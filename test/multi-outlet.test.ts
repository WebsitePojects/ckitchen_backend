/**
 * ORION W3b — Multi-outlet correctness (cross-outlet isolation).
 *
 * Covers three defects fixed together:
 *   1. Cross-outlet stock deduction (SEVERE) — advanceOrder / cancelOrder must
 *      deduct + restock ONLY the order's own outlet's KITCHEN warehouse. Cardinal
 *      rule: an outlet owns its own inventory.
 *   2. resolveLocationId in brands/stations always picked "the first location" —
 *      brands/stations can now be created at a specific outlet (X-Outlet-Id /
 *      body location_id), membership-checked, default-outlet fallback preserved.
 *   3. brand_outlet many-to-many (D30) — a brand may operate in 2+ outlets;
 *      GET/POST/DELETE deployment endpoints + home-outlet backfill on create.
 *
 * Full-stack via supertest, in-memory PGlite per file (isolated from other files).
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

let app: Express;
let db: DB;
let adminToken: string; // OWNER — ALL scope
let brandManagerToken: string; // BRAND_MANAGER — ASSIGNED to outlet 1 only

let outlet1Id: string; // seeded CK1 (the deployment default)
let outlet2Id: string; // CK2, created in this suite

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

/** KITCHEN balance for one ingredient at one outlet (undefined if no row). */
async function kitchenQty(outletId: string, ingredientId: string): Promise<number | undefined> {
  const res = await request(app)
    .get(`/api/v1/inventory?warehouse=KITCHEN&outlet_id=${outletId}`)
    .set("Authorization", `Bearer ${adminToken}`);
  const row = (res.body as Array<{ ingredientId: string; quantity: string }>).find(
    (r) => r.ingredientId === ingredientId,
  );
  return row ? Number(row.quantity) : undefined;
}

/** Receive into MAIN then ITO the full qty into KITCHEN for a given outlet (as OWNER). */
async function stockKitchen(outletId: string, ingredientId: string, qty: number): Promise<void> {
  await request(app)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ outlet_id: outletId, items: [{ ingredient_id: ingredientId, quantity: qty }] });

  const itoRes = await request(app)
    .post("/api/v1/itos")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ outlet_id: outletId, from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingredientId, quantity: qty }] });

  await request(app)
    .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
    .set("Authorization", `Bearer ${adminToken}`);
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  brandManagerToken = await login("brand_manager@cloudkitchen.local", "password123");

  // Seeded outlet (CK1)
  const outletsRes = await request(app)
    .get("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`);
  outlet1Id = (outletsRes.body as Array<{ id: string; code: string }>).find((o) => o.code === "CK1")!.id;

  // Second physical outlet (CK2) — POST /outlets also creates its MAIN + KITCHEN warehouses.
  const outlet2Res = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "CK2", name: "CloudKitchen TWO", address: "Second Site" });
  expect(outlet2Res.status).toBe(201);
  outlet2Id = outlet2Res.body.id as string;
});

// ---------------------------------------------------------------------------
// DEFECT 2 — brands/stations created at a specific outlet
// ---------------------------------------------------------------------------

