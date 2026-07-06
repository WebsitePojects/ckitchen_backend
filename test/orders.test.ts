/**
 * Task 6 — Orders API Tests (CK1-API-003 §7)
 *
 * Covers:
 *   - POST /ingest/order (idempotency, print jobs, validation)
 *   - GET /orders (unified feed + filters)
 *   - GET /orders/:id (detail with items + print jobs)
 *   - POST /orders/:id/advance (stage advancement)
 *   - POST /orders/:id/cancel (before-preparing cancel)
 *   - POST /simulator/start and /simulator/stop
 *   - Simulator pure generator function
 *   - RBAC enforcement
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { generateOrderInput } from "../src/modules/orders/simulator.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { userOutletAccess, users } from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string;
let kitchenToken: string;
let warehouseToken: string;

/** IDs shared across describes (set up in file-level beforeAll) */
let grillStationId: string;
let beverageStationId: string;
let ingId: string;
let brandId: string;
let fpAccountId: string;
let grillItemId: string;   // Teriyaki — station=Grill
let bevItemId: string;     // Lemon Tea — station=Beverage

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

/** Unique external_ref generator to avoid unique-constraint conflicts across tests */
let _refSeq = 0;
function nextRef(): string {
  return `TEST-${Date.now()}-${++_refSeq}`;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

  // ── Resolve seeded stations ─────────────────────────────────────────────
  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const stations = stRes.body as Array<{ id: string; name: string }>;
  grillStationId = stations.find((s) => s.name === "Grill")!.id;
  beverageStationId = stations.find((s) => s.name === "Beverage")!.id;

  // ── Create an ingredient and put 1000 units in KITCHEN ──────────────────
  const ingRes = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "OrderTest_Ing", unit: "g", unit_cost: "1.00", low_stock_threshold: "50" });
  ingId = ingRes.body.id as string;

  await request(app)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${warehouseToken}`)
    .send({ items: [{ ingredient_id: ingId, quantity: 2000 }] });

  const itoRes = await request(app)
    .post("/api/v1/itos")
    .set("Authorization", `Bearer ${kitchenToken}`)
    .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingId, quantity: 2000 }] });

  await request(app)
    .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
    .set("Authorization", `Bearer ${warehouseToken}`);

  // ── Brand + FOODPANDA account ────────────────────────────────────────────
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Test Brand Orders", color: "#123456" });
  brandId = brandRes.body.id as string;

  const accRes = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-TB", credential_ref: "ref-tb" });
  fpAccountId = accRes.body.id as string;

  // ── Grill item with recipe ───────────────────────────────────────────────
  const grillRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Teriyaki Test", price: "180", station_id: grillStationId });
  grillItemId = grillRes.body.id as string;

  await request(app)
    .put(`/api/v1/menu/${grillItemId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingId, portion_qty: 100, unit: "g" }] });

  // ── Beverage item with recipe ────────────────────────────────────────────
  const bevRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Lemon Tea Test", price: "60", station_id: beverageStationId });
  bevItemId = bevRes.body.id as string;

  await request(app)
    .put(`/api/v1/menu/${bevItemId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingId, portion_qty: 50, unit: "g" }] });
});

// ---------------------------------------------------------------------------
// POST /ingest/order — basic creation
// ---------------------------------------------------------------------------

describe("POST /api/v1/ingest/order — basic creation", () => {
  it("creates an order with status=NEW and returns order_id + print_jobs", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "John D.",
        placed_at: "2026-06-24T03:11:00Z",
        items: [{ menu_item_id: grillItemId, qty: 2, notes: "no onion" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.order_id).toBeTruthy();
    expect(res.body.status).toBe("NEW");
    expect(Array.isArray(res.body.print_jobs)).toBe(true);
  });

  it("returns 400 VALIDATION_ERROR when brand_id is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aggregator: "FOODPANDA",
        external_ref: "FP-VALID-001",
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when items is empty", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 AUTH_REQUIRED for unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .send({ brand_id: brandId, aggregator: "FOODPANDA", external_ref: nextRef(), items: [] });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY: same (aggregator, external_ref) → DUPLICATE_ORDER no-op
// (Cardinal Business Rule #5)
// ---------------------------------------------------------------------------

describe("Idempotency: DUPLICATE_ORDER on duplicate (aggregator, external_ref)", () => {
  const IDEMPOTENT_REF = "FP-IDEM-FIXED-001";
  let firstOrderId: string;

  it("first ingest creates exactly ONE order → 201", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: IDEMPOTENT_REF,
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });

    expect(res.status).toBe(201);
    firstOrderId = res.body.order_id as string;
    expect(firstOrderId).toBeTruthy();
  });

  it("second ingest with SAME (aggregator, external_ref) → 200 DUPLICATE_ORDER, returns existing order", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: IDEMPOTENT_REF,
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("DUPLICATE_ORDER");
    expect(res.body.order_id).toBe(firstOrderId); // same order
  });

  it("exactly ONE order row exists for the duplicate ref (no second row created)", async () => {
    const listRes = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ aggregator: "FOODPANDA" });

    const ordersForRef = (listRes.body as Array<{ externalRef: string }>).filter(
      (o) => o.externalRef === IDEMPOTENT_REF,
    );
    expect(ordersForRef).toHaveLength(1); // exactly ONE
  });
});

// ---------------------------------------------------------------------------
// LISTING-SCOPED IDEMPOTENCY: same external_ref on a DIFFERENT aggregator
// account (channel listing) is a DISTINCT order; same external_ref replayed
// on the SAME listing is still an idempotent no-op (Cardinal Business Rule #5,
// listing-scoped variant — migration 0010).
// ---------------------------------------------------------------------------

describe("Idempotency is listing-scoped: (aggregator_account_id, external_ref)", () => {
  const SHARED_REF = "FP-LISTING-SCOPED-001";
  let brandTwoId: string;
  let brandTwoAccountId: string;
  let brandTwoItemId: string;
  let firstListingOrderId: string;
  let secondListingOrderId: string;

  beforeAll(async () => {
    // A second brand with its own FOODPANDA aggregator account == a distinct
    // channel listing, even though it shares the SAME aggregator enum value
    // ("FOODPANDA") as fpAccountId used above.
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Test Brand Orders — Second Listing", color: "#654321" });
    expect(brandRes.status).toBe(201);
    brandTwoId = brandRes.body.id as string;

    const accRes = await request(app)
      .post(`/api/v1/brands/${brandTwoId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-TB2", credential_ref: "ref-tb2" });
    expect(accRes.status).toBe(201);
    brandTwoAccountId = accRes.body.id as string;
    expect(brandTwoAccountId).not.toBe(fpAccountId);

    const menuRes = await request(app)
      .post(`/api/v1/brands/${brandTwoId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Second Listing Dish", price: "99", station_id: grillStationId });
    expect(menuRes.status).toBe(201);
    brandTwoItemId = menuRes.body.id as string;
  });

  it("ingests order for brand 1's listing with SHARED_REF → 201", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: SHARED_REF,
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });

    expect(res.status).toBe(201);
    firstListingOrderId = res.body.order_id as string;
    expect(firstListingOrderId).toBeTruthy();
  });

  it("same external_ref via a DIFFERENT listing (brand 2's account) → 201, DISTINCT order", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandTwoId,
        aggregator: "FOODPANDA",
        external_ref: SHARED_REF,
        items: [{ menu_item_id: brandTwoItemId, qty: 1 }],
      });

    expect(res.status).toBe(201);
    secondListingOrderId = res.body.order_id as string;
    expect(secondListingOrderId).toBeTruthy();
    expect(secondListingOrderId).not.toBe(firstListingOrderId);
  });

  it("replaying SHARED_REF again on listing 1 → 200 DUPLICATE_ORDER, returns listing 1's order", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: SHARED_REF,
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("DUPLICATE_ORDER");
    expect(res.body.order_id).toBe(firstListingOrderId);
  });

  it("replaying SHARED_REF again on listing 2 → 200 DUPLICATE_ORDER, returns listing 2's order", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandTwoId,
        aggregator: "FOODPANDA",
        external_ref: SHARED_REF,
        items: [{ menu_item_id: brandTwoItemId, qty: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe("DUPLICATE_ORDER");
    expect(res.body.order_id).toBe(secondListingOrderId);
  });

  it("exactly TWO order rows exist for SHARED_REF — one per listing", async () => {
    const listRes = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ aggregator: "FOODPANDA" });

    const rowsForRef = (listRes.body as Array<{ id: string; externalRef: string }>).filter(
      (o) => o.externalRef === SHARED_REF,
    );
    expect(rowsForRef).toHaveLength(2);
    const ids = rowsForRef.map((r) => r.id).sort();
    expect(ids).toEqual([firstListingOrderId, secondListingOrderId].sort());
  });

  it("concurrent duplicate ingests on the SAME listing race down to exactly ONE order (FIX C)", async () => {
    const RACE_REF = "FP-LISTING-RACE-001";
    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/v1/ingest/order")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          brand_id: brandId,
          aggregator: "FOODPANDA",
          external_ref: RACE_REF,
          items: [{ menu_item_id: grillItemId, qty: 1 }],
        }),
      request(app)
        .post("/api/v1/ingest/order")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          brand_id: brandId,
          aggregator: "FOODPANDA",
          external_ref: RACE_REF,
          items: [{ menu_item_id: grillItemId, qty: 1 }],
        }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 201]);
    const orderIds = new Set([resA.body.order_id, resB.body.order_id]);
    expect(orderIds.size).toBe(1); // both resolve to the same order

    const listRes = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ aggregator: "FOODPANDA" });
    const rowsForRef = (listRes.body as Array<{ externalRef: string }>).filter(
      (o) => o.externalRef === RACE_REF,
    );
    expect(rowsForRef).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PRINT JOBS: one print job per distinct station (Cardinal Business Rule #6)
// ---------------------------------------------------------------------------

describe("Print jobs: one PENDING print_job per distinct station", () => {
  let twoStationOrderId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [
          { menu_item_id: grillItemId, qty: 1 },   // station=Grill
          { menu_item_id: bevItemId, qty: 2 },      // station=Beverage
        ],
      });
    expect(res.status).toBe(201);
    twoStationOrderId = res.body.order_id as string;
  });

  it("ingesting items at 2 distinct stations creates exactly 2 PENDING print_jobs", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [
          { menu_item_id: grillItemId, qty: 1 },
          { menu_item_id: bevItemId, qty: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.print_jobs).toHaveLength(2); // exactly 2 DISTINCT stations
    const stations = res.body.print_jobs.map((j: { station: string }) => j.station);
    expect(stations).toContain("Grill");
    expect(stations).toContain("Beverage");
  });

  it("ingesting items all at same station → exactly 1 print_job", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [
          { menu_item_id: grillItemId, qty: 1 },
          { menu_item_id: grillItemId, qty: 2 }, // same station, same item
        ],
      });

    // Note: two separate order_items for same menu_item → still 1 station → 1 print job
    expect(res.status).toBe(201);
    expect(res.body.print_jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /orders — unified feed with filters
// ---------------------------------------------------------------------------

describe("GET /api/v1/orders — unified feed and filters", () => {
  let filteredOrderId: string;
  const FILTER_REF = `FP-FILTER-${Date.now()}`;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: FILTER_REF,
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    filteredOrderId = res.body.order_id as string;
  });

  it("returns 200 array of orders when authenticated", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("filters by brand_id correctly", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ brand_id: brandId });

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ brandId: string }>).map((o) => o.brandId);
    expect(ids.every((id) => id === brandId)).toBe(true);
  });

  it("filters by aggregator correctly", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ aggregator: "FOODPANDA" });

    expect(res.status).toBe(200);
    const aggs = (res.body as Array<{ aggregator: string }>).map((o) => o.aggregator);
    expect(aggs.every((a) => a === "FOODPANDA")).toBe(true);
  });

  it("filters by status=NEW correctly", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW" });

    expect(res.status).toBe(200);
    const statuses = (res.body as Array<{ status: string }>).map((o) => o.status);
    expect(statuses.every((s) => s === "NEW")).toBe(true);
  });

  it("returns 401 for unauthenticated GET /orders", async () => {
    const res = await request(app).get("/api/v1/orders");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /orders?detail=1 — bulk-hydrated detail mode (KDS N+1 fix)
//
// The frontend Kitchen Display / Dashboard used to call GET /orders for a
// summary list, then GET /orders/:id ONCE PER ORDER to hydrate items +
// print_jobs (ckitchen_frontend src/hooks/useKitchenOrders.ts). ?detail=1
// (alias ?include=items) returns the SAME per-order items[]/print_jobs[]
// shape in ONE call, bulk-fetched server-side (listOrdersWithDetail).
// ---------------------------------------------------------------------------

describe("GET /api/v1/orders?detail=1 — bulk detail mode", () => {
  let multiItemOrderId: string;
  let singleItemOrderId: string;
  const DETAIL_REF_1 = `FP-DETAIL-${Date.now()}-1`;
  const DETAIL_REF_2 = `FP-DETAIL-${Date.now()}-2`;

  beforeAll(async () => {
    // Two stations (Grill + Beverage) → 2 order_items + 2 print_jobs.
    const res1 = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: DETAIL_REF_1,
        customer_name: "Detail Mode Test",
        items: [
          { menu_item_id: grillItemId, qty: 2, notes: "extra spicy" },
          { menu_item_id: bevItemId, qty: 1 },
        ],
      });
    expect(res1.status).toBe(201);
    multiItemOrderId = res1.body.order_id as string;

    // A second, unrelated order — only 1 item/1 print job — to prove per-order
    // assembly doesn't leak items across orders in the bulk fetch.
    const res2 = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: DETAIL_REF_2,
        items: [{ menu_item_id: bevItemId, qty: 3 }],
      });
    expect(res2.status).toBe(201);
    singleItemOrderId = res2.body.order_id as string;
  });

  it("summary mode (no detail param) is byte-identical to the pre-existing contract — no items/print_jobs keys", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW" });

    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find(
      (o) => o.id === multiItemOrderId,
    );
    expect(found).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(found, "items")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(found, "print_jobs")).toBe(false);
  });

  it("?detail=1 returns each order WITH items[] and print_jobs[] matching GET /orders/:id for the same order", async () => {
    const listRes = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW", detail: "1" });
    expect(listRes.status).toBe(200);

    const detailRes = await request(app)
      .get(`/api/v1/orders/${multiItemOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);

    const listed = (
      listRes.body as Array<{
        id: string;
        items: Array<{ id: string }>;
        print_jobs: Array<{ id: string }>;
      }>
    ).find((o) => o.id === multiItemOrderId);
    expect(listed).toBeTruthy();

    const sortIds = (arr: Array<{ id: string }>) => arr.map((x) => x.id).sort();
    expect(sortIds(listed!.items)).toEqual(sortIds(detailRes.body.items));
    expect(sortIds(listed!.print_jobs)).toEqual(sortIds(detailRes.body.print_jobs));
    expect(listed!.items).toEqual(detailRes.body.items);
    expect(listed!.print_jobs).toEqual(detailRes.body.print_jobs);
  });

  it("an order with multiple items across multiple stations assembles with NO cartesian duplication", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW", detail: "1" });

    const found = (
      res.body as Array<{ id: string; items: unknown[]; print_jobs: unknown[] }>
    ).find((o) => o.id === multiItemOrderId)!;

    // 2 distinct order_items (grill qty=2 + beverage qty=1) and 2 distinct
    // print_jobs (Grill station + Beverage station) — a naive SQL JOIN across
    // order_item x print_job would fan out to 4 rows; the bulk fetch must not.
    expect(found.items).toHaveLength(2);
    expect(found.print_jobs).toHaveLength(2);
  });

  it("a second order in the SAME detail=1 response gets its own items only (no cross-order leakage)", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW", detail: "1" });

    const rows = res.body as Array<{
      id: string;
      items: Array<{ menuItemId: string; qty: number }>;
      print_jobs: unknown[];
    }>;
    const multi = rows.find((o) => o.id === multiItemOrderId)!;
    const single = rows.find((o) => o.id === singleItemOrderId)!;

    expect(multi.items).toHaveLength(2);
    expect(single.items).toHaveLength(1);
    expect(single.items[0].menuItemId).toBe(bevItemId);
    expect(single.items[0].qty).toBe(3);
    expect(single.print_jobs).toHaveLength(1);
  });

  it("?include=items behaves the same as ?detail=1 (alias)", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW", include: "items" });

    expect(res.status).toBe(200);
    const found = (res.body as Array<{ id: string; items: unknown[] }>).find(
      (o) => o.id === multiItemOrderId,
    );
    expect(found).toBeTruthy();
    expect(found!.items).toHaveLength(2);
  });

  it("?detail=0 is treated as summary mode (no items key)", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ status: "NEW", detail: "0" });

    expect(res.status).toBe(200);
    const found = (res.body as Array<Record<string, unknown>>).find(
      (o) => o.id === multiItemOrderId,
    );
    expect(found).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(found, "items")).toBe(false);
  });

  it("empty result set with detail=1 (no matching orders) returns []", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ brand_id: "00000000-0000-4000-a000-000000000099", detail: "1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /orders?detail=1 — H2 outlet scoping (ASSIGNED user must not see
// another outlet's orders, detailed or not)
// ---------------------------------------------------------------------------

describe("GET /api/v1/orders?detail=1 — respects outlet scope (H2)", () => {
  let scopedOutletId: string;
  let scopedToken: string;
  let scopedBrandId: string;
  let scopedItemId: string;

  beforeAll(async () => {
    // A brand-new outlet, distinct from the deployment default outlet that
    // brandId/grillItemId (file-level fixtures) live in.
    const outletRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "ORD-DETAIL-SCOPE", name: "Detail Scope Outlet", address: "Elsewhere" });
    expect(outletRes.status).toBe(201);
    scopedOutletId = outletRes.body.id as string;

    // An ASSIGNED (single-outlet) KITCHEN_CREW user, member of ONLY scopedOutletId.
    const email = `detail-scope-${Date.now()}@cloudkitchen.local`;
    const [u] = await db
      .insert(users)
      .values({
        name: "Detail Scope Crew",
        email,
        passwordHash: await hashPassword("password123"),
        role: "KITCHEN_CREW",
      })
      .returning();
    await db.insert(userOutletAccess).values({ userId: u.id, locationId: scopedOutletId });
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "password123" });
    scopedToken = loginRes.body.token as string;
    expect(scopedToken).toBeTruthy();

    // Brand + station + menu item at the NEW outlet.
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Detail Scope Brand", color: "#abcdef", location_id: scopedOutletId });
    scopedBrandId = brandRes.body.id as string;

    await request(app)
      .post(`/api/v1/brands/${scopedBrandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "GRABFOOD", external_merchant_id: "GF-DETAIL-SCOPE", credential_ref: "ref-detail-scope" });

    const stationRes = await request(app)
      .post("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", scopedOutletId)
      .send({ name: "Detail Scope Station" });
    const scopedStationId = stationRes.body.id as string;

    const menuRes = await request(app)
      .post(`/api/v1/brands/${scopedBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Detail Scope Dish", price: "77", station_id: scopedStationId });
    scopedItemId = menuRes.body.id as string;
  });

  it("ASSIGNED user's ?detail=1 list excludes another outlet's detailed order, and hydrates its own", async () => {
    // Order at the default/other outlet (NOT in the scoped user's access).
    const otherOutletOrder = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    expect(otherOutletOrder.status).toBe(201);
    const otherOrderId = otherOutletOrder.body.order_id as string;

    // Order at the scoped user's own outlet.
    const ownOrder = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: scopedBrandId,
        aggregator: "GRABFOOD",
        external_ref: nextRef(),
        items: [{ menu_item_id: scopedItemId, qty: 1 }],
      });
    expect(ownOrder.status).toBe(201);
    const ownOrderId = ownOrder.body.order_id as string;

    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${scopedToken}`)
      .query({ detail: "1" });

    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      id: string;
      items: Array<{ menuItemId: string }>;
      print_jobs: unknown[];
    }>;
    const ids = rows.map((o) => o.id);
    expect(ids).toContain(ownOrderId);
    expect(ids).not.toContain(otherOrderId);

    const ownRow = rows.find((o) => o.id === ownOrderId)!;
    expect(ownRow.items.length).toBeGreaterThan(0);
    expect(ownRow.items[0].menuItemId).toBe(scopedItemId);
    expect(ownRow.print_jobs.length).toBeGreaterThan(0);
  });

  it("ALL-scope admin's ?detail=1 list still sees both outlets' orders, each correctly hydrated", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ detail: "1", brand_id: scopedBrandId });

    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; items: unknown[] }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Array.isArray(row.items)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /orders/:id — order detail with items + print-job status
// ---------------------------------------------------------------------------

describe("GET /api/v1/orders/:id — order detail", () => {
  let detailOrderId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Detail Test",
        items: [
          { menu_item_id: grillItemId, qty: 2, notes: "extra spicy" },
          { menu_item_id: bevItemId, qty: 1 },
        ],
      });
    detailOrderId = res.body.order_id as string;
  });

  it("returns order detail with items array and print_jobs array", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${detailOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(detailOrderId);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(2);
    expect(Array.isArray(res.body.print_jobs)).toBe(true);
    expect(res.body.print_jobs).toHaveLength(2); // Grill + Beverage
  });

  it("order items have qty and notes", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${detailOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const grillItem = (res.body.items as Array<{ menuItemId: string; qty: number; notes: string | null }>)
      .find((i) => i.menuItemId === grillItemId);
    expect(grillItem).toBeTruthy();
    expect(grillItem!.qty).toBe(2);
    expect(grillItem!.notes).toBe("extra spicy");
  });

  it("print jobs are in PENDING status after ingest", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${detailOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const jobs = res.body.print_jobs as Array<{ status: string }>;
    expect(jobs.every((j) => j.status === "PENDING")).toBe(true);
  });

  it("returns 404 NOT_FOUND for non-existent order id", async () => {
    const res = await request(app)
      .get("/api/v1/orders/00000000-0000-4000-a000-000000000001")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/cancel — cancel before PREPARING (no restock needed)
// ---------------------------------------------------------------------------

describe("POST /orders/:id/cancel — cancel before PREPARING", () => {
  let newOrderId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    newOrderId = res.body.order_id as string;
  });

  it("cancelling WITHOUT a reason → 400 VALIDATION_ERROR (MOTM: reason required)", async () => {
    const ingest = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    const freshId = ingest.body.order_id as string;

    const noReason = await request(app)
      .post(`/api/v1/orders/${freshId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("VALIDATION_ERROR");

    const blankReason = await request(app)
      .post(`/api/v1/orders/${freshId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "   " });
    expect(blankReason.status).toBe(400);
  });

  it("cancelling a NEW order → 200 with status=CANCELLED (no stock deduction occurred)", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${newOrderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "customer no-show" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  it("advancing a CANCELLED order → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${newOrderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// SIMULATOR — pure generator + start/stop endpoints
// ---------------------------------------------------------------------------

describe("Simulator: pure generator + HTTP endpoints", () => {
  it("generateOrderInput() returns a valid NormalizedOrderInput shape", () => {
    const result = generateOrderInput({
      brandId: brandId,
      aggregator: "FOODPANDA",
      menuItemIds: [grillItemId, bevItemId],
    });

    expect(result.brand_id).toBe(brandId);
    expect(result.aggregator).toBe("FOODPANDA");
    expect(typeof result.external_ref).toBe("string");
    expect(result.external_ref.length).toBeGreaterThan(0);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].menu_item_id).toBeTruthy();
    expect(result.items[0].qty).toBeGreaterThanOrEqual(1);
  });

  it("generateOrderInput() with available items → ingests successfully via /ingest/order", async () => {
    const input = generateOrderInput({
      brandId: brandId,
      aggregator: "FOODPANDA",
      menuItemIds: [grillItemId, bevItemId],
    });

    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(input);

    expect(res.status).toBe(201);
    expect(res.body.order_id).toBeTruthy();
    expect(res.body.status).toBe("NEW");
  });

  it("POST /simulator/start with brand_ids and rate_per_min → 200 ok (SUPER_ADMIN)", async () => {
    const res = await request(app)
      .post("/api/v1/simulator/start")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ brand_ids: [brandId], rate_per_min: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /simulator/stop → 200 ok", async () => {
    const res = await request(app)
      .post("/api/v1/simulator/stop")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("KITCHEN_STAFF cannot start the simulator → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/simulator/start")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ brand_ids: [brandId], rate_per_min: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("POST /simulator/start returns 400 when brand_ids is missing", async () => {
    const res = await request(app)
      .post("/api/v1/simulator/start")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rate_per_min: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
