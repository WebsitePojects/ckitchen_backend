import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  aggregatorAccounts,
  brands,
  ingredients,
  inventoryStock,
  locations,
  orders,
  warehouses,
} from "../src/db/schema.js";

let db: DB;

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await runMigrations(db);
});

describe("schema: core tables + FK", () => {
  it("persists Location -> Brand -> AggregatorAccount with FKs intact", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "TST1", name: "Main Cloud Kitchen", address: "123 Test St" })
      .returning();
    expect(location.id).toBeTruthy();

    const [brand] = await db
      .insert(brands)
      .values({
        locationId: location.id,
        name: "Tokyo House",
        color: "#FF0000",
        salesPerfId: "tokyo-house",
      })
      .returning();
    expect(brand.id).toBeTruthy();
    expect(brand.locationId).toBe(location.id);

    const [account] = await db
      .insert(aggregatorAccounts)
      .values({
        brandId: brand.id,
        aggregator: "FOODPANDA",
        externalMerchantId: "FP-12345",
        credentialRef: "secret-ref-1",
      })
      .returning();
    expect(account.id).toBeTruthy();
    expect(account.brandId).toBe(brand.id);
    expect(account.aggregator).toBe("FOODPANDA");
  });

  it("rejects inserting a Brand with a non-existent location_id (FK enforced)", async () => {
    const fakeLocationId = "00000000-0000-0000-0000-000000000000";
    await expect(
      db.insert(brands).values({
        locationId: fakeLocationId,
        name: "Ghost Brand",
        color: "#000000",
        salesPerfId: "ghost",
      }),
    ).rejects.toThrow();
  });

  it("enforces UNIQUE (aggregator, external_ref) on order — idempotent ingestion", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "ORD1", name: "Loc for order test" })
      .returning();
    const [brand] = await db
      .insert(brands)
      .values({
        locationId: location.id,
        name: "Seoul Bowl",
        color: "#00FF00",
        salesPerfId: "seoul-bowl",
      })
      .returning();
    const [account] = await db
      .insert(aggregatorAccounts)
      .values({
        brandId: brand.id,
        aggregator: "GRABFOOD",
        externalMerchantId: "GF-999",
        credentialRef: "secret-ref-2",
      })
      .returning();

    const orderValues = {
      brandId: brand.id,
      aggregatorAccountId: account.id,
      aggregator: "GRABFOOD" as const,
      externalRef: "GF-ORDER-0001",
      customerName: "Jane Doe",
      status: "NEW" as const,
      total: "250.00",
    };

    const [firstOrder] = await db.insert(orders).values(orderValues).returning();
    expect(firstOrder.id).toBeTruthy();

    await expect(db.insert(orders).values(orderValues)).rejects.toThrow();
  });

  it("enforces UNIQUE (warehouse_id, ingredient_id) on inventory_stock", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "INV1", name: "Loc for inventory test" })
      .returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "MAIN" })
      .returning();
    const [ingredient] = await db
      .insert(ingredients)
      .values({
        name: "Chicken",
        unit: "g",
        unitCost: "0.25",
        lowStockThreshold: "5000",
      })
      .returning();

    const stockValues = {
      warehouseId: warehouse.id,
      ingredientId: ingredient.id,
      quantity: "10000",
    };

    const [stock] = await db.insert(inventoryStock).values(stockValues).returning();
    expect(stock.id).toBeTruthy();

    await expect(db.insert(inventoryStock).values(stockValues)).rejects.toThrow();
  });
});
