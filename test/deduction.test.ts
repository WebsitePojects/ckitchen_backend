/**
 * Task 6 — Deduction Engine Tests (CK1-ARC-002 §5.1)
 *
 * Cardinal Business Rules under test:
 *   #2 — Deduct stock at PREPARING; cancel-after → compensating restock.
 *   #3 — Shared ingredient, per-recipe portion_qty (ONE pool, brand-specific deduction).
 *
 * Test setup uses the HTTP API throughout (full-stack via supertest).
 * Each describe group creates its OWN ingredient so stock values never cross-contaminate.
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
let kitchenToken: string;
let warehouseToken: string;
/** Grill station id (seeded by seed()) */
let grillStationId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per file
  db = created.db;
  await seed(db); // migrations + 1 location, 5 stations, 2 warehouses, role users

  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

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
// DEDUCTION: KITCHEN -= portionQty * qty for each recipe line on NEW→PREPARING
// (Cardinal Business Rule #2 + #3)
// ---------------------------------------------------------------------------

describe("Deduction engine: KITCHEN Chicken -= 350 exactly (200+150) on NEW→PREPARING", () => {
  let chickenId: string;
  let brandId: string;
  let teriyakiId: string;
  let tonkatsuId: string;
  let orderId: string;

  beforeAll(async () => {
    // ── 1. Create Chicken ingredient (threshold=100g) ──────────────────────
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Chicken_Deduction", unit: "g", unit_cost: "1.00", low_stock_threshold: "100" });
    expect(ingRes.status).toBe(201);
    chickenId = ingRes.body.id as string;

    // ── 2. Stock MAIN with 1000g, ITO → KITCHEN so KITCHEN Chicken = 1000g ─
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: chickenId, quantity: 1000 }] });

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: chickenId, quantity: 1000 }] });
    expect(itoRes.status).toBe(201);

    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    // ── 3. Create brand + FOODPANDA aggregator account ─────────────────────
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tokyo House (Deduction)", color: "#ff0000" });
    expect(brandRes.status).toBe(201);
    brandId = brandRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-TH-DED", credential_ref: "ref-ded" });

    // ── 4. Teriyaki Chicken: recipe = 200g Chicken, station = Grill ────────
    const terRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Teriyaki Chicken", price: "180", station_id: grillStationId });
    expect(terRes.status).toBe(201);
    teriyakiId = terRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${teriyakiId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenId, portion_qty: 200, unit: "g" }] });

    // ── 5. Tonkatsu: recipe = 150g Chicken, station = Grill ───────────────
    const tonRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tonkatsu", price: "200", station_id: grillStationId });
    expect(tonRes.status).toBe(201);
    tonkatsuId = tonRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${tonkatsuId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenId, portion_qty: 150, unit: "g" }] });

    // ── 6. Ingest order with Teriyaki qty=1 + Tonkatsu qty=1 ──────────────
    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: "FP-DEDUCT-001",
        customer_name: "Test User",
        items: [
          { menu_item_id: teriyakiId, qty: 1 },
          { menu_item_id: tonkatsuId, qty: 1 },
        ],
      });
    expect(ingestRes.status).toBe(201);
    orderId = ingestRes.body.order_id as string;
  });

  it("KITCHEN Chicken stays at 1000g while order is NEW (no deduction yet)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = (res.body as Array<{ ingredientId: string; quantity: string }>).find(
      (r) => r.ingredientId === chickenId,
    );
    expect(row).toBeTruthy();
    expect(Number(row!.quantity)).toBe(1000); // unchanged while NEW
  });

  it("advancing to PREPARING deducts exactly 350g (200+150) from KITCHEN Chicken", async () => {
    const advanceRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(advanceRes.status).toBe(200);
    expect(advanceRes.body.status).toBe("PREPARING");

    // KITCHEN Chicken must be exactly 650g
    const stockRes = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(stockRes.status).toBe(200);
    const row = (stockRes.body as Array<{ ingredientId: string; quantity: string }>).find(
      (r) => r.ingredientId === chickenId,
    );
    expect(row).toBeTruthy();
    expect(Number(row!.quantity)).toBe(650); // 1000 - 200 - 150 = 650 EXACT
  });

  it("prepAt timestamp is set after advancing to PREPARING", async () => {
    const detailRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.prepAt).toBeTruthy();
    expect(detailRes.body.readyAt).toBeNull();
    expect(detailRes.body.completedAt).toBeNull();
  });

  it("advancing PREPARING→READY sets readyAt, does NOT further deduct stock", async () => {
    const advanceRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(advanceRes.status).toBe(200);
    expect(advanceRes.body.status).toBe("READY");

    // Stock should still be 650 (deduction only happens once at PREPARING)
    const stockRes = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    const row = (stockRes.body as Array<{ ingredientId: string; quantity: string }>).find(
      (r) => r.ingredientId === chickenId,
    );
    expect(Number(row!.quantity)).toBe(650); // unchanged

    const detailRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.body.readyAt).toBeTruthy();
  });

  it("advancing READY→COMPLETED sets completedAt", async () => {
    const advanceRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(advanceRes.status).toBe(200);
    expect(advanceRes.body.status).toBe("COMPLETED");

    const detailRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.body.completedAt).toBeTruthy();
  });

  it("advancing a COMPLETED order → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// CANCEL-AFTER-PREPARING: compensating restock (Cardinal Business Rule #2)
// Uses a SEPARATE ingredient (Pork) so this group's stock is independent.
// ---------------------------------------------------------------------------

describe("Cancel-after-preparing: compensating restock restores KITCHEN Pork to 1000g", () => {
  let porkId: string;
  let cancelBrandId: string;
  let ribsAId: string;
  let ribsBId: string;
  let cancelOrderId: string;

  beforeAll(async () => {
    // ── 1. Pork ingredient, threshold=100g ──────────────────────────────────
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Pork_Cancel", unit: "g", unit_cost: "1.50", low_stock_threshold: "100" });
    expect(ingRes.status).toBe(201);
    porkId = ingRes.body.id as string;

    // MAIN=1000 → ITO → KITCHEN Pork = 1000g
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: porkId, quantity: 1000 }] });

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: porkId, quantity: 1000 }] });

    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    // ── 2. Brand + account ─────────────────────────────────────────────────
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Seoul Bowl (Cancel)", color: "#00ff00" });
    cancelBrandId = brandRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${cancelBrandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "GRABFOOD", external_merchant_id: "GF-SB-CAN", credential_ref: "ref-can" });

    // ── 3. Menu items with Pork recipes (200g + 150g) ──────────────────────
    const ribsARes = await request(app)
      .post(`/api/v1/brands/${cancelBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Pork Ribs A", price: "250", station_id: grillStationId });
    ribsAId = ribsARes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${ribsAId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: porkId, portion_qty: 200, unit: "g" }] });

    const ribsBRes = await request(app)
      .post(`/api/v1/brands/${cancelBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Pork Ribs B", price: "220", station_id: grillStationId });
    ribsBId = ribsBRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${ribsBId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: porkId, portion_qty: 150, unit: "g" }] });

    // ── 4. Ingest order + advance to PREPARING (deducts 350g) ─────────────
    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: cancelBrandId,
        aggregator: "GRABFOOD",
        external_ref: "GF-CANCEL-001",
        items: [
          { menu_item_id: ribsAId, qty: 1 },
          { menu_item_id: ribsBId, qty: 1 },
        ],
      });
    expect(ingestRes.status).toBe(201);
    cancelOrderId = ingestRes.body.order_id as string;

    // Advance to PREPARING → KITCHEN Pork -= 350 → should be 650
    const advRes = await request(app)
      .post(`/api/v1/orders/${cancelOrderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(advRes.status).toBe(200);
    expect(advRes.body.status).toBe("PREPARING");
  });

  it("KITCHEN Pork = 650 after advancing to PREPARING (deduction happened)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    const row = (res.body as Array<{ ingredientId: string; quantity: string }>).find(
      (r) => r.ingredientId === porkId,
    );
    expect(Number(row!.quantity)).toBe(650); // 1000 - 350 = 650
  });

  it("cancelling the PREPARING order restores KITCHEN Pork back to 1000g exactly", async () => {
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${cancelOrderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("CANCELLED");

    // Compensating restock: KITCHEN Pork must be exactly 1000g again
    const stockRes = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    const row = (stockRes.body as Array<{ ingredientId: string; quantity: string }>).find(
      (r) => r.ingredientId === porkId,
    );
    expect(row).toBeTruthy();
    expect(Number(row!.quantity)).toBe(1000); // 650 + 350 = 1000 EXACT
  });

  it("cancelling a CANCELLED order → 400 VALIDATION_ERROR (idempotent guard)", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${cancelOrderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// RBAC enforcement on advance / cancel / ingest
// ---------------------------------------------------------------------------

describe("RBAC: advance/cancel require SUPER_ADMIN or KITCHEN_STAFF", () => {
  let rbacOrderId: string;
  let rbacBrandId: string;
  let rbacIngId: string;
  let rbacMenuId: string;
  let accountantToken: string;

  beforeAll(async () => {
    accountantToken = await login("accountant@cloudkitchen.local", "password123");

    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Beef_RBAC", unit: "g", unit_cost: "2.00", low_stock_threshold: "10" });
    rbacIngId = ingRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: rbacIngId, quantity: 500 }] });
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: rbacIngId, quantity: 500 }] });
    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "RBAC Brand", color: "#0000ff" });
    rbacBrandId = brandRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${rbacBrandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "OTHER", external_merchant_id: "OTH-RBAC", credential_ref: "ref-rbac" });

    const menuRes = await request(app)
      .post(`/api/v1/brands/${rbacBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "RBAC Item", price: "100", station_id: grillStationId });
    rbacMenuId = menuRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${rbacMenuId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: rbacIngId, portion_qty: 50, unit: "g" }] });

    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: rbacBrandId,
        aggregator: "OTHER",
        external_ref: "OTH-RBAC-001",
        items: [{ menu_item_id: rbacMenuId, qty: 1 }],
      });
    rbacOrderId = ingestRes.body.order_id as string;
  });

  it("KITCHEN_STAFF can advance an order", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${rbacOrderId}/advance`)
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(200);
  });

  it("ACCOUNTANT cannot advance an order → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${rbacOrderId}/advance`)
      .set("Authorization", `Bearer ${accountantToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ACCOUNTANT cannot cancel an order → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${rbacOrderId}/cancel`)
      .set("Authorization", `Bearer ${accountantToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("KITCHEN_STAFF can cancel an order", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${rbacOrderId}/cancel`)
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });
});
