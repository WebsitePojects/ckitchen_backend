/**
 * Job Order production output coverage for completeJobOrder() (IN_PROGRESS ->
 * COMPLETED): output lot minting (status/expiry/unit cost), immediate
 * availability via inventory_lot_balance, component-lot -> output-lot
 * genealogy, actual-yield cost computation, idempotent replay, invalid
 * transitions/actors/quantities, a reachable UOM-mismatch path, concurrent
 * completion convergence, and posting-failure rollback + retry. Fixture setup
 * mirrors test/job-order-consumption.test.ts (HQ_MAIN + stock.lot_writes flag
 * + resolved topology exceptions), since completeJobOrder() posts through the
 * central stock posting service exactly like startJobOrder() does.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  auditLogs,
  employees,
  ingredients,
  locations,
  users,
  userSessions,
  warehouses,
  type Role,
} from "../src/db/schema.js";
import {
  inventoryLotBalances,
  inventoryLotGenealogy,
  inventoryLots,
  itemUomConversions,
  operationalFeatureFlags,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { jobOrderComponentAllocations, jobOrderOutputLots, jobOrders } from "../src/db/production-schema.js";
import { createBomService } from "../src/modules/production/service.js";
import { completeJobOrder, createJobOrderService } from "../src/modules/production/job-order-service.js";
import { PRODUCTION_OUTPUT_MODULE, PRODUCTION_OUTPUT_POLICY } from "../src/modules/production/policies.js";
import { createStockPostingService } from "../src/modules/stock/posting-service.js";
import type { BomVersion } from "../src/modules/production/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  // completeJobOrder() posts stock through the central posting service, which
  // requires stock.lot_writes enabled, exactly one active HQ_MAIN warehouse,
  // and no OPEN topology exceptions before it will accept any movement.
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  const [hqLocation] = await db
    .insert(locations)
    .values({ code: `JOO-HQ-${suffix()}`, name: "JOO HQ" })
    .returning();
  await makeWarehouse(hqLocation!.id, "HQ_MAIN");
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
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.production"));
}

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

/** Mirrors job-order-service.ts's addDaysToManilaDate(), for expected-value assertions. */
function expectedExpiryDate(days: number): string {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
  today.setUTCDate(today.getUTCDate() + days);
  return today.toISOString().slice(0, 10);
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({
      name: `JOO User ${s}`,
      email: `joo-${s}@test.local`,
      passwordHash: "hash",
      role,
      status,
    })
    .returning();
  return user!;
}

async function makeSession(userId: string, active = true) {
  const [session] = await db
    .insert(userSessions)
    .values({ userId, logoutAt: active ? null : new Date() })
    .returning();
  return session!;
}

async function makeItem(
  itemType: "RAW" | "WIP" | "FINISHED_GOOD" | "CONSUMABLE" | "PACKAGING" | "SERVICE",
  overrides: Partial<{ unit: string; isActive: boolean; name: string; shelfLifeDays: number | null }> = {},
) {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `JOO-ITEM-${s}`,
      name: overrides.name ?? `JOO Item ${s}`,
      unit: overrides.unit ?? "kg",
      itemType,
      lotTracked: false,
      isActive: overrides.isActive ?? true,
      shelfLifeDays: overrides.shelfLifeDays ?? null,
      unitCost: "1.0000",
      lowStockThreshold: "0.0000",
    })
    .returning();
  return item!;
}

async function makeLocation() {
  const s = suffix();
  const [location] = await db
    .insert(locations)
    .values({ code: `JOO-LOC-${s}`, name: `JOO Location ${s}` })
    .returning();
  return location!;
}

async function makeWarehouse(
  locationId: string,
  purpose: "HQ_MAIN" | "OUTLET_STORAGE" | "KITCHEN" | "PRODUCTION" | "QUARANTINE",
  isActive = true,
) {
  const s = suffix();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId,
      type: "MAIN",
      purpose,
      code: `JOO-WH-${s}`,
      name: `JOO Warehouse ${s}`,
      isActive,
    })
    .returning();
  return warehouse!;
}

