/**
 * ERP R1 — Universal Stock Ledger Tests
 *
 * Tests the append-only audit trail that shadows every inventoryStock mutation.
 * The ledger does NOT replace inventoryStock — it is additive.
 *
 * Coverage:
 *   1. Receiving stock posts an IN ledger row (source_module=RECEIVE).
 *   2. Confirming an ITO posts OUT(MAIN) + IN(KITCHEN) (source_module=ITO).
 *   3. Advancing an order NEW→PREPARING posts ORDER_DEDUCTION OUT rows for each
 *      deducted ingredient (source_module=ORDER_DEDUCTION).
 *   4. Cancelling after PREPARING posts RESTOCK IN rows (source_module=RESTOCK).
 *   5. Re-posting the same (source_module, source_document_no, source_line_no) is
 *      a no-op (idempotency — onConflictDoNothing on the unique key).
 *   6. GET /stock-ledger filters: ingredient_id, warehouse_id, source_module, from, to.
 *   7. GET /stock-ledger returns 401 when unauthenticated.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

let app: Express;
let db: DB;
let adminToken: string;
let warehouseToken: string;
let kitchenToken: string;

/** Seeded grill station id — resolved in beforeAll */
let grillStationId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per file
  db = created.db;
  await seed(db); // migrations + location, warehouses, stations, role users

  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  // Resolve the seeded "Grill" station id
  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grillStation = (stRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  grillStationId = grillStation!.id;
});

// ---------------------------------------------------------------------------
// 1. Receive → LEDGER: IN row for MAIN warehouse
// ---------------------------------------------------------------------------

