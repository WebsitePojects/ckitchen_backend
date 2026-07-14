/**
 * W4-2 — order_item.component_snapshot deduction coverage (spec §6/§7,
 * enterprise-operations-foundation.md).
 *
 * Cardinal rule under test: a recipe/BOM edit made AFTER an order is
 * accepted must NOT change what that order deducts. ingestOrder freezes
 * each item's recipe lines into order_item.component_snapshot at creation
 * time (unconditionally); advanceOrder's NEW→PREPARING deduction reads that
 * frozen snapshot ONLY when the `orders.legacy_recipe_snapshot` operational
 * feature flag (seeded false — drizzle/0032_w4_client_rules_foundation.sql)
 * is enabled. Flag off preserves the pre-W4-2 live recipe_lines read,
 * byte-for-byte.
 *
 * Scenarios:
 *   (a) flag ON  + recipe edited after order creation → advance deducts the
 *       ORIGINAL (snapshotted) quantities.
 *   (b) flag OFF + same edit-after-creation setup → advance deducts the
 *       EDITED live quantities (current/legacy behavior unchanged).
 *   (c) flag ON  + order_item.component_snapshot is NULL (pre-existing order
 *       placed before this column/feature shipped) → falls back to a live
 *       recipe_lines read; deduction still works.
 *   (d) cancel-after-PREPARING restock is exact via consumption_log in BOTH
 *       modes (ledger-driven restock is untouched by this change).
 *
 * Fixture setup mirrors test/listing-outlet-routing.test.ts (direct service
 * calls against a real migrated DB — no HTTP layer, no seed()).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  aggregatorAccounts,
  brands,
  consumptionLogs,
  ingredients,
  inventoryStock,
  kitchenStations,
  locations,
  menuItems,
  orderItems,
  orders,
  recipeLines,
  warehouses,
} from "../src/db/schema.js";
import { advanceOrder, cancelOrder, ingestOrder } from "../src/modules/orders/service.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let seq = 0;

const FLAG_KEY = "orders.legacy_recipe_snapshot";

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

async function setFlag(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, FLAG_KEY));
}

/** Fresh location + brand + RESOLVED listing + station + ingredient + recipe'd
 *  menu item + KITCHEN warehouse stocked with `initialStock`. Every fixture
 *  is fully isolated (own ingredient/menu item/warehouse) so tests never
 *  cross-contaminate stock balances. */
