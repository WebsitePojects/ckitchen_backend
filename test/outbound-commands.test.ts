/**
 * Outbound aggregator command tests (AGGREGATOR_API_INTEGRATION_SPEC.md
 * §4-5): enqueue validation (listing existence, control_mode gates,
 * order-scope validation), idempotency dedupe, the out-of-order guard
 * (ACCEPT/MARK_READY refused after REJECT), the HTTP surface (generic
 * commands + pause/resume/availability sugar + control-mode PATCH +
 * monitoring GET) with RBAC + outlet scoping, the worker's race-safe
 * claim-lease loop + bounded retries -> DEAD, and the order-lifecycle hooks
 * wired into orders/service.ts advanceOrder.
 *
 * Fixture shape (location/brand/station/menu item/recipe line/
 * menuItemOutlets/KITCHEN warehouse+stock) mirrors test/
 * middleware-processing.test.ts's proven orderFixture, since advanceOrder's
 * PREPARING transition unconditionally requires a KITCHEN warehouse to
 * exist for the order's outlet.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";
import { menuItemOutlets, operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  aggregatorAccounts,
  auditLogs,
  brands,
  ingredients,
  inventoryStock,
  kitchenStations,
  locations,
  menuItems,
  recipeLines,
  userOutletAccess,
  users,
  warehouses,
  type Role,
} from "../src/db/schema.js";
import { aggregatorCommands, type AggregatorCommand } from "../src/db/outbound-schema.js";
import { ingestOrder, advanceOrder } from "../src/modules/orders/service.js";
import { enqueueCommand } from "../src/modules/outbound/service.js";
import { processCommands } from "../src/modules/outbound/worker.js";
import { DummyOutboundAdapter } from "../src/modules/outbound/adapter.js";
import { OUTBOUND_COMMANDS_FLAG } from "../src/modules/outbound/policies.js";

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

async function setOutboundEnabled(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, OUTBOUND_COMMANDS_FLAG));
}

async function actor(role: Role, locationId?: string): Promise<{ userId: string; token: string; name: string }> {
  const s = suffix();
  const name = `OB Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `ob-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token, name };
}

interface ListingFixture {
  locationId: string;
  brandId: string;
  aggregatorAccountId: string;
}

/** Bare channel listing (no order) — enough for pause/resume/availability/control-mode tests. */
async function listingFixture(controlMode: "DEVICE" | "SHADOW" | "API" = "API"): Promise<ListingFixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `OB-LOC-${s}`, name: `OB Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `OB Brand ${s}`, color: "#334455", salesPerfId: `ob-brand-${s}` })
    .returning();
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "FOODPANDA",
      externalMerchantId: `FP-OB-${s}`,
      controlMode,
    })
    .returning();
  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id };
}

interface OrderFixture extends ListingFixture {
  menuItemId: string;
}

/** Full ingestOrder-ready fixture (mirrors middleware-processing.test.ts's orderFixture). */
async function orderFixture(controlMode: "DEVICE" | "SHADOW" | "API" = "API"): Promise<OrderFixture> {
  const s = suffix();
  const listing = await listingFixture(controlMode);
  const [station] = await db.insert(kitchenStations).values({ locationId: listing.locationId, name: `OB Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `OB-ITEM-${s}`, name: `OB Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "100", lowStockThreshold: "5" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId: listing.brandId,
      name: `OB Dish ${s}`,
      price: "199",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: item!.id,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: listing.locationId, stationId: station!.id });
  const [kitchenWh] = await db
    .insert(warehouses)
    .values({ locationId: listing.locationId, type: "KITCHEN", purpose: "KITCHEN", code: `OB-WH-${s}`, name: `OB Kitchen ${s}` })
    .returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "1000" });

  return { ...listing, menuItemId: menuItem!.id };
}

async function createOrder(fixture: OrderFixture): Promise<string> {
  const result = await ingestOrder(db, {
    brand_id: fixture.brandId,
    aggregator_account_id: fixture.aggregatorAccountId,
    aggregator: "FOODPANDA",
    external_ref: `EXT-${randomUUID()}`,
    items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
  });
  return result.order_id;
}

async function commandsForOrder(orderId: string): Promise<AggregatorCommand[]> {
  return db.select().from(aggregatorCommands).where(eq(aggregatorCommands.orderId, orderId));
}

// ---------------------------------------------------------------------------
// enqueueCommand — control-mode gates, validation, NOT_FOUND
// ---------------------------------------------------------------------------

describe("outbound commands — enqueueCommand gates", () => {
  it("refuses with FEATURE_DISABLED while integration.outbound_commands is OFF", async () => {
    await setOutboundEnabled(false);
    const listing = await listingFixture("API");
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: listing.aggregatorAccountId,
        commandType: "PAUSE_STORE",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
  });

  it("returns NOT_FOUND for an unknown channel listing", async () => {
    await setOutboundEnabled(true);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: randomUUID(),
        commandType: "PAUSE_STORE",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("refuses with CONTROL_MODE when the listing is DEVICE mode", async () => {
    await setOutboundEnabled(true);
    const listing = await listingFixture("DEVICE");
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: listing.aggregatorAccountId,
        commandType: "PAUSE_STORE",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_MODE", status: 409 });
  });

  it("refuses ACCEPT_ORDER for a SHADOW listing but allows NOTIFY_MENU_UPDATED", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("SHADOW");
    const orderId = await createOrder(fixture);

    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "ACCEPT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_MODE", status: 409 });

    const notify = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "NOTIFY_MENU_UPDATED",
      payload: {},
      idempotencyKey: randomUUID(),
    });
    expect(notify.status).toBe("PENDING");
    expect(notify.commandType).toBe("NOTIFY_MENU_UPDATED");
  });

  it("VALIDATION when an order-scoped command_type omits order_id", async () => {
    await setOutboundEnabled(true);
    const listing = await listingFixture("API");
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: listing.aggregatorAccountId,
        commandType: "ACCEPT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("VALIDATION when a listing-scoped command_type includes order_id", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "PAUSE_STORE",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("NOT_FOUND when order_id does not exist", async () => {
    await setOutboundEnabled(true);
    const listing = await listingFixture("API");
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: listing.aggregatorAccountId,
        orderId: randomUUID(),
        commandType: "ACCEPT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("VALIDATION when the order belongs to a different listing", async () => {
    await setOutboundEnabled(true);
    const fixtureA = await orderFixture("API");
    const orderIdA = await createOrder(fixtureA);
    const fixtureB = await listingFixture("API");
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixtureB.aggregatorAccountId,
        orderId: orderIdA,
        commandType: "ACCEPT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("enqueues successfully when control_mode=API and audits the actor", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
      actorUserId: owner.userId,
      actorName: owner.name,
    });
    expect(command.status).toBe("PENDING");
    expect(command.attempts).toBe(0);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, command.id));
    expect(audit?.action).toBe("aggregator_command.enqueued");
    expect(audit?.actorUserId).toBe(owner.userId);
  });
});

// ---------------------------------------------------------------------------
// Idempotency dedupe
// ---------------------------------------------------------------------------

describe("outbound commands — idempotency dedupe", () => {
  it("a replayed idempotency_key returns the SAME row instead of creating a duplicate", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const key = randomUUID();

    const first = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: key,
    });
    const second = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: key,
    });
    expect(second.id).toBe(first.id);

    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(1);
  });

  it("two concurrent enqueues racing the SAME idempotency_key settle to exactly ONE row (FIX C style race)", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const key = `race-${randomUUID()}`;

    const [a, b] = await Promise.allSettled([
      enqueueCommand(db, { aggregatorAccountId: fixture.aggregatorAccountId, orderId, commandType: "ACCEPT_ORDER", payload: {}, idempotencyKey: key }),
      enqueueCommand(db, { aggregatorAccountId: fixture.aggregatorAccountId, orderId, commandType: "ACCEPT_ORDER", payload: {}, idempotencyKey: key }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const idA = a.status === "fulfilled" ? a.value.id : null;
    const idB = b.status === "fulfilled" ? b.value.id : null;
    expect(idA).toBe(idB);

    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(1);
  });

  it("a different idempotency_key for the same (listing, order, command_type) is refused as OUT_OF_ORDER only when it's a genuinely new ACCEPT after REJECT — otherwise it enqueues a distinct row", async () => {
    // MARK_READY may legitimately be attempted more than once with different
    // keys pre-REJECT (e.g. a retry with a fresh client key) — confirms the
    // dedupe is scoped to the EXACT key, not just (listing, order, type).
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    await advanceOrder(db, orderId); // NEW -> PREPARING (hook OFF by default here; flag was already ON above, but listing API — allow it to enqueue its own AUTO row too, harmless)

    const first = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "UPDATE_READY_TIME",
      payload: { ready_time: "2026-07-18T12:00:00Z" },
      idempotencyKey: "k1",
    });
    const second = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "UPDATE_READY_TIME",
      payload: { ready_time: "2026-07-18T12:05:00Z" },
      idempotencyKey: "k2",
    });
    expect(second.id).not.toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Out-of-order guard
// ---------------------------------------------------------------------------

describe("outbound commands — out-of-order guard", () => {
  it("refuses ACCEPT_ORDER after REJECT_ORDER for the same order", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: "OUT_OF_STOCK" },
      idempotencyKey: randomUUID(),
    });

    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "ACCEPT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OUT_OF_ORDER", status: 409 });
  });

  it("refuses MARK_READY after REJECT_ORDER for the same order", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: "TOO_BUSY" },
      idempotencyKey: randomUUID(),
    });

    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "MARK_READY",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OUT_OF_ORDER", status: 409 });
  });

  it("REJECT_ORDER after ACCEPT_ORDER is NOT blocked (the guard is one-directional)", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });
    const reject = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: "CUSTOMER_REQUEST" },
      idempotencyKey: randomUUID(),
    });
    expect(reject.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe("outbound commands — HTTP routes", () => {
  it("POST /channel-listings/:id/commands requires a bounded Idempotency-Key header", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ command_type: "ACCEPT_ORDER", order_id: orderId });
    expect(res.status).toBe(400);
  });

  it("POST /channel-listings/:id/commands succeeds for OWNER with a valid Idempotency-Key", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "ACCEPT_ORDER", order_id: orderId });
    expect(res.status).toBe(201);
    expect(res.body.command_type).toBe("ACCEPT_ORDER");
    expect(res.body.status).toBe("PENDING");
  });

  it("KITCHEN_CREW may send ACCEPT_ORDER via the generic route but not SET_ITEM_AVAILABILITY", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);

    const acceptRes = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "ACCEPT_ORDER", order_id: orderId });
    expect(acceptRes.status).toBe(201);

    const availabilityRes = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "SET_ITEM_AVAILABILITY", payload: { item_id: "x", available: false } });
    expect(availabilityRes.status).toBe(403);
  });

  it("KITCHEN_CREW is forbidden from POST /channel-listings/:id/pause (role-gated)", async () => {
    await setOutboundEnabled(true);
    const fixture = await listingFixture("API");
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/pause`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ reason: "closing early" });
    expect(res.status).toBe(403);
  });

  it("OWNER can pause and resume a listing", async () => {
    await setOutboundEnabled(true);
    const fixture = await listingFixture("API");
    const owner = await actor("OWNER");

    const pauseRes = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/pause`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ reason: "closing early" });
    expect(pauseRes.status).toBe(201);
    expect(pauseRes.body.command_type).toBe("PAUSE_STORE");
    expect(pauseRes.body.payload).toEqual({ reason: "closing early" });

    const resumeRes = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/resume`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({});
    expect(resumeRes.status).toBe(201);
    expect(resumeRes.body.command_type).toBe("RESUME_STORE");
  });

  it("OUTLET_MANAGER can toggle item availability", async () => {
    await setOutboundEnabled(true);
    const fixture = await listingFixture("API");
    const manager = await actor("OUTLET_MANAGER", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/items/menu-item-123/availability`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ available: false, reason: "sold out" });
    expect(res.status).toBe(201);
    expect(res.body.payload).toMatchObject({ item_id: "menu-item-123", available: false, reason: "sold out" });
  });

  it("outlet scoping: an OUTLET_MANAGER assigned to a DIFFERENT outlet is forbidden", async () => {
    await setOutboundEnabled(true);
    const fixture = await listingFixture("API");
    const otherLocation = await db.insert(locations).values({ code: `OB-OTHER-${suffix()}`, name: "Other Outlet" }).returning();
    const manager = await actor("OUTLET_MANAGER", otherLocation[0]!.id);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/pause`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({});
    expect(res.status).toBe(403);
  });

  it("PATCH /channel-listings/:id/control-mode is OWNER-only and audited", async () => {
    const fixture = await listingFixture("DEVICE");
    const manager = await actor("OUTLET_MANAGER", fixture.locationId);
    const forbidden = await request(app)
      .patch(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/control-mode`)
      .set("Authorization", `Bearer ${manager.token}`)
      .send({ control_mode: "API" });
    expect(forbidden.status).toBe(403);

    const owner = await actor("OWNER");
    const res = await request(app)
      .patch(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/control-mode`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ control_mode: "API" });
    expect(res.status).toBe(200);
    expect(res.body.control_mode).toBe("API");

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, fixture.aggregatorAccountId));
    expect(audit?.action).toBe("aggregator_account.control_mode_changed");
  });

  it("GET /outbound-commands filters by listing_id and status", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });

    const owner = await actor("OWNER");
    const res = await request(app)
      .get("/api/v1/outbound-commands")
      .query({ listing_id: fixture.aggregatorAccountId, status: "PENDING" })
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((c: { aggregator_account_id: string; status: string }) => c.aggregator_account_id === fixture.aggregatorAccountId && c.status === "PENDING")).toBe(true);
  });

  it("GET /outbound-commands scopes an ASSIGNED caller to their own outlet when listing_id is omitted", async () => {
    await setOutboundEnabled(true);
    const mine = await orderFixture("API");
    const other = await orderFixture("API");
    const mineOrder = await createOrder(mine);
    const otherOrder = await createOrder(other);
    await enqueueCommand(db, { aggregatorAccountId: mine.aggregatorAccountId, orderId: mineOrder, commandType: "ACCEPT_ORDER", payload: {}, idempotencyKey: randomUUID() });
    await enqueueCommand(db, { aggregatorAccountId: other.aggregatorAccountId, orderId: otherOrder, commandType: "ACCEPT_ORDER", payload: {}, idempotencyKey: randomUUID() });

    const manager = await actor("OUTLET_MANAGER", mine.locationId);
    const res = await request(app).get("/api/v1/outbound-commands").set("Authorization", `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { aggregator_account_id: string }) => c.aggregator_account_id);
    expect(ids).toContain(mine.aggregatorAccountId);
    expect(ids).not.toContain(other.aggregatorAccountId);
  });
});

// ---------------------------------------------------------------------------
// Worker — claim-lease race safety, bounded retries -> DEAD, end-to-end SENT
// ---------------------------------------------------------------------------

describe("outbound commands — worker (claim, retry, dead, sent)", () => {
  // Earlier describe blocks (enqueue gates, dedupe, out-of-order, HTTP
  // routes) leave PENDING aggregator_command rows in the SAME shared db —
  // processCommands claims the globally OLDEST eligible rows first, so
  // without draining them a small `limit` here could claim only unrelated
  // leftovers and never reach this block's own freshly-created command.
  // Drain once up front so each test below starts from a clean claimable
  // pool; later describe blocks (order-lifecycle hooks) query by orderId,
  // not global count, so they are unaffected either way.
  beforeAll(async () => {
    await setOutboundEnabled(true);
    const flusher = new DummyOutboundAdapter();
    for (let i = 0; i < 20; i++) {
      const result = await processCommands(db, flusher, { limit: 50 });
      if (result.claimed === 0) break;
    }
  });

  it("claims and sends a PENDING command end-to-end to SENT via the dummy adapter", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });

    const adapter = new DummyOutboundAdapter();
    const result = await processCommands(db, adapter, { limit: 50 });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, command.id));
    expect(row!.status).toBe("SENT");
    expect(row!.providerRef).toBeTruthy();
    expect(adapter.calls.some((c) => c.commandId === command.id)).toBe(true);
  });

  it("two concurrent processCommands() calls never both send the SAME command (race-safe claim)", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "MARK_READY",
      payload: {},
      idempotencyKey: randomUUID(),
    });

    const adapterA = new DummyOutboundAdapter();
    const adapterB = new DummyOutboundAdapter();
    const [resA, resB] = await Promise.allSettled([
      processCommands(db, adapterA, { limit: 50, leaseOwner: "worker-A" }),
      processCommands(db, adapterB, { limit: 50, leaseOwner: "worker-B" }),
    ]);
    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("fulfilled");

    // Exactly one of the two adapters ever saw this command — the claim
    // conditional-UPDATE guarantees no double-send, matching printing v2's
    // proven claimJobs race protocol.
    const sawA = adapterA.calls.some((c) => c.commandId === command.id);
    const sawB = adapterB.calls.some((c) => c.commandId === command.id);
    expect(sawA !== sawB).toBe(true);

    const [row] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, command.id));
    expect(row!.status).toBe("SENT");
  });

  it("exhausts bounded retries (3) and lands on DEAD, never re-processed further", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });

    const adapter = new DummyOutboundAdapter({ forcedResult: { ok: false, kind: "RETRYABLE", message: "simulated network failure" } });

    let last: { status: string } = { status: "" };
    for (let i = 0; i < 5; i++) {
      // next_attempt_at backoff would normally gate real-time re-claims; force
      // eligibility deterministically by clearing it between forced attempts
      // (unit-testing the bounded-retry OUTCOME, not the wall-clock backoff).
      await db.update(aggregatorCommands).set({ nextAttemptAt: null }).where(eq(aggregatorCommands.id, command.id));
      await processCommands(db, adapter, { limit: 50 });
      const [row] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, command.id));
      last = row!;
      if (last.status === "DEAD") break;
    }

    expect(last.status).toBe("DEAD");
    const [final] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, command.id));
    expect(final!.attempts).toBe(3);
    expect(final!.lastError).toBeTruthy();
    expect(adapter.calls.filter((c) => c.commandId === command.id)).toHaveLength(3);

    // A further pass never touches a DEAD row again.
    await processCommands(db, adapter, { limit: 50 });
    expect(adapter.calls.filter((c) => c.commandId === command.id)).toHaveLength(3);
  });

  it("a TERMINAL failure DEAD-ends on the FIRST attempt (never retried)", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });

    const adapter = new DummyOutboundAdapter({ forcedResult: { ok: false, kind: "TERMINAL", message: "listing rejected by partner" } });
    await processCommands(db, adapter, { limit: 50 });

    const [row] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, command.id));
    expect(row!.status).toBe("DEAD");
    expect(row!.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Order-lifecycle hooks (orders/service.ts advanceOrder)
// ---------------------------------------------------------------------------

describe("outbound commands — order-lifecycle hooks", () => {
  it("no aggregator_command row is created while integration.outbound_commands is OFF, even for an API-mode listing", async () => {
    await setOutboundEnabled(false);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await advanceOrder(db, orderId); // NEW -> PREPARING
    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(0);
  });

  it("no aggregator_command row is created for a DEVICE-mode listing, even with the flag ON", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("DEVICE");
    const orderId = await createOrder(fixture);

    await advanceOrder(db, orderId); // NEW -> PREPARING
    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(0);
  });

  it("flag ON + API mode: NEW->PREPARING enqueues exactly one PENDING ACCEPT_ORDER", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await advanceOrder(db, orderId); // NEW -> PREPARING
    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commandType).toBe("ACCEPT_ORDER");
    expect(rows[0]!.status).toBe("PENDING");
  });

  it("flag ON + API mode: PREPARING->READY additionally enqueues exactly one MARK_READY", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);

    await advanceOrder(db, orderId); // NEW -> PREPARING
    await advanceOrder(db, orderId); // PREPARING -> READY

    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.commandType).sort();
    expect(types).toEqual(["ACCEPT_ORDER", "MARK_READY"]);
  });

  it("the hook is idempotent per stage: re-deriving the same AUTO key never double-enqueues", async () => {
    await setOutboundEnabled(true);
    const fixture = await orderFixture("API");
    const orderId = await createOrder(fixture);
    await advanceOrder(db, orderId); // NEW -> PREPARING

    // A second manual enqueue attempt using the SAME derivation the hook uses
    // (AUTO key) is an idempotent replay, not a second row — proving the
    // hook's safety net holds even if it were ever invoked twice.
    const replay = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: "AUTO",
    });
    const rows = await commandsForOrder(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(replay.id);
  });
});
