/**
 * apply-grab-store-ids (D48): makes the 9 accepting GrabFood stores resolvable.
 * Each test builds its own fresh PGlite that mirrors the live starting state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorAccounts, brandOutlet, brands, locations, warehouses } from "../src/db/schema.js";
import { resolveGrabListing } from "../src/modules/grab/service.js";
import { applyGrabStoreIds, formatReport, GRAB_STORES } from "../src/scripts/apply-grab-store-ids.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let ck1Id: string;

async function addBrand(name: string, opts: { isActive?: boolean } = {}): Promise<string> {
  const [row] = await db
    .insert(brands)
    .values({ locationId: ck1Id, name, color: "#123456", salesPerfId: name.toLowerCase(), isActive: opts.isActive ?? true })
    .returning({ id: brands.id });
  await db.insert(brandOutlet).values({ brandId: row!.id, locationId: ck1Id, isActive: true });
  return row!.id;
}

async function addListing(brandId: string, aggregator: "GRABFOOD" | "FOODPANDA", externalMerchantId: string): Promise<string> {
  const [row] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, locationId: ck1Id, aggregator, externalMerchantId, credentialRef: "pending-api-onboarding" })
    .returning({ id: aggregatorAccounts.id });
  return row!.id;
}

/** Mirrors live: CK1 with the placeholder address, 4 brands with a pending Grab listing, 2 Foodpanda-only brands, 1 demo brand. */
async function seedLiveLikeState(): Promise<void> {
  [{ id: ck1Id }] = await db
    .insert(locations)
    .values({ code: "CK1", name: "CloudKitchen ONE", address: "Prototype HQ" })
    .returning({ id: locations.id });

  for (const [name, slug] of [
    ["Kaina Manila", "kaina-manila"],
    ["Greek Alpha", "greek-alpha"],
    ["Panda Imperial", "panda-imperial"],
    ["The Chicken Bar", "the-chicken-bar"],
  ] as const) {
    await addListing(await addBrand(name), "GRABFOOD", `pending-grabfood-${slug}`);
  }
  await addListing(await addBrand("Timpla't Lasa"), "FOODPANDA", "pending-foodpanda-timpla-t-lasa");
  await addListing(await addBrand("Yo! Annyeong"), "FOODPANDA", "pending-foodpanda-yo-annyeong");

  const greenGarden = await addBrand("Green Garden", { isActive: false });
  await addListing(greenGarden, "GRABFOOD", "GF-GREENGAR");
  await addListing(greenGarden, "FOODPANDA", "FP-GREENGAR");
}

/** Full-table fingerprint, used to prove a run (or re-run) wrote nothing. */
async function fingerprint(): Promise<Record<string, unknown[]>> {
  const dump = async (query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: unknown[] }).rows;
  return {
    locations: await dump(sql`SELECT * FROM location ORDER BY code`),
    warehouses: await dump(sql`SELECT * FROM warehouse ORDER BY code`),
    brands: await dump(sql`SELECT * FROM brand ORDER BY name`),
    brandOutlet: await dump(sql`SELECT * FROM brand_outlet ORDER BY brand_id, location_id`),
    listings: await dump(sql`SELECT * FROM aggregator_account ORDER BY id`),
  };
}

beforeEach(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  await seedLiveLikeState();
});

afterEach(async () => {
  await closeDb(client);
});

