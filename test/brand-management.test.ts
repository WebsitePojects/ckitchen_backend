/**
 * Brand/merchant + menu management API surface — new endpoints (2026-07-18):
 *
 *   DELETE /brands/:id                              — hard delete w/ HAS_LISTINGS/HAS_ORDERS guards
 *   POST   /brands/:id/accounts (location_id)        — channel listing create, D39 outlet targeting
 *   PATCH  /accounts/:id                              — channel listing update (never credentials)
 *   GET    /menu/:id/outlets                          — per-outlet deployment read
 *   PUT    /menu/:id/outlets/:locationId               — per-outlet deployment UPSERT
 *   DELETE /menu/:id/outlets/:locationId               — per-outlet soft-undeploy
 *   POST   /brands/:id/availability                    — bulk brand-wide availability
 *   POST   /outlets/:locationId/menu-availability       — bulk per-outlet availability
 *   POST   /channel-listings/:id/items/:itemId/availability — RBAC now includes BRAND_MANAGER
 *
 * Fixture style mirrors test/menu-availability-scope.test.ts: runMigrations (not
 * seed) + a per-test actor() helper that mints a role-scoped JWT via
 * user_outlet_access, so ASSIGNED-scope RBAC (OUTLET_MANAGER/BRAND_MANAGER) can
 * be exercised across MULTIPLE outlets in the same file.
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
  brandOutlet,
  brands,
  kitchenStations,
  locations,
  menuItems,
  orderItems,
  orders,
  userOutletAccess,
  users,
  type Role,
} from "../src/db/schema.js";
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
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, OUTBOUND_COMMANDS_FLAG));
}, 60_000);

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function actor(role: Role, locationId?: string): Promise<{ userId: string; token: string; name: string }> {
  const s = suffix();
  const name = `BM Actor ${s}`;
  const [user] = await db
    .insert(users)
    .values({ name, email: `bm-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token, name };
}

async function createLocation(): Promise<string> {
  const s = suffix();
  const [loc] = await db.insert(locations).values({ code: `BM-LOC-${s}`, name: `BM Outlet ${s}` }).returning();
  return loc!.id;
}

async function createStation(locationId: string): Promise<string> {
  const s = suffix();
  const [st] = await db.insert(kitchenStations).values({ locationId, name: `Station ${s}` }).returning();
  return st!.id;
}

async function createBrand(homeLocationId: string): Promise<string> {
  const s = suffix();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: homeLocationId, name: `BM Brand ${s}`, color: "#112233", salesPerfId: `bm-brand-${s}` })
    .returning();
  await db.insert(brandOutlet).values({ brandId: brand!.id, locationId: homeLocationId, isActive: true });
  return brand!.id;
}

async function deployBrandToOutlet(brandId: string, locationId: string, isActiveVal = true): Promise<void> {
  await db.insert(brandOutlet).values({ brandId, locationId, isActive: isActiveVal }).onConflictDoNothing();
}

async function createMenuItem(brandId: string): Promise<string> {
  const s = suffix();
  const [item] = await db.insert(menuItems).values({ brandId, name: `Item ${s}`, price: "100" }).returning();
  return item!.id;
}

// ---------------------------------------------------------------------------
// DELETE /brands/:id
// ---------------------------------------------------------------------------
describe("DELETE /brands/:id", () => {
  it("OWNER deletes a brand with zero listings/orders -> 200, brand gone", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");

    const res = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(rows.length).toBe(0);
  });

  it("BRAND_MANAGER is forbidden (OWNER-only) -> 403", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const bm = await actor("BRAND_MANAGER", locationId);

    const res = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${bm.token}`);
    expect(res.status).toBe(403);

    const rows = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(rows.length).toBe(1); // unaffected
  });

  it("404 NOT_FOUND for an unknown brand id", async () => {
    const owner = await actor("OWNER");
    const res = await request(app)
      .delete(`/api/v1/brands/${randomUUID()}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(404);
  });

  it("409 HAS_LISTINGS when the brand has an aggregator account", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    await db.insert(aggregatorAccounts).values({ brandId, aggregator: "OTHER", externalMerchantId: `ext-${suffix()}` });
    const owner = await actor("OWNER");

    const res = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HAS_LISTINGS");

    const rows = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(rows.length).toBe(1); // unaffected
  });

  it("409 HAS_ORDERS when a menu item has been ordered (zero listings of its own)", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);

    // Order rows must FK to SOME existing aggregator_account; use a different
    // brand's account so brandId's own aggregator_account count stays ZERO
    // (isolating the HAS_ORDERS branch from the HAS_LISTINGS branch, which
    // would otherwise always fire first in a real ingestion flow).
    const otherBrandId = await createBrand(await createLocation());
    const [otherAccount] = await db
      .insert(aggregatorAccounts)
      .values({ brandId: otherBrandId, aggregator: "OTHER", externalMerchantId: `ext-${suffix()}` })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        brandId,
        aggregatorAccountId: otherAccount!.id,
        aggregator: "OTHER",
        externalRef: `ref-${suffix()}`,
        total: "100.00",
      })
      .returning();
    await db.insert(orderItems).values({ orderId: order!.id, menuItemId, qty: 1, stationId });

    const owner = await actor("OWNER");
    const res = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HAS_ORDERS");
  });

  it("double-fire: two CONCURRENT deletes of the same brand — one 200, one 404, brand deleted exactly once", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");

    const [r1, r2] = await Promise.all([
      request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`),
      request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 404]);

    const rows = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(rows.length).toBe(0);
  });

  it("two SEQUENTIAL deletes of the same brand — second replays 404, not a 500", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");

    const r1 = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`);
    const r2 = await request(app).delete(`/api/v1/brands/${brandId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /brands/:id/accounts — location_id (D39)
// ---------------------------------------------------------------------------
describe("POST /brands/:id/accounts — location_id", () => {
  it("201 + persists location_id when the brand IS deployed there", async () => {
    const homeLocationId = await createLocation();
    const brandId = await createBrand(homeLocationId);
    const otherLocationId = await createLocation();
    await deployBrandToOutlet(brandId, otherLocationId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        aggregator: "FOODPANDA",
        external_merchant_id: `FP-${suffix()}`,
        credential_ref: "secret-value",
        location_id: otherLocationId,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.locationId).toBe(otherLocationId);
  });

  it("422 NOT_DEPLOYED when the brand is NOT deployed at that outlet", async () => {
    const homeLocationId = await createLocation();
    const brandId = await createBrand(homeLocationId);
    const foreignLocationId = await createLocation(); // brand never deployed here
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        aggregator: "GRABFOOD",
        external_merchant_id: `GF-${suffix()}`,
        credential_ref: "secret-value",
        location_id: foreignLocationId,
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_DEPLOYED");
  });

  it("404 when location_id does not reference an existing outlet", async () => {
    const homeLocationId = await createLocation();
    const brandId = await createBrand(homeLocationId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        aggregator: "GRABFOOD",
        external_merchant_id: `GF-${suffix()}`,
        credential_ref: "secret-value",
        location_id: randomUUID(),
      });
    expect(res.status).toBe(404);
  });

  it("omitting location_id stays backward compatible -> 201, locationId null", async () => {
    const homeLocationId = await createLocation();
    const brandId = await createBrand(homeLocationId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ aggregator: "OTHER", external_merchant_id: `OT-${suffix()}`, credential_ref: "secret-value" });
    expect(res.status).toBe(201);
    expect(res.body.locationId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /accounts/:id
// ---------------------------------------------------------------------------
describe("PATCH /accounts/:id", () => {
  async function createAccount(ownerToken: string, brandId: string, credentialRef = "top-secret-value") {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: `FP-${suffix()}`, credential_ref: credentialRef });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  it("OWNER updates commission_rate/status/external_merchant_id -> 200, credential never returned", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ commission_rate: 12.5, status: "RESOLVED", external_merchant_id: "FP-RENAMED" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mappingStatus).toBe("RESOLVED");
    expect(Number(res.body.commissionRate)).toBe(12.5);
    expect(res.body.externalMerchantId).toBe("FP-RENAMED");
    expect(res.body.credentialRef).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("top-secret-value");
  });

  it("credential_ref sent in the body is silently ignored — DB row unchanged", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId, "original-credential");

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ commission_rate: 5, credential_ref: "attempted-override" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, accountId));
    expect(row!.credentialRef).toBe("original-credential");
  });

  it("BRAND_MANAGER may patch -> 200; KITCHEN_CREW is forbidden -> 403", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);

    const bm = await actor("BRAND_MANAGER", locationId);
    const bmRes = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${bm.token}`)
      .send({ commission_rate: 8 });
    expect(bmRes.status, JSON.stringify(bmRes.body)).toBe(200);

    const crew = await actor("KITCHEN_CREW", locationId);
    const crewRes = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${crew.token}`)
      .send({ commission_rate: 9 });
    expect(crewRes.status).toBe(403);
  });

  it("400 VALIDATION_ERROR on an invalid status enum value", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ status: "NOT_A_REAL_STATUS" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 when the body has no fields at all", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("422 NOT_DEPLOYED when reassigning location_id to an outlet the brand isn't deployed to", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);
    const foreignLocationId = await createLocation();

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ location_id: foreignLocationId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_DEPLOYED");
  });

  it("200 when reassigning location_id to a properly deployed outlet", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");
    const accountId = await createAccount(owner.token, brandId);
    const otherLocationId = await createLocation();
    await deployBrandToOutlet(brandId, otherLocationId);

    const res = await request(app)
      .patch(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ location_id: otherLocationId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.locationId).toBe(otherLocationId);
  });

  it("404 NOT_FOUND for an unknown account id", async () => {
    const owner = await actor("OWNER");
    const res = await request(app)
      .patch(`/api/v1/accounts/${randomUUID()}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ commission_rate: 1 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// menu_item_outlet — GET / PUT / DELETE
// ---------------------------------------------------------------------------
describe("GET /menu/:id/outlets", () => {
  it("returns [] for an item never deployed to any outlet", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .get(`/api/v1/menu/${menuItemId}/outlets`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("404 for an unknown menu item", async () => {
    const owner = await actor("OWNER");
    const res = await request(app)
      .get(`/api/v1/menu/${randomUUID()}/outlets`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /menu/:id/outlets/:locationId", () => {
  it("upserts a deployment — defaults availability=AVAILABLE, is_active=true", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.availability).toBe("AVAILABLE");
    expect(res.body.isActive).toBe(true);

    const getRes = await request(app)
      .get(`/api/v1/menu/${menuItemId}/outlets`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].locationId).toBe(locationId);
    expect(getRes.body[0].stationId).toBe(stationId);
  });

  it("a second PUT with a different availability UPDATES the same row — no duplicate", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId });

    const res2 = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId, availability: "PAUSED" });
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    expect(res2.body.availability).toBe("PAUSED");

    const rows = await db
      .select()
      .from(menuItemOutlets)
      .where(eq(menuItemOutlets.menuItemId, menuItemId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.availability).toBe("PAUSED");
  });

  it("422 STATION_NOT_IN_OUTLET when station_id belongs to a different outlet", async () => {
    const locationA = await createLocation();
    const stationA = await createStation(locationA);
    const brandId = await createBrand(locationA);
    const menuItemId = await createMenuItem(brandId);
    const locationB = await createLocation();
    const owner = await actor("OWNER");

    const res = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationB}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationA });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("STATION_NOT_IN_OUTLET");
  });

  it("403 FORBIDDEN when KITCHEN_CREW attempts a PUT", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const crew = await actor("KITCHEN_CREW", locationId);

    const res = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${crew.token}`)
      .send({ station_id: stationId });
    expect(res.status).toBe(403);
  });

  it("403 outlet-scope: OUTLET_MANAGER assigned elsewhere cannot PUT for a different outlet", async () => {
    const locationA = await createLocation();
    const locationB = await createLocation();
    const stationB = await createStation(locationB);
    const brandId = await createBrand(locationA);
    const menuItemId = await createMenuItem(brandId);
    const om = await actor("OUTLET_MANAGER", locationA); // assigned to A, not B

    const res = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationB}`)
      .set("Authorization", `Bearer ${om.token}`)
      .send({ station_id: stationB });
    expect(res.status).toBe(403);
  });

  it("400 VALIDATION_ERROR when station_id is missing", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("double-fire: two CONCURRENT identical PUTs leave exactly ONE row", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const body = { station_id: stationId, availability: "AVAILABLE" as const };
    const [r1, r2] = await Promise.all([
      request(app).put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`).set("Authorization", `Bearer ${owner.token}`).send(body),
      request(app).put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`).set("Authorization", `Bearer ${owner.token}`).send(body),
    ]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    const rows = await db
      .select()
      .from(menuItemOutlets)
      .where(eq(menuItemOutlets.menuItemId, menuItemId));
    expect(rows.length).toBe(1); // NOT 2
  });
});

describe("DELETE /menu/:id/outlets/:locationId", () => {
  it("soft-undeploys (is_active=false); a re-delete stays 200 and idempotent", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId });

    const del1 = await request(app)
      .delete(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(del1.status, JSON.stringify(del1.body)).toBe(200);
    expect(del1.body.deployment.isActive).toBe(false);

    const del2 = await request(app)
      .delete(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(del2.status).toBe(200); // idempotent, already inactive

    const rows = await db
      .select()
      .from(menuItemOutlets)
      .where(eq(menuItemOutlets.menuItemId, menuItemId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.isActive).toBe(false);
  });

  it("404 when the item was never deployed to that outlet", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .delete(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(res.status).toBe(404);
  });

  it("double-fire: two CONCURRENT deletes both 200, ends inactive, single row", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const menuItemId = await createMenuItem(brandId);
    const owner = await actor("OWNER");

    await request(app)
      .put(`/api/v1/menu/${menuItemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId });

    const [r1, r2] = await Promise.all([
      request(app).delete(`/api/v1/menu/${menuItemId}/outlets/${locationId}`).set("Authorization", `Bearer ${owner.token}`),
      request(app).delete(`/api/v1/menu/${menuItemId}/outlets/${locationId}`).set("Authorization", `Bearer ${owner.token}`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await db
      .select()
      .from(menuItemOutlets)
      .where(eq(menuItemOutlets.menuItemId, menuItemId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bulk availability
// ---------------------------------------------------------------------------
describe("POST /brands/:id/availability (bulk, brand-wide)", () => {
  it("sets availability across every menu item -> {updated:n}", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const itemIds = [await createMenuItem(brandId), await createMenuItem(brandId), await createMenuItem(brandId)];
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/availability`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ availability: "PAUSED" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.updated).toBe(3);

    const rows = await db.select().from(menuItems).where(eq(menuItems.brandId, brandId));
    for (const row of rows) {
      expect(itemIds).toContain(row.id);
      expect(row.availability).toBe("PAUSED");
    }
  });

  it("403 for KITCHEN_CREW", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const crew = await actor("KITCHEN_CREW", locationId);

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/availability`)
      .set("Authorization", `Bearer ${crew.token}`)
      .send({ availability: "SOLD_OUT" });
    expect(res.status).toBe(403);
  });

  it("400 for an invalid availability value", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const owner = await actor("OWNER");

    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/availability`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ availability: "NOT_A_REAL_VALUE" });
    expect(res.status).toBe(400);
  });

  it("double-fire: two CONCURRENT identical bulk calls converge to the same state, no duplication", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    await createMenuItem(brandId);
    await createMenuItem(brandId);
    const owner = await actor("OWNER");

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/brands/${brandId}/availability`).set("Authorization", `Bearer ${owner.token}`).send({ availability: "SOLD_OUT" }),
      request(app).post(`/api/v1/brands/${brandId}/availability`).set("Authorization", `Bearer ${owner.token}`).send({ availability: "SOLD_OUT" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await db.select().from(menuItems).where(eq(menuItems.brandId, brandId));
    expect(rows.length).toBe(2); // no new/duplicated rows
    for (const row of rows) expect(row.availability).toBe("SOLD_OUT");
  });
});

describe("POST /outlets/:locationId/menu-availability (bulk, per-outlet)", () => {
  it("sets availability only for ACTIVE deployments at that outlet", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const owner = await actor("OWNER");

    const activeItem1 = await createMenuItem(brandId);
    const activeItem2 = await createMenuItem(brandId);
    const inactiveItem = await createMenuItem(brandId);

    for (const itemId of [activeItem1, activeItem2, inactiveItem]) {
      await request(app)
        .put(`/api/v1/menu/${itemId}/outlets/${locationId}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ station_id: stationId });
    }
    // Deactivate one deployment so it must be EXCLUDED from the bulk update.
    await request(app)
      .delete(`/api/v1/menu/${inactiveItem}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`);

    const res = await request(app)
      .post(`/api/v1/outlets/${locationId}/menu-availability`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ availability: "SOLD_OUT" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.updated).toBe(2);

    const rows = await db.select().from(menuItemOutlets).where(eq(menuItemOutlets.locationId, locationId));
    const byItem = new Map(rows.map((r) => [r.menuItemId, r]));
    expect(byItem.get(activeItem1)!.availability).toBe("SOLD_OUT");
    expect(byItem.get(activeItem2)!.availability).toBe("SOLD_OUT");
    expect(byItem.get(inactiveItem)!.availability).toBe("AVAILABLE"); // untouched
  });

  it("403 outlet-scope for OUTLET_MANAGER assigned to a different outlet", async () => {
    const locationA = await createLocation();
    const locationB = await createLocation();
    const om = await actor("OUTLET_MANAGER", locationA);

    const res = await request(app)
      .post(`/api/v1/outlets/${locationB}/menu-availability`)
      .set("Authorization", `Bearer ${om.token}`)
      .send({ availability: "PAUSED" });
    expect(res.status).toBe(403);
  });

  it("403 for BRAND_MANAGER (not in this endpoint's RBAC list)", async () => {
    const locationId = await createLocation();
    const bm = await actor("BRAND_MANAGER", locationId);

    const res = await request(app)
      .post(`/api/v1/outlets/${locationId}/menu-availability`)
      .set("Authorization", `Bearer ${bm.token}`)
      .send({ availability: "PAUSED" });
    expect(res.status).toBe(403);
  });

  it("double-fire: two CONCURRENT identical bulk calls converge to the same state", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const stationId = await createStation(locationId);
    const owner = await actor("OWNER");
    const itemId = await createMenuItem(brandId);
    await request(app)
      .put(`/api/v1/menu/${itemId}/outlets/${locationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ station_id: stationId });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/outlets/${locationId}/menu-availability`).set("Authorization", `Bearer ${owner.token}`).send({ availability: "PAUSED" }),
      request(app).post(`/api/v1/outlets/${locationId}/menu-availability`).set("Authorization", `Bearer ${owner.token}`).send({ availability: "PAUSED" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await db.select().from(menuItemOutlets).where(eq(menuItemOutlets.locationId, locationId));
    expect(rows.length).toBe(1); // no duplication
    expect(rows[0]!.availability).toBe("PAUSED");
  });
});

// ---------------------------------------------------------------------------
// RBAC alignment: POST /channel-listings/:id/items/:itemId/availability now
// allows BRAND_MANAGER (server was the last place still blocking a control
// the frontend already offers brand managers).
// ---------------------------------------------------------------------------
describe("RBAC alignment — channel-listing item availability allows BRAND_MANAGER", () => {
  it("BRAND_MANAGER can set item availability -> 201", async () => {
    const locationId = await createLocation();
    const brandId = await createBrand(locationId);
    const [listing] = await db
      .insert(aggregatorAccounts)
      .values({
        brandId,
        locationId,
        mappingStatus: "RESOLVED",
        aggregator: "GRABFOOD",
        externalMerchantId: `GF-${suffix()}`,
        controlMode: "API",
      })
      .returning();
    const bm = await actor("BRAND_MANAGER", locationId);

    const res = await request(app)
      .post(`/api/v1/channel-listings/${listing!.id}/items/some-item/availability`)
      .set("Authorization", `Bearer ${bm.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ available: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
