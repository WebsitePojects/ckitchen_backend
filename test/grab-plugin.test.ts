/**
 * GrabFood Partner API v1.1.3 inbound routes (src/modules/grab/{config,auth,
 * validation,service,routes}.ts). Grab-calls-us shape throughout: G1 mints an
 * access token FOR Grab (inverted from every other inbound integration in
 * this codebase); G2 verifies that token as a bearer on every other route.
 * Test harness pattern (PGlite + runMigrations + supertest) mirrors
 * test/foodpanda-plugin.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { grabListingIntegrations, grabMenuSyncJobs, grabPartnerReceipts } from "../src/db/grab-schema.js";
import { aggregatorAccounts, brands, locations, menuItems, orders } from "../src/db/schema.js";

const BASE = "/api/v1/grab";
const CLIENT_ID = "test-grab-client-id";
const CLIENT_SECRET = "test-grab-client-secret";
const TOKEN_SECRET = "test-grab-token-secret";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let partnerMerchantId: string;
let accountId: string;
let brandId: string;
let seq = 0;

const ORIGINAL_ENV = {
  GRAB_PARTNER_BASE_PATH: process.env.GRAB_PARTNER_BASE_PATH,
  GRAB_PARTNER_CLIENT_ID: process.env.GRAB_PARTNER_CLIENT_ID,
  GRAB_PARTNER_CLIENT_SECRET: process.env.GRAB_PARTNER_CLIENT_SECRET,
  GRAB_PARTNER_TOKEN_SECRET: process.env.GRAB_PARTNER_TOKEN_SECRET,
};

function setConfiguredEnv() {
  process.env.GRAB_PARTNER_BASE_PATH = BASE;
  process.env.GRAB_PARTNER_CLIENT_ID = CLIENT_ID;
  process.env.GRAB_PARTNER_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GRAB_PARTNER_TOKEN_SECRET = TOKEN_SECRET;
}

beforeAll(async () => {
  setConfiguredEnv();
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  app = createApp(db);

  const fixture = await createListing();
  partnerMerchantId = fixture.partnerMerchantId;
  accountId = fixture.accountId;
  brandId = fixture.brandId;
});

afterEach(() => {
  setConfiguredEnv();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeDb(client);
});

function suffix(): string {
  seq += 1;
  return `${seq}-${randomUUID().slice(0, 8)}`;
}

async function createListing() {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `GRABPI-LOC-${s}`, name: `GrabPI Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `GrabPI Brand ${s}`, color: "#00b14f", salesPerfId: `grabpi-brand-${s}` })
    .returning();
  const pmid = `GRABPI-STORE-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      aggregator: "GRABFOOD",
      externalMerchantId: pmid,
      mappingStatus: "RESOLVED",
      isActive: true,
    })
    .returning();
  return { partnerMerchantId: pmid, accountId: account!.id, brandId: brand!.id };
}

async function validToken(): Promise<string> {
  const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

function auth(req: request.Test, token: string) {
  return req.set("Authorization", `Bearer ${token}`);
}

function submitOrderBody(overrides: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    orderID: `GRAB-ORDER-${s}`,
    shortOrderNumber: `S${s}`,
    merchantID: `GRAB-MERCHANT-${s}`,
    partnerMerchantID: partnerMerchantId,
    paymentType: "CASHLESS",
    cutlery: true,
    orderTime: new Date().toISOString(),
    currency: { code: "PHP", symbol: "₱", exponent: 2 },
    featureFlags: { orderAcceptedType: "AUTO", orderType: "DELIVERY", isMexEditOrder: false },
    items: [{ id: "line-1", grabItemID: `SKU-${s}`, quantity: 2, price: 15000, tax: 0 }],
    price: { subtotal: 30000, total: 30000 },
    receiver: {
      name: "Juan Dela Cruz",
      phones: ["+639171234567"],
      address: { address: "123 Test St", coordinates: { latitude: 14.5, longitude: 121.0 } },
    },
    ...overrides,
  };
}

async function receiptCount(route?: "SUBMIT_ORDER" | "PUSH_ORDER_STATE" | "PUSH_INTEGRATION_STATUS" | "MENU_SYNC_STATE" | "PUSH_GRAB_MENU" | "GET_MENU") {
  const rows = route
    ? await db.select({ id: grabPartnerReceipts.id }).from(grabPartnerReceipts).where(eq(grabPartnerReceipts.route, route))
    : await db.select({ id: grabPartnerReceipts.id }).from(grabPartnerReceipts);
  return rows.length;
}

describe("G1 — POST /oauth/token", () => {
  it("issues a token for valid credentials", async () => {
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe("Bearer");
    expect(typeof res.body.access_token).toBe("string");
    expect(typeof res.body.expires_in).toBe("number");

    const decoded = jwt.verify(res.body.access_token, TOKEN_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    expect(decoded.scope).toBe("food.partner_api");
  });

  it("accepts the optional scope field when it matches food.partner_api", async () => {
    const res = await request(app)
      .post(`${BASE}/oauth/token`)
      .send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials", scope: "food.partner_api" });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong client_secret with a generic 401 (no field enumeration)", async () => {
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: "wrong-secret", grant_type: "client_credentials" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_client");
  });

  it("rejects a wrong client_id with the SAME generic 401 code as a wrong secret", async () => {
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: "wrong-id", client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_client");
  });

  it("rejects a wrong grant_type", async () => {
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_client");
  });

  it("rejects an unrecognized scope value", async () => {
    const res = await request(app)
      .post(`${BASE}/oauth/token`)
      .send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials", scope: "something.else" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_client");
  });

  it("is inert with 503 FEATURE_DISABLED when unconfigured", async () => {
    delete process.env.GRAB_PARTNER_CLIENT_SECRET;
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");
  });

  it("never returns or echoes the client_secret", async () => {
    const res = await request(app).post(`${BASE}/oauth/token`).send({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" });
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
  });
});

describe("G2 — bearer auth on every other route", () => {
  it("rejects a missing bearer token on every non-oauth route with 401", async () => {
    const routes = [
      request(app).post(`${BASE}/orders`).send(submitOrderBody()),
      request(app).put(`${BASE}/order/state`).send({ merchantID: "m", partnerMerchantID: partnerMerchantId, orderID: "o", state: "CANCELLED" }),
      request(app).post(`${BASE}/pushIntegrationStatus`).send({ partnerMerchantID: partnerMerchantId, grabMerchantID: "g", integrationStatus: "ACTIVE" }),
      request(app).post(`${BASE}/menuSyncState`).send({ requestID: randomUUID(), merchantID: "m", jobID: randomUUID(), updatedAt: new Date().toISOString(), status: "SUCCESS" }),
      request(app).post(`${BASE}/pushGrabMenu`).send({ partnerMerchantID: partnerMerchantId }),
      request(app).get(`${BASE}/merchant/menu`).query({ merchantID: "m", partnerMerchantID: partnerMerchantId, BusinessType: 1 }),
    ];
    for (const pending of routes) {
      const res = await pending;
      expect(res.status).toBe(401);
    }
  });

  it("rejects a wrong-algorithm token", async () => {
    const wrongAlg = jwt.sign({ scope: "food.partner_api" }, TOKEN_SECRET, { algorithm: "HS512" });
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), wrongAlg).send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(401);
  });

  it("rejects a bad-signature token", async () => {
    const badSig = jwt.sign({ scope: "food.partner_api" }, "totally-wrong-secret", { algorithm: "HS256" });
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), badSig).send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ scope: "food.partner_api" }, TOKEN_SECRET, { algorithm: "HS256", expiresIn: -1 });
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), expired).send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed bearer value", async () => {
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), "not.a.jwt").send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(401);
  });

  it("accepts a genuine token minted via G1", async () => {
    const token = await validToken();
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), token).send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(200);
  });

  it("is inert with 503 when unconfigured, even with a syntactically valid token", async () => {
    const token = await validToken();
    delete process.env.GRAB_PARTNER_TOKEN_SECRET;
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), token).send({ partnerMerchantID: partnerMerchantId });
    expect(res.status).toBe(503);
  });
});

describe("G3 — POST /orders (submit order)", () => {
  it("persists exactly one PENDING receipt and never ingests inline", async () => {
    const token = await validToken();
    const before = await receiptCount("SUBMIT_ORDER");
    const body = submitOrderBody();
    const res = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(res.status).toBe(200);
    expect(res.body.orderID).toBe(body.orderID);

    const rows = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, body.orderID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("PENDING");
    expect(rows[0]!.orderId).toBeNull();
    expect(await receiptCount("SUBMIT_ORDER")).toBe(before + 1);
  });

  it("double-fire: two SEQUENTIAL identical submits create exactly one receipt", async () => {
    const token = await validToken();
    const body = submitOrderBody();
    const before = await receiptCount("SUBMIT_ORDER");

    const first = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    const second = await auth(request(app).post(`${BASE}/orders`), token).send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await receiptCount("SUBMIT_ORDER")).toBe(before + 1);
  });

  it("double-fire: two CONCURRENT (Promise.all) identical submits create exactly one receipt", async () => {
    const token = await validToken();
    const body = submitOrderBody();
    const before = await receiptCount("SUBMIT_ORDER");

    const [a, b] = await Promise.all([auth(request(app).post(`${BASE}/orders`), token).send(body), auth(request(app).post(`${BASE}/orders`), token).send(body)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await receiptCount("SUBMIT_ORDER")).toBe(before + 1);
  });

  it("isMexEditOrder flipped false -> true is NOT treated as a duplicate (Grab's explicit carve-out)", async () => {
    const token = await validToken();
    const body = submitOrderBody();
    const before = await receiptCount("SUBMIT_ORDER");

    const original = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(original.status).toBe(200);

    const edited = await auth(request(app).post(`${BASE}/orders`), token).send({
      ...body,
      featureFlags: { ...body.featureFlags, isMexEditOrder: true },
    });
    expect(edited.status).toBe(200);

    // Two DISTINCT rows for the same orderID — the edit is a legitimate resubmission, not a replay.
    expect(await receiptCount("SUBMIT_ORDER")).toBe(before + 2);
    const rows = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, body.orderID));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.isMexEditOrder).sort()).toEqual([false, true]);
  });

  it("stores receiver PII in rawPayload but NEVER in redactedPayload", async () => {
    const token = await validToken();
    const body = submitOrderBody();
    const res = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(res.status).toBe(200);

    const [receipt] = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, body.orderID));
    expect(receipt).toBeTruthy();

    const rawPayload = receipt!.rawPayload as Record<string, unknown>;
    expect(rawPayload.receiver).toBeTruthy();
    expect(JSON.stringify(rawPayload.receiver)).toContain("Juan Dela Cruz");

    const redacted = receipt!.redactedPayload as Record<string, unknown>;
    const redactedText = JSON.stringify(redacted);
    expect(redactedText).not.toContain("Juan Dela Cruz");
    expect(redactedText).not.toContain("+639171234567");
    expect(redacted.hasReceiver).toBe(true);
  });

  it("converts price.total to major units using the payload's OWN currency.exponent", async () => {
    const token = await validToken();
    const body = submitOrderBody({ currency: { code: "PHP", symbol: "₱", exponent: 2 }, price: { subtotal: 12345, total: 12345 } });
    const res = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(res.status).toBe(200);

    const [receipt] = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, body.orderID));
    const redacted = receipt!.redactedPayload as Record<string, unknown>;
    expect(redacted.totalMajorUnits).toBe(123.45);
  });

  it("fails closed with 400 VALIDATION_ERROR for a bad paymentType enum", async () => {
    const token = await validToken();
    const body = submitOrderBody({ paymentType: "CRYPTO" });
    const res = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when partnerMerchantID does not resolve to an active GRABFOOD listing", async () => {
    const token = await validToken();
    const body = submitOrderBody({ partnerMerchantID: "unknown-store" });
    const res = await auth(request(app).post(`${BASE}/orders`), token).send(body);
    expect(res.status).toBe(404);
  });
});

describe("G4 — PUT /order/state", () => {
  it("fails closed with 400 for an unrecognized state value", async () => {
    const token = await validToken();
    const res = await auth(request(app).put(`${BASE}/order/state`), token).send({
      merchantID: "m",
      partnerMerchantID: partnerMerchantId,
      orderID: "some-order",
      state: "TELEPORTED",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("records an unrecognized-but-valid Grab state (e.g. DRIVER_ALLOCATED) as IGNORED, never guessed", async () => {
    const token = await validToken();
    const orderId = `GRAB-STATE-${suffix()}`;
    const res = await auth(request(app).put(`${BASE}/order/state`), token).send({
      merchantID: "m",
      partnerMerchantID: partnerMerchantId,
      orderID: orderId,
      state: "DRIVER_ALLOCATED",
      driverETA: 300,
    });
    expect(res.status).toBe(200);

    const [receipt] = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, orderId));
    expect(receipt!.state).toBe("IGNORED");
    expect(receipt!.lastError).toContain("DRIVER_ALLOCATED");
  });

  it("double-fire: two identical CANCELLED pushes for a not-yet-ingested order create exactly one receipt", async () => {
    const token = await validToken();
    const orderId = `GRAB-CANCEL-${suffix()}`;
    const body = { merchantID: "m", partnerMerchantID: partnerMerchantId, orderID: orderId, state: "CANCELLED" as const };
    const before = await receiptCount("PUSH_ORDER_STATE");

    const [a, b] = await Promise.all([auth(request(app).put(`${BASE}/order/state`), token).send(body), auth(request(app).put(`${BASE}/order/state`), token).send(body)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await receiptCount("PUSH_ORDER_STATE")).toBe(before + 1);
  });

  /**
   * Rule 6 (.claude/rules/idempotency-concurrency.md). Two CANCELLED pushes for
   * the SAME order that differ only in `message` hash to DIFFERENT dedupeKeys,
   * so both clear the unique-index guard and both reach the cancel path.
   * Asserts the duplicate is absorbed: one CANCELLED order, no 5xx.
   *
   * HONEST SCOPE — read before trusting this test:
   *  1. It does NOT reproduce the true concurrent race. PGlite serialises on a
   *     single connection, so Promise.all here is sequential at the DB: the
   *     second request reads status=CANCELLED and short-circuits on the guard,
   *     never entering cancelOrder. Verified by reverting the handler's
   *     try/catch — this test still passed. The catch guards a real-Postgres
   *     interleaving (both read pre-cancel, cancelOrder's conditional UPDATE
   *     picks a winner, the loser throws ConflictError) that this harness
   *     cannot stage. Reproducing it needs a real Postgres with two live
   *     connections and a scheduling barrier.
   *  2. The order is seeded NEW, so this covers the transition/response
   *     contract only — not the compensating-stock path, which fires from
   *     PREPARING and needs recipe + stock fixtures.
   */
  it("duplicate CANCELLED pushes differing only in message cancel the order exactly once and never 500", async () => {
    const token = await validToken();
    const externalRef = `GRAB-RACE-${suffix()}`;
    const [order] = await db
      .insert(orders)
      .values({
        brandId,
        aggregatorAccountId: accountId,
        aggregator: "GRABFOOD",
        externalRef,
        total: "100.00",
        status: "NEW",
      })
      .returning();

    const base = { merchantID: "m", partnerMerchantID: partnerMerchantId, orderID: externalRef, state: "CANCELLED" as const };
    const [a, b] = await Promise.all([
      auth(request(app).put(`${BASE}/order/state`), token).send({ ...base, message: "customer changed mind" }),
      auth(request(app).put(`${BASE}/order/state`), token).send({ ...base, message: "driver unavailable" }),
    ]);

    // Distinct payloads -> two legitimate receipts, but NEITHER may be a 5xx.
    expect(a.status).toBeLessThan(500);
    expect(b.status).toBeLessThan(500);

    const [after] = await db.select({ status: orders.status, cancelReason: orders.cancelReason }).from(orders).where(eq(orders.id, order!.id));
    expect(after!.status).toBe("CANCELLED");
    expect(after!.cancelReason).toBeTruthy();
  });
});

