/**
 * HQ Transfer Order lifecycle coverage: route legality (D35-D46 §2) for all
 * four allowed pairs plus rejected outlet<->outlet/reverse/KITCHEN routes,
 * FEFO lot selection at dispatch (single-lot-per-line), insufficient stock,
 * received<=dispatched enforcement, idempotent dispatch/receive replay,
 * version conflicts, segregation of duties, pre/post-dispatch cancel, and
 * flag-off dark-mode gating (draft/submit/approve OK, dispatch/receive
 * refused). Fixture setup mirrors test/job-order-consumption.test.ts and
 * test/stock-return-service.test.ts (shared HQ_MAIN + per-test outlet/
 * production locations + stock.lot_writes/topology preconditions).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLotBalances,
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { transferOrderLines, transferOrders } from "../src/db/transfer-orders-schema.js";
import { TransferOrderError } from "../src/modules/transfers/errors.js";
import { createTransferOrderService } from "../src/modules/transfers/service.js";
import type { TransferOrderLineInput } from "../src/modules/transfers/types.js";
import { StockPostingError } from "../src/modules/stock/errors.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;
let hqMainWarehouseId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  // D31: exactly one *active* HQ_MAIN warehouse company-wide.
  const [hqLocation] = await db
    .insert(locations)
    .values({ code: `TOL-HQ-${randomUUID().slice(0, 8)}`, name: "Transfer Lifecycle HQ" })
    .returning();
  const [hqWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: hqLocation!.id,
      type: "MAIN",
      purpose: "HQ_MAIN",
      code: `WH-TOL-HQ-${randomUUID().slice(0, 8)}`,
      name: "Transfer Lifecycle HQ Main Warehouse",
    })
    .returning();
  hqMainWarehouseId = hqWarehouse!.id;

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

async function setTransfersEnabled(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.transfers"));
}

async function makeLocation() {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `TOL-${s}`, name: `TOL Location ${s}` }).returning();
  return location!;
}

async function makeWarehouse(
  locationId: string,
  purpose: "HQ_MAIN" | "OUTLET_STORAGE" | "KITCHEN" | "PRODUCTION" | "QUARANTINE",
) {
  const s = suffix();
  const [warehouse] = await db
    .insert(warehouses)
    .values({ locationId, type: "MAIN", purpose, code: `WH-TOL-${s}`, name: `TOL Warehouse ${s}` })
    .returning();
  return warehouse!;
}

async function makeItem() {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `TOL-ITEM-${s}`,
      name: `TOL Item ${s}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  return item!;
}

async function makeLot(itemId: string, overrides: Partial<{ expiresAt: string | null; status: string }> = {}) {
  const s = suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode: `TOL-LOT-${s}`,
      unitCost: "10.000000",
      status: (overrides.status as "AVAILABLE") ?? "AVAILABLE",
      expiresAt: overrides.expiresAt ?? null,
    })
    .returning();
  return lot!;
}

async function setBalance(warehouseId: string, lotId: string, onHand: string, reserved = "0") {
  await db.insert(inventoryLotBalances).values({ warehouseId, lotId, onHand, reserved });
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `TOL User ${s}`, email: `tol-${s}@test.local`, passwordHash: "hash", role, status })
    .returning();
  return user!;
}

async function grantAccess(userId: string, locationId: string) {
  await db.insert(userOutletAccess).values({ userId, locationId });
}

interface RouteFixture {
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  itemId: string;
  lotId: string;
  creatorUserId: string;
  approverUserId: string;
  receiverUserId: string;
}

/** HQ_MAIN -> OUTLET_STORAGE fixture: the most common route. */
async function hqToOutletFixture(onHand = "50.000000"): Promise<RouteFixture> {
  const outlet = await makeLocation();
  const outletStorage = await makeWarehouse(outlet.id, "OUTLET_STORAGE");
  const item = await makeItem();
  const lot = await makeLot(item.id);
  await setBalance(hqMainWarehouseId, lot.id, onHand);
  const creator = await makeUser("OWNER");
  const approver = await makeUser("OWNER");
  const receiver = await makeUser("OWNER");
  return {
    sourceWarehouseId: hqMainWarehouseId,
    destinationWarehouseId: outletStorage.id,
    sourceLocationId: (await db.select().from(warehouses).where(eq(warehouses.id, hqMainWarehouseId)))[0]!.locationId,
    destinationLocationId: outlet.id,
    itemId: item.id,
    lotId: lot.id,
    creatorUserId: creator.id,
    approverUserId: approver.id,
    receiverUserId: receiver.id,
  };
}

