/**
 * Date-range regression tests — the "Reports show no data even after
 * completing orders" bug (2026-07-08).
 *
 * The frontend sends DATE-ONLY strings ("2026-07-08") as from/to. The old
 * code parsed them with `new Date(str)` → midnight UTC, so `placed_at <= to`
 * excluded every order placed later that same day. The fix
 * (src/modules/date-range.ts parseRangeBoundary) expands a date-only param to
 * the full UTC day (from → 00:00:00.000Z, to → 23:59:59.999Z) while passing
 * full ISO datetimes through unchanged.
 *
 * Core regression scenario: an order placed "now", queried with
 * from = to = today's date-only string, MUST be counted — across every
 * analytics endpoint that takes from/to, /analytics/orders-by-hour(-by-brand)
 * (which take a date-only `date`), /reports/sales, and /reports/sales/export.
 *
 * Fixture: one fresh brand ("DR Range Brand") + FOODPANDA listing + one menu
 * item (price 250, NO recipe so advancing deducts nothing), one order placed
 * at a captured "now" instant and advanced NEW→PREPARING→READY→COMPLETED
 * (reports only count COMPLETED orders).
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { parseRangeBoundary } from "../src/modules/date-range.js";

let app: Express;
let db: DB;
let adminToken: string;

let brandId: string;
let menuItemId: string;
let orderId: string;

/** Captured once so "today" can never roll over between ingest and assert. */
const placedAt = new Date();
const placedAtIso = placedAt.toISOString();
/** Today's DATE-ONLY string — exactly what the frontend date picker sends. */
const today = placedAtIso.slice(0, 10);

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");

  // Station (seeded)
  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grill = (stRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  expect(grill, "Grill station missing from seed").toBeTruthy();

  // Brand + FOODPANDA listing + menu item (no recipe — deduction is a no-op)
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "DR Range Brand", color: "#22CC88" });
  expect(brandRes.status).toBe(201);
  brandId = brandRes.body.id as string;

  const accRes = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "DR-FP", credential_ref: "ref-dr-fp" });
  expect(accRes.status).toBe(201);

  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "DR Range Dish", price: "250", station_id: grill!.id });
  expect(menuRes.status).toBe(201);
  menuItemId = menuRes.body.id as string;

  // The regression order: placed "now"
  const ingestRes = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator: "FOODPANDA",
      external_ref: "DR-NOW-1",
      placed_at: placedAtIso,
      items: [{ menu_item_id: menuItemId, qty: 1 }],
    });
  expect(ingestRes.status, JSON.stringify(ingestRes.body)).toBe(201);
  orderId = ingestRes.body.order_id as string;

  // Advance to COMPLETED for /reports/sales (only COMPLETED counts as revenue)
  for (let i = 0; i < 3; i++) {
    const adv = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adv.status, `advance ${i + 1}: ${JSON.stringify(adv.body)}`).toBe(200);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Unit: parseRangeBoundary
// ---------------------------------------------------------------------------