async function makeFixture(initialStock: string) {
  const s = `RS-${Date.now()}-${++seq}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `${s}-LOC`, name: `Recipe Snapshot ${s}` })
    .returning();
  const [brand] = await db
    .insert(brands)
    .values({
      locationId: location!.id,
      name: `Recipe Snapshot Brand ${s}`,
      color: "#ABCDEF",
      salesPerfId: `rs-${s}`,
    })
    .returning();
  const [listing] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "FOODPANDA",
      externalMerchantId: `FP-${s}`,
    })
    .returning();
  const [station] = await db
    .insert(kitchenStations)
    .values({ locationId: location!.id, name: `Grill ${s}` })
    .returning();
  const [ingredient] = await db
    .insert(ingredients)
    .values({
      code: `${s}-ING`,
      name: `Ingredient ${s}`,
      unit: "g",
      unitCost: "1.00",
      lowStockThreshold: "5",
    })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId: brand!.id,
      name: `Dish ${s}`,
      price: "180",
      stationId: station!.id,
    })
    .returning();
  const [recipeLine] = await db
    .insert(recipeLines)
    .values({ menuItemId: menuItem!.id, ingredientId: ingredient!.id, portionQty: "100", unit: "g" })
    .returning();
  const [warehouse] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `${s}-WH` })
    .returning();
  await db
    .insert(inventoryStock)
    .values({ warehouseId: warehouse!.id, ingredientId: ingredient!.id, quantity: initialStock });

  return {
    s,
    location: location!,
    brand: brand!,
    listing: listing!,
    station: station!,
    ingredient: ingredient!,
    menuItem: menuItem!,
    recipeLine: recipeLine!,
    warehouse: warehouse!,
  };
}

async function stockQty(warehouseId: string, ingredientId: string): Promise<number> {
  const [row] = await db
    .select({ quantity: inventoryStock.quantity })
    .from(inventoryStock)
    .where(eq(inventoryStock.warehouseId, warehouseId));
  return row ? Number(row.quantity) : NaN;
}

async function consumptionQty(orderId: string): Promise<number> {
  const rows = await db
    .select({ quantity: consumptionLogs.quantity })
    .from(consumptionLogs)
    .where(eq(consumptionLogs.orderId, orderId));
  return rows.reduce((sum, r) => sum + Number(r.quantity), 0);
}

// ---------------------------------------------------------------------------
// (a) flag ON: recipe edited after order creation → advance deducts the
//     ORIGINAL snapshotted quantities, not the edited ones.
// ---------------------------------------------------------------------------

describe("(a) flag ON: deduction uses the order's frozen snapshot, immune to a later recipe edit", () => {
  it("deducts 200 (2 x original portionQty=100), not 1000 (2 x edited portionQty=500)", async () => {
    const fx = await makeFixture("10000");

    const ingestResult = await ingestOrder(db, {
      brand_id: fx.brand.id,
      aggregator_account_id: fx.listing.id,
      aggregator: "FOODPANDA",
      external_ref: `${fx.s}-REF`,
      items: [{ menu_item_id: fx.menuItem.id, qty: 2 }],
    });
    const orderId = ingestResult.order_id;

    // Snapshot was captured at creation — assert it BEFORE the recipe edit.
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(item!.componentSnapshot).toEqual([
      { ingredientId: fx.ingredient.id, portionQty: "100.0000", uom: "g" },
    ]);

    // Recipe edited AFTER order acceptance — portionQty 100 -> 500.
    await db
      .update(recipeLines)
      .set({ portionQty: "500" })
      .where(eq(recipeLines.id, fx.recipeLine.id));

    await setFlag(true);
    const advanceResult = await advanceOrder(db, orderId);
    expect(advanceResult.status).toBe("PREPARING");

    // 10000 - 200 (2 x ORIGINAL 100), never 10000 - 1000 (2 x edited 500).
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(9800);
    expect(await consumptionQty(orderId)).toBe(200);

    await setFlag(false);
  });
});

// ---------------------------------------------------------------------------
// (b) flag OFF: same edit-after-creation setup → advance deducts the EDITED
//     live quantities (pre-W4-2 behavior is unchanged when the flag is off).
// ---------------------------------------------------------------------------

describe("(b) flag OFF: deduction still reads recipe_lines live (unchanged pre-W4-2 behavior)", () => {
  it("deducts 1000 (2 x edited portionQty=500), proving the snapshot is ignored when the flag is off", async () => {
    const fx = await makeFixture("10000");

    const ingestResult = await ingestOrder(db, {
      brand_id: fx.brand.id,
      aggregator_account_id: fx.listing.id,
      aggregator: "FOODPANDA",
      external_ref: `${fx.s}-REF`,
      items: [{ menu_item_id: fx.menuItem.id, qty: 2 }],
    });
    const orderId = ingestResult.order_id;

    await db
      .update(recipeLines)
      .set({ portionQty: "500" })
      .where(eq(recipeLines.id, fx.recipeLine.id));

    await setFlag(false); // explicit — this IS the seeded default
    const advanceResult = await advanceOrder(db, orderId);
    expect(advanceResult.status).toBe("PREPARING");

    // 10000 - 1000 (2 x EDITED 500) — legacy live-read behavior preserved.
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(9000);
    expect(await consumptionQty(orderId)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// (c) flag ON + NULL component_snapshot (order predates this column/feature)
//     → falls back to a live recipe_lines read; deduction still works.
// ---------------------------------------------------------------------------

describe("(c) flag ON + NULL snapshot: falls back to a live recipe_lines read", () => {
  it("deducts the current live portionQty when component_snapshot is NULL", async () => {
    const fx = await makeFixture("10000");

    // Simulate a pre-existing order_item written BEFORE this column/feature
    // existed: insert the order + order_item directly (bypassing ingestOrder,
    // which always writes an array — see schema.ts comment on the column).
    const [order] = await db
      .insert(orders)
      .values({
        brandId: fx.brand.id,
        locationId: fx.location.id,
        aggregatorAccountId: fx.listing.id,
        aggregator: "FOODPANDA",
        externalRef: `${fx.s}-LEGACY-REF`,
        order_code: `RS-${fx.s}-LEGACY`,
        status: "NEW",
        total: "180.00",
      })
      .returning();
    await db.insert(orderItems).values({
      orderId: order!.id,
      menuItemId: fx.menuItem.id,
      qty: 3,
      stationId: fx.station.id,
      componentSnapshot: null,
    });

    await setFlag(true);
    const advanceResult = await advanceOrder(db, order!.id);
    expect(advanceResult.status).toBe("PREPARING");

    // 10000 - 300 (3 x live portionQty=100) via the NULL-snapshot fallback.
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(9700);
    expect(await consumptionQty(order!.id)).toBe(300);

    await setFlag(false);
  });
});

// ---------------------------------------------------------------------------
// (d) cancel-after-PREPARING restock is exact via consumption_log, in BOTH
//     flag modes (the ledger — not the recipe — drives the restock).
// ---------------------------------------------------------------------------

describe("(d) cancel-after-PREPARING restocks exactly via consumption_log, in both flag modes", () => {
  it("flag ON: cancel restores the ORIGINAL (snapshot-deducted) 200 units exactly", async () => {
    const fx = await makeFixture("10000");

    const ingestResult = await ingestOrder(db, {
      brand_id: fx.brand.id,
      aggregator_account_id: fx.listing.id,
      aggregator: "FOODPANDA",
      external_ref: `${fx.s}-REF`,
      items: [{ menu_item_id: fx.menuItem.id, qty: 2 }],
    });
    const orderId = ingestResult.order_id;

    // Edit recipe after creation so a restock keyed off LIVE recipe (a bug)
    // would visibly diverge from a restock keyed off the ledger (correct).
    await db
      .update(recipeLines)
      .set({ portionQty: "999" })
      .where(eq(recipeLines.id, fx.recipeLine.id));

    await setFlag(true);
    await advanceOrder(db, orderId);
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(9800); // -200

    const cancelResult = await cancelOrder(db, orderId, "test: cancel after preparing (flag on)");
    expect(cancelResult.status).toBe("CANCELLED");
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(10000); // restored exactly

    // Double-cancel guard: consumption_log rows are deleted after restock.
    expect(await consumptionQty(orderId)).toBe(0);

    await setFlag(false);
  });

  it("flag OFF: cancel restores the LIVE-deducted 1000 units exactly", async () => {
    const fx = await makeFixture("10000");

    const ingestResult = await ingestOrder(db, {
      brand_id: fx.brand.id,
      aggregator_account_id: fx.listing.id,
      aggregator: "FOODPANDA",
      external_ref: `${fx.s}-REF`,
      items: [{ menu_item_id: fx.menuItem.id, qty: 2 }],
    });
    const orderId = ingestResult.order_id;

    await db
      .update(recipeLines)
      .set({ portionQty: "500" })
      .where(eq(recipeLines.id, fx.recipeLine.id));

    await setFlag(false);
    await advanceOrder(db, orderId);
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(9000); // -1000

    const cancelResult = await cancelOrder(db, orderId, "test: cancel after preparing (flag off)");
    expect(cancelResult.status).toBe("CANCELLED");
    expect(await stockQty(fx.warehouse.id, fx.ingredient.id)).toBe(10000); // restored exactly
    expect(await consumptionQty(orderId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additive write-path sanity: every order created via ingestOrder always
// gets a component_snapshot array (never NULL — NULL is reserved for
// pre-existing rows, see scenario (c)), regardless of the flag's state.
// ---------------------------------------------------------------------------

describe("write path: ingestOrder always snapshots component lines, flag-independent", () => {
  it("snapshot is written even while the flag is OFF (additive + harmless)", async () => {
    const fx = await makeFixture("10000");
    await setFlag(false);

    const ingestResult = await ingestOrder(db, {
      brand_id: fx.brand.id,
      aggregator_account_id: fx.listing.id,
      aggregator: "FOODPANDA",
      external_ref: `${fx.s}-REF`,
      items: [{ menu_item_id: fx.menuItem.id, qty: 1 }],
    });

    const [item] = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, ingestResult.order_id));
    expect(item!.componentSnapshot).toEqual([
      { ingredientId: fx.ingredient.id, portionQty: "100.0000", uom: "g" },
    ]);
  });
});
