/**
 * QA Release lifecycle coverage: happy-path partial + full release from HQ
 * QUARANTINE to HQ_MAIN, REASON_NOT_RELEASABLE for every disposition-only
 * stock_return_reason value (proving D35-D46 §5's "disposition-reason stock
 * never becomes allocatable HQ stock" invariant), over-release refusal
 * (single-shot and sibling-release accounting across two releases against the
 * same stock_return_receipt_line), a concurrent over-release race, idempotent
 * duplicate release() replay, version conflicts, segregation of duties,
 * pre/post-release cancel, flag-off dark-mode gating (draft/submit/approve OK,
 * release refused), and the qa_release_route_check DB trigger rejecting
 * wrong-purpose warehouses directly.
 *
 * Fixture setup mirrors test/transfer-order-lifecycle.test.ts (shared HQ_MAIN
 * + QUARANTINE + stock.lot_writes/topology preconditions) but seeds
 * stock_return_batch/stock_return_batch_line/stock_return_receipt_line rows
 * DIRECTLY (not via stock-returns' receiveAndDisposeStockReturnBatch()) so
 * this module's own unit coverage stays independent of stock-returns'
 * internals — see the note at the bottom of this file, and
 * test/return-to-qa-release-e2e.test.ts for the real end-to-end chain.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLotBalances,
  inventoryLotGenealogy,
  inventoryLots,
  operationalFeatureFlags,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { stockReturnBatchLines, stockReturnBatches, stockReturnReceiptLines } from "../src/db/returns-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { qaReleaseLines, qaReleases } from "../src/db/transfer-orders-schema.js";
import { QaReleaseError } from "../src/modules/qa-releases/errors.js";
import { createQaReleaseService } from "../src/modules/qa-releases/service.js";
import type { QaReleaseLineInput } from "../src/modules/qa-releases/types.js";
import { StockPostingError } from "../src/modules/stock/errors.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;
let hqLocationId: string;
let hqMainWarehouseId: string;
let quarantineWarehouseId: string;
let outletLocationId: string;
let outletStorageWarehouseId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  const [hqLocation] = await db
    .insert(locations)
    .values({ code: `QAR-HQ-${randomUUID().slice(0, 8)}`, name: "QA Release Lifecycle HQ" })
    .returning();
  hqLocationId = hqLocation!.id;
  const [hqWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: hqLocationId,
      type: "MAIN",
      purpose: "HQ_MAIN",
      code: `WH-QAR-HQ-${randomUUID().slice(0, 8)}`,
      name: "QA Release Lifecycle HQ Main Warehouse",
    })
    .returning();
  hqMainWarehouseId = hqWarehouse!.id;
  const [quarantineWarehouse] = await db
    .insert(warehouses)
    .values({
      // "KITCHEN" here is just the `type` column value avoiding a collision
      // with the HQ_MAIN warehouse's (location_id, type) unique index at the
      // same physical HQ location; `purpose` (the enterprise identity) is
      // what matters — same convention as test/stock-return-lifecycle.test.ts.
      locationId: hqLocationId,
      type: "KITCHEN",
      purpose: "QUARANTINE",
      code: `WH-QAR-QTN-${randomUUID().slice(0, 8)}`,
      name: "QA Release Lifecycle Quarantine Warehouse",
    })
    .returning();
  quarantineWarehouseId = quarantineWarehouse!.id;

  const [outletLocation] = await db
    .insert(locations)
    .values({ code: `QAR-OUT-${randomUUID().slice(0, 8)}`, name: "QA Release Lifecycle Outlet" })
    .returning();
  outletLocationId = outletLocation!.id;
  const [outletStorage] = await db
    .insert(warehouses)
    .values({
      locationId: outletLocationId,
      type: "MAIN",
      purpose: "OUTLET_STORAGE",
      code: `WH-QAR-OUT-${randomUUID().slice(0, 8)}`,
      name: "QA Release Lifecycle Outlet Storage",
    })
    .returning();
  outletStorageWarehouseId = outletStorage!.id;

  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function setReturnsEnabled(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.returns"));
}

async function makeItem() {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `QAR-ITEM-${s}`,
      name: `QAR Item ${s}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  return item!;
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `QAR User ${s}`, email: `qar-${s}@test.local`, passwordHash: "hash", role, status })
    .returning();
  return user!;
}

async function grantAccess(userId: string, locationId: string) {
  await db.insert(userOutletAccess).values({ userId, locationId });
}

type ReasonCode = "SPOILED" | "EXPIRED" | "DAMAGED" | "RECALLED" | "OTHER";

/**
 * Seeds a stock_return_batch -> stock_return_batch_line -> stock_return_
 * receipt_line chain DIRECTLY (bypassing stock-returns' service), plus a
 * QUARANTINED inventory_lot with a genuinely positive on-hand balance at the
 * quarantine warehouse. See this file's header comment for why: the current
 * receiveAndDisposeStockReturnBatch() always posts an immediate quarantine
 * IN + DISPOSITION OUT pair for the FULL received quantity regardless of
 * reason code (posting-service.ts's RETURN_DISPOSITION route class enforces
 * net-zero IN/OUT per item/lot), so no receipt line reachable through that
 * function's real runtime behavior would ever carry a nonzero quarantine
 * balance to release against, for ANY reason including OTHER. This fixture
 * constructs the schema-correct state QA Release's own contract depends on
 * (a receipt line whose quarantine lot genuinely still holds `receivedQty`)
 * directly, independent of that upstream gap.
 */
