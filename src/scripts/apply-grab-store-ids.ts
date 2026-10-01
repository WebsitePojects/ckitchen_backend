/**
 * Makes the 9 GrabFood stores that are ACCEPTING orders resolvable (decision D48,
 * .claude/memory/decisions.md in the parent repo).
 *
 * Grab sends our External Store ID as `partnerMerchantID` and resolveGrabListing()
 * rejects the order unless exactly one active GRABFOOD listing carries that value.
 * Before this script, 0 of the 9 stores resolved, so every Grab order would be
 * rejected.
 *
 * Everything runs inside ONE transaction. Dry run (the default) executes the
 * identical code path and then rolls back via a private sentinel, so the printed
 * plan is exactly what --apply would commit. Any ambiguity (a second candidate
 * listing, an ID already held by another active listing) aborts the whole run:
 * nothing is guessed, nothing is half-applied.
 *
 * Idempotent: a second --apply reports every store "unchanged". Never deletes
 * (orders FK to listings) and never writes a credential.
 *
 * Usage:  npm run grab:store-ids              (dry run)
 *         npm run grab:store-ids -- --apply   (commit)
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { grabListingIntegrations } from "../db/grab-schema.js";
import {
  aggregatorAccounts,
  brandOutlet,
  brands,
  locations,
  warehouses,
  type AggregatorAccount,
  type Brand,
  type Location,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Existing CloudKitchen ONE outlet. Resolved by code, never created here. */
const CK1_CODE = "CK1";

/** The base seed stores this placeholder; only a placeholder may be replaced with the real address. */
const CK1_PLACEHOLDER_ADDRESS = "Prototype HQ";
const CK1_REAL_ADDRESS = "34 Matapang St";

// PLACEHOLDER — confirm with client before --apply
// Bowlfully Greens is a separate physical site (D48 #4: Grab lists it at Matalino St,
// not 34 Matapang St), so it needs its own outlet and its own warehouses (cardinal rule 2).
const MTL_CODE = "MTL";
const MTL_NAME = "Matalino Street";
const MTL_ADDRESS = "Matalino St cnr Malakas St, Central District, Quezon City";

/**
 * `store -> brand -> home outlet` as agreed in the client's ORION_STORE_ID_MATRIX
 * (D48 #2). Wok Street and Panda Imperial are deliberately two separate brands (D48 #3).
 */
