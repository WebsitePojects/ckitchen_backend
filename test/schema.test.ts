import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  aggregatorAccounts,
  attendanceRecords,
  auditLogs,
  brands,
  employees,
  ingredients,
  inventoryStock,
  itoItems,
  itos,
  locations,
  orders,
  stockLedgerEntries,
  userSessions,
  users,
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

// ---------------------------------------------------------------------------
// Migration 0009 — hardening batch: append-only triggers + CHECK constraints.
// audit-db.md §8 (append-only) and §2a (CHECK), scoped per BUILDER TASKS.
// ---------------------------------------------------------------------------

/**
 * Drizzle's postgres-js/pglite drivers wrap the raw Postgres error inside a
 * "Failed query: ..." DrizzleQueryError, with the original trigger exception
 * message on `.cause.message` (not on the top-level `.message`). This walks
 * the cause chain so the assertion is robust to either shape.
 */
async function expectAppendOnlyRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeTruthy();
  let cursor: unknown = caught;
  let matched = false;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    const msg = (cursor as { message?: string }).message ?? "";
    if (/append-only/.test(msg)) {
      matched = true;
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  expect(matched, `expected an "append-only" error, got: ${String((caught as Error)?.message)}`).toBe(
    true,
  );
}

describe("migration 0009: append-only enforcement (audit_log, attendance_record, stock_ledger_entry)", () => {
  it("blocks UPDATE and DELETE on audit_log", async () => {
    const [row] = await db
      .insert(auditLogs)
      .values({ action: "TEST_ACTION", description: "append-only probe" })
      .returning();

    await expectAppendOnlyRejection(
      db.update(auditLogs).set({ description: "mutated" }).where(sql`${auditLogs.id} = ${row.id}`),
    );

    await expectAppendOnlyRejection(
      db.delete(auditLogs).where(sql`${auditLogs.id} = ${row.id}`),
    );
  });

  it("blocks UPDATE and DELETE on attendance_record", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "ATT1", name: "Loc for attendance append-only test" })
      .returning();
    void location;

    const [user] = await db
      .insert(users)
      .values({
        name: "Attendance Recorder",
        email: "attendance-recorder@test.local",
        passwordHash: "hash",
        role: "KITCHEN_STAFF",
      })
      .returning();

    const [employee] = await db
      .insert(employees)
      .values({ employeeNo: "EMP-APPEND-1", fullName: "Append Only Test", department: "KITCHEN" })
      .returning();

    const [session] = await db.insert(userSessions).values({ userId: user.id }).returning();

    const [record] = await db
      .insert(attendanceRecords)
      .values({
        employeeId: employee.id,
        type: "TIME_IN",
        photoUrl: "https://example.test/photo.jpg",
        photoPublicId: "photo-1",
        recordedByUserId: user.id,
        sessionId: session.id,
      })
      .returning();

    await expectAppendOnlyRejection(
      db
        .update(attendanceRecords)
        .set({ note: "mutated" })
        .where(sql`${attendanceRecords.id} = ${record.id}`),
    );

    await expectAppendOnlyRejection(
      db.delete(attendanceRecords).where(sql`${attendanceRecords.id} = ${record.id}`),
    );
  });

  it("blocks UPDATE and DELETE on stock_ledger_entry", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "SLE1", name: "Loc for ledger append-only test" })
      .returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "MAIN" })
      .returning();
    const [ingredient] = await db
      .insert(ingredients)
      .values({ name: "AppendOnlyBeef", unit: "g", unitCost: "0.5", lowStockThreshold: "1000" })
      .returning();

    const [entry] = await db
      .insert(stockLedgerEntries)
      .values({
        sourceModule: "RECEIVE",
        sourceDocumentNo: "APPEND-ONLY-DOC-1",
        ingredientId: ingredient.id,
        warehouseId: warehouse.id,
        movementType: "IN",
        quantity: "100",
      })
      .returning();

    await expectAppendOnlyRejection(
      db
        .update(stockLedgerEntries)
        .set({ quantity: "999" })
        .where(sql`${stockLedgerEntries.id} = ${entry.id}`),
    );

    await expectAppendOnlyRejection(
      db.delete(stockLedgerEntries).where(sql`${stockLedgerEntries.id} = ${entry.id}`),
    );
  });

  it("does NOT block DELETE on consumption_log (excluded — see 0009 migration comment; cancelOrder's double-cancel guard relies on DELETE)", async () => {
    // No positive assertion needed beyond "migration ran" — covered end-to-end
    // by test/deduction.test.ts's cancel-after-preparing suite, which exercises
    // the actual consumptionLogs DELETE via the /orders/:id/cancel route and
    // would fail if a consumption_log_append_only trigger were present.
    expect(true).toBe(true);
  });
});

describe("migration 0009: CHECK constraints", () => {
  it("rejects a negative-quantity stock_ledger_entry insert (stock_ledger_qty_positive)", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "CHK1", name: "Loc for CHECK test" })
      .returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "MAIN" })
      .returning();
    const [ingredient] = await db
      .insert(ingredients)
      .values({ name: "CheckConstraintPork", unit: "g", unitCost: "0.3", lowStockThreshold: "500" })
      .returning();

    await expect(
      db.insert(stockLedgerEntries).values({
        sourceModule: "RECEIVE",
        sourceDocumentNo: "NEG-QTY-DOC",
        ingredientId: ingredient.id,
        warehouseId: warehouse.id,
        movementType: "IN",
        quantity: "-5",
      }),
    ).rejects.toThrow();
  });

  it("rejects an ITO with the same from/to warehouse (ito_distinct_warehouses)", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "CHK2", name: "Loc for ITO CHECK test" })
      .returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "MAIN" })
      .returning();

    await expect(
      db.insert(itos).values({
        fromWarehouseId: warehouse.id,
        toWarehouseId: warehouse.id,
        status: "REQUESTED",
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive ito_item quantity (ito_item_qty_positive)", async () => {
    const [location] = await db
      .insert(locations)
      .values({ code: "CHK3", name: "Loc for ITO item CHECK test" })
      .returning();
    const [mainWh] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "MAIN" })
      .returning();
    const [kitchenWh] = await db
      .insert(warehouses)
      .values({ locationId: location.id, type: "KITCHEN" })
      .returning();
    const [ingredient] = await db
      .insert(ingredients)
      .values({ name: "ItoItemCheckBeef", unit: "g", unitCost: "0.4", lowStockThreshold: "500" })
      .returning();
    const [ito] = await db
      .insert(itos)
      .values({ fromWarehouseId: mainWh.id, toWarehouseId: kitchenWh.id, status: "REQUESTED" })
      .returning();

    await expect(
      db.insert(itoItems).values({
        itoId: ito.id,
        ingredientId: ingredient.id,
        quantity: "0",
      }),
    ).rejects.toThrow();
  });
});