async function makeReceiptLine(
  itemId: string,
  opts: { receivedQuantity?: string; reasonCode?: ReasonCode; unitCost?: string } = {},
) {
  const s = suffix();
  const receivedQuantity = opts.receivedQuantity ?? "10.000000";
  const reasonCode = opts.reasonCode ?? "OTHER";
  const unitCost = opts.unitCost ?? "10.000000";

  const [sourceLot] = await db
    .insert(inventoryLots)
    .values({ itemId, lotCode: `QAR-SRC-${s}`, unitCost, status: "AVAILABLE" })
    .returning();

  const [batch] = await db
    .insert(stockReturnBatches)
    .values({
      documentNo: `SRB-QAR-${s}`,
      sourceLocationId: outletLocationId,
      destinationLocationId: hqLocationId,
      destinationWarehouseId: hqMainWarehouseId,
      status: "RECEIVED_DISPOSED",
    })
    .returning();

  const [batchLine] = await db
    .insert(stockReturnBatchLines)
    .values({
      batchId: batch!.id,
      lineNo: 1,
      itemId,
      lotId: sourceLot!.id,
      sourceWarehouseId: outletStorageWarehouseId,
      quantity: receivedQuantity,
      enteredQuantity: receivedQuantity,
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      reasonCode,
    })
    .returning();

  const [quarantineLot] = await db
    .insert(inventoryLots)
    .values({ itemId, lotCode: `QAR-QTN-${s}`, unitCost, status: "QUARANTINED" })
    .returning();
  await db.insert(inventoryLotBalances).values({
    warehouseId: quarantineWarehouseId,
    lotId: quarantineLot!.id,
    onHand: receivedQuantity,
  });

  const [receiptLine] = await db
    .insert(stockReturnReceiptLines)
    .values({
      batchLineId: batchLine!.id,
      quarantineLotId: quarantineLot!.id,
      receivedQuantity,
      dispositionReasonCode: reasonCode,
    })
    .returning();

  return { receiptLine: receiptLine!, quarantineLot: quarantineLot!, batch: batch! };
}

function lineInput(receiptLineId: string, overrides: Partial<QaReleaseLineInput> = {}): QaReleaseLineInput {
  return {
    sourceReturnReceiptLineId: receiptLineId,
    enteredQuantity: "10",
    enteredUom: "kg",
    ...overrides,
  };
}

function service() {
  return createQaReleaseService(db);
}