describe("parseRangeBoundary (shared helper)", () => {
  it("expands a date-only 'from' to start of the UTC day", () => {
    expect(parseRangeBoundary("2026-07-08", "from").toISOString()).toBe(
      "2026-07-08T00:00:00.000Z",
    );
  });

  it("expands a date-only 'to' to end of the UTC day", () => {
    expect(parseRangeBoundary("2026-07-08", "to").toISOString()).toBe(
      "2026-07-08T23:59:59.999Z",
    );
  });

  it("passes full ISO datetimes through unchanged (both boundaries)", () => {
    const iso = "2026-07-08T13:45:30.123Z";
    expect(parseRangeBoundary(iso, "from").toISOString()).toBe(iso);
    expect(parseRangeBoundary(iso, "to").toISOString()).toBe(iso);
  });

  it("still yields Invalid Date for garbage (callers keep their 400 handling)", () => {
    expect(Number.isNaN(parseRangeBoundary("not-a-date", "from").getTime())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: order placed today + date-only from=to=today → counted
// ---------------------------------------------------------------------------

describe("analytics endpoints count an order placed TODAY when from=to are date-only", () => {
  it("GET /analytics/brands", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today });
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ brand_id: string; order_count: number; revenue: number }>).find(
      (b) => b.brand_id === brandId,
    );
    expect(row, "brand missing from response").toBeTruthy();
    expect(Number(row!.order_count)).toBe(1);
    expect(Number(row!.revenue)).toBeCloseTo(250, 2);
  });

  it("GET /analytics/aggregators", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/aggregators")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today });
    expect(res.status).toBe(200);
    const fp = (res.body as Array<{ aggregator: string; order_count: number; revenue: number }>).find(
      (a) => a.aggregator === "FOODPANDA",
    );
    expect(fp, "FOODPANDA missing").toBeTruthy();
    expect(Number(fp!.order_count)).toBe(1);
    expect(Number(fp!.revenue)).toBeCloseTo(250, 2);
  });

  it("GET /analytics/margins", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/margins")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today });
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ brand_id: string; revenue: number; margin: number }>).find(
      (b) => b.brand_id === brandId,
    );
    expect(row, "brand missing from margins").toBeTruthy();
    // No recipe → cost 0 → margin == revenue
    expect(Number(row!.revenue)).toBeCloseTo(250, 2);
    expect(Number(row!.margin)).toBeCloseTo(250, 2);
  });

  it("GET /analytics/products", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/products")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today });
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ menuItemId: string; qtySold: number; orders: number }>).find(
      (p) => p.menuItemId === menuItemId,
    );
    expect(row, "menu item missing from products").toBeTruthy();
    expect(Number(row!.qtySold)).toBe(1);
    expect(Number(row!.orders)).toBe(1);
  });

  it("GET /analytics/orders-by-hour with ?date=today includes the order", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: today });
    expect(res.status).toBe(200);
    const total = (res.body as Array<{ order_count: number }>).reduce(
      (sum, h) => sum + Number(h.order_count),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it("GET /analytics/orders-by-hour-by-brand with ?date=today includes the order", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour-by-brand")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ date: today });
    expect(res.status).toBe(200);
    const body = res.body as Array<{
      brands: Array<{ brandId: string; count: number }>;
    }>;
    const brandTotal = body.reduce((sum, bucket) => {
      const entry = bucket.brands.find((b) => b.brandId === brandId);
      return sum + (entry ? Number(entry.count) : 0);
    }, 0);
    expect(brandTotal).toBe(1);
  });

  it("full ISO datetimes still pass through unchanged (exclusion window finds nothing)", async () => {
    // A precise window that ends BEFORE the order was placed must exclude it —
    // proving date-only expansion did not blur full-ISO semantics.
    const before = new Date(placedAt.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const stillBefore = new Date(placedAt.getTime() - 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: before, to: stillBefore });
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ brand_id: string; order_count: number }>).find(
      (b) => b.brand_id === brandId,
    );
    expect(row, "LEFT JOIN keeps zero-order brands").toBeTruthy();
    expect(Number(row!.order_count)).toBe(0);

    // ...and a full-ISO window AROUND the instant still finds it.
    const after = new Date(placedAt.getTime() + 60 * 60 * 1000).toISOString();
    const res2 = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: before, to: after });
    const row2 = (res2.body as Array<{ brand_id: string; order_count: number }>).find(
      (b) => b.brand_id === brandId,
    );
    expect(Number(row2!.order_count)).toBe(1);
  });
});

describe("reports count an order COMPLETED today when from=to are date-only", () => {
  it("GET /reports/sales", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today });
    expect(res.status).toBe(200);
    expect(res.body.totals.orders_count).toBe(1);
    expect(Number(res.body.totals.gross_sales)).toBeCloseTo(250, 2);
    // Echoed range reflects the expanded full-day bounds
    expect(res.body.from).toBe(`${today}T00:00:00.000Z`);
    expect(res.body.to).toBe(`${today}T23:59:59.999Z`);
  });

  it("GET /reports/sales/export?format=xlsx", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: today, to: today, format: "xlsx" })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });
});
