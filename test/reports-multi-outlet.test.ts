/**
 * Regression test — sales report outlet attribution for a SINGLE brand deployed
 * to 2+ outlets (D30 brand_outlet + D39 order.location_id snapshot).
 *
 * reports.test.ts already covers group_by=outlet with two DIFFERENT brands, each
 * homed at a different outlet — that case passes even if the report grouped by
 * `brand.location_id` (the brand's home outlet) instead of the order's own
 * `location_id` snapshot, because for those brands the two happen to be equal
 * for every order. It does NOT catch a report that silently falls back to
 * `brand.location_id` instead of `COALESCE(order.location_id, brand.location_id)`
 * (src/modules/reports/service.ts).
 *
 * This file exercises the case that DOES catch that bug: ONE brand, homed at
 * Outlet A, deployed (brand_outlet) to both Outlet A and Outlet B, with one
 * COMPLETED order snapshotting each outlet via its own channel listing
 * (aggregator_account.location_id, D39). `brand.location_id` is Outlet A for
 * BOTH orders, so a report keyed off the brand's home outlet would wrongly
 * attribute the Outlet B order's revenue to Outlet A (or drop it under an
 * ASSIGNED-scope Outlet-B-only user). Only reading each order's own snapshot
 * gets this right.
 *
 * Fixtures (fresh in-memory DB):
 *   - Outlet A: the seeded "CloudKitchen ONE" location (brand's home).
 *   - Outlet B: created via POST /outlets.
 *   - Brand "MO_Report Brand" -> home Outlet A (brand.location_id), inserted
 *     directly via drizzle (POST /brands hard-resolves the caller's outlet —
 *     see resolveRequestLocationId() in brands/routes.ts — so it can't produce
 *     a brand whose recorded home differs from where we then deploy it; this
 *     mirrors the direct-insert pattern already used in reports.test.ts).
 *   - Deployed (brand_outlet, D30) to BOTH Outlet A and Outlet B via
 *     POST /brands/:id/outlets (OWNER-only).
 *   - Two channel listings (aggregator_account), each explicitly resolved
 *     (D39) to a different physical outlet so ingestion is unambiguous:
 *       accountA: FOODPANDA, location_id=Outlet A, mapping_status=RESOLVED,
 *                 commission_rate=10.00
 *       accountB: GRABFOOD,  location_id=Outlet B, mapping_status=RESOLVED,
 *                 commission_rate=NULL (=> treated as 0, gross==net)
 *   - One shared menu item ("MO Item", price=500), deployed (menu_item_outlet)
 *     to both outlets against the seeded Grill station (station<->outlet is
 *     not cross-validated by ingest, same as reports.test.ts's convention).
 *
 * Orders (via POST /ingest/order + POST /orders/:id/advance, both in Feb 2026):
 *   O-A1  accountA (Outlet A listing)  total=500  -> COMPLETED, location_id=Outlet A
 *   O-B1  accountB (Outlet B listing)  total=500  -> COMPLETED, location_id=Outlet B
 *
 * Hand-computed:
 *   Outlet A: orders=1  gross=500.00  net=450.00  (10% commission)
 *   Outlet B: orders=1  gross=500.00  net=500.00  (no rate configured)
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import { aggregatorAccounts, brands, orders, users } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";

let app: Express;
let db: DB;
let adminToken: string;

let outletAId: string;
let outletBId: string;
let brandId: string;
let orderA1Id: string;
let orderB1Id: string;

const FROM = "2026-02-01T00:00:00.000Z";
const TO = "2026-02-28T23:59:59.999Z";

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

async function advanceThriceToCompleted(orderId: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status, `advance ${i + 1} for ${orderId} failed: ${JSON.stringify(res.body)}`).toBe(
      200,
    );
  }
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");

  // ── Outlets ──────────────────────────────────────────────────────────────
  const outletsRes = await request(app)
    .get("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`);
  outletAId = outletsRes.body[0].id as string;

  const outletBRes = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "MO-B", name: "MO Report Outlet B" });
  expect(outletBRes.status).toBe(201);
  outletBId = outletBRes.body.id as string;

  // ── Grill station (seeded, tied to Outlet A — reused for the Outlet B
  //    deployment too; ingest/advance don't cross-validate station<->outlet
  //    in this build, same convention as reports.test.ts) ───────────────────
  const stationsRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grillStation = (stationsRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  const grillStationId = grillStation!.id;

  // ── Brand -> home Outlet A (direct insert: POST /brands hard-resolves to
  //    the caller's outlet, so it can't produce a brand pre-deployed to a
  //    second outlet in one call) ──────────────────────────────────────────
  const [brand] = await db
    .insert(brands)
    .values({
      locationId: outletAId,
      name: "MO_Report Brand",
      color: "#333333",
      salesPerfId: "mo-report-brand",
    })
    .returning();
  brandId = brand.id;

  // ── Deploy (D30 brand_outlet) to BOTH outlets ───────────────────────────
  const deployARes = await request(app)
    .post(`/api/v1/brands/${brandId}/outlets`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ location_id: outletAId });
  expect(deployARes.status).toBe(201);

  const deployBRes = await request(app)
    .post(`/api/v1/brands/${brandId}/outlets`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ location_id: outletBId });
  expect(deployBRes.status).toBe(201);

  // ── Channel listings, one per outlet (D39: explicit, unambiguous mapping) ──
  const accARes = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "MO-A-FP", credential_ref: "ref-mo-a" });
  expect(accARes.status).toBe(201);
  const accountAId = accARes.body.id as string;

  const accBRes = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "GRABFOOD", external_merchant_id: "MO-B-GF", credential_ref: "ref-mo-b" });
  expect(accBRes.status).toBe(201);
  const accountBId = accBRes.body.id as string;

  // accountA -> Outlet A, 10% commission. accountB -> Outlet B, no rate
  // configured (=> treated as 0 by the report, gross==net).
  await db
    .update(aggregatorAccounts)
    .set({ locationId: outletAId, mappingStatus: "RESOLVED", commissionRate: "10.00" })
    .where(eq(aggregatorAccounts.id, accountAId));
  await db
    .update(aggregatorAccounts)
    .set({ locationId: outletBId, mappingStatus: "RESOLVED" })
    .where(eq(aggregatorAccounts.id, accountBId));

  // ── One shared menu item, deployed to both outlets ──────────────────────
  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "MO Item", price: "500", station_id: grillStationId });
  expect(menuRes.status).toBe(201);
  const menuItemId = menuRes.body.id as string;
  await db.insert(menuItemOutlets).values([
    { menuItemId, locationId: outletAId, stationId: grillStationId },
    { menuItemId, locationId: outletBId, stationId: grillStationId },
  ]);

  async function ingest(
    aggregatorAccountId: string,
    aggregator: "FOODPANDA" | "GRABFOOD",
    externalRef: string,
  ): Promise<{ order_id: string; location_id: string | null }> {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator_account_id: aggregatorAccountId,
        aggregator,
        external_ref: externalRef,
        placed_at: "2026-02-10T09:00:00.000Z",
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(res.status, `ingest ${externalRef} failed: ${JSON.stringify(res.body)}`).toBe(201);
    return { order_id: res.body.order_id as string, location_id: res.body.location_id ?? null };
  }

  // O-A1 via accountA -> must snapshot Outlet A.
  const a1 = await ingest(accountAId, "FOODPANDA", "MO-A1");
  expect(a1.location_id).toBe(outletAId);
  orderA1Id = a1.order_id;
  await advanceThriceToCompleted(orderA1Id);

  // O-B1 via accountB -> must snapshot Outlet B, even though brand.location_id
  // is Outlet A for both orders.
  const b1 = await ingest(accountBId, "GRABFOOD", "MO-B1");
  expect(b1.location_id).toBe(outletBId);
  orderB1Id = b1.order_id;
  await advanceThriceToCompleted(orderB1Id);
}, 60_000);

// ---------------------------------------------------------------------------
// Sanity: order.location_id snapshots persisted correctly and diverge from
// the shared brand's home outlet.
// ---------------------------------------------------------------------------

describe("order.location_id snapshot (D39)", () => {
  it("persists a different location_id per order for the same brand", async () => {
    const rows = await db
      .select({ id: orders.id, locationId: orders.locationId, brandId: orders.brandId })
      .from(orders)
      .where(eq(orders.brandId, brandId));

    const byId = new Map(rows.map((r) => [r.id, r.locationId]));
    expect(byId.get(orderA1Id)).toBe(outletAId);
    expect(byId.get(orderB1Id)).toBe(outletBId);
    expect(byId.get(orderA1Id)).not.toBe(byId.get(orderB1Id));
  });
});

// ---------------------------------------------------------------------------
// GET /reports/sales — group_by=outlet attributes by the order's own snapshot
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — group_by=outlet, single brand deployed to 2 outlets", () => {
  it("attributes each order to its OWN location_id snapshot, not the brand's home outlet", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "outlet" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
      totals: { orders_count: number; gross_sales: number; net_sales: number };
    };

    const outletARow = body.rows.find((r) => r.key === "CloudKitchen ONE");
    const outletBRow = body.rows.find((r) => r.key === "MO Report Outlet B");
    expect(outletARow, "Outlet A row missing").toBeTruthy();
    expect(outletBRow, "Outlet B row missing").toBeTruthy();

    // Regression: without COALESCE(order.location_id, brand.location_id),
    // both orders would land under Outlet A (the brand's home outlet) and
    // Outlet B would show 0 orders.
    expect(outletARow!.orders_count).toBe(1);
    expect(outletARow!.gross_sales).toBeCloseTo(500, 2);
    expect(outletARow!.net_sales).toBeCloseTo(450, 2); // 10% commission preserved

    expect(outletBRow!.orders_count).toBe(1);
    expect(outletBRow!.gross_sales).toBeCloseTo(500, 2);
    expect(outletBRow!.net_sales).toBeCloseTo(500, 2); // no rate configured -> gross==net

    expect(body.totals.orders_count).toBe(2);
    expect(body.totals.gross_sales).toBeCloseTo(1000, 2);
    expect(body.totals.net_sales).toBeCloseTo(950, 2);
  });
});

// ---------------------------------------------------------------------------
// Tenancy: an ASSIGNED-scope user granted only Outlet B sees only Outlet B's
// share of this single brand's revenue.
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — ASSIGNED scope on a multi-outlet brand", () => {
  it("an ASSIGNED-scope user (outlet_ids=[Outlet B]) sees Outlet B revenue and not Outlet A's", async () => {
    const { jwtSecret } = loadConfig();
    const [accountingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "accountant@cloudkitchen.local"));

    const scopedToken = signToken(
      { id: accountingUser.id, role: accountingUser.role },
      jwtSecret,
      { outletScope: "ASSIGNED", outletIds: [outletBId] },
    );

    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${scopedToken}`)
      .query({ from: FROM, to: TO, group_by: "outlet" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
      totals: { orders_count: number; gross_sales: number; net_sales: number };
    };

    expect(body.rows.find((r) => r.key === "CloudKitchen ONE")).toBeUndefined();
    const outletBRow = body.rows.find((r) => r.key === "MO Report Outlet B");
    expect(outletBRow, "Outlet B row missing").toBeTruthy();
    expect(outletBRow!.orders_count).toBe(1);
    expect(outletBRow!.gross_sales).toBeCloseTo(500, 2);
    expect(outletBRow!.net_sales).toBeCloseTo(500, 2);

    // Cannot see Outlet A's revenue: totals must equal Outlet B's share only.
    expect(body.totals.orders_count).toBe(1);
    expect(body.totals.gross_sales).toBeCloseTo(500, 2);
    expect(body.totals.net_sales).toBeCloseTo(500, 2);
  });
});
