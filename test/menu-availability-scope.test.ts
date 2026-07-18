/**
 * SET_ITEM_AVAILABILITY scope + snooze-until tests (migration 0036 / SITE_
 * VISIT_VIDEO_ANALYSIS.md findings F/G):
 *   F — foodpanda's "unavailable until tomorrow/specific date (yellow) vs.
 *       indefinitely (grey)" snooze legend -> `unavailable_until`.
 *   G — client-confirmed efficiency mechanism: option-group-level toggling
 *       ("isa na lang yung papatayin namin, hindi na namin isa-isa") so one
 *       shared ingredient issue (e.g. rice) doesn't require disabling every
 *       menu item one by one -> `scope` + `option_group_id`, backed by the
 *       new minimal menu_option_group / menu_option_group_item tables.
 *
 * Validated centrally in enqueueCommand (service.ts
 * assertValidItemAvailabilityPayload). Fixture shape mirrors test/
 * outbound-commands.test.ts's listingFixture.
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
import { aggregatorAccounts, brands, locations, menuItems, userOutletAccess, users, type Role } from "../src/db/schema.js";
import { menuOptionGroupItems, menuOptionGroups } from "../src/db/outbound-schema.js";
import { enqueueCommand } from "../src/modules/outbound/service.js";
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
  const name = `Avail Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `avail-actor-${s}@test.local`, passwordHash: "hash", role })
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
}

async function listingFixture(): Promise<Fixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `OG-LOC-${s}`, name: `OG Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `OG Brand ${s}`, color: "#998877", salesPerfId: `og-brand-${s}` })
    .returning();
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "GRABFOOD",
      externalMerchantId: `GF-OG-${s}`,
      controlMode: "API",
    })
    .returning();
  return { locationId: location!.id, brandId: brand!.id, aggregatorAccountId: account!.id };
}

/** Rice Type: Brown Rice / Turmeric Rice / Kimchi Rice — the site-visit's own example. */
async function optionGroupFixture(brandId: string): Promise<{ groupId: string; itemIds: string[] }> {
  const s = suffix();
  const [group] = await db.insert(menuOptionGroups).values({ brandId, name: `Rice Type ${s}` }).returning();
  const itemIds: string[] = [];
  for (const name of ["Brown Rice", "Turmeric Rice", "Kimchi Rice"]) {
    const [item] = await db.insert(menuItems).values({ brandId, name: `${name} ${s}`, price: "20" }).returning();
    await db.insert(menuOptionGroupItems).values({ optionGroupId: group!.id, menuItemId: item!.id });
    itemIds.push(item!.id);
  }
  return { groupId: group!.id, itemIds };
}

describe("SET_ITEM_AVAILABILITY — backward compatibility (pre-0036 payload shape)", () => {
  it("a payload with only item_id/available (no scope) still works, defaulting to ITEM", async () => {
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "legacy-item-1", available: false },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
    expect(command.payload).toMatchObject({ item_id: "legacy-item-1", available: false });
  });

  it("a payload with item_id + reason (the original sugar-route shape) still works", async () => {
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "legacy-item-2", available: false, reason: "sold out" },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
  });

  it("an explicit scope=ITEM behaves identically to the default", async () => {
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { scope: "ITEM", item_id: "legacy-item-3", available: true },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
  });
});

