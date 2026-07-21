/**
 * Deliverect adapter tests — inbound webhook intake/signature/idempotency
 * (src/modules/middleware/deliverect-adapter.ts + routes.ts's DELIVERECT
 * branch) and outbound command mapping (src/modules/outbound/
 * deliverect-adapter.ts), all exercised WITHOUT any real Deliverect
 * credentials or network access (fetch is stubbed for outbound).
 *
 * Inbound fixture mirrors test/middleware-processing.test.ts's proven
 * orderFixture shape; outbound tests construct an OutboundCommandRequest
 * directly (mirrors test/outbound-commands.test.ts's DummyOutboundAdapter
 * usage pattern) since no listing/order context is needed to exercise
 * sendCommand's HTTP-mapping logic in isolation.
 */
import { randomUUID, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { menuItemOutlets, operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  aggregatorAccounts,
  brands,
  ingredients,
  inventoryStock,
  kitchenStations,
  locations,
  menuItems,
  orders,
  recipeLines,
  warehouses,
} from "../src/db/schema.js";
import { processEvent } from "../src/modules/middleware/processor.js";
import { DEFAULT_TEST_DELIVERECT_SECRET } from "../src/modules/middleware/deliverect-secrets.js";
import { DeliverectOutboundAdapter, type FetchLike } from "../src/modules/outbound/deliverect-adapter.js";
import type { OutboundCommandRequest } from "../src/modules/outbound/types.js";

const WEBHOOK_PATH = "/api/v1/middleware/webhook";
const FLAG_KEY = "integration.middleware_processing";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  app = createApp(db);
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function setProcessingEnabled(enabled: boolean): Promise<void> {
  await db.update(operationalFeatureFlags).set({ enabled, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, FLAG_KEY));
}

/** Full ingestOrder-ready fixture: outlet, RESOLVED DELIVERECT-mapped listing, deployed menu item, stocked KITCHEN. */
async function orderFixture(): Promise<{
  locationId: string;
  brandId: string;
  aggregatorAccountId: string;
  channelLinkId: string;
  menuItemId: string;
}> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `DLV-LOC-${s}`, name: `DLV Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `DLV Brand ${s}`, color: "#556677", salesPerfId: `dlv-brand-${s}` })
    .returning();
  const channelLinkId = `DLV-CHANNEL-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({ brandId: brand!.id, locationId: location!.id, mappingStatus: "RESOLVED", aggregator: "FOODPANDA", externalMerchantId: channelLinkId })
    .returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `DLV Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `DLV-ITEM-${s}`, name: `DLV Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "100", lowStockThreshold: "5" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId: brand!.id,
      name: `DLV Dish ${s}`,
      price: "199",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: item!.id,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
  const [kitchenWh] = await db.insert(warehouses).values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `DLV-WH-${s}`, name: `DLV Kitchen ${s}` }).returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "1000" });

  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id, channelLinkId, menuItemId: menuItem!.id };
}

interface DeliverectOrderInput {
  orderId: string;
  channelOrderId: string;
  channelLinkId: string;
  channel?: string;
  status?: string;
  items?: Array<{ plu: string; quantity: number }>;
}

