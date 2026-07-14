import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLotBalances,
  inventoryLotGenealogy,
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses } from "../src/db/schema.js";
import {
  stockReturnBatchLines,
  stockReturnBatches,
  stockReturnReceiptLines,
} from "../src/db/returns-schema.js";
import { StockPostingError } from "../src/modules/stock/errors.js";
import { StockReturnError } from "../src/modules/stock-returns/errors.js";
import { createStockReturnService } from "../src/modules/stock-returns/service.js";
import type {
  CreateStockReturnBatchInput,
  ReceiptLineInput,
  StockReturnLineInput,
} from "../src/modules/stock-returns/types.js";
import { STOCK_RETURN_MAX_LINES } from "../src/modules/stock-returns/policies.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;
let hqLocationId: string;
let hqQuarantineWarehouseId: string;

interface Fixture {
  outletLocationId: string;
  outletWarehouseId: string;
  itemId: string;
  lotId: string;
  creatorUserId: string;
  approverUserId: string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  // ONE configured active HQ for the whole file, matching D35-D46 §1: the
  // system requires exactly one active HQ_MAIN warehouse globally.
  const [hq] = await db
    .insert(locations)
    .values({ code: "SRS-HQ", name: "Stock Return Service HQ" })
    .returning();
  hqLocationId = hq!.id;
  await db.insert(warehouses).values({
    locationId: hq!.id,
    type: "MAIN",
    purpose: "HQ_MAIN",
    code: "WH-SRS-HQ-MAIN",
    name: "SRS HQ Main Warehouse",
  });
  const [hqQuarantine] = await db
    .insert(warehouses)
    .values({
      // `type` is the legacy MAIN/KITCHEN identity, distinct from `purpose`
      // (the enterprise identity). Using KITCHEN here just avoids colliding
      // with the HQ_MAIN warehouse's (locationId, type) unique index at the
      // same physical HQ location.
      locationId: hq!.id,
      type: "KITCHEN",
      purpose: "QUARANTINE",
      code: "WH-SRS-HQ-QUARANTINE",
      name: "SRS HQ Quarantine Warehouse",
    })
    .returning();
  hqQuarantineWarehouseId = hqQuarantine!.id;

  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

async function setFlags(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.returns"));
}

async function fixture(onHand = "100.000000"): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [outlet] = await db
    .insert(locations)
    .values({ code: `SRS-O-${suffix}`, name: `SRS Outlet ${suffix}` })
    .returning();
  const [outletWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: outlet!.id,
      type: "KITCHEN",
      purpose: "KITCHEN",
      code: `WH-SRS-${suffix}`,
      name: `SRS Kitchen ${suffix}`,
    })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `SRS-ITEM-${suffix}`,
      name: `SRS Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item!.id, lotCode: `SRS-LOT-${suffix}`, unitCost: "10.000000" })
    .returning();
  await db.insert(inventoryLotBalances).values({ warehouseId: outletWarehouse!.id, lotId: lot!.id, onHand, reserved: "0" });
  const [creator] = await db
    .insert(users)
    .values({
      name: `SRS Creator ${suffix}`,
      email: `srs-creator-${suffix}@test.local`,
      passwordHash: "hash",
      role: "WAREHOUSE_OUTLET",
    })
    .returning();
  await db.insert(userOutletAccess).values({ userId: creator!.id, locationId: outlet!.id });
  const [approver] = await db
    .insert(users)
    .values({
      name: `SRS Approver ${suffix}`,
      email: `srs-approver-${suffix}@test.local`,
      passwordHash: "hash",
      role: "WAREHOUSE_MAIN",
    })
    .returning();
  return {
    outletLocationId: outlet!.id,
    outletWarehouseId: outletWarehouse!.id,
    itemId: item!.id,
    lotId: lot!.id,
    creatorUserId: creator!.id,
    approverUserId: approver!.id,
  };
}

/**
 * Bulk-provisions `count` distinct item/lot pairs in fx's own outlet
 * warehouse so a movement-cap boundary test can build a batch with an exact
 * line count without colliding with the DUPLICATE_LINE (itemId:lotId:
 * sourceWarehouseId) check.
 */
async function manyLines(fx: Fixture, count: number): Promise<StockReturnLineInput[]> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const itemRows = await db
    .insert(ingredients)
    .values(
      Array.from({ length: count }, (_, i) => ({
        code: `SRS-CAP-${suffix}-${i}`,
        name: `SRS Cap Item ${suffix}-${i}`,
        unit: "kg",
        itemType: "RAW" as const,
        lotTracked: true,
        unitCost: "10.0000",
        lowStockThreshold: "1.0000",
      })),
    )
    .returning();
  const lotRows = await db
    .insert(inventoryLots)
    .values(
      itemRows.map((item, i) => ({
        itemId: item.id,
        lotCode: `SRS-CAP-LOT-${suffix}-${i}`,
        unitCost: "10.000000",
      })),
    )
    .returning();
  await db.insert(inventoryLotBalances).values(
    lotRows.map((lot) => ({
      warehouseId: fx.outletWarehouseId,
      lotId: lot.id,
      onHand: "5.000000",
      reserved: "0",
    })),
  );
  return itemRows.map((item, i) => ({
    itemId: item.id,
    lotId: lotRows[i]!.id,
    sourceWarehouseId: fx.outletWarehouseId,
    quantity: "1.000000",
    enteredQuantity: "1.000000",
    enteredUom: "kg",
    conversionFactor: "1.00000000",
    reasonCode: "SPOILED" as const,
  }));
}

function draftInput(
  fx: Fixture,
  overrides: Partial<CreateStockReturnBatchInput> = {},
): CreateStockReturnBatchInput {
  return {
    sourceLocationId: fx.outletLocationId,
    remarks: "Test batch",
    lines: [
      {
        itemId: fx.itemId,
        lotId: fx.lotId,
        sourceWarehouseId: fx.outletWarehouseId,
        quantity: "5.000000",
        enteredQuantity: "5.000000",
        enteredUom: "kg",
        conversionFactor: "1.00000000",
        reasonCode: "SPOILED",
      },
    ],
    ...overrides,
  };
}

function service() {
  return createStockReturnService(db);
}

async function toApproved(
  svc: ReturnType<typeof createStockReturnService>,
  fx: Fixture,
  input?: CreateStockReturnBatchInput,
) {
  const draft = await svc.createDraft({ actorUserId: fx.creatorUserId }, input ?? draftInput(fx));
  const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, {
    batchId: draft.id,
    version: draft.version,
  });
  const approved = await svc.approve({ actorUserId: fx.approverUserId }, {
    batchId: submitted.id,
    version: submitted.version,
  });
  return approved;
}

async function balanceOf(warehouseId: string, lotId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row?.onHand;
}

describe("stock return batch service", () => {
  it("keeps every operation dark until the stock.returns feature flag is enabled", async () => {
    await setFlags(false);
    const fx = await fixture();
    await expect(
      service().createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx)),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
  });

  it("happy path: create, submit, approve, dispatch, and receive+dispose a multi-line batch", async () => {
    await setFlags(true);
    const fx = await fixture("50.000000");
    const suffix = randomUUID().slice(0, 8);
    const [item2] = await db
      .insert(ingredients)
      .values({
        code: `SRS-ITEM2-${suffix}`,
        name: `SRS Item2 ${suffix}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "20.0000",
        lowStockThreshold: "1.0000",
      })
      .returning();
    const [lot2] = await db
      .insert(inventoryLots)
      .values({ itemId: item2!.id, lotCode: `SRS-LOT2-${suffix}`, unitCost: "20.000000" })
      .returning();
    await db.insert(inventoryLotBalances).values({ warehouseId: fx.outletWarehouseId, lotId: lot2!.id, onHand: "30.000000" });

    const svc = service();
    const input = draftInput(fx, {
      lines: [
        {
          itemId: fx.itemId,
          lotId: fx.lotId,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "10.000000",
          enteredQuantity: "10.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "EXPIRED",
        },
        {
          itemId: item2!.id,
          lotId: lot2!.id,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "5.000000",
          enteredQuantity: "5.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "SPOILED",
        },
      ],
    });

    const draft = await svc.createDraft({ actorUserId: fx.creatorUserId }, input);
    expect(draft).toMatchObject({ status: "DRAFT", sourceLocationId: fx.outletLocationId, destinationLocationId: hqLocationId });
    const lines = await db
      .select()
      .from(stockReturnBatchLines)
      .where(eq(stockReturnBatchLines.batchId, draft.id))
      .orderBy(stockReturnBatchLines.lineNo);
    expect(lines).toHaveLength(2);

    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { batchId: draft.id, version: draft.version });
    expect(submitted.status).toBe("SUBMITTED");

    const approved = await svc.approve({ actorUserId: fx.approverUserId }, { batchId: submitted.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");

    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    expect(dispatched.status).toBe("DISPATCHED");

    expect(await balanceOf(fx.outletWarehouseId, fx.lotId)).toBe("40.000000");
    expect(await balanceOf(fx.outletWarehouseId, lot2!.id)).toBe("25.000000");

    const received = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [
        { batchLineId: lines[0]!.id, dispositionReasonCode: "DAMAGED", dispositionRemarks: "Disposed at HQ" },
        { batchLineId: lines[1]!.id, dispositionReasonCode: "RECALLED" },
      ],
    });
    expect(received.status).toBe("RECEIVED_DISPOSED");

    for (const line of lines) {
      const lotCode = `RETURN:${draft.id}:${line.lineNo}`;
      const [qLot] = await db
        .select()
        .from(inventoryLots)
        .where(and(eq(inventoryLots.itemId, line.itemId), eq(inventoryLots.lotCode, lotCode)));
      expect(qLot).toBeTruthy();
      expect(qLot!.status).toBe("QUARANTINED");

      expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("0.000000");

      const [genealogy] = await db
        .select()
        .from(inventoryLotGenealogy)
        .where(and(eq(inventoryLotGenealogy.parentLotId, line.lotId), eq(inventoryLotGenealogy.childLotId, qLot!.id)));
      expect(genealogy).toBeTruthy();

      const [receiptRow] = await db
        .select()
        .from(stockReturnReceiptLines)
        .where(eq(stockReturnReceiptLines.batchLineId, line.id));
      expect(receiptRow).toBeTruthy();
      expect(receiptRow!.quarantineInPostingLineId).toBeTruthy();
      expect(receiptRow!.dispositionOutPostingLineId).toBeTruthy();
      expect(receiptRow!.quarantineInPostingLineId).not.toBe(receiptRow!.dispositionOutPostingLineId);
    }
  });

  it("rejects a line whose source warehouse belongs to a different outlet ('borrowing')", async () => {
    await setFlags(true);
    const fx = await fixture();
    const otherFx = await fixture();
    const input = draftInput(fx, {
      lines: [{ ...draftInput(fx).lines[0]!, sourceWarehouseId: otherFx.outletWarehouseId }],
    });
    await expect(service().createDraft({ actorUserId: fx.creatorUserId }, input)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects a caller-declared destination that isn't the server-resolved HQ route", async () => {
    await setFlags(true);
    const fx = await fixture();
    await expect(
      service().createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx, { destinationLocationId: fx.outletLocationId })),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ROUTE" });
    await expect(
      service().createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx, { destinationWarehouseId: fx.outletWarehouseId })),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ROUTE" });
  });

  it("rejects a self-return whose source outlet is the configured HQ location", async () => {
    await setFlags(true);
    const [ownerActor] = await db
      .insert(users)
      .values({ name: "HQ Self Actor", email: `srs-self-${randomUUID()}@test.local`, passwordHash: "hash", role: "OWNER" })
      .returning();
    const fx = await fixture();
    await expect(
      service().createDraft(
        { actorUserId: ownerActor!.id },
        draftInput(fx, { sourceLocationId: hqLocationId }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an actor whose outlet access does not cover the source outlet on create and dispatch", async () => {
    await setFlags(true);
    const fx = await fixture();
    const otherFx = await fixture();
    await expect(
      service().createDraft({ actorUserId: otherFx.creatorUserId }, draftInput(fx)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const approved = await toApproved(service(), fx);
    await expect(
      service().dispatch({ actorUserId: otherFx.creatorUserId }, { batchId: approved.id, version: approved.version }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rolls back the whole dispatch (document, posting, ledger, balance) when stock is insufficient", async () => {
    await setFlags(true);
    const fx = await fixture("5.000000");
    const input = draftInput(fx, {
      lines: [{ ...draftInput(fx).lines[0]!, quantity: "10.000000", enteredQuantity: "10.000000" }],
    });
    const approved = await toApproved(service(), fx, input);

    const postingCountBefore = (await db.select({ id: stockPostings.id }).from(stockPostings)).length;
    const lineCountBefore = (await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length;

    let caught: unknown;
    try {
      await service().dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockPostingError);
    expect((caught as StockPostingError).code).toBe("INSUFFICIENT_STOCK");

    const [batchRow] = await db.select().from(stockReturnBatches).where(eq(stockReturnBatches.id, approved.id));
    expect(batchRow).toMatchObject({ status: "APPROVED", version: approved.version });

    const dispatchDocs = await db
      .select()
      .from(operationalDocuments)
      .where(
        and(
          eq(operationalDocuments.module, "STOCK_RETURN_DISPATCH"),
          eq(operationalDocuments.documentNo, `${approved.documentNo}:DISPATCH`),
        ),
      );
    expect(dispatchDocs).toHaveLength(0);

    expect((await db.select({ id: stockPostings.id }).from(stockPostings)).length).toBe(postingCountBefore);
    expect((await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length).toBe(lineCountBefore);
    expect(await balanceOf(fx.outletWarehouseId, fx.lotId)).toBe("5.000000");
  });

  it("is idempotent: retried dispatch() and receiveAndDispose() calls replay without double posting", async () => {
    await setFlags(true);
    const fx = await fixture("50.000000");
    const svc = service();
    const approved = await toApproved(svc, fx);

    const first = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    expect(first.status).toBe("DISPATCHED");
    const second = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    expect(second.status).toBe("DISPATCHED");
    expect(second.id).toBe(first.id);

    const dispatchPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${approved.documentNo}:DISPATCH`));
    expect(dispatchPostings).toHaveLength(1);
    expect(
      await db.select().from(stockPostingLines).where(eq(stockPostingLines.postingId, dispatchPostings[0]!.id)),
    ).toHaveLength(1);
    expect(await balanceOf(fx.outletWarehouseId, fx.lotId)).toBe("45.000000");

    const [line] = await db.select().from(stockReturnBatchLines).where(eq(stockReturnBatchLines.batchId, approved.id));
    const receiptLines: ReceiptLineInput[] = [{ batchLineId: line!.id, dispositionReasonCode: "DAMAGED" }];

    const receivedFirst = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: first.id,
      version: first.version,
      receiptLines,
    });
    expect(receivedFirst.status).toBe("RECEIVED_DISPOSED");
    const receivedSecond = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: first.id,
      version: first.version,
      receiptLines,
    });
    expect(receivedSecond.status).toBe("RECEIVED_DISPOSED");

    const receiptPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${approved.documentNo}:RECEIPT`));
    expect(receiptPostings).toHaveLength(1);
    expect(
      await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, line!.id)),
    ).toHaveLength(1);
  });

  it("rejects invalid transitions: dispatch on DRAFT/SUBMITTED, and a second approve()", async () => {
    await setFlags(true);
    const fx = await fixture();
    const svc = service();
    const draft = await svc.createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx));

    await expect(
      svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: draft.id, version: draft.version }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { batchId: draft.id, version: draft.version });
    await expect(
      svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: submitted.id, version: submitted.version }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const approved = await svc.approve({ actorUserId: fx.approverUserId }, { batchId: submitted.id, version: submitted.version });
    await expect(
      svc.approve({ actorUserId: fx.approverUserId }, { batchId: approved.id, version: approved.version }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("keeps the dispatch-time reason and the disposition-time reason independent per line", async () => {
    await setFlags(true);
    const fx = await fixture("50.000000");
    const suffix = randomUUID().slice(0, 8);
    const [item2] = await db
      .insert(ingredients)
      .values({
        code: `SRS-I2-${suffix}`,
        name: `SRS I2 ${suffix}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "5.0000",
        lowStockThreshold: "1.0000",
      })
      .returning();
    const [lot2] = await db
      .insert(inventoryLots)
      .values({ itemId: item2!.id, lotCode: `SRS-L2-${suffix}`, unitCost: "5.000000" })
      .returning();
    await db.insert(inventoryLotBalances).values({ warehouseId: fx.outletWarehouseId, lotId: lot2!.id, onHand: "20.000000" });

    const svc = service();
    const input = draftInput(fx, {
      lines: [
        {
          itemId: fx.itemId,
          lotId: fx.lotId,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "3.000000",
          enteredQuantity: "3.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "EXPIRED",
        },
        {
          itemId: item2!.id,
          lotId: lot2!.id,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "2.000000",
          enteredQuantity: "2.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "SPOILED",
        },
      ],
    });
    const approved = await toApproved(svc, fx, input);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    const lines = await db
      .select()
      .from(stockReturnBatchLines)
      .where(eq(stockReturnBatchLines.batchId, approved.id))
      .orderBy(stockReturnBatchLines.lineNo);

    await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [
        { batchLineId: lines[0]!.id, dispositionReasonCode: "DAMAGED" },
        { batchLineId: lines[1]!.id, dispositionReasonCode: "RECALLED" },
      ],
    });

    expect(lines[0]!.reasonCode).toBe("EXPIRED");
    expect(lines[1]!.reasonCode).toBe("SPOILED");
    const [receipt0] = await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, lines[0]!.id));
    const [receipt1] = await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, lines[1]!.id));
    expect(receipt0!.dispositionReasonCode).toBe("DAMAGED");
    expect(receipt1!.dispositionReasonCode).toBe("RECALLED");
  });

  it("leaves the quarantine lot balance at exactly zero and the lot non-allocatable after disposition", async () => {
    await setFlags(true);
    const fx = await fixture("20.000000");
    const svc = service();
    const approved = await toApproved(svc, fx);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    const [line] = await db.select().from(stockReturnBatchLines).where(eq(stockReturnBatchLines.batchId, approved.id));

    await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [{ batchLineId: line!.id, dispositionReasonCode: "SPOILED" }],
    });

    const [qLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, fx.itemId), eq(inventoryLots.lotCode, `RETURN:${approved.id}:${line!.lineNo}`)));
    expect(qLot!.status).toBe("QUARANTINED");
    expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("0.000000");
  });

  it("leaves a positive quarantine balance for an OTHER-reason (reusable) receipt line instead of zeroing it out", async () => {
    await setFlags(true);
    const fx = await fixture("20.000000");
    const svc = service();
    const approved = await toApproved(svc, fx);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    const [line] = await db.select().from(stockReturnBatchLines).where(eq(stockReturnBatchLines.batchId, approved.id));

    const received = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [{ batchLineId: line!.id, dispositionReasonCode: "OTHER", dispositionRemarks: "Wrong item sent back, still sealed" }],
    });
    expect(received.status).toBe("RECEIVED_DISPOSED");

    const [qLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, fx.itemId), eq(inventoryLots.lotCode, `RETURN:${approved.id}:${line!.lineNo}`)));
    expect(qLot!.status).toBe("QUARANTINED");
    // Unlike a disposition reason, the quarantine IN has no compensating OUT:
    // the full received quantity remains quarantined for a later QA Release.
    expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("5.000000");

    const [receiptRow] = await db
      .select()
      .from(stockReturnReceiptLines)
      .where(eq(stockReturnReceiptLines.batchLineId, line!.id));
    expect(receiptRow!.quarantineInPostingLineId).toBeTruthy();
    expect(receiptRow!.dispositionOutPostingLineId).toBeNull();
  });

  it("in a mixed-reason batch, zeros the disposition-reason line but retains the OTHER-reason line's quarantine balance", async () => {
    await setFlags(true);
    const fx = await fixture("50.000000");
    const suffix = randomUUID().slice(0, 8);
    const [item2] = await db
      .insert(ingredients)
      .values({
        code: `SRS-MIX-${suffix}`,
        name: `SRS Mix ${suffix}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "8.0000",
        lowStockThreshold: "1.0000",
      })
      .returning();
    const [lot2] = await db
      .insert(inventoryLots)
      .values({ itemId: item2!.id, lotCode: `SRS-MIX-LOT-${suffix}`, unitCost: "8.000000" })
      .returning();
    await db.insert(inventoryLotBalances).values({ warehouseId: fx.outletWarehouseId, lotId: lot2!.id, onHand: "15.000000" });

    const svc = service();
    const input = draftInput(fx, {
      lines: [
        {
          itemId: fx.itemId,
          lotId: fx.lotId,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "4.000000",
          enteredQuantity: "4.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "SPOILED",
        },
        {
          itemId: item2!.id,
          lotId: lot2!.id,
          sourceWarehouseId: fx.outletWarehouseId,
          quantity: "6.000000",
          enteredQuantity: "6.000000",
          enteredUom: "kg",
          conversionFactor: "1.00000000",
          reasonCode: "SPOILED",
        },
      ],
    });
    const approved = await toApproved(svc, fx, input);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    const lines = await db
      .select()
      .from(stockReturnBatchLines)
      .where(eq(stockReturnBatchLines.batchId, approved.id))
      .orderBy(stockReturnBatchLines.lineNo);

    const received = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [
        { batchLineId: lines[0]!.id, dispositionReasonCode: "DAMAGED" },
        { batchLineId: lines[1]!.id, dispositionReasonCode: "OTHER" },
      ],
    });
    expect(received.status).toBe("RECEIVED_DISPOSED");

    const [qLot0] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, lines[0]!.itemId), eq(inventoryLots.lotCode, `RETURN:${approved.id}:${lines[0]!.lineNo}`)));
    expect(await balanceOf(hqQuarantineWarehouseId, qLot0!.id)).toBe("0.000000");
    const [receipt0] = await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, lines[0]!.id));
    expect(receipt0!.dispositionOutPostingLineId).toBeTruthy();

    const [qLot1] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, lines[1]!.itemId), eq(inventoryLots.lotCode, `RETURN:${approved.id}:${lines[1]!.lineNo}`)));
    expect(await balanceOf(hqQuarantineWarehouseId, qLot1!.id)).toBe("6.000000");
    const [receipt1] = await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, lines[1]!.id));
    expect(receipt1!.dispositionOutPostingLineId).toBeNull();
    expect(receipt1!.quarantineInPostingLineId).toBeTruthy();
  });

  it("is idempotent for an OTHER-reason receive: a retried call replays without double-crediting the quarantine balance", async () => {
    await setFlags(true);
    const fx = await fixture("50.000000");
    const svc = service();
    const approved = await toApproved(svc, fx);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { batchId: approved.id, version: approved.version });
    const [line] = await db.select().from(stockReturnBatchLines).where(eq(stockReturnBatchLines.batchId, approved.id));
    const receiptLines: ReceiptLineInput[] = [{ batchLineId: line!.id, dispositionReasonCode: "OTHER" }];

    const first = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines,
    });
    expect(first.status).toBe("RECEIVED_DISPOSED");
    const second = await svc.receiveAndDispose({ actorUserId: fx.approverUserId }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines,
    });
    expect(second.status).toBe("RECEIVED_DISPOSED");

    const [qLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, fx.itemId), eq(inventoryLots.lotCode, `RETURN:${approved.id}:${line!.lineNo}`)));
    expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("5.000000");

    const receiptPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${approved.documentNo}:RECEIPT`));
    expect(receiptPostings).toHaveLength(1);
    expect(
      await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, line!.id)),
    ).toHaveLength(1);
  });

  it("rejects a creator approving their own batch (segregation of duties)", async () => {
    await setFlags(true);
    const fx = await fixture();
    const [ownerActor] = await db
      .insert(users)
      .values({ name: "SoD Owner", email: `srs-sod-${randomUUID()}@test.local`, passwordHash: "hash", role: "OWNER" })
      .returning();
    const svc = service();
    const draft = await svc.createDraft({ actorUserId: ownerActor!.id }, draftInput(fx));
    const submitted = await svc.submit({ actorUserId: ownerActor!.id }, { batchId: draft.id, version: draft.version });
    await expect(
      svc.approve({ actorUserId: ownerActor!.id }, { batchId: submitted.id, version: submitted.version }),
    ).rejects.toMatchObject({ code: "SEGREGATION_OF_DUTIES" });
  });

  it("rejects a stale version on a repeated updateDraftLines call", async () => {
    await setFlags(true);
    const fx = await fixture();
    const svc = service();
    const draft = await svc.createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx));
    await svc.updateDraftLines({ actorUserId: fx.creatorUserId }, {
      batchId: draft.id,
      version: draft.version,
      lines: draftInput(fx).lines,
    });
    await expect(
      svc.updateDraftLines({ actorUserId: fx.creatorUserId }, {
        batchId: draft.id,
        version: draft.version,
        lines: draftInput(fx).lines,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("allows a DRAFT/SUBMITTED/APPROVED batch to be cancelled but never a DISPATCHED one", async () => {
    await setFlags(true);
    const fx = await fixture();
    const svc = service();
    const draft = await svc.createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx));
    const cancelled = await svc.cancel({ actorUserId: fx.creatorUserId }, {
      batchId: draft.id,
      version: draft.version,
      cancelReason: "Created in error",
    });
    expect(cancelled.status).toBe("CANCELLED");

    const fx2 = await fixture("50.000000");
    const approved = await toApproved(svc, fx2);
    const dispatched = await svc.dispatch({ actorUserId: fx2.creatorUserId }, { batchId: approved.id, version: approved.version });
    await expect(
      svc.cancel({ actorUserId: fx2.creatorUserId }, {
        batchId: dispatched.id,
        version: dispatched.version,
        cancelReason: "Too late",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it(`accepts a draft at exactly the ${STOCK_RETURN_MAX_LINES}-line movement-cap boundary`, async () => {
    await setFlags(true);
    const fx = await fixture();
    const lines = await manyLines(fx, STOCK_RETURN_MAX_LINES);
    const draft = await service().createDraft(
      { actorUserId: fx.creatorUserId },
      draftInput(fx, { lines }),
    );
    expect(draft.status).toBe("DRAFT");
    const storedLines = await db
      .select()
      .from(stockReturnBatchLines)
      .where(eq(stockReturnBatchLines.batchId, draft.id));
    expect(storedLines).toHaveLength(STOCK_RETURN_MAX_LINES);
  });

  it(`rejects a ${STOCK_RETURN_MAX_LINES + 1}-line draft before any batch/document/line creation, with a stable VALIDATION code`, async () => {
    await setFlags(true);
    const fx = await fixture();
    const lines = await manyLines(fx, STOCK_RETURN_MAX_LINES + 1);

    const [{ count: batchCountBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockReturnBatches);
    const [{ count: lineCountBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockReturnBatchLines);
    const [{ count: documentCountBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(operationalDocuments);

    let caught: unknown;
    try {
      await service().createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx, { lines }));
      throw new Error("expected createDraft to reject a batch exceeding the movement-cap line limit");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockReturnError);
    expect((caught as StockReturnError).code).toBe("VALIDATION");
    expect((caught as StockReturnError).status).toBe(400);

    const [{ count: batchCountAfter }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockReturnBatches);
    const [{ count: lineCountAfter }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockReturnBatchLines);
    const [{ count: documentCountAfter }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(operationalDocuments);
    expect(batchCountAfter).toBe(batchCountBefore);
    expect(lineCountAfter).toBe(lineCountBefore);
    expect(documentCountAfter).toBe(documentCountBefore);
  });

  it("propagates StockReturnError instances with a stable code/status shape", async () => {
    await setFlags(true);
    const fx = await fixture();
    try {
      await service().createDraft({ actorUserId: fx.creatorUserId }, draftInput(fx, { lines: [] }));
      throw new Error("expected createDraft to reject an empty line list");
    } catch (error) {
      expect(error).toBeInstanceOf(StockReturnError);
      expect((error as StockReturnError).code).toBe("VALIDATION");
      expect((error as StockReturnError).status).toBe(400);
    }
  });
});