async function quarantineBalance(lotId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, quarantineWarehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row?.onHand;
}

async function toApproved(
  svc: ReturnType<typeof createQaReleaseService>,
  creator: { id: string },
  approver: { id: string },
  lines: QaReleaseLineInput[],
) {
  const draft = await svc.createDraft({ actorUserId: creator.id }, { lines });
  const submitted = await svc.submit({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version });
  const approved = await svc.approve({ actorUserId: approver.id }, {
    releaseId: submitted.id,
    version: submitted.version,
  });
  return approved;
}

describe("QA release lifecycle: happy path", () => {
  it("DRAFT -> SUBMITTED -> APPROVED -> RELEASED for a full release, moving balance HQ quarantine -> HQ_MAIN", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine, quarantineLot } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const draft = await svc.createDraft(
      { actorUserId: creator.id },
      { remarks: "reusable overstock return", lines: [lineInput(receiptLine.id, { enteredQuantity: "10" })] },
    );
    expect(draft).toMatchObject({ status: "DRAFT", version: 1, sourceWarehouseId: quarantineWarehouseId, destinationWarehouseId: hqMainWarehouseId });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ quarantineLotId: quarantineLot.id, releaseQuantity: "10.000000" });

    const submitted = await svc.submit({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version });
    expect(submitted.status).toBe("SUBMITTED");

    const approved = await svc.approve({ actorUserId: approver.id }, { releaseId: submitted.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");

    const released = await svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version });
    expect(released.status).toBe("RELEASED");
    expect(released.lines[0]!.releasePostingLineId).toBeTruthy();

    expect(await quarantineBalance(quarantineLot.id)).toBe("0.000000");

    const genealogyRows = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.parentLotId, quarantineLot.id));
    expect(genealogyRows).toHaveLength(1);
    const releasedLotId = genealogyRows[0]!.childLotId;

    const [releasedLot] = await db.select().from(inventoryLots).where(eq(inventoryLots.id, releasedLotId));
    expect(releasedLot).toMatchObject({ itemId: item.id, status: "AVAILABLE" });

    const [releasedBalance] = await db
      .select()
      .from(inventoryLotBalances)
      .where(and(eq(inventoryLotBalances.warehouseId, hqMainWarehouseId), eq(inventoryLotBalances.lotId, releasedLotId)));
    expect(releasedBalance?.onHand).toBe("10.000000");

    const fetched = await svc.get({ actorUserId: approver.id }, { releaseId: draft.id });
    expect(fetched.status).toBe("RELEASED");
  });

  it("allows a partial release, leaving the remaining quarantined quantity releasable by a second QA release", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine, quarantineLot } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const approved1 = await toApproved(svc, creator, approver, [lineInput(receiptLine.id, { enteredQuantity: "4" })]);
    const released1 = await svc.release({ actorUserId: creator.id }, { releaseId: approved1.id, version: approved1.version });
    expect(released1.status).toBe("RELEASED");
    expect(await quarantineBalance(quarantineLot.id)).toBe("6.000000");

    const approved2 = await toApproved(svc, creator, approver, [lineInput(receiptLine.id, { enteredQuantity: "6" })]);
    const released2 = await svc.release({ actorUserId: creator.id }, { releaseId: approved2.id, version: approved2.version });
    expect(released2.status).toBe("RELEASED");
    expect(await quarantineBalance(quarantineLot.id)).toBe("0.000000");

    const genealogyRows = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.parentLotId, quarantineLot.id));
    expect(genealogyRows).toHaveLength(2);
  });
});

