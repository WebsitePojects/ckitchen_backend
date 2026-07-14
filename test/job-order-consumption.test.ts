/**
 * Job Order consumption/posting coverage for startJobOrder() (RELEASED ->
 * IN_PROGRESS): FEFO lot selection (split across lots, expired-lot
 * exclusion), exact multi-component balance/posting-line assertions,
 * planned-allocation-as-source-of-truth, audit/outbox side effects,
 * all-or-nothing failure on partial insufficient stock, idempotent replay,
 * concurrent-start convergence, and role/scope/session denial. Fixture setup
 * mirrors test/job-order-lifecycle.test.ts (HQ_MAIN + stock.lot_writes flag +
 * resolved topology exceptions) since startJobOrder() posts through the
 * central stock posting service, which requires all three preconditions.
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
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  outboxEvents,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { jobOrderComponentAllocations, jobOrders } from "../src/db/production-schema.js";
import { createBomService } from "../src/modules/production/service.js";
import { createJobOrderService } from "../src/modules/production/job-order-service.js";
import type { BomVersion } from "../src/modules/production/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  // startJobOrder() posts stock through the central posting service, which
  // requires stock.lot_writes enabled, exactly one active HQ_MAIN warehouse,
  // and no OPEN topology exceptions before it will accept any movement.
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  const [hqLocation] = await db
    .insert(locations)
    .values({ code: `JOC-HQ-${suffix()}`, name: "JOC HQ" })
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

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({
      name: `JOC User ${s}`,
      email: `joc-${s}@test.local`,
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
  overrides: Partial<{ unit: string; isActive: boolean; name: string }> = {},
) {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `JOC-ITEM-${s}`,
      name: overrides.name ?? `JOC Item ${s}`,
      unit: overrides.unit ?? "kg",
      itemType,
      lotTracked: false,
      isActive: overrides.isActive ?? true,
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
    .values({ code: `JOC-LOC-${s}`, name: `JOC Location ${s}` })
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
      code: `JOC-WH-${s}`,
      name: `JOC Warehouse ${s}`,
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
      employeeNo: `JOC-EMP-${s}`,
      fullName: `JOC Employee ${s}`,
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
    { code: `JOC-BOM-${suffix()}`, name: "JOC Test BOM", outputItemId: outputItem.id },
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
  status?: "AVAILABLE" | "QUARANTINED" | "EXPIRED" | "RECALLED" | "DAMAGED" | "DISPOSED";
}

async function seedLot(itemId: string, warehouseId: string, spec: LotSpec) {
  const s = suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode: `JOC-LOT-${s}`,
      status: spec.status ?? "AVAILABLE",
      expiresAt: spec.expiresAt ?? null,
      unitCost: "1.000000",
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

async function lotBalance(warehouseId: string, lotId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row!.onHand;
}

/** Drives a fresh DRAFT Job Order through submit -> approve -> release, returning it RELEASED. */
async function releaseFreshJobOrder(
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
      jobOrderNo: `JOC-JO-${suffix()}`,
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
  return { draft, released };
}

