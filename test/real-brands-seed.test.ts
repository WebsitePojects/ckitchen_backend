/**
 * Real-brand seed tests (src/scripts/seed-real-brands.ts) — the 6 real,
 * client-confirmed brands at the "CloudKitchen ONE" outlet from the July
 * site visits.
 *
 * Covers: outlet resolution (fails clearly when missing), idempotent
 * double-run, the exact 6 brands + their site-visit channel listings,
 * never-a-real-credential placeholders, and demo/dummy-brand deactivation
 * (never deletion) at that outlet.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";
import { aggregatorAccounts, brandOutlet, brands, locations } from "../src/db/schema.js";
import { REAL_BRANDS, seedRealBrands } from "../src/scripts/seed-real-brands.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];

async function ck1Location(database: DB) {
  const [loc] = await database.select().from(locations).where(eq(locations.code, "CK1"));
  return loc!;
}

describe("seed-real-brands", () => {
  describe("missing outlet", () => {
    it("throws a clear error when neither CK1 code nor 'CloudKitchen ONE' name exists", async () => {
      const created = createDb();
      try {
        await runMigrations(created.db);
        // No location at all — the base seed never ran.
        await expect(seedRealBrands(created.db)).rejects.toThrow(/CloudKitchen ONE/i);
      } finally {
        await closeDb(created.client);
      }
    });
  });

  describe("against a base-seeded DB (CK1 / CloudKitchen ONE exists)", () => {
    beforeAll(async () => {
      const created = createDb();
      db = created.db;
      client = created.client;
      await seed(db); // base seed: creates location code=CK1 name="CloudKitchen ONE"
    });

    afterAll(async () => {
      await closeDb(client);
    });

    it("resolves the CK1 / CloudKitchen ONE outlet and creates all 6 real brands", async () => {
      const result = await seedRealBrands(db);
      const loc = await ck1Location(db);
      expect(result.locationId).toBe(loc.id);
      expect(result.brandsCreated).toHaveLength(6);
      expect(result.brandsCreated.sort()).toEqual([...REAL_BRANDS.map((b) => b.name)].sort());
    });

    it("each brand's home outlet is CloudKitchen ONE and has an active brand_outlet deployment", async () => {
      const loc = await ck1Location(db);
      for (const def of REAL_BRANDS) {
        const [brand] = await db.select().from(brands).where(eq(brands.name, def.name));
        expect(brand, `brand ${def.name} should exist`).toBeTruthy();
        expect(brand!.locationId).toBe(loc.id);
        expect(brand!.isActive).toBe(true);

        const [deployment] = await db
          .select()
          .from(brandOutlet)
          .where(and(eq(brandOutlet.brandId, brand!.id), eq(brandOutlet.locationId, loc.id)));
        expect(deployment).toBeTruthy();
        expect(deployment!.isActive).toBe(true);
      }
    });

    it("creates the site-visit-observed channel listings per brand", async () => {
      const loc = await ck1Location(db);
      const expectations: Record<string, string[]> = {
        "Panda Imperial": ["GRABFOOD"],
        "Greek Alpha": ["GRABFOOD"],
        "Kaina Manila": ["GRABFOOD"],
        "Timpla't Lasa": ["FOODPANDA"],
        "Yo! Annyeong": ["FOODPANDA"],
        "The Chicken Bar": ["GRABFOOD"],
      };

      for (const [name, expectedAggregators] of Object.entries(expectations)) {
        const [brand] = await db.select().from(brands).where(eq(brands.name, name));
        const listings = await db
          .select()
          .from(aggregatorAccounts)
          .where(and(eq(aggregatorAccounts.brandId, brand!.id), eq(aggregatorAccounts.locationId, loc.id)));
        expect(listings.map((l) => l.aggregator).sort()).toEqual([...expectedAggregators].sort());
      }
    });

    it("never stores a real credential — credential_ref is always the literal placeholder", async () => {
      const loc = await ck1Location(db);
      const rows = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, loc.id));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.credentialRef === "pending-api-onboarding")).toBe(true);
      expect(rows.every((r) => r.controlMode === "DEVICE")).toBe(true);
      expect(rows.every((r) => r.externalMerchantId.startsWith("pending-"))).toBe(true);
    });

    it("deactivates pre-existing demo/dummy brands homed at CK1 that are NOT one of the 6 (never deletes)", async () => {
      const loc = await ck1Location(db);
      // A pilot/demo brand homed at CK1, simulating seed-pilot.ts's output.
      const [dummy] = await db
        .insert(brands)
        .values({ locationId: loc.id, name: "Old Demo Brand", color: "#999999", salesPerfId: "old-demo-brand" })
        .returning();

      const result = await seedRealBrands(db);
      expect(result.deactivated).toContain("Old Demo Brand");

      const [afterRow] = await db.select().from(brands).where(eq(brands.id, dummy!.id));
      expect(afterRow).toBeTruthy(); // NEVER deleted
      expect(afterRow!.isActive).toBe(false);
    });

    it("idempotent double-run: identical counts, no duplicate brands/listings, nothing re-deactivated redundantly", async () => {
      const first = await seedRealBrands(db);
      const loc = await ck1Location(db);
      const brandsBefore = await db.select().from(brands).where(eq(brands.locationId, loc.id));
      const listingsBefore = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, loc.id));

      const second = await seedRealBrands(db);
      const brandsAfter = await db.select().from(brands).where(eq(brands.locationId, loc.id));
      const listingsAfter = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.locationId, loc.id));

      expect(second.locationId).toBe(first.locationId);
      expect(second.brandsCreated).toHaveLength(0); // all 6 reused on the 2nd run
      expect(second.brandsReused).toHaveLength(6);
      expect(brandsAfter.length).toBe(brandsBefore.length);
      expect(listingsAfter.length).toBe(listingsBefore.length);
    });

    it("resolves the outlet by name when the code lookup misses (fallback path)", async () => {
      const created = createDb();
      try {
        await runMigrations(created.db);
        const [renamedCodeLoc] = await created.db
          .insert(locations)
          .values({ code: "SOMETHING-ELSE", name: "CloudKitchen ONE", status: "ACTIVE" })
          .returning();
        const result = await seedRealBrands(created.db);
        expect(result.locationId).toBe(renamedCodeLoc!.id);
      } finally {
        await closeDb(created.client);
      }
    });
  });
});
