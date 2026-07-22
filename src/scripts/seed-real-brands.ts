/**
 * Real-brand seed — CloudKitchen ONE site-visit findings (Documents/
 * July9_site_visit.md, Documents/July15_site_visit.md,
 * Documents/AGGREGATOR_API_INTEGRATION_SPEC.md).
 *
 * Idempotently ensures the 6 real, client-confirmed brands operating at the
 * "CloudKitchen ONE" outlet exist, each with its site-visit-observed channel
 * listing(s), and deactivates (is_active=false, NEVER deletes — deleting
 * would break FK'd orders, business-rules.md #8) any pre-existing demo/dummy
 * brand still homed at that outlet that is NOT one of the 6.
 *
 * The outlet is resolved AT RUNTIME by code ("CK1") or name ("CloudKitchen
 * ONE") — never assumed/created. If neither is found this throws a clear
 * error rather than silently seeding onto the wrong outlet (or creating a
 * duplicate one): run the base seed (`npm run seed`) first.
 *
 * Brand reuse is case-insensitive EXACT name match, GLOBAL (not location-
 * scoped) — same convention as src/db/seed-merchants.ts. If a brand with the
 * same name already exists with its HOME at a different outlet (e.g. from an
 * unrelated seed/script), this script does NOT silently rewrite that brand's
 * home location_id (a brand's identity/home is not this script's to move) —
 * it only ensures an ACTIVE brand_outlet deployment (D30) to CloudKitchen
 * ONE exists, so the brand genuinely operates there either way.
 *
 * NEVER stores real credentials (security.md): credential_ref stays the
 * literal placeholder 'pending-api-onboarding' and external_merchant_id is a
 * deterministic script-local placeholder until real Grab/foodpanda merchant
 * ids are confirmed. mapping_status is left at its DB default
 * (MAPPING_REQUIRED) for the same reason src/db/seed-merchants.ts does — an
 * operator must supply the real merchant id before a listing can ever
 * resolve a live webhook ("migration never guesses", enterprise-operations-
 * foundation.md §8).
 *
 * Idempotent: safe to re-run. Uses DATABASE_URL exactly like migrate.ts /
 * seed.ts (loadConfig()) — no hardcoded secrets, no credentials of any kind.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { aggregatorAccounts, brandOutlet, brands, locations, type AggregatorAccount, type Brand } from "../db/schema.js";

const CK1_LOCATION_CODE = "CK1";
const CK1_LOCATION_NAME = "CloudKitchen ONE";

/** security.md: never store a real credential. This is a literal placeholder, not a secret. */
const CREDENTIAL_REF_PLACEHOLDER = "pending-api-onboarding";

type Aggregator = "FOODPANDA" | "GRABFOOD";

interface RealBrandDef {
  name: string;
  listings: readonly Aggregator[];
}

// Site-visit evidence: the 6 real brands confirmed live at the CloudKitchen
// ONE outlet and which aggregator(s) each is listed on. Spelling is the
// literal site-visit spelling — deliberately NOT fuzzy-merged with any
// similarly-named brand a different script (e.g. seed-merchants.ts's "Yo
// Annyeong" / "Yo' Annyeong") may have created at a different outlet.
export const REAL_BRANDS: readonly RealBrandDef[] = [
  { name: "Panda Imperial", listings: ["GRABFOOD"] },
  { name: "Greek Alpha", listings: ["GRABFOOD"] },
  { name: "Kaina Manila", listings: ["GRABFOOD"] },
  { name: "Timpla't Lasa", listings: ["FOODPANDA"] },
  { name: "Yo! Annyeong", listings: ["FOODPANDA"] },
  { name: "The Chicken Bar", listings: ["GRABFOOD"] },
];

/** Deterministic, cosmetic-only accent color cycle — no client brand-color data exists yet. */
const PALETTE = ["#E63946", "#457B9D", "#2A9D8F", "#E9C46A", "#F4A261", "#264653"] as const;

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (accents only)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function findCk1Location(db: DB): Promise<typeof locations.$inferSelect> {
  const [byCode] = await db.select().from(locations).where(eq(locations.code, CK1_LOCATION_CODE));
  if (byCode) return byCode;

  const [byName] = await db.select().from(locations).where(eq(locations.name, CK1_LOCATION_NAME));
  if (byName) return byName;

  throw new Error(
    `seed-real-brands: could not find the "${CK1_LOCATION_NAME}" outlet (looked for location.code=` +
      `"${CK1_LOCATION_CODE}" or location.name="${CK1_LOCATION_NAME}"). Run the base seed ` +
      `(npm run seed) first, or create the outlet before re-running this script.`,
  );
}

async function findBrandByNameCI(db: DB, name: string): Promise<Brand | undefined> {
  const [row] = await db.select().from(brands).where(sql`lower(${brands.name}) = lower(${name})`);
  return row;
}

/** Idempotent: creates the brand_outlet row if missing, reactivates it if it was deactivated. */
async function ensureDeployedToOutlet(db: DB, brandId: string, locationId: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(brandOutlet)
    .where(and(eq(brandOutlet.brandId, brandId), eq(brandOutlet.locationId, locationId)));

  if (!existing) {
    await db.insert(brandOutlet).values({ brandId, locationId, isActive: true }).onConflictDoNothing();
    return;
  }
  if (!existing.isActive) {
    await db
      .update(brandOutlet)
      .set({ isActive: true })
      .where(and(eq(brandOutlet.brandId, brandId), eq(brandOutlet.locationId, locationId)));
  }
}

