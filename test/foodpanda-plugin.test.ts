/**
 * Foodpanda / Delivery Hero POS Plugin API inbound routes (src/modules/foodpanda/
 * routes.ts + service.ts + validation.ts). Rewritten against the REAL Delivery
 * Hero order shape (Documents/foodpanda-api/pluginOrder.yaml, verified against
 * test/fixtures/foodpanda-generic-order.json — see test/foodpanda-spec-fixture.test.ts
 * for the anti-regression coverage of the shape itself).
 *
 * Top-level order identity is `token` (POS-middleware order id — the real
 * dedupe/outbound key) + `code` (platform-side id, display-only). There is NO
 * top-level orderId/orderToken/id, and the line array is `products[]`, not
 * `items[]`. Dispatch now persists a PENDING receipt + PENDING outbound task and
 * leaves mapping/ingestion to the worker (test/foodpanda-worker.test.ts) — it
 * does NOT ingest inline.
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
import {
  foodpandaListingAvailability,
  foodpandaPluginOutboundTasks,
  foodpandaPluginReceipts,
} from "../src/db/foodpanda-plugin-schema.js";
import { aggregatorAccounts, brands, locations } from "../src/db/schema.js";
import {
  MIXED_ITEM_UNAVAILABILITY_HANDLING,
  resolveItemUnavailabilityHandling,
  type ItemUnavailabilityHandling,
  type OrderDispatchBody,
} from "../src/modules/foodpanda/validation.js";

const SECRET = "test-foodpanda-plugin-secret";
const BASE = "/api/v1/foodpanda";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let remoteId: string;
let accountId: string;
let seq = 0;

const ORIGINAL_ENV = {
  FOODPANDA_PLUGIN_BASE_PATH: process.env.FOODPANDA_PLUGIN_BASE_PATH,
  FOODPANDA_PLUGIN_JWT_SECRET: process.env.FOODPANDA_PLUGIN_JWT_SECRET,
};

beforeAll(async () => {
  process.env.FOODPANDA_PLUGIN_BASE_PATH = BASE;
  process.env.FOODPANDA_PLUGIN_JWT_SECRET = SECRET;
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  app = createApp(db);

  const fixture = await createListing();
  remoteId = fixture.remoteId;
  accountId = fixture.accountId;
});

afterEach(() => {
  process.env.FOODPANDA_PLUGIN_BASE_PATH = BASE;
  process.env.FOODPANDA_PLUGIN_JWT_SECRET = SECRET;
});

afterAll(async () => {
  if (ORIGINAL_ENV.FOODPANDA_PLUGIN_BASE_PATH === undefined) delete process.env.FOODPANDA_PLUGIN_BASE_PATH;
  else process.env.FOODPANDA_PLUGIN_BASE_PATH = ORIGINAL_ENV.FOODPANDA_PLUGIN_BASE_PATH;
  if (ORIGINAL_ENV.FOODPANDA_PLUGIN_JWT_SECRET === undefined) delete process.env.FOODPANDA_PLUGIN_JWT_SECRET;
  else process.env.FOODPANDA_PLUGIN_JWT_SECRET = ORIGINAL_ENV.FOODPANDA_PLUGIN_JWT_SECRET;
  await closeDb(client);
});

function suffix() {
  seq += 1;
  return `${seq}-${randomUUID().slice(0, 8)}`;
}

// No hardcoded calendar literals — every date a test depends on comes from Date.now().
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

async function createListing() {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `FPPI-LOC-${s}`, name: `FPPI Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `FPPI Brand ${s}`, color: "#cc0066", salesPerfId: `fppi-brand-${s}` })
    .returning();
  const rid = `FPPI-REMOTE-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      aggregator: "FOODPANDA",
      externalMerchantId: `legacy-${rid}`,
      apiMerchantId: rid,
      mappingStatus: "RESOLVED",
      isActive: true,
    })
    .returning();
  return { remoteId: rid, accountId: account!.id };
}

function token(payload: object = { service: "middleware" }, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, SECRET, { algorithm: "HS512", ...options });
}

function auth(req: request.Test, jwtToken = token()) {
  return req.set("Authorization", `Bearer ${jwtToken}`);
}

/**
 * pluginOrder.yaml's REAL top-level shape: `token` (POS-middleware order id —
 * the outbound/dedupe key), `code` (platform id, display-only), `expeditionType`,
 * `expiryDate`, `products[]` (NOT `items[]`), `callbackUrls`. Defaults to
 * "pickup" so tests don't also have to satisfy the delivery-required refinement.
 */
