/**
 * Migration 0041: each order line freezes its price and food cost at order time, and
 * margins exclude cancelled orders and subtract aggregator commission.
 *
 * Before: order_item stored only qty, so reports recomputed revenue from the CURRENT
 * menu price and cost from the CURRENT ingredient cost (a price change rewrote history),
 * cancelled orders counted as revenue, and margins ignored commission.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { orderItems } from "../src/db/schema.js";

let app: Express;
let db: DB;
let token: string;
let brandId: string;
let menuItemId: string;
let ingredientId: string;
let keptOrderId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });
const FROM = "2026-01-20";
const TO = "2026-01-20";
const PLACED = "2026-01-20T04:00:00.000Z"; // 12:00 Manila on the 20th

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  const login = await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" });
  token = login.body.token as string;

  const stations = (await request(app).get("/api/v1/stations").set(auth())).body as Array<{ id: string; name: string }>;
  const grill = stations.find((s) => s.name === "Grill")!;

  const brand = await request(app).post("/api/v1/brands").set(auth()).send({ name: "Snapshot Brand", color: "#226688" });
  brandId = brand.body.id;
  const acct = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set(auth())
    .send({ aggregator: "GRABFOOD", external_merchant_id: "SNAP-GF", credential_ref: "ref-snap" });
  expect(acct.status).toBe(201);
  // 30% aggregator commission, frozen onto each order at ingest.
  const patch = await request(app).patch(`/api/v1/accounts/${acct.body.id}`).set(auth()).send({ commission_rate: 30 });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);

  const ing = await request(app)
    .post("/api/v1/ingredients")
    .set(auth())
    .send({ name: "Snapshot Chicken", unit: "serving", unit_cost: 50, low_stock_threshold: 0 });
  ingredientId = ing.body.id;

  const menu = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set(auth())
    .send({ name: "Snapshot Bowl", price: "200", station_id: grill.id });
  menuItemId = menu.body.id;
  const recipe = await request(app)
    .put(`/api/v1/menu/${menuItemId}/recipe`)
    .set(auth())
    .send({ lines: [{ ingredient_id: ingredientId, portion_qty: 2, unit: "serving" }] }); // 2 x 50 = 100 cost
  expect(recipe.status, JSON.stringify(recipe.body)).toBe(200);

  const ingest = (ref: string, qty: number) =>
    request(app)
      .post("/api/v1/ingest/order")
      .set(auth())
      .send({ brand_id: brandId, aggregator: "GRABFOOD", aggregator_account_id: acct.body.id, external_ref: ref, placed_at: PLACED, items: [{ menu_item_id: menuItemId, qty }] });

  const kept = await ingest("SNAP-1", 3);
  expect(kept.status, JSON.stringify(kept.body)).toBe(201);
  keptOrderId = kept.body.order_id;

  const cancelled = await ingest("SNAP-2", 5);
  expect(cancelled.status).toBe(201);
  const cancel = await request(app).post(`/api/v1/orders/${cancelled.body.order_id}/cancel`).set(auth()).send({ reason: "customer cancelled" });
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

  // Prices and costs change AFTER the orders were placed.
  await request(app).patch(`/api/v1/menu/${menuItemId}`).set(auth()).send({ price: "999" });
  await request(app).patch(`/api/v1/ingredients/${ingredientId}`).set(auth()).send({ unit_cost: 500 });
}, 60_000);

describe("order line money snapshot", () => {
  it("stores the price and food cost in effect when the order was placed", async () => {
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, keptOrderId));
    expect(Number(line!.unitPrice)).toBe(200);
    expect(Number(line!.unitCost)).toBe(100);
  });

  it("margins use frozen values, exclude the cancelled order, and subtract commission", async () => {
    const res = await request(app).get("/api/v1/analytics/margins").query({ from: FROM, to: TO }).set(auth());
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, number | string>>).find((r) => r.brand_id === brandId)!;
    // Only SNAP-1 (qty 3) counts: revenue 600, cost 300, commission 30% of 600 = 180.
    expect(row.revenue).toBe(600);
    expect(row.recipe_cost_total).toBe(300);
    expect(row.margin).toBe(300);
    expect(row.commission).toBe(180);
    expect(row.net_margin).toBe(120);
  });

  it("product performance revenue uses the frozen price", async () => {
    const res = await request(app).get("/api/v1/analytics/products").query({ from: FROM, to: TO }).set(auth());
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, number | string>>).find((r) => r.menuItemId === menuItemId)!;
    expect(row.revenue).toBe(600);
  });

  it("brand and channel revenue exclude the cancelled order", async () => {
    const brands = await request(app).get("/api/v1/analytics/brands").query({ from: FROM, to: TO }).set(auth());
    const b = (brands.body as Array<Record<string, number | string>>).find((r) => r.brand_id === brandId)!;
    expect(b.order_count).toBe(1);
    expect(b.revenue).toBe(600);

    const aggs = await request(app).get("/api/v1/analytics/aggregators").query({ from: FROM, to: TO }).set(auth());
    const grab = (aggs.body as Array<Record<string, number | string>>).find((r) => r.aggregator === "GRABFOOD")!;
    expect(grab.revenue).toBe(600);
  });
});
