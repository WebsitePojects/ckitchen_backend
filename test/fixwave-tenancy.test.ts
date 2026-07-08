/**
 * Fix-wave tenancy (Fable ORION review 2026-07-05) — cross-outlet isolation on
 * the user-facing surfaces that were outlet-blind.
 *
 *   H2 — orders: list / detail / advance / cancel scoped to the caller's outlets.
 *   H3 — print jobs: list / reprint scoped to the caller's outlets.
 *   H4 — ITO confirm: membership-checked against the ITO's outlet.
 *   H6 — PO receiving credits the receiver's outlet's MAIN warehouse only.
 *   M4 — GET /ems/attendance/dtr role-gated like its sibling.
 *   M5 — RIDER (retired) is blocked at login.
 *   L2 — malformed X-Outlet-Id → 400, not a 500 cast error.
 *
 * Full-stack via supertest, in-memory PGlite per file (isolated from other files).
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { ingredients, printAgents, suppliers, userOutletAccess, users } from "../src/db/schema.js";

let app: Express;
let db: DB;

let adminToken: string; // OWNER — ALL scope
let kitchenA: string; // KITCHEN_CREW @ outlet A
let warehouseA: string; // WAREHOUSE_OUTLET @ outlet A
let kitchenB: string; // KITCHEN_CREW @ outlet B (created here)
let warehouseB: string; // WAREHOUSE_OUTLET @ outlet B (created here)

let outletAId: string; // seeded CK1
let outletBId: string; // CK2

let brandAId: string;
let menuAId: string;
let brandBId: string;
let menuBId: string;
let ingredientId: string;

let _seq = 0;
const nextRef = () => `FW-${Date.now()}-${++_seq}`;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

/** Create an ASSIGNED user (single outlet) and return a fresh token. */
async function createScopedUser(
  email: string,
  role: "KITCHEN_CREW" | "WAREHOUSE_OUTLET",
  outletId: string,
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ name: email, email, passwordHash: await hashPassword("password123"), role })
    .returning();
  await db.insert(userOutletAccess).values({ userId: u.id, locationId: outletId });
  return login(email, "password123");
}

async function mainQty(outletId: string, ingId: string): Promise<number> {
  const res = await request(app)
    .get(`/api/v1/inventory?warehouse=MAIN&outlet_id=${outletId}`)
    .set("Authorization", `Bearer ${adminToken}`);
  const row = (res.body as Array<{ ingredientId: string; quantity: string }>).find(
    (r) => r.ingredientId === ingId,
  );
  return row ? Number(row.quantity) : 0;
}

/** Ingest a fresh order at the given brand/menu; returns { orderId, jobId }. */
async function ingest(brandId: string, menuId: string): Promise<{ orderId: string; jobId: string }> {
  const res = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator: "FOODPANDA",
      external_ref: nextRef(),
      items: [{ menu_item_id: menuId, qty: 1 }],
    });
  expect(res.status).toBe(201);
  return { orderId: res.body.order_id as string, jobId: res.body.print_jobs[0].id as string };
}