describe("G5 — POST /pushIntegrationStatus", () => {
  it("returns 204 and writes grabMerchantId into grab_listing_integration", async () => {
    const token = await validToken();
    const grabMerchantId = `GRAB-M-${suffix()}`;
    const res = await auth(request(app).post(`${BASE}/pushIntegrationStatus`), token).send({
      partnerMerchantID: partnerMerchantId,
      grabMerchantID: grabMerchantId,
      integrationStatus: "ACTIVE",
    });
    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    const [integration] = await db.select().from(grabListingIntegrations).where(eq(grabListingIntegrations.aggregatorAccountId, accountId));
    expect(integration!.grabMerchantId).toBe(grabMerchantId);
    expect(integration!.integrationStatus).toBe("ACTIVE");

    const [account] = await db.select({ apiMerchantId: aggregatorAccounts.apiMerchantId }).from(aggregatorAccounts).where(eq(aggregatorAccounts.id, accountId));
    expect(account!.apiMerchantId).toBe(grabMerchantId);
  });

  it("fails closed with 400 for an unrecognized integrationStatus", async () => {
    const token = await validToken();
    const res = await auth(request(app).post(`${BASE}/pushIntegrationStatus`), token).send({
      partnerMerchantID: partnerMerchantId,
      grabMerchantID: "g",
      integrationStatus: "PENDING_REVIEW",
    });
    expect(res.status).toBe(400);
  });
});