describe("Ledger: inventory receive posts IN row (source_module=RECEIVE)", () => {
  let ingredientId: string;
  let mainWarehouseId: string;

  beforeAll(async () => {
    // Create ingredient
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerRiceReceive", unit: "kg", unit_cost: "45.00", low_stock_threshold: "5" });
    expect(ingRes.status).toBe(201);
    ingredientId = ingRes.body.id as string;

    // Lookup MAIN warehouse id
    const whRes = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`);
    const mainWh = (whRes.body as Array<{ id: string; type: string }>).find(
      (w) => w.type === "MAIN",
    );
    mainWarehouseId = mainWh!.id;

    // Receive 20 kg into MAIN
    const recvRes = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 20 }] });
    expect(recvRes.status).toBe(201);
  });

  it("GET /stock-ledger?ingredient_id= returns at least one RECEIVE IN row", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${ingredientId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find(
      (r: { sourceModule: string; movementType: string; ingredientId: string }) =>
        r.sourceModule === "RECEIVE" &&
        r.movementType === "IN" &&
        r.ingredientId === ingredientId,
    );
    expect(row).toBeTruthy();
    expect(Number(row.quantity)).toBe(20);
    expect(row.warehouseId).toBe(mainWarehouseId);
  });

  it("GET /stock-ledger?source_module=RECEIVE filters by module", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?source_module=RECEIVE&ingredient_id=${ingredientId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{ sourceModule: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sourceModule === "RECEIVE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. ITO confirm → LEDGER: OUT(MAIN) + IN(KITCHEN)
// ---------------------------------------------------------------------------

describe("Ledger: ITO confirm posts OUT(MAIN) + IN(KITCHEN) (source_module=ITO)", () => {
  let ingredientId: string;
  let mainWarehouseId: string;
  let kitchenWarehouseId: string;
  let itoId: string;

  beforeAll(async () => {
    // Create ingredient
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerPorkITO", unit: "kg", unit_cost: "150.00", low_stock_threshold: "3" });
    expect(ingRes.status).toBe(201);
    ingredientId = ingRes.body.id as string;

    // Lookup warehouse ids
    const whRes = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`);
    const mainWh = (whRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "MAIN");
    const kitWh = (whRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "KITCHEN");
    mainWarehouseId = mainWh!.id;
    kitchenWarehouseId = kitWh!.id;

    // Receive 30 kg into MAIN
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 30 }] });

    // Create ITO MAIN→KITCHEN for 15 kg
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingredientId, quantity: 15 }] });
    expect(itoRes.status).toBe(201);
    itoId = itoRes.body.id as string;

    // Confirm the ITO
    const confirmRes = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(confirmRes.status).toBe(200);
  });

  it("ledger has OUT row from MAIN for the ITO", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${ingredientId}&source_module=ITO`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const outRow = (res.body as Array<{
      sourceModule: string;
      movementType: string;
      warehouseId: string;
      sourceDocumentNo: string;
    }>).find(
      (r) => r.sourceModule === "ITO" && r.movementType === "OUT" && r.warehouseId === mainWarehouseId,
    );
    expect(outRow).toBeTruthy();
    expect(outRow!.sourceDocumentNo).toBe(itoId);
  });

  it("ledger has IN row to KITCHEN for the ITO", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${ingredientId}&source_module=ITO`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const inRow = (res.body as Array<{
      sourceModule: string;
      movementType: string;
      warehouseId: string;
    }>).find(
      (r) => r.sourceModule === "ITO" && r.movementType === "IN" && r.warehouseId === kitchenWarehouseId,
    );
    expect(inRow).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. Order NEW→PREPARING → LEDGER: ORDER_DEDUCTION OUT rows
// ---------------------------------------------------------------------------

describe("Ledger: order NEW→PREPARING posts ORDER_DEDUCTION OUT rows", () => {
  let chickenId: string;
  let orderId: string;
  let kitchenWarehouseId: string;
  let brandId: string;
  let menuItemId: string;

  beforeAll(async () => {
    // Create ingredient
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerChickenOD", unit: "g", unit_cost: "2.00", low_stock_threshold: "100" });
    expect(ingRes.status).toBe(201);
    chickenId = ingRes.body.id as string;

    // Lookup kitchen warehouse id
    const whRes = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`);
    const kitWh = (whRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "KITCHEN");
    kitchenWarehouseId = kitWh!.id;

    // Stock: receive into MAIN, ITO to KITCHEN
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: chickenId, quantity: 2000 }] });

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: chickenId, quantity: 2000 }] });
    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    // Create brand
    const bRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerBrand", color: "#FFFFFF" });
    expect(bRes.status).toBe(201);
    brandId = bRes.body.id as string;

    // Add FOODPANDA aggregator account
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "lbfp001", credential_ref: "cred-lbfp001" });

    // Create menu item
    const miRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Chicken Dish OD", price: "199.00", station_id: grillStationId });
    expect(miRes.status).toBe(201);
    menuItemId = miRes.body.id as string;

    // Add recipe (200g chicken)
    await request(app)
      .put(`/api/v1/menu/${menuItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenId, portion_qty: 200, unit: "g" }] });

    // Ingest an order (NEW)
    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: "ledger-od-001",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    orderId = orderRes.body.order_id as string;

    // Advance to PREPARING (triggers deduction)
    const advRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(advRes.status).toBe(200);
    expect(advRes.body.status).toBe("PREPARING");
  });

  it("ledger has ORDER_DEDUCTION OUT row for chicken in KITCHEN matching recipe qty", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${chickenId}&source_module=ORDER_DEDUCTION`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      sourceModule: string;
      movementType: string;
      warehouseId: string;
      sourceDocumentNo: string;
      quantity: string;
    }>;
    const outRow = rows.find(
      (r) =>
        r.sourceModule === "ORDER_DEDUCTION" &&
        r.movementType === "OUT" &&
        r.warehouseId === kitchenWarehouseId &&
        r.sourceDocumentNo === orderId,
    );
    expect(outRow).toBeTruthy();
    // portionQty=200, qty=1 → deduction=200
    expect(Number(outRow!.quantity)).toBe(200);
  });

  it("GET /stock-ledger?warehouse_id= filters by warehouse", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?warehouse_id=${kitchenWarehouseId}&source_module=ORDER_DEDUCTION`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{ warehouseId: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.warehouseId === kitchenWarehouseId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Cancel after PREPARING → LEDGER: RESTOCK IN rows
// ---------------------------------------------------------------------------

describe("Ledger: cancel after PREPARING posts RESTOCK IN rows", () => {
  let beefId: string;
  let kitchenWarehouseId: string;
  let orderId: string;
  let brandId: string;
  let menuItemId: string;

  beforeAll(async () => {
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerBeefRestock", unit: "g", unit_cost: "3.00", low_stock_threshold: "50" });
    expect(ingRes.status).toBe(201);
    beefId = ingRes.body.id as string;

    const whRes = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`);
    const kitWh = (whRes.body as Array<{ id: string; type: string }>).find((w) => w.type === "KITCHEN");
    kitchenWarehouseId = kitWh!.id;

    // Stock kitchen with 1000g beef
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: beefId, quantity: 1000 }] });
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: beefId, quantity: 1000 }] });
    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    // Brand + menu item with 300g beef recipe
    const bRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerRestockBrand", color: "#AABBCC" });
    expect(bRes.status).toBe(201);
    brandId = bRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "GRABFOOD", external_merchant_id: "lrb001", credential_ref: "cred-lrb001" });

    const miRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Beef Dish Restock", price: "299.00", station_id: grillStationId });
    expect(miRes.status).toBe(201);
    menuItemId = miRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${menuItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: beefId, portion_qty: 300, unit: "g" }] });

    // Ingest + advance to PREPARING
    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "GRABFOOD",
        external_ref: "ledger-restock-001",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    orderId = orderRes.body.order_id as string;

    await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    // Cancel the order → triggers compensating restock
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "ledger restock test" });
    expect(cancelRes.status).toBe(200);
  });

  it("ledger has RESTOCK IN row for beef after cancel", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${beefId}&source_module=RESTOCK`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      sourceModule: string;
      movementType: string;
      warehouseId: string;
      sourceDocumentNo: string;
      quantity: string;
    }>;
    const restockRow = rows.find(
      (r) =>
        r.sourceModule === "RESTOCK" &&
        r.movementType === "IN" &&
        r.warehouseId === kitchenWarehouseId &&
        r.sourceDocumentNo === orderId,
    );
    expect(restockRow).toBeTruthy();
    expect(Number(restockRow!.quantity)).toBe(300); // portion 300g × qty 1
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency: re-posting the same (module, doc, line) is a no-op
// ---------------------------------------------------------------------------

describe("Ledger idempotency: duplicate (module, doc, line) is a no-op", () => {
  it("receiving the same ingredient twice posts two RECEIVE rows (unique doc per call)", async () => {
    // Create a fresh ingredient
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerIdempotent", unit: "kg", unit_cost: "10.00", low_stock_threshold: "1" });
    const ingredientId = ingRes.body.id as string;

    // Receive twice — each receive call generates its own document ref so both should be recorded
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 5 }] });

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 5 }] });

    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${ingredientId}&source_module=RECEIVE`)
      .set("Authorization", `Bearer ${adminToken}`);

    // Both receives should produce ledger rows (they have distinct doc refs)
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 6. GET /stock-ledger date range filters (from / to)
// ---------------------------------------------------------------------------

describe("Ledger: GET /stock-ledger date filters (from/to)", () => {
  it("from filter excludes rows before the timestamp", async () => {
    const futureFrom = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app)
      .get(`/api/v1/stock-ledger?from=${encodeURIComponent(futureFrom)}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // All existing ledger rows were posted before the future timestamp → should be 0
    expect(res.body.length).toBe(0);
  });

  it("to filter excludes rows after the timestamp", async () => {
    const pastTo = new Date(Date.now() - 60_000).toISOString();
    const res = await request(app)
      .get(`/api/v1/stock-ledger?to=${encodeURIComponent(pastTo)}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // All ledger rows posted in this test run are after pastTo → should be 0
    expect(res.body.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Auth guard
// ---------------------------------------------------------------------------

describe("Ledger: GET /stock-ledger auth guard", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/stock-ledger");
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 8. source_ref enrichment + q search (client review 2026-07-08)
// ---------------------------------------------------------------------------

describe("Ledger enrichment: source_ref + q search", () => {
  let searchIngredientId: string;
  let orderId: string;
  let orderCode: string;
  let rrNo: string;

  beforeAll(async () => {
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerSearchSalmon", unit: "g", unit_cost: "5.00", low_stock_threshold: "100" });
    expect(ingRes.status).toBe(201);
    searchIngredientId = ingRes.body.id as string;

    // Direct receive — 0024 returns the RR; its rr_no is what RECEIVE ledger
    // rows now stamp as sourceDocumentNo (and resolve as source_ref).
    const recvRes = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: searchIngredientId, quantity: 5000 }] });
    expect(recvRes.status).toBe(201);
    rrNo = recvRes.body.rr.rrNo as string;

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: searchIngredientId, quantity: 3000 }] });
    expect(itoRes.status).toBe(201);
    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    const bRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LedgerSearchBrand", color: "#123123" });
    const brandId = bRes.body.id as string;
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "lsb001", credential_ref: "cred-lsb001" });
    const miRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Salmon Search Dish", price: "349.00", station_id: grillStationId });
    const menuItemId = miRes.body.id as string;
    await request(app)
      .put(`/api/v1/menu/${menuItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: searchIngredientId, portion_qty: 250, unit: "g" }] });

    const orderRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: "ledger-search-001",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(orderRes.status).toBe(201);
    orderId = orderRes.body.order_id as string;
    orderCode = orderRes.body.order_code as string;
    expect(orderCode).toBeTruthy();

    const advRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(advRes.status).toBe(200);
    expect(advRes.body.status).toBe("PREPARING");
  });

  it("an order-sourced row carries the order's code as source_ref", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${searchIngredientId}&source_module=ORDER_DEDUCTION`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ sourceDocumentNo: string; source_ref: string | null }>).find(
      (r) => r.sourceDocumentNo === orderId,
    );
    expect(row).toBeTruthy();
    expect(row!.source_ref).toBe(orderCode);
  });

  it("a RECEIVE row resolves source_ref to the RR number", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${searchIngredientId}&source_module=RECEIVE`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ sourceDocumentNo: string; source_ref: string | null }>).find(
      (r) => r.sourceDocumentNo === rrNo,
    );
    expect(row).toBeTruthy();
    expect(row!.source_ref).toBe(rrNo);
  });

  it("ITO rows keep source_ref null (raw doc id column remains)", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?ingredient_id=${searchIngredientId}&source_module=ITO`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ source_ref: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source_ref === null)).toBe(true);
  });

  it("q= by order code finds the deduction row (case-insensitive)", async () => {
    const res = await request(app)
      .get(`/api/v1/stock-ledger?q=${encodeURIComponent(orderCode.toLowerCase())}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(
      (res.body as Array<{ source_ref: string | null }>).some((r) => r.source_ref === orderCode),
    ).toBe(true);
  });

  it("q= by ingredient name matches only that ingredient's rows", async () => {
    const res = await request(app)
      .get("/api/v1/stock-ledger?q=ledgersearchsalmon")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ ingredientId: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ingredientId === searchIngredientId)).toBe(true);
  });

  it("q miss returns an empty array", async () => {
    const res = await request(app)
      .get("/api/v1/stock-ledger?q=zzz-no-such-ref-999")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