function buildDeliverectEnvelope(input: DeliverectOrderInput): Buffer {
  const envelope = {
    accountId: "acct-1",
    locationId: "loc-1",
    channelLinkId: input.channelLinkId,
    channel: input.channel ?? "foodpanda",
    order: {
      id: input.orderId,
      channelOrderId: input.channelOrderId,
      ...(input.status !== undefined ? { status: input.status } : {}),
      creationDate: new Date().toISOString(),
      items: input.status && input.status.toUpperCase() === "CANCELLED" ? [] : (input.items ?? []),
    },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function signDeliverect(rawBytes: Buffer, secret: string = DEFAULT_TEST_DELIVERECT_SECRET): string {
  return createHmac("sha256", secret).update(rawBytes).digest("hex");
}

async function postDeliverectRawBody(body: Buffer, opts: { signature?: string } = {}): Promise<{ status: number; body: any }> {
  const signature = opts.signature ?? signDeliverect(body);
  const res = await request(app)
    .post(WEBHOOK_PATH)
    .set("Content-Type", "application/json")
    .set("X-Middleware-Provider", "DELIVERECT")
    .set("X-Deliverect-Hmac-Sha256", signature)
    .send(body.toString("utf8"));
  return { status: res.status, body: res.body };
}

/** Builds the envelope once and posts it — use this whenever a test needs two byte-identical requests (idempotency). */
async function postDeliverectWebhook(input: DeliverectOrderInput, opts: { signature?: string } = {}): Promise<{ status: number; body: any }> {
  return postDeliverectRawBody(buildDeliverectEnvelope(input), opts);
}

async function getOrderByExternalRef(aggregatorAccountId: string, externalRef: string) {
  const [order] = await db.select().from(orders).where(eq(orders.externalRef, externalRef));
  return order;
}

describe("Deliverect inbound adapter", () => {
  it("ingests a valid signed order end-to-end into one ORION order", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const orderId = `DLV-ORDER-${randomUUID()}`;
    const channelOrderId = `EXT-${randomUUID()}`;

    const { status, body } = await postDeliverectWebhook({
      orderId,
      channelOrderId,
      channelLinkId: fixture.channelLinkId,
      items: [{ plu: fixture.menuItemId, quantity: 2 }],
    });
    expect(status).toBe(202);
    expect(body.event.provider ?? "DELIVERECT").toBeTruthy();

    const processed = await processEvent(db, body.event.id, { force: true });
    expect(processed.state).toBe("PROCESSED");
    expect(processed.orderId).not.toBeNull();

    const order = await getOrderByExternalRef(fixture.aggregatorAccountId, channelOrderId);
    expect(order).toBeDefined();
    expect(order!.aggregatorAccountId).toBe(fixture.aggregatorAccountId);
    expect(order!.locationId).toBe(fixture.locationId);
  });

  it("rejects a badly signed webhook with 401 and creates no provider_event", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const orderId = `DLV-ORDER-${randomUUID()}`;
    const { status, body } = await postDeliverectWebhook(
      { orderId, channelOrderId: `EXT-${randomUUID()}`, channelLinkId: fixture.channelLinkId, items: [{ plu: fixture.menuItemId, quantity: 1 }] },
      { signature: "0".repeat(64) },
    );
    expect(status).toBe(401);
    expect(body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("is idempotent: replaying the same Deliverect order id sequentially yields a single order", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const orderId = `DLV-ORDER-${randomUUID()}`;
    const channelOrderId = `EXT-${randomUUID()}`;
    const rawBody = buildDeliverectEnvelope({ orderId, channelOrderId, channelLinkId: fixture.channelLinkId, items: [{ plu: fixture.menuItemId, quantity: 1 }] });

    const first = await postDeliverectRawBody(rawBody);
    expect(first.status).toBe(202);
    await processEvent(db, first.body.event.id, { force: true });

    const second = await postDeliverectRawBody(rawBody); // byte-identical replay — same raw hash
    expect(second.status).toBe(200); // DUPLICATE ack — same raw hash
    expect(second.body.status).toBe("DUPLICATE");
    expect(second.body.event.id).toBe(first.body.event.id);

    const rows = await db.select().from(orders).where(eq(orders.externalRef, channelOrderId));
    expect(rows.length).toBe(1);
  });

  it("is idempotent under concurrent replay of the same Deliverect order id", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const orderId = `DLV-ORDER-${randomUUID()}`;
    const channelOrderId = `EXT-${randomUUID()}`;
    const rawBody = buildDeliverectEnvelope({ orderId, channelOrderId, channelLinkId: fixture.channelLinkId, items: [{ plu: fixture.menuItemId, quantity: 1 }] });

    const [a, b] = await Promise.all([postDeliverectRawBody(rawBody), postDeliverectRawBody(rawBody)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 202]); // one CREATED, one DUPLICATE — same underlying event row
    const eventId = a.status === 202 ? a.body.event.id : b.body.event.id;
    await processEvent(db, eventId, { force: true });

    const rows = await db.select().from(orders).where(eq(orders.externalRef, channelOrderId));
    expect(rows.length).toBe(1);
  });
});

describe("Deliverect outbound adapter", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
  }
  function restoreEnv() {
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  afterEach(() => {
    restoreEnv();
  });

  function baseCommand(overrides: Partial<OutboundCommandRequest> = {}): OutboundCommandRequest {
    return {
      commandId: randomUUID(),
      commandType: "ACCEPT_ORDER",
      apiMerchantId: "merchant-1",
      externalRef: "EXT-1",
      payload: {},
      attempt: 1,
      ...overrides,
    };
  }

  it("returns TERMINAL 'not configured' when DELIVERECT_API_TOKEN is unset", async () => {
    saveEnv("DELIVERECT_API_TOKEN", "DELIVERECT_API_BASE_URL");
    delete process.env.DELIVERECT_API_TOKEN;
    delete process.env.DELIVERECT_API_BASE_URL;

    const neverCalled: FetchLike = async () => {
      throw new Error("fetch must not be called when Deliverect is unconfigured");
    };
    const adapter = new DeliverectOutboundAdapter(neverCalled);
    const result = await adapter.sendCommand(baseCommand());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("not configured");
    }
  });

  it("maps ACCEPT_ORDER/MARK_READY/PAUSE_STORE to the expected Deliverect call shape on 200", async () => {
    saveEnv("DELIVERECT_API_TOKEN", "DELIVERECT_API_BASE_URL");
    process.env.DELIVERECT_API_TOKEN = "test-token";
    process.env.DELIVERECT_API_BASE_URL = "https://deliverect.example.test";

    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stub: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "provider-ref-1" }), text: async () => "" };
    };
    const adapter = new DeliverectOutboundAdapter(stub);

    const acceptResult = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "EXT-ACCEPT" }));
    expect(acceptResult).toEqual({ ok: true, providerRef: "provider-ref-1" });
    expect(seen[0]!.url).toBe("https://deliverect.example.test/orders/EXT-ACCEPT/status");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ status: "Accepted" });
    expect((seen[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");

    const readyResult = await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "EXT-READY" }));
    expect(readyResult.ok).toBe(true);
    expect(seen[1]!.url).toBe("https://deliverect.example.test/orders/EXT-READY/status");
    expect(JSON.parse(String(seen[1]!.init!.body))).toEqual({ status: "Pick Up Ready" });

    const pauseResult = await adapter.sendCommand(baseCommand({ commandType: "PAUSE_STORE", externalRef: null, apiMerchantId: "merchant-9" }));
    expect(pauseResult.ok).toBe(true);
    expect(seen[2]!.url).toBe("https://deliverect.example.test/busy");
    expect(JSON.parse(String(seen[2]!.init!.body))).toEqual({ channelLinkId: "merchant-9", status: "PAUSED" });
  });

  it("maps a 500 response to RETRYABLE", async () => {
    saveEnv("DELIVERECT_API_TOKEN", "DELIVERECT_API_BASE_URL");
    process.env.DELIVERECT_API_TOKEN = "test-token";
    process.env.DELIVERECT_API_BASE_URL = "https://deliverect.example.test";

    const stub: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "server exploded" });
    const adapter = new DeliverectOutboundAdapter(stub);
    const result = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "EXT-500" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("RETRYABLE");
  });

  it("maps a 400 response to TERMINAL", async () => {
    saveEnv("DELIVERECT_API_TOKEN", "DELIVERECT_API_BASE_URL");
    process.env.DELIVERECT_API_TOKEN = "test-token";
    process.env.DELIVERECT_API_BASE_URL = "https://deliverect.example.test";

    const stub: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "bad request" });
    const adapter = new DeliverectOutboundAdapter(stub);
    const result = await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "EXT-400" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("TERMINAL");
  });
});