interface GrabStoreDef {
  externalStoreId: string;
  brandName: string;
  outletCode: string;
}
export const GRAB_STORES: readonly GrabStoreDef[] = [
  { externalStoreId: "CK-GF-001", brandName: "Kaina Manila", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-002", brandName: "Bowlfully Greens", outletCode: MTL_CODE },
  { externalStoreId: "CK-GF-003", brandName: "Greek Alpha", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-004", brandName: "Timpla't Lasa", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-005", brandName: "The Chicken Bar", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-006", brandName: "Yo! Annyeong", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-007", brandName: "Verde Kitchen", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-008", brandName: "Wok Street", outletCode: CK1_CODE },
  { externalStoreId: "CK-GF-009", brandName: "Panda Imperial", outletCode: CK1_CODE },
];

/**
 * Demo GRABFOOD listings (Green Garden, Manila Lechon, Seoul Bowl, Sip & Co, Tokyo
 * House; D48 #5). Deactivated, never deleted. Only their GRABFOOD rows are touched.
 */
export const DEMO_GRAB_EXTERNAL_IDS = [
  "GF-GREENGAR",
  "GF-MANILALE",
  "GF-SEOULBOW",
  "GF-SIPCO",
  "GF-TOKYOHOU",
] as const;

/** Prefix seed-real-brands.ts gives a GRABFOOD listing that still awaits its real id. */
const PLACEHOLDER_PREFIX = "pending-grabfood-";

/** security.md: a literal placeholder, not a secret. Same value seed-real-brands.ts uses. */
const CREDENTIAL_REF_PLACEHOLDER = "pending-api-onboarding";

/** Cosmetic accent for brands this script has to create; editable later in the admin UI. */
const NEW_BRAND_COLOR = "#2A9D8F";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

interface ListingSnapshot {
  externalMerchantId: string;
  outletCode: string | null;
  isActive: boolean;
  mappingStatus: string;
}

export interface StoreReport {
  externalStoreId: string;
  brandName: string;
  outletCode: string;
  brand: "created" | "reused";
  deployment: "created" | "reactivated" | "ok";
  before: ListingSnapshot | null;
  after: ListingSnapshot;
  /** "unchanged" only when no row was written for this store. */
  change: "created" | "updated" | "unchanged";
}

export interface ApplyGrabStoreIdsReport {
  applied: boolean;
  outlets: Array<{ code: string; action: string }>;
  stores: StoreReport[];
  demoListings: Array<{ externalMerchantId: string; brandName: string | null; action: string }>;
  /** Active non-GRABFOOD listings of the demo brands: intentionally left alone. */
  outOfScope: Array<{ aggregator: string; externalMerchantId: string; brandName: string }>;
}

/** Thrown inside the transaction to roll a dry run back; caught by nothing but applyGrabStoreIds. */
class DryRunRollback extends Error {
  constructor() {
    super("dry run rollback");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function describeListing(row: Pick<AggregatorAccount, "id" | "externalMerchantId" | "brandId">): string {
  return `listing ${row.id} (external_merchant_id=${row.externalMerchantId}, brand_id=${row.brandId})`;
}

async function ensureCk1(tx: Tx): Promise<{ outlet: Location; action: string }> {
  const [outlet] = await tx.select().from(locations).where(eq(locations.code, CK1_CODE));
  if (!outlet) {
    throw new Error(`apply-grab-store-ids: outlet code "${CK1_CODE}" not found. Run the base seed first; this script never creates it.`);
  }
  if (outlet.address !== CK1_PLACEHOLDER_ADDRESS) return { outlet, action: "found (address left as is)" };

  const [updated] = await tx.update(locations).set({ address: CK1_REAL_ADDRESS }).where(eq(locations.id, outlet.id)).returning();
  return { outlet: updated!, action: `address "${CK1_PLACEHOLDER_ADDRESS}" -> "${CK1_REAL_ADDRESS}"` };
}

/**
 * Creates the outlet with the two warehouses the outlets module gives every outlet (MAIN +
 * KITCHEN), named with the live enterprise convention (migration 0027 backfill). The module
 * creates no kitchen station, so neither do we. Warehouse inserts are conflict-tolerant so a
 * half-created outlet is completed instead of duplicated.
 */
async function ensureMtl(tx: Tx): Promise<{ outlet: Location; action: string }> {
  let outlet: Location | undefined;
  [outlet] = await tx.select().from(locations).where(eq(locations.code, MTL_CODE));
  const created = !outlet;
  if (!outlet) {
    [outlet] = await tx.insert(locations).values({ code: MTL_CODE, name: MTL_NAME, address: MTL_ADDRESS }).returning();
  }

  const addedWarehouses = await tx
    .insert(warehouses)
    .values([
      {
        locationId: outlet!.id,
        type: "KITCHEN",
        purpose: "KITCHEN",
        code: `WH-${MTL_CODE}-KITCHEN`,
        name: `${outlet!.name} Kitchen Inventory`,
      },
      {
        locationId: outlet!.id,
        type: "MAIN",
        purpose: "OUTLET_STORAGE",
        code: `WH-${MTL_CODE}-OUTLET_STORAGE`,
        name: `${outlet!.name} Outlet Storage`,
      },
    ])
    .onConflictDoNothing()
    .returning({ id: warehouses.id });

  if (created) return { outlet: outlet!, action: "created (with KITCHEN + OUTLET_STORAGE warehouses)" };
  if (addedWarehouses.length > 0) return { outlet: outlet!, action: `found; added ${addedWarehouses.length} missing warehouse(s)` };
  return { outlet: outlet!, action: "found (unchanged)" };
}

async function ensureBrand(tx: Tx, name: string, outlet: Location): Promise<{ brand: Brand; created: boolean }> {
  // Case-insensitive exact name, global — same convention as seed-real-brands.ts.
  const [existing] = await tx.select().from(brands).where(sql`lower(${brands.name}) = lower(${name})`);
  if (existing) return { brand: existing, created: false };

  const [brand] = await tx
    .insert(brands)
    .values({ locationId: outlet.id, name, color: NEW_BRAND_COLOR, salesPerfId: slugFor(name) })
    .returning();
  return { brand: brand!, created: true };
}

/** Ensures an active brand_outlet row; the brand's home location_id is never moved. */
async function ensureDeployment(tx: Tx, brandId: string, locationId: string): Promise<"created" | "reactivated" | "ok"> {
  const [existing] = await tx
    .select()
    .from(brandOutlet)
    .where(and(eq(brandOutlet.brandId, brandId), eq(brandOutlet.locationId, locationId)));
  if (!existing) {
    await tx.insert(brandOutlet).values({ brandId, locationId, isActive: true });
    return "created";
  }
  if (!existing.isActive) {
    await tx
      .update(brandOutlet)
      .set({ isActive: true })
      .where(and(eq(brandOutlet.brandId, brandId), eq(brandOutlet.locationId, locationId)));
    return "reactivated";
  }
  return "ok";
}

/**
 * Picks the brand's single GRABFOOD listing to carry the store id, or inserts one. More than
 * one active GRABFOOD listing, or one that already holds a different real id, is ambiguous:
 * abort rather than overwrite or leave the brand with two live listings.
 */
async function pickListing(tx: Tx, brand: Brand, store: GrabStoreDef): Promise<AggregatorAccount | null> {
  const active = await tx
    .select()
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.brandId, brand.id),
        eq(aggregatorAccounts.aggregator, "GRABFOOD"),
        eq(aggregatorAccounts.isActive, true),
      ),
    );

  if (active.length === 0) return null;
  if (active.length > 1) {
    throw new Error(
      `apply-grab-store-ids: brand "${brand.name}" has ${active.length} active GRABFOOD listings; cannot choose one for ${store.externalStoreId}: ` +
        active.map(describeListing).join("; "),
    );
  }

  const [only] = active;
  const isAssignable =
    only!.externalMerchantId === store.externalStoreId || only!.externalMerchantId.startsWith(PLACEHOLDER_PREFIX);
  if (!isAssignable) {
    throw new Error(
      `apply-grab-store-ids: brand "${brand.name}" already has an active GRABFOOD listing with a different id; refusing to overwrite for ${store.externalStoreId}: ${describeListing(only!)}`,
    );
  }
  return only!;
}

/**
 * resolveGrabListing matches on external_merchant_id OR api_merchant_id, and prefers a
 * grab_listing_integration row — so a clash on any of the three would make the id ambiguous
 * or route it to the wrong listing.
 */
async function assertIdHeldByNoOtherListing(tx: Tx, externalStoreId: string, keepListingId: string | null): Promise<void> {
  const holders = await tx
    .select()
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.aggregator, "GRABFOOD"),
        eq(aggregatorAccounts.isActive, true),
        or(
          eq(aggregatorAccounts.externalMerchantId, externalStoreId),
          eq(aggregatorAccounts.apiMerchantId, externalStoreId),
        ),
        keepListingId ? ne(aggregatorAccounts.id, keepListingId) : undefined,
      ),
    );
  if (holders.length > 0) {
    throw new Error(
      `apply-grab-store-ids: ${externalStoreId} is already held by another active GRABFOOD listing: ` +
        `${holders.map(describeListing).join("; ")}` +
        (keepListingId ? `; it would also be assigned to listing ${keepListingId}` : ""),
    );
  }

  const [integration] = await tx
    .select()
    .from(grabListingIntegrations)
    .where(eq(grabListingIntegrations.partnerMerchantId, externalStoreId));
  if (integration && integration.aggregatorAccountId !== keepListingId) {
    throw new Error(
      `apply-grab-store-ids: ${externalStoreId} is already mapped in grab_listing_integration to listing ${integration.aggregatorAccountId}, not the one this run would assign it to`,
    );
  }
}

