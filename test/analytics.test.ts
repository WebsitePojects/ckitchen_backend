/**
 * Task 9 — Analytics Tests (CK1-API-003 §9)
 *
 * Fixtures: 2 brands, 1 shared ingredient, 2 menu items with recipes, 4 orders
 * spread across aggregators and hours, placed on 2026-01-15 (UTC).
 *
 * All known-number assertions are derived from hand-computed values:
 *
 *   Ingredient: Chicken — unit_cost = 0.05 /g
 *
 *   Menu A (Tokyo House): Teriyaki Chicken — price=200, recipe=200g chicken
 *     → recipe_cost per unit = 200 * 0.05 = 10.00
 *     → margin per unit      = 200 - 10   = 190.00
 *
 *   Menu B (Seoul Bowl): Korean Chicken Bowl — price=150, recipe=150g chicken
 *     → recipe_cost per unit = 150 * 0.05 = 7.50
 *     → margin per unit      = 150 - 7.50 = 142.50
 *
 *   Orders on 2026-01-15 (UTC):
 *     O-A1  10:00 UTC  Tokyo House  FOODPANDA  1×Teriyaki  total=200
 *     O-A2  10:30 UTC  Tokyo House  GRABFOOD   1×Teriyaki  total=200
 *     O-A3  10:15 UTC  Tokyo House  OTHER      1×Teriyaki  total=200
 *     O-B1  14:00 UTC  Seoul Bowl   FOODPANDA  1×Korean    total=150
 *
 *   Brand analytics (2026-01-15):
 *     Tokyo House  revenue=600  orders=3  avg=200  → ranked 1st (top)
 *     Seoul Bowl   revenue=150  orders=1  avg=150  → ranked 2nd (weakest)
 *
 *   Orders-by-hour (2026-01-15):
 *     hour=10 → 3 orders
 *     hour=14 → 1 order
 *
 *   Aggregators (2026-01-15):
 *     FOODPANDA  orders=2  revenue=350
 *     GRABFOOD   orders=1  revenue=200
 *     OTHER      orders=1  revenue=200
 *
 *   Margins (2026-01-15):
 *     Tokyo House  revenue=600  recipe_cost_total=30.00  margin=570.00
 *     Seoul Bowl   revenue=150  recipe_cost_total=7.50   margin=142.50
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: Express;
let db: DB;
let adminToken: string;
let accountantToken: string;
let kitchenToken: string;

let brandAId: string; // Tokyo House
let brandBId: string; // Seoul Bowl
let menuAId: string;  // Teriyaki Chicken
let menuBId: string;  // Korean Chicken Bowl

const TEST_DATE = "2026-01-15";
const FROM = "2026-01-15T00:00:00.000Z";
const TO = "2026-01-15T23:59:59.999Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

// ---------------------------------------------------------------------------
// One-time fixture setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // ── 1. Fresh in-memory DB + migrations + seed ────────────────────────────
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  // ── 2. Tokens ────────────────────────────────────────────────────────────
  adminToken = await login("admin@cloudkitchen.local", "admin123");
  accountantToken = await login("accountant@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  // ── 3. Resolve Grill station (from seed) ────────────────────────────────
  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(stRes.status).toBe(200);
  const grillStation = (stRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  expect(grillStation, "Grill station missing from seed").toBeTruthy();
  const grillStationId = grillStation!.id;

  // ── 4. Create ingredient: Chicken (unit_cost = 0.05) ────────────────────
  const ingRes = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Chicken", unit: "g", unit_cost: "0.05", low_stock_threshold: "100" });
  expect(ingRes.status).toBe(201);
  const chickenId = ingRes.body.id as string;

  // ── 5. Brand A: Tokyo House ──────────────────────────────────────────────
  const brandARes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Tokyo House", color: "#FF0000" });
  expect(brandARes.status).toBe(201);
  brandAId = brandARes.body.id as string;

  // Accounts: FP + GF + OTHER
  for (const agg of ["FOODPANDA", "GRABFOOD", "OTHER"] as const) {
    const accRes = await request(app)
      .post(`/api/v1/brands/${brandAId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: agg, external_merchant_id: `A-${agg}`, credential_ref: `ref-a-${agg}` });
    expect(accRes.status).toBe(201);
  }

  // Menu item A: Teriyaki Chicken, price=200
  const menuARes = await request(app)
    .post(`/api/v1/brands/${brandAId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Teriyaki Chicken", price: "200", station_id: grillStationId });
  expect(menuARes.status).toBe(201);
  menuAId = menuARes.body.id as string;

  // Recipe: 200g chicken → recipe_cost = 200*0.05 = 10.00
  const recipeARes = await request(app)
    .put(`/api/v1/menu/${menuAId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: chickenId, portion_qty: 200, unit: "g" }] });
  expect(recipeARes.status).toBe(200);

  // ── 6. Brand B: Seoul Bowl ───────────────────────────────────────────────
  const brandBRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Seoul Bowl", color: "#0000FF" });
  expect(brandBRes.status).toBe(201);
  brandBId = brandBRes.body.id as string;

  // Account: FP
  const accBRes = await request(app)
    .post(`/api/v1/brands/${brandBId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "B-FP", credential_ref: "ref-b-fp" });
  expect(accBRes.status).toBe(201);

  // Menu item B: Korean Chicken Bowl, price=150
  const menuBRes = await request(app)
    .post(`/api/v1/brands/${brandBId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Korean Chicken Bowl", price: "150", station_id: grillStationId });
  expect(menuBRes.status).toBe(201);
  menuBId = menuBRes.body.id as string;

  // Recipe: 150g chicken → recipe_cost = 150*0.05 = 7.50
  const recipeBRes = await request(app)
    .put(`/api/v1/menu/${menuBId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: chickenId, portion_qty: 150, unit: "g" }] });
  expect(recipeBRes.status).toBe(200);

  // ── 7. Ingest 4 orders on 2026-01-15 ────────────────────────────────────
  // O-A1: Tokyo House, FOODPANDA, 10:00 UTC, 1×Teriyaki → total=200
  const oa1 = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandAId,
      aggregator: "FOODPANDA",
      external_ref: "AN-A1",
      placed_at: "2026-01-15T10:00:00.000Z",
      items: [{ menu_item_id: menuAId, qty: 1 }],
    });
  expect(oa1.status).toBe(201);

  // O-A2: Tokyo House, GRABFOOD, 10:30 UTC, 1×Teriyaki → total=200
  const oa2 = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandAId,
      aggregator: "GRABFOOD",
      external_ref: "AN-A2",
      placed_at: "2026-01-15T10:30:00.000Z",
      items: [{ menu_item_id: menuAId, qty: 1 }],
    });
  expect(oa2.status).toBe(201);

  // O-A3: Tokyo House, OTHER, 10:15 UTC, 1×Teriyaki → total=200
  const oa3 = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandAId,
      aggregator: "OTHER",
      external_ref: "AN-A3",
      placed_at: "2026-01-15T10:15:00.000Z",
      items: [{ menu_item_id: menuAId, qty: 1 }],
    });
  expect(oa3.status).toBe(201);

  // O-B1: Seoul Bowl, FOODPANDA, 14:00 UTC, 1×Korean Bowl → total=150
  const ob1 = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandBId,
      aggregator: "FOODPANDA",
      external_ref: "AN-B1",
      placed_at: "2026-01-15T14:00:00.000Z",
      items: [{ menu_item_id: menuBId, qty: 1 }],
    });
  expect(ob1.status).toBe(201);
}, 60_000);

// ---------------------------------------------------------------------------
// GET /analytics/brands
// ---------------------------------------------------------------------------

describe("GET /api/v1/analytics/brands", () => {
  it("returns 200 array ranked top→weak for SUPER_ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("Tokyo House ranks first (higher revenue) in date range", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ brand_id: string; name: string; revenue: number; order_count: number; avg_order_value: number; is_weakest: boolean }>;

    // Filter to our test brands (seed + other tests might add brands in other test files,
    // but this is a fresh DB so only our brands exist)
    const tokyoEntry = body.find((b) => b.brand_id === brandAId);
    const seoulEntry = body.find((b) => b.brand_id === brandBId);

    expect(tokyoEntry, "Tokyo House not found in response").toBeTruthy();
    expect(seoulEntry, "Seoul Bowl not found in response").toBeTruthy();

    // Revenue numbers
    expect(Number(tokyoEntry!.revenue)).toBeCloseTo(600, 2);
    expect(Number(tokyoEntry!.order_count)).toBe(3);
    expect(Number(tokyoEntry!.avg_order_value)).toBeCloseTo(200, 2);

    expect(Number(seoulEntry!.revenue)).toBeCloseTo(150, 2);
    expect(Number(seoulEntry!.order_count)).toBe(1);
    expect(Number(seoulEntry!.avg_order_value)).toBeCloseTo(150, 2);

    // Tokyo House must be ranked BEFORE Seoul Bowl
    const tokyoIdx = body.findIndex((b) => b.brand_id === brandAId);
    const seoulIdx = body.findIndex((b) => b.brand_id === brandBId);
    expect(tokyoIdx).toBeLessThan(seoulIdx);
  });

  it("flags the weakest brand (lowest revenue) with is_weakest=true", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ brand_id: string; is_weakest: boolean }>;

    // Only one brand should be flagged is_weakest
    const weakestEntries = body.filter((b) => b.is_weakest === true);
    expect(weakestEntries).toHaveLength(1);

    // The weakest should be Seoul Bowl (lowest revenue 150)
    expect(weakestEntries[0].brand_id).toBe(brandBId);
  });

  it("returns 200 for ACCOUNTANT role", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${accountantToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
  });

  it("returns 403 for KITCHEN_STAFF", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 for unauthenticated request", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/orders-by-hour
// ---------------------------------------------------------------------------

describe("GET /api/v1/analytics/orders-by-hour", () => {
  it("returns 200 array for SUPER_ADMIN with ?date param", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: TEST_DATE });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns hour=10 with order_count=3 (three Tokyo House orders at 10:00/10:15/10:30 UTC)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: TEST_DATE });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ hour: number; order_count: number }>;

    const hour10 = body.find((h) => Number(h.hour) === 10);
    expect(hour10, "Hour 10 not found in response").toBeTruthy();
    expect(Number(hour10!.order_count)).toBe(3);
  });

  it("returns hour=14 with order_count=1 (Seoul Bowl order at 14:00 UTC)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: TEST_DATE });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ hour: number; order_count: number }>;

    const hour14 = body.find((h) => Number(h.hour) === 14);
    expect(hour14, "Hour 14 not found in response").toBeTruthy();
    expect(Number(hour14!.order_count)).toBe(1);
  });

  it("only returns hours with actual orders (sparse, not 24 hours)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: TEST_DATE });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ hour: number; order_count: number }>;

    // Only hours 10 and 14 have orders in this fresh DB
    const allHours = body.map((h) => Number(h.hour));
    expect(allHours).toContain(10);
    expect(allHours).toContain(14);
    expect(body).toHaveLength(2);
  });

  it("returns 400 when ?date is missing", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 403 for KITCHEN_STAFF", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ date: TEST_DATE });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/aggregators
// ---------------------------------------------------------------------------

describe("GET /api/v1/analytics/aggregators", () => {
  it("returns 200 array with aggregator splits for SUPER_ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("FOODPANDA has 2 orders and revenue=350 (orders A1 + B1)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    const body = res.body as Array<{ aggregator: string; order_count: number; revenue: number }>;

    const fp = body.find((a) => a.aggregator === "FOODPANDA");
    expect(fp, "FOODPANDA not found").toBeTruthy();
    expect(Number(fp!.order_count)).toBe(2);
    expect(Number(fp!.revenue)).toBeCloseTo(350, 2);
  });

  it("GRABFOOD has 1 order and revenue=200 (order A2)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    const body = res.body as Array<{ aggregator: string; order_count: number; revenue: number }>;
    const gf = body.find((a) => a.aggregator === "GRABFOOD");
    expect(gf, "GRABFOOD not found").toBeTruthy();
    expect(Number(gf!.order_count)).toBe(1);
    expect(Number(gf!.revenue)).toBeCloseTo(200, 2);
  });

  it("OTHER has 1 order and revenue=200 (order A3)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    const body = res.body as Array<{ aggregator: string; order_count: number; revenue: number }>;
    const other = body.find((a) => a.aggregator === "OTHER");
    expect(other, "OTHER not found").toBeTruthy();
    expect(Number(other!.order_count)).toBe(1);
    expect(Number(other!.revenue)).toBeCloseTo(200, 2);
  });

  it("total order_count across all aggregators sums to 4", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    const body = res.body as Array<{ aggregator: string; order_count: number }>;
    const total = body.reduce((sum, a) => sum + Number(a.order_count), 0);
    expect(total).toBe(4);
  });

  it("returns 200 for ACCOUNTANT role", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${accountantToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
  });

  it("returns 403 for KITCHEN_STAFF", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /analytics/margins
// ---------------------------------------------------------------------------

describe("GET /api/v1/analytics/margins", () => {
  it("returns 200 array for SUPER_ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("Tokyo House: revenue=600, recipe_cost_total=30.00, margin=570.00 (exact)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    const body = res.body as Array<{
      brand_id: string;
      name: string;
      revenue: number;
      recipe_cost_total: number;
      margin: number;
    }>;

    const tokyo = body.find((b) => b.brand_id === brandAId);
    expect(tokyo, "Tokyo House not found in margins response").toBeTruthy();

    // Hand-computed: 3 orders × qty=1 × Teriyaki(200) = 600 revenue
    // recipe_cost = 3 × 1 × (200g × 0.05) = 3 × 10 = 30
    // margin = 600 - 30 = 570
    expect(Number(tokyo!.revenue)).toBeCloseTo(600, 4);
    expect(Number(tokyo!.recipe_cost_total)).toBeCloseTo(30, 4);
    expect(Number(tokyo!.margin)).toBeCloseTo(570, 4);
  });

  it("Seoul Bowl: revenue=150, recipe_cost_total=7.50, margin=142.50 (exact)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
    const body = res.body as Array<{
      brand_id: string;
      revenue: number;
      recipe_cost_total: number;
      margin: number;
    }>;

    const seoul = body.find((b) => b.brand_id === brandBId);
    expect(seoul, "Seoul Bowl not found in margins response").toBeTruthy();

    // Hand-computed: 1 order × qty=1 × Korean(150) = 150 revenue
    // recipe_cost = 1 × 1 × (150g × 0.05) = 7.50
    // margin = 150 - 7.50 = 142.50
    expect(Number(seoul!.revenue)).toBeCloseTo(150, 4);
    expect(Number(seoul!.recipe_cost_total)).toBeCloseTo(7.5, 4);
    expect(Number(seoul!.margin)).toBeCloseTo(142.5, 4);
  });

  it("returns 200 for ACCOUNTANT role", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${accountantToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(200);
  });

  it("returns 403 for KITCHEN_STAFF", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(403);
  });

  it("returns 401 for unauthenticated", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(401);
  });
});