describe("Job Order consumption/posting (startJobOrder)", () => {
  it("FEFO splits a single component's need across two AVAILABLE lots, draining the earlier-expiry lot first", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);

    // Planned output 3kg -> needed = 3kg. Lot A (earlier expiry) has 2kg,
    // Lot B (later expiry) has 5kg: FEFO must take 2kg from A + 1kg from B.
    const lotA = await seedLot(chicken.id, productionWarehouse.id, { onHand: "2.000000", expiresAt: "2030-01-01" });
    const lotB = await seedLot(chicken.id, productionWarehouse.id, { onHand: "5.000000", expiresAt: "2031-01-01" });

    const { draft, released } = await releaseFreshJobOrder(
      owner.id,
      approver.id,
      activeVersion.id,
      location.id,
      "3.000000",
    );
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.status).toBe("IN_PROGRESS");

    expect(await lotBalance(productionWarehouse.id, lotA.id)).toBe("0.000000");
    expect(await lotBalance(productionWarehouse.id, lotB.id)).toBe("4.000000");

    const allocations = await db
      .select()
      .from(jobOrderComponentAllocations)
      .where(eq(jobOrderComponentAllocations.jobOrderId, draft.id))
      .orderBy(jobOrderComponentAllocations.lineNo);
    expect(allocations).toHaveLength(2);
    const byLot = new Map(allocations.map((a) => [a.sourceLotId, a]));
    expect(byLot.get(lotA.id)!.allocatedQuantity).toBe("2.000000");
    expect(byLot.get(lotB.id)!.allocatedQuantity).toBe("1.000000");
  });

  it("skips an expired lot even with sufficient on-hand qty, consuming instead from a valid non-expired lot", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);

    const expiredLot = await seedLot(chicken.id, productionWarehouse.id, {
      onHand: "100.000000",
      expiresAt: "2020-01-01",
    });
    const validLot = await seedLot(chicken.id, productionWarehouse.id, {
      onHand: "1.000000",
      expiresAt: null,
    });

    const { draft, released } = await releaseFreshJobOrder(
      owner.id,
      approver.id,
      activeVersion.id,
      location.id,
      "1.000000",
    );
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.status).toBe("IN_PROGRESS");

    expect(await lotBalance(productionWarehouse.id, expiredLot.id)).toBe("100.000000");
    expect(await lotBalance(productionWarehouse.id, validLot.id)).toBe("0.000000");

    const [allocation] = await db
      .select()
      .from(jobOrderComponentAllocations)
      .where(eq(jobOrderComponentAllocations.jobOrderId, draft.id));
    expect(allocation!.sourceLotId).toBe(validLot.id);
  });

  it("consumes exact multi-component balances and posting lines matching planned allocation", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const pepper = await makeItem("RAW", { unit: "kg" });
    const roastChicken = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Roast Chicken" });

    // BOM yields 1kg from chicken 1kg (5% scrap) + salt 0.05kg + pepper 0.01kg;
    // planned output 2kg scales to chicken 2.1kg, salt 0.1kg, pepper 0.02kg
    // (mirrors test/job-order-draft.test.ts's scaling assertions).
    const activeVersion = await createActiveBom(
      owner.id,
      roastChicken,
      [
        { item: chicken, qty: "1.000000", uom: "kg", scrapAllowancePct: "5" },
        { item: salt, qty: "0.050000", uom: "kg" },
        { item: pepper, qty: "0.010000", uom: "kg" },
      ],
      "1.000000",
      "kg",
    );

    const chickenLot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });
    const saltLot = await seedLot(salt.id, productionWarehouse.id, { onHand: "10.000000" });
    const pepperLot = await seedLot(pepper.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(
      owner.id,
      approver.id,
      activeVersion.id,
      location.id,
      "2.000000",
    );
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.status).toBe("IN_PROGRESS");

    expect(await lotBalance(productionWarehouse.id, chickenLot.id)).toBe("7.900000"); // 10 - 2.1
    expect(await lotBalance(productionWarehouse.id, saltLot.id)).toBe("9.900000"); // 10 - 0.1
    expect(await lotBalance(productionWarehouse.id, pepperLot.id)).toBe("9.980000"); // 10 - 0.02

    const allocations = await db
      .select()
      .from(jobOrderComponentAllocations)
      .where(eq(jobOrderComponentAllocations.jobOrderId, draft.id));
    expect(allocations).toHaveLength(3);
    const byItem = new Map(allocations.map((a) => [a.componentItemId, a]));
    expect(byItem.get(chicken.id)!.allocatedQuantity).toBe("2.100000");
    expect(byItem.get(salt.id)!.allocatedQuantity).toBe("0.100000");
    expect(byItem.get(pepper.id)!.allocatedQuantity).toBe("0.020000");

    // Every allocation's plannedQuantity must equal its allocatedQuantity
    // (single-lot coverage) and every consumePostingLineId must resolve to a
    // real stock_posting_line row for the right item/lot/warehouse/qty.
    for (const allocation of allocations) {
      expect(allocation.allocatedQuantity).toBe(allocation.plannedQuantity);
      expect(allocation.consumePostingLineId).toBeTruthy();
      const [line] = await db
        .select()
        .from(stockPostingLines)
        .where(eq(stockPostingLines.id, allocation.consumePostingLineId!));
      expect(line).toMatchObject({
        itemId: allocation.componentItemId,
        lotId: allocation.sourceLotId,
        warehouseId: productionWarehouse.id,
        movementType: "OUT",
        quantity: allocation.allocatedQuantity,
      });
    }

    const distinctLots = new Set(allocations.map((a) => a.sourceLotId));
    expect(distinctLots).toEqual(new Set([chickenLot.id, saltLot.id, pepperLot.id]));
  });

  it("creates the consume operational document, audit log, and outbox event on start()", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.operatorId).toBe(operator.id);

    const [consumeDoc] = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_CONSUME"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    expect(consumeDoc).toMatchObject({ status: "CONSUMED" });
    expect(consumeDoc!.stockPostingId).toBeTruthy();

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "job_order"), eq(auditLogs.entityId, draft.id), eq(auditLogs.action, "job_order.started")));
    expect(auditRow).toBeTruthy();

    const [postingRow] = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, draft.jobOrderNo));
    expect(postingRow).toBeTruthy();
    const [outboxRow] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, postingRow!.id));
    expect(outboxRow).toBeTruthy();
  });

  it("fails start() entirely with no side effects when one of several components has insufficient stock", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [
      { item: chicken, qty: "1.000000", uom: "kg" },
      { item: salt, qty: "1.000000", uom: "kg" },
    ]);

    const chickenLot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });
    // Salt has only 0.5kg on hand; plan needs 1kg -> INSUFFICIENT_STOCK.
    const saltLot = await seedLot(salt.id, productionWarehouse.id, { onHand: "0.500000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();

    const postingCountBefore = (await db.select({ id: stockPostings.id }).from(stockPostings)).length;
    const lineCountBefore = (await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length;
    const auditCountBefore = (await db.select({ id: auditLogs.id }).from(auditLogs)).length;
    const outboxCountBefore = (await db.select({ id: outboxEvents.id }).from(outboxEvents)).length;

    await expect(
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });

    // No lot balance for ANY component changed (chicken's plan would have
    // succeeded on its own, but the whole prepare transaction rolls back).
    expect(await lotBalance(productionWarehouse.id, chickenLot.id)).toBe("10.000000");
    expect(await lotBalance(productionWarehouse.id, saltLot.id)).toBe("0.500000");

    expect((await db.select({ id: stockPostings.id }).from(stockPostings)).length).toBe(postingCountBefore);
    expect((await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length).toBe(lineCountBefore);
    expect((await db.select({ id: auditLogs.id }).from(auditLogs)).length).toBe(auditCountBefore);
    expect((await db.select({ id: outboxEvents.id }).from(outboxEvents)).length).toBe(outboxCountBefore);

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("RELEASED");
    expect(current!.operatorId).toBeNull();

    const [consumeDoc] = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_CONSUME"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    expect(consumeDoc).toMatchObject({ status: "PENDING", stockPostingId: null });
  });

  it("is idempotent: calling start() again on an already IN_PROGRESS job order does not deduct stock twice", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const lot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();

    const first = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(first.status).toBe("IN_PROGRESS");
    expect(await lotBalance(productionWarehouse.id, lot.id)).toBe("9.000000");

    const postingCountAfterFirst = (await db.select({ id: stockPostings.id }).from(stockPostings)).length;
    const lineCountAfterFirst = (await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length;

    // Second call: same jobOrderId, but the version is already stale relative
    // to the row (it advanced RELEASED -> IN_PROGRESS on the first call). The
    // service still special-cases status === "IN_PROGRESS" as a safe replay
    // before it ever compares expectedVersion, so this must not double-post.
    const second = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(second.status).toBe("IN_PROGRESS");
    expect(second.id).toBe(first.id);

    expect(await lotBalance(productionWarehouse.id, lot.id)).toBe("9.000000");
    expect((await db.select({ id: stockPostings.id }).from(stockPostings)).length).toBe(postingCountAfterFirst);
    expect((await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length).toBe(lineCountAfterFirst);
  });

  it("converges two concurrent start() calls on the same RELEASED job order to a single effective deduction", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const lot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();

    const call = () =>
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
      );

    const settled = await Promise.allSettled([call(), call()]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    // Both may converge safely (one performs the real transition, the other
    // observes IN_PROGRESS and replays) or exactly one may win with the other
    // rejected on CONCURRENT_MODIFICATION/version race — either way exactly
    // one physical deduction must have occurred.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    expect(await lotBalance(productionWarehouse.id, lot.id)).toBe("9.000000"); // exactly one deduction of 1kg

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("IN_PROGRESS");

    const postingRows = await db.select().from(stockPostings).where(eq(stockPostings.sourceDocumentNo, draft.jobOrderNo));
    expect(postingRows).toHaveLength(1);
    const lineRows = await db.select().from(stockPostingLines).where(eq(stockPostingLines.postingId, postingRows[0]!.id));
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]).toMatchObject({ itemId: chicken.id, lotId: lot.id, quantity: "1.000000" });
  });

  it("rejects start() from a role outside STOCK_PRODUCTION_ROLES with UNAUTHORIZED", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const kitchenCrew = await makeUser("KITCHEN_CREW");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();

    await expect(
      svc.start(
        { actorUserId: kitchenCrew.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    // No side effects from the rejected attempt.
    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("RELEASED");
  });

  it("outlet-scope denial: both STOCK_PRODUCTION_ROLES are HQ ALL-scope roles, so no reachable cross-outlet 403 exists for start() " +
    "(documented, mirrors the same finding in test/job-order-lifecycle.test.ts's role/session test)", async () => {
    // src/modules/auth/roles.ts's HQ_ALL_SCOPE_ROLES includes every role in
    // STOCK_PRODUCTION_ROLES (OWNER, WAREHOUSE_MAIN), so authorizeActor()
    // always resolves allowedLocationIds = null for any actor that can reach
    // startJobOrder() at all -- assertLocationInScope() is therefore never
    // able to reject a same-role actor on outlet grounds inside this module.
    // This test exists to document that finding rather than assert a
    // fictitious 403; see the cross-outlet employee SCOPE_MISMATCH case below
    // for the reachable "wrong outlet" failure this module actually has.
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);

    // Reachable "wrong outlet" case: the operator employee is scoped to a
    // different physical location than the Job Order -> SCOPE_MISMATCH, no
    // stock mutation.
    const otherLocation = await makeLocation();
    const crossOutletOperator = await makeEmployee({ locationId: otherLocation.id });
    const svc = jobService();

    await expect(
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: crossOutletOperator.id },
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });

    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("RELEASED");
  });

  it("rejects start() with a dead/expired session and with a session belonging to a different user", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { location, productionWarehouse } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const lot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const { draft, released } = await releaseFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id);
    const operator = await makeEmployee({ locationId: location.id });
    const svc = jobService();

    const deadSession = await makeSession(owner.id, false);
    await expect(
      svc.start(
        { actorUserId: owner.id, sessionId: deadSession.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const otherOwner = await makeUser("OWNER");
    const otherSession = await makeSession(otherOwner.id, true);
    await expect(
      svc.start(
        { actorUserId: owner.id, sessionId: otherSession.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    // No stock moved and job order untouched by either rejected attempt.
    expect(await lotBalance(productionWarehouse.id, lot.id)).toBe("10.000000");
    const [current] = await db.select().from(jobOrders).where(eq(jobOrders.id, draft.id));
    expect(current!.status).toBe("RELEASED");
  });
});