function dispatchBody(overrides: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    token: `FP-TOKEN-${s}`,
    code: `plat-${s}`,
    expeditionType: "pickup",
    expiryDate: day(1),
    products: [{ id: "provider-product-1", name: "Dish", quantity: "1", remoteCode: `SKU-${s}` }],
    callbackUrls: {
      orderAcceptedUrl: "https://vendor.example.restaurant-partners.com/callback/accept",
      orderRejectedUrl: "https://vendor.example.restaurant-partners.com/callback/reject",
    },
    ignoredFutureField: { ok: true },
    ...overrides,
  };
}

async function receiptRows() {
  return db.select().from(foodpandaPluginReceipts);
}

async function receiptCount(route?: "ORDER_DISPATCH" | "ORDER_STATUS" | "AVAILABILITY" | "MENU_IMPORT_TRIGGER" | "CATALOG_IMPORT_CALLBACK") {
  const rows = route
    ? await db.select({ id: foodpandaPluginReceipts.id }).from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.route, route))
    : await db.select({ id: foodpandaPluginReceipts.id }).from(foodpandaPluginReceipts);
  return rows.length;
}

describe("Foodpanda Plugin API auth and mounted routes", () => {
  it("is inert with 503 when FOODPANDA_PLUGIN_JWT_SECRET is absent", async () => {
    delete process.env.FOODPANDA_PLUGIN_JWT_SECRET;
    const res = await request(app).post(`${BASE}/order/${remoteId}`).send(dispatchBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");
  });

  it("fails closed for wrong algorithm and missing service claim", async () => {
    const wrongAlg = jwt.sign({ service: "middleware" }, SECRET, { algorithm: "HS256" });
    const wrongAlgRes = await auth(request(app).post(`${BASE}/order/${remoteId}`), wrongAlg).send(dispatchBody());
    expect(wrongAlgRes.status).toBe(401);

    const missingServiceRes = await auth(request(app).post(`${BASE}/order/${remoteId}`), token({ sub: "delivery-hero" })).send(dispatchBody());
    expect(missingServiceRes.status).toBe(401);
  });

  it("fails closed for malformed, expired, and bad-signature bearer JWTs", async () => {
    const malformed = await auth(request(app).post(`${BASE}/order/${remoteId}`), "not.a.jwt").send(dispatchBody());
    expect(malformed.status).toBe(401);

    const expired = await auth(request(app).post(`${BASE}/order/${remoteId}`), token({ service: "middleware" }, { expiresIn: -1 })).send(dispatchBody());
    expect(expired.status).toBe(401);

    const badSignature = jwt.sign({ service: "middleware" }, "wrong-secret", { algorithm: "HS512" });
    const badSignatureRes = await auth(request(app).post(`${BASE}/order/${remoteId}`), badSignature).send(dispatchBody());
    expect(badSignatureRes.status).toBe(401);
  });

  it("requires bearer auth on all five plugin routes", async () => {
    const routes = [
      request(app).post(`${BASE}/order/${remoteId}`).send(dispatchBody()),
      request(app).put(`${BASE}/remoteId/${remoteId}/remoteOrder/orion-fp-test/posOrderStatus`).send({ status: "ORDER_PICKED_UP", message: "ok" }),
      request(app).put(`${BASE}/remoteId/${remoteId}/availability`).send({ timestamp: new Date().toISOString(), closures: [] }),
      request(app).get(`${BASE}/menuimport/${remoteId}`).query({ vendorCode: "vendor-1", menuImportId: "menu-1" }),
      request(app).post(`${BASE}/catalog-callback`).send({ catalogImportId: `cat-${suffix()}`, status: "done" }),
    ];
    for (const pending of routes) {
      const res = await pending;
      expect(res.status).toBe(401);
    }
  });

  it("mounts all five documented plugin routes behind valid HS512 middleware JWT auth", async () => {
    const dispatch = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(dispatchBody());
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.remoteResponse.remoteOrderId).toMatch(/^orion-fp-/);

    const status = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/remoteOrder/${dispatch.body.remoteResponse.remoteOrderId}/posOrderStatus`)).send({
      status: "ORDER_PICKED_UP",
      message: "picked up",
    });
    expect(status.status).toBe(200);

    const availability = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send({
      timestamp: new Date().toISOString(),
      closures: [],
    });
    expect(availability.status).toBe(200);

    const menu = await auth(request(app).get(`${BASE}/menuimport/${remoteId}`).query({ vendorCode: "vendor-1", menuImportId: `menu-${suffix()}` }));
    expect(menu.status).toBe(202);
    expect(menu.text).toBe("");

    const callback = await auth(request(app).post(`${BASE}/catalog-callback`)).send({ catalogImportId: `cat-${suffix()}`, status: "in_progress" });
    expect(callback.status).toBe(200);
    expect(callback.text).toBe("");
  });
});

describe("Foodpanda order dispatch — real shape persistence, no inline ingestion", () => {
  it("returns 200 with { remoteResponse: { remoteOrderId } } and persists a PENDING receipt (left for the worker)", async () => {
    const before = await receiptCount("ORDER_DISPATCH");
    const body = dispatchBody();
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);
    expect(res.status).toBe(200);
    const remoteOrderId = res.body.remoteResponse.remoteOrderId as string;
    expect(remoteOrderId).toMatch(/^orion-fp-/);

    const rows = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.remoteOrderId, remoteOrderId));
    expect(rows).toHaveLength(1);
    const receipt = rows[0]!;
    // Left for the worker — dispatch never ingests inline.
    expect(receipt.state).toBe("PENDING");
    expect(receipt.orderId).toBeNull();
    expect(await receiptCount("ORDER_DISPATCH")).toBe(before + 1);
  });

  it("persists token as provider_order_id, code, expiryDate, callbackUrls, and the full raw_payload", async () => {
    const body = dispatchBody();
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);
    const remoteOrderId = res.body.remoteResponse.remoteOrderId as string;

    const [receipt] = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.remoteOrderId, remoteOrderId));
    expect(receipt!.providerOrderId).toBe(body.token);
    expect(receipt!.platformOrderCode).toBe(body.code);
    expect(receipt!.expiryDate!.toISOString()).toBe(body.expiryDate);
    expect(receipt!.callbackUrls).toEqual(body.callbackUrls);
    expect(receipt!.rawPayload).toMatchObject({ token: body.token, code: body.code, expeditionType: body.expeditionType });
  });

  it("creates exactly one PENDING outbound decision task in the same transaction as the receipt", async () => {
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(dispatchBody());
    const remoteOrderId = res.body.remoteResponse.remoteOrderId as string;
    const [receipt] = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.remoteOrderId, remoteOrderId));

    const tasks = await db.select().from(foodpandaPluginOutboundTasks).where(eq(foodpandaPluginOutboundTasks.receiptId, receipt!.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("PENDING");
    expect(tasks[0]!.taskType).toBe("ORDER_ACCEPT_REJECT_DECISION");
    expect(tasks[0]!.remoteOrderId).toBe(remoteOrderId);
  });

  it("double-fire: two SEQUENTIAL identical dispatches return the same remoteOrderId and create exactly one receipt", async () => {
    const body = dispatchBody();
    const before = await receiptCount("ORDER_DISPATCH");

    const first = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);
    const second = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.remoteResponse.remoteOrderId).toBe(first.body.remoteResponse.remoteOrderId);
    expect(await receiptCount("ORDER_DISPATCH")).toBe(before + 1);
  });

  it("double-fire: two CONCURRENT (Promise.all) identical dispatches return the same remoteOrderId and create exactly one receipt", async () => {
    const body = dispatchBody();
    const before = await receiptCount("ORDER_DISPATCH");

    const [a, b] = await Promise.all([
      auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body),
      auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.remoteResponse.remoteOrderId).toBe(b.body.remoteResponse.remoteOrderId);
    expect(await receiptCount("ORDER_DISPATCH")).toBe(before + 1);

    const tasks = await db.select().from(foodpandaPluginOutboundTasks).where(eq(foodpandaPluginOutboundTasks.remoteOrderId, a.body.remoteResponse.remoteOrderId));
    expect(tasks).toHaveLength(1);
  });

  it("fails closed with 400 VALIDATION_ERROR for an unknown expeditionType", async () => {
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send({
      token: `FP-BAD-${suffix()}`,
      expeditionType: "dine-in",
      products: [{ quantity: "1" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("fails closed with 400 VALIDATION_ERROR for a missing token", async () => {
    const body = dispatchBody();
    delete (body as Record<string, unknown>).token;
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("fails closed with 400 VALIDATION_ERROR for a non-numeric products[].quantity", async () => {
    const body = dispatchBody({ products: [{ id: "p1", name: "Dish", quantity: "string" }] });
    const res = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Foodpanda status, availability, menu, and callback idempotency", () => {
  it("dedupes identical status notifications by remoteOrderId and request hash", async () => {
    const dispatch = await auth(request(app).post(`${BASE}/order/${remoteId}`)).send(dispatchBody());
    const remoteOrderId = dispatch.body.remoteResponse.remoteOrderId as string;
    const before = await receiptCount("ORDER_STATUS");
    const body = { status: "ORDER_CANCELLED", message: "cancelled by platform" };

    const first = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/remoteOrder/${remoteOrderId}/posOrderStatus`)).send(body);
    const second = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/remoteOrder/${remoteOrderId}/posOrderStatus`)).send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await receiptCount("ORDER_STATUS")).toBe(before + 1);
  });

  it("applies availability equal timestamp once and ignores older timestamps", async () => {
    const timestamp = day(0);
    const olderTimestamp = day(-1);
    const body = { timestamp, closures: [{ reason: "TOO_BUSY_KITCHEN", start: timestamp, end: null, changeable: true }] };
    const before = await receiptCount("AVAILABILITY");

    const [a, b] = await Promise.all([
      auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send(body),
      auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send(body),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await receiptCount("AVAILABILITY")).toBe(before + 1);

    const older = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send({
      timestamp: olderTimestamp,
      closures: [],
    });
    expect(older.status).toBe(200);

    const [state] = await db.select().from(foodpandaListingAvailability).where(eq(foodpandaListingAvailability.aggregatorAccountId, accountId));
    expect(state!.eventTimestamp.toISOString()).toBe(timestamp);
    expect(Array.isArray(state!.closures)).toBe(true);
    expect(state!.closures).toHaveLength(1);
  });

  it("dedupes menu import trigger and catalog callback notifications", async () => {
    const menuImportId = `menu-${suffix()}`;
    const menuBefore = await receiptCount("MENU_IMPORT_TRIGGER");
    const menuA = await auth(request(app).get(`${BASE}/menuimport/${remoteId}`).query({ vendorCode: "vendor-x", menuImportId }));
    const menuB = await auth(request(app).get(`${BASE}/menuimport/${remoteId}`).query({ vendorCode: "vendor-x", menuImportId }));
    expect(menuA.status).toBe(202);
    expect(menuB.status).toBe(202);
    expect(await receiptCount("MENU_IMPORT_TRIGGER")).toBe(menuBefore + 1);

    const callbackBefore = await receiptCount("CATALOG_IMPORT_CALLBACK");
    const callbackBody = {
      catalogImportId: `catalog-${suffix()}`,
      status: "done_with_errors",
      details: [{ status: "failed", posVendorId: remoteId, platformVendorId: "platform-1", globalEntityId: "FP_PH" }],
    };
    const callbackA = await auth(request(app).post(`${BASE}/catalog-callback`)).send(callbackBody);
    const callbackB = await auth(request(app).post(`${BASE}/catalog-callback`)).send(callbackBody);
    expect(callbackA.status).toBe(200);
    expect(callbackB.status).toBe(200);
    expect(await receiptCount("CATALOG_IMPORT_CALLBACK")).toBe(callbackBefore + 1);

    const rows = await receiptRows();
    expect(rows.some((r) => r.route === "CATALOG_IMPORT_CALLBACK" && r.remoteId === "catalog-callback")).toBe(true);
  });

  it("returns 404 when remoteId is unknown or ambiguous", async () => {
    const unknown = await auth(request(app).put(`${BASE}/remoteId/unknown-remote/availability`)).send({
      timestamp: new Date().toISOString(),
      closures: [],
    });
    expect(unknown.status).toBe(404);

    const s = suffix();
    const [location] = await db.insert(locations).values({ code: `FPPI-AMB-${s}`, name: `FPPI Amb ${s}` }).returning();
    const [brand] = await db
      .insert(brands)
      .values({ locationId: location!.id, name: `FPPI Amb Brand ${s}`, color: "#000000", salesPerfId: `fppi-amb-${s}` })
      .returning();
    await db.insert(aggregatorAccounts).values({
      brandId: brand!.id,
      locationId: location!.id,
      aggregator: "FOODPANDA",
      externalMerchantId: remoteId,
      mappingStatus: "RESOLVED",
      isActive: true,
    });

    const ambiguous = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send({
      timestamp: new Date().toISOString(),
      closures: [],
    });
    expect(ambiguous.status).toBe(404);
  });

  it("fails closed for unknown status and availability closure enums", async () => {
    const status = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/remoteOrder/orion-fp-x/posOrderStatus`)).send({
      status: "ORDER_SOMETHING_ELSE",
      message: "x",
    });
    expect(status.status).toBe(400);

    const availability = await auth(request(app).put(`${BASE}/remoteId/${remoteId}/availability`)).send({
      timestamp: new Date().toISOString(),
      closures: [{ reason: "NEW_REASON", start: new Date().toISOString(), changeable: true }],
    });
    expect(availability.status).toBe(400);
  });
});

