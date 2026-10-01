/**
 * Migration 0040: at most ONE active channel listing per (aggregator, external_merchant_id).
 * resolveGrabListing / the foodpanda resolver 404 unless exactly one active row matches,
 * so the database must refuse a second one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorAccounts, brands, locations } from "../src/db/schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let brandId: string;
let locationId: string;

type Aggregator = "FOODPANDA" | "GRABFOOD";

function insertAccount(aggregator: Aggregator, externalMerchantId: string, isActive: boolean) {
  return db.insert(aggregatorAccounts).values({ brandId, locationId, aggregator, externalMerchantId, isActive });
}

/** drizzle wraps the driver error; the Postgres message lives on the cause chain. */
async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "insert should have been rejected").not.toBeNull();
  const messages: string[] = [];
  for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    messages.push(String(e.message));
  }
  expect(messages.join(" | ")).toMatch(/aggregator_account_active_external_id_unique|duplicate key/i);
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  [{ id: locationId }] = await db.insert(locations).values({ code: "T40", name: "Test 0040" }).returning({ id: locations.id });
  [{ id: brandId }] = await db
    .insert(brands)
    .values({ locationId, name: "Brand 0040", color: "#000000", salesPerfId: "brand-0040" })
    .returning({ id: brands.id });
});

afterAll(async () => {
  await closeDb(client);
});

describe("migration 0040 aggregator_account active external id uniqueness", () => {
  it("creates the index as partial on is_active = true", async () => {
    const result = await db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'aggregator_account_active_external_id_unique'
    `);
    const [row] = (result as unknown as { rows: Array<{ indexdef: string }> }).rows;
    expect(row?.indexdef).toMatch(/UNIQUE/i);
    expect(row?.indexdef).toMatch(/is_active/);
  });

  it("rejects a second ACTIVE account with the same (aggregator, external_merchant_id)", async () => {
    await insertAccount("GRABFOOD", "DUP-ACTIVE", true);
    await expectUniqueViolation(insertAccount("GRABFOOD", "DUP-ACTIVE", true));
  });

  it("allows the same pair when one of the rows is inactive", async () => {
    await insertAccount("GRABFOOD", "HISTORY-ID", false);
    await insertAccount("GRABFOOD", "HISTORY-ID", true);
    // Inactive rows may pile up: deactivated history must never block reuse.
    await insertAccount("GRABFOOD", "HISTORY-ID", false);

    const result = await db.execute(sql`SELECT count(*)::int AS n FROM aggregator_account WHERE external_merchant_id = 'HISTORY-ID'`);
    expect((result as unknown as { rows: Array<{ n: number }> }).rows[0]?.n).toBe(3);
  });

  it("allows the same external id under a different aggregator", async () => {
    await insertAccount("GRABFOOD", "CROSS-AGG", true);
    await insertAccount("FOODPANDA", "CROSS-AGG", true);
  });
});