describe("SET_ITEM_AVAILABILITY — scope validation", () => {
  it("rejects an invalid scope value", async () => {
    const fixture = await listingFixture();
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "BRAND", item_id: "x", available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("rejects scope=OPTION_GROUP without an option_group_id", async () => {
    const fixture = await listingFixture();
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "OPTION_GROUP", available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("rejects scope=OPTION_GROUP with a malformed (non-UUID) option_group_id", async () => {
    const fixture = await listingFixture();
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "OPTION_GROUP", option_group_id: "not-a-uuid", available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("rejects an option_group_id that does not exist", async () => {
    const fixture = await listingFixture();
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "OPTION_GROUP", option_group_id: randomUUID(), available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("rejects an option_group_id belonging to a DIFFERENT brand than the listing", async () => {
    const fixture = await listingFixture();
    const otherBrandFixture = await listingFixture();
    const { groupId } = await optionGroupFixture(otherBrandFixture.brandId);

    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("rejects option_group_id present when scope=ITEM (or default)", async () => {
    const fixture = await listingFixture();
    const { groupId } = await optionGroupFixture(fixture.brandId);
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { option_group_id: groupId, available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("accepts scope=OPTION_GROUP with a valid, same-brand option_group_id", async () => {
    const fixture = await listingFixture();
    const { groupId } = await optionGroupFixture(fixture.brandId);

    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
    expect(command.payload).toMatchObject({ scope: "OPTION_GROUP", option_group_id: groupId, available: false });
  });
});

describe("SET_ITEM_AVAILABILITY — unavailable_until (snooze legend)", () => {
  it("rejects a non-ISO unavailable_until", async () => {
    const fixture = await listingFixture();
    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixture.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { item_id: "x", available: false, unavailable_until: "not-a-date" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("accepts a valid ISO unavailable_until (yellow: unavailable until a specific date)", async () => {
    const fixture = await listingFixture();
    const until = "2026-07-19T00:00:00.000Z";
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "x", available: false, unavailable_until: until },
      idempotencyKey: randomUUID(),
    });
    expect((command.payload as { unavailable_until: string }).unavailable_until).toBe(until);
  });

  it("accepts unavailable_until=null (grey: unavailable indefinitely)", async () => {
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "x", available: false, unavailable_until: null },
      idempotencyKey: randomUUID(),
    });
    expect((command.payload as { unavailable_until: null }).unavailable_until).toBeNull();
  });

  it("an absent unavailable_until is also treated as indefinite (no field required)", async () => {
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "x", available: false },
      idempotencyKey: randomUUID(),
    });
    expect(command.payload).not.toHaveProperty("unavailable_until");
  });

  it("unavailable_until also works combined with scope=OPTION_GROUP (snooze a whole group)", async () => {
    const fixture = await listingFixture();
    const { groupId } = await optionGroupFixture(fixture.brandId);
    const until = "2026-07-20T00:00:00.000Z";
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false, unavailable_until: until },
      idempotencyKey: randomUUID(),
    });
    expect(command.payload).toMatchObject({ scope: "OPTION_GROUP", option_group_id: groupId, unavailable_until: until });
  });

  it("re-enabling (available=true) clears the practical effect even if unavailable_until is still set on the payload", async () => {
    // The command payload is a point-in-time instruction, not a stored
    // state — "cleared" means the merchant sends a fresh available=true
    // command; there's nothing to reconcile against previous payloads.
    const fixture = await listingFixture();
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixture.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { item_id: "x", available: true, unavailable_until: null },
      idempotencyKey: randomUUID(),
    });
    expect((command.payload as { available: boolean }).available).toBe(true);
  });
});

describe("SET_ITEM_AVAILABILITY — HTTP sugar route (ITEM-scoped, unavailable_until)", () => {
  it("POST /channel-listings/:id/items/:itemId/availability accepts unavailable_until", async () => {
    const fixture = await listingFixture();
    const manager = await actor("OUTLET_MANAGER", fixture.locationId);
    const until = "2026-07-19T00:00:00.000Z";

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/items/some-item/availability`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ available: false, unavailable_until: until });
    expect(res.status).toBe(201);
    expect(res.body.payload).toMatchObject({ item_id: "some-item", available: false, unavailable_until: until });
  });

  it("POST /channel-listings/:id/items/:itemId/availability without unavailable_until still works (backward compat)", async () => {
    const fixture = await listingFixture();
    const manager = await actor("OUTLET_MANAGER", fixture.locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/items/some-item-2/availability`)
      .set("Authorization", `Bearer ${manager.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ available: true });
    expect(res.status).toBe(201);
    expect(res.body.payload).not.toHaveProperty("unavailable_until");
  });

  it("POST /channel-listings/:id/commands with scope=OPTION_GROUP succeeds end-to-end via HTTP", async () => {
    const fixture = await listingFixture();
    const { groupId } = await optionGroupFixture(fixture.brandId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "SET_ITEM_AVAILABILITY", payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false } });
    expect(res.status).toBe(201);
    expect(res.body.payload).toMatchObject({ scope: "OPTION_GROUP", option_group_id: groupId });
  });

  it("POST /channel-listings/:id/commands 400s an invalid option_group_id via HTTP", async () => {
    const fixture = await listingFixture();
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/channel-listings/${fixture.aggregatorAccountId}/commands`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ command_type: "SET_ITEM_AVAILABILITY", payload: { scope: "OPTION_GROUP", option_group_id: randomUUID(), available: false } });
    expect(res.status).toBe(404);
  });
});

describe("menu_option_group — minimal model sanity", () => {
  it("groups items under a brand (Rice Type: Brown/Turmeric/Kimchi)", async () => {
    const fixture = await listingFixture();
    const { groupId, itemIds } = await optionGroupFixture(fixture.brandId);

    const links = await db.select().from(menuOptionGroupItems).where(eq(menuOptionGroupItems.optionGroupId, groupId));
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.menuItemId).sort()).toEqual([...itemIds].sort());
  });

  it("is scoped to one brand — a group from brand A is not usable for brand B's listing", async () => {
    const fixtureA = await listingFixture();
    const fixtureB = await listingFixture();
    const { groupId } = await optionGroupFixture(fixtureA.brandId);

    await expect(
      enqueueCommand(db, {
        aggregatorAccountId: fixtureB.aggregatorAccountId,
        commandType: "SET_ITEM_AVAILABILITY",
        payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // But it works for the CORRECT brand's listing.
    const command = await enqueueCommand(db, {
      aggregatorAccountId: fixtureA.aggregatorAccountId,
      commandType: "SET_ITEM_AVAILABILITY",
      payload: { scope: "OPTION_GROUP", option_group_id: groupId, available: false },
      idempotencyKey: randomUUID(),
    });
    expect(command.status).toBe("PENDING");
  });
});