async function createBrandOrder(outletId: string, stationId: string, ext: string) {
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `Brand ${ext}`, color: "#123456", location_id: outletId });
  const brandId = brandRes.body.id as string;

  await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: `FP-${ext}`, credential_ref: `ref-${ext}` });

  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `Dish ${ext}`, price: "150", station_id: stationId });
  const menuId = menuRes.body.id as string;

  await request(app)
    .put(`/api/v1/menu/${menuId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingredientId, portion_qty: 10, unit: "g" }] });

  return { brandId, menuId };
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenA = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseA = await login("warehouse@cloudkitchen.local", "password123");

  // Outlet A = seeded CK1
  const outletsRes = await request(app).get("/api/v1/outlets").set("Authorization", `Bearer ${adminToken}`);
  outletAId = (outletsRes.body as Array<{ id: string; code: string }>).find((o) => o.code === "CK1")!.id;

  // Outlet B = CK2 (POST /outlets also creates its MAIN + KITCHEN warehouses)
  const outletBRes = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "CK2", name: "CloudKitchen TWO", address: "Second Site" });
  outletBId = outletBRes.body.id as string;

  kitchenB = await createScopedUser("kitchen_b@cloudkitchen.local", "KITCHEN_CREW", outletBId);
  warehouseB = await createScopedUser("warehouse_b@cloudkitchen.local", "WAREHOUSE_OUTLET", outletBId);

  // Shared ingredient.
  const [ing] = await db
    .insert(ingredients)
    .values({ name: "FW Beef", unit: "g", unitCost: "2", lowStockThreshold: "10" })
    .returning();
  ingredientId = ing!.id;

  // Stock outlet A's KITCHEN so an outlet-A advance can actually deduct.
  await request(app)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ outlet_id: outletAId, items: [{ ingredient_id: ingredientId, quantity: 1000 }] });
  const itoRes = await request(app)
    .post("/api/v1/itos")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ outlet_id: outletAId, from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingredientId, quantity: 1000 }] });
  await request(app)
    .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
    .set("Authorization", `Bearer ${adminToken}`);

  // Station at A (seeded "Grill") + station at B.
  const stationsA = await request(app).get("/api/v1/stations").set("Authorization", `Bearer ${adminToken}`);
  const grillA = (stationsA.body as Array<{ id: string; name: string; locationId: string }>).find(
    (s) => s.name === "Grill" && s.locationId === outletAId,
  )!.id;

  const stationBRes = await request(app)
    .post("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("X-Outlet-Id", outletBId)
    .send({ name: "B Grill" });
  const stationB = stationBRes.body.id as string;

  ({ brandId: brandAId, menuId: menuAId } = await createBrandOrder(outletAId, grillA, "A"));
  ({ brandId: brandBId, menuId: menuBId } = await createBrandOrder(outletBId, stationB, "B"));
});

// ---------------------------------------------------------------------------
// H2 — orders scoping
// ---------------------------------------------------------------------------

describe("H2 — orders outlet scoping", () => {
  it("ASSIGNED outlet-B crew cannot GET an outlet-A order detail → 403", async () => {
    const { orderId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${kitchenB}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ASSIGNED outlet-B crew cannot ADVANCE an outlet-A order → 403 (and it stays NEW)", async () => {
    const { orderId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${kitchenB}`);
    expect(res.status).toBe(403);

    // Still NEW — the deduction never ran.
    const detail = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.body.status).toBe("NEW");
  });

  it("ASSIGNED outlet-B crew cannot CANCEL an outlet-A order → 403", async () => {
    const { orderId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${kitchenB}`)
      .send({ reason: "not my outlet" });
    expect(res.status).toBe(403);
  });

  it("GET /orders for outlet-B crew excludes outlet-A orders", async () => {
    const { orderId: aOrder } = await ingest(brandAId, menuAId);
    const { orderId: bOrder } = await ingest(brandBId, menuBId);
    const res = await request(app).get("/api/v1/orders").set("Authorization", `Bearer ${kitchenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(bOrder);
    expect(ids).not.toContain(aOrder);
  });

  it("ALL-scope (admin) GET /orders sees both outlets", async () => {
    const { orderId: aOrder } = await ingest(brandAId, menuAId);
    const { orderId: bOrder } = await ingest(brandBId, menuBId);
    const res = await request(app).get("/api/v1/orders").set("Authorization", `Bearer ${adminToken}`);
    const ids = (res.body as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(aOrder);
    expect(ids).toContain(bOrder);
  });

  it("single-outlet flow unchanged: outlet-A crew advances its own order", async () => {
    const { orderId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${kitchenA}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PREPARING");
  });
});

// ---------------------------------------------------------------------------
// H3 — print jobs scoping
// ---------------------------------------------------------------------------

describe("H3 — print-jobs outlet scoping", () => {
  it("outlet-B crew cannot reprint an outlet-A job → 403", async () => {
    const { jobId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .post(`/api/v1/print-jobs/${jobId}/reprint`)
      .set("Authorization", `Bearer ${kitchenB}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("GET /print-jobs for outlet-B crew excludes outlet-A jobs", async () => {
    const { jobId: aJob } = await ingest(brandAId, menuAId);
    const { jobId: bJob } = await ingest(brandBId, menuBId);
    const res = await request(app).get("/api/v1/print-jobs").set("Authorization", `Bearer ${kitchenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(bJob);
    expect(ids).not.toContain(aJob);
  });

  it("ALL-scope admin sees jobs from both outlets and can reprint an outlet-A job", async () => {
    const { jobId } = await ingest(brandAId, menuAId);
    const list = await request(app).get("/api/v1/print-jobs").set("Authorization", `Bearer ${adminToken}`);
    expect((list.body as Array<{ id: string }>).map((j) => j.id)).toContain(jobId);

    const reprint = await request(app)
      .post(`/api/v1/print-jobs/${jobId}/reprint`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reprint.status).toBe(201);
  });

  it("outlet-A crew CAN reprint its own outlet's job → 201", async () => {
    const { jobId } = await ingest(brandAId, menuAId);
    const res = await request(app)
      .post(`/api/v1/print-jobs/${jobId}/reprint`)
      .set("Authorization", `Bearer ${kitchenA}`);
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// H4 — ITO confirm membership
// ---------------------------------------------------------------------------

describe("H4 — ITO confirm membership", () => {
  it("outlet-B WAREHOUSE_OUTLET cannot confirm an outlet-A ITO → 403 (stays REQUESTED)", async () => {
    // Stock A MAIN, then request an A ITO (as admin, targeting A).
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ outlet_id: outletAId, items: [{ ingredient_id: ingredientId, quantity: 50 }] });
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ outlet_id: outletAId, from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingredientId, quantity: 20 }] });
    const itoId = itoRes.body.id as string;

    const denied = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseB}`);
    expect(denied.status).toBe(403);

    // outlet-A warehouse CAN confirm it → 200.
    const ok = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseA}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// H6 — PO receiving credits the receiver's outlet MAIN only
// ---------------------------------------------------------------------------

describe("H6 — PO receiving credits the right outlet MAIN", () => {
  let supplierId: string;

  beforeAll(async () => {
    const [sup] = await db.insert(suppliers).values({ code: "FW-SUP", name: "FW Supplier" }).returning();
    supplierId = sup!.id;
  });

  async function makeSentPo(qty: number): Promise<{ poId: string; poLineId: string }> {
    const create = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ supplier_id: supplierId, lines: [{ ingredient_id: ingredientId, quantity: qty, unit_cost: 2 }] });
    const poId = create.body.id as string;
    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set("Authorization", `Bearer ${adminToken}`);
    const poLineId = detail.body.lines[0].id as string;
    await request(app).post(`/api/v1/purchase-orders/${poId}/send`).set("Authorization", `Bearer ${adminToken}`);
    return { poId, poLineId };
  }

  it("outlet-A warehouse receiving credits A's MAIN, not B's", async () => {
    const aBefore = await mainQty(outletAId, ingredientId);
    const bBefore = await mainQty(outletBId, ingredientId);

    const { poId, poLineId } = await makeSentPo(30);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${warehouseA}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 30 }] });
    expect(res.status).toBe(201);

    expect(await mainQty(outletAId, ingredientId)).toBe(aBefore + 30);
    expect(await mainQty(outletBId, ingredientId)).toBe(bBefore); // untouched
  });

  it("outlet-B warehouse receiving credits B's MAIN, not A's", async () => {
    const aBefore = await mainQty(outletAId, ingredientId);
    const bBefore = await mainQty(outletBId, ingredientId);

    const { poId, poLineId } = await makeSentPo(40);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${warehouseB}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 40 }] });
    expect(res.status).toBe(201);

    expect(await mainQty(outletBId, ingredientId)).toBe(bBefore + 40);
    expect(await mainQty(outletAId, ingredientId)).toBe(aBefore); // untouched
  });
});

// ---------------------------------------------------------------------------
// M4 — DTR role gate
// ---------------------------------------------------------------------------

describe("M4 — GET /ems/attendance/dtr role gate", () => {
  let outletAEmployeeId: string;

  beforeAll(async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: `FW-M4-${Date.now()}`,
        full_name: "FW M4 Scoped Employee",
        department: "KITCHEN",
        location_id: outletAId,
      });
    expect(create.status).toBe(201);
    outletAEmployeeId = create.body.id as string;
  });

  it("non-OWNER without employee_id → 403", async () => {
    const res = await request(app)
      .get("/api/v1/ems/attendance/dtr")
      .set("Authorization", `Bearer ${kitchenA}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("OWNER without employee_id → 200", async () => {
    const res = await request(app)
      .get("/api/v1/ems/attendance/dtr")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("non-OWNER WITH valid in-scope employee_id → 200 (filtered still allowed)", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${outletAEmployeeId}`)
      .set("Authorization", `Bearer ${kitchenA}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M5 — RIDER blocked at login
// ---------------------------------------------------------------------------

describe("M5 — RIDER retired role blocked at login", () => {
  it("a RIDER account cannot log in → 403 ROLE_RETIRED", async () => {
    await db.insert(users).values({
      name: "Rider One",
      email: "rider@cloudkitchen.local",
      passwordHash: await hashPassword("password123"),
      role: "RIDER",
    });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "rider@cloudkitchen.local", password: "password123" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ROLE_RETIRED");
  });
});

// ---------------------------------------------------------------------------
// L4a — migration 0016: unique index on print_agent (name, location_id)
// ---------------------------------------------------------------------------

describe("L4a — print_agent (name, location_id) unique index", () => {
  it("rejects a duplicate (name, location) agent row", async () => {
    await db.insert(printAgents).values({ name: "dup-agent", locationId: outletAId, tokenHash: "h1" });
    await expect(
      db.insert(printAgents).values({ name: "dup-agent", locationId: outletAId, tokenHash: "h2" }),
    ).rejects.toThrow();
  });

  it("allows the same agent name at a DIFFERENT location", async () => {
    const [row] = await db
      .insert(printAgents)
      .values({ name: "dup-agent", locationId: outletBId, tokenHash: "h3" })
      .returning();
    expect(row.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// L2 — malformed X-Outlet-Id → 400 (not a 500 cast error)
// ---------------------------------------------------------------------------

describe("L2 — malformed X-Outlet-Id", () => {
  it("ALL-scope with a non-UUID X-Outlet-Id → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", "not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
