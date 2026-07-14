/**
 * W3a — Sales Report + Export tests (client req #10, D33; spec platform-ia-navigation.md §8 W3).
 *
 * Fixtures (fresh in-memory DB):
 *   - Outlet 1: the seeded "CloudKitchen ONE" location.
 *   - Outlet 2: created via POST /outlets.
 *   - Brand A (AN_Report Brand A) -> Outlet 1, aggregator account FOODPANDA,
 *     commission_rate = 10.00 (set directly via db.update — no API surface for it yet).
 *   - Brand B (AN_Report Brand B) -> Outlet 2, aggregator account GRABFOOD,
 *     commission_rate left NULL (=> treated as 0, gross==net).
 *
 * Brands/stations are inserted directly via drizzle (bypassing POST /brands / POST
 * /stations, which both hard-resolve to "the first location" in this prototype —
 * see resolveLocationId() in brands/routes.ts and stations/routes.ts) so Brand B can
 * be attached to the second outlet. This mirrors the existing test-suite pattern of
 * inserting rows directly where the REST surface doesn't support the scenario
 * (e.g. test/roles-tenancy.test.ts inserting users directly).
 *
 * Orders (all via POST /ingest/order + POST /orders/:id/advance):
 *   O-A1  2026-02-10T09:00Z  Brand A / FOODPANDA  total=500  -> advanced to COMPLETED
 *   O-A2  2026-02-11T09:00Z  Brand A / FOODPANDA  total=500  -> advanced to COMPLETED
 *   O-B1  2026-02-11T10:00Z  Brand B / GRABFOOD   total=300  -> advanced to COMPLETED
 *   O-A3  2026-02-10T09:30Z  Brand A / FOODPANDA  total=500  -> CANCELLED (must not count)
 *   O-A4  2026-02-12T09:00Z  Brand A / FOODPANDA  total=500  -> left at NEW (must not count)
 *
 * Hand-computed (10% commission on Brand A/FOODPANDA, 0% on Brand B/GRABFOOD):
 *   Brand A: orders=2  gross=1000.00  net=900.00   (500 - 50 per order)
 *   Brand B: orders=1  gross=300.00   net=300.00
 *   TOTAL:   orders=3  gross=1300.00  net=1200.00
 *   2026-02-10: orders=1 gross=500.00  net=450.00  (only O-A1; O-A3 cancelled)
 *   2026-02-11: orders=2 gross=800.00  net=750.00  (O-A2 net=450 + O-B1 net=300)
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
import { aggregatorAccounts, brands, users } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";

let app: Express;
let db: DB;
let adminToken: string;
let accountantToken: string;
let kitchenToken: string;

let outlet1Id: string;
let outlet2Id: string;
let brandAId: string;
let brandBId: string;

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
  accountantToken = await login("accountant@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  // ── Outlets ──────────────────────────────────────────────────────────────
  const outletsRes = await request(app)
    .get("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`);
  outlet1Id = outletsRes.body[0].id as string;

  const outlet2Res = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "RPT2", name: "Report Outlet 2" });
  expect(outlet2Res.status).toBe(201);
  outlet2Id = outlet2Res.body.id as string;

  // ── Grill station (seeded, tied to outlet 1 — reused for Brand B's menu item
  //    too; ingest/advance don't cross-validate station<->outlet in this build) ──
  const stationsRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grillStation = (stationsRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  );
  const grillStationId = grillStation!.id;

  // ── Brand A -> Outlet 1 (direct insert: POST /brands hard-resolves to the
  //    first location, so it cannot target outlet 2 for Brand B below) ────────
  const [brandA] = await db
    .insert(brands)
    .values({
      locationId: outlet1Id,
      name: "AN_Report Brand A",
      color: "#111111",
      salesPerfId: "rpt-brand-a",
    })
    .returning();
  brandAId = brandA.id;

  const [brandB] = await db
    .insert(brands)
    .values({
      locationId: outlet2Id,
      name: "AN_Report Brand B",
      color: "#222222",
      salesPerfId: "rpt-brand-b",
    })
    .returning();
  brandBId = brandB.id;

  // ── Aggregator accounts ──────────────────────────────────────────────────
  const accARes = await request(app)
    .post(`/api/v1/brands/${brandAId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "RPT-A-FP", credential_ref: "ref-rpt-a" });
  expect(accARes.status).toBe(201);

  const accBRes = await request(app)
    .post(`/api/v1/brands/${brandBId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "GRABFOOD", external_merchant_id: "RPT-B-GF", credential_ref: "ref-rpt-b" });
  expect(accBRes.status).toBe(201);

  // Brand A/FOODPANDA gets a 10% commission rate; Brand B/GRABFOOD is left
  // NULL (=> treated as 0 by the report — gross==net until the client
  // supplies real rates).
  await db
    .update(aggregatorAccounts)
    .set({ commissionRate: "10.00" })
    .where(eq(aggregatorAccounts.brandId, brandAId));

  // ── Menu items (price chosen so a single item's total matches the order total) ──
  const menuARes = await request(app)
    .post(`/api/v1/brands/${brandAId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Report Item A", price: "500", station_id: grillStationId });
  expect(menuARes.status).toBe(201);
  const menuAId = menuARes.body.id as string;

  const menuBRes = await request(app)
    .post(`/api/v1/brands/${brandBId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "AN_Report Item B", price: "300", station_id: grillStationId });
  expect(menuBRes.status).toBe(201);
  const menuBId = menuBRes.body.id as string;
  await db.insert(menuItemOutlets).values([
    { menuItemId: menuAId, locationId: outlet1Id, stationId: grillStationId },
    { menuItemId: menuBId, locationId: outlet2Id, stationId: grillStationId },
  ]);

  async function ingest(
    brandId: string,
    aggregator: "FOODPANDA" | "GRABFOOD",
    externalRef: string,
    placedAt: string,
    menuItemId: string,
  ): Promise<string> {
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator,
        external_ref: externalRef,
        placed_at: placedAt,
        items: [{ menu_item_id: menuItemId, qty: 1 }],
      });
    expect(res.status, `ingest ${externalRef} failed: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body.order_id as string;
  }

  // O-A1: 2026-02-10 09:00 — advance to COMPLETED
  const orderA1 = await ingest(brandAId, "FOODPANDA", "RPT-A1", "2026-02-10T09:00:00.000Z", menuAId);
  await advanceThriceToCompleted(orderA1);

  // O-A2: 2026-02-11 09:00 — advance to COMPLETED
  const orderA2 = await ingest(brandAId, "FOODPANDA", "RPT-A2", "2026-02-11T09:00:00.000Z", menuAId);
  await advanceThriceToCompleted(orderA2);

  // O-B1: 2026-02-11 10:00 — advance to COMPLETED
  const orderB1 = await ingest(brandBId, "GRABFOOD", "RPT-B1", "2026-02-11T10:00:00.000Z", menuBId);
  await advanceThriceToCompleted(orderB1);

  // O-A3: 2026-02-10 09:30 — CANCELLED (never a revenue order)
  const orderA3 = await ingest(brandAId, "FOODPANDA", "RPT-A3", "2026-02-10T09:30:00.000Z", menuAId);
  const cancelRes = await request(app)
    .post(`/api/v1/orders/${orderA3}/cancel`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ reason: "test: not a revenue order" });
  expect(cancelRes.status).toBe(200);

  // O-A4: 2026-02-12 09:00 — left at NEW (never a revenue order)
  await ingest(brandAId, "FOODPANDA", "RPT-A4", "2026-02-12T09:00:00.000Z", menuAId);
}, 60_000);

// ---------------------------------------------------------------------------
// GET /reports/sales — RBAC
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — RBAC", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/reports/sales").query({ from: FROM, to: TO });
    expect(res.status).toBe(401);
  });

  it("403s for KITCHEN_CREW", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("200s for OWNER", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
  });

  it("200s for ACCOUNTING", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${accountantToken}`)
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /reports/sales — date range
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — date range", () => {
  it("400s when from > to", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: TO, to: FROM });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("defaults to the current UTC calendar month when from/to are omitted", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const now = new Date();
    const expectedFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    expect(res.body.from).toBe(expectedFrom);
    expect(res.body.group_by).toBe("day");
  });
});

// ---------------------------------------------------------------------------
// GET /reports/sales — gross/net math + group_by variants
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — group_by=brand", () => {
  it("computes gross/net per brand with the 10% commission applied only to Brand A", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "brand" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
      totals: { orders_count: number; gross_sales: number; net_sales: number };
    };

    const brandARow = body.rows.find((r) => r.key === "AN_Report Brand A");
    const brandBRow = body.rows.find((r) => r.key === "AN_Report Brand B");
    expect(brandARow, "Brand A row missing").toBeTruthy();
    expect(brandBRow, "Brand B row missing").toBeTruthy();

    expect(brandARow!.orders_count).toBe(2);
    expect(brandARow!.gross_sales).toBeCloseTo(1000, 2);
    expect(brandARow!.net_sales).toBeCloseTo(900, 2); // 10% commission

    expect(brandBRow!.orders_count).toBe(1);
    expect(brandBRow!.gross_sales).toBeCloseTo(300, 2);
    expect(brandBRow!.net_sales).toBeCloseTo(300, 2); // no rate configured -> gross==net

    expect(body.totals.orders_count).toBe(3);
    expect(body.totals.gross_sales).toBeCloseTo(1300, 2);
    expect(body.totals.net_sales).toBeCloseTo(1200, 2);
  });

  it("excludes CANCELLED and NEW orders from both gross and orders_count", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "brand" });

    const body = res.body as { rows: Array<{ key: string; orders_count: number }> };
    const brandARow = body.rows.find((r) => r.key === "AN_Report Brand A");
    // Brand A has 4 orders total (A1, A2, A3-cancelled, A4-new) but only 2 COMPLETED.
    expect(brandARow!.orders_count).toBe(2);
  });
});

describe("GET /api/v1/reports/sales — group_by=outlet", () => {
  it("groups by outlet name (ALL scope sees both outlets)", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "outlet" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
    };

    const outlet1Row = body.rows.find((r) => r.key === "CloudKitchen ONE");
    const outlet2Row = body.rows.find((r) => r.key === "Report Outlet 2");
    expect(outlet1Row, "Outlet 1 row missing").toBeTruthy();
    expect(outlet2Row, "Outlet 2 row missing").toBeTruthy();

    expect(outlet1Row!.orders_count).toBe(2);
    expect(outlet1Row!.gross_sales).toBeCloseTo(1000, 2);
    expect(outlet1Row!.net_sales).toBeCloseTo(900, 2);

    expect(outlet2Row!.orders_count).toBe(1);
    expect(outlet2Row!.gross_sales).toBeCloseTo(300, 2);
    expect(outlet2Row!.net_sales).toBeCloseTo(300, 2);
  });
});

describe("GET /api/v1/reports/sales — group_by=aggregator", () => {
  it("splits FOODPANDA vs GRABFOOD with the correct net after commission", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "aggregator" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
    };

    const fp = body.rows.find((r) => r.key === "FOODPANDA");
    const gf = body.rows.find((r) => r.key === "GRABFOOD");
    expect(fp, "FOODPANDA row missing").toBeTruthy();
    expect(gf, "GRABFOOD row missing").toBeTruthy();

    expect(fp!.orders_count).toBe(2);
    expect(fp!.gross_sales).toBeCloseTo(1000, 2);
    expect(fp!.net_sales).toBeCloseTo(900, 2);

    expect(gf!.orders_count).toBe(1);
    expect(gf!.gross_sales).toBeCloseTo(300, 2);
    expect(gf!.net_sales).toBeCloseTo(300, 2);
  });
});

describe("GET /api/v1/reports/sales — group_by=day", () => {
  it("splits by UTC calendar day, excluding cancelled/new orders", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "day" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string; orders_count: number; gross_sales: number; net_sales: number }>;
    };

    const day10 = body.rows.find((r) => r.key === "2026-02-10");
    const day11 = body.rows.find((r) => r.key === "2026-02-11");
    const day12 = body.rows.find((r) => r.key === "2026-02-12");

    expect(day10, "2026-02-10 row missing").toBeTruthy();
    expect(day11, "2026-02-11 row missing").toBeTruthy();
    // 2026-02-12 has only O-A4, left at NEW -> no COMPLETED orders -> no row.
    expect(day12).toBeUndefined();

    expect(day10!.orders_count).toBe(1); // O-A1 only (O-A3 cancelled)
    expect(day10!.gross_sales).toBeCloseTo(500, 2);
    expect(day10!.net_sales).toBeCloseTo(450, 2);

    expect(day11!.orders_count).toBe(2); // O-A2 + O-B1
    expect(day11!.gross_sales).toBeCloseTo(800, 2);
    expect(day11!.net_sales).toBeCloseTo(750, 2);
  });

  it("400s for an invalid group_by value", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, group_by: "not-a-real-value" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Tenancy scoping (D22/D31)
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales — outlet scoping", () => {
  it("an ASSIGNED-scope user (outlet_ids=[outlet1]) sees only Outlet 1's numbers", async () => {
    // The two RBAC-allowed roles (OWNER, ACCOUNTING) are always ALL-scope via
    // normal login (D31: HQ_ALL_SCOPE_ROLES). To exercise the ASSIGNED-scope
    // code path for a role that's actually allowed on this endpoint, mint a
    // token directly for the real seeded ACCOUNTING user with an ASSIGNED
    // scope override (signToken's opts.outletScope/outletIds — the same
    // override mechanism the login route itself would use for a
    // per-user-scoped accountant, which this deployment doesn't have yet).
    const { jwtSecret } = loadConfig();
    const [accountingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "accountant@cloudkitchen.local"));

    const scopedToken = signToken(
      { id: accountingUser.id, role: accountingUser.role },
      jwtSecret,
      { outletScope: "ASSIGNED", outletIds: [outlet1Id] },
    );

    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${scopedToken}`)
      .query({ from: FROM, to: TO, group_by: "brand" });

    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ key: string }>;
      totals: { orders_count: number; gross_sales: number; net_sales: number };
    };

    expect(body.rows.find((r) => r.key === "AN_Report Brand A")).toBeTruthy();
    expect(body.rows.find((r) => r.key === "AN_Report Brand B")).toBeUndefined();
    expect(body.totals.orders_count).toBe(2);
    expect(body.totals.gross_sales).toBeCloseTo(1000, 2);
    expect(body.totals.net_sales).toBeCloseTo(900, 2);
  });

  it("an ASSIGNED-scope user with zero granted outlets sees nothing (fails closed)", async () => {
    const { jwtSecret } = loadConfig();
    const [accountingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "accountant@cloudkitchen.local"));

    const scopedToken = signToken(
      { id: accountingUser.id, role: accountingUser.role },
      jwtSecret,
      { outletScope: "ASSIGNED", outletIds: [] },
    );

    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${scopedToken}`)
      .query({ from: FROM, to: TO, group_by: "brand" });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.totals.orders_count).toBe(0);
  });

  it("X-Outlet-Id narrows an ALL-scope (OWNER) user to just that outlet", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", outlet2Id)
      .query({ from: FROM, to: TO, group_by: "brand" });

    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ key: string }>; totals: { orders_count: number } };
    expect(body.rows.find((r) => r.key === "AN_Report Brand B")).toBeTruthy();
    expect(body.rows.find((r) => r.key === "AN_Report Brand A")).toBeUndefined();
    expect(body.totals.orders_count).toBe(1);
  });

  it("X-Outlet-Id for an outlet outside an ASSIGNED user's scope is 403'd (existing W1 middleware)", async () => {
    const { jwtSecret } = loadConfig();
    const [accountingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "accountant@cloudkitchen.local"));

    const scopedToken = signToken(
      { id: accountingUser.id, role: accountingUser.role },
      jwtSecret,
      { outletScope: "ASSIGNED", outletIds: [outlet1Id] },
    );

    const res = await request(app)
      .get("/api/v1/reports/sales")
      .set("Authorization", `Bearer ${scopedToken}`)
      .set("X-Outlet-Id", outlet2Id)
      .query({ from: FROM, to: TO });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /reports/sales/export
// ---------------------------------------------------------------------------

describe("GET /api/v1/reports/sales/export", () => {
  it("400s when format is missing", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(400);
  });

  it("403s for KITCHEN_CREW", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .query({ from: FROM, to: TO, format: "xlsx" });
    expect(res.status).toBe(403);
  });

  it("streams a valid XLSX file with the correct content-type, filename, and PK magic bytes", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, format: "xlsx", group_by: "brand" })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers["content-disposition"]).toContain("orion-sales-2026-02.xlsx");

    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(0);
    // XLSX is a zip archive -> starts with the "PK" local file header signature.
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("streams a valid PDF file with the correct content-type, filename, and %PDF magic bytes", async () => {
    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${adminToken}`)
      .query({ from: FROM, to: TO, format: "pdf", group_by: "day" })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("orion-sales-2026-02.pdf");

    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(0);
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("honors outlet scoping for the export too (ASSIGNED user -> outlet 1 only)", async () => {
    const { jwtSecret } = loadConfig();
    const [accountingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "accountant@cloudkitchen.local"));

    const scopedToken = signToken(
      { id: accountingUser.id, role: accountingUser.role },
      jwtSecret,
      { outletScope: "ASSIGNED", outletIds: [outlet1Id] },
    );

    const res = await request(app)
      .get("/api/v1/reports/sales/export")
      .set("Authorization", `Bearer ${scopedToken}`)
      .query({ from: FROM, to: TO, format: "xlsx" })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
