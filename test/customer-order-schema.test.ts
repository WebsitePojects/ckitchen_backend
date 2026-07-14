import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { inventoryLots, stockPostings, stockPostingLines } from "../src/db/enterprise-schema.js";
import { bomHeaders, bomVersions, jobOrders } from "../src/db/production-schema.js";
import { customers, ingredients, locations, users, warehouses } from "../src/db/schema.js";
import {
  customerOrderAllocations,
  customerOrderFulfillments,
  customerOrderLines,
  customerOrders,
} from "../src/db/customer-orders-schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  locationId: string;
  actorUserId: string;
  customerId: string;
  itemId: string;
  warehouseId: string;
  productionWarehouseId: string;
  lotId: string;
  jobOrderId: string;
  otherJobOrderId: string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

async function makeJobOrder(fx: Omit<Fixture, "jobOrderId" | "otherJobOrderId">, suffix: string) {
  const [header] = await db
    .insert(bomHeaders)
    .values({
      code: `CO-BOM-${suffix}`,
      name: `CO BOM ${suffix}`,
      outputItemId: fx.itemId,
      createdBy: fx.actorUserId,
    })
    .returning();
  const [version] = await db
    .insert(bomVersions)
    .values({
      bomHeaderId: header.id,
      versionNo: 1,
      status: "ACTIVE",
      outputUom: "kg",
      outputYieldQty: "10.000000",
      effectiveFrom: "2026-01-01",
      createdBy: fx.actorUserId,
    })
    .returning();
  const [jobOrder] = await db
    .insert(jobOrders)
    .values({
      jobOrderNo: `CO-JO-${suffix}`,
      bomHeaderId: header.id,
      bomVersionId: version.id,
      locationId: fx.locationId,
      productionWarehouseId: fx.productionWarehouseId,
      plannedOutputQty: "10.000000",
      outputUom: "kg",
      createdBy: fx.actorUserId,
    })
    .returning();
  return jobOrder;
}

async function fixture(): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `COL${suffix}`, name: `Customer Order Location ${suffix}` })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Customer Order Actor ${suffix}`,
      email: `customer-order-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [customer] = await db
    .insert(customers)
    .values({ code: `CUST-${suffix}`, name: `Customer ${suffix}` })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `CO-ITEM-${suffix}`,
      name: `Order Item ${suffix}`,
      unit: "kg",
      itemType: "FINISHED_GOOD",
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "KITCHEN",
      purpose: "KITCHEN",
      code: `WH-COK-${suffix}`,
      name: `Kitchen Warehouse ${suffix}`,
    })
    .returning();
  const [productionWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "MAIN",
      purpose: "PRODUCTION",
      code: `WH-COP-${suffix}`,
      name: `Production Warehouse ${suffix}`,
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item.id, lotCode: `CO-LOT-${suffix}`, unitCost: "10.000000" })
    .returning();

  const base = {
    locationId: location.id,
    actorUserId: actor.id,
    customerId: customer.id,
    itemId: item.id,
    warehouseId: warehouse.id,
    productionWarehouseId: productionWarehouse.id,
    lotId: lot.id,
  };
  const jobOrder = await makeJobOrder(base, `a-${suffix}`);
  const otherJobOrder = await makeJobOrder(base, `b-${suffix}`);
  return { ...base, jobOrderId: jobOrder.id, otherJobOrderId: otherJobOrder.id };
}

