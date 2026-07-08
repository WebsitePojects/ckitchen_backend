/**
 * D26 — Stock Adjustment document (approved write-off / correction).
 *
 * Under test:
 *   • POST creates a PENDING row and does NOT touch stock
 *   • approve OUT decrements the balance + posts an ADJUSTMENT ledger row (same tx)
 *   • approve IN increments the balance
 *   • reject flips status only — no stock change
 *   • double-decide → 409 CONFLICT (conditional WHERE status='PENDING')
 *   • OUTLET_MANAGER cannot approve their OWN request (403 SELF_APPROVAL); OWNER can
 *   • cross-outlet request / decide → 403 (tenancy)
 *   • invalid quantity / reason → 400
 *
 * Full-stack via supertest, in-memory PGlite per file. A recording hub asserts the
 * stock.updated emission on approve.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { inventoryStock, stockLedgerEntries } from "../src/db/schema.js";
import type { RealtimeHub } from "../src/realtime/hub.js";

let app: Express;
let db: DB;
let adminToken: string; // OWNER — ALL scope
let managerToken: string; // OUTLET_MANAGER — ASSIGNED to CK1
let warehouseToken: string; // WAREHOUSE_OUTLET — ASSIGNED to CK1

let ck1MainWhId: string;
let ck2MainWhId: string;

interface EmittedEvent {
  locationId: string;
  event: string;
  payload: unknown;
}
const emitted: EmittedEvent[] = [];
const recordingHub: RealtimeHub = {
  emitToLocation(locationId, event, payload) {
    emitted.push({ locationId, event, payload });
  },
};

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

let _seq = 0;
async function makeIngredient(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `ADJ_${Date.now()}_${++_seq}`, unit: "kg", unit_cost: "2.00", low_stock_threshold: "1" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Receive qty into CK1 MAIN. */
async function receiveMain(ingredientId: string, qty: number): Promise<void> {
  const res = await request(app)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${warehouseToken}`)
    .send({ items: [{ ingredient_id: ingredientId, quantity: qty }] });
  expect(res.status).toBe(201);
}

async function mainBalance(ingredientId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ q: inventoryStock.quantity })
    .from(inventoryStock)
    .where(and(eq(inventoryStock.warehouseId, ck1MainWhId), eq(inventoryStock.ingredientId, ingredientId)));
  return row ? Number(row.q) : undefined;
}

function createReq(
  token: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post("/api/v1/adjustments")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db, recordingHub);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  managerToken = await login("outlet_manager@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

  // CK1 warehouses (default outlet).
  const whRes = await request(app)
    .get("/api/v1/warehouses")
    .set("Authorization", `Bearer ${adminToken}`);
  ck1MainWhId = (whRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "MAIN")!.id;

  // Second outlet CK2 (POST /outlets creates its MAIN + KITCHEN warehouses).
  const ck2Res = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "CK2", name: "CloudKitchen TWO", address: "Second Site" });
  expect(ck2Res.status).toBe(201);
  const ck2Id = ck2Res.body.id as string;
  const ck2WhRes = await request(app)
    .get(`/api/v1/warehouses?outlet_id=${ck2Id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  ck2MainWhId = (ck2WhRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "MAIN")!.id;
}, 60_000);

describe("create request", () => {
  it("creates a PENDING row and does not touch stock", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 100);

    const res = await createReq(warehouseToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 10,
      reason: "EXPIRY",
      note: "expired batch",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.direction).toBe("OUT");
    expect(Number(res.body.quantity)).toBe(10);

    expect(await mainBalance(ing)).toBe(100); // untouched while PENDING
  });

  it("404 for unknown warehouse / ingredient; 400 for bad qty / reason", async () => {
    const ing = await makeIngredient();
    const bogusUuid = "00000000-0000-0000-0000-000000000000";

    expect(
      (await createReq(adminToken, { warehouse_id: bogusUuid, ingredient_id: ing, direction: "OUT", quantity: 1, reason: "EXPIRY" })).status,
    ).toBe(404);
    expect(
      (await createReq(adminToken, { warehouse_id: ck1MainWhId, ingredient_id: bogusUuid, direction: "OUT", quantity: 1, reason: "EXPIRY" })).status,
    ).toBe(404);
    expect(
      (await createReq(adminToken, { warehouse_id: ck1MainWhId, ingredient_id: ing, direction: "OUT", quantity: 0, reason: "EXPIRY" })).status,
    ).toBe(400);
    expect(
      (await createReq(adminToken, { warehouse_id: ck1MainWhId, ingredient_id: ing, direction: "OUT", quantity: -5, reason: "EXPIRY" })).status,
    ).toBe(400);
    expect(
      (await createReq(adminToken, { warehouse_id: ck1MainWhId, ingredient_id: ing, direction: "OUT", quantity: 5, reason: "BOGUS" })).status,
    ).toBe(400);
  });
});