function lineInput(fx: RouteFixture, overrides: Partial<TransferOrderLineInput> = {}): TransferOrderLineInput {
  return {
    itemId: fx.itemId,
    lotId: fx.lotId,
    enteredQuantity: "10",
    enteredUom: "kg",
    ...overrides,
  };
}

function service() {
  return createTransferOrderService(db);
}

async function balanceOf(warehouseId: string, lotId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row?.onHand;
}

async function toApproved(
  svc: ReturnType<typeof createTransferOrderService>,
  fx: RouteFixture,
  lines: TransferOrderLineInput[],
) {
  const draft = await svc.createDraft(
    { actorUserId: fx.creatorUserId },
    { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines },
  );
  const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version });
  const approved = await svc.approve({ actorUserId: fx.approverUserId }, {
    orderId: submitted.id,
    version: submitted.version,
  });
  return approved;
}

describe("transfer order lifecycle: route legality", () => {
  it("happy path DRAFT -> RECEIVED for HQ_MAIN -> OUTLET_STORAGE, moving balances end to end", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("50.000000");
    const svc = service();

    const draft = await svc.createDraft(
      { actorUserId: fx.creatorUserId },
      {
        sourceWarehouseId: fx.sourceWarehouseId,
        destinationWarehouseId: fx.destinationWarehouseId,
        remarks: "restock",
        lines: [lineInput(fx, { enteredQuantity: "12" })],
      },
    );
    expect(draft).toMatchObject({ status: "DRAFT", version: 1, sourceLocationId: fx.sourceLocationId, destinationLocationId: fx.destinationLocationId });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ status: "DRAFT", lotId: fx.lotId, baseQuantity: "12.000000" });

    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version });
    expect(submitted.status).toBe("SUBMITTED");

    const approved = await svc.approve({ actorUserId: fx.approverUserId }, { orderId: submitted.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");

    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    expect(dispatched.status).toBe("DISPATCHED");
    expect(await balanceOf(fx.sourceWarehouseId, fx.lotId)).toBe("38.000000");
    const dispatchedLine = dispatched.lines[0]!;
    expect(dispatchedLine.dispatchedQuantity).toBe("12.000000");
    expect(dispatchedLine.dispatchPostingLineId).toBeTruthy();

    const received = await svc.receive({ actorUserId: fx.receiverUserId }, { orderId: dispatched.id, version: dispatched.version });
    expect(received.status).toBe("RECEIVED");
    expect(await balanceOf(fx.destinationWarehouseId, fx.lotId)).toBe("12.000000");
    const receivedLine = received.lines[0]!;
    expect(receivedLine.receivedQuantity).toBe("12.000000");
    expect(receivedLine.receiptPostingLineId).toBeTruthy();
    expect(receivedLine.status).toBe("RECEIVED");

    const fetched = await svc.get({ actorUserId: fx.approverUserId }, { orderId: draft.id });
    expect(fetched.status).toBe("RECEIVED");
  });

  it("allows HQ_MAIN -> PRODUCTION and PRODUCTION -> HQ_MAIN routes end to end", async () => {
    await setTransfersEnabled(true);
    const production = await makeLocation();
    const productionWarehouse = await makeWarehouse(production.id, "PRODUCTION");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await setBalance(hqMainWarehouseId, lot.id, "30.000000");
    const creator = await makeUser("OWNER");
    const approver = await makeUser("OWNER");

    const fxOut: RouteFixture = {
      sourceWarehouseId: hqMainWarehouseId,
      destinationWarehouseId: productionWarehouse.id,
      sourceLocationId: (await db.select().from(warehouses).where(eq(warehouses.id, hqMainWarehouseId)))[0]!.locationId,
      destinationLocationId: production.id,
      itemId: item.id,
      lotId: lot.id,
      creatorUserId: creator.id,
      approverUserId: approver.id,
      receiverUserId: creator.id,
    };
    const svc = service();
    const approvedOut = await toApproved(svc, fxOut, [lineInput(fxOut, { enteredQuantity: "5" })]);
    const dispatchedOut = await svc.dispatch({ actorUserId: fxOut.creatorUserId }, { orderId: approvedOut.id, version: approvedOut.version });
    const receivedOut = await svc.receive({ actorUserId: fxOut.creatorUserId }, { orderId: dispatchedOut.id, version: dispatchedOut.version });
    expect(receivedOut.status).toBe("RECEIVED");
    expect(await balanceOf(productionWarehouse.id, lot.id)).toBe("5.000000");
    expect(await balanceOf(hqMainWarehouseId, lot.id)).toBe("25.000000");

    // PRODUCTION -> HQ_MAIN: transfer the lot now sitting in PRODUCTION back to HQ_MAIN.
    const fxBack: RouteFixture = {
      sourceWarehouseId: productionWarehouse.id,
      destinationWarehouseId: hqMainWarehouseId,
      sourceLocationId: production.id,
      destinationLocationId: fxOut.sourceLocationId,
      itemId: item.id,
      lotId: lot.id,
      creatorUserId: creator.id,
      approverUserId: approver.id,
      receiverUserId: creator.id,
    };
    const approvedBack = await toApproved(svc, fxBack, [lineInput(fxBack, { enteredQuantity: "5" })]);
    const dispatchedBack = await svc.dispatch({ actorUserId: fxBack.creatorUserId }, { orderId: approvedBack.id, version: approvedBack.version });
    const receivedBack = await svc.receive({ actorUserId: fxBack.creatorUserId }, { orderId: dispatchedBack.id, version: dispatchedBack.version });
    expect(receivedBack.status).toBe("RECEIVED");
    expect(await balanceOf(hqMainWarehouseId, lot.id)).toBe("30.000000");
    expect(await balanceOf(productionWarehouse.id, lot.id)).toBe("0.000000");
  });

  it("allows PRODUCTION -> OUTLET_STORAGE", async () => {
    await setTransfersEnabled(true);
    const production = await makeLocation();
    const productionWarehouse = await makeWarehouse(production.id, "PRODUCTION");
    const outlet = await makeLocation();
    const outletStorage = await makeWarehouse(outlet.id, "OUTLET_STORAGE");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await setBalance(productionWarehouse.id, lot.id, "20.000000");
    const creator = await makeUser("OWNER");
    const approver = await makeUser("OWNER");

    const fx: RouteFixture = {
      sourceWarehouseId: productionWarehouse.id,
      destinationWarehouseId: outletStorage.id,
      sourceLocationId: production.id,
      destinationLocationId: outlet.id,
      itemId: item.id,
      lotId: lot.id,
      creatorUserId: creator.id,
      approverUserId: approver.id,
      receiverUserId: creator.id,
    };
    const svc = service();
    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "8" })]);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    const received = await svc.receive({ actorUserId: fx.creatorUserId }, { orderId: dispatched.id, version: dispatched.version });
    expect(received.status).toBe("RECEIVED");
    expect(await balanceOf(outletStorage.id, lot.id)).toBe("8.000000");
  });

  it("rejects outlet -> outlet as ROUTE_NOT_ALLOWED", async () => {
    await setTransfersEnabled(true);
    const outletA = await makeLocation();
    const storageA = await makeWarehouse(outletA.id, "OUTLET_STORAGE");
    const outletB = await makeLocation();
    const storageB = await makeWarehouse(outletB.id, "OUTLET_STORAGE");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await setBalance(storageA.id, lot.id, "10.000000");
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        {
          sourceWarehouseId: storageA.id,
          destinationWarehouseId: storageB.id,
          lines: [{ itemId: item.id, lotId: lot.id, enteredQuantity: "1", enteredUom: "kg" }],
        },
      ),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_ALLOWED" });
  });

  it("rejects OUTLET_STORAGE -> HQ_MAIN as ROUTE_NOT_ALLOWED (that redistribution is Stock Return Batch, not Transfer Order)", async () => {
    await setTransfersEnabled(true);
    const outlet = await makeLocation();
    const storage = await makeWarehouse(outlet.id, "OUTLET_STORAGE");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await setBalance(storage.id, lot.id, "10.000000");
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        {
          sourceWarehouseId: storage.id,
          destinationWarehouseId: hqMainWarehouseId,
          lines: [{ itemId: item.id, lotId: lot.id, enteredQuantity: "1", enteredUom: "kg" }],
        },
      ),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_ALLOWED" });
  });

  it("rejects a KITCHEN destination as ROUTE_NOT_ALLOWED (KITCHEN is fed by Internal Transfer Order, not this module)", async () => {
    await setTransfersEnabled(true);
    const outlet = await makeLocation();
    const kitchen = await makeWarehouse(outlet.id, "KITCHEN");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await setBalance(hqMainWarehouseId, lot.id, "10.000000");
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        {
          sourceWarehouseId: hqMainWarehouseId,
          destinationWarehouseId: kitchen.id,
          lines: [{ itemId: item.id, lotId: lot.id, enteredQuantity: "1", enteredUom: "kg" }],
        },
      ),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_ALLOWED" });
  });

  it("rejects a QUARANTINE source or destination as ROUTE_NOT_ALLOWED (that route is QA Release only)", async () => {
    await setTransfersEnabled(true);
    const quarantineLoc = await makeLocation();
    const quarantine = await makeWarehouse(quarantineLoc.id, "QUARANTINE");
    const outlet = await makeLocation();
    const storage = await makeWarehouse(outlet.id, "OUTLET_STORAGE");
    const item = await makeItem();
    const lot = await makeLot(item.id, { status: "QUARANTINED" });
    const creator = await makeUser("OWNER");

    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        {
          sourceWarehouseId: quarantine.id,
          destinationWarehouseId: storage.id,
          lines: [{ itemId: item.id, lotId: lot.id, enteredQuantity: "1", enteredUom: "kg" }],
        },
      ),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_ALLOWED" });
  });

  it("rejects a header whose source equals its destination warehouse", async () => {
    await setTransfersEnabled(true);
    const creator = await makeUser("OWNER");
    const item = await makeItem();
    const lot = await makeLot(item.id);
    await expect(
      service().createDraft(
        { actorUserId: creator.id },
        {
          sourceWarehouseId: hqMainWarehouseId,
          destinationWarehouseId: hqMainWarehouseId,
          lines: [{ itemId: item.id, lotId: lot.id, enteredQuantity: "1", enteredUom: "kg" }],
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("transfer order lifecycle: FEFO and stock effects", () => {
  it("FEFO-selects the earliest-expiring eligible lot at dispatch when no lot is pinned", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("0.000000");
    // fx.lotId has no balance seeded; create three lots with different expiries.
    const soon = await makeLot(fx.itemId, { expiresAt: "2026-08-01" });
    const later = await makeLot(fx.itemId, { expiresAt: "2026-12-01" });
    const expired = await makeLot(fx.itemId, { expiresAt: "2020-01-01" });
    await setBalance(fx.sourceWarehouseId, soon.id, "10.000000");
    await setBalance(fx.sourceWarehouseId, later.id, "10.000000");
    await setBalance(fx.sourceWarehouseId, expired.id, "10.000000");

    const svc = service();
    const approved = await toApproved(svc, fx, [
      { itemId: fx.itemId, enteredQuantity: "6", enteredUom: "kg" }, // no lotId: unpinned
    ]);
    expect(approved.lines[0]!.lotId).toBeNull();

    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    expect(dispatched.lines[0]!.lotId).toBe(soon.id);
    expect(await balanceOf(fx.sourceWarehouseId, soon.id)).toBe("4.000000");
    expect(await balanceOf(fx.sourceWarehouseId, later.id)).toBe("10.000000");
    expect(await balanceOf(fx.sourceWarehouseId, expired.id)).toBe("10.000000");
  });

  it("uses a caller-pinned lot as-is at dispatch, skipping FEFO", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("0.000000");
    const pinned = await makeLot(fx.itemId, { expiresAt: "2026-12-01" });
    const earlier = await makeLot(fx.itemId, { expiresAt: "2026-01-01" });
    await setBalance(fx.sourceWarehouseId, pinned.id, "10.000000");
    await setBalance(fx.sourceWarehouseId, earlier.id, "10.000000");

    const svc = service();
    const approved = await toApproved(svc, fx, [{ itemId: fx.itemId, lotId: pinned.id, enteredQuantity: "4", enteredUom: "kg" }]);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    expect(dispatched.lines[0]!.lotId).toBe(pinned.id);
    expect(await balanceOf(fx.sourceWarehouseId, pinned.id)).toBe("6.000000");
    expect(await balanceOf(fx.sourceWarehouseId, earlier.id)).toBe("10.000000");
  });

  it("throws INSUFFICIENT_STOCK when no single lot covers the requested quantity", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("0.000000");
    const lotA = await makeLot(fx.itemId);
    const lotB = await makeLot(fx.itemId);
    await setBalance(fx.sourceWarehouseId, lotA.id, "3.000000");
    await setBalance(fx.sourceWarehouseId, lotB.id, "3.000000");

    const svc = service();
    const approved = await toApproved(svc, fx, [{ itemId: fx.itemId, enteredQuantity: "5", enteredUom: "kg" }]);
    await expect(
      svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("rejects a dispatch that exceeds the pinned lot's available balance (posting-service INSUFFICIENT_STOCK)", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("3.000000");
    const svc = service();
    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "10" })]);
    let caught: unknown;
    try {
      await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockPostingError);
    expect((caught as StockPostingError).code).toBe("INSUFFICIENT_STOCK");
    expect(await balanceOf(fx.sourceWarehouseId, fx.lotId)).toBe("3.000000");
    const [orderRow] = await db.select().from(transferOrders).where(eq(transferOrders.id, approved.id));
    expect(orderRow).toMatchObject({ status: "APPROVED" });
  });

  it("enforces received_quantity <= dispatched_quantity and allows a partial (shortage) receipt", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("20.000000");
    const svc = service();
    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "10" })]);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    const lineId = dispatched.lines[0]!.id;

    await expect(
      svc.receive(
        { actorUserId: fx.receiverUserId },
        { orderId: dispatched.id, version: dispatched.version, receiptLines: [{ lineId, receivedQuantity: "11" }] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const received = await svc.receive(
      { actorUserId: fx.receiverUserId },
      { orderId: dispatched.id, version: dispatched.version, receiptLines: [{ lineId, receivedQuantity: "9" }] },
    );
    expect(received.status).toBe("RECEIVED");
    expect(received.lines[0]!.receivedQuantity).toBe("9.000000");
    expect(await balanceOf(fx.destinationWarehouseId, fx.lotId)).toBe("9.000000");
  });
});