async function findOrCreateRealBrand(
  db: DB,
  name: string,
  ck1Id: string,
  colorIndex: number,
): Promise<{ brand: Brand; created: boolean }> {
  const existing = await findBrandByNameCI(db, name);
  if (existing) {
    await ensureDeployedToOutlet(db, existing.id, ck1Id);
    return { brand: existing, created: false };
  }

  let brand!: Brand;
  await db.transaction(async (tx) => {
    [brand] = await tx
      .insert(brands)
      .values({ locationId: ck1Id, name, color: colorFor(colorIndex), salesPerfId: slugFor(name) })
      .returning();
    // Home deployment (D30 brand_outlet), same as brands/routes.ts POST /brands.
    await tx.insert(brandOutlet).values({ brandId: brand.id, locationId: ck1Id, isActive: true }).onConflictDoNothing();
  });
  return { brand, created: true };
}

async function findOrCreateListing(
  db: DB,
  brandId: string,
  ck1Id: string,
  aggregator: Aggregator,
  placeholderExternalMerchantId: string,
): Promise<{ listing: AggregatorAccount; created: boolean }> {
  const [existing] = await db
    .select()
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.brandId, brandId),
        eq(aggregatorAccounts.aggregator, aggregator),
        eq(aggregatorAccounts.locationId, ck1Id),
      ),
    );
  if (existing) return { listing: existing, created: false };

  const [created] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId,
      locationId: ck1Id,
      aggregator,
      externalMerchantId: placeholderExternalMerchantId,
      credentialRef: CREDENTIAL_REF_PLACEHOLDER,
      controlMode: "DEVICE",
      // mappingStatus intentionally left at its DB default (MAPPING_REQUIRED)
      // — see module doc comment.
    })
    .returning();
  return { listing: created!, created: true };
}

export interface SeedRealBrandsResult {
  locationId: string;
  brandsCreated: string[];
  brandsReused: string[];
  listingsCreated: string[];
  listingsReused: string[];
  deactivated: string[];
}

export async function seedRealBrands(db: DB): Promise<SeedRealBrandsResult> {
  await runMigrations(db);

  const ck1 = await findCk1Location(db);

  const brandsCreated: string[] = [];
  const brandsReused: string[] = [];
  const listingsCreated: string[] = [];
  const listingsReused: string[] = [];
  const keptBrandIds = new Set<string>();

  let colorIndex = 0;
  for (const def of REAL_BRANDS) {
    const { brand, created } = await findOrCreateRealBrand(db, def.name, ck1.id, colorIndex);
    colorIndex += 1;
    keptBrandIds.add(brand.id);
    if (created) brandsCreated.push(def.name);
    else brandsReused.push(def.name);

    for (const aggregator of def.listings) {
      const placeholder = `pending-${aggregator.toLowerCase()}-${slugFor(def.name)}`;
      const { created: listingCreated } = await findOrCreateListing(db, brand.id, ck1.id, aggregator, placeholder);
      const label = `${def.name} (${aggregator})`;
      if (listingCreated) listingsCreated.push(label);
      else listingsReused.push(label);
    }
  }

  // Deactivate (is_active=false, NEVER delete) any existing demo/dummy brand
  // still HOMED at CloudKitchen ONE that is not one of the 6 real brands
  // above. Deleting would break FK'd orders (business-rules.md #8) — the
  // brand's whole history (menu, orders, listings) stays intact, just hidden
  // from active use.
  const homeBrandsAtCk1 = await db
    .select()
    .from(brands)
    .where(and(eq(brands.locationId, ck1.id), eq(brands.isActive, true)));

  const deactivated: string[] = [];
  for (const b of homeBrandsAtCk1) {
    if (keptBrandIds.has(b.id)) continue;
    await db.update(brands).set({ isActive: false }).where(eq(brands.id, b.id));
    deactivated.push(b.name);
  }

  return {
    locationId: ck1.id,
    brandsCreated,
    brandsReused,
    listingsCreated,
    listingsReused,
    deactivated,
  };
}

// `npm run seed:real-brands` against the default file-backed client:
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb, closeDb } = await import("../db/client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });

  const result = await seedRealBrands(db);

  console.log("Real-brand seed complete.");
  console.log(`CloudKitchen ONE location id: ${result.locationId}`);
  console.log(`\nBrands created (${result.brandsCreated.length}): ${result.brandsCreated.join(", ") || "(none)"}`);
  console.log(`Brands reused  (${result.brandsReused.length}): ${result.brandsReused.join(", ") || "(none)"}`);
  console.log(`\nListings created (${result.listingsCreated.length}): ${result.listingsCreated.join(", ") || "(none)"}`);
  console.log(`Listings reused  (${result.listingsReused.length}): ${result.listingsReused.join(", ") || "(none)"}`);
  console.log(`\nDeactivated demo/dummy brands (${result.deactivated.length}): ${result.deactivated.join(", ") || "(none)"}`);

  await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
}