describe("Defect 2: brand/station creation targets a specific outlet", () => {
  it("creates a brand at outlet 2 via X-Outlet-Id header", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", outlet2Id)
      .send({ name: "Header Brand", color: "#111111" });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outlet2Id);
  });

  it("creates a brand at outlet 2 via body location_id", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Body Brand", color: "#222222", location_id: outlet2Id });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outlet2Id);
  });

  it("falls back to the default (first/home) outlet when none is specified", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Default Brand", color: "#333333" });
    expect(res.status).toBe(201);
    // Single-outlet behaviour preserved: resolves to the seeded home outlet (CK1).
    expect(res.body.locationId).toBe(outlet1Id);
  });

  it("ASSIGNED user cannot create a brand at an outlet outside their scope → 403", async () => {
    // brand_manager is seeded with access to outlet 1 only.
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${brandManagerToken}`)
      .send({ name: "Sneaky Brand", color: "#444444", location_id: outlet2Id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("creates a station at outlet 2 via X-Outlet-Id header", async () => {
    const res = await request(app)
      .post("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", outlet2Id)
      .send({ name: "Outlet2 Grill" });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outlet2Id);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — brand_outlet many-to-many deployment endpoints
// ---------------------------------------------------------------------------

describe("Defect 3: brand_outlet deployment endpoints (D30)", () => {
  let brandId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Deploy Brand", color: "#556677", location_id: outlet1Id });
    brandId = res.body.id as string;
  });

  it("a newly created brand has a home brand_outlet deployment (backfill on create)", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ locationId: string; isActive: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].locationId).toBe(outlet1Id);
    expect(rows[0].isActive).toBe(true);
  });

  it("deploys the brand to a second outlet → 201, then GET lists both", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outlet2Id });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outlet2Id);
    expect(res.body.isActive).toBe(true);

    const list = await request(app)
      .get(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`);
    const activeLocations = (list.body as Array<{ locationId: string; isActive: boolean }>)
      .filter((r) => r.isActive)
      .map((r) => r.locationId);
    expect(activeLocations).toContain(outlet1Id);
    expect(activeLocations).toContain(outlet2Id);
  });

  it("re-deploying an already-active outlet is idempotent → 200, no duplicate row", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outlet2Id });
    expect(res.status).toBe(200);

    const list = await request(app)
      .get(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outlet2Rows = (list.body as Array<{ locationId: string }>).filter(
      (r) => r.locationId === outlet2Id,
    );
    expect(outlet2Rows).toHaveLength(1);
  });

  it("DELETE deactivates a deployment (soft — row kept, is_active=false)", async () => {
    const res = await request(app)
      .delete(`/api/v1/brands/${brandId}/outlets/${outlet2Id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const list = await request(app)
      .get(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outlet2Row = (list.body as Array<{ locationId: string; isActive: boolean }>).find(
      (r) => r.locationId === outlet2Id,
    );
    expect(outlet2Row).toBeTruthy(); // NOT hard-deleted
    expect(outlet2Row!.isActive).toBe(false);
  });

  it("re-deploying a deactivated outlet reactivates it → 200 is_active=true", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outlet2Id });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
  });

  it("non-OWNER cannot deploy a brand to an outlet → 403", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${brandManagerToken}`)
      .send({ location_id: outlet1Id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// DEFECT 1 — Cross-outlet deduction isolation (the important one)
// ---------------------------------------------------------------------------

describe("Defect 1: advancing an outlet-2 order deducts ONLY outlet-2 stock", () => {
  let beefId: string;
  let brand2Id: string;
  let menu2Id: string;
  let orderId: string;

  beforeAll(async () => {
    // Shared-name ingredient stocked identically in BOTH outlets' KITCHEN (1000g each).
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Beef_MultiOutlet", unit: "g", unit_cost: "2.00", low_stock_threshold: "100" });
    beefId = ingRes.body.id as string;

    await stockKitchen(outlet1Id, beefId, 1000);
    await stockKitchen(outlet2Id, beefId, 1000);

    // A station at outlet 2 for the brand's menu item.
    const stationRes = await request(app)
      .post("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", outlet2Id)
      .send({ name: "MO Grill O2" });
    const station2Id = stationRes.body.id as string;

    // Brand deployed at outlet 2 (its home outlet).
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Outlet2 Kitchen Co", color: "#0088ff", location_id: outlet2Id });
    brand2Id = brandRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${brand2Id}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-O2", credential_ref: "ref-o2" });

    const menuRes = await request(app)
      .post(`/api/v1/brands/${brand2Id}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Beef Bowl O2", price: "200", station_id: station2Id });
    menu2Id = menuRes.body.id as string;

    await request(app)
      .put(`/api/v1/menu/${menu2Id}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: beefId, portion_qty: 300, unit: "g" }] });

    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brand2Id,
        aggregator: "FOODPANDA",
        external_ref: "FP-O2-DEDUCT-001",
        items: [{ menu_item_id: menu2Id, qty: 1 }],
      });
    expect(ingestRes.status).toBe(201);
    orderId = ingestRes.body.order_id as string;
  });

  it("both outlets start with KITCHEN Beef = 1000g", async () => {
    expect(await kitchenQty(outlet1Id, beefId)).toBe(1000);
    expect(await kitchenQty(outlet2Id, beefId)).toBe(1000);
  });

  it("advancing the outlet-2 order deducts 300g from OUTLET 2 ONLY", async () => {
    const advRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(advRes.status).toBe(200);
    expect(advRes.body.status).toBe("PREPARING");

    // Outlet 2 deducted: 1000 - 300 = 700
    expect(await kitchenQty(outlet2Id, beefId)).toBe(700);
    // Outlet 1 UNTOUCHED — this is the cross-outlet bug guard.
    expect(await kitchenQty(outlet1Id, beefId)).toBe(1000);
  });

  it("cancel-after-preparing restocks OUTLET 2 ONLY, leaving outlet 1 unchanged", async () => {
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "cross-outlet restock isolation test" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("CANCELLED");

    // Outlet 2 restored: 700 + 300 = 1000
    expect(await kitchenQty(outlet2Id, beefId)).toBe(1000);
    // Outlet 1 still exactly 1000 — restock never credited the wrong outlet.
    expect(await kitchenQty(outlet1Id, beefId)).toBe(1000);
  });
});
