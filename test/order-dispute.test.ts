/**
 * Dispute/contest workflow tests (migration 0036 / SITE_VISIT_VIDEO_
 * ANALYSIS.md finding N2 — CLIENT-CONFIRMED FRAUD PATTERN: "Hindi automatic
 * i-refund... kailangan i-contest mo po lagi" — a cancel-after-accept order
 * is never auto-refunded; the merchant must actively contest, 2-4 day
 * turnaround). Covers the CONTEST_CANCELLATION command type, the
 * order_dispute durable record, the only-CANCELLED-orders-contestable
 * guard, RBAC (OWNER/OUTLET_MANAGER only — KITCHEN_CREW refused), the
 * idempotent contest, GET /order-disputes monitoring, and the full
 * OPEN -> RESOLVED_MERCHANT_FAVOR lifecycle via resolveDispute.
 *
 * Fixture shape mirrors test/outbound-commands.test.ts's orderFixture.
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
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
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
import { menuItemOutlets } from "../src/db/enterprise-schema.js";
import { orderDisputes } from "../src/db/outbound-schema.js";
import { ingestOrder, cancelOrder } from "../src/modules/orders/service.js";
import { createDispute, resolveDispute } from "../src/modules/outbound/service.js";
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
  await db.update(operationalFeatureFlags).set({ enabled: true, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, OUTBOUND_COMMANDS_FLAG));
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function actor(role: Role, locationId?: string): Promise<{ userId: string; token: string; name: string }> {
  const s = suffix();
  const name = `Dispute Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `dispute-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token, name };
}

interface Fixture {
  locationId: string;
  brandId: string;
  aggregatorAccountId: string;
  menuItemId: string;
}

async function orderFixture(controlMode: "DEVICE" | "API" = "API"): Promise<Fixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `DSP-LOC-${s}`, name: `DSP Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `DSP Brand ${s}`, color: "#667788", salesPerfId: `dsp-brand-${s}` })
    .returning();
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "GRABFOOD",
      externalMerchantId: `GF-DSP-${s}`,
      controlMode,
    })
    .returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `DSP Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `DSP-ITEM-${s}`, name: `DSP Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "30", lowStockThreshold: "2" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({ brandId: brand!.id, name: `DSP Dish ${s}`, price: "129", stationId: station!.id, consumptionMode: "STOCKED_OUTPUT", stockItemId: item!.id })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
  const [kitchenWh] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `DSP-WH-${s}`, name: `DSP Kitchen ${s}` })
    .returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "100" });

  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id, menuItemId: menuItem!.id };
}

async function createOrder(fixture: Fixture): Promise<string> {
  const result = await ingestOrder(db, {
    brand_id: fixture.brandId,
    aggregator_account_id: fixture.aggregatorAccountId,
    aggregator: "GRABFOOD",
    external_ref: `DSP-EXT-${randomUUID()}`,
    items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
  });
  return result.order_id;
}

async function createCancelledOrder(fixture: Fixture): Promise<string> {
  const orderId = await createOrder(fixture);
  await cancelOrder(db, orderId, "Rider no-show — suspected fraud pattern.");
  return orderId;
}

describe("createDispute — service-level guards", () => {
  it("refuses to contest a NEW (not-yet-cancelled) order", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      createDispute(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        disputeReason: "SUSPECTED_FRAUD",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses an unknown order_id", async () => {
    const fixture = await orderFixture();
    await expect(
      createDispute(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId: randomUUID(),
        disputeReason: "SUSPECTED_FRAUD",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("refuses an order that belongs to a different listing", async () => {
    const fixtureA = await orderFixture();
    const orderId = await createCancelledOrder(fixtureA);
    const fixtureB = await orderFixture();
    await expect(
      createDispute(db, {
        aggregatorAccountId: fixtureB.aggregatorAccountId,
        orderId,
        disputeReason: "SUSPECTED_FRAUD",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses an invalid dispute_reason", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    await expect(
      createDispute(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        // @ts-expect-error — deliberately invalid for the runtime check
        disputeReason: "NOT_A_REASON",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("creates an OPEN dispute for a CANCELLED order, linked to a CONTEST_CANCELLATION command", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const dispute = await createDispute(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      disputeReason: "RIDER_NO_SHOW",
      evidenceNote: "Rider marked delivered but customer never received it.",
      idempotencyKey: randomUUID(),
      actorUserId: owner.userId,
      actorName: owner.name,
    });

    expect(dispute.status).toBe("OPEN");
    expect(dispute.orderId).toBe(orderId);
    expect(dispute.reason).toBe("RIDER_NO_SHOW");
    expect(dispute.aggregatorCommandId).toBeTruthy();
    expect(dispute.evidenceNote).toBe("Rider marked delivered but customer never received it.");

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, dispute.id));
    expect(audit?.action).toBe("order_dispute.raised");
    expect(audit?.actorUserId).toBe(owner.userId);
  });

  it("is idempotent: a second contest call for the SAME order returns the SAME dispute row", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);

    const first = await createDispute(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      disputeReason: "SUSPECTED_FRAUD",
      idempotencyKey: randomUUID(),
    });
    const second = await createDispute(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      disputeReason: "ALREADY_PREPARED", // even a different reason on replay — still the same order
      idempotencyKey: randomUUID(),
    });

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("SUSPECTED_FRAUD"); // unchanged from the original raise

    const rows = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it("two concurrent first-time contests for the same order settle to exactly ONE dispute row", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);

    const [a, b] = await Promise.allSettled([
      createDispute(db, { aggregatorAccountId: fixture.aggregatorAccountId, orderId, disputeReason: "SUSPECTED_FRAUD", idempotencyKey: randomUUID() }),
      createDispute(db, { aggregatorAccountId: fixture.aggregatorAccountId, orderId, disputeReason: "SUSPECTED_FRAUD", idempotencyKey: randomUUID() }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const idA = a.status === "fulfilled" ? a.value.id : null;
    const idB = b.status === "fulfilled" ? b.value.id : null;
    expect(idA).toBe(idB);

    const rows = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it("respects the CONTROL_MODE gate: a DEVICE-mode listing's cancelled order cannot be contested (enqueueCommand's own gate — API mode only)", async () => {
    const fixture = await orderFixture("DEVICE");
    const orderId = await createCancelledOrder(fixture);
    await expect(
      createDispute(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        disputeReason: "SUSPECTED_FRAUD",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONTROL_MODE", status: 409 });
  });
});

describe("resolveDispute — lifecycle", () => {
  it("moves OPEN -> CONTESTED -> RESOLVED_MERCHANT_FAVOR, stamping resolved_at only on the terminal transition", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const dispute = await createDispute(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      disputeReason: "SUSPECTED_FRAUD",
      idempotencyKey: randomUUID(),
    });
    expect(dispute.resolvedAt).toBeNull();

    const contested = await resolveDispute(db, { disputeId: dispute.id, status: "CONTESTED" });
    expect(contested.status).toBe("CONTESTED");
    expect(contested.resolvedAt).toBeNull();

    const resolved = await resolveDispute(db, {
      disputeId: dispute.id,
      status: "RESOLVED_MERCHANT_FAVOR",
      resolutionNote: "Grab confirmed the rider cancellation was unwarranted; payout released.",
    });
    expect(resolved.status).toBe("RESOLVED_MERCHANT_FAVOR");
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolutionNote).toContain("payout released");
  });

  it("404s an unknown dispute id", async () => {
    await expect(resolveDispute(db, { disputeId: randomUUID(), status: "EXPIRED" })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("POST /channel-listings/:id/orders/:orderId/contest-cancellation — RBAC + HTTP", () => {
  it("requires a bounded Idempotency-Key header", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    expect(res.status).toBe(400);
  });

  it("OWNER can raise a contest and gets a credential-leak-free response shape", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD", evidence_note: "Order already prepared and receipt printed." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ order_id: orderId, reason: "SUSPECTED_FRAUD", status: "OPEN" });
    expect(res.body.aggregator_command_id).toBeTruthy();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/credential/i);
  });

  it("OUTLET_MANAGER (assigned to the listing's outlet) can raise a contest", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const manager = await actor("OUTLET_MANAGER", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "ALREADY_PREPARED" });
    expect(res.status).toBe(201);
  });

  it("KITCHEN_CREW is forbidden (business-risk action, not a kitchen action)", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    expect(res.status).toBe(403);
  });

  it("an OUTLET_MANAGER assigned to a DIFFERENT outlet is forbidden", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const other = await db.insert(locations).values({ code: `DSP-OTHER-${suffix()}`, name: "Other Outlet" }).returning();
    const manager = await actor("OUTLET_MANAGER", other[0]!.id);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    expect(res.status).toBe(403);
  });

  it("400s a NEW (non-cancelled) order", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    expect(res.status).toBe(400);
  });

  it("400s an invalid dispute_reason", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "NOT_A_REASON" });
    expect(res.status).toBe(400);
  });

  it("a repeat HTTP call returns the SAME dispute (idempotent contest end-to-end)", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const first = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    const second = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/orders/${orderId}/contest-cancellation`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ dispute_reason: "SUSPECTED_FRAUD" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it("CONTEST_CANCELLATION is refused on the generic /commands route (must use the dedicated endpoint)", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "CONTEST_CANCELLATION", order_id: orderId, payload: { dispute_reason: "SUSPECTED_FRAUD" } });
    expect(res.status).toBe(400);

    const rows = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId));
    expect(rows).toHaveLength(0);
  });
});

describe("GET /order-disputes — monitoring", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/v1/order-disputes");
    expect(res.status).toBe(401);
  });

  it("filters by listing_id and status", async () => {
    const fixture = await orderFixture();
    const orderId = await createCancelledOrder(fixture);
    const owner = await actor("OWNER");
    await createDispute(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      disputeReason: "SUSPECTED_FRAUD",
      idempotencyKey: randomUUID(),
      actorUserId: owner.userId,
    });

    const res = await request(app)
      .get("/api/v1/order-disputes")
      .query({ listing_id: fixture.aggregatorAccountId, status: "OPEN" })
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((d: { order_id: string; status: string }) => d.status === "OPEN")).toBe(true);
    expect(res.body.items.some((d: { order_id: string }) => d.order_id === orderId)).toBe(true);
  });

  it("scopes an ASSIGNED caller to their own outlet when listing_id is omitted", async () => {
    const mine = await orderFixture();
    const other = await orderFixture();
    const mineOrder = await createCancelledOrder(mine);
    const otherOrder = await createCancelledOrder(other);
    await createDispute(db, { aggregatorAccountId: mine.aggregatorAccountId, orderId: mineOrder, disputeReason: "SUSPECTED_FRAUD", idempotencyKey: randomUUID() });
    await createDispute(db, { aggregatorAccountId: other.aggregatorAccountId, orderId: otherOrder, disputeReason: "SUSPECTED_FRAUD", idempotencyKey: randomUUID() });

    const manager = await actor("OUTLET_MANAGER", mine.locationId);
    const res = await request(app).get("/api/v1/order-disputes").set("Authorization", `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    const orderIds = res.body.items.map((d: { order_id: string }) => d.order_id);
    expect(orderIds).toContain(mineOrder);
    expect(orderIds).not.toContain(otherOrder);
  });

  it("KITCHEN_CREW is forbidden from the monitoring endpoint", async () => {
    const fixture = await orderFixture();
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);
    const res = await request(app).get("/api/v1/order-disputes").set("Authorization", `Bearer ${crew.token}`);
    expect(res.status).toBe(403);
  });
});