describe("QA release lifecycle: disposition-reason stock can never reach HQ_MAIN", () => {
  it.each(["SPOILED", "EXPIRED", "DAMAGED", "RECALLED"] as const)(
    "refuses a %s-reason receipt line as REASON_NOT_RELEASABLE at draft creation",
    async (reasonCode) => {
      await setReturnsEnabled(true);
      const item = await makeItem();
      const { receiptLine } = await makeReceiptLine(item.id, { reasonCode });
      const creator = await makeUser("OWNER");

      await expect(
        service().createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id)] }),
      ).rejects.toMatchObject({ code: "REASON_NOT_RELEASABLE" });

      // Proves the invariant end to end: no qa_release_line was ever created
      // for this receipt line, so it is structurally impossible for this
      // disposition-reason stock to ever post an IN@HQ_MAIN through this
      // module.
      const lines = await db
        .select()
        .from(qaReleaseLines)
        .where(eq(qaReleaseLines.sourceReturnReceiptLineId, receiptLine.id));
      expect(lines).toHaveLength(0);
    },
  );

  it("accepts an OTHER-reason receipt line (the only releasable reason)", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { reasonCode: "OTHER" });
    const creator = await makeUser("OWNER");
    const draft = await service().createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id)] });
    expect(draft.status).toBe("DRAFT");
  });
});

describe("QA release lifecycle: over-release refusal and concurrency", () => {
  it("refuses a single line that exceeds the receipt line's received quantity as INSUFFICIENT_QUARANTINE_BALANCE", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "5.000000" });
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "6" })] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_QUARANTINE_BALANCE" });
  });

  it("accounts for sibling releases: a second (non-cancelled) DRAFT booking against the same receipt line cannot exceed the remainder", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const svc = service();

    const first = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "7" })] });
    expect(first.status).toBe("DRAFT");

    await expect(
      svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "4" })] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_QUARANTINE_BALANCE" });

    // Exactly 3 remains (10 - 7): this must succeed.
    const second = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "3" })] });
    expect(second.status).toBe("DRAFT");
  });

  it("excludes a CANCELLED sibling release from the remaining-balance accounting", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const svc = service();

    const first = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "8" })] });
    await svc.cancel({ actorUserId: creator.id }, { releaseId: first.id, version: first.version, cancelReason: "wrong line" });

    // Now the full 10 should be available again.
    const second = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "10" })] });
    expect(second.status).toBe("DRAFT");
  });

  it("rejects a duplicate sourceReturnReceiptLineId across lines in the same release as DUPLICATE_LINE", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        { lines: [lineInput(receiptLine.id, { enteredQuantity: "1" }), lineInput(receiptLine.id, { enteredQuantity: "2" })] },
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });
  });

  it("serializes concurrent createDraft() calls against the same receipt line so their combined booking never exceeds the remaining quarantined balance", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const svc = service();

    const call = (qty: string) =>
      svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: qty })] });

    // 7 + 7 = 14 > 10 available: at most one may succeed.
    const settled = await Promise.allSettled([call("7"), call("7")]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "INSUFFICIENT_QUARANTINE_BALANCE" });

    const bookedLines = await db
      .select()
      .from(qaReleaseLines)
      .where(eq(qaReleaseLines.sourceReturnReceiptLineId, receiptLine.id));
    expect(bookedLines).toHaveLength(1);
    expect(bookedLines[0]!.releaseQuantity).toBe("7.000000");
  });
});

