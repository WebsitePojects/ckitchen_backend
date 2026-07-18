/**
 * REJECT_ORDER controlled vocabulary tests (migration 0036 / SITE_VISIT_
 * VIDEO_ANALYSIS.md finding H: "aggregators require an enumerated reason
 * list; free-text reason only" was a gap). Validated centrally in
 * enqueueCommand (service.ts assertValidRejectReasonPayload) so every entry
 * point — the generic POST /channel-listings/:id/commands route and any
 * direct enqueueCommand caller — gets the same guarantee.
 *
 * Fixture shape mirrors test/outbound-commands.test.ts's listingFixture/
 * orderFixture.
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
import { ingestOrder } from "../src/modules/orders/service.js";
import { enqueueCommand } from "../src/modules/outbound/service.js";
import { OUTBOUND_COMMANDS_FLAG } from "../src/modules/outbound/policies.js";
import { REJECT_REASON_CODES } from "../src/modules/outbound/types.js";

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
  const name = `RR Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `rr-actor-${s}@test.local`, passwordHash: "hash", role })
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

async function orderFixture(): Promise<Fixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `RR-LOC-${s}`, name: `RR Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `RR Brand ${s}`, color: "#445566", salesPerfId: `rr-brand-${s}` })
    .returning();
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "FOODPANDA",
      externalMerchantId: `FP-RR-${s}`,
      controlMode: "API",
    })
    .returning();
  const [station] = await db.insert(kitchenStations).values({ locationId: location!.id, name: `RR Grill ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `RR-ITEM-${s}`, name: `RR Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "20", lowStockThreshold: "2" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({ brandId: brand!.id, name: `RR Dish ${s}`, price: "99", stationId: station!.id, consumptionMode: "STOCKED_OUTPUT", stockItemId: item!.id })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId: location!.id, stationId: station!.id });
  const [kitchenWh] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `RR-WH-${s}`, name: `RR Kitchen ${s}` })
    .returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "100" });

  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id, menuItemId: menuItem!.id };
}

async function createOrder(fixture: Fixture): Promise<string> {
  const result = await ingestOrder(db, {
    brand_id: fixture.brandId,
    aggregator_account_id: fixture.aggregatorAccountId,
    aggregator: "FOODPANDA",
    external_ref: `RR-EXT-${randomUUID()}`,
    items: [{ menu_item_id: fixture.menuItemId, qty: 1 }],
  });
  return result.order_id;
}

describe("REJECT_ORDER reason_code — enqueueCommand validation", () => {
  it("refuses REJECT_ORDER with no payload at all", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "REJECT_ORDER",
        payload: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses REJECT_ORDER with a free-text reason but no reason_code (the old shape)", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "REJECT_ORDER",
        payload: { reason: "Out of stock" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses an unknown reason_code", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "REJECT_ORDER",
        payload: { reason_code: "NOT_A_REAL_CODE" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses reason_code=OTHER without a note", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "REJECT_ORDER",
        payload: { reason_code: "OTHER" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("refuses reason_code=OTHER with an empty/whitespace-only note", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        orderId,
        commandType: "REJECT_ORDER",
        payload: { reason_code: "OTHER", note: "   " },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("accepts reason_code=OTHER with a non-empty note", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: "OTHER", note: "Customer changed their mind after we called." },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
    expect((command.payload as { reason_code: string }).reason_code).toBe("OTHER");
  });

  it.each(REJECT_REASON_CODES.filter((c) => c !== "OTHER"))("accepts every non-OTHER reason_code without requiring a note: %s", async (code) => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: code },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
    expect((command.payload as { reason_code: string }).reason_code).toBe(code);
  });

  it("a non-OTHER reason_code may still carry an optional free-text note", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "REJECT_ORDER",
      payload: { reason_code: "OUT_OF_STOCK", note: "Ran out of chicken thigh." },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
  });

  it("does not validate reason_code for OTHER command types (ACCEPT_ORDER unaffected)", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      orderId,
      commandType: "ACCEPT_ORDER",
      payload: {},
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
  });
});

describe("REJECT_ORDER reason_code — HTTP surface", () => {
  it("POST /channel-listings/:id/commands 400s an invalid reason_code", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "REJECT_ORDER", order_id: orderId, payload: { reason_code: "BOGUS" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("POST /channel-listings/:id/commands succeeds with a valid reason_code", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "REJECT_ORDER", order_id: orderId, payload: { reason_code: "KITCHEN_CLOSED" } });
    expect(res.status).toBe(201);
    expect(res.body.payload).toMatchObject({ reason_code: "KITCHEN_CLOSED" });
  });

  it("KITCHEN_CREW may send a valid REJECT_ORDER with reason_code (role already allowed this command type)", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "REJECT_ORDER", order_id: orderId, payload: { reason_code: "TOO_BUSY" } });
    expect(res.status).toBe(201);
  });

  it("KITCHEN_CREW's invalid reason_code is still 400 VALIDATION, not silently accepted", async () => {
    const fixture = await orderFixture();
    const orderId = await createOrder(fixture);
    const crew = await actor("KITCHEN_STAFF", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${crew.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "REJECT_ORDER", order_id: orderId, payload: {} });
    expect(res.status).toBe(400);
  });
});
