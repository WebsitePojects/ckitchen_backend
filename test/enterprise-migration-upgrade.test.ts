import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import {
  inventoryLotBalances,
  inventoryLots,
  listingMigrationExceptions,
  operationalFeatureFlags,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import {
  ingredients,
  warehouses,
} from "../src/db/schema.js";

const MIGRATIONS = resolve(process.cwd(), "drizzle");
let db: DB;
let client: PGlite;

async function applySqlFile(name: string): Promise<void> {
  const body = readFileSync(resolve(MIGRATIONS, name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "\n",
  );
  await client.transaction(async (tx) => {
    await tx.exec(body);
  });
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client as PGlite;
  const baseMigrations = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 26)
    .sort();
  for (const migration of baseMigrations) await applySqlFile(migration);
});

afterAll(async () => {
  await closeDb(client);
});

describe("migration 0027 production-like upgrade", () => {
  it("backfills a legacy single-outlet database without changing inventory totals", async () => {
    // Seed through legacy SQL: the current Drizzle model intentionally contains
    // columns that do not exist until migration 0027 has been applied.
    const location = { id: randomUUID() };
    const brand = { id: randomUUID() };
    const listing = { id: randomUUID() };
    const main = { id: randomUUID() };
    const kitchenId = randomUUID();
    const item = { id: randomUUID() };
    const legacyStock = { id: randomUUID() };
    await client.query(
      `insert into location (id, code, name) values ($1, 'UPG-CK', 'Legacy Central Kitchen')`,
      [location.id],
    );
    await client.query(
      `insert into brand (id, location_id, name, color, sales_perf_id)
       values ($1, $2, 'Legacy Greek Alpha', '#008855', 'legacy-greek-alpha')`,
      [brand.id, location.id],
    );
    await client.query(
      `insert into brand_outlet (brand_id, location_id) values ($1, $2)`,
      [brand.id, location.id],
    );
    await client.query(
      `insert into aggregator_account (id, brand_id, aggregator, external_merchant_id)
       values ($1, $2, 'FOODPANDA', 'UPG-FP-1')`,
      [listing.id, brand.id],
    );
    await client.query(
      `insert into warehouse (id, location_id, type) values ($1, $2, 'MAIN'), ($3, $2, 'KITCHEN')`,
      [main.id, location.id, kitchenId],
    );
    await client.query(
      `insert into ingredient (id, name, unit, unit_cost, low_stock_threshold)
       values ($1, 'Legacy Chicken', 'kg', 150, 10)`,
      [item.id],
    );
    await client.query(
      `insert into inventory_stock (id, warehouse_id, ingredient_id, quantity)
       values ($1, $2, $3, 123.4567)`,
      [legacyStock.id, main.id, item.id],
    );

    await applySqlFile("0027_enterprise_operations_foundation.sql");

    const [migratedItem] = await db.select().from(ingredients).where(eq(ingredients.id, item.id));
    expect(migratedItem.code).toMatch(/^ITM-[A-F0-9]{12}$/);
    const [migratedMain] = await db.select().from(warehouses).where(eq(warehouses.id, main.id));
    expect(migratedMain).toMatchObject({ purpose: "HQ_MAIN", isActive: true });
    // Migration 0035 (outbound aggregator commands) later added control_mode/
    // api_merchant_id to aggregator_account — columns this deliberately-
    // frozen-at-0027 physical table does not have yet. A raw-SQL read (like
    // the legacy inserts above) checks only the columns 0027 itself owns,
    // instead of `db.select().from(aggregatorAccounts)`, which would select
    // every column the LIVE Drizzle model knows about and fail with
    // "column does not exist" against this intentionally-partial schema.
    const { rows: migratedListingRows } = await client.query<{ location_id: string; mapping_status: string }>(
      `select location_id, mapping_status from aggregator_account where id = $1`,
      [listing.id],
    );
    expect(migratedListingRows[0]).toMatchObject({
      location_id: location.id,
      mapping_status: "RESOLVED",
    });
    expect(
      await db
        .select()
        .from(listingMigrationExceptions)
        .where(eq(listingMigrationExceptions.aggregatorAccountId, listing.id)),
    ).toHaveLength(0);
    expect(await db.select().from(topologyMigrationExceptions)).toHaveLength(0);

    const [openingLot] = await db
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.sourceDocumentId, legacyStock.id));
    const [openingBalance] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.lotId, openingLot.id));
    expect(openingBalance).toMatchObject({ warehouseId: main.id, onHand: "123.456700" });
    const flags = await db.select().from(operationalFeatureFlags);
    expect(flags.length).toBeGreaterThanOrEqual(8);
    expect(flags.every((flag) => flag.enabled === false)).toBe(true);

    // The hand-written migration is intentionally replay-safe for controlled
    // forward-fix rehearsal; deterministic rows/indexes must not duplicate.
    await applySqlFile("0027_enterprise_operations_foundation.sql");
    expect(
      await db
        .select()
        .from(inventoryLots)
        .where(eq(inventoryLots.sourceDocumentId, legacyStock.id)),
    ).toHaveLength(1);
  });
});