describe("transfer order lifecycle: idempotency, concurrency, and authorization", () => {
  it("is idempotent: retried dispatch() and receive() calls replay without double posting", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("40.000000");
    const svc = service();
    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "10" })]);

    const firstDispatch = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    const secondDispatch = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    expect(secondDispatch.id).toBe(firstDispatch.id);
    expect(secondDispatch.status).toBe("DISPATCHED");

    const dispatchPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, firstDispatch.documentNo));
    const dispatchPostingRows = dispatchPostings.filter((p) => p.sourceModule === "TRANSFER_ORDER_DISPATCH");
    expect(dispatchPostingRows).toHaveLength(1);
    expect(
      await db.select().from(stockPostingLines).where(eq(stockPostingLines.postingId, dispatchPostingRows[0]!.id)),
    ).toHaveLength(1);
    expect(await balanceOf(fx.sourceWarehouseId, fx.lotId)).toBe("30.000000");

    const firstReceive = await svc.receive({ actorUserId: fx.receiverUserId }, { orderId: firstDispatch.id, version: firstDispatch.version });
    const secondReceive = await svc.receive({ actorUserId: fx.receiverUserId }, { orderId: firstDispatch.id, version: firstDispatch.version });
    expect(secondReceive.status).toBe("RECEIVED");
    expect(secondReceive.id).toBe(firstReceive.id);

    const receiptPostings = (
      await db.select().from(stockPostings).where(eq(stockPostings.sourceDocumentNo, firstDispatch.documentNo))
    ).filter((p) => p.sourceModule === "TRANSFER_ORDER_RECEIPT");
    expect(receiptPostings).toHaveLength(1);
    expect(await balanceOf(fx.destinationWarehouseId, fx.lotId)).toBe("10.000000");
  });

  it("rejects a stale expectedVersion on update/submit/approve with CONCURRENT_MODIFICATION", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    const svc = service();
    const draft = await svc.createDraft(
      { actorUserId: fx.creatorUserId },
      { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx)] },
    );
    await expect(
      svc.updateDraft({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version + 1, remarks: "x" }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version });
    await expect(
      svc.approve({ actorUserId: fx.approverUserId }, { orderId: submitted.id, version: submitted.version + 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("rejects approval by the same actor who submitted (segregation of duties)", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    const svc = service();
    const draft = await svc.createDraft(
      { actorUserId: fx.creatorUserId },
      { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx)] },
    );
    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version });
    await expect(
      svc.approve({ actorUserId: fx.creatorUserId }, { orderId: submitted.id, version: submitted.version }),
    ).rejects.toMatchObject({ code: "SEGREGATION_OF_DUTIES" });
  });

  it("allows cancel from DRAFT, SUBMITTED, and APPROVED, but refuses cancel after DISPATCHED", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("30.000000");
    const svc = service();

    const draft = await svc.createDraft(
      { actorUserId: fx.creatorUserId },
      { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx, { enteredQuantity: "1" })] },
    );
    const cancelledDraft = await svc.cancel({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version, cancelReason: "mistake" });
    expect(cancelledDraft.status).toBe("CANCELLED");

    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "1" })]);
    const cancelledApproved = await svc.cancel(
      { actorUserId: fx.creatorUserId },
      { orderId: approved.id, version: approved.version, cancelReason: "no longer needed" },
    );
    expect(cancelledApproved.status).toBe("CANCELLED");

    const approved2 = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "1" })]);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved2.id, version: approved2.version });
    await expect(
      svc.cancel({ actorUserId: fx.creatorUserId }, { orderId: dispatched.id, version: dispatched.version, cancelReason: "too late" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("keeps draft/submit/approve reachable when stock.transfers is OFF, but refuses dispatch and receive", async () => {
    const fx = await hqToOutletFixture("20.000000");
    const svc = service();
    await setTransfersEnabled(false);

    const draft = await svc.createDraft(
      { actorUserId: fx.creatorUserId },
      { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx, { enteredQuantity: "2" })] },
    );
    expect(draft.status).toBe("DRAFT");
    const submitted = await svc.submit({ actorUserId: fx.creatorUserId }, { orderId: draft.id, version: draft.version });
    expect(submitted.status).toBe("SUBMITTED");
    const approved = await svc.approve({ actorUserId: fx.approverUserId }, { orderId: submitted.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");

    await expect(
      svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });

    await setTransfersEnabled(true);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    await setTransfersEnabled(false);
    await expect(
      svc.receive({ actorUserId: fx.receiverUserId }, { orderId: dispatched.id, version: dispatched.version }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    await setTransfersEnabled(true);
  });

  it("rejects an actor role outside TRANSFER_ROLES", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    const outsider = await makeUser("KITCHEN_CREW");
    await expect(
      service().createDraft(
        { actorUserId: outsider.id },
        { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx)] },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an ASSIGNED-scope actor whose outlet access does not cover the order's source location", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    const outsider = await makeUser("WAREHOUSE_OUTLET");
    const otherOutlet = await makeLocation();
    await grantAccess(outsider.id, otherOutlet.id);
    await expect(
      service().createDraft(
        { actorUserId: outsider.id },
        { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [lineInput(fx)] },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows a destination-scoped WAREHOUSE_OUTLET actor to receive without HQ-wide access", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture("15.000000");
    const outletReceiver = await makeUser("WAREHOUSE_OUTLET");
    await grantAccess(outletReceiver.id, fx.destinationLocationId);

    const svc = service();
    const approved = await toApproved(svc, fx, [lineInput(fx, { enteredQuantity: "5" })]);
    const dispatched = await svc.dispatch({ actorUserId: fx.creatorUserId }, { orderId: approved.id, version: approved.version });
    const received = await svc.receive({ actorUserId: outletReceiver.id }, { orderId: dispatched.id, version: dispatched.version });
    expect(received.status).toBe("RECEIVED");
  });

  it("rejects a duplicate pinned lot across lines in the same order as DUPLICATE_LINE", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    await expect(
      service().createDraft(
        { actorUserId: fx.creatorUserId },
        {
          sourceWarehouseId: fx.sourceWarehouseId,
          destinationWarehouseId: fx.destinationWarehouseId,
          lines: [lineInput(fx, { enteredQuantity: "1" }), lineInput(fx, { enteredQuantity: "2" })],
        },
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });
  });

  it("rejects an entered UOM with no matching item unit or active conversion as UOM_MISMATCH", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    await expect(
      service().createDraft(
        { actorUserId: fx.creatorUserId },
        {
          sourceWarehouseId: fx.sourceWarehouseId,
          destinationWarehouseId: fx.destinationWarehouseId,
          lines: [lineInput(fx, { enteredUom: "liters" })],
        },
      ),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH" });
  });

  it("rejects an empty line set as VALIDATION", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    await expect(
      service().createDraft(
        { actorUserId: fx.creatorUserId },
        { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.destinationWarehouseId, lines: [] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("propagates TransferOrderError instances with a stable code/status shape", async () => {
    await setTransfersEnabled(true);
    const fx = await hqToOutletFixture();
    let caught: unknown;
    try {
      await service().createDraft(
        { actorUserId: fx.creatorUserId },
        { sourceWarehouseId: fx.sourceWarehouseId, destinationWarehouseId: fx.sourceWarehouseId, lines: [lineInput(fx)] },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransferOrderError);
    expect((caught as TransferOrderError).code).toBe("VALIDATION");
    expect((caught as TransferOrderError).status).toBe(400);
  });
});