async function snapshotOf(tx: Tx, row: AggregatorAccount): Promise<ListingSnapshot> {
  let outletCode: string | null = null;
  if (row.locationId) {
    const [loc] = await tx.select({ code: locations.code }).from(locations).where(eq(locations.id, row.locationId));
    outletCode = loc?.code ?? null;
  }
  return {
    externalMerchantId: row.externalMerchantId,
    outletCode,
    isActive: row.isActive,
    mappingStatus: row.mappingStatus,
  };
}

async function applyStore(tx: Tx, store: GrabStoreDef, outlet: Location): Promise<StoreReport> {
  const { brand, created: brandCreated } = await ensureBrand(tx, store.brandName, outlet);
  const deployment = await ensureDeployment(tx, brand.id, outlet.id);

  const listing = await pickListing(tx, brand, store);
  await assertIdHeldByNoOtherListing(tx, store.externalStoreId, listing?.id ?? null);

  let before: ListingSnapshot | null = null;
  let afterRow: AggregatorAccount;
  let listingWritten: boolean;

  if (!listing) {
    [afterRow] = await tx
      .insert(aggregatorAccounts)
      .values({
        brandId: brand.id,
        locationId: outlet.id,
        aggregator: "GRABFOOD",
        externalMerchantId: store.externalStoreId,
        credentialRef: CREDENTIAL_REF_PLACEHOLDER,
        controlMode: "DEVICE",
        isActive: true,
        mappingStatus: "RESOLVED",
      })
      .returning() as [AggregatorAccount];
    listingWritten = true;
  } else {
    before = await snapshotOf(tx, listing);
    const needsUpdate =
      listing.externalMerchantId !== store.externalStoreId ||
      listing.locationId !== outlet.id ||
      !listing.isActive ||
      listing.mappingStatus !== "RESOLVED";
    if (needsUpdate) {
      [afterRow] = await tx
        .update(aggregatorAccounts)
        .set({ externalMerchantId: store.externalStoreId, locationId: outlet.id, isActive: true, mappingStatus: "RESOLVED" })
        .where(eq(aggregatorAccounts.id, listing.id))
        .returning() as [AggregatorAccount];
    } else {
      afterRow = listing;
    }
    listingWritten = needsUpdate;
  }

  const anyWrite = brandCreated || deployment !== "ok" || listingWritten;
  return {
    externalStoreId: store.externalStoreId,
    brandName: brand.name,
    outletCode: store.outletCode,
    brand: brandCreated ? "created" : "reused",
    deployment,
    before,
    after: await snapshotOf(tx, afterRow),
    change: !anyWrite ? "unchanged" : listing ? "updated" : "created",
  };
}

