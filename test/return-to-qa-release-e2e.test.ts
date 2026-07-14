/**
 * End-to-end proof that a real outlet -> HQ Stock Return Batch receipt now
 * feeds QA Release with genuinely quarantined stock (D35-D46 §5).
 *
 * Before the RET-FIX P1 fix, stock-returns/service.ts's
 * receiveAndDisposeStockReturnBatch() posted an immediate quarantine IN +
 * DISPOSITION OUT pair for the FULL received quantity of EVERY line
 * regardless of dispositionReasonCode (posting-service.ts's
 * RETURN_DISPOSITION route class forced net-zero IN/OUT per item/lot), so no
 * receipt line reachable through the real runtime path ever carried a
 * nonzero quarantine balance — QA Release itself was correct but
 * structurally unreachable with real data (see the "known upstream finding"
 * that used to sit at the bottom of test/qa-release-lifecycle.test.ts).
 *
 * This file drives the ENTIRE chain through real service calls only (no
 * direct-insert fixtures): outlet dispatch -> HQ receive (mixed reasons) ->
 * QA Release draft/submit/approve/release against the actual receipt line
 * the receive step produced, and proves:
 *  - a reusable-reason (OTHER) line's quarantine balance survives receipt;
 *  - QA Release moves exactly that balance to HQ_MAIN and zeros quarantine;
 *  - a disposition-reason (DAMAGED) line from the SAME batch can never be
 *    released (REASON_NOT_RELEASABLE), proving disposition-reason stock
 *    still never becomes allocatable HQ stock end to end.
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
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { stockReturnReceiptLines } from "../src/db/returns-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { createStockReturnService } from "../src/modules/stock-returns/service.js";
import { createQaReleaseService } from "../src/modules/qa-releases/service.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;
let hqLocationId: string;
let hqMainWarehouseId: string;
let quarantineWarehouseId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  const [hq] = await db
    .insert(locations)
    .values({ code: `RQE-HQ-${randomUUID().slice(0, 8)}`, name: "Return-to-QA-Release E2E HQ" })
    .returning();
  hqLocationId = hq!.id;
  const [hqMain] = await db
    .insert(warehouses)
    .values({
      locationId: hqLocationId,
      type: "MAIN",
      purpose: "HQ_MAIN",
      code: `WH-RQE-HQ-${randomUUID().slice(0, 8)}`,
      name: "RQE HQ Main Warehouse",
    })
    .returning();
  hqMainWarehouseId = hqMain!.id;
  const [quarantine] = await db
    .insert(warehouses)
    .values({
      // `type` just avoids colliding with HQ_MAIN's (locationId, type) unique
      // index at the same physical HQ location; `purpose` is what matters.
      locationId: hqLocationId,
      type: "KITCHEN",
      purpose: "QUARANTINE",
      code: `WH-RQE-QTN-${randomUUID().slice(0, 8)}`,
      name: "RQE HQ Quarantine Warehouse",
    })
    .returning();
  quarantineWarehouseId = quarantine!.id;

  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.returns"));
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

async function makeUser(role: Role) {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `RQE User ${s}`, email: `rqe-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  return user!;
}

async function grantAccess(userId: string, locationId: string) {
  await db.insert(userOutletAccess).values({ userId, locationId });
}

async function balanceOf(warehouseId: string, lotId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row?.onHand;
}

describe("outlet return -> HQ receive -> QA release: real end-to-end runtime path", () => {
  it("moves a reusable-reason line's quarantine balance to HQ_MAIN via QA Release, and permanently refuses a disposition-reason line from the same batch", async () => {
    const outletCreator = await makeUser("WAREHOUSE_OUTLET");
    const hqOwner = await makeUser("OWNER");
    const hqWarehouseManager = await makeUser("WAREHOUSE_MAIN");

    // One outlet, one two-line batch (a batch cannot span two source
    // outlets): line A returned for a reusable reason, line B for a
    // disposition reason, so the branch decision is proven to be per receipt
    // line (dispositionReasonCode assigned at HQ receive), not per batch.
    const s = suffix();
    const [outlet] = await db
      .insert(locations)
      .values({ code: `RQE-O-${s}`, name: `RQE Outlet ${s}` })
      .returning();
    const [outletWarehouse] = await db
      .insert(warehouses)
      .values({
        locationId: outlet!.id,
        type: "MAIN",
        purpose: "OUTLET_STORAGE",
        code: `WH-RQE-O-${s}`,
        name: `RQE Outlet Storage ${s}`,
      })
      .returning();
    await grantAccess(outletCreator.id, outlet!.id);

    const [itemReusable] = await db
      .insert(ingredients)
      .values({
        code: `RQE-ITEM-A-${s}`,
        name: `RQE Item A ${s}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "10.0000",
        lowStockThreshold: "1.0000",
      })
      .returning();
    const [lotReusable] = await db
      .insert(inventoryLots)
      .values({ itemId: itemReusable!.id, lotCode: `RQE-LOT-A-${s}`, unitCost: "10.000000" })
      .returning();
    await db.insert(inventoryLotBalances).values({ warehouseId: outletWarehouse!.id, lotId: lotReusable!.id, onHand: "20.000000" });

    const [itemDisposition] = await db
      .insert(ingredients)
      .values({
        code: `RQE-ITEM-B-${s}`,
        name: `RQE Item B ${s}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "12.0000",
        lowStockThreshold: "1.0000",
      })
      .returning();
    const [lotDisposition] = await db
      .insert(inventoryLots)
      .values({ itemId: itemDisposition!.id, lotCode: `RQE-LOT-B-${s}`, unitCost: "12.000000" })
      .returning();
    await db.insert(inventoryLotBalances).values({ warehouseId: outletWarehouse!.id, lotId: lotDisposition!.id, onHand: "25.000000" });

    const returnSvc = createStockReturnService(db);

    const draft = await returnSvc.createDraft(
      { actorUserId: outletCreator.id },
      {
        sourceLocationId: outlet!.id,
        remarks: "Mixed reusable + disposition return",
        lines: [
          {
            itemId: itemReusable!.id,
            lotId: lotReusable!.id,
            sourceWarehouseId: outletWarehouse!.id,
            enteredQuantity: "7",
            enteredUom: "kg",
            reasonCode: "SPOILED",
          },
          {
            itemId: itemDisposition!.id,
            lotId: lotDisposition!.id,
            sourceWarehouseId: outletWarehouse!.id,
            enteredQuantity: "9",
            enteredUom: "kg",
            reasonCode: "SPOILED",
          },
        ],
      },
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.lines).toHaveLength(2);

    const submitted = await returnSvc.submit({ actorUserId: outletCreator.id }, { batchId: draft.id, version: draft.version });
    const approved = await returnSvc.approve({ actorUserId: hqOwner.id }, { batchId: submitted.id, version: submitted.version });
    const dispatched = await returnSvc.dispatch({ actorUserId: outletCreator.id }, { batchId: approved.id, version: approved.version });
    expect(dispatched.status).toBe("DISPATCHED");

    const reusableLine = dispatched.lines.find((line) => line.itemId === itemReusable!.id)!;
    const dispositionLine = dispatched.lines.find((line) => line.itemId === itemDisposition!.id)!;

    const received = await returnSvc.receiveAndDispose({ actorUserId: hqWarehouseManager.id }, {
      batchId: dispatched.id,
      version: dispatched.version,
      receiptLines: [
        { batchLineId: reusableLine.id, dispositionReasonCode: "OTHER", dispositionRemarks: "Sealed, unopened, wrong outlet" },
        { batchLineId: dispositionLine.id, dispositionReasonCode: "DAMAGED", dispositionRemarks: "Crushed in transit" },
      ],
    });
    expect(received.status).toBe("RECEIVED_DISPOSED");

    const [reusableQLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, itemReusable!.id), eq(inventoryLots.lotCode, `RETURN:${draft.id}:${reusableLine.lineNo}`)));
    const [dispositionQLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, itemDisposition!.id), eq(inventoryLots.lotCode, `RETURN:${draft.id}:${dispositionLine.lineNo}`)));

    // Core P1 assertion: the reusable line's quarantine IN has no
    // compensating OUT and survives receipt; the disposition line's does not.
    expect(await balanceOf(quarantineWarehouseId, reusableQLot!.id)).toBe("7.000000");
    expect(await balanceOf(quarantineWarehouseId, dispositionQLot!.id)).toBe("0.000000");

    const [reusableReceipt] = await db
      .select()
      .from(stockReturnReceiptLines)
      .where(eq(stockReturnReceiptLines.batchLineId, reusableLine.id));
    const [dispositionReceipt] = await db
      .select()
      .from(stockReturnReceiptLines)
      .where(eq(stockReturnReceiptLines.batchLineId, dispositionLine.id));
    expect(reusableReceipt!.dispositionOutPostingLineId).toBeNull();
    expect(reusableReceipt!.quarantineInPostingLineId).toBeTruthy();
    expect(dispositionReceipt!.dispositionOutPostingLineId).toBeTruthy();

    // --- QA Release phase: drives the ACTUAL receive-produced receipt line ---
    const qaSvc = createQaReleaseService(db);

    const qaDraft = await qaSvc.createDraft(
      { actorUserId: hqOwner.id },
      {
        remarks: "Release the reusable return to HQ_MAIN",
        lines: [{ sourceReturnReceiptLineId: reusableReceipt!.id, enteredQuantity: "7", enteredUom: "kg" }],
      },
    );
    expect(qaDraft.status).toBe("DRAFT");
    expect(qaDraft.lines[0]).toMatchObject({ quarantineLotId: reusableQLot!.id, releaseQuantity: "7.000000" });

    const qaSubmitted = await qaSvc.submit({ actorUserId: hqOwner.id }, { releaseId: qaDraft.id, version: qaDraft.version });
    const qaApproved = await qaSvc.approve(
      { actorUserId: hqWarehouseManager.id },
      { releaseId: qaSubmitted.id, version: qaSubmitted.version },
    );
    const qaReleased = await qaSvc.release({ actorUserId: hqOwner.id }, { releaseId: qaApproved.id, version: qaApproved.version });
    expect(qaReleased.status).toBe("RELEASED");

    // Quarantine drains to zero; HQ_MAIN gains the exact released quantity.
    expect(await balanceOf(quarantineWarehouseId, reusableQLot!.id)).toBe("0.000000");

    const [genealogy] = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.parentLotId, reusableQLot!.id));
    expect(genealogy).toBeTruthy();
    const releasedLotId = genealogy!.childLotId;
    const [releasedLot] = await db.select().from(inventoryLots).where(eq(inventoryLots.id, releasedLotId));
    expect(releasedLot).toMatchObject({ itemId: itemReusable!.id, status: "AVAILABLE" });
    expect(await balanceOf(hqMainWarehouseId, releasedLotId)).toBe("7.000000");

    // The disposition-reason line from the SAME batch is permanently
    // refused: disposition-reason stock never becomes allocatable HQ stock.
    await expect(
      qaSvc.createDraft(
        { actorUserId: hqOwner.id },
        { lines: [{ sourceReturnReceiptLineId: dispositionReceipt!.id, enteredQuantity: "9", enteredUom: "kg" }] },
      ),
    ).rejects.toMatchObject({ code: "REASON_NOT_RELEASABLE" });
  });
});
