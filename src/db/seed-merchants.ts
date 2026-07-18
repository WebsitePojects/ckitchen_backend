/**
 * Real-merchant seed — the client's July 15 site-visit lists
 * (Documents/AGGREGATOR_API_INTEGRATION_SPEC.md §3): 15 foodpanda listings +
 * 9 GrabFood listings, chain-level, to be onboarded via Grab/foodpanda
 * partner-API access. Idempotently upserts brands + one channel listing per
 * (brand, aggregator) at the Central Kitchen outlet, all control_mode=DEVICE
 * — every listing keeps running on its merchant tablet/phone until the
 * client explicitly cuts a listing over (spec §5 cutover plan).
 *
 * NEVER stores real credentials (security.md): credential_ref is the
 * literal placeholder 'pending-api-onboarding', and external_merchant_id is
 * a deterministic script-local placeholder ("pending-<aggregator>-<brand-
 * slug>") until the Grab (Mandaluyong) / foodpanda (Delivery Hero) meetings
 * hand over real merchant/vendor ids (spec §3 meeting checklist). Because
 * that id is a placeholder, mapping_status is left at its DB default
 * MAPPING_REQUIRED — an operator must replace it with the real id
 * (enterprise-operations-foundation.md §8: "Migration never guesses:
 * ambiguous records become disabled MAPPING_REQUIRED exceptions until an
 * operator approves the mapping") before this listing can ever resolve a
 * live webhook.
 *
 * Central Kitchen (`CK` / "Central Kitchen") is the outlet enterprise-
 * operations-foundation.md §10's client-confirmed table names as the home of
 * "25 brand names pending" — it does not yet exist in any seed script, so
 * this one creates it idempotently (find-by-code, else insert) rather than
 * assuming it was seeded elsewhere.
 *
 * Brand reuse is case-insensitive EXACT name match only (no fuzzy/
 * punctuation normalization) — so e.g. foodpanda's "Yo Annyeong" and
 * GrabFood's "Yo' Annyeong" (and "Chicken Bar" / "The Chicken Bar") are
 * deliberately treated as DISTINCT brands here. The client's two source
 * lists carry a few near-duplicate spellings that a human should reconcile
 * through normal brand edit tooling once confirmed at the Grab/foodpanda
 * meetings — this script does the simple, literal, predictable thing
 * instead of guessing a fuzzy merge.
 *
 * Idempotent: safe to re-run. Brand-by-name and listing-by-(brand,
 * aggregator, location) lookups always reuse an existing row instead of
 * inserting a duplicate.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import { aggregatorAccounts, brandOutlet, brands, locations, type AggregatorAccount, type Brand } from "./schema.js";
import { runMigrations } from "./migrate.js";

const CK_LOCATION_CODE = "CK";
const CK_LOCATION_NAME = "Central Kitchen";

/** security.md: never store real credentials. This is a literal placeholder, not a secret. */
const CREDENTIAL_REF_PLACEHOLDER = "pending-api-onboarding";

export const FOODPANDA_MERCHANT_BRANDS = [
  "Timpla't Lasa",
  "Yo Annyeong",
  "Greek Alpha",
  "Verde Kitchen",
  "Kaina Manila",
  "Ciao Pasta",
  "BBCue",
  "Made in Tokyo",
  "Bread & Breakfast",
  "East Burger Bay",
  "Chicken Bar",
  "Khal by Khaleb Shawarma",
  "Panda Imperial",
  "Boba Bean",
  "Work Street",
] as const;

export const GRABFOOD_MERCHANT_BRANDS = [
  "Verde Kitchen",
  "Greek Alpha",
  "Panda Imperial",
  "Kaina Manila",
  "Yo' Annyeong",
  "Bowlfully Greens",
  "The Chicken Bar",
  "Timpla't Lasa",
  "Khal by Khaleb Shawarma",
] as const;