describe("QA release lifecycle: idempotency, concurrency, and authorization", () => {
  it("is idempotent: a retried release() call replays without double posting", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine, quarantineLot } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const approved = await toApproved(svc, creator, approver, [lineInput(receiptLine.id, { enteredQuantity: "10" })]);
    const first = await svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version });
    const second = await svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("RELEASED");

    const releasePostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${first.documentNo}:RELEASE`));
    expect(releasePostings).toHaveLength(1);
    expect(
      await db.select().from(stockPostingLines).where(eq(stockPostingLines.postingId, releasePostings[0]!.id)),
    ).toHaveLength(2); // one OUT + one IN

    expect(await quarantineBalance(quarantineLot.id)).toBe("0.000000");
  });

  it("rejects a stale expectedVersion on update/submit/approve/release with CONCURRENT_MODIFICATION", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const draft = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "5" })] });
    await expect(
      svc.updateDraft({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version + 1, remarks: "x" }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    const submitted = await svc.submit({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version });
    await expect(
      svc.approve({ actorUserId: approver.id }, { releaseId: submitted.id, version: submitted.version + 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    const approved = await svc.approve({ actorUserId: approver.id }, { releaseId: submitted.id, version: submitted.version });
    await expect(
      svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version + 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("rejects approval by the same actor who submitted (segregation of duties)", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const svc = service();

    const draft = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "5" })] });
    const submitted = await svc.submit({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version });
    await expect(
      svc.approve({ actorUserId: creator.id }, { releaseId: submitted.id, version: submitted.version }),
    ).rejects.toMatchObject({ code: "SEGREGATION_OF_DUTIES" });
  });

  it("allows cancel from DRAFT, SUBMITTED, and APPROVED, but refuses cancel after RELEASED", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine: rl1 } = await makeReceiptLine(item.id, { receivedQuantity: "3.000000" });
    const { receiptLine: rl2 } = await makeReceiptLine(item.id, { receivedQuantity: "3.000000" });
    const { receiptLine: rl3 } = await makeReceiptLine(item.id, { receivedQuantity: "3.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const draft = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(rl1.id, { enteredQuantity: "1" })] });
    const cancelledDraft = await svc.cancel({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version, cancelReason: "mistake" });
    expect(cancelledDraft.status).toBe("CANCELLED");

    const approved = await toApproved(svc, creator, approver, [lineInput(rl2.id, { enteredQuantity: "1" })]);
    const cancelledApproved = await svc.cancel(
      { actorUserId: creator.id },
      { releaseId: approved.id, version: approved.version, cancelReason: "no longer needed" },
    );
    expect(cancelledApproved.status).toBe("CANCELLED");

    const approved2 = await toApproved(svc, creator, approver, [lineInput(rl3.id, { enteredQuantity: "1" })]);
    const released = await svc.release({ actorUserId: creator.id }, { releaseId: approved2.id, version: approved2.version });
    await expect(
      svc.cancel({ actorUserId: creator.id }, { releaseId: released.id, version: released.version, cancelReason: "too late" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("keeps draft/submit/approve reachable when stock.returns is OFF, but refuses release", async () => {
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();
    await setReturnsEnabled(false);

    const draft = await svc.createDraft({ actorUserId: creator.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "2" })] });
    expect(draft.status).toBe("DRAFT");
    const submitted = await svc.submit({ actorUserId: creator.id }, { releaseId: draft.id, version: draft.version });
    expect(submitted.status).toBe("SUBMITTED");
    const approved = await svc.approve({ actorUserId: approver.id }, { releaseId: submitted.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");

    await expect(
      svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });

    await setReturnsEnabled(true);
    const released = await svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version });
    expect(released.status).toBe("RELEASED");
  });

  it("rejects an actor role outside QA_RELEASE_ROLES", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const outsider = await makeUser("KITCHEN_CREW");
    await expect(
      service().createDraft({ actorUserId: outsider.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "1" })] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an outlet-scoped WAREHOUSE_OUTLET actor (QA release is HQ-only)", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const outsider = await makeUser("WAREHOUSE_OUTLET");
    await grantAccess(outsider.id, outletLocationId);
    await expect(
      service().createDraft({ actorUserId: outsider.id }, { lines: [lineInput(receiptLine.id, { enteredQuantity: "1" })] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an unknown source_return_receipt_line_id as VALIDATION", async () => {
    await setReturnsEnabled(true);
    const creator = await makeUser("OWNER");
    await expect(
      service().createDraft({ actorUserId: creator.id }, { lines: [lineInput(randomUUID(), { enteredQuantity: "1" })] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an entered UOM with no matching item unit or active conversion as UOM_MISMATCH", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        { lines: [lineInput(receiptLine.id, { enteredUom: "liters" })] },
      ),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH" });
  });

  it("rejects an empty line set as VALIDATION", async () => {
    await setReturnsEnabled(true);
    const creator = await makeUser("OWNER");
    await expect(
      service().createDraft({ actorUserId: creator.id }, { lines: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("propagates QaReleaseError instances with a stable code/status shape", async () => {
    await setReturnsEnabled(true);
    const creator = await makeUser("OWNER");
    let caught: unknown;
    try {
      await service().createDraft({ actorUserId: creator.id }, { lines: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QaReleaseError);
    expect((caught as QaReleaseError).code).toBe("VALIDATION");
    expect((caught as QaReleaseError).status).toBe(400);
  });

  it("rejects release() when the posting-time on-hand balance is insufficient (StockPostingError, no partial move)", async () => {
    await setReturnsEnabled(true);
    const item = await makeItem();
    const { receiptLine, quarantineLot } = await makeReceiptLine(item.id, { receivedQuantity: "10.000000" });
    const creator = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = service();

    const approved = await toApproved(svc, creator, approver, [lineInput(receiptLine.id, { enteredQuantity: "10" })]);
    // Balance drained out-of-band between APPROVED and release() (e.g. a
    // parallel correction) so posting-service's own hard balance check must
    // now be the one to refuse it.
    await db
      .update(inventoryLotBalances)
      .set({ onHand: "2.000000" })
      .where(and(eq(inventoryLotBalances.warehouseId, quarantineWarehouseId), eq(inventoryLotBalances.lotId, quarantineLot.id)));

    let caught: unknown;
    try {
      await svc.release({ actorUserId: creator.id }, { releaseId: approved.id, version: approved.version });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockPostingError);
    expect((caught as StockPostingError).code).toBe("INSUFFICIENT_STOCK");
    const [releaseRow] = await db.select().from(qaReleases).where(eq(qaReleases.id, approved.id));
    expect(releaseRow).toMatchObject({ status: "APPROVED" });
  });
});

describe("QA release lifecycle: route trigger sanity", () => {
  it("rejects a qa_release row whose source_warehouse_id is not QUARANTINE (DB trigger, bypassing the service)", async () => {
    const creator = await makeUser("OWNER");
    await expect(
      db.insert(qaReleases).values({
        documentNo: `QAR-BADROUTE-${randomUUID()}`,
        sourceWarehouseId: outletStorageWarehouseId, // wrong purpose: OUTLET_STORAGE
        destinationWarehouseId: hqMainWarehouseId,
        createdBy: creator.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects a qa_release row whose destination_warehouse_id is not HQ_MAIN (DB trigger, bypassing the service)", async () => {
    const creator = await makeUser("OWNER");
    await expect(
      db.insert(qaReleases).values({
        documentNo: `QAR-BADROUTE-${randomUUID()}`,
        sourceWarehouseId: quarantineWarehouseId,
        destinationWarehouseId: outletStorageWarehouseId, // wrong purpose: OUTLET_STORAGE
        createdBy: creator.id,
      }),
    ).rejects.toThrow();
  });
});

/**
 * RESOLVED (RET-FIX P1): the finding this comment used to describe —
 * stock-returns/service.ts's receiveAndDisposeStockReturnBatch() posting an
 * immediate quarantine IN + DISPOSITION OUT pair for the FULL received
 * quantity of EVERY line regardless of dispositionReasonCode, which left no
 * receipt line reachable through the real runtime path with a nonzero
 * quarantine balance — is fixed. That function now only pairs the OUT with
 * disposition-reason lines; a reusable-reason (OTHER) line posts an unpaired
 * quarantine IN (posting-service.ts's RETURN_DISPOSITION route exempts
 * QUARANTINE_HOLD-tagged IN movements from its net-zero check) and survives
 * receipt with a genuinely positive balance. This file's fixtures still
 * construct receipt-line state directly (a deliberate choice to keep QA
 * Release's own unit coverage independent of stock-returns' internals), but
 * the real chain is now proven end to end by
 * test/return-to-qa-release-e2e.test.ts, which drives outlet dispatch -> HQ
 * receive -> QA Release entirely through real service calls.
 */