async function deactivateDemoListings(tx: Tx): Promise<Pick<ApplyGrabStoreIdsReport, "demoListings" | "outOfScope">> {
  const demoRows = await tx
    .select({ row: aggregatorAccounts, brandName: brands.name })
    .from(aggregatorAccounts)
    .innerJoin(brands, eq(brands.id, aggregatorAccounts.brandId))
    .where(
      and(
        eq(aggregatorAccounts.aggregator, "GRABFOOD"),
        inArray(aggregatorAccounts.externalMerchantId, [...DEMO_GRAB_EXTERNAL_IDS]),
      ),
    );

  const demoListings: ApplyGrabStoreIdsReport["demoListings"] = [];
  for (const id of DEMO_GRAB_EXTERNAL_IDS) {
    const matches = demoRows.filter((m) => m.row.externalMerchantId === id);
    if (matches.length === 0) {
      demoListings.push({ externalMerchantId: id, brandName: null, action: "not found" });
      continue;
    }
    for (const { row, brandName } of matches) {
      if (!row.isActive) {
        demoListings.push({ externalMerchantId: id, brandName, action: "already inactive" });
        continue;
      }
      await tx.update(aggregatorAccounts).set({ isActive: false }).where(eq(aggregatorAccounts.id, row.id));
      demoListings.push({ externalMerchantId: id, brandName, action: "deactivated" });
    }
  }

  const demoBrandIds = [...new Set(demoRows.map((m) => m.row.brandId))];
  const outOfScope =
    demoBrandIds.length === 0
      ? []
      : await tx
          .select({
            aggregator: aggregatorAccounts.aggregator,
            externalMerchantId: aggregatorAccounts.externalMerchantId,
            brandName: brands.name,
          })
          .from(aggregatorAccounts)
          .innerJoin(brands, eq(brands.id, aggregatorAccounts.brandId))
          .where(
            and(
              inArray(aggregatorAccounts.brandId, demoBrandIds),
              ne(aggregatorAccounts.aggregator, "GRABFOOD"),
              eq(aggregatorAccounts.isActive, true),
            ),
          );

  return { demoListings, outOfScope };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies D48 to `db` in a single transaction. With `apply: false` the same code runs and is
 * then rolled back, so the returned report is a faithful preview and the DB is untouched.
 * Throws (rolling everything back) on any ambiguity.
 */
export async function applyGrabStoreIds(db: DB, { apply }: { apply: boolean }): Promise<ApplyGrabStoreIdsReport> {
  let report: ApplyGrabStoreIdsReport | undefined;

  try {
    await db.transaction(async (tx) => {
      const ck1 = await ensureCk1(tx);
      const mtl = await ensureMtl(tx);
      const outletsByCode = new Map<string, Location>([
        [CK1_CODE, ck1.outlet],
        [MTL_CODE, mtl.outlet],
      ]);

      const stores: StoreReport[] = [];
      for (const store of GRAB_STORES) {
        const outlet = outletsByCode.get(store.outletCode);
        if (!outlet) throw new Error(`apply-grab-store-ids: ${store.externalStoreId} references unknown outlet code "${store.outletCode}"`);
        stores.push(await applyStore(tx, store, outlet));
      }

      const demo = await deactivateDemoListings(tx);
      report = {
        applied: apply,
        outlets: [
          { code: CK1_CODE, action: ck1.action },
          { code: MTL_CODE, action: mtl.action },
        ],
        stores,
        ...demo,
      };

      if (!apply) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  return report!;
}

/** Human-readable plan/result. Contains no credentials: only ids, names and statuses. */
export function formatReport(report: ApplyGrabStoreIdsReport): string {
  const snap = (s: ListingSnapshot | null) =>
    s ? `${s.externalMerchantId} @${s.outletCode ?? "-"} ${s.isActive ? "active" : "inactive"} ${s.mappingStatus}` : "(no listing)";

  const lines: string[] = [report.applied ? "APPLIED (committed)" : "DRY RUN (rolled back, nothing written)", "", "Outlets"];
  for (const o of report.outlets) lines.push(`  ${o.code}: ${o.action}`);

  lines.push("", "GrabFood stores");
  for (const s of report.stores) {
    lines.push(
      `  ${s.externalStoreId}  ${s.brandName} -> ${s.outletCode}  [${s.change}]  brand ${s.brand}, deployment ${s.deployment}`,
      `      before: ${snap(s.before)}`,
      `      after:  ${snap(s.after)}`,
    );
  }

  lines.push("", "Demo GRABFOOD listings");
  for (const d of report.demoListings) lines.push(`  ${d.externalMerchantId}${d.brandName ? ` (${d.brandName})` : ""}: ${d.action}`);

  lines.push("", "Still active, not in scope (non-GRABFOOD rows of the demo brands)");
  if (report.outOfScope.length === 0) lines.push("  (none)");
  for (const r of report.outOfScope) lines.push(`  ${r.aggregator} ${r.externalMerchantId} (${r.brandName})`);

  lines.push("", "Menus are NOT created or copied here; all brands' menus (including the Wok Street / Panda Imperial duplicate) load later from the client's menu sheet.");
  return lines.join("\n");
}

// `npm run grab:store-ids [-- --apply]`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb, closeDb } = await import("../db/client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });

  try {
    const report = await applyGrabStoreIds(db, { apply: process.argv.includes("--apply") });
    console.log(formatReport(report));
    if (!report.applied) console.log("\nRe-run with --apply to commit.");
  } finally {
    await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
  }
}
