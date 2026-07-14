import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLots,
  operationalDocuments,
  stockPostingLines,
  stockPostings,
} from "../src/db/enterprise-schema.js";
import { ingredients, locations, users, warehouses } from "../src/db/schema.js";
import {
  stockReturnBatchLines,
  stockReturnBatches,
  stockReturnReceiptLines,
} from "../src/db/returns-schema.js";
import {
  qaReleaseLines,
  qaReleases,
  transferOrderLines,
  transferOrders,
} from "../src/db/transfer-orders-schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  hqLocationId: string;
  outletLocationId: string;
  hqMainWarehouseId: string;
  hqQuarantineWarehouseId: string;
  outletStorageWarehouseId: string;
  productionWarehouseId: string;
  actorUserId: string;
  itemId: string;
  lotId: string;
  quarantineLotId: string;
  returnReceiptLineId: string;
}

// D31: exactly one *active* HQ_MAIN warehouse may exist company-wide
// (`warehouse_single_hq_main_unique`, keyed on purpose alone, not per
// location) — mirrors how enterprise-stock-posting.test.ts seeds a single
// shared HQ_MAIN warehouse once in beforeAll rather than per-fixture.
let sharedHqMainWarehouseId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  const [hqMainLocation] = await db
    .insert(locations)
    .values({ code: `TO-HQMAIN-${randomUUID().slice(0, 8)}`, name: "Transfer Order Test HQ Main" })
    .returning();
  const [hqMain] = await db
    .insert(warehouses)
    .values({
      locationId: hqMainLocation.id,
      type: "MAIN",
      purpose: "HQ_MAIN",
      code: `WH-TO-HQMAIN-${randomUUID().slice(0, 8)}`,
      name: "Transfer Order Test HQ Main Warehouse",
    })
    .returning();
  sharedHqMainWarehouseId = hqMain.id;
});

afterAll(async () => {
  await closeDb(client);
});

