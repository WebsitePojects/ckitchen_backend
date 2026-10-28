/**
 * Sales channels (D60): owner-managed channels beyond GrabFood / foodpanda, without touching
 * partner routing. Pins: system channels exist once; create is duplicate-safe (sequential +
 * concurrent); names are unique per workspace; Walk-in cannot be switched off; offering a
 * manual channel creates one listing per brand outlet and repeating it adds nothing; a manual
 * channel listing never makes walk-in orders ambiguous; orders on it report under its name.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { aggregatorAccounts, auditLogs, brandOutlet, brands, kitchenStations, locations, menuItems, orders, salesChannels } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";

let app: Express;
let db: DB;
let owner: string;
let manager: string;
let brandId: string;
let locationId: string;
let menuItemId: string;

async function login(email: string, password: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  owner = await login("admin@cloudkitchen.local", "admin123");
  manager = await login("outlet_manager@cloudkitchen.local", "password123");
  const [loc] = await db.select().from(locations).limit(1);
  locationId = loc!.id;
  const [brand] = await db.insert(brands).values({ locationId, name: `SC Brand ${randomUUID().slice(0, 6)}`, color: "#123456", salesPerfId: `sc-${randomUUID()}` }).returning();
  brandId = brand!.id;
  await db.insert(brandOutlet).values({ brandId, locationId, isActive: true });
  const [item] = await db.insert(menuItems).values({ brandId, name: "SC Bowl", price: "150" }).returning();
  menuItemId = item!.id;
  const [station] = await db.select().from(kitchenStations).where(eq(kitchenStations.locationId, locationId)).limit(1);
  await db.insert(menuItemOutlets).values({ menuItemId, locationId, stationId: station!.id });
});

const create = (token: string, body: Record<string, unknown>) =>
  request(app).post("/api/v1/sales-channels").set("Authorization", `Bearer ${token}`).send(body);

describe("GET /sales-channels", () => {
  it("every workspace has GrabFood, foodpanda and Walk-in exactly once", async () => {
    await request(app).get("/api/v1/sales-channels").set("Authorization", `Bearer ${owner}`);
    const res = await request(app).get("/api/v1/sales-channels").set("Authorization", `Bearer ${manager}`);
    expect(res.status).toBe(200);
    const system = res.body.filter((c: { isSystem: boolean }) => c.isSystem).map((c: { code: string }) => c.code).sort();
    expect(system).toEqual(["FOODPANDA", "GRABFOOD", "WALK_IN"]);
  });
});

describe("POST /sales-channels", () => {
  it("sequential + concurrent repeats of one intent make one channel and one audit row", async () => {
    const body = { client_request_id: randomUUID(), name: `Lalamove ${randomUUID().slice(0, 4)}`, color: "#F16622", default_commission_rate: 12 };
    const [a, b] = await Promise.all([create(owner, body), create(owner, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await create(owner, body)).status).toBe(200);
    const rows = await db.select().from(salesChannels).where(eq(salesChannels.clientRequestId, body.client_request_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.integration).toBe("MANUAL");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "sales_channel.create"), eq(auditLogs.entityId, rows[0]!.id)));
    expect(audits).toHaveLength(1);
  });

  it("names are unique per workspace regardless of case; only the owner adds; integration cannot be chosen", async () => {
    const name = `ShopeeFood ${randomUUID().slice(0, 4)}`;
    expect((await create(owner, { client_request_id: randomUUID(), name })).status).toBe(201);
    const dupe = await create(owner, { client_request_id: randomUUID(), name: name.toUpperCase() });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe("NAME_TAKEN");
    expect((await create(manager, { client_request_id: randomUUID(), name: "Phone" })).status).toBe(403);
    expect((await create(owner, { client_request_id: randomUUID(), name: "Fake Grab", integration: "GRABFOOD" })).status).toBe(400);
    expect((await create(owner, { client_request_id: randomUUID(), name: "Bad colour", color: "red" })).status).toBe(400);
  });
});

describe("PATCH /sales-channels/:id", () => {
  it("Walk-in cannot be switched off; others can be edited", async () => {
    const list = (await request(app).get("/api/v1/sales-channels").set("Authorization", `Bearer ${owner}`)).body;
    const walkIn = list.find((c: { code: string }) => c.code === "WALK_IN");
    const off = await request(app).patch(`/api/v1/sales-channels/${walkIn.id}`).set("Authorization", `Bearer ${owner}`).send({ is_active: false });
    expect(off.status).toBe(409);
    const recolour = await request(app).patch(`/api/v1/sales-channels/${walkIn.id}`).set("Authorization", `Bearer ${owner}`).send({ color: "#334455" });
    expect(recolour.status).toBe(200);
    expect(recolour.body.color).toBe("#334455");
  });
});

describe("manual channel listings and orders", () => {
  let channelId: string;

  beforeAll(async () => {
    const res = await create(owner, { client_request_id: randomUUID(), name: `Phone orders ${randomUUID().slice(0, 4)}`, default_commission_rate: 0 });
    channelId = res.body.id;
  });

  it("offering creates one listing per brand outlet; repeats (sequential + concurrent) add nothing", async () => {
    const offer = () => request(app).post(`/api/v1/sales-channels/${channelId}/listings`).set("Authorization", `Bearer ${owner}`).send({ brand_ids: [brandId] });
    const first = await offer();
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(1);
    const again = await Promise.all([offer(), offer()]);
    expect(again.map((r) => r.body.created)).toEqual([0, 0]);
    const listings = await db.select().from(aggregatorAccounts).where(and(eq(aggregatorAccounts.channelId, channelId), eq(aggregatorAccounts.brandId, brandId)));
    expect(listings).toHaveLength(1);
    expect(listings[0]!.aggregator).toBe("OTHER");
  });

  it("an API channel cannot be bulk-offered", async () => {
    const list = (await request(app).get("/api/v1/sales-channels").set("Authorization", `Bearer ${owner}`)).body;
    const grab = list.find((c: { code: string }) => c.code === "GRABFOOD");
    const res = await request(app).post(`/api/v1/sales-channels/${grab.id}/listings`).set("Authorization", `Bearer ${owner}`).send({});
    expect(res.status).toBe(409);
  });

  it("walk-in orders still resolve (not ambiguous) with a manual channel listing at the same outlet", async () => {
    const ref = `walk-${randomUUID()}`;
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${owner}`)
      .set("X-Outlet-Id", locationId)
      .send({ brand_id: brandId, aggregator: "OTHER", external_ref: ref, allow_oversell: true, items: [{ menu_item_id: menuItemId, qty: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [order] = await db.select().from(orders).where(eq(orders.externalRef, ref));
    const [listing] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, order!.aggregatorAccountId!));
    const [channel] = await db.select().from(salesChannels).where(eq(salesChannels.id, listing!.channelId!));
    expect(channel!.code).toBe("WALK_IN");
  });

  it("an order keyed on the manual channel reports under its name", async () => {
    const [listing] = await db.select().from(aggregatorAccounts).where(and(eq(aggregatorAccounts.channelId, channelId), eq(aggregatorAccounts.brandId, brandId)));
    const res = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${owner}`)
      .send({ brand_id: brandId, aggregator: "OTHER", aggregator_account_id: listing!.id, external_ref: `phone-${randomUUID()}`, allow_oversell: true, items: [{ menu_item_id: menuItemId, qty: 2 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const split = await request(app).get("/api/v1/analytics/aggregators").set("Authorization", `Bearer ${owner}`);
    const row = split.body.find((r: { channel_id: string }) => r.channel_id === channelId);
    expect(row.order_count).toBe(1);
    expect(row.channel_name).toMatch(/^Phone orders/);
  });

  it("a listing made with channel_id needs no credentials; a duplicate store id is a 409", async () => {
    const body = { channel_id: channelId, external_merchant_id: `PHONE-${randomUUID().slice(0, 6)}`, location_id: locationId };
    const first = await request(app).post(`/api/v1/brands/${brandId}/accounts`).set("Authorization", `Bearer ${owner}`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.aggregator).toBe("OTHER");
    expect(first.body.channelId).toBe(channelId);
    const dupe = await request(app).post(`/api/v1/brands/${brandId}/accounts`).set("Authorization", `Bearer ${owner}`).send(body);
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe("LISTING_EXISTS");
  });

  it("a brand's listings carry their channel (name, colour, code, active) and never the credential", async () => {
    const res = await request(app).get(`/api/v1/brands/${brandId}/accounts`).set("Authorization", `Bearer ${owner}`);
    expect(res.status).toBe(200);
    const phone = res.body.find((a: { channel?: { id: string } }) => a.channel?.id === channelId);
    expect(phone.channel).toMatchObject({ integration: "MANUAL", code: null, isActive: true });
    const walkIn = res.body.find((a: { channel?: { code: string } }) => a.channel?.code === "WALK_IN");
    expect(walkIn).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("credentialRef");
  });

  it("a listing inserted the old way (aggregator only) is linked to the system channel by the trigger", async () => {
    const [row] = await db.insert(aggregatorAccounts).values({ brandId, aggregator: "GRABFOOD", externalMerchantId: `CK-T-${randomUUID().slice(0, 6)}`, credentialRef: "x" }).returning();
    const [channel] = await db.select().from(salesChannels).where(eq(salesChannels.id, row!.channelId!));
    expect(channel!.code).toBe("GRABFOOD");
  });
});
