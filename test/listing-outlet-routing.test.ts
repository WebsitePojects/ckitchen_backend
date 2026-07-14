import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  aggregatorAccounts,
  brandOutlet,
  brands,
  ingredients,
  inventoryStock,
  kitchenStations,
  locations,
  menuItems,
  orders,
  printJobs,
  recipeLines,
  stockReservations,
  warehouses,
} from "../src/db/schema.js";
import {
  AmbiguousListingError,
  ListingMappingRequiredError,
  ingestOrder,
} from "../src/modules/orders/service.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

describe("listing-owned outlet routing", () => {
  it("quarantines an unresolved multi-outlet listing before any downstream side effect", async () => {
    const [scs, acc, acc2] = await db
      .insert(locations)
      .values([
        { code: "LOR-SCS", name: "SM Cubao Supermarket" },
        { code: "LOR-ACC", name: "Araneta Coliseum Cubao" },
        { code: "LOR-ACC2", name: "Araneta Coliseum Cubao 2" },
      ])
      .returning();
    const [brand] = await db
      .insert(brands)
      .values({
        locationId: scs.id,
        name: "Greek Alpha Unresolved",
        color: "#123456",
        salesPerfId: "greek-alpha-unresolved",
      })
      .returning();
    await db.insert(brandOutlet).values([
      { brandId: brand.id, locationId: scs.id },
      { brandId: brand.id, locationId: acc.id },
      { brandId: brand.id, locationId: acc2.id },
    ]);
    const [listing] = await db
      .insert(aggregatorAccounts)
      .values({
        brandId: brand.id,
        aggregator: "FOODPANDA",
        externalMerchantId: "FP-GA-UNRESOLVED",
        mappingStatus: "MAPPING_REQUIRED",
      })
      .returning();

    const beforeOrders = (await db.select({ id: orders.id }).from(orders)).length;
    const beforeReservations = (await db.select({ id: stockReservations.id }).from(stockReservations)).length;
    const beforePrintJobs = (await db.select({ id: printJobs.id }).from(printJobs)).length;
    await expect(
      ingestOrder(db, {
        brand_id: brand.id,
        aggregator_account_id: listing.id,
        aggregator: "FOODPANDA",
        external_ref: "UNRESOLVED-1",
        items: [{ menu_item_id: "00000000-0000-0000-0000-000000000001", qty: 1 }],
      }),
    ).rejects.toBeInstanceOf(ListingMappingRequiredError);
    expect((await db.select({ id: orders.id }).from(orders)).length).toBe(beforeOrders);
    expect((await db.select({ id: stockReservations.id }).from(stockReservations)).length).toBe(
      beforeReservations,
    );
    expect((await db.select({ id: printJobs.id }).from(printJobs)).length).toBe(beforePrintJobs);
  });

  it("requires an account id when one brand has multiple resolved listings", async () => {
    const [home, second] = await db
      .insert(locations)
      .values([
        { code: "LOR-AMB1", name: "Ambiguous One" },
        { code: "LOR-AMB2", name: "Ambiguous Two" },
      ])
      .returning();
    const [brand] = await db
      .insert(brands)
      .values({
        locationId: home.id,
        name: "Greek Alpha Ambiguous",
        color: "#654321",
        salesPerfId: "greek-alpha-ambiguous",
      })
      .returning();
    await db.insert(aggregatorAccounts).values([
      {
        brandId: brand.id,
        locationId: home.id,
        mappingStatus: "RESOLVED",
        aggregator: "GRABFOOD",
        externalMerchantId: "GF-AMB-1",
      },
      {
        brandId: brand.id,
        locationId: second.id,
        mappingStatus: "RESOLVED",
        aggregator: "GRABFOOD",
        externalMerchantId: "GF-AMB-2",
      },
    ]);
    await expect(
      ingestOrder(db, {
        brand_id: brand.id,
        aggregator: "GRABFOOD",
        external_ref: "AMB-1",
        items: [{ menu_item_id: "00000000-0000-0000-0000-000000000001", qty: 1 }],
      }),
    ).rejects.toBeInstanceOf(AmbiguousListingError);
  });

  it("routes identical external refs to the correct outlet stock, station, and order snapshot", async () => {
    const [scs, acc, acc2] = await db
      .insert(locations)
      .values([
        { code: "LOR2-SCS", name: "SM Cubao Supermarket" },
        { code: "LOR2-ACC", name: "Araneta Coliseum Cubao" },
        { code: "LOR2-ACC2", name: "Araneta Coliseum Cubao 2" },
      ])
      .returning();
    const [brand] = await db
      .insert(brands)
      .values({
        locationId: scs.id,
        name: "Greek Alpha Routed",
        color: "#00AA66",
        salesPerfId: "greek-alpha-routed",
      })
      .returning();
    await db.insert(brandOutlet).values([
      { brandId: brand.id, locationId: scs.id },
      { brandId: brand.id, locationId: acc.id },
      { brandId: brand.id, locationId: acc2.id },
    ]);
    const [accListing, acc2Listing] = await db
      .insert(aggregatorAccounts)
      .values([
        {
          brandId: brand.id,
          locationId: acc.id,
          mappingStatus: "RESOLVED",
          aggregator: "FOODPANDA",
          externalMerchantId: "FP-GA-ACC",
        },
        {
          brandId: brand.id,
          locationId: acc2.id,
          mappingStatus: "RESOLVED",
          aggregator: "FOODPANDA",
          externalMerchantId: "FP-GA-ACC2",
        },
      ])
      .returning();
    const [accStation, acc2Station] = await db
      .insert(kitchenStations)
      .values([
        { locationId: acc.id, name: "ACC Grill" },
        { locationId: acc2.id, name: "ACC2 Grill" },
      ])
      .returning();
    const [item] = await db
      .insert(ingredients)
      .values({
        code: "LOR2-ROAST",
        name: "Roast Chicken Output",
        unit: "pcs",
        itemType: "FINISHED_GOOD",
        unitCost: "120",
        lowStockThreshold: "5",
      })
      .returning();
    const [menuItem] = await db
      .insert(menuItems)
      .values({
        brandId: brand.id,
        name: "Roast Chicken",
        price: "299",
        stationId: accStation.id,
        consumptionMode: "STOCKED_OUTPUT",
        stockItemId: item.id,
      })
      .returning();
    await db.insert(recipeLines).values({
      menuItemId: menuItem.id,
      ingredientId: item.id,
      portionQty: "1",
      unit: "pcs",
    });
    await db.insert(menuItemOutlets).values([
      { menuItemId: menuItem.id, locationId: acc.id, stationId: accStation.id },
      { menuItemId: menuItem.id, locationId: acc2.id, stationId: acc2Station.id },
    ]);
    const [accKitchen, acc2Kitchen] = await db
      .insert(warehouses)
      .values([
        { locationId: acc.id, type: "KITCHEN", purpose: "KITCHEN", code: "LOR2-WH-ACC" },
        { locationId: acc2.id, type: "KITCHEN", purpose: "KITCHEN", code: "LOR2-WH-ACC2" },
      ])
      .returning();
    await db.insert(inventoryStock).values([
      { warehouseId: accKitchen.id, ingredientId: item.id, quantity: "100" },
      { warehouseId: acc2Kitchen.id, ingredientId: item.id, quantity: "100" },
    ]);

    const sharedRef = "FP-SAME-REF-100";
    const first = await ingestOrder(db, {
      brand_id: brand.id,
      aggregator_account_id: accListing.id,
      aggregator: "FOODPANDA",
      external_ref: sharedRef,
      items: [{ menu_item_id: menuItem.id, qty: 2 }],
    });
    const second = await ingestOrder(db, {
      brand_id: brand.id,
      aggregator_account_id: acc2Listing.id,
      aggregator: "FOODPANDA",
      external_ref: sharedRef,
      items: [{ menu_item_id: menuItem.id, qty: 3 }],
    });
    expect(first.location_id).toBe(acc.id);
    expect(second.location_id).toBe(acc2.id);

    const createdOrders = await db
      .select()
      .from(orders)
      .where(inArray(orders.id, [first.order_id, second.order_id]));
    expect(new Map(createdOrders.map((row) => [row.id, row.locationId]))).toEqual(
      new Map([
        [first.order_id, acc.id],
        [second.order_id, acc2.id],
      ]),
    );
    const reservations = await db
      .select()
      .from(stockReservations)
      .where(inArray(stockReservations.orderId, [first.order_id, second.order_id]));
    expect(new Set(reservations.map((row) => row.warehouseId))).toEqual(
      new Set([accKitchen.id, acc2Kitchen.id]),
    );
    const jobs = await db
      .select()
      .from(printJobs)
      .where(inArray(printJobs.orderId, [first.order_id, second.order_id]));
    expect(new Set(jobs.map((row) => row.stationId))).toEqual(
      new Set([accStation.id, acc2Station.id]),
    );
  });
});
