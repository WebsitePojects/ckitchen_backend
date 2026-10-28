/**
 * GET /analytics/brand-performance (D59): the money adds up from frozen order lines,
 * cancelled orders and unapproved discounts do not count, and the report is scoped — a brand
 * manager sees only assigned brands, an outlet manager only their outlets' orders.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";
import {
  aggregatorAccounts,
  brandOutlet,
  brands,
  kitchenStations,
  locations,
  menuItems,
  orderDiscounts,
  orderItems,
  orders,
  userBrands,
  userOutletAccess,
  users,
  type Role,
} from "../src/db/schema.js";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let seq = 0;
const s = () => `${++seq}-${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  jwtSecret = loadConfig().jwtSecret;
  await runMigrations(db);
  app = createApp(db);
}, 60_000);

afterAll(async () => {
  await closeDb(client);
});

async function actor(role: Role, opts: { locationId?: string; brandIds?: string[] } = {}) {
  const [user] = await db.insert(users).values({ name: `BP ${role}`, email: `bp-${s()}@test.local`, passwordHash: "x", role }).returning();
  const outletIds = outletScopeForRole(role) === "ALL" || !opts.locationId ? [] : [opts.locationId];
  if (opts.locationId) await db.insert(userOutletAccess).values({ userId: user!.id, locationId: opts.locationId });
  for (const brandId of opts.brandIds ?? []) await db.insert(userBrands).values({ userId: user!.id, brandId });
  return signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
}

async function outlet() {
  const [loc] = await db.insert(locations).values({ code: `BP-${s()}`, name: `BP Outlet ${s()}` }).returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: loc!.id, name: `St ${s()}` }).returning();
  return { locationId: loc!.id, stationId: station!.id };
}

async function brandAt(locationId: string) {
  const [brand] = await db.insert(brands).values({ locationId, name: `BP Brand ${s()}`, color: "#335577", salesPerfId: `bp-${s()}` }).returning();
  await db.insert(brandOutlet).values({ brandId: brand!.id, locationId, isActive: true });
  const [account] = await db.insert(aggregatorAccounts).values({ brandId: brand!.id, aggregator: "OTHER", externalMerchantId: `ext-${s()}` }).returning();
  const [item] = await db.insert(menuItems).values({ brandId: brand!.id, name: `Bowl ${s()}`, price: "999" }).returning();
  return { brandId: brand!.id, accountId: account!.id, menuItemId: item!.id };
}

/** One order line: qty × price with a frozen unit cost, placed now at an outlet. */
async function sale(
  b: Awaited<ReturnType<typeof brandAt>>,
  where: Awaited<ReturnType<typeof outlet>>,
  opts: { qty: number; price: number; cost: number; commission?: number; status?: "COMPLETED" | "CANCELLED" },
) {
  const [order] = await db
    .insert(orders)
    .values({
      brandId: b.brandId,
      aggregatorAccountId: b.accountId,
      aggregator: "OTHER",
      externalRef: `ref-${s()}`,
      locationId: where.locationId,
      total: String(opts.qty * opts.price),
      status: opts.status ?? "COMPLETED",
      commissionRateSnapshot: opts.commission != null ? String(opts.commission) : null,
    })
    .returning();
  await db.insert(orderItems).values({
    orderId: order!.id,
    menuItemId: b.menuItemId,
    qty: opts.qty,
    stationId: where.stationId,
    unitPrice: String(opts.price),
    unitCost: String(opts.cost),
  });
  return order!.id;
}