async function fixture(): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [hq] = await db
    .insert(locations)
    .values({ code: `TOH${suffix}`, name: `Transfer HQ ${suffix}` })
    .returning();
  const [outlet] = await db
    .insert(locations)
    .values({ code: `TOO${suffix}`, name: `Transfer Outlet ${suffix}` })
    .returning();
  // `warehouse_location_type_unique` is (location_id, type) — QUARANTINE and
  // PRODUCTION both use legacy `type = 'MAIN'`, so they need distinct
  // locations even though both are conceptually HQ-side nodes here.
  const [productionLocation] = await db
    .insert(locations)
    .values({ code: `TOP${suffix}`, name: `Transfer Production Site ${suffix}` })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Transfer Actor ${suffix}`,
      email: `transfer-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `TO-ITEM-${suffix}`,
      name: `Transfer Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [hqQuarantine] = await db
    .insert(warehouses)
    .values({
      locationId: hq.id,
      type: "MAIN",
      purpose: "QUARANTINE",
      code: `WH-TOQ-${suffix}`,
      name: `Transfer HQ Quarantine ${suffix}`,
    })
    .returning();
  const [outletStorage] = await db
    .insert(warehouses)
    .values({
      locationId: outlet.id,
      type: "MAIN",
      purpose: "OUTLET_STORAGE",
      code: `WH-TOS-${suffix}`,
      name: `Transfer Outlet Storage ${suffix}`,
    })
    .returning();
  const [production] = await db
    .insert(warehouses)
    .values({
      locationId: productionLocation.id,
      type: "MAIN",
      purpose: "PRODUCTION",
      code: `WH-TOP-${suffix}`,
      name: `Transfer Production ${suffix}`,
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item.id, lotCode: `TO-LOT-${suffix}`, unitCost: "10.000000" })
    .returning();
  const [quarantineLot] = await db
    .insert(inventoryLots)
    .values({
      itemId: item.id,
      lotCode: `TO-QLOT-${suffix}`,
      status: "QUARANTINED",
      unitCost: "10.000000",
    })
    .returning();

  // Provenance chain for QA Release: a Stock Return Batch that quarantined
  // `quarantineLot` at `hqQuarantine`, matching the returns-schema fixture
  // shape (stock-return-schema.test.ts).
  const [batch] = await db
    .insert(stockReturnBatches)
    .values({
      documentNo: `TO-SRB-${randomUUID()}`,
      sourceLocationId: outlet.id,
      destinationLocationId: hq.id,
      destinationWarehouseId: hqQuarantine.id,
      createdBy: actor.id,
    })
    .returning();
  const [batchLine] = await db
    .insert(stockReturnBatchLines)
    .values({
      batchId: batch.id,
      lineNo: 1,
      itemId: item.id,
      lotId: lot.id,
      sourceWarehouseId: outletStorage.id,
      quantity: "5.000000",
      enteredQuantity: "5.000000",
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      reasonCode: "OTHER",
    })
    .returning();
  const [receiptLine] = await db
    .insert(stockReturnReceiptLines)
    .values({
      batchLineId: batchLine.id,
      quarantineLotId: quarantineLot.id,
      receivedQuantity: "5.000000",
      dispositionReasonCode: "OTHER",
    })
    .returning();

  return {
    hqLocationId: hq.id,
    outletLocationId: outlet.id,
    hqMainWarehouseId: sharedHqMainWarehouseId,
    hqQuarantineWarehouseId: hqQuarantine.id,
    outletStorageWarehouseId: outletStorage.id,
    productionWarehouseId: production.id,
    actorUserId: actor.id,
    itemId: item.id,
    lotId: lot.id,
    quarantineLotId: quarantineLot.id,
    returnReceiptLineId: receiptLine.id,
  };
}

/** A minimal posted stock_posting_line to exercise the line-level posting FKs/uniques. */
async function postingLineFixture(
  fx: Fixture,
  warehouseId: string,
  movementType: "IN" | "OUT",
  lotId: string = fx.lotId,
) {
  const [posting] = await db
    .insert(stockPostings)
    .values({
      idempotencyKey: `TO-POSTING:${randomUUID()}`,
      requestHash: randomUUID(),
      sourceModule: "TRANSFER_ORDER",
      sourceDocumentNo: `TO-${randomUUID()}`,
      correlationId: randomUUID(),
    })
    .returning();
  const [line] = await db
    .insert(stockPostingLines)
    .values({
      postingId: posting.id,
      lineNo: 1,
      warehouseId,
      itemId: fx.itemId,
      lotId,
      movementType,
      quantity: "5.000000",
      enteredQuantity: "5.000000",
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      balanceBefore: "0.000000",
      balanceAfter: "5.000000",
      lineHash: randomUUID(),
    })
    .returning();
  return line;
}

function orderValues(fx: Fixture, overrides: Partial<typeof transferOrders.$inferInsert> = {}) {
  return {
    documentNo: `TO-${randomUUID()}`,
    sourceWarehouseId: fx.hqMainWarehouseId,
    destinationWarehouseId: fx.outletStorageWarehouseId,
    sourceLocationId: fx.hqLocationId,
    destinationLocationId: fx.outletLocationId,
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertOrder(fx: Fixture, overrides: Partial<typeof transferOrders.$inferInsert> = {}) {
  const [order] = await db.insert(transferOrders).values(orderValues(fx, overrides)).returning();
  return order;
}

function lineValues(
  fx: Fixture,
  orderId: string,
  overrides: Partial<typeof transferOrderLines.$inferInsert> = {},
) {
  return {
    orderId,
    lineNo: 1,
    itemId: fx.itemId,
    enteredUom: "kg",
    enteredQuantity: "5.000000",
    conversionFactor: "1.00000000",
    baseQuantity: "5.000000",
    ...overrides,
  };
}

async function insertLine(
  fx: Fixture,
  orderId: string,
  overrides: Partial<typeof transferOrderLines.$inferInsert> = {},
) {
  const [line] = await db.insert(transferOrderLines).values(lineValues(fx, orderId, overrides)).returning();
  return line;
}

function releaseValues(fx: Fixture, overrides: Partial<typeof qaReleases.$inferInsert> = {}) {
  return {
    documentNo: `QAR-${randomUUID()}`,
    sourceWarehouseId: fx.hqQuarantineWarehouseId,
    destinationWarehouseId: fx.hqMainWarehouseId,
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertRelease(fx: Fixture, overrides: Partial<typeof qaReleases.$inferInsert> = {}) {
  const [release] = await db.insert(qaReleases).values(releaseValues(fx, overrides)).returning();
  return release;
}

function releaseLineValues(
  fx: Fixture,
  releaseId: string,
  overrides: Partial<typeof qaReleaseLines.$inferInsert> = {},
) {
  return {
    releaseId,
    lineNo: 1,
    itemId: fx.itemId,
    quarantineLotId: fx.quarantineLotId,
    sourceReturnReceiptLineId: fx.returnReceiptLineId,
    releaseQuantity: "5.000000",
    enteredUom: "kg",
    conversionFactor: "1.00000000",
    ...overrides,
  };
}

async function insertReleaseLine(
  fx: Fixture,
  releaseId: string,
  overrides: Partial<typeof qaReleaseLines.$inferInsert> = {},
) {
  const [line] = await db
    .insert(qaReleaseLines)
    .values(releaseLineValues(fx, releaseId, overrides))
    .returning();
  return line;
}

describe("transfer order schema", () => {
  it("creates a full transfer_order/line chain", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    expect(order).toMatchObject({
      status: "DRAFT",
      version: 1,
      sourceWarehouseId: fx.hqMainWarehouseId,
      destinationWarehouseId: fx.outletStorageWarehouseId,
    });

    const line = await insertLine(fx, order.id);
    expect(line).toMatchObject({ orderId: order.id, status: "DRAFT", lotId: null });
  });

  it("rejects a header whose source warehouse equals its destination warehouse", async () => {
    const fx = await fixture();
    await expect(
      insertOrder(fx, { destinationWarehouseId: fx.hqMainWarehouseId }),
    ).rejects.toThrow();
  });

  it("allows the HQ_MAIN -> PRODUCTION and PRODUCTION -> HQ_MAIN warehouse pairs at the DB layer", async () => {
    const fx = await fixture();
    await expect(
      insertOrder(fx, { destinationWarehouseId: fx.productionWarehouseId }),
    ).resolves.not.toThrow();
    await expect(
      insertOrder(fx, {
        sourceWarehouseId: fx.productionWarehouseId,
        destinationWarehouseId: fx.hqMainWarehouseId,
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a non-positive version", async () => {
    const fx = await fixture();
    await expect(insertOrder(fx, { version: 0 })).rejects.toThrow();
  });

  it("enforces a unique transfer_order document_no", async () => {
    const fx = await fixture();
    const documentNo = `TO-DUP-${randomUUID()}`;
    await insertOrder(fx, { documentNo });
    await expect(insertOrder(fx, { documentNo })).rejects.toThrow();
  });

  it("rejects a status value outside the DRAFT..CANCELLED lifecycle", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      client.query(`update transfer_order set status = 'BOGUS' where id = $1`, [order.id]),
    ).rejects.toThrow();
  });

  it("rejects a line with a non-positive line number, entered quantity, conversion factor, or base quantity", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(insertLine(fx, order.id, { lineNo: 0 })).rejects.toThrow();
    await expect(insertLine(fx, order.id, { enteredQuantity: "0" })).rejects.toThrow();
    await expect(insertLine(fx, order.id, { conversionFactor: "0" })).rejects.toThrow();
    await expect(insertLine(fx, order.id, { baseQuantity: "0" })).rejects.toThrow();
  });

  it("enforces a unique (order_id, line_no) pair", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await insertLine(fx, order.id, { lineNo: 1 });
    await expect(insertLine(fx, order.id, { lineNo: 1 })).rejects.toThrow();
  });

  it("rejects unknown FK references on the header and line", async () => {
    const fx = await fixture();
    await expect(insertOrder(fx, { sourceWarehouseId: randomUUID() })).rejects.toThrow();
    await expect(insertOrder(fx, { sourceLocationId: randomUUID() })).rejects.toThrow();
    const order = await insertOrder(fx);
    await expect(insertLine(fx, order.id, { itemId: randomUUID() })).rejects.toThrow();
    await expect(insertLine(fx, order.id, { lotId: randomUUID() })).rejects.toThrow();
  });

  it("rejects a received_quantity that exceeds dispatched_quantity, or is set before any dispatch", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    await expect(
      insertLine(fx, order.id, { receivedQuantity: "1.000000" }),
    ).rejects.toThrow();
    const line = await insertLine(fx, order.id, { dispatchedQuantity: "3.000000" });
    await expect(
      db
        .update(transferOrderLines)
        .set({ receivedQuantity: "4.000000" })
        .where(eq(transferOrderLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(transferOrderLines)
        .set({ receivedQuantity: "3.000000" })
        .where(eq(transferOrderLines.id, line.id)),
    ).resolves.not.toThrow();
  });

  it("keeps dispatch_posting_line_id append-only once set (cannot be repointed)", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(fx, order.id);
    const dispatchPosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "OUT");
    const otherDispatchPosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "OUT");

    await db
      .update(transferOrderLines)
      .set({ dispatchPostingLineId: dispatchPosting.id, dispatchedQuantity: "5.000000" })
      .where(eq(transferOrderLines.id, line.id));

    await expect(
      db
        .update(transferOrderLines)
        .set({ dispatchPostingLineId: otherDispatchPosting.id })
        .where(eq(transferOrderLines.id, line.id)),
    ).rejects.toThrow();
  });

  it("makes a transfer_order_line fully immutable (no update, no delete) once receipt_posting_line_id is set", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(fx, order.id);
    const dispatchPosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "OUT");
    const receiptPosting = await postingLineFixture(fx, fx.outletStorageWarehouseId, "IN");

    await db
      .update(transferOrderLines)
      .set({
        dispatchPostingLineId: dispatchPosting.id,
        dispatchedQuantity: "5.000000",
        receiptPostingLineId: receiptPosting.id,
        receivedQuantity: "5.000000",
        status: "RECEIVED",
      })
      .where(eq(transferOrderLines.id, line.id));

    await expect(
      db
        .update(transferOrderLines)
        .set({ remarks: "late edit" })
        .where(eq(transferOrderLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(transferOrderLines).where(eq(transferOrderLines.id, line.id)),
    ).rejects.toThrow();
  });

  it("prevents two lines from claiming the same dispatch or receipt posting line", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const lineA = await insertLine(fx, order.id, { lineNo: 1 });
    const lineB = await insertLine(fx, order.id, { lineNo: 2 });
    const dispatchPosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "OUT");

    await db
      .update(transferOrderLines)
      .set({ dispatchPostingLineId: dispatchPosting.id, dispatchedQuantity: "5.000000" })
      .where(eq(transferOrderLines.id, lineA.id));

    await expect(
      db
        .update(transferOrderLines)
        .set({ dispatchPostingLineId: dispatchPosting.id, dispatchedQuantity: "5.000000" })
        .where(eq(transferOrderLines.id, lineB.id)),
    ).rejects.toThrow();
  });

  it("cascades line deletion when the parent order is removed (pre-posting)", async () => {
    const fx = await fixture();
    const order = await insertOrder(fx);
    const line = await insertLine(fx, order.id);
    await db.delete(transferOrders).where(eq(transferOrders.id, order.id));
    expect(
      await db.select().from(transferOrderLines).where(eq(transferOrderLines.id, line.id)),
    ).toHaveLength(0);
  });

  it("links dispatch and receipt operational_documents one-to-one with an order", async () => {
    const fx = await fixture();
    const [dispatchDoc] = await db
      .insert(operationalDocuments)
      .values({
        module: "TRANSFER_ORDER_DISPATCH",
        documentNo: `TO-DISP-${randomUUID()}`,
        locationId: fx.hqLocationId,
        status: "APPROVED",
      })
      .returning();
    const order = await insertOrder(fx, { dispatchDocumentId: dispatchDoc.id, status: "DISPATCHED" });
    expect(order).toMatchObject({ dispatchDocumentId: dispatchDoc.id });

    const otherOrder = await insertOrder(fx);
    await expect(
      db
        .update(transferOrders)
        .set({ dispatchDocumentId: dispatchDoc.id })
        .where(eq(transferOrders.id, otherOrder.id)),
    ).rejects.toThrow();
  });

  it("is replay-safe: reapplying migration 0031 does not duplicate enum types", async () => {
    const migrationsDir = resolve(process.cwd(), "drizzle");
    const body = readFileSync(
      resolve(migrationsDir, "0031_transfer_orders_qa_release.sql"),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "\n");
    await client.transaction(async (tx: { exec: (sql: string) => Promise<unknown> }) => {
      await tx.exec(body);
    });
    const { rows } = (await client.query(
      `select count(*)::int as count from pg_type where typname in ('transfer_order_status','qa_release_status')`,
    )) as { rows: { count: number }[] };
    expect(rows[0]?.count).toBe(2);
  });
});

describe("qa release schema", () => {
  it("creates a DRAFT qa_release with a line tracing back to the return receipt line", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    expect(release).toMatchObject({
      status: "DRAFT",
      version: 1,
      sourceWarehouseId: fx.hqQuarantineWarehouseId,
      destinationWarehouseId: fx.hqMainWarehouseId,
    });

    const line = await insertReleaseLine(fx, release.id);
    expect(line).toMatchObject({
      releaseId: release.id,
      sourceReturnReceiptLineId: fx.returnReceiptLineId,
      quarantineLotId: fx.quarantineLotId,
    });
  });

  it("rejects a qa_release whose source warehouse is not a QUARANTINE node", async () => {
    const fx = await fixture();
    // Distinct from the default destination (hqMainWarehouseId) so this
    // isolates the route-purpose trigger from the plain source<>destination
    // distinctness CHECK exercised separately above.
    await expect(
      insertRelease(fx, { sourceWarehouseId: fx.outletStorageWarehouseId }),
    ).rejects.toThrow();
  });

  it("rejects a qa_release whose destination warehouse is not an HQ_MAIN node", async () => {
    const fx = await fixture();
    await expect(
      insertRelease(fx, { destinationWarehouseId: fx.outletStorageWarehouseId }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive version", async () => {
    const fx = await fixture();
    await expect(insertRelease(fx, { version: 0 })).rejects.toThrow();
  });

  it("enforces a unique qa_release document_no", async () => {
    const fx = await fixture();
    const documentNo = `QAR-DUP-${randomUUID()}`;
    await insertRelease(fx, { documentNo });
    await expect(insertRelease(fx, { documentNo })).rejects.toThrow();
  });

  it("rejects a status value outside the DRAFT..CANCELLED lifecycle", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    await expect(
      client.query(`update qa_release set status = 'BOGUS' where id = $1`, [release.id]),
    ).rejects.toThrow();
  });

  it("rejects a line with a non-positive line number, release quantity, or conversion factor", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    await expect(insertReleaseLine(fx, release.id, { lineNo: 0 })).rejects.toThrow();
    await expect(insertReleaseLine(fx, release.id, { releaseQuantity: "0" })).rejects.toThrow();
    await expect(insertReleaseLine(fx, release.id, { conversionFactor: "0" })).rejects.toThrow();
  });

  it("enforces a unique (release_id, line_no) pair", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    await insertReleaseLine(fx, release.id, { lineNo: 1 });
    await expect(insertReleaseLine(fx, release.id, { lineNo: 1 })).rejects.toThrow();
  });

  it("rejects unknown FK references, including a non-existent source return receipt line", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    await expect(insertReleaseLine(fx, release.id, { itemId: randomUUID() })).rejects.toThrow();
    await expect(insertReleaseLine(fx, release.id, { quarantineLotId: randomUUID() })).rejects.toThrow();
    await expect(
      insertReleaseLine(fx, release.id, { sourceReturnReceiptLineId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("allows more than one qa_release_line to trace back to the same return receipt line (partial releases)", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    await insertReleaseLine(fx, release.id, { lineNo: 1, releaseQuantity: "2.000000" });
    await expect(
      insertReleaseLine(fx, release.id, { lineNo: 2, releaseQuantity: "3.000000" }),
    ).resolves.not.toThrow();
  });

  it("keeps a qa_release_line append-only (no update, no delete) once posted", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    const line = await insertReleaseLine(fx, release.id);
    const releasePosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "IN", fx.quarantineLotId);

    await db
      .update(qaReleaseLines)
      .set({ releasePostingLineId: releasePosting.id })
      .where(eq(qaReleaseLines.id, line.id));

    await expect(
      db
        .update(qaReleaseLines)
        .set({ remarks: "late edit" })
        .where(eq(qaReleaseLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(qaReleaseLines).where(eq(qaReleaseLines.id, line.id)),
    ).rejects.toThrow();
  });

  it("prevents two release lines from claiming the same release_posting_line_id", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    const lineA = await insertReleaseLine(fx, release.id, { lineNo: 1 });
    const lineB = await insertReleaseLine(fx, release.id, { lineNo: 2 });
    const releasePosting = await postingLineFixture(fx, fx.hqMainWarehouseId, "IN", fx.quarantineLotId);

    await db
      .update(qaReleaseLines)
      .set({ releasePostingLineId: releasePosting.id })
      .where(eq(qaReleaseLines.id, lineA.id));

    await expect(
      db
        .update(qaReleaseLines)
        .set({ releasePostingLineId: releasePosting.id })
        .where(eq(qaReleaseLines.id, lineB.id)),
    ).rejects.toThrow();
  });

  it("cascades line deletion when the parent release is removed (pre-posting)", async () => {
    const fx = await fixture();
    const release = await insertRelease(fx);
    const line = await insertReleaseLine(fx, release.id);
    await db.delete(qaReleases).where(eq(qaReleases.id, release.id));
    expect(await db.select().from(qaReleaseLines).where(eq(qaReleaseLines.id, line.id))).toHaveLength(0);
  });
});
