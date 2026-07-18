/**
 * Double-submit / duplicate-delivery audit — focused regression tests.
 *
 * Every describe block below fires the SAME logical mutating request twice —
 * once sequentially (the double-click / client-retry-after-timeout case) and
 * once concurrently via Promise.all (the true race case) — and asserts the
 * business effect happened exactly ONCE: one stock movement, one document,
 * one status transition, one print job. This mirrors the "second request
 * gets 409/200-replay, side effects only in the winning branch" convention
 * already used by src/modules/customer-orders/service.ts and
 * src/modules/inventory/adjustments.ts's approve/reject handlers.
 *
 * Covers the fixes made in this audit pass:
 *   - POST /itos/:id/confirm                       (inventory/routes.ts)
 *   - POST /inventory/receive                       (inventory/routes.ts)
 *   - POST /purchase-orders/:id/receive             (purchasing/routes.ts)
 *   - PR submit/approve + PO send                   (purchasing/routes.ts)
 *   - PUT /menu/:id/recipe                          (menu/routes.ts)
 *   - POST /orders/:id/discounts                    (discounts/routes.ts)
 *   - POST /order-discounts/:id/approve             (discounts/routes.ts)
 *   - enqueueCommand()                              (outbound/service.ts)
 *   - reprintJob()                                  (printing/service.ts)
 *   - recordAttendancePunch()                       (ems/attendance-shared.ts)
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  aggregatorAccounts,
  brands,
  employees,
  inventoryStock,
  itoItems,
  itos,
  kitchenStations,
  menuItems,
  orderDiscounts,
  orders,
  printJobs,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  receivingReportLines,
  receivingReports,
  recipeLines,
  users,
  warehouses,
} from "../src/db/schema.js";
import { aggregatorCommands } from "../src/db/outbound-schema.js";
import { enqueueCommand } from "../src/modules/outbound/service.js";
import { OUTBOUND_COMMANDS_FLAG } from "../src/modules/outbound/policies.js";
import { reprintJob } from "../src/modules/printing/service.js";

// Cloudinary is mocked so the EMS attendance section makes no real network call.
vi.mock("../src/modules/ems/cloudinary.js", () => ({
  uploadAttendancePhoto: vi.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image/upload/ck1/attendance/mock.jpg",
    publicId: "ck1/attendance/mock",
  }),
  ConfigError: class ConfigError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ConfigError";
    }
  },
}));

let app: Express;
let db: DB;

let adminToken: string; // OWNER
let warehouseToken: string; // WAREHOUSE_OUTLET
let kitchenToken: string; // KITCHEN_CREW
let purchToken: string; // PURCHASING
let brandManagerToken: string; // BRAND_MANAGER

let brandId: string;
let walkInAccountId: string;
let mainWarehouseId: string;
let kitchenWarehouseId: string;
let stationId: string;

let seq = 0;
function suffix(): string {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

async function createIngredient(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `Ing-${suffix()}`, unit: "kg", unit_cost: "10.00", low_stock_threshold: "1" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Bare walk-in (OTHER) order, direct insert — mirrors discount-strict-approval.test.ts. */
async function createWalkInOrder(total: string): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      brandId,
      aggregatorAccountId: walkInAccountId,
      aggregator: "OTHER",
      externalRef: `ext-${suffix()}`,
      customerName: "Test Customer",
      status: "NEW",
      total,
    })
    .returning();
  return order.id;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await seed(db); // 1 location (CK1), MAIN+KITCHEN warehouses, 5 stations, one user per role

  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  purchToken = await login("supplier_coordinator@cloudkitchen.local", "password123");
  brandManagerToken = await login("brand_manager@cloudkitchen.local", "password123");

  const wh = await db.select().from(warehouses);
  mainWarehouseId = wh.find((w) => w.type === "MAIN")!.id;
  kitchenWarehouseId = wh.find((w) => w.type === "KITCHEN")!.id;
  stationId = (await db.select().from(kitchenStations).limit(1))[0]!.id;

  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `DS Brand ${suffix()}`, color: "#123456" });
  expect(brandRes.status, JSON.stringify(brandRes.body)).toBe(201);
  brandId = brandRes.body.id as string;

  const [walkIn] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, aggregator: "OTHER", externalMerchantId: `walkin-${suffix()}` })
    .returning();
  walkInAccountId = walkIn.id;
}, 60_000);