function orderValues(fx: Fixture, overrides: Partial<typeof customerOrders.$inferInsert> = {}) {
  return {
    documentNo: `CO-${randomUUID()}`,
    customerId: fx.customerId,
    locationId: fx.locationId,
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertOrder(fx: Fixture, overrides: Partial<typeof customerOrders.$inferInsert> = {}) {
  const [order] = await db.insert(customerOrders).values(orderValues(fx, overrides)).returning();
  return order;
}

function stockedOutputLineValues(
  fx: Fixture,
  orderId: string,
  overrides: Partial<typeof customerOrderLines.$inferInsert> = {},
) {
  return {
    orderId,
    lineNo: 1,
    itemId: fx.itemId,
    enteredUom: "kg",
    enteredQuantity: "2.000000",
    conversionFactor: "1.00000000",
    baseQuantity: "2.000000",
    unitPrice: "100.000000",
    lineTotal: "200.000000",
    consumptionMode: "STOCKED_OUTPUT" as const,
    ...overrides,
  };
}

function madeToOrderLineValues(
  fx: Fixture,
  orderId: string,
  overrides: Partial<typeof customerOrderLines.$inferInsert> = {},
) {
  return {
    ...stockedOutputLineValues(fx, orderId),
    consumptionMode: "MADE_TO_ORDER" as const,
    componentRequirementsSnapshot: { components: [{ itemId: fx.itemId, qty: "1.000000" }] },
    ...overrides,
  };
}

async function insertLine(values: typeof customerOrderLines.$inferInsert) {
  const [line] = await db.insert(customerOrderLines).values(values).returning();
  return line;
}

describe("customer order schema", () => {
  it("creates a full customer_order/line/allocation/fulfillment chain for a STOCKED_OUTPUT line", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    expect(order).toMatchObject({ status: "DRAFT", version: 1, customerId: fx.customerId });

    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    expect(line).toMatchObject({
      orderId: order.id,
      consumptionMode: "STOCKED_OUTPUT",
      componentRequirementsSnapshot: null,
      jobOrderId: null,
    });

    const [allocation] = await db
      .insert(customerOrderAllocations)
      .values({
        lineId: line.id,
        lotId: fx.lotId,
        warehouseId: fx.warehouseId,
        quantity: "2.000000",
      })
      .returning();
    expect(allocation).toMatchObject({ lineId: line.id, status: "ACTIVE" });

    const [fulfillment] = await db
      .insert(customerOrderFulfillments)
      .values({ orderId: order.id, lineId: line.id, quantity: "2.000000", actorUserId: fx.actorUserId })
      .returning();
    expect(fulfillment).toMatchObject({ orderId: order.id, lineId: line.id });
  });

  it("allows a MADE_TO_ORDER line whose consumption owner is a component snapshot", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(madeToOrderLineValues(fx, order.id));
    expect(line.componentRequirementsSnapshot).not.toBeNull();
    expect(line.jobOrderId).toBeNull();
  });

  it("allows a MADE_TO_ORDER line whose consumption owner is a linked job order", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(
      madeToOrderLineValues(fx, order.id, { componentRequirementsSnapshot: null, jobOrderId: fx.jobOrderId }),
    );
    expect(line.jobOrderId).toBe(fx.jobOrderId);
    expect(line.componentRequirementsSnapshot).toBeNull();
  });

  it("rejects a MADE_TO_ORDER line with BOTH a component snapshot and a linked job order", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      insertLine(madeToOrderLineValues(fx, order.id, { jobOrderId: fx.jobOrderId })),
    ).rejects.toThrow();
  });

  it("rejects a MADE_TO_ORDER line with NEITHER a component snapshot nor a linked job order", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      insertLine(
        madeToOrderLineValues(fx, order.id, { componentRequirementsSnapshot: null, jobOrderId: null }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a STOCKED_OUTPUT line carrying a component snapshot", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      insertLine(
        stockedOutputLineValues(fx, order.id, {
          componentRequirementsSnapshot: { components: [] },
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a STOCKED_OUTPUT line carrying a linked job order", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      insertLine(stockedOutputLineValues(fx, order.id, { jobOrderId: fx.jobOrderId })),
    ).rejects.toThrow();
  });

  it("enforces a unique customer_order document_no", async () => {
    const fx = await fixture();
    const documentNo = `CO-DUP-${randomUUID()}`;
    await insertOrder(fx, { documentNo });
    await expect(insertOrder(fx, { documentNo })).rejects.toThrow();
  });

  it("rejects a non-positive version, line number, quantity, or conversion factor", async () => {
    const fx = await fixture();
    await expect(insertOrder(fx, { version: 0 })).rejects.toThrow();
    const order = await insertOrder(fx);
    await expect(insertLine(stockedOutputLineValues(fx, order.id, { lineNo: 0 }))).rejects.toThrow();
    await expect(
      insertLine(stockedOutputLineValues(fx, order.id, { enteredQuantity: "0" })),
    ).rejects.toThrow();
    await expect(
      insertLine(stockedOutputLineValues(fx, order.id, { conversionFactor: "0" })),
    ).rejects.toThrow();
    await expect(insertLine(stockedOutputLineValues(fx, order.id, { baseQuantity: "0" }))).rejects.toThrow();
  });

  it("enforces a unique (order_id, line_no) pair", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await insertLine(stockedOutputLineValues(fx, order.id, { lineNo: 1 }));
    await expect(insertLine(stockedOutputLineValues(fx, order.id, { lineNo: 1 }))).rejects.toThrow();
  });

  it("prevents two lines from claiming the same job order", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await insertLine(
      madeToOrderLineValues(fx, order.id, {
        lineNo: 1,
        componentRequirementsSnapshot: null,
        jobOrderId: fx.jobOrderId,
      }),
    );
    await expect(
      insertLine(
        madeToOrderLineValues(fx, order.id, {
          lineNo: 2,
          componentRequirementsSnapshot: null,
          jobOrderId: fx.jobOrderId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown FK references on the order header and line", async () => {
    const fx = await fixture();
    await expect(insertOrder(fx, { customerId: randomUUID() })).rejects.toThrow();
    await expect(insertOrder(fx, { locationId: randomUUID() })).rejects.toThrow();
    const order = await insertOrder(fx);
    await expect(insertLine(stockedOutputLineValues(fx, order.id, { itemId: randomUUID() }))).rejects.toThrow();
  });

  it("enforces at most one ACTIVE allocation per (line, lot)", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    await db.insert(customerOrderAllocations).values({
      lineId: line.id,
      lotId: fx.lotId,
      warehouseId: fx.warehouseId,
      quantity: "1.000000",
    });
    await expect(
      db.insert(customerOrderAllocations).values({
        lineId: line.id,
        lotId: fx.lotId,
        warehouseId: fx.warehouseId,
        quantity: "1.000000",
      }),
    ).rejects.toThrow();
  });

  it("allows a new ACTIVE allocation for the same (line, lot) once the prior one is RELEASED", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    const [first] = await db
      .insert(customerOrderAllocations)
      .values({ lineId: line.id, lotId: fx.lotId, warehouseId: fx.warehouseId, quantity: "1.000000" })
      .returning();
    await db
      .update(customerOrderAllocations)
      .set({ status: "RELEASED" })
      .where(eq(customerOrderAllocations.id, first.id));
    await expect(
      db.insert(customerOrderAllocations).values({
        lineId: line.id,
        lotId: fx.lotId,
        warehouseId: fx.warehouseId,
        quantity: "1.000000",
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a non-positive allocation quantity or an unknown lot/warehouse reference", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    await expect(
      db
        .insert(customerOrderAllocations)
        .values({ lineId: line.id, lotId: fx.lotId, warehouseId: fx.warehouseId, quantity: "0" }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(customerOrderAllocations)
        .values({ lineId: line.id, lotId: randomUUID(), warehouseId: fx.warehouseId, quantity: "1.000000" }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(customerOrderAllocations)
        .values({ lineId: line.id, lotId: fx.lotId, warehouseId: randomUUID(), quantity: "1.000000" }),
    ).rejects.toThrow();
  });

  it("rejects a customer_order status value outside its lifecycle enum", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      client.query(`update customer_order set status = 'BOGUS' where id = $1`, [order.id]),
    ).rejects.toThrow();
  });

  it("rejects a non-positive fulfillment quantity", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    await expect(
      db.insert(customerOrderFulfillments).values({ orderId: order.id, lineId: line.id, quantity: "0" }),
    ).rejects.toThrow();
  });

  it("keeps customer_order_fulfillment append-only once written", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    const [fulfillment] = await db
      .insert(customerOrderFulfillments)
      .values({ orderId: order.id, lineId: line.id, quantity: "1.000000" })
      .returning();

    await expect(
      db
        .update(customerOrderFulfillments)
        .set({ quantity: "2.000000" })
        .where(eq(customerOrderFulfillments.id, fulfillment.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(customerOrderFulfillments).where(eq(customerOrderFulfillments.id, fulfillment.id)),
    ).rejects.toThrow();
  });

  it("accepts a fulfillment linked to a posted stock_posting reference", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    const [posting] = await db
      .insert(stockPostings)
      .values({
        idempotencyKey: `CO-POSTING:${randomUUID()}`,
        requestHash: randomUUID(),
        sourceModule: "CUSTOMER_ORDER",
        sourceDocumentNo: order.documentNo,
        correlationId: randomUUID(),
      })
      .returning();
    await db.insert(stockPostingLines).values({
      postingId: posting.id,
      lineNo: 1,
      warehouseId: fx.warehouseId,
      itemId: fx.itemId,
      lotId: fx.lotId,
      movementType: "OUT",
      quantity: "1.000000",
      enteredQuantity: "1.000000",
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      balanceBefore: "5.000000",
      balanceAfter: "4.000000",
      lineHash: randomUUID(),
    });
    const [fulfillment] = await db
      .insert(customerOrderFulfillments)
      .values({ orderId: order.id, lineId: line.id, quantity: "1.000000", stockPostingId: posting.id })
      .returning();
    expect(fulfillment).toMatchObject({ stockPostingId: posting.id });
  });

  it("cascades line/allocation deletion when the parent order is removed", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    const [allocation] = await db
      .insert(customerOrderAllocations)
      .values({ lineId: line.id, lotId: fx.lotId, warehouseId: fx.warehouseId, quantity: "1.000000" })
      .returning();

    await db.delete(customerOrders).where(eq(customerOrders.id, order.id));

    expect(await db.select().from(customerOrderLines).where(eq(customerOrderLines.id, line.id))).toHaveLength(0);
    expect(
      await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.id, allocation.id)),
    ).toHaveLength(0);
  });

  it("blocks deleting an order once it has append-only fulfillment history (history is never lost, even via cascade)", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(stockedOutputLineValues(fx, order.id));
    await db
      .insert(customerOrderFulfillments)
      .values({ orderId: order.id, lineId: line.id, quantity: "1.000000" });

    await expect(db.delete(customerOrders).where(eq(customerOrders.id, order.id))).rejects.toThrow();
  });

  it("is replay-safe: reapplying migration 0030 does not duplicate enum types", async () => {
    const migrationsDir = resolve(process.cwd(), "drizzle");
    const body = readFileSync(resolve(migrationsDir, "0030_customer_orders.sql"), "utf8").replaceAll(
      "--> statement-breakpoint",
      "\n",
    );
    await client.transaction(async (tx: { exec: (sql: string) => Promise<unknown> }) => {
      await tx.exec(body);
    });
    const { rows } = (await client.query(
      `select count(*)::int as count from pg_type where typname in ('customer_order_status','customer_order_allocation_status')`,
    )) as { rows: { count: number }[] };
    expect(rows[0]?.count).toBe(2);
  });
});
