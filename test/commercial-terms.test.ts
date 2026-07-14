/**
 * W4 -- channel_commercial_term CRUD + resolution coverage (spec section 10,
 * audit gaps B2/B3/B4). Two halves:
 *
 *  (1) HTTP CRUD + RBAC against the real router (createCommercialTermsRouter,
 *      mounted in app.ts) -- list/create/end, the 409 TERM_OVERLAP mapping of
 *      the DB EXCLUDE USING gist constraint, and role gating (OWNER +
 *      ACCOUNTING only, mirroring reports/routes.ts REPORTS_ROLES).
 *
 *  (2) Direct-service effective-dating resolution
 *      (resolveCommercialTermSnapshots) -- proves a query at an order
 *      placement date picks the term that covered THAT date, not "today",
 *      and exercises the documented legacy-commission-rate bridge.
 *
 * Fixture style mirrors src/modules/discounts/discounts.test.ts: fresh
 * in-memory PGlite DB via createDb() + runMigrations(), no seed().
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorAccounts, brands, locations, users } from "../src/db/schema.js";
import { channelCommercialTerms } from "../src/db/w4-schema.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { resolveCommercialTermSnapshots } from "../src/modules/commercial-terms/service.js";

let app: Express;
let db: DB;

let brandId: string;
let accountAId: string; // has a legacy commission_rate configured
let accountBId: string; // legacy commission_rate is NULL

let ownerToken: string;
let accountingToken: string;
let kitchenToken: string;

const OWNER_CRED = { email: "owner@commterms.local", password: "owner-password" };
const ACCOUNTING_CRED = { email: "accounting@commterms.local", password: "acct-password" };
const KITCHEN_CRED = { email: "kitchen@commterms.local", password: "kitchen-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await runMigrations(db);
  app = createApp(db);

  const [location] = await db
    .insert(locations)
    .values({ code: "CT1", name: "Commercial Terms Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [brand] = await db
    .insert(brands)
    .values({ locationId: location.id, name: "CT Brand", color: "#123123", salesPerfId: "CT-SP-1" })
    .returning();
  brandId = brand.id;

  const [accountA] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId,
      aggregator: "FOODPANDA",
      externalMerchantId: "ct-merchant-a",
      commissionRate: "18.00",
    })
    .returning();
  accountAId = accountA.id;

  const [accountB] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, aggregator: "GRABFOOD", externalMerchantId: "ct-merchant-b" })
    .returning();
  accountBId = accountB.id;

  await db.insert(users).values([
    { name: "Owner", email: OWNER_CRED.email, passwordHash: await hashPassword(OWNER_CRED.password), role: "OWNER" },
    {
      name: "Accounting",
      email: ACCOUNTING_CRED.email,
      passwordHash: await hashPassword(ACCOUNTING_CRED.password),
      role: "ACCOUNTING",
    },
    {
      name: "Kitchen Crew",
      email: KITCHEN_CRED.email,
      passwordHash: await hashPassword(KITCHEN_CRED.password),
      role: "KITCHEN_CREW",
    },
  ]);

  ownerToken = await login(OWNER_CRED.email, OWNER_CRED.password);
  accountingToken = await login(ACCOUNTING_CRED.email, ACCOUNTING_CRED.password);
  kitchenToken = await login(KITCHEN_CRED.email, KITCHEN_CRED.password);
});

describe("commercial-terms HTTP -- auth + RBAC", () => {
  it("rejects GET without a token", async () => {
    const res = await request(app).get("/api/v1/commercial-terms");
    expect(res.status).toBe(401);
  });

  it("rejects POST without a token", async () => {
    const res = await request(app).post("/api/v1/commercial-terms").send({});
    expect(res.status).toBe(401);
  });

  it("forbids a non-owner/accounting role (KITCHEN_CREW) from GET", async () => {
    const res = await request(app)
      .get("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(403);
  });

  it("forbids a non-owner/accounting role (KITCHEN_CREW) from POST", async () => {
    const res = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        aggregator_account_id: accountAId,
        rate_type: "BASE",
        percent: "25.00",
        effective_from: "2026-01-01",
      });
    expect(res.status).toBe(403);
  });

  it("allows OWNER and ACCOUNTING to create + list terms", async () => {
    const createRes = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: accountAId,
        rate_type: "BASE",
        percent: "25.00",
        effective_from: "2026-01-01",
        effective_to: "2026-03-31",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body.percent).toBe("25.00");
    expect(createRes.body.rateType).toBe("BASE");

    const listRes = await request(app)
      .get(`/api/v1/commercial-terms?aggregator_account_id=${accountAId}`)
      .set("Authorization", `Bearer ${accountingToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe("commercial-terms HTTP -- CRUD validation", () => {
  it("rejects an unknown aggregator_account_id with 404", async () => {
    const res = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: "00000000-0000-0000-0000-000000000000",
        rate_type: "BASE",
        percent: "10.00",
        effective_from: "2026-01-01",
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a percent outside 0-100 with 400", async () => {
    const res = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: accountBId,
        rate_type: "BASE",
        percent: "150.00",
        effective_from: "2026-01-01",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects effective_to before effective_from with 400", async () => {
    const res = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: accountBId,
        rate_type: "BASE",
        percent: "10.00",
        effective_from: "2026-06-01",
        effective_to: "2026-01-01",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed payload (missing rate_type) with 400", async () => {
    const res = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ aggregator_account_id: accountBId, percent: "10.00", effective_from: "2026-01-01" });
    expect(res.status).toBe(400);
  });

  it("filters list by rate_type", async () => {
    await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: accountBId,
        rate_type: "BASE",
        percent: "20.00",
        effective_from: "2026-01-01",
      });
    await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: accountBId,
        rate_type: "MARKETING",
        percent: "3.00",
        effective_from: "2026-01-01",
      });

    const marketingOnly = await request(app)
      .get(`/api/v1/commercial-terms?aggregator_account_id=${accountBId}&rate_type=MARKETING`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(marketingOnly.status).toBe(200);
    expect(marketingOnly.body.length).toBeGreaterThanOrEqual(1);
    for (const row of marketingOnly.body as Array<{ rateType: string }>) {
      expect(row.rateType).toBe("MARKETING");
    }
  });

  it("rejects an invalid rate_type query filter with 400", async () => {
    const res = await request(app)
      .get("/api/v1/commercial-terms?rate_type=NOT_A_TYPE")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });
});

describe("commercial-terms HTTP -- overlap 409 + end/supersede", () => {
  it("allows a MARKETING term to share the same period as a BASE term (different rate_type)", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-overlap-1" })
      .returning();

    const baseRes = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "25.00",
        effective_from: "2026-01-01",
      });
    expect(baseRes.status).toBe(201);

    const marketingRes = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "MARKETING",
        percent: "5.00",
        effective_from: "2026-01-01",
      });
    expect(marketingRes.status, JSON.stringify(marketingRes.body)).toBe(201);
  });

  it("rejects a second overlapping BASE term for the same listing with 409 TERM_OVERLAP", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-overlap-2" })
      .returning();

    const first = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "25.00",
        effective_from: "2026-01-01",
        effective_to: "2026-06-30",
      });
    expect(first.status).toBe(201);

    const overlapping = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "30.00",
        effective_from: "2026-03-01",
      });
    expect(overlapping.status, JSON.stringify(overlapping.body)).toBe(409);
    expect(overlapping.body.error.code).toBe("TERM_OVERLAP");

    // The first term must be untouched -- a rejected overlap never mutates
    // the existing row.
    const rows = await db
      .select()
      .from(channelCommercialTerms)
      .where(eq(channelCommercialTerms.aggregatorAccountId, account.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.percent).toBe("25.00");
  });

  it("allows a non-overlapping BASE term that starts right after the first one ends", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-overlap-3" })
      .returning();

    await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "25.00",
        effective_from: "2026-01-01",
        effective_to: "2026-06-30",
      });

    const second = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "30.00",
        effective_from: "2026-07-01",
      });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  });

  it("ends (supersedes) a term via PATCH .../end and bumps its version -- never a hard delete", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-end-1" })
      .returning();

    const created = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "22.00",
        effective_from: "2026-01-01",
      });
    expect(created.status).toBe(201);
    const termId = created.body.id as string;
    expect(created.body.version).toBe(1);

    const ended = await request(app)
      .patch(`/api/v1/commercial-terms/${termId}/end`)
      .set("Authorization", `Bearer ${accountingToken}`)
      .send({ effective_to: "2026-06-30" });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.effectiveTo).toBe("2026-06-30");
    expect(ended.body.version).toBe(2);

    // Row still exists (soft end, no hard delete) -- fetch it back via GET.
    const list = await request(app)
      .get(`/api/v1/commercial-terms?aggregator_account_id=${account.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body.find((r: { id: string }) => r.id === termId)).toBeTruthy();

    // Now a new BASE term starting right after the ended one is accepted --
    // proves the narrowed range no longer blocks a successor.
    const successor = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "28.00",
        effective_from: "2026-07-01",
      });
    expect(successor.status).toBe(201);
  });

  it("rejects PATCH .../end with effective_to before effective_from (400)", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-end-2" })
      .returning();
    const created = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "22.00",
        effective_from: "2026-06-01",
      });

    const res = await request(app)
      .patch(`/api/v1/commercial-terms/${created.body.id}/end`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ effective_to: "2026-01-01" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for PATCH .../end on an unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/commercial-terms/00000000-0000-0000-0000-000000000000/end")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ effective_to: "2026-01-01" });
    expect(res.status).toBe(404);
  });

  it("forbids KITCHEN_CREW from ending a term", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-merchant-end-3" })
      .returning();
    const created = await request(app)
      .post("/api/v1/commercial-terms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        aggregator_account_id: account.id,
        rate_type: "BASE",
        percent: "22.00",
        effective_from: "2026-01-01",
      });

    const res = await request(app)
      .patch(`/api/v1/commercial-terms/${created.body.id}/end`)
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ effective_to: "2026-06-30" });
    expect(res.status).toBe(403);
  });
});

describe("resolveCommercialTermSnapshots -- effective-dating resolution", () => {
  it("picks the term whose range covers the order date, not the newest term", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-resolve-1" })
      .returning();

    await db.insert(channelCommercialTerms).values([
      {
        aggregatorAccountId: account.id,
        rateType: "BASE",
        percent: "20.00",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-03-31",
      },
      {
        aggregatorAccountId: account.id,
        rateType: "BASE",
        percent: "25.00",
        effectiveFrom: "2026-04-01",
      },
    ]);

    const duringFirst = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-02-15T00:00:00.000Z"), null);
    expect(duringFirst.commissionRateSnapshot).toBe("20.00");

    const duringSecond = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-05-01T00:00:00.000Z"), null);
    expect(duringSecond.commissionRateSnapshot).toBe("25.00");

    const wellIntoSecond = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-12-31T00:00:00.000Z"), null);
    expect(wellIntoSecond.commissionRateSnapshot).toBe("25.00");
  });

  it("resolves BASE and MARKETING independently for the same date", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-resolve-2" })
      .returning();

    await db.insert(channelCommercialTerms).values([
      { aggregatorAccountId: account.id, rateType: "BASE", percent: "25.00", effectiveFrom: "2026-01-01" },
      { aggregatorAccountId: account.id, rateType: "MARKETING", percent: "4.50", effectiveFrom: "2026-01-01" },
    ]);

    const result = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-06-01T00:00:00.000Z"), null);
    expect(result.commissionRateSnapshot).toBe("25.00");
    expect(result.marketingRateSnapshot).toBe("4.50");
  });

  it("bridges to the legacy aggregator_account.commission_rate for BASE when zero term rows exist", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-resolve-3", commissionRate: "12.50" })
      .returning();

    const result = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-06-01T00:00:00.000Z"), "12.50");
    expect(result.commissionRateSnapshot).toBe("12.50");
    // MARKETING has no legacy equivalent -- always NULL under the bridge.
    expect(result.marketingRateSnapshot).toBeNull();
  });

  it("returns NULL (never the legacy rate) for a coverage gap once ANY term row exists for the listing", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-resolve-4", commissionRate: "12.50" })
      .returning();

    // A term exists, but only covering Jan-Mar -- querying a date in July is
    // a genuine coverage gap, NOT a "zero rows" bridge case.
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: account.id,
      rateType: "BASE",
      percent: "20.00",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-03-31",
    });

    const result = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-07-01T00:00:00.000Z"), "12.50");
    expect(result.commissionRateSnapshot).toBeNull();
    expect(result.marketingRateSnapshot).toBeNull();
  });

  it("returns NULL for a date before any term's effective_from with no legacy rate available", async () => {
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId, aggregator: "OTHER", externalMerchantId: "ct-resolve-5" })
      .returning();

    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: account.id,
      rateType: "BASE",
      percent: "20.00",
      effectiveFrom: "2026-06-01",
    });

    const result = await resolveCommercialTermSnapshots(db, account.id, new Date("2026-01-01T00:00:00.000Z"), null);
    expect(result.commissionRateSnapshot).toBeNull();
  });
});
