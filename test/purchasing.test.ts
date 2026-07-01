/**
 * ERP R3 — purchasing tests (CK1-ERP-006 §4)
 *
 * Full flow: PR create → submit → approve → PO create (from approved PR) →
 * send → receive. Verifies RBAC at each step and that receiving posts a
 * RECEIVE IN stock-ledger row + bumps MAIN inventory_stock + advances PO status.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { ingredients, inventoryStock, stockLedgerEntries, suppliers, warehouses } from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string, purchToken: string, whToken: string, kitchenToken: string, acctToken: string;
let ingredientId: string, supplierId: string, mainWarehouseId: string;

// shared across the sequential flow
let prId: string, poId: string, poLineId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  purchToken = await login("supplier_coordinator@cloudkitchen.local", "password123");
  whToken = await login("warehouse@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  acctToken = await login("accountant@cloudkitchen.local", "password123");

  const [ing] = await db
    .insert(ingredients)
    .values({ name: "Chicken", unit: "kg", unitCost: "120", lowStockThreshold: "5" })
    .returning();
  ingredientId = ing!.id;

  const [sup] = await db.insert(suppliers).values({ code: "SUP-PO", name: "PO Supplier" }).returning();
  supplierId = sup!.id;

  const [mw] = await db.select().from(warehouses).where(eq(warehouses.type, "MAIN"));
  mainWarehouseId = mw!.id;
}, 60_000);

describe("Purchase Request", () => {
  it("403 for a non-requester role (accountant)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${acctToken}`)
      .send({ department: "PURCHASING", lines: [{ ingredient_id: ingredientId, quantity: 10 }] });
    expect(res.status).toBe(403);
  });

  it("kitchen staff can raise a PR (DRAFT)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "KITCHEN", notes: "need chicken", lines: [{ ingredient_id: ingredientId, quantity: 20, est_unit_cost: 118 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.prNo).toMatch(/^PR-/);
    prId = res.body.id;
  });

  it("404 when a line references an unknown ingredient", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "KITCHEN", lines: [{ ingredient_id: "00000000-0000-0000-0000-000000000000", quantity: 1 }] });
    expect(res.status).toBe(404);
  });

  it("submits then admin approves; non-admin cannot approve", async () => {
    const submit = await request(app)
      .post(`/api/v1/purchase-requests/${prId}/submit`)
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe("SUBMITTED");

    const denied = await request(app)
      .post(`/api/v1/purchase-requests/${prId}/approve`)
      .set("Authorization", `Bearer ${purchToken}`);
    expect(denied.status).toBe(403);

    const approve = await request(app)
      .post(`/api/v1/purchase-requests/${prId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("APPROVED");
  });

  it("GET /purchase-requests/:id returns the PR with its lines", async () => {
    const res = await request(app)
      .get(`/api/v1/purchase-requests/${prId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lines.length).toBe(1);
    expect(res.body.lines[0].ingredientId).toBe(ingredientId);
  });
});

describe("Purchase Order", () => {
  it("409 when creating a PO from a non-approved PR", async () => {
    // raise a fresh DRAFT PR (not approved) and try to attach it
    const draft = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${purchToken}`)
      .send({ department: "PURCHASING", lines: [{ ingredient_id: ingredientId, quantity: 5 }] });
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${purchToken}`)
      .send({ supplier_id: supplierId, pr_id: draft.body.id, lines: [{ ingredient_id: ingredientId, quantity: 5, unit_cost: 120 }] });
    expect(res.status).toBe(409);
  });

  it("purchasing creates a PO from the approved PR, then sends it", async () => {
    const create = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${purchToken}`)
      .send({ supplier_id: supplierId, pr_id: prId, lines: [{ ingredient_id: ingredientId, quantity: 20, unit_cost: 120 }] });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe("DRAFT");
    poId = create.body.id;

    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set("Authorization", `Bearer ${purchToken}`);
    expect(detail.body.lines.length).toBe(1);
    poLineId = detail.body.lines[0].id;

    const send = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/send`)
      .set("Authorization", `Bearer ${purchToken}`);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("SENT");
  });
});

describe("Receiving (posts ledger + stock)", () => {
  it("403 when a non-warehouse role tries to receive", async () => {
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 5 }] });
    expect(res.status).toBe(403);
  });

  it("409 when trying to over-receive a line", async () => {
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${whToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 999 }] });
    expect(res.status).toBe(409);
  });

  it("partial receive → PO PARTIAL, stock + ledger updated", async () => {
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${whToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 12 }] });
    expect(res.status).toBe(201);
    expect(res.body.rrNo).toMatch(/^RR-/);

    // PO now PARTIAL
    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set("Authorization", `Bearer ${whToken}`);
    expect(po.body.status).toBe("PARTIAL");
    expect(Number(po.body.lines[0].qtyReceived)).toBe(12);

    // MAIN inventory_stock bumped by 12
    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(12);

    // ledger has a RECEIVE IN row for this ingredient in MAIN
    const led = await db
      .select()
      .from(stockLedgerEntries)
      .where(and(eq(stockLedgerEntries.ingredientId, ingredientId), eq(stockLedgerEntries.sourceModule, "RECEIVE")));
    expect(led.length).toBeGreaterThan(0);
    expect(led.some((l) => l.movementType === "IN" && Number(l.quantity) === 12)).toBe(true);
  });

  it("receiving the remainder → PO RECEIVED, stock accumulates", async () => {
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${whToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 8 }] });
    expect(res.status).toBe(201);

    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(po.body.status).toBe("RECEIVED");
    expect(Number(po.body.lines[0].qtyReceived)).toBe(20);

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(20);
  });

  it("GET /receiving-reports lists the reports", async () => {
    const res = await request(app).get("/api/v1/receiving-reports").set("Authorization", `Bearer ${whToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});