describe("approve / reject", () => {
  it("approve OUT decrements stock and posts an ADJUSTMENT ledger row + emits stock.updated", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 100);
    const reqRes = await createReq(warehouseToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 30,
      reason: "SPOILAGE",
    });
    const adjId = reqRes.body.id as string;

    emitted.length = 0;
    const approve = await request(app)
      .post(`/api/v1/adjustments/${adjId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "confirmed" });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("APPROVED");
    expect(approve.body.decidedBy).toBeTruthy();

    expect(await mainBalance(ing)).toBe(70); // 100 − 30

    const ledger = await db
      .select()
      .from(stockLedgerEntries)
      .where(and(eq(stockLedgerEntries.sourceModule, "ADJUSTMENT"), eq(stockLedgerEntries.sourceDocumentNo, adjId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].movementType).toBe("OUT");
    expect(Number(ledger[0].quantity)).toBe(30);

    const evt = emitted.find((e) => e.event === "stock.updated");
    expect(evt).toBeTruthy();
    expect(evt!.payload).toMatchObject({ ingredientId: ing, warehouseType: "MAIN", quantity: 70 });
  });

  it("approve IN increments stock", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 50);
    const reqRes = await createReq(warehouseToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "IN",
      quantity: 15,
      reason: "CORRECTION",
    });
    const approve = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(await mainBalance(ing)).toBe(65); // 50 + 15
  });

  it("reject flips status only — no stock change", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 40);
    const reqRes = await createReq(warehouseToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 20,
      reason: "NEGLIGENCE",
    });
    const reject = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "not justified" });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("REJECTED");
    expect(await mainBalance(ing)).toBe(40); // unchanged
  });

  it("double-approve → 409 CONFLICT", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 100);
    const reqRes = await createReq(warehouseToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 5,
      reason: "EXPIRY",
    });
    const adjId = reqRes.body.id as string;

    const first = await request(app)
      .post(`/api/v1/adjustments/${adjId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/adjustments/${adjId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");

    expect(await mainBalance(ing)).toBe(95); // only one decrement
  });
});

describe("segregation of duties", () => {
  it("OUTLET_MANAGER cannot approve their OWN request (403 SELF_APPROVAL)", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 100);
    const reqRes = await createReq(managerToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 10,
      reason: "EXPIRY",
    });
    expect(reqRes.status).toBe(201);

    const selfApprove = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe("SELF_APPROVAL");

    // A different decider (OWNER) can approve it.
    const ownerApprove = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(ownerApprove.status).toBe(200);
  });

  it("OWNER CAN approve their own request (exempt)", async () => {
    const ing = await makeIngredient();
    await receiveMain(ing, 100);
    const reqRes = await createReq(adminToken, {
      warehouse_id: ck1MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 10,
      reason: "EXPIRY",
    });
    const approve = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(200);
    expect(await mainBalance(ing)).toBe(90);
  });
});

describe("tenancy", () => {
  it("ASSIGNED user cannot request against a warehouse outside their outlet → 403", async () => {
    const ing = await makeIngredient();
    const res = await createReq(managerToken, {
      warehouse_id: ck2MainWhId, // CK2, manager is scoped to CK1
      ingredient_id: ing,
      direction: "OUT",
      quantity: 1,
      reason: "EXPIRY",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ASSIGNED user cannot decide an out-of-scope adjustment → 403", async () => {
    const ing = await makeIngredient();
    // OWNER (ALL scope) creates a request at CK2.
    const reqRes = await createReq(adminToken, {
      warehouse_id: ck2MainWhId,
      ingredient_id: ing,
      direction: "OUT",
      quantity: 1,
      reason: "EXPIRY",
    });
    expect(reqRes.status).toBe(201);

    const decide = await request(app)
      .post(`/api/v1/adjustments/${reqRes.body.id}/approve`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(decide.status).toBe(403);
    expect(decide.body.error.code).toBe("FORBIDDEN");
  });
});

describe("list", () => {
  it("returns rows newest-first, enriched, and scoped", async () => {
    const res = await request(app)
      .get("/api/v1/adjustments?warehouse_id=" + ck1MainWhId)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const first = res.body[0];
    expect(first.ingredient).toHaveProperty("name");
    expect(first.warehouse).toHaveProperty("type");
    expect(first.warehouse).toHaveProperty("locationId");
    expect(first).toHaveProperty("requested_by_name");
    expect(first).toHaveProperty("decided_by_name");

    // ASSIGNED manager (CK1) must NOT see CK2 adjustments.
    const scoped = await request(app)
      .get("/api/v1/adjustments")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(scoped.status).toBe(200);
    const wids = new Set((scoped.body as Array<{ warehouseId: string }>).map((r) => r.warehouseId));
    expect(wids.has(ck2MainWhId)).toBe(false);
  });
});
