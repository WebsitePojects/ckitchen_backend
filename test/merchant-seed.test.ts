/**
 * Real-merchant seed tests (src/db/seed-merchants.ts —
 * AGGREGATOR_API_INTEGRATION_SPEC.md §3's July 15 client lists: 15
 * foodpanda + 9 GrabFood listings). Covers: idempotent double-run, the
 * expected 24 total channel listings, case-insensitive brand reuse (both
 * across the two source lists AND against a pre-existing brand row), the
 * deliberate non-fuzzy-match design decision (near-duplicate spellings stay
 * distinct brands), the Central Kitchen outlet being created on demand, and
 * the never-a-real-credential placeholder contract.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorAccounts, brands, locations } from "../src/db/schema.js";
import {
  FOODPANDA_MERCHANT_BRANDS,
  GRABFOOD_MERCHANT_BRANDS,
  seedMerchants,
} from "../src/db/seed-merchants.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
});

afterAll(async () => {
  await closeDb(client);
});

async function ckLocation() {
  const [loc] = await db.select().from(locations).where(eq(locations.code, "CK"));
  return loc!;
}

describe("seed-merchants", () => {
  it("creates the Central Kitchen outlet (code CK) on first run", async () => {
    const result = await seedMerchants(db);
    const loc = await ckLocation();
    expect(loc).toBeDefined();
    expect(loc.name).toBe("Central Kitchen");
    expect(result.locationId).toBe(loc.id);
  });

  it("creates exactly 24 channel listings total (15 foodpanda + 9 GrabFood)", async () => {
    await seedMerchants(db);
    const loc = await ckLocation();
    const rows = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, loc.id));
    expect(rows).toHaveLength(FOODPANDA_MERCHANT_BRANDS.length + GRABFOOD_MERCHANT_BRANDS.length);
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.aggregator === "FOODPANDA")).toHaveLength(15);
    expect(rows.filter((r) => r.aggregator === "GRABFOOD")).toHaveLength(9);
  });

  it("reuses brands case-insensitively across the two source lists (e.g. Verde Kitchen)", async () => {
    await seedMerchants(db);
    const loc = await ckLocation();
    const [verdeBrand] = await db.select().from(brands).where(and(eq(brands.locationId, loc.id), eq(brands.name, "Verde Kitchen")));
    expect(verdeBrand).toBeDefined();

    const listings = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.brandId, verdeBrand!.id));
    expect(listings).toHaveLength(2); // one FOODPANDA + one GRABFOOD
    const aggregators = listings.map((l) => l.aggregator).sort();
    expect(aggregators).toEqual(["FOODPANDA", "GRABFOOD"]);
  });

  it("treats near-duplicate spellings as DISTINCT brands (deliberate: no fuzzy/punctuation merge)", async () => {
    await seedMerchants(db);
    const loc = await ckLocation();
    const allBrands = await db.select().from(brands).where(eq(brands.locationId, loc.id));
    const byName = new Map(allBrands.map((b) => [b.name, b]));

    // foodpanda "Yo Annyeong" vs GrabFood "Yo' Annyeong" — distinct rows.
    expect(byName.get("Yo Annyeong")).toBeDefined();
    expect(byName.get("Yo' Annyeong")).toBeDefined();
    expect(byName.get("Yo Annyeong")!.id).not.toBe(byName.get("Yo' Annyeong")!.id);

    // foodpanda "Chicken Bar" vs GrabFood "The Chicken Bar" — distinct rows.
    expect(byName.get("Chicken Bar")).toBeDefined();
    expect(byName.get("The Chicken Bar")).toBeDefined();
    expect(byName.get("Chicken Bar")!.id).not.toBe(byName.get("The Chicken Bar")!.id);
  });

  it("computes 18 distinct brands (24 listing entries, 6 exact case-insensitive overlaps)", async () => {
    const result = await seedMerchants(db);
    expect(result.brandsTouched).toBe(18);
    const loc = await ckLocation();
    const allBrands = await db.select().from(brands).where(eq(brands.locationId, loc.id));
    expect(allBrands).toHaveLength(18);
  });

  it("reuses a brand that already exists (case-insensitively) BEFORE the seed ever runs", async () => {
    const created2 = createDb();
    const freshDb = created2.db;
    try {
      await runMigrations(freshDb);
      const [preLocation] = await freshDb.insert(locations).values({ code: "PRE-LOC", name: "Pre-existing Outlet" }).returning();
      const [preexisting] = await freshDb
        .insert(brands)
        .values({ locationId: preLocation!.id, name: "gREEK aLPHA", color: "#000000", salesPerfId: "pre-existing-greek-alpha" })
        .returning();

      const result = await seedMerchants(freshDb);
      const loc2 = await freshDb.select().from(locations).where(eq(locations.code, "CK"));
      const listingsForBrand = await freshDb
        .select()
        .from(aggregatorAccounts)
        .where(eq(aggregatorAccounts.brandId, preexisting!.id));

      // Greek Alpha appears in BOTH source lists (2 listings), both reusing
      // the pre-existing (differently-cased) brand row rather than creating
      // a NEW "Greek Alpha" brand.
      expect(listingsForBrand).toHaveLength(2);
      const brandsNamedGreekAlphaCI = (await freshDb.select().from(brands)).filter(
        (b) => b.name.toLowerCase() === "greek alpha",
      );
      expect(brandsNamedGreekAlphaCI).toHaveLength(1);
      expect(brandsNamedGreekAlphaCI[0]!.id).toBe(preexisting!.id);
      expect(result.locationId).toBe(loc2[0]!.id);
    } finally {
      await closeDb(created2.client);
    }
  });

  it("never stores a real credential — credential_ref is always the literal placeholder", async () => {
    await seedMerchants(db);
    const loc = await ckLocation();
    const rows = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, loc.id));
    expect(rows.every((r) => r.credentialRef === "pending-api-onboarding")).toBe(true);
    expect(rows.every((r) => r.controlMode === "DEVICE")).toBe(true);
    expect(rows.every((r) => r.externalMerchantId.startsWith("pending-"))).toBe(true);
  });

  it("idempotent double-run: re-running produces IDENTICAL counts, no duplicate rows", async () => {
    const first = await seedMerchants(db);
    const beforeListingCount = (await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, first.locationId))).length;
    const beforeBrandCount = (await db.select().from(brands).where(eq(brands.locationId, first.locationId))).length;

    const second = await seedMerchants(db);
    const afterListingCount = (await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, second.locationId))).length;
    const afterBrandCount = (await db.select().from(brands).where(eq(brands.locationId, second.locationId))).length;

    expect(second.locationId).toBe(first.locationId);
    expect(afterListingCount).toBe(beforeListingCount);
    expect(afterBrandCount).toBe(beforeBrandCount);
    expect(afterListingCount).toBe(24);
    expect(afterBrandCount).toBe(18);

    // A third run for good measure — genuinely stable, not "stable by luck".
    const third = await seedMerchants(db);
    expect(third.brandsTouched).toBe(18);
    expect(third.listingsTouched).toBe(24);
  });
});
