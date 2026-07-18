/**
 * Merchant-console READ endpoints (outbound/routes.ts):
 *   GET /channel-listings            — listing rail (brand + outlet joined,
 *                                      camelCase shape matching the frontend
 *                                      client merchant-console-api.ts)
 *   GET /channel-listings/:id/items  — per-listing menu with availability
 *                                      resolved deployment-first (same rule
 *                                      as order ingestion).
 * Found missing by MA-3 browser QA (listing rail 404 — write side existed,
 * read side did not). These tests pin the contract.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { createApp } from "../src/app.js";
import { seedMerchants } from "../src/db/seed-merchants.js";
import { aggregatorAccounts, brands, kitchenStations, menuItems } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let app: Express;
let ownerToken: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await seed(db);
  await seedMerchants(db);
  app = createApp(db);
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "admin@cloudkitchen.local", password: "admin123" });
  ownerToken = res.body.token as string;
});

afterAll(async () => {
  await closeDb(client);
});

const authed = (path: string) => request(app).get(path).set("Authorization", `Bearer ${ownerToken}`);

describe("GET /channel-listings", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/v1/channel-listings");
    expect(res.status).toBe(401);
  });

  it("returns all seeded listings for an ALL-outlet role, in the frontend contract shape", async () => {
    const res = await authed("/api/v1/channel-listings");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(24);
    const one = res.body.find((l: { brand: { name: string } }) => l.brand.name === "Greek Alpha");
    expect(one).toBeTruthy();
    expect(one).toMatchObject({
      aggregator: expect.any(String),
      status: expect.stringMatching(/^(ACTIVE|PAUSED|INACTIVE)$/),
      controlMode: expect.stringMatching(/^(DEVICE|SHADOW|API)$/),
    });
    expect(one.brand).toMatchObject({ id: expect.any(String), name: "Greek Alpha", color: expect.any(String) });
    expect(one.outlet).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    // credential material must never appear in the response
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/credential/i);
  });

  it("derives INACTIVE status from is_active=false", async () => {
    const res = await authed("/api/v1/channel-listings");
    const target = res.body[0];
    await db.update(aggregatorAccounts).set({ isActive: false }).where(eq(aggregatorAccounts.id, target.id));
    const after = await authed("/api/v1/channel-listings");
    const updated = after.body.find((l: { id: string }) => l.id === target.id);
    expect(updated.status).toBe("INACTIVE");
    await db.update(aggregatorAccounts).set({ isActive: true }).where(eq(aggregatorAccounts.id, target.id));
  });
});

describe("GET /channel-listings/:id/items", () => {
  it("404s an unknown listing", async () => {
    const res = await authed("/api/v1/channel-listings/00000000-0000-0000-0000-000000000000/items");
    expect(res.status).toBe(404);
  });

  it("lists the listing brand's menu items with deployment-first availability", async () => {
    const listings = await authed("/api/v1/channel-listings");
    const listing = listings.body.find((l: { brand: { name: string } }) => l.brand.name === "Greek Alpha");
    const [brand] = await db.select().from(brands).where(eq(brands.id, listing.brand.id));
    const [item] = await db
      .insert(menuItems)
      .values({ brandId: brand!.id, name: "Gyro Wrap QA", price: "199.00", availability: "AVAILABLE" })
      .returning();

    const res = await authed(`/api/v1/channel-listings/${listing.id}/items`);
    expect(res.status).toBe(200);
    const found = res.body.find((i: { id: string }) => i.id === item!.id);
    expect(found).toMatchObject({ name: "Gyro Wrap QA", price: 199, available: true });

    // Deployment row at the listing's outlet overrides item-level availability
    // (menu_item_outlet.station_id is NOT NULL — create a station at that outlet)
    const [station] = await db
      .insert(kitchenStations)
      .values({ locationId: listing.outlet.id, name: "QA Pack Station" })
      .returning();
    await db.insert(menuItemOutlets).values({
      menuItemId: item!.id,
      locationId: listing.outlet.id,
      stationId: station!.id,
      availability: "PAUSED",
    });
    const after = await authed(`/api/v1/channel-listings/${listing.id}/items`);
    const overridden = after.body.find((i: { id: string }) => i.id === item!.id);
    expect(overridden.available).toBe(false);
  });
});