async function makeEmployee(overrides: Partial<{ locationId: string | null; status: "ACTIVE" | "INACTIVE" }> = {}) {
  const s = suffix();
  const [employee] = await db
    .insert(employees)
    .values({
      employeeNo: `JOO-EMP-${s}`,
      fullName: `JOO Employee ${s}`,
      department: "KITCHEN",
      status: overrides.status ?? "ACTIVE",
      locationId: overrides.locationId ?? null,
    })
    .returning();
  return employee!;
}

function bomService() {
  return createBomService(db);
}

function jobService() {
  return createJobOrderService(db);
}

interface ComponentSpec {
  item: { id: string };
  qty: string;
  uom: string;
  scrapAllowancePct?: string;
}

async function createActiveBom(
  ownerId: string,
  outputItem: { id: string },
  componentSpecs: ComponentSpec[],
  outputYieldQty = "1.000000",
  outputUom = "kg",
): Promise<BomVersion> {
  const svc = bomService();
  const header = await svc.createHeader(
    { actorUserId: ownerId },
    { code: `JOO-BOM-${suffix()}`, name: "JOO Test BOM", outputItemId: outputItem.id },
  );
  const version = await svc.createDraftVersion(
    { actorUserId: ownerId },
    { bomHeaderId: header.id, outputUom, outputYieldQty, effectiveFrom: "2026-01-01" },
  );
  await svc.replaceDraftComponents(
    { actorUserId: ownerId },
    {
      bomVersionId: version.id,
      lines: componentSpecs.map((c) => ({
        componentItemId: c.item.id,
        enteredQuantity: c.qty,
        enteredUom: c.uom,
        scrapAllowancePct: c.scrapAllowancePct,
      })),
    },
  );
  return svc.activateVersion({ actorUserId: ownerId }, { bomVersionId: version.id });
}

async function setupProductionLocation() {
  const location = await makeLocation();
  const productionWarehouse = await makeWarehouse(location.id, "PRODUCTION");
  return { location, productionWarehouse };
}

interface LotSpec {
  onHand: string;
  expiresAt?: string | null;
  unitCost?: string;
  status?: "AVAILABLE" | "QUARANTINED" | "EXPIRED" | "RECALLED" | "DAMAGED" | "DISPOSED";
}

async function seedLot(itemId: string, warehouseId: string, spec: LotSpec) {
  const s = suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode: `JOO-LOT-${s}`,
      status: spec.status ?? "AVAILABLE",
      expiresAt: spec.expiresAt ?? null,
      unitCost: spec.unitCost ?? "1.000000",
    })
    .returning();
  await db.insert(inventoryLotBalances).values({
    warehouseId,
    lotId: lot!.id,
    onHand: spec.onHand,
    reserved: "0",
  });
  return lot!;
}

async function lotBalanceRow(warehouseId: string, lotId: string) {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row ?? null;
}

async function outputLotByJobOrderId(jobOrderId: string) {
  const [lot] = await db
    .select()
    .from(inventoryLots)
    .where(eq(inventoryLots.lotCode, `JOBORDER:${jobOrderId}`));
  return lot ?? null;
}