/** Deterministic, cosmetic-only accent color cycle — no client brand-color data exists yet. */
const PALETTE = [
  "#E63946",
  "#457B9D",
  "#2A9D8F",
  "#E9C46A",
  "#F4A261",
  "#264653",
  "#8338EC",
  "#3A86FF",
  "#FB5607",
  "#06D6A0",
];

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (accents only; apostrophes/ampersands are untouched here)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function findOrCreateCentralKitchen(db: DB) {
  const [existing] = await db.select().from(locations).where(eq(locations.code, CK_LOCATION_CODE));
  if (existing) return existing;
  const [created] = await db
    .insert(locations)
    .values({ code: CK_LOCATION_CODE, name: CK_LOCATION_NAME, status: "ACTIVE" })
    .returning();
  return created!;
}

async function findBrandByNameCI(db: DB, name: string): Promise<Brand | undefined> {
  const [row] = await db.select().from(brands).where(sql`lower(${brands.name}) = lower(${name})`);
  return row;
}

async function findOrCreateBrand(db: DB, name: string, locationId: string, colorIndex: number): Promise<Brand> {
  const existing = await findBrandByNameCI(db, name);
  if (existing) return existing;

  let brand!: Brand;
  await db.transaction(async (tx) => {
    [brand] = await tx
      .insert(brands)
      .values({
        locationId,
        name,
        color: colorFor(colorIndex),
        salesPerfId: slugFor(name),
      })
      .returning();
    // Home deployment (D30 brand_outlet), same as brands/routes.ts POST /brands.
    await tx.insert(brandOutlet).values({ brandId: brand.id, locationId, isActive: true }).onConflictDoNothing();
  });
  return brand;
}

async function findOrCreateListing(
  db: DB,
  brandId: string,
  locationId: string,
  aggregator: "FOODPANDA" | "GRABFOOD",
  placeholderExternalMerchantId: string,
): Promise<AggregatorAccount> {
  const [existing] = await db
    .select()
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.brandId, brandId),
        eq(aggregatorAccounts.aggregator, aggregator),
        eq(aggregatorAccounts.locationId, locationId),
      ),
    );
  if (existing) return existing;

  const [created] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId,
      locationId,
      aggregator,
      externalMerchantId: placeholderExternalMerchantId,
      credentialRef: CREDENTIAL_REF_PLACEHOLDER,
      controlMode: "DEVICE",
      // mappingStatus intentionally left at its DB default (MAPPING_REQUIRED)
      // — see module doc comment.
    })
    .returning();
  return created!;
}

export interface SeedMerchantsResult {
  locationId: string;
  brandsTouched: number;
  listingsTouched: number;
}

export async function seedMerchants(db: DB): Promise<SeedMerchantsResult> {
  await runMigrations(db);

  const ckLocation = await findOrCreateCentralKitchen(db);

  const entries: Array<{ name: string; aggregator: "FOODPANDA" | "GRABFOOD" }> = [
    ...FOODPANDA_MERCHANT_BRANDS.map((name) => ({ name, aggregator: "FOODPANDA" as const })),
    ...GRABFOOD_MERCHANT_BRANDS.map((name) => ({ name, aggregator: "GRABFOOD" as const })),
  ];

  const brandCache = new Map<string, Brand>(); // key: lower(name)
  let colorIndex = 0;
  let listingsTouched = 0;

  for (const entry of entries) {
    const cacheKey = entry.name.toLowerCase();
    let brand = brandCache.get(cacheKey);
    if (!brand) {
      brand = await findOrCreateBrand(db, entry.name, ckLocation.id, colorIndex);
      colorIndex += 1;
      brandCache.set(cacheKey, brand);
    }

    const placeholderExternalMerchantId = `pending-${entry.aggregator.toLowerCase()}-${slugFor(entry.name)}`;
    await findOrCreateListing(db, brand.id, ckLocation.id, entry.aggregator, placeholderExternalMerchantId);
    listingsTouched += 1;
  }

  return {
    locationId: ckLocation.id,
    brandsTouched: brandCache.size,
    listingsTouched,
  };
}

// `npm run seed:merchants` against the default file-backed client:
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb, closeDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });

  const result = await seedMerchants(db);
  console.log("Merchant seed complete.");
  console.log(`Central Kitchen location id: ${result.locationId}`);
  console.log(`Brands touched: ${result.brandsTouched}`);
  console.log(`Listings touched: ${result.listingsTouched}`);

  await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
}
