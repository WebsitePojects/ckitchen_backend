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

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  outletLocationId: string;
  hqLocationId: string;
  outletWarehouseId: string;
  hqQuarantineWarehouseId: string;
  actorUserId: string;
  itemId: string;
  lotId: string;
  quarantineLotId: string;
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

async function fixture(): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [outlet] = await db
    .insert(locations)
    .values({ code: `SRO${suffix}`, name: `Return Outlet ${suffix}` })
    .returning();
  const [hq] = await db
    .insert(locations)
    .values({ code: `SRH${suffix}`, name: `Return HQ ${suffix}` })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Return Actor ${suffix}`,
      email: `return-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `SR-ITEM-${suffix}`,
      name: `Return Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [outletWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: outlet.id,
      type: "KITCHEN",
      purpose: "KITCHEN",
      code: `WH-SRO-${suffix}`,
      name: `Return Outlet Kitchen ${suffix}`,
    })
    .returning();
  const [hqQuarantine] = await db
    .insert(warehouses)
    .values({
      locationId: hq.id,
      type: "MAIN",
      purpose: "QUARANTINE",
      code: `WH-SRQ-${suffix}`,
      name: `Return HQ Quarantine ${suffix}`,
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item.id, lotCode: `SR-LOT-${suffix}`, unitCost: "10.000000" })
    .returning();
  const [quarantineLot] = await db
    .insert(inventoryLots)
    .values({
      itemId: item.id,
      lotCode: `SR-QLOT-${suffix}`,
      status: "QUARANTINED",
      unitCost: "10.000000",
    })
    .returning();
  return {
    outletLocationId: outlet.id,
    hqLocationId: hq.id,
    outletWarehouseId: outletWarehouse.id,
    hqQuarantineWarehouseId: hqQuarantine.id,
    actorUserId: actor.id,
    itemId: item.id,
    lotId: lot.id,
    quarantineLotId: quarantineLot.id,
  };
}

function batchValues(fx: Fixture, overrides: Partial<typeof stockReturnBatches.$inferInsert> = {}) {
  return {
    documentNo: `SRB-${randomUUID()}`,
    sourceLocationId: fx.outletLocationId,
    destinationLocationId: fx.hqLocationId,
    destinationWarehouseId: fx.hqQuarantineWarehouseId,
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertBatch(
  fx: Fixture,
  overrides: Partial<typeof stockReturnBatches.$inferInsert> = {},
) {
  const [batch] = await db.insert(stockReturnBatches).values(batchValues(fx, overrides)).returning();
  return batch;
}

function lineValues(
  fx: Fixture,
  batchId: string,
  overrides: Partial<typeof stockReturnBatchLines.$inferInsert> = {},
) {
  return {
    batchId,
    lineNo: 1,
    itemId: fx.itemId,
    lotId: fx.lotId,
    sourceWarehouseId: fx.outletWarehouseId,
    quantity: "5.000000",
    enteredQuantity: "5.000000",
    enteredUom: "kg",
    conversionFactor: "1.00000000",
    reasonCode: "SPOILED" as const,
    ...overrides,
  };
}

async function insertLine(
  fx: Fixture,
  batchId: string,
  overrides: Partial<typeof stockReturnBatchLines.$inferInsert> = {},
) {
  const [line] = await db
    .insert(stockReturnBatchLines)
    .values(lineValues(fx, batchId, overrides))
    .returning();
  return line;
}

/** A minimal posted stock_posting_line to exercise the receipt-line posting-line FKs/uniques. */
async function postingLineFixture(fx: Fixture) {
  const [posting] = await db
    .insert(stockPostings)
    .values({
      idempotencyKey: `SR-POSTING:${randomUUID()}`,
      requestHash: randomUUID(),
      sourceModule: "STOCK_RETURN_RECEIPT",
      sourceDocumentNo: `SRR-${randomUUID()}`,
      correlationId: randomUUID(),
    })
    .returning();
  const [line] = await db
    .insert(stockPostingLines)
    .values({
      postingId: posting.id,
      lineNo: 1,
      warehouseId: fx.hqQuarantineWarehouseId,
      itemId: fx.itemId,
      lotId: fx.quarantineLotId,
      movementType: "IN",
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

describe("stock return batch schema", () => {
  it("creates a DRAFT batch with a line and a receipt line end to end", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    expect(batch).toMatchObject({ status: "DRAFT", version: 1 });

    const line = await insertLine(fx, batch.id);
    const [receipt] = await db
      .insert(stockReturnReceiptLines)
      .values({
        batchLineId: line.id,
        quarantineLotId: fx.quarantineLotId,
        receivedQuantity: "5.000000",
        dispositionReasonCode: "SPOILED",
      })
      .returning();
    expect(receipt).toMatchObject({ batchLineId: line.id, receivedQuantity: "5.000000" });
  });

  it("rejects a batch whose source outlet equals its HQ destination", async () => {
    const fx = await fixture();
    await expect(
      insertBatch(fx, { destinationLocationId: fx.outletLocationId }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive optimistic version", async () => {
    const fx = await fixture();
    await expect(insertBatch(fx, { version: 0 })).rejects.toThrow();
  });

  it("enforces a unique human document number", async () => {
    const fx = await fixture();
    const documentNo = `SRB-DUP-${randomUUID()}`;
    await insertBatch(fx, { documentNo });
    await expect(insertBatch(fx, { documentNo })).rejects.toThrow();
  });

  it("rejects a status value outside the DRAFT..CANCELLED lifecycle", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    await expect(
      client.query(`update stock_return_batch set status = 'BOGUS' where id = $1`, [batch.id]),
    ).rejects.toThrow();
  });

  it("rejects a line with a non-positive quantity, entered quantity, or conversion factor", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    await expect(insertLine(fx, batch.id, { quantity: "0" })).rejects.toThrow();
    await expect(insertLine(fx, batch.id, { lineNo: 2, enteredQuantity: "-1" })).rejects.toThrow();
    await expect(insertLine(fx, batch.id, { lineNo: 3, conversionFactor: "0" })).rejects.toThrow();
    await expect(insertLine(fx, batch.id, { lineNo: 4, conversionFactor: "-1" })).rejects.toThrow();
  });

  it("rejects a duplicate line number within the same batch", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    await insertLine(fx, batch.id, { lineNo: 1 });
    await expect(insertLine(fx, batch.id, { lineNo: 1 })).rejects.toThrow();
  });

  it("rejects a line referencing a lot or warehouse that does not exist", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    await expect(insertLine(fx, batch.id, { lotId: randomUUID() })).rejects.toThrow();
    await expect(
      insertLine(fx, batch.id, { lineNo: 3, sourceWarehouseId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("rejects an unknown disposition/reason code", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    await expect(
      // @ts-expect-error -- deliberately invalid enum value to prove the DB enum rejects it
      insertLine(fx, batch.id, { reasonCode: "NEGLIGENCE" }),
    ).rejects.toThrow();
  });

  it("cascades line deletion when its parent batch is removed", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    const line = await insertLine(fx, batch.id);
    await db.delete(stockReturnBatches).where(eq(stockReturnBatches.id, batch.id));
    expect(
      await db.select().from(stockReturnBatchLines).where(eq(stockReturnBatchLines.id, line.id)),
    ).toHaveLength(0);
  });

  it("allows exactly one receipt line per batch line and rejects a replayed second receipt", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    const line = await insertLine(fx, batch.id);
    await db.insert(stockReturnReceiptLines).values({
      batchLineId: line.id,
      quarantineLotId: fx.quarantineLotId,
      receivedQuantity: "5",
      dispositionReasonCode: "SPOILED",
    });
    await expect(
      db.insert(stockReturnReceiptLines).values({
        batchLineId: line.id,
        quarantineLotId: fx.quarantineLotId,
        receivedQuantity: "5",
        dispositionReasonCode: "SPOILED",
      }),
    ).rejects.toThrow();
  });

  it("prevents two receipt lines from claiming the same quarantine-in posting line", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    const lineA = await insertLine(fx, batch.id, { lineNo: 1 });
    const lineB = await insertLine(fx, batch.id, { lineNo: 2 });
    const postingLine = await postingLineFixture(fx);
    await db.insert(stockReturnReceiptLines).values({
      batchLineId: lineA.id,
      quarantineLotId: fx.quarantineLotId,
      receivedQuantity: "5",
      dispositionReasonCode: "SPOILED",
      quarantineInPostingLineId: postingLine.id,
    });
    await expect(
      db.insert(stockReturnReceiptLines).values({
        batchLineId: lineB.id,
        quarantineLotId: fx.quarantineLotId,
        receivedQuantity: "5",
        dispositionReasonCode: "SPOILED",
        quarantineInPostingLineId: postingLine.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects a receipt line whose quarantine-in and disposition-out point at the same posting line", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    const line = await insertLine(fx, batch.id);
    const postingLine = await postingLineFixture(fx);
    await expect(
      db.insert(stockReturnReceiptLines).values({
        batchLineId: line.id,
        quarantineLotId: fx.quarantineLotId,
        receivedQuantity: "5",
        dispositionReasonCode: "SPOILED",
        quarantineInPostingLineId: postingLine.id,
        dispositionOutPostingLineId: postingLine.id,
      }),
    ).rejects.toThrow();
  });

  it("keeps posted receipt lines append-only (no update, no delete)", async () => {
    const fx = await fixture();
    const batch = await insertBatch(fx);
    const line = await insertLine(fx, batch.id);
    const [receipt] = await db
      .insert(stockReturnReceiptLines)
      .values({
        batchLineId: line.id,
        quarantineLotId: fx.quarantineLotId,
        receivedQuantity: "5",
        dispositionReasonCode: "SPOILED",
      })
      .returning();
    await expect(
      db
        .update(stockReturnReceiptLines)
        .set({ receivedQuantity: "4" })
        .where(eq(stockReturnReceiptLines.id, receipt.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.id, receipt.id)),
    ).rejects.toThrow();
  });

  it("links dispatch and receipt operational_documents one-to-one with a batch", async () => {
    const fx = await fixture();
    const [dispatchDoc] = await db
      .insert(operationalDocuments)
      .values({
        module: "STOCK_RETURN_DISPATCH",
        documentNo: `DISP-${randomUUID()}`,
        locationId: fx.outletLocationId,
        status: "APPROVED",
      })
      .returning();
    const [receiptDoc] = await db
      .insert(operationalDocuments)
      .values({
        module: "STOCK_RETURN_RECEIPT",
        documentNo: `RECV-${randomUUID()}`,
        locationId: fx.hqLocationId,
        status: "APPROVED",
      })
      .returning();
    const batch = await insertBatch(fx, {
      dispatchDocumentId: dispatchDoc.id,
      receiptDocumentId: receiptDoc.id,
      status: "DISPATCHED",
    });
    expect(batch).toMatchObject({ dispatchDocumentId: dispatchDoc.id, receiptDocumentId: receiptDoc.id });

    const otherBatch = await insertBatch(fx);
    await expect(
      db
        .update(stockReturnBatches)
        .set({ dispatchDocumentId: dispatchDoc.id })
        .where(eq(stockReturnBatches.id, otherBatch.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(stockReturnBatches)
        .set({ receiptDocumentId: receiptDoc.id })
        .where(eq(stockReturnBatches.id, otherBatch.id)),
    ).rejects.toThrow();
  });

  it("is replay-safe: reapplying migration 0028 does not duplicate enum types", async () => {
    const migrationsDir = resolve(process.cwd(), "drizzle");
    const body = readFileSync(resolve(migrationsDir, "0028_stock_return_batches.sql"), "utf8").replaceAll(
      "--> statement-breakpoint",
      "\n",
    );
    await client.transaction(async (tx) => {
      await tx.exec(body);
    });
    const { rows } = (await client.query(
      `select count(*)::int as count from pg_type where typname in ('stock_return_batch_status','stock_return_reason')`,
    )) as { rows: { count: number }[] };
    expect(rows[0]?.count).toBe(2);
  });
});
