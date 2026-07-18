/**
 * Accept-deadline SLA tests (migration 0036 / SITE_VISIT_VIDEO_ANALYSIS.md
 * finding B — the single highest-ranked gap: "Accept your order within 5
 * minutes — orders that are ignored will expire and your store will be
 * paused"). Covers: order.accept_deadline_at populated only for
 * control_mode=API listings, the 300s (5 min) fallback, the per-listing
 * aggregator_account.accept_sla_seconds override, and both fields exposed
 * additively in GET /channel-listings and the order-list/detail responses.
 *
 * Fixture shape mirrors test/outbound-commands.test.ts's proven
 * orderFixture (KITCHEN warehouse + stock so advanceOrder's PREPARING
 * transition — exercised in one test — never throws).
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
import { menuItemOutlets } from "../src/db/enterprise-schema.js";
import { ingestOrder, advanceOrder, type IngestOrderInput } from "../src/modules/orders/service.js";

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

async function actor(role: Role, locationId?: string): Promise<{ userId: string; token: string; name: string }> {
  const s = suffix();
  const name = `SLA Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `sla-actor-${s}@test.local`, passwordHash: "hash", role })
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

/** Full ingestOrder-ready fixture, parameterized by control_mode + optional accept_sla_seconds override. */
async function orderFixture(controlMode: "DEVICE" | "SHADOW" | "API", acceptSlaSeconds?: number | null): Promise<Fixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `SLA-LOC-${s}`, name: `SLA Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `SLA Brand ${s}`, color: "#112233", salesPerfId: `sla-brand-${s}` })
    .returning();
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "GRABFOOD",
      externalMerchantId: `GF-SLA-${s}`,
      controlMode,
      ...(acceptSlaSeconds !== undefined ? { acceptSlaSeconds } : {}),
    })
    .returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `SLA Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `SLA-ITEM-${s}`, name: `SLA Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "50", lowStockThreshold: "2" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId: brand!.id,
      name: `SLA Dish ${s}`,
      price: "149",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: item!.id,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
  const [kitchenWh] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `SLA-WH-${s}`, name: `SLA Kitchen ${s}` })
    .returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "100" });

  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id, menuItemId: menuItem!.id };
}

function ingestInput(fixture: Fixture): IngestOrderInput {
  return {
    brand_id: fixture.brandId,
    aggregator_account_id: fixture.aggregatorAccountId,
    aggregator: "GRABFOOD",
    external_ref: `SLA-EXT-${randomUUID()}`,
    items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
  };
}

describe("accept-deadline SLA — ingestOrder", () => {
  it("populates accept_deadline_at with the 300s (5 min) default for an API-mode listing", async () => {
    const fixture = await orderFixture("API");
    const before = Date.now();
    const result = await ingestOrder(db, ingestInput(fixture));
    const after = Date.now();

    expect(result.accept_deadline_at).toBeTruthy();
    const deadlineMs = new Date(result.accept_deadline_at!).getTime();
    // placed_at defaults to "now" inside ingestOrder — bound the expected
    // deadline between (before + 300s) and (after + 300s).
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    expect(deadlineMs).toBeLessThanOrEqual(after + 300_000 + 1000);
  });

  it("leaves accept_deadline_at null for a DEVICE-mode listing", async () => {
    const fixture = await orderFixture("DEVICE");
    const result = await ingestOrder(db, ingestInput(fixture));
    expect(result.accept_deadline_at).toBeNull();

    const [row] = await db.select().from(orders).where(eq(orders.id, result.order_id));
    expect(row!.acceptDeadlineAt).toBeNull();
  });

  it("leaves accept_deadline_at null for a SHADOW-mode listing", async () => {
    const fixture = await orderFixture("SHADOW");
    const result = await ingestOrder(db, ingestInput(fixture));
    expect(result.accept_deadline_at).toBeNull();
  });

  it("respects a per-listing accept_sla_seconds override", async () => {
    const fixture = await orderFixture("API", 120);
    const before = Date.now();
    const result = await ingestOrder(db, ingestInput(fixture));
    const after = Date.now();

    const deadlineMs = new Date(result.accept_deadline_at!).getTime();
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 120_000 - 1000);
    expect(deadlineMs).toBeLessThanOrEqual(after + 120_000 + 1000);
  });

  it("an override of 0 seconds produces a deadline equal to placed_at (immediate)", async () => {
    const fixture = await orderFixture("API", 0);
    const placedAt = "2026-07-18T10:00:00.000Z";
    const result = await ingestOrder(db, { ...ingestInput(fixture), placed_at: placedAt });
    expect(result.accept_deadline_at).toBe(placedAt);
  });

  it("a large override (e.g. 3600s) is honored verbatim", async () => {
    const fixture = await orderFixture("API", 3600);
    const placedAt = "2026-07-18T10:00:00.000Z";
    const result = await ingestOrder(db, { ...ingestInput(fixture), placed_at: placedAt });
    expect(result.accept_deadline_at).toBe("2026-07-18T11:00:00.000Z");
  });

  it("uses the exact placed_at + 300s math when placed_at is explicit and no override is set", async () => {
    const fixture = await orderFixture("API");
    const placedAt = "2026-07-18T09:00:00.000Z";
    const result = await ingestOrder(db, { ...ingestInput(fixture), placed_at: placedAt });
    expect(result.accept_deadline_at).toBe("2026-07-18T09:05:00.000Z");
  });

  it("a DUPLICATE_ORDER replay echoes the SAME accept_deadline_at, not a freshly computed one", async () => {
    const fixture = await orderFixture("API");
    const input = { ...ingestInput(fixture), placed_at: "2026-07-18T09:00:00.000Z" };
    const first = await ingestOrder(db, input);
    const second = await ingestOrder(db, input);
    expect(second.code).toBe("DUPLICATE_ORDER");
    expect(second.accept_deadline_at).toBe(first.accept_deadline_at);
  });

  it("advancing the order to PREPARING does not clear or change accept_deadline_at", async () => {
    const fixture = await orderFixture("API");
    const result = await ingestOrder(db, ingestInput(fixture));
    await advanceOrder(db, result.order_id);
    const [row] = await db.select().from(orders).where(eq(orders.id, result.order_id));
    expect(row!.acceptDeadlineAt?.toISOString()).toBe(result.accept_deadline_at);
  });
});

describe("accept-deadline SLA — HTTP exposure", () => {
  it("GET /orders/:id exposes accept_deadline_at for an API-mode listing's order", async () => {
    const fixture = await orderFixture("API");
    const result = await ingestOrder(db, ingestInput(fixture));
    const owner = await actor("OWNER");

    const res = await request(app).get(`/api/v1/orders/${result.order_id}`).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.acceptDeadlineAt).toBeTruthy();
    expect(new Date(res.body.acceptDeadlineAt).toISOString()).toBe(result.accept_deadline_at);
  });

  it("GET /orders (summary list) exposes accept_deadline_at without breaking the existing shape", async () => {
    const fixture = await orderFixture("API");
    const result = await ingestOrder(db, ingestInput(fixture));
    const owner = await actor("OWNER");

    const res = await request(app).get("/api/v1/orders").query({ brand_id: fixture.brandId }).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const found = res.body.find((o: { id: string }) => o.id === result.order_id);
    expect(found).toBeTruthy();
    expect(found.acceptDeadlineAt).toBeTruthy();
    // Pre-existing fields untouched.
    expect(found.status).toBe("NEW");
    expect(found.aggregatorAccountId).toBe(fixture.aggregatorAccountId);
  });

  it("GET /orders?detail=1 also carries accept_deadline_at alongside items[]/print_jobs[]", async () => {
    const fixture = await orderFixture("API");
    const result = await ingestOrder(db, ingestInput(fixture));
    const owner = await actor("OWNER");

    const res = await request(app)
      .get("/api/v1/orders")
      .query({ brand_id: fixture.brandId, detail: 1 })
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const found = res.body.find((o: { id: string }) => o.id === result.order_id);
    expect(found.acceptDeadlineAt).toBeTruthy();
    expect(Array.isArray(found.items)).toBe(true);
    expect(Array.isArray(found.print_jobs)).toBe(true);
  });

  it("GET /orders/:id is null accept_deadline_at for a DEVICE-mode listing's order", async () => {
    const fixture = await orderFixture("DEVICE");
    const result = await ingestOrder(db, ingestInput(fixture));
    const owner = await actor("OWNER");

    const res = await request(app).get(`/api/v1/orders/${result.order_id}`).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.acceptDeadlineAt).toBeNull();
  });
});

describe("accept-deadline SLA — GET /channel-listings exposes accept_sla_seconds", () => {
  it("defaults to null when no override was set", async () => {
    const fixture = await orderFixture("API");
    const owner = await actor("OWNER");

    const res = await request(app).get("/api/v1/channel-listings").set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    const found = res.body.find((l: { id: string }) => l.id === fixture.aggregatorAccountId);
    expect(found).toBeTruthy();
    expect(found.acceptSlaSeconds).toBeNull();
  });

  it("reflects a configured per-listing override", async () => {
    const fixture = await orderFixture("API", 180);
    const owner = await actor("OWNER");

    const res = await request(app).get("/api/v1/channel-listings").set("Authorization", `Bearer ${owner.token}`);
    const found = res.body.find((l: { id: string }) => l.id === fixture.aggregatorAccountId);
    expect(found.acceptSlaSeconds).toBe(180);
  });

  it("does not leak the SLA field for a DEVICE-mode listing (still present, just informational)", async () => {
    const fixture = await orderFixture("DEVICE", 240);
    const owner = await actor("OWNER");

    const res = await request(app).get("/api/v1/channel-listings").set("Authorization", `Bearer ${owner.token}`);
    const found = res.body.find((l: { id: string }) => l.id === fixture.aggregatorAccountId);
    expect(found.acceptSlaSeconds).toBe(240);
    expect(found.controlMode).toBe("DEVICE");
  });
});