describe("GET /analytics/brand-performance", () => {
  it("adds up net sales, food cost, fees and contribution from frozen lines", async () => {
    const at = await outlet();
    const b = await brandAt(at.locationId);
    await sale(b, at, { qty: 2, price: 200, cost: 60, commission: 20 }); // 400 sales, 120 food, 80 fees
    const discounted = await sale(b, at, { qty: 1, price: 100, cost: 30 }); // 100 sales, 30 food
    const [requester] = await db.insert(users).values({ name: "Cashier", email: `bp-${s()}@test.local`, passwordHash: "x", role: "OUTLET_MANAGER" }).returning();
    const discount = { orderId: discounted, type: "FIXED" as const, label: "Promo", approvalLevel: "AUTO" as const, requestedBy: requester!.id };
    await db.insert(orderDiscounts).values([
      { ...discount, amount: "10.00", status: "APPROVED" },
      { ...discount, amount: "50.00", status: "PENDING" },
    ]);
    await sale(b, at, { qty: 5, price: 200, cost: 60, status: "CANCELLED" }); // must not count

    const owner = await actor("OWNER");
    const res = await request(app).get(`/api/v1/analytics/brand-performance?months=3&brand_ids=${b.brandId}`).set("Authorization", `Bearer ${owner}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.months).toHaveLength(4);
    const perf = res.body.brands[0];
    expect(perf.brand.id).toBe(b.brandId);
    expect(perf.totals.grossSales).toBe(500);
    expect(perf.totals.discounts).toBe(10); // the pending discount is not money yet
    expect(perf.totals.netSales).toBe(490);
    expect(perf.totals.foodCost).toBe(150);
    expect(perf.totals.channelFees).toBe(80);
    expect(perf.totals.contribution).toBe(260);
    expect(perf.totals.orders).toBe(2);
    expect(perf.totals.cancelledOrders).toBe(1);
    expect(perf.series.at(-1).netSales).toBe(490); // all of it this month
    expect(perf.verdict.status).toBe("PROFITABLE");
    expect(perf.verdict.momentum).toBe("INSUFFICIENT_HISTORY");
  });

  it("a brand manager sees only assigned brands; asking for another is 403", async () => {
    const at = await outlet();
    const mine = await brandAt(at.locationId);
    const theirs = await brandAt(at.locationId);
    const bm = await actor("BRAND_MANAGER", { locationId: at.locationId, brandIds: [mine.brandId] });

    const list = await request(app).get("/api/v1/analytics/brand-performance").set("Authorization", `Bearer ${bm}`);
    expect(list.status).toBe(200);
    expect(list.body.brands.map((x: { brand: { id: string } }) => x.brand.id)).toEqual([mine.brandId]);

    const other = await request(app)
      .get(`/api/v1/analytics/brand-performance?brand_ids=${theirs.brandId}`)
      .set("Authorization", `Bearer ${bm}`);
    expect(other.status).toBe(403);

    const none = await actor("BRAND_MANAGER", { locationId: at.locationId });
    const empty = await request(app).get("/api/v1/analytics/brand-performance").set("Authorization", `Bearer ${none}`);
    expect(empty.status).toBe(200);
    expect(empty.body.brands).toEqual([]);
  });

  it("an outlet manager counts only their outlet's orders and brands", async () => {
    const a = await outlet();
    const b = await outlet();
    const shared = await brandAt(a.locationId);
    await db.insert(brandOutlet).values({ brandId: shared.brandId, locationId: b.locationId, isActive: true });
    const elsewhere = await brandAt(b.locationId);
    await sale(shared, a, { qty: 1, price: 300, cost: 90 });
    await sale(shared, b, { qty: 1, price: 700, cost: 200 });
    await sale(elsewhere, b, { qty: 1, price: 500, cost: 100 });

    const managerA = await actor("OUTLET_MANAGER", { locationId: a.locationId });
    const res = await request(app).get("/api/v1/analytics/brand-performance").set("Authorization", `Bearer ${managerA}`);
    expect(res.status).toBe(200);
    const ids = res.body.brands.map((x: { brand: { id: string } }) => x.brand.id);
    expect(ids).toContain(shared.brandId);
    expect(ids).not.toContain(elsewhere.brandId);
    const sharedPerf = res.body.brands.find((x: { brand: { id: string } }) => x.brand.id === shared.brandId);
    expect(sharedPerf.totals.netSales).toBe(300); // outlet B's 700 is not theirs
  });

  it("kitchen crew is refused; bad input is 400", async () => {
    const crew = await actor("KITCHEN_CREW");
    expect((await request(app).get("/api/v1/analytics/brand-performance").set("Authorization", `Bearer ${crew}`)).status).toBe(403);
    const owner = await actor("OWNER");
    for (const q of ["months=0", "months=99", "brand_ids=not-a-uuid"]) {
      const res = await request(app).get(`/api/v1/analytics/brand-performance?${q}`).set("Authorization", `Bearer ${owner}`);
      expect(res.status, q).toBe(400);
    }
  });
});

describe("older analytics endpoints use the same scope", () => {
  const today = new Date().toISOString().slice(0, 10);
  const endpoints = [
    "/api/v1/analytics/brands",
    "/api/v1/analytics/margins",
    "/api/v1/analytics/products",
    `/api/v1/analytics/orders-by-hour-by-brand?date=${today}`,
  ];
  const brandIdsIn = (body: unknown): string[] => {
    const rows = Array.isArray(body) ? body : [];
    const ids = new Set<string>();
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.brand_id === "string") ids.add(r.brand_id);
      if (typeof r.brandId === "string") ids.add(r.brandId);
      for (const b of (r.brands as Array<{ brandId: string }> | undefined) ?? []) ids.add(b.brandId);
    }
    return [...ids];
  };

  it("a brand manager sees only assigned brands in every report", async () => {
    const at = await outlet();
    const mine = await brandAt(at.locationId);
    const theirs = await brandAt(at.locationId);
    await sale(mine, at, { qty: 1, price: 100, cost: 30 });
    await sale(theirs, at, { qty: 1, price: 900, cost: 30 });
    const bm = await actor("BRAND_MANAGER", { locationId: at.locationId, brandIds: [mine.brandId] });
    for (const url of endpoints) {
      const res = await request(app).get(url).set("Authorization", `Bearer ${bm}`);
      expect(res.status, url).toBe(200);
      const ids = brandIdsIn(res.body);
      expect(ids, url).toContain(mine.brandId);
      expect(ids, url).not.toContain(theirs.brandId);
    }
    const split = await request(app).get("/api/v1/analytics/aggregators").set("Authorization", `Bearer ${bm}`);
    const total = split.body.reduce((sum: number, r: { revenue: number }) => sum + r.revenue, 0);
    expect(total).toBe(100); // the other brand's 900 is not theirs
  });

  it("an outlet picked in X-Outlet-Id narrows the owner's reports to that outlet", async () => {
    const a = await outlet();
    const b = await outlet();
    const brandA = await brandAt(a.locationId);
    const brandB = await brandAt(b.locationId);
    await sale(brandA, a, { qty: 1, price: 111, cost: 10 });
    await sale(brandB, b, { qty: 1, price: 222, cost: 10 });
    const owner = await actor("OWNER");
    const res = await request(app).get("/api/v1/analytics/brands").set("Authorization", `Bearer ${owner}`).set("X-Outlet-Id", a.locationId);
    expect(res.status).toBe(200);
    const ids = brandIdsIn(res.body);
    expect(ids).toContain(brandA.brandId);
    expect(ids).not.toContain(brandB.brandId);
  });
});

describe("GET /brands/:id/activity uses the same scope (it carries daily revenue)", () => {
  const month = new Date().toISOString().slice(0, 7);
  const activity = (brandId: string, token: string) =>
    request(app).get(`/api/v1/brands/${brandId}/activity?detail=daily&month=${month}`).set("Authorization", `Bearer ${token}`);
  const monthOrders = (body: { daily: Array<{ orders: number }> }) => body.daily.reduce((n, d) => n + d.orders, 0);

  it("kitchen crew is refused", async () => {
    const at = await outlet();
    const b = await brandAt(at.locationId);
    const crew = await actor("KITCHEN_CREW", { locationId: at.locationId });
    expect((await activity(b.brandId, crew)).status).toBe(403);
  });

  it("a brand manager reads assigned brands only; another brand (or a malformed id) is a 404", async () => {
    const at = await outlet();
    const mine = await brandAt(at.locationId);
    const theirs = await brandAt(at.locationId);
    const bm = await actor("BRAND_MANAGER", { locationId: at.locationId, brandIds: [mine.brandId] });
    expect((await activity(mine.brandId, bm)).status).toBe(200);
    expect((await activity(theirs.brandId, bm)).status).toBe(404);
    expect((await activity("not-a-uuid", bm)).status).toBe(404);
  });

  it("an outlet manager counts only their outlet's orders of a shared brand", async () => {
    const a = await outlet();
    const b = await outlet();
    const shared = await brandAt(a.locationId);
    await db.insert(brandOutlet).values({ brandId: shared.brandId, locationId: b.locationId, isActive: true });
    const elsewhere = await brandAt(b.locationId);
    await sale(shared, a, { qty: 1, price: 300, cost: 90 });
    await sale(shared, b, { qty: 1, price: 700, cost: 200 });

    const managerA = await actor("OUTLET_MANAGER", { locationId: a.locationId });
    const res = await activity(shared.brandId, managerA);
    expect(res.status).toBe(200);
    expect(monthOrders(res.body)).toBe(1); // outlet B's order is not theirs
    expect((await activity(elsewhere.brandId, managerA)).status).toBe(404);

    const owner = await actor("OWNER");
    expect(monthOrders((await activity(shared.brandId, owner)).body)).toBe(2);
  });
});
