/**
 * Middleware event processing tests (spec §11 — src/modules/middleware/
 * processor.ts + the admin routes in routes.ts). Covers §8 listing
 * resolution (aggregator + external_merchant_id -> exactly one channel
 * listing), MAPPING_REQUIRED/DLQ parking, the flag gate on
 * `integration.middleware_processing`, bounded retries -> FAILED, replay via
 * the admin reprocess endpoint, and out-of-order ORDER_CANCELLED handling.
 *
 * Order fixture shape (brand/outlet/station/menu item/recipe line/
 * menuItemOutlets/KITCHEN warehouse+stock) mirrors test/
 * listing-outlet-routing.test.ts's proven ingestOrder fixture.
 */
import { randomUUID, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import { menuItemOutlets, operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import { providerEvents, type ProviderEvent } from "../src/db/middleware-schema.js";
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
  userOutletAccess,
  users,
  warehouses,
  type Role,
} from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";
import { processEvent, MAX_PROCESSING_ATTEMPTS } from "../src/modules/middleware/processor.js";
import { intakeEvent } from "../src/modules/middleware/service.js";
import { DummyProviderAdapter } from "../src/modules/middleware/adapter.js";
import type { NormalizedProviderEvent } from "../src/modules/middleware/types.js";

const TEST_SECRET = "test-middleware-webhook-secret";
const TEST_KEY_ID = "dummy-key-v1";
const WEBHOOK_PATH = "/api/v1/middleware/webhook";
const FLAG_KEY = "integration.middleware_processing";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  jwtSecret = loadConfig().jwtSecret;
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

async function actor(role: Role, locationId?: string): Promise<{ userId: string; token: string }> {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `MW Actor ${s}`, email: `mw-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token };
}

/** Full ingestOrder-ready fixture: outlet, RESOLVED listing, deployed menu item, stocked KITCHEN. */
async function orderFixture(): Promise<{
  locationId: string;
  brandId: string;
  aggregatorAccountId: string;
  merchantRef: string;
  menuItemId: string;
}> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `MWP-LOC-${s}`, name: `MW Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `MW Brand ${s}`, color: "#112233", salesPerfId: `mw-brand-${s}` })
    .returning();
  const merchantRef = `FP-MW-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({ brandId: brand!.id, locationId: location!.id, mappingStatus: "RESOLVED", aggregator: "FOODPANDA", externalMerchantId: merchantRef })
    .returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `MW Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `MWP-ITEM-${s}`, name: `MW Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "100", lowStockThreshold: "5" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId: brand!.id,
      name: `MW Dish ${s}`,
      price: "199",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: item!.id,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
  const [kitchenWh] = await db.insert(warehouses).values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `MWP-WH-${s}`, name: `MW Kitchen ${s}` }).returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "1000" });

  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id, merchantRef, menuItemId: menuItem!.id };
}

function sign(rawBytes: Buffer, timestamp: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(Buffer.from(`${timestamp}.`, "utf8"));
  hmac.update(rawBytes);
  return hmac.digest("hex");
}

interface EnvelopeInput {
  event_id: string;
  event_type: "ORDER_CREATED" | "ORDER_CANCELLED";
  merchant_id: string;
  external_ref: string;
  aggregator?: "FOODPANDA" | "GRABFOOD" | "OTHER";
  items?: Array<{ menu_item_id: string; qty: number }>;
}

function buildEnvelope(input: EnvelopeInput): Buffer {
  const envelope = {
    event_id: input.event_id,
    event_type: input.event_type,
    occurred_at: new Date().toISOString(),
    aggregator: input.aggregator ?? "FOODPANDA",
    merchant_id: input.merchant_id,
    order: {
      external_ref: input.external_ref,
      items: input.event_type === "ORDER_CREATED" ? (input.items ?? []) : [],
    },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

/** Posts a validly-signed webhook and returns the parsed response body. */
async function postWebhook(input: EnvelopeInput): Promise<{ status: number; body: { status: string; event: { id: string } } }> {
  const body = buildEnvelope(input);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(body, timestamp, TEST_SECRET);
  const res = await request(app)
    .post(WEBHOOK_PATH)
    .set("Content-Type", "application/json")
    .set("X-Middleware-Timestamp", timestamp)
    .set("X-Middleware-Key-Id", TEST_KEY_ID)
    .set("X-Middleware-Signature", signature)
    .send(body.toString("utf8"));
  return { status: res.status, body: res.body };
}

async function getEvent(id: string): Promise<ProviderEvent> {
  const [row] = await db.select().from(providerEvents).where(eq(providerEvents.id, id));
  return row!;
}

describe("middleware event processing", () => {
  it("refuses to process while integration.middleware_processing is OFF, but intake already persisted", async () => {
    await setProcessingEnabled(false);
    const fixture = await orderFixture();
    const { status, body } = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: `EXT-${randomUUID()}`,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    expect(status).toBe(202); // intake ack is independent of the processing flag
    await expect(processEvent(db, body.event.id)).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    const row = await getEvent(body.event.id);
    expect(row.state).toBe("PENDING"); // untouched — processing never ran
  });

  it("parks MAPPING_REQUIRED for an unknown external_merchant_id and creates no order", async () => {
    await setProcessingEnabled(true);
    const eventId = randomUUID();
    const externalRef = `EXT-${randomUUID()}`;
    const normalized: NormalizedProviderEvent = {
      providerEventId: eventId,
      occurredAt: new Date().toISOString(),
      kind: "ORDER_CREATED",
      aggregator: "FOODPANDA",
      merchantRef: `UNKNOWN-MERCHANT-${randomUUID()}`,
      orderPayload: { external_ref: externalRef, items: [{ menu_item_id: randomUUID(), qty: 1 }] },
    };
    const rawHash = "deadbeef".repeat(8);
    const { event } = await intakeEvent(db, { provider: "DUMMY", normalized, rawHash, keyId: TEST_KEY_ID });

    const beforeOrders = (await db.select({ id: orders.id }).from(orders)).length;
    const processed = await processEvent(db, event.id);
    expect(processed.state).toBe("MAPPING_REQUIRED");
    expect((await db.select({ id: orders.id }).from(orders)).length).toBe(beforeOrders);
  });

  it("parks MAPPING_REQUIRED when more than one RESOLVED listing matches the same (aggregator, merchant_ref)", async () => {
    await setProcessingEnabled(true);
    const s = suffix();
    const [location1] = await db.insert(locations).values({ code: `MWP-AMB1-${s}`, name: `MW Amb1 ${s}` }).returning();
    const [location2] = await db.insert(locations).values({ code: `MWP-AMB2-${s}`, name: `MW Amb2 ${s}` }).returning();
    const [brand] = await db.insert(brands).values({ locationId: location1!.id, name: `MW Amb Brand ${s}`, color: "#445566", salesPerfId: `mw-amb-${s}` }).returning();
    const sharedMerchantRef = `FP-AMBIGUOUS-${s}`;
    await db.insert(aggregatorAccounts).values([
      { brandId: brand!.id, locationId: location1!.id, mappingStatus: "RESOLVED", aggregator: "FOODPANDA", externalMerchantId: sharedMerchantRef },
      { brandId: brand!.id, locationId: location2!.id, mappingStatus: "RESOLVED", aggregator: "FOODPANDA", externalMerchantId: sharedMerchantRef },
    ]);

    const eventId = randomUUID();
    const normalized: NormalizedProviderEvent = {
      providerEventId: eventId,
      occurredAt: new Date().toISOString(),
      kind: "ORDER_CREATED",
      aggregator: "FOODPANDA",
      merchantRef: sharedMerchantRef,
      orderPayload: { external_ref: `EXT-${randomUUID()}`, items: [{ menu_item_id: randomUUID(), qty: 1 }] },
    };
    const { event } = await intakeEvent(db, { provider: "DUMMY", normalized, rawHash: "cafebabe".repeat(8), keyId: TEST_KEY_ID });
    const processed = await processEvent(db, event.id);
    expect(processed.state).toBe("MAPPING_REQUIRED");
  });

  it("processes a valid DUMMY event end-to-end into an order snapshotted to the listing's outlet", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const externalRef = `EXT-${randomUUID()}`;
    const { status, body } = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
      items: [{ menu_item_id: fixture.menuItemId, qty: 2 }],
    });
    expect(status).toBe(202);

    // The route's fire-and-forget processing call may or may not have
    // settled yet; force a deterministic pass via the same processor
    // function the reprocess endpoint uses.
    const processed = await processEvent(db, body.event.id, { force: true });
    expect(processed.state).toBe("PROCESSED");
    expect(processed.orderId).not.toBeNull();

    const [order] = await db.select().from(orders).where(eq(orders.id, processed.orderId!));
    expect(order).toBeDefined();
    expect(order!.locationId).toBe(fixture.locationId);
    expect(order!.aggregatorAccountId).toBe(fixture.aggregatorAccountId);
    expect(order!.externalRef).toBe(externalRef);
  });

  it("does not create a second order when the same underlying order is delivered via two different provider_event_ids", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const externalRef = `EXT-${randomUUID()}`;

    const first = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    const firstProcessed = await processEvent(db, first.body.event.id, { force: true });
    expect(firstProcessed.state).toBe("PROCESSED");

    // A different provider_event_id, SAME external_ref/listing — simulates a
    // provider-side redelivery under a new envelope id.
    const second = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    const secondProcessed = await processEvent(db, second.body.event.id, { force: true });
    expect(secondProcessed.state).toBe("PROCESSED");
    expect(secondProcessed.orderId).toBe(firstProcessed.orderId); // same order, not a duplicate

    const matchingOrders = await db.select({ id: orders.id }).from(orders).where(eq(orders.externalRef, externalRef));
    expect(matchingOrders).toHaveLength(1);
  });

  it("exhausts bounded retries and lands on FAILED after MAX_PROCESSING_ATTEMPTS", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    // Pause the menu item so ingestOrder throws a retryable ValidationError
    // every attempt (a legitimate "keeps failing" condition, not a mapping
    // problem — the listing resolves fine).
    // Per-outlet deployment availability overrides the item-level value (orders/service.ts
    // ~530: deployment?.availability ?? menuItem.availability) — pause the deployment row.
    await db.update(menuItemOutlets).set({ availability: "PAUSED" }).where(eq(menuItemOutlets.menuItemId, fixture.menuItemId));

    const { body } = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: `EXT-${randomUUID()}`,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });

    // The unawaited post-intake processEvent (routes.ts) may race in one extra
    // attempt; drive forced attempts until terminal FAILED (bounded loop).
    let last = await processEvent(db, body.event.id, { force: true });
    for (let i = 1; i < MAX_PROCESSING_ATTEMPTS + 1 && last.state !== "FAILED"; i++) {
      last = await processEvent(db, body.event.id, { force: true });
    }
    expect(last.state).toBe("FAILED");
    expect(last.attempts).toBeGreaterThanOrEqual(MAX_PROCESSING_ATTEMPTS);
    expect(last.lastError).toBeTruthy();
    // Bounded-retry invariant: a NON-forced call on a FAILED event is a refusal
    // no-op — attempts must not advance further.
    const afterNonForced = await processEvent(db, body.event.id);
    expect(afterNonForced.state).toBe("FAILED");
    expect(afterNonForced.attempts).toBe(last.attempts);
  });

  it("succeeds via the admin reprocess endpoint once a MAPPING_REQUIRED listing is resolved", async () => {
    await setProcessingEnabled(true);
    const s = suffix();
    const [location] = await db.insert(locations).values({ code: `MWP-MAP-${s}`, name: `MW Map ${s}` }).returning();
    const [brand] = await db.insert(brands).values({ locationId: location!.id, name: `MW Map Brand ${s}`, color: "#778899", salesPerfId: `mw-map-${s}` }).returning();
    const merchantRef = `FP-MAP-${s}`;

    const eventId = randomUUID();
    const externalRef = `EXT-${randomUUID()}`;
    const normalized: NormalizedProviderEvent = {
      providerEventId: eventId,
      occurredAt: new Date().toISOString(),
      kind: "ORDER_CREATED",
      aggregator: "FOODPANDA",
      merchantRef,
      orderPayload: { external_ref: externalRef, items: [{ menu_item_id: randomUUID(), qty: 1 }] },
    };
    const { event } = await intakeEvent(db, { provider: "DUMMY", normalized, rawHash: "abad1dea".repeat(8), keyId: TEST_KEY_ID });
    const firstAttempt = await processEvent(db, event.id);
    expect(firstAttempt.state).toBe("MAPPING_REQUIRED");

    // Ops adds the missing listing mapping...
    const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `MW Map Grill ${s}` }).returning();
    const [item] = await db
      .insert(ingredients)
      .values({ code: `MWP-MAP-ITEM-${s}`, name: `MW Map Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "50", lowStockThreshold: "1" })
      .returning();
    const [menuItem] = await db
      .insert(menuItems)
      .values({ brandId: brand!.id, name: `MW Map Dish ${s}`, price: "150", stationId: station!.id, consumptionMode: "STOCKED_OUTPUT", stockItemId: item!.id })
      .returning();
    await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
    await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
    const [kitchenWh] = await db.insert(warehouses).values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `MWP-MAP-WH-${s}`, name: `MW Map Kitchen ${s}` }).returning();
    await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "500" });
    // Original event's payload referenced a random menu_item_id (never resolved
    // to a real item), so re-intake the SAME external_ref with the real item id
    // to prove reprocess drives a fresh, resolvable payload through.
    await db
      .update(providerEvents)
      .set({ redactedPayload: { external_ref: externalRef, items: [{ menu_item_id: menuItem!.id, qty: 1 }] } })
      .where(eq(providerEvents.id, event.id));
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({ brandId: brand!.id, locationId: location!.id, mappingStatus: "RESOLVED", aggregator: "FOODPANDA", externalMerchantId: merchantRef })
      .returning();

    const owner = await actor("OWNER");
    const res = await request(app)
      .post(`/api/v1/middleware/events/${event.id}/reprocess`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("PROCESSED");
    expect(res.body.order_id).not.toBeNull();

    const [order] = await db.select().from(orders).where(eq(orders.id, res.body.order_id));
    expect(order!.aggregatorAccountId).toBe(account!.id);
  });

  it("parks an ORDER_CANCELLED that arrives before its ORDER_CREATED as WAITING_DEPENDENCY, then auto-resolves once the create processes", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const externalRef = `EXT-${randomUUID()}`;

    const cancelPost = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CANCELLED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
    });
    const cancelProcessed = await processEvent(db, cancelPost.body.event.id, { force: true });
    expect(cancelProcessed.state).toBe("WAITING_DEPENDENCY");

    const createPost = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    const createProcessed = await processEvent(db, createPost.body.event.id, { force: true });
    expect(createProcessed.state).toBe("PROCESSED");

    // The auto-resolution runs synchronously inside processOrderCreated —
    // re-read the cancel event's row to see the resolved state.
    const resolvedCancel = await getEvent(cancelPost.body.event.id);
    expect(resolvedCancel.state).toBe("PROCESSED");

    const [order] = await db.select().from(orders).where(eq(orders.id, createProcessed.orderId!));
    expect(order!.status).toBe("CANCELLED");
  });

  it("treats cancelling an already-CANCELLED order as an idempotent success", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const externalRef = `EXT-${randomUUID()}`;

    const createPost = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: externalRef,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    await processEvent(db, createPost.body.event.id, { force: true });

    const cancel1 = await postWebhook({ event_id: randomUUID(), event_type: "ORDER_CANCELLED", merchant_id: fixture.merchantRef, external_ref: externalRef });
    const cancel1Processed = await processEvent(db, cancel1.body.event.id, { force: true });
    expect(cancel1Processed.state).toBe("PROCESSED");

    const cancel2 = await postWebhook({ event_id: randomUUID(), event_type: "ORDER_CANCELLED", merchant_id: fixture.merchantRef, external_ref: externalRef });
    const cancel2Processed = await processEvent(db, cancel2.body.event.id, { force: true });
    expect(cancel2Processed.state).toBe("PROCESSED"); // idempotent, not an error
  });

  it("GET /middleware/events lists events filtered by state for an authorized admin", async () => {
    await setProcessingEnabled(true);
    const fixture = await orderFixture();
    const { body } = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: `EXT-${randomUUID()}`,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    await processEvent(db, body.event.id, { force: true });

    const owner = await actor("OWNER");
    const res = await request(app)
      .get("/api/v1/middleware/events")
      .query({ state: "PROCESSED" })
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((e: { id: string }) => e.id === body.event.id)).toBe(true);
    expect(res.body.items.every((e: { state: string }) => e.state === "PROCESSED")).toBe(true);
  });

  it("forbids a non-admin role from calling the reprocess endpoint", async () => {
    const fixture = await orderFixture();
    const { body } = await postWebhook({
      event_id: randomUUID(),
      event_type: "ORDER_CREATED",
      merchant_id: fixture.merchantRef,
      external_ref: `EXT-${randomUUID()}`,
      items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
    });
    const kitchen = await actor("KITCHEN_STAFF", fixture.locationId);
    const res = await request(app)
      .post(`/api/v1/middleware/events/${body.event.id}/reprocess`)
      .set("Authorization", `Bearer ${kitchen.token}`);
    expect(res.status).toBe(403);
  });

  it("verifySignature via the DummyProviderAdapter directly matches the shared signature primitive", () => {
    const adapter = new DummyProviderAdapter();
    const rawBytes = Buffer.from(JSON.stringify({ x: 1 }), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBytes, timestamp, TEST_SECRET);
    expect(adapter.verifySignature(rawBytes, { timestamp, keyId: TEST_KEY_ID, signature }, { current: TEST_SECRET })).toBe(true);
    expect(adapter.verifySignature(rawBytes, { timestamp, keyId: TEST_KEY_ID, signature: "f".repeat(64) }, { current: TEST_SECRET })).toBe(false);
  });
});