// ---------------------------------------------------------------------------
// 1. POST /itos/:id/confirm — ATOMIC stock move, must fire once
// ---------------------------------------------------------------------------
describe("POST /itos/:id/confirm — double-submit", () => {
  it("two CONCURRENT confirms: exactly one 200, one 409, stock moved once", async () => {
    const ingredientId = await createIngredient();
    await db.insert(inventoryStock).values({ warehouseId: mainWarehouseId, ingredientId, quantity: "20" });

    const [ito] = await db
      .insert(itos)
      .values({ fromWarehouseId: mainWarehouseId, toWarehouseId: kitchenWarehouseId, status: "REQUESTED" })
      .returning();
    await db.insert(itoItems).values({ itoId: ito.id, ingredientId, quantity: "5" });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/itos/${ito.id}/confirm`).set("Authorization", `Bearer ${warehouseToken}`),
      request(app).post(`/api/v1/itos/${ito.id}/confirm`).set("Authorization", `Bearer ${warehouseToken}`),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // PGlite serializes the two transactions, so the loser may observe the
    // fast-path 400 (already REQUESTED->CONFIRMED) or the in-tx 409 CAS
    // conflict depending on interleaving — either is an acceptable "second
    // request rejected cleanly" outcome; what must NEVER happen is 200+200.
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    const [main] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    const [kitchen] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, kitchenWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(main!.quantity)).toBe(15); // 20 - 5, NOT 10
    expect(Number(kitchen!.quantity)).toBe(5); // NOT 10
  });
});

// ---------------------------------------------------------------------------
// 2. POST /inventory/receive — direct RR, must not double-credit MAIN
// ---------------------------------------------------------------------------
describe("POST /inventory/receive — double-submit", () => {
  it("two SEQUENTIAL identical receives: second replays the first RR, stock credited once", async () => {
    const ingredientId = await createIngredient();
    const body = { reference: `SEQ-${suffix()}`, items: [{ ingredient_id: ingredientId, quantity: 7, unit_cost: 10 }] };

    const r1 = await request(app).post("/api/v1/inventory/receive").set("Authorization", `Bearer ${warehouseToken}`).send(body);
    const r2 = await request(app).post("/api/v1/inventory/receive").set("Authorization", `Bearer ${warehouseToken}`).send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.rr.id).toBe(r1.body.rr.id); // replay of the SAME RR, not a new one

    const rrRows = await db.select().from(receivingReports).where(eq(receivingReports.id, r1.body.rr.id));
    expect(rrRows.length).toBe(1);

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(7); // NOT 14
  });

  it("two CONCURRENT identical receives: single RR, stock credited once", async () => {
    const ingredientId = await createIngredient();
    const body = { reference: `CONC-${suffix()}`, items: [{ ingredient_id: ingredientId, quantity: 4, unit_cost: 10 }] };

    const [r1, r2] = await Promise.all([
      request(app).post("/api/v1/inventory/receive").set("Authorization", `Bearer ${warehouseToken}`).send(body),
      request(app).post("/api/v1/inventory/receive").set("Authorization", `Bearer ${warehouseToken}`).send(body),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.rr.id).toBe(r1.body.rr.id);

    const lines = await db.select().from(receivingReportLines).where(eq(receivingReportLines.rrId, r1.body.rr.id));
    expect(lines.length).toBe(1);

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(4); // NOT 8
  });

  it("a genuinely DIFFERENT receive (different quantity) is NOT treated as a duplicate", async () => {
    const ingredientId = await createIngredient();
    const first = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 5 }] });
    const second = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 3 }] });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.rr.id).not.toBe(first.body.rr.id); // two real, distinct receipts

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(8); // 5 + 3, correctly accumulated
  });
});

// ---------------------------------------------------------------------------
// 3. POST /purchase-orders/:id/receive + PR/PO status transitions
// ---------------------------------------------------------------------------
describe("Purchasing — double-submit", () => {
  let ingredientId: string;
  let poId: string;
  let poLineId: string;

  beforeAll(async () => {
    ingredientId = await createIngredient();
  });

  it("PR submit: two CONCURRENT submits — one 200, one 409, single SUBMITTED transition", async () => {
    const create = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "KITCHEN", lines: [{ ingredient_id: ingredientId, quantity: 5 }] });
    expect(create.status).toBe(201);
    const prId = create.body.id as string;

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/purchase-requests/${prId}/submit`).set("Authorization", `Bearer ${kitchenToken}`),
      request(app).post(`/api/v1/purchase-requests/${prId}/submit`).set("Authorization", `Bearer ${kitchenToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, prId));
    expect(pr!.status).toBe("SUBMITTED");
  });

  it("PR approve: two CONCURRENT approves — one 200, one 409", async () => {
    const create = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "KITCHEN", lines: [{ ingredient_id: ingredientId, quantity: 5 }] });
    const prId = create.body.id as string;
    await request(app).post(`/api/v1/purchase-requests/${prId}/submit`).set("Authorization", `Bearer ${kitchenToken}`);

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/purchase-requests/${prId}/approve`).set("Authorization", `Bearer ${adminToken}`),
      request(app).post(`/api/v1/purchase-requests/${prId}/approve`).set("Authorization", `Bearer ${adminToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, prId));
    expect(pr!.status).toBe("APPROVED");
  });

  it("PO send: two CONCURRENT sends — one 200, one 409", async () => {
    const create = await request(app)
      .post("/api/v1/purchase-requests")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "KITCHEN", lines: [{ ingredient_id: ingredientId, quantity: 20 }] });
    const prId = create.body.id as string;
    await request(app).post(`/api/v1/purchase-requests/${prId}/submit`).set("Authorization", `Bearer ${kitchenToken}`);
    await request(app).post(`/api/v1/purchase-requests/${prId}/approve`).set("Authorization", `Bearer ${adminToken}`);

    const poRes = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${purchToken}`)
      .send({
        supplier_id: (await ensureSupplier()),
        pr_id: prId,
        lines: [{ ingredient_id: ingredientId, quantity: 20, unit_cost: 15 }],
      });
    expect(poRes.status, JSON.stringify(poRes.body)).toBe(201);
    poId = poRes.body.id as string;
    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set("Authorization", `Bearer ${purchToken}`);
    poLineId = detail.body.lines[0].id as string;

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/purchase-orders/${poId}/send`).set("Authorization", `Bearer ${purchToken}`),
      request(app).post(`/api/v1/purchase-orders/${poId}/send`).set("Authorization", `Bearer ${purchToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("PO receive: two SEQUENTIAL identical receives — second replays, stock/qtyReceived not doubled", async () => {
    const body = { lines: [{ po_line_id: poLineId, qty_received: 6 }] };
    const r1 = await request(app).post(`/api/v1/purchase-orders/${poId}/receive`).set("Authorization", `Bearer ${warehouseToken}`).send(body);
    const r2 = await request(app).post(`/api/v1/purchase-orders/${poId}/receive`).set("Authorization", `Bearer ${warehouseToken}`).send(body);

    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.id).toBe(r1.body.id); // same RR replayed

    const [line] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId));
    expect(Number(line!.qtyReceived)).toBe(6); // NOT 12

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(6);
  });

  it("PO receive: two CONCURRENT identical receives — single RR, stock/qtyReceived not doubled", async () => {
    const body = { lines: [{ po_line_id: poLineId, qty_received: 5 }] };
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/purchase-orders/${poId}/receive`).set("Authorization", `Bearer ${warehouseToken}`).send(body),
      request(app).post(`/api/v1/purchase-orders/${poId}/receive`).set("Authorization", `Bearer ${warehouseToken}`).send(body),
    ]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);

    const [line] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId));
    expect(Number(line!.qtyReceived)).toBe(11); // 6 (prior test) + 5, NOT 16

    const [stock] = await db
      .select()
      .from(inventoryStock)
      .where(and(eq(inventoryStock.warehouseId, mainWarehouseId), eq(inventoryStock.ingredientId, ingredientId)));
    expect(Number(stock!.quantity)).toBe(11);
  });
});

let _supplierId: string | undefined;
async function ensureSupplier(): Promise<string> {
  if (_supplierId) return _supplierId;
  const res = await request(app)
    .post("/api/v1/suppliers")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: `SUP-DS-${suffix()}`, name: "Double-Submit Test Supplier" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  _supplierId = res.body.id as string;
  return _supplierId;
}

// ---------------------------------------------------------------------------
// 4. PUT /menu/:id/recipe — no duplicate recipe_line rows under a race
// ---------------------------------------------------------------------------
describe("PUT /menu/:id/recipe — double-submit", () => {
  it("two CONCURRENT identical PUTs leave exactly the intended lines, not duplicates", async () => {
    const ingredientId = await createIngredient();
    const menuRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${brandManagerToken}`)
      .send({ name: `Recipe Item ${suffix()}`, price: 100 });
    expect(menuRes.status).toBe(201);
    const menuItemId = menuRes.body.id as string;

    const body = { lines: [{ ingredient_id: ingredientId, portion_qty: 0.2, unit: "kg" }] };
    const [r1, r2] = await Promise.all([
      request(app).put(`/api/v1/menu/${menuItemId}/recipe`).set("Authorization", `Bearer ${brandManagerToken}`).send(body),
      request(app).put(`/api/v1/menu/${menuItemId}/recipe`).set("Authorization", `Bearer ${brandManagerToken}`).send(body),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const lines = await db.select().from(recipeLines).where(eq(recipeLines.menuItemId, menuItemId));
    expect(lines.length).toBe(1); // NOT 2
  });
});