describe("resolveItemUnavailabilityHandling precedence (validation.ts, pure unit coverage)", () => {
  function bodyWithHandling(handlingByProduct: Array<ItemUnavailabilityHandling | undefined>): OrderDispatchBody {
    return {
      token: "unit-test-token",
      expeditionType: "pickup",
      products: handlingByProduct.map((handling) => ({
        quantity: "1",
        ...(handling ? { itemUnavailabilityHandling: handling } : {}),
      })),
    } as unknown as OrderDispatchBody;
  }

  it("any CANCEL_ORDER present wins, even alongside other values", () => {
    expect(resolveItemUnavailabilityHandling(bodyWithHandling(["REMOVE", "CANCEL_ORDER", "REDUCE_QUANTITY"]))).toBe("CANCEL_ORDER");
  });

  it("all products carrying the SAME value returns that value", () => {
    expect(resolveItemUnavailabilityHandling(bodyWithHandling(["REMOVE", "REMOVE", "REMOVE"]))).toBe("REMOVE");
  });

  it("a genuine mix (no CANCEL_ORDER) returns the MIXED sentinel", () => {
    expect(resolveItemUnavailabilityHandling(bodyWithHandling(["REMOVE", "REDUCE_QUANTITY"]))).toBe(MIXED_ITEM_UNAVAILABILITY_HANDLING);
  });

  it("no product carrying a value returns null", () => {
    expect(resolveItemUnavailabilityHandling(bodyWithHandling([undefined, undefined]))).toBeNull();
  });

  it("CANCEL_ORDER buried in a nested topping still wins (recursion into selectedToppings.children)", () => {
    const body = {
      token: "unit-test-token-2",
      expeditionType: "pickup",
      products: [
        {
          quantity: "1",
          itemUnavailabilityHandling: "REMOVE",
          selectedToppings: [{ children: [{ itemUnavailabilityHandling: "CANCEL_ORDER" }] }],
        },
      ],
    } as unknown as OrderDispatchBody;
    expect(resolveItemUnavailabilityHandling(body)).toBe("CANCEL_ORDER");
  });
});