describe("applyGrabStoreIds", () => {
  it("dry run changes nothing but reports the full plan", async () => {
    const before = await fingerprint();

    const report = await applyGrabStoreIds(db, { apply: false });

    expect(await fingerprint()).toEqual(before);
    expect(report.applied).toBe(false);
    expect(report.stores).toHaveLength(9);
    expect(report.stores.every((s) => s.change !== "unchanged")).toBe(true);
    console.log(formatReport(report));
  });

  it("apply makes all 9 ids resolve to the right brand and outlet", async () => {
    await applyGrabStoreIds(db, { apply: true });

    const [mtl] = await db.select().from(locations).where(eq(locations.code, "MTL"));
    expect(mtl).toBeDefined();

    for (const store of GRAB_STORES) {
      const resolved = await resolveGrabListing(db, store.externalStoreId);
      const [brand] = await db.select().from(brands).where(eq(brands.id, resolved.brandId));
      expect(brand?.name, store.externalStoreId).toBe(store.brandName);
      expect(resolved.locationId, store.externalStoreId).toBe(store.outletCode === "MTL" ? mtl!.id : ck1Id);

      const [deployment] = await db
        .select()
        .from(brandOutlet)
        .where(and(eq(brandOutlet.brandId, resolved.brandId), eq(brandOutlet.locationId, resolved.locationId!)));
      expect(deployment?.isActive, store.externalStoreId).toBe(true);
    }
  });

  it("creates MTL with its KITCHEN and OUTLET_STORAGE warehouses and updates the CK1 placeholder address", async () => {
    await applyGrabStoreIds(db, { apply: true });

    const [mtl] = await db.select().from(locations).where(eq(locations.code, "MTL"));
    expect(mtl).toMatchObject({ name: "Matalino Street" });
    const mtlWarehouses = await db.select().from(warehouses).where(eq(warehouses.locationId, mtl!.id));
    expect(mtlWarehouses.map((w) => [w.code, w.type, w.purpose, w.name]).sort()).toEqual([
      ["WH-MTL-KITCHEN", "KITCHEN", "KITCHEN", "Matalino Street Kitchen Inventory"],
      ["WH-MTL-OUTLET_STORAGE", "MAIN", "OUTLET_STORAGE", "Matalino Street Outlet Storage"],
    ]);

    const [ck1] = await db.select().from(locations).where(eq(locations.id, ck1Id));
    expect(ck1?.address).toBe("34 Matapang Street, Barangay Pinyahan, Quezon City");
  });

  it("does not overwrite a real CK1 address", async () => {
    await db.update(locations).set({ address: "Somewhere real" }).where(eq(locations.id, ck1Id));
    await applyGrabStoreIds(db, { apply: true });
    const [ck1] = await db.select().from(locations).where(eq(locations.id, ck1Id));
    expect(ck1?.address).toBe("Somewhere real");
  });

  it("keeps Wok Street and Panda Imperial as distinct brands with their own listings", async () => {
    await applyGrabStoreIds(db, { apply: true });

    const [wok] = await db.select().from(brands).where(eq(brands.name, "Wok Street"));
    const [panda] = await db.select().from(brands).where(eq(brands.name, "Panda Imperial"));
    expect(wok!.id).not.toBe(panda!.id);
    expect((await resolveGrabListing(db, "CK-GF-008")).brandId).toBe(wok!.id);
    expect((await resolveGrabListing(db, "CK-GF-009")).brandId).toBe(panda!.id);
  });

  it("deactivates only the GRABFOOD demo listing and leaves the same brand's FOODPANDA listing active", async () => {
    const report = await applyGrabStoreIds(db, { apply: true });

    const [grab] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.externalMerchantId, "GF-GREENGAR"));
    const [foodpanda] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.externalMerchantId, "FP-GREENGAR"));
    expect(grab?.isActive).toBe(false);
    expect(foodpanda?.isActive).toBe(true);
    expect(report.outOfScope).toEqual([{ aggregator: "FOODPANDA", externalMerchantId: "FP-GREENGAR", brandName: "Green Garden" }]);
  });

  it("a second apply is a no-op", async () => {
    await applyGrabStoreIds(db, { apply: true });
    const afterFirst = await fingerprint();

    const second = await applyGrabStoreIds(db, { apply: true });

    expect(await fingerprint()).toEqual(afterFirst);
    expect(second.stores.map((s) => s.change)).toEqual(Array(9).fill("unchanged"));
    expect(second.demoListings.filter((d) => d.action === "deactivated")).toEqual([]);
  });

  it("aborts and rolls everything back when another active GRABFOOD listing already holds an id", async () => {
    const intruder = await addBrand("Intruder Brand");
    await addListing(intruder, "GRABFOOD", "CK-GF-003");
    const before = await fingerprint();

    await expect(applyGrabStoreIds(db, { apply: true })).rejects.toThrow(/CK-GF-003.*already held/s);

    expect(await fingerprint()).toEqual(before);
  });

  it("aborts when a brand has several active GRABFOOD listings", async () => {
    const [greek] = await db.select().from(brands).where(eq(brands.name, "Greek Alpha"));
    await addListing(greek!.id, "GRABFOOD", "pending-grabfood-greek-alpha-2");
    const before = await fingerprint();

    await expect(applyGrabStoreIds(db, { apply: true })).rejects.toThrow(/Greek Alpha.*2 active GRABFOOD listings/s);

    expect(await fingerprint()).toEqual(before);
  });

  it("aborts when the CK1 outlet is missing instead of creating it", async () => {
    await db.update(locations).set({ code: "NOPE" }).where(eq(locations.id, ck1Id));
    await expect(applyGrabStoreIds(db, { apply: true })).rejects.toThrow(/"CK1" not found/);
  });
});