// ---------------------------------------------------------------------------
// 5. POST /orders/:id/discounts — no duplicate discount application
// ---------------------------------------------------------------------------
describe("POST /orders/:id/discounts — double-submit", () => {
  it("two SEQUENTIAL identical applies: second replays, order_discount row created once", async () => {
    const orderId = await createWalkInOrder("1000.00");
    const body = { type: "FIXED", value: 30, reason: `double-submit test ${suffix()}` };

    const r1 = await request(app).post(`/api/v1/orders/${orderId}/discounts`).set("Authorization", `Bearer ${adminToken}`).send(body);
    const r2 = await request(app).post(`/api/v1/orders/${orderId}/discounts`).set("Authorization", `Bearer ${adminToken}`).send(body);

    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.id).toBe(r1.body.id); // replay of the same row

    const rows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
    expect(rows.length).toBe(1);
    expect(r2.body.discount_total).toBe("30.00"); // NOT 60.00
  });

  it("two CONCURRENT identical applies: single order_discount row", async () => {
    const orderId = await createWalkInOrder("1000.00");
    const body = { type: "FIXED", value: 25, reason: `concurrent test ${suffix()}` };

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/orders/${orderId}/discounts`).set("Authorization", `Bearer ${adminToken}`).send(body),
      request(app).post(`/api/v1/orders/${orderId}/discounts`).set("Authorization", `Bearer ${adminToken}`).send(body),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);

    const rows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
    expect(rows.length).toBe(1);
  });

  it("a genuinely DIFFERENT discount on the same order is NOT deduped", async () => {
    const orderId = await createWalkInOrder("1000.00");
    const first = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "FIXED", value: 10, reason: "first" });
    const second = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "FIXED", value: 20, reason: "second, different amount" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const rows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
    expect(rows.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. POST /order-discounts/:id/approve — TOCTOU on the PENDING->APPROVED CAS
// ---------------------------------------------------------------------------
describe("POST /order-discounts/:id/approve — double-submit", () => {
  it("two CONCURRENT approves on an ADMIN-level PENDING discount — one 200, one 409", async () => {
    const orderId = await createWalkInOrder("1000.00");
    // amount=500 on a 1000 order => 50% of order AND >200 pesos => ADMIN level (PENDING, not auto-approved).
    const apply = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "FIXED", value: 500, reason: "big manual discount, needs ADMIN approval" });
    expect(apply.status, JSON.stringify(apply.body)).toBe(201);
    expect(apply.body.status).toBe("PENDING");
    expect(apply.body.approvalLevel).toBe("ADMIN");

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/order-discounts/${apply.body.id}/approve`).set("Authorization", `Bearer ${adminToken}`),
      request(app).post(`/api/v1/order-discounts/${apply.body.id}/approve`).set("Authorization", `Bearer ${adminToken}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, apply.body.id));
    expect(row!.status).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// 7. outbound enqueueCommand() — recovery-inside-aborted-tx fix
// ---------------------------------------------------------------------------
describe("enqueueCommand — double-submit", () => {
  it("two CONCURRENT enqueues with the SAME Idempotency-Key resolve to ONE command row", async () => {
    await db
      .update(operationalFeatureFlags)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(operationalFeatureFlags.key, OUTBOUND_COMMANDS_FLAG));

    const [listing] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "GRABFOOD", externalMerchantId: `grab-${suffix()}`, controlMode: "API" })
      .returning();

    const [owner] = await db.select().from(users).where(eq(users.email, "admin@cloudkitchen.local"));
    const idempotencyKey = `pause-${suffix()}`;

    const [c1, c2] = await Promise.all([
      enqueueCommand(db, { aggregatorAccountId: listing.id, commandType: "PAUSE_STORE", idempotencyKey, actorUserId: owner.id }),
      enqueueCommand(db, { aggregatorAccountId: listing.id, commandType: "PAUSE_STORE", idempotencyKey, actorUserId: owner.id }),
    ]);
    expect(c1.id).toBe(c2.id);

    const rows = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.aggregatorAccountId, listing.id));
    expect(rows.length).toBe(1);
  });

  it("two SEQUENTIAL enqueues with the SAME Idempotency-Key replay the same row", async () => {
    const [listing] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "FOODPANDA", externalMerchantId: `fp-${suffix()}`, controlMode: "API" })
      .returning();
    const [owner] = await db.select().from(users).where(eq(users.email, "admin@cloudkitchen.local"));
    const idempotencyKey = `pause-seq-${suffix()}`;

    const c1 = await enqueueCommand(db, { aggregatorAccountId: listing.id, commandType: "PAUSE_STORE", idempotencyKey, actorUserId: owner.id });
    const c2 = await enqueueCommand(db, { aggregatorAccountId: listing.id, commandType: "PAUSE_STORE", idempotencyKey, actorUserId: owner.id });
    expect(c1.id).toBe(c2.id);

    const rows = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.aggregatorAccountId, listing.id));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. reprintJob() — no duplicate physical print job on a double reprint
// ---------------------------------------------------------------------------
describe("reprintJob — double-submit", () => {
  it("two CONCURRENT reprints of the same job resolve to ONE new PENDING clone", async () => {
    const orderId = await createWalkInOrder("100.00");
    const [original] = await db
      .insert(printJobs)
      .values({ orderId, stationId, payload: { hello: "kot" }, status: "FAILED" })
      .returning();

    const [j1, j2] = await Promise.all([reprintJob(db, original.id), reprintJob(db, original.id)]);
    expect(j1.id).toBe(j2.id);

    const clones = await db.select().from(printJobs).where(eq(printJobs.reprintOfId, original.id));
    expect(clones.length).toBe(1);
  });

  it("a reprint AFTER the clone resolves (PRINTED) mints a fresh job — not blocked forever", async () => {
    const orderId = await createWalkInOrder("100.00");
    const [original] = await db
      .insert(printJobs)
      .values({ orderId, stationId, payload: { hello: "kot2" }, status: "FAILED" })
      .returning();

    const first = await reprintJob(db, original.id);
    await db.update(printJobs).set({ status: "PRINTED" }).where(eq(printJobs.id, first.id));

    const second = await reprintJob(db, original.id);
    expect(second.id).not.toBe(first.id); // legitimately reprintable again (Business Rule #7)

    const clones = await db.select().from(printJobs).where(eq(printJobs.reprintOfId, original.id));
    expect(clones.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 9. EMS attendance punch — no duplicate TIME_IN under a race
// ---------------------------------------------------------------------------
describe("POST /ems/attendance — double-submit", () => {
  it("two CONCURRENT identical TIME_IN punches — one 200, one 409, ONE attendance_record", async () => {
    const [kitchenUser] = await db.select().from(users).where(eq(users.email, "kitchen_staff@cloudkitchen.local"));
    const [emp] = await db.select().from(employees).where(eq(employees.userId, kitchenUser.id));
    expect(emp).toBeTruthy();

    const body = { employee_id: emp.id, type: "TIME_IN", photo: "data:image/jpeg;base64,ZmFrZQ==" };
    const [r1, r2] = await Promise.all([
      request(app).post("/api/v1/ems/attendance").set("Authorization", `Bearer ${kitchenToken}`).send(body),
      request(app).post("/api/v1/ems/attendance").set("Authorization", `Bearer ${kitchenToken}`).send(body),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const recordsRes = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${emp.id}&type=TIME_IN`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(recordsRes.status).toBe(200);
    expect(recordsRes.body.length).toBe(1); // NOT 2
  });
});