describe("G6 — POST /menuSyncState", () => {
  it("processes the first requestID and ignores a repeat, writing exactly one job row", async () => {
    const token = await validToken();
    const requestID = randomUUID();
    const jobID = randomUUID();
    const body = { requestID, merchantID: "m", partnerMerchantID: partnerMerchantId, jobID, updatedAt: new Date().toISOString(), status: "SUCCESS" as const };
    const before = await receiptCount("MENU_SYNC_STATE");

    const first = await auth(request(app).post(`${BASE}/menuSyncState`), token).send(body);
    const second = await auth(request(app).post(`${BASE}/menuSyncState`), token).send(body);
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    expect(await receiptCount("MENU_SYNC_STATE")).toBe(before + 1);

    const jobs = await db.select().from(grabMenuSyncJobs).where(eq(grabMenuSyncJobs.jobId, jobID));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("SUCCESS");
  });

  it("also ignores a concurrent duplicate requestID (Promise.all)", async () => {
    const token = await validToken();
    const requestID = randomUUID();
    const body = { requestID, merchantID: "m", partnerMerchantID: partnerMerchantId, jobID: randomUUID(), updatedAt: new Date().toISOString(), status: "PROCESSING" as const };
    const before = await receiptCount("MENU_SYNC_STATE");

    const [a, b] = await Promise.all([auth(request(app).post(`${BASE}/menuSyncState`), token).send(body), auth(request(app).post(`${BASE}/menuSyncState`), token).send(body)]);
    expect(a.status).toBeLessThan(300);
    expect(b.status).toBeLessThan(300);
    expect(await receiptCount("MENU_SYNC_STATE")).toBe(before + 1);
  });
});

