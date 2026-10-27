/**
 * Walk-ins work for brands created without a walk-in listing.
 *
 * Found 2026-10-27 on the POS: the real brands (seed-real-brands / production) have
 * GrabFood/foodpanda listings but no OTHER (walk-in) listing, so every walk-in failed with
 * "No aggregator account found for brand <uuid> + OTHER". Ingest now gets-or-creates the
 * brand's walk-in listing at the outlet the order is taken in.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { aggregatorAccounts, brandOutlet, kitchenStations, locations } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";

let app: Express;
let db: DB;
let token: string;
let grillId: string;
let homeLocationId: string;

const auth = (outletId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(outletId ? { "X-Outlet-Id": outletId } : {}),
});

async function makeBrand(name: string) {
  const brand = await request(app).post("/api/v1/brands").set(auth()).send({ name, color: "#336699" });
  expect(brand.status, JSON.stringify(brand.body)).toBe(201);
  const menu = await request(app).post(`/api/v1/brands/${brand.body.id}/menu`).set(auth()).send({ name: `${name} Rice`, price: "150", station_id: grillId });
  expect(menu.status).toBe(201);
  return { brandId: brand.body.id as string, menuItemId: menu.body.id as string };
}

const walkIn = (brandId: string, menuItemId: string, ref: string, outletId?: string) =>
  request(app)
    .post("/api/v1/ingest/order")
    .set(auth(outletId))
    .send({ brand_id: brandId, aggregator: "OTHER", external_ref: ref, items: [{ menu_item_id: menuItemId, qty: 1 }] });

const walkInListings = (brandId: string) =>
  db.select().from(aggregatorAccounts).where(and(eq(aggregatorAccounts.brandId, brandId), eq(aggregatorAccounts.aggregator, "OTHER")));

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  token = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;
  const stations = (await request(app).get("/api/v1/stations").set(auth())).body as Array<{ id: string; name: string; locationId: string }>;
  const grill = stations.find((s) => s.name === "Grill")!;
  grillId = grill.id;
  homeLocationId = grill.locationId;
}, 60_000);

describe("walk-in listing get-or-create", () => {
  it("creates the walk-in listing on the first walk-in and reuses it after", async () => {
    const { brandId, menuItemId } = await makeBrand("Walkin Alpha");
    expect(await walkInListings(brandId)).toHaveLength(0);

    const first = await walkIn(brandId, menuItemId, "WI-A-1");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await walkIn(brandId, menuItemId, "WI-A-2");
    expect(second.status).toBe(201);

    const listings = await walkInListings(brandId);
    expect(listings).toHaveLength(1);
    expect(listings[0]!.locationId).toBe(homeLocationId);
    expect(listings[0]!.mappingStatus).toBe("RESOLVED");
  });

  it("two simultaneous first walk-ins create exactly one listing and both succeed", async () => {
    const { brandId, menuItemId } = await makeBrand("Walkin Race");
    const [a, b] = await Promise.all([walkIn(brandId, menuItemId, "WI-R-1"), walkIn(brandId, menuItemId, "WI-R-2")]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(await walkInListings(brandId)).toHaveLength(1);
  });

  it("replaying the same walk-in reference is still one order", async () => {
    const { brandId, menuItemId } = await makeBrand("Walkin Replay");
    const a = await walkIn(brandId, menuItemId, "WI-SAME");
    const b = await walkIn(brandId, menuItemId, "WI-SAME");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.code).toBe("DUPLICATE_ORDER");
    expect(b.body.order_id).toBe(a.body.order_id);
  });

  it("a multi-outlet brand needs the working outlet, and then uses that outlet", async () => {
    const { brandId, menuItemId } = await makeBrand("Walkin Multi");
    const [second] = await db.insert(locations).values({ name: "Second Site", code: "WI2" }).returning();
    // Creating a brand already deploys it to its home outlet; add the second one, with a
    // station there and the menu item deployed to it (an item must be deployed to be sold).
    await db.insert(brandOutlet).values({ brandId, locationId: second!.id, isActive: true });
    const [station2] = await db.insert(kitchenStations).values({ locationId: second!.id, name: "Grill" }).returning();
    await db.insert(menuItemOutlets).values({ menuItemId, locationId: second!.id, stationId: station2!.id, isActive: true });

    const noOutlet = await walkIn(brandId, menuItemId, "WI-M-1");
    expect(noOutlet.status).toBe(409);
    expect(noOutlet.body.error.message).toMatch(/Select the outlet/);
    expect(noOutlet.body.error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no raw ids for staff

    const atSecond = await walkIn(brandId, menuItemId, "WI-M-2", second!.id);
    expect(atSecond.status, JSON.stringify(atSecond.body)).toBe(201);
    const listings = await walkInListings(brandId);
    expect(listings.map((l) => l.locationId)).toEqual([second!.id]);
  });
});