/** Drives a fresh DRAFT Job Order through submit -> approve -> release -> start, returning it IN_PROGRESS. */
async function startFreshJobOrder(
  ownerId: string,
  approverId: string,
  bomVersionId: string,
  locationId: string,
  plannedOutputQty = "1.000000",
) {
  const svc = jobService();
  const draft = await svc.createDraft(
    { actorUserId: ownerId },
    {
      jobOrderNo: `JOO-JO-${suffix()}`,
      bomVersionId,
      locationId,
      plannedOutputQty,
      plannedOutputUom: "kg",
    },
  );
  const submitted = await svc.submit({ actorUserId: ownerId }, { jobOrderId: draft.id, expectedVersion: draft.version });
  const approved = await svc.approve(
    { actorUserId: approverId },
    { jobOrderId: draft.id, expectedVersion: submitted.version },
  );
  const released = await svc.release(
    { actorUserId: ownerId },
    { jobOrderId: draft.id, expectedVersion: approved.version },
  );
  const operator = await makeEmployee({ locationId });
  const started = await svc.start(
    { actorUserId: ownerId },
    { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
  );
  return { draft, started, operator };
}

/** Standard 3-component fixture: chicken (2.000000/kg) + salt (3.000000/kg) + pepper (5.000000/kg) -> roast chicken. */
async function setupRoastChickenFixture(outputItemType: "WIP" | "FINISHED_GOOD" = "FINISHED_GOOD", shelfLifeDays: number | null = null) {
  const owner = await makeUser("OWNER");
  const approver = await makeUser("WAREHOUSE_MAIN");
  const { location, productionWarehouse } = await setupProductionLocation();
  const chicken = await makeItem("RAW", { unit: "kg" });
  const salt = await makeItem("RAW", { unit: "kg" });
  const pepper = await makeItem("RAW", { unit: "kg" });
  const roastChicken = await makeItem(outputItemType, { unit: "kg", name: "Roast Chicken", shelfLifeDays });
  const activeVersion = await createActiveBom(
    owner.id,
    roastChicken,
    [
      { item: chicken, qty: "1.000000", uom: "kg" },
      { item: salt, qty: "0.050000", uom: "kg" },
      { item: pepper, qty: "0.010000", uom: "kg" },
    ],
    "1.000000",
    "kg",
  );

  const chickenLot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000", unitCost: "2.000000" });
  const saltLot = await seedLot(salt.id, productionWarehouse.id, { onHand: "10.000000", unitCost: "3.000000" });
  const pepperLot = await seedLot(pepper.id, productionWarehouse.id, { onHand: "10.000000", unitCost: "5.000000" });

  return {
    owner,
    approver,
    location,
    productionWarehouse,
    chicken,
    salt,
    pepper,
    roastChicken,
    activeVersion,
    chickenLot,
    saltLot,
    pepperLot,
  };
}

describe("Job Order production output (completeJobOrder)", () => {
  it("happy path: mints an AVAILABLE output lot with correct unit cost/expiry and evidence row (FINISHED_GOOD output, with shelf life)", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture("FINISHED_GOOD", 5);
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    const completed = await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000", evidenceRef: "photo-01" },
    );

    expect(completed.status).toBe("COMPLETED");
    expect(completed.actualOutputQty).toBe("1.000000");
    expect(completed.completedBy).toBe(fx.owner.id);

    // chicken 1kg@2 + salt 0.05kg@3 + pepper 0.01kg@5 = 2 + 0.15 + 0.05 = 2.2; /1kg actual = 2.200000
    const outputLot = await outputLotByJobOrderId(draft.id);
    expect(outputLot).not.toBeNull();
    expect(outputLot!.status).toBe("AVAILABLE");
    expect(outputLot!.unitCost).toBe("2.200000");
    expect(outputLot!.expiresAt).toBe(expectedExpiryDate(5));
    expect(outputLot!.itemId).toBe(fx.roastChicken.id);

    const [evidence] = await db
      .select()
      .from(jobOrderOutputLots)
      .where(eq(jobOrderOutputLots.jobOrderId, draft.id));
    expect(evidence).toMatchObject({
      outputLotId: outputLot!.id,
      quantity: "1.000000",
      evidenceRef: "photo-01",
    });
    expect(evidence!.outputPostingLineId).toBeTruthy();
  });

  it("happy path: mints an AVAILABLE output lot with null expiry when the output item has no shelf life (WIP output)", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture("WIP", null);
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    const completed = await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
    );
    expect(completed.status).toBe("COMPLETED");

    const outputLot = await outputLotByJobOrderId(draft.id);
    expect(outputLot!.expiresAt).toBeNull();
  });

  it("makes the output lot immediately available: inventory_lot_balance onHand == actualOutputQty, status AVAILABLE, at the job's PRODUCTION warehouse", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
    );

    const outputLot = await outputLotByJobOrderId(draft.id);
    const balance = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balance).not.toBeNull();
    expect(balance!.onHand).toBe("1.000000");

    const [lotRow] = await db.select().from(inventoryLots).where(eq(inventoryLots.id, outputLot!.id));
    expect(lotRow!.status).toBe("AVAILABLE");
  });

  it("records one inventory_lot_genealogy row per consumed source lot, with correct parent/child/quantity/document", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
    );

    const outputLot = await outputLotByJobOrderId(draft.id);
    const genealogyRows = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.childLotId, outputLot!.id));
    expect(genealogyRows).toHaveLength(3);

    const allocations = await db
      .select()
      .from(jobOrderComponentAllocations)
      .where(eq(jobOrderComponentAllocations.jobOrderId, draft.id));
    const byParent = new Map(genealogyRows.map((row) => [row.parentLotId, row]));
    for (const allocation of allocations) {
      const row = byParent.get(allocation.sourceLotId!);
      expect(row).toBeTruthy();
      expect(row!.quantityConsumed).toBe(allocation.allocatedQuantity);
      expect(row!.productionDocumentNo).toBe(draft.jobOrderNo);
    }
  });

  it("computes cost/unit cost against the ACTUAL output quantity, not the planned quantity (under-yield)", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    // Planned output 1kg, but actual yield is only 0.8kg (under-yield).
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    const completed = await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "0.800000" },
    );
    expect(completed.actualOutputQty).toBe("0.800000");

    // Total consumed cost is fixed at 2.2 (based on the planned/consumed component
    // quantities from startJobOrder(), unaffected by actual yield); unit cost =
    // 2.2 / 0.8 = 2.750000.
    const outputLot = await outputLotByJobOrderId(draft.id);
    expect(outputLot!.unitCost).toBe("2.750000");

    const balance = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balance!.onHand).toBe("0.800000");
  });

  it("is idempotent: calling complete() twice returns COMPLETED with no duplicate lot/genealogy/posting/balance", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    const first = await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
    );
    expect(first.status).toBe("COMPLETED");

    const outputLot = await outputLotByJobOrderId(draft.id);
    const balanceAfterFirst = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balanceAfterFirst!.onHand).toBe("1.000000");

    const postingCountAfterFirst = (
      await db.select({ id: stockPostings.id }).from(stockPostings).where(eq(stockPostings.sourceDocumentNo, draft.jobOrderNo))
    ).length;

    // Second call: same jobOrderId + same (now stale) expectedVersion. The
    // service special-cases status === "COMPLETED" as a safe replay before it
    // ever compares expectedVersion.
    const second = await svc.complete(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
    );
    expect(second.status).toBe("COMPLETED");
    expect(second.id).toBe(first.id);

    const outputLotsAfter = await db.select().from(inventoryLots).where(eq(inventoryLots.lotCode, `JOBORDER:${draft.id}`));
    expect(outputLotsAfter).toHaveLength(1);

    const genealogyRows = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.childLotId, outputLot!.id));
    expect(genealogyRows).toHaveLength(3);

    const evidenceRows = await db.select().from(jobOrderOutputLots).where(eq(jobOrderOutputLots.jobOrderId, draft.id));
    expect(evidenceRows).toHaveLength(1);

    const balanceAfterSecond = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balanceAfterSecond!.onHand).toBe("1.000000"); // not double-counted

    const postingCountAfterSecond = (
      await db.select({ id: stockPostings.id }).from(stockPostings).where(eq(stockPostings.sourceDocumentNo, draft.jobOrderNo))
    ).length;
    expect(postingCountAfterSecond).toBe(postingCountAfterFirst);
  });

  it("rejects complete() on a not-yet-started Job Order (DRAFT or RELEASED) with INVALID_TRANSITION", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const svc = jobService();

    const draft = await svc.createDraft(
      { actorUserId: fx.owner.id },
      {
        jobOrderNo: `JOO-JO-${suffix()}`,
        bomVersionId: fx.activeVersion.id,
        locationId: fx.location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "kg",
      },
    );
    await expect(
      svc.complete(
        { actorUserId: fx.owner.id },
        { jobOrderId: draft.id, expectedVersion: draft.version, actualOutputQty: "1.000000" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });

    const submitted = await svc.submit({ actorUserId: fx.owner.id }, { jobOrderId: draft.id, expectedVersion: draft.version });
    const approved = await svc.approve(
      { actorUserId: fx.approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    const released = await svc.release(
      { actorUserId: fx.owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );
    await expect(
      svc.complete(
        { actorUserId: fx.owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, actualOutputQty: "1.000000" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("rejects complete() from a role outside STOCK_PRODUCTION_ROLES with UNAUTHORIZED", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");
    const kitchenCrew = await makeUser("KITCHEN_CREW");

    const svc = jobService();
    await expect(
      svc.complete(
        { actorUserId: kitchenCrew.id },
        { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("IN_PROGRESS");
  });

  it("rejects complete() with UOM_MISMATCH when the job's pinned output UOM is not the output item's base unit", async () => {
    // Reachable path: BOM authoring's assertUomRecognized() accepts a
    // version.outputUom that differs from the output item's base `unit` as
    // long as an active item_uom_conversion row exists for it (e.g. "L" for
    // a "kg"-based item) -- createJobOrderDraft() then pins jobOrder.outputUom
    // to that same non-base UOM. completeJobOrder() deliberately does not
    // perform a UOM conversion (per the task spec's "simpler" option), so it
    // requires the output item's base unit to equal jobOrder.outputUom and
    // rejects otherwise.
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    await db.insert(itemUomConversions).values({
      itemId: output.id,
      fromUom: "L",
      toBaseFactor: "1.00000000",
      isActive: true,
    });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }], "1.000000", "L");
    await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `JOO-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "L",
      },
    );
    const submitted = await svc.submit({ actorUserId: owner.id }, { jobOrderId: draft.id, expectedVersion: draft.version });
    const approved = await svc.approve({ actorUserId: approver.id }, { jobOrderId: draft.id, expectedVersion: submitted.version });
    const released = await svc.release({ actorUserId: owner.id }, { jobOrderId: draft.id, expectedVersion: approved.version });
    const operator = await makeEmployee({ locationId: location.id });
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.outputUom).toBe("L");

    await expect(
      svc.complete(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
      ),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH", status: 409 });

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("IN_PROGRESS");
  });

  it("rejects complete() with VALIDATION for a zero, negative, or non-numeric actualOutputQty, with no side effects", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");
    const svc = jobService();

    for (const bad of ["0.000000", "-1.000000", "not-a-number"]) {
      await expect(
        svc.complete(
          { actorUserId: fx.owner.id },
          { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: bad },
        ),
      ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    }

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("IN_PROGRESS");
    expect(current!.version).toBe(started.version);
    const outputLot = await outputLotByJobOrderId(draft.id);
    expect(outputLot).toBeNull();
  });

  it("converges two concurrent complete() calls on the same IN_PROGRESS job order to a single output lot/posting/balance", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const svc = jobService();
    const call = () =>
      svc.complete(
        { actorUserId: fx.owner.id },
        { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: "1.000000" },
      );

    const settled = await Promise.allSettled([call(), call()]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("COMPLETED");

    const outputLots = await db.select().from(inventoryLots).where(eq(inventoryLots.lotCode, `JOBORDER:${draft.id}`));
    expect(outputLots).toHaveLength(1);

    const balance = await lotBalanceRow(fx.productionWarehouse.id, outputLots[0]!.id);
    expect(balance!.onHand).toBe("1.000000");

    // Filtered to PRODUCTION_OUTPUT specifically: sourceDocumentNo alone would
    // also match the PRODUCTION_CONSUME posting startFreshJobOrder() already
    // created under the same jobOrderNo (different sourceModule).
    const postingRows = await db
      .select()
      .from(stockPostings)
      .where(and(eq(stockPostings.sourceDocumentNo, draft.jobOrderNo), eq(stockPostings.sourceModule, PRODUCTION_OUTPUT_MODULE)));
    expect(postingRows).toHaveLength(1);
  });

  it("rolls back cleanly on a posting failure (job order stays IN_PROGRESS, no balance credited), then a retry succeeds reusing the idempotently-created output lot/genealogy/evidence", async () => {
    await setFlags(true);
    const fx = await setupRoastChickenFixture();
    const { draft, started } = await startFreshJobOrder(fx.owner.id, fx.approver.id, fx.activeVersion.id, fx.location.id, "1.000000");

    const faultyPostingService = createStockPostingService(db, {
      documentPolicies: { [PRODUCTION_OUTPUT_MODULE]: PRODUCTION_OUTPUT_POLICY },
      faultInjector(stage) {
        if (stage === "after_ledger") throw new Error("injected-output-fault");
      },
    });

    await expect(
      completeJobOrder(db, faultyPostingService, {
        actorUserId: fx.owner.id,
        jobOrderId: draft.id,
        expectedVersion: started.version,
        actualOutputQty: "1.000000",
      }),
    ).rejects.toThrow("injected-output-fault");

    const [afterFailure] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(afterFailure!.status).toBe("IN_PROGRESS");
    expect(afterFailure!.version).toBe(started.version);

    // The output lot/genealogy/evidence rows from the failed attempt's
    // prepare transaction are left in place (idempotent-safe to reuse), but
    // no balance was credited since the posting transaction itself rolled
    // back entirely.
    const outputLot = await outputLotByJobOrderId(draft.id);
    expect(outputLot).not.toBeNull();
    const balanceAfterFailure = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balanceAfterFailure === null || balanceAfterFailure.onHand === "0.000000").toBe(true);

    const genealogyAfterFailure = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.childLotId, outputLot!.id));
    expect(genealogyAfterFailure).toHaveLength(3);
    const evidenceAfterFailure = await db.select().from(jobOrderOutputLots).where(eq(jobOrderOutputLots.jobOrderId, draft.id));
    expect(evidenceAfterFailure).toHaveLength(1);
    expect(evidenceAfterFailure[0]!.outputPostingLineId).toBeNull();

    // Retry with a clean (non-faulty) posting service reuses the same
    // idempotently-created rows and succeeds.
    const cleanPostingService = createStockPostingService(db, {
      documentPolicies: { [PRODUCTION_OUTPUT_MODULE]: PRODUCTION_OUTPUT_POLICY },
    });
    const completed = await completeJobOrder(db, cleanPostingService, {
      actorUserId: fx.owner.id,
      jobOrderId: draft.id,
      expectedVersion: started.version,
      actualOutputQty: "1.000000",
    });
    expect(completed.status).toBe("COMPLETED");

    const outputLotsAfterRetry = await db.select().from(inventoryLots).where(eq(inventoryLots.lotCode, `JOBORDER:${draft.id}`));
    expect(outputLotsAfterRetry).toHaveLength(1);
    expect(outputLotsAfterRetry[0]!.id).toBe(outputLot!.id);

    const balanceAfterRetry = await lotBalanceRow(fx.productionWarehouse.id, outputLot!.id);
    expect(balanceAfterRetry!.onHand).toBe("1.000000");

    const genealogyAfterRetry = await db
      .select()
      .from(inventoryLotGenealogy)
      .where(eq(inventoryLotGenealogy.childLotId, outputLot!.id));
    expect(genealogyAfterRetry).toHaveLength(3);
    const evidenceAfterRetry = await db.select().from(jobOrderOutputLots).where(eq(jobOrderOutputLots.jobOrderId, draft.id));
    expect(evidenceAfterRetry).toHaveLength(1);
    expect(evidenceAfterRetry[0]!.outputPostingLineId).toBeTruthy();

    const linesAfterRetry = await db
      .select()
      .from(stockPostingLines)
      .where(eq(stockPostingLines.id, evidenceAfterRetry[0]!.outputPostingLineId!));
    expect(linesAfterRetry).toHaveLength(1);
  });
});