describe("G7 — POST /pushGrabMenu", () => {
  it("persists the raw document as a receipt and returns 2XX", async () => {
    const token = await validToken();
    const res = await auth(request(app).post(`${BASE}/pushGrabMenu`), token).send({ partnerMerchantID: partnerMerchantId, merchantID: "m", categories: [{ weird: "shape" }] });
    expect(res.status).toBeLessThan(300);

    const rows = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.route, "PUSH_GRAB_MENU"));
    expect(rows.length).toBeGreaterThan(0);
    const raw = rows[rows.length - 1]!.rawPayload as Record<string, unknown>;
    expect(raw.categories).toEqual([{ weird: "shape" }]);
  });
});

describe("G8 — GET /merchant/menu", () => {
  it("requires merchantID, partnerMerchantID, and BusinessType", async () => {
    const token = await validToken();
    const res = await auth(request(app).get(`${BASE}/merchant/menu`), token).query({ merchantID: "m" });
    expect(res.status).toBe(400);
  });

  it("returns the documented shape with one synthetic selling time, one category, prices in minor units, and empty modifierGroups", async () => {
    const token = await validToken();
    const s = suffix();
    const [item] = await db
      .insert(menuItems)
      .values({ brandId, name: `Grab Menu Item ${s}`, price: "199.50", availability: "AVAILABLE", itemNo: `GMI-${s}` })
      .returning();
    expect(item).toBeTruthy();

    const res = await auth(request(app).get(`${BASE}/merchant/menu`), token).query({ merchantID: "GRAB-M-1", partnerMerchantID: partnerMerchantId, BusinessType: 1 });
    expect(res.status).toBe(200);
    expect(res.body.merchantID).toBe("GRAB-M-1");
    expect(res.body.partnerMerchantID).toBe(partnerMerchantId);
    expect(res.body.currency).toEqual({ code: "PHP", symbol: "₱", exponent: 2 });
    expect(res.body.sellingTimes).toHaveLength(1);
    expect(res.body.categories).toHaveLength(1);

    const category = res.body.categories[0];
    const found = category.items.find((i: { id: string }) => i.id === `GMI-${s}`);
    expect(found).toBeTruthy();
    expect(found.price).toBe(19950); // 199.50 PHP * 10^2 = minor units
    expect(found.availableStatus).toBe("AVAILABLE");
    expect(found.modifierGroups).toEqual([]);
  });

  it("returns 404 for an unresolvable partnerMerchantID", async () => {
    const token = await validToken();
    const res = await auth(request(app).get(`${BASE}/merchant/menu`), token).query({ merchantID: "m", partnerMerchantID: "no-such-store", BusinessType: 1 });
    expect(res.status).toBe(404);
  });
});
