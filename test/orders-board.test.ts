/**
 * GET /orders bounds: the live board (scope=board) returns today's business day plus any
 * still-open order, newest first; every list is capped and ordered. Before this, the
 * dashboard downloaded every order ever placed on each visit.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { aggregatorAccounts, brands, locations, orders } from "../src/db/schema.js";
import { listOrders } from "../src/modules/orders/service.js";

let db: DB;
let app: Express;
let token: string;
const DAY = 24 * 60 * 60 * 1000;
const refs: Record<string, string> = {};

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  token = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;

  const [location] = await db.select().from(locations).limit(1);
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: "Board Test Brand", color: "#123456", salesPerfId: "BOARD-TEST" })
    .returning();
  const [listing] = await db
    .insert(aggregatorAccounts)
    .values({ brandId: brand!.id, aggregator: "OTHER", externalMerchantId: "BOARD-TEST-LISTING" })
    .returning();

  const now = Date.now();
  const rows: [key: string, status: (typeof orders.$inferSelect)["status"], placedAt: Date][] = [
    ["todayNew", "NEW", new Date(now - 60_000)],
    ["todayDone", "COMPLETED", new Date(now - 120_000)],
    ["oldOpen", "PREPARING", new Date(now - 3 * DAY)],
    ["oldDone", "COMPLETED", new Date(now - 3 * DAY)],
    ["oldCancelled", "CANCELLED", new Date(now - 5 * DAY)],
  ];
  for (const [key, status, placedAt] of rows) {
    const [row] = await db
      .insert(orders)
      .values({ brandId: brand!.id, aggregatorAccountId: listing!.id, aggregator: "OTHER", externalRef: `BOARD-${key}`, status, total: "100", placedAt })
      .returning();
    refs[key] = row!.id;
  }
});

const ids = (list: { id: string }[]) => list.map((o) => o.id);

describe("listOrders bounds", () => {
  it("board = today's business day + still-open orders, newest first", async () => {
    const board = (await listOrders(db, { board: true })).filter((o) => Object.values(refs).includes(o.id));
    expect(ids(board)).toEqual([refs.todayNew, refs.todayDone, refs.oldOpen]);
  });

  it("without board, old completed and cancelled orders are still listed, newest first", async () => {
    const all = (await listOrders(db, {})).filter((o) => Object.values(refs).includes(o.id));
    expect(ids(all)).toEqual([refs.todayNew, refs.todayDone, refs.oldOpen, refs.oldDone, refs.oldCancelled]);
  });

  it("limit returns only the newest N", async () => {
    const page = await listOrders(db, { limit: 2 });
    expect(page).toHaveLength(2);
    expect(page[0]!.placedAt.getTime()).toBeGreaterThanOrEqual(page[1]!.placedAt.getTime());
  });
});

describe("GET /api/v1/orders?scope=board", () => {
  it("returns the board through the API", async () => {
    const res = await request(app).get("/api/v1/orders?scope=board&detail=1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const mine = (res.body as { id: string }[]).filter((o) => Object.values(refs).includes(o.id));
    expect(ids(mine)).toEqual([refs.todayNew, refs.todayDone, refs.oldOpen]);
  });

  it("rejects an unknown scope and an out-of-range limit (fail closed)", async () => {
    const badScope = await request(app).get("/api/v1/orders?scope=everything").set("Authorization", `Bearer ${token}`);
    expect(badScope.status).toBe(400);
    for (const limit of ["0", "-5", "1.5", "abc", "100000"]) {
      const res = await request(app).get(`/api/v1/orders?limit=${limit}`).set("Authorization", `Bearer ${token}`);
      expect(res.status, `limit=${limit}`).toBe(400);
    }
  });
});
