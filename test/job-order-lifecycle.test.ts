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
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { employees, ingredients, locations, users, userSessions, warehouses, type Role } from "../src/db/schema.js";
import { StockProductionError } from "../src/modules/production/errors.js";
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
    .values({ code: `JOL-HQ-${suffix()}`, name: "JOL HQ" })
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
      name: `JOL User ${s}`,
      email: `jol-${s}@test.local`,
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
      code: `JOL-ITEM-${s}`,
      name: overrides.name ?? `JOL Item ${s}`,
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
    .values({ code: `JOL-LOC-${s}`, name: `JOL Location ${s}` })
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
      code: `JOL-WH-${s}`,
      name: `JOL Warehouse ${s}`,
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
      employeeNo: `JOL-EMP-${s}`,
      fullName: `JOL Employee ${s}`,
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
    { code: `JOL-BOM-${suffix()}`, name: "JOL Test BOM", outputItemId: outputItem.id },
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

async function seedComponentLot(itemId: string, warehouseId: string, onHand = "10.000000") {
  const s = suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode: `JOL-LOT-${s}`,
      status: "AVAILABLE",
      expiresAt: null,
      unitCost: "1.000000",
    })
    .returning();
  await db.insert(inventoryLotBalances).values({
    warehouseId,
    lotId: lot!.id,
    onHand,
    reserved: "0",
  });
  return lot!;
}

async function createDraftJobOrder(ownerId: string) {
  const { location, productionWarehouse } = await setupProductionLocation();
  const chicken = await makeItem("RAW", { unit: "kg" });
  const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
  const activeVersion = await createActiveBom(ownerId, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
  // start() FEFO-consumes components from the job's own PRODUCTION
  // warehouse, so an AVAILABLE non-expired lot with sufficient on-hand
  // balance must exist there for every test that reaches start().
  await seedComponentLot(chicken.id, productionWarehouse.id);
  const svc = jobService();
  const draft = await svc.createDraft(
    { actorUserId: ownerId },
    {
      jobOrderNo: `JOL-JO-${suffix()}`,
      bomVersionId: activeVersion.id,
      locationId: location.id,
      plannedOutputQty: "1.000000",
      plannedOutputUom: "kg",
    },
  );
  return { draft, location };
}

describe("Job Order lifecycle transitions", () => {
  it("runs the happy path: submit -> approve (different actor) -> release (documents created+linked) -> start (operator assigned)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { draft, location } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(owner.id);

    const approved = await svc.approve(
      { actorUserId: approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe(approver.id);

    const released = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );
    expect(released.status).toBe("RELEASED");
    expect(released.consumeDocumentId).toBeTruthy();
    expect(released.outputDocumentId).toBeTruthy();

    const consumeDoc = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_CONSUME"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    const outputDoc = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_OUTPUT"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    expect(consumeDoc).toHaveLength(1);
    expect(outputDoc).toHaveLength(1);
    expect(released.consumeDocumentId).toBe(consumeDoc[0]!.id);
    expect(released.outputDocumentId).toBe(outputDoc[0]!.id);

    const operator = await makeEmployee({ locationId: location.id });
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.operatorId).toBe(operator.id);
    expect(started.operatorAssignedAt).toBeTruthy();
  });

  it("rejects maker-checker violation: same actor cannot submit and approve", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );

    await expect(
      svc.approve({ actorUserId: owner.id }, { jobOrderId: draft.id, expectedVersion: submitted.version }),
    ).rejects.toMatchObject({ code: "SEGREGATION_OF_DUTIES", status: 409 });
  });

  it("enforces role, outlet-scope, and session checks", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const kitchenCrew = await makeUser("KITCHEN_CREW");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    // Wrong role.
    await expect(
      svc.submit({ actorUserId: kitchenCrew.id }, { jobOrderId: draft.id, expectedVersion: draft.version }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    // Note: both STOCK_PRODUCTION_ROLES (OWNER, WAREHOUSE_MAIN) are HQ_ALL_SCOPE_ROLES
    // (see src/modules/auth/roles.ts), so allowedLocationIds is always null for any
    // actor authorized to reach this module — there is no reachable "wrong outlet"
    // 403 case here, matching job-order-draft.test.ts which likewise only covers
    // role/session, not outlet scope.

    // Expired/logged-out session.
    const deadSession = await makeSession(owner.id, false);
    await expect(
      svc.submit(
        { actorUserId: owner.id, sessionId: deadSession.id },
        { jobOrderId: draft.id, expectedVersion: draft.version },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    // Session belonging to a different user.
    const otherOwner = await makeUser("OWNER");
    const otherSession = await makeSession(otherOwner.id, true);
    await expect(
      svc.submit(
        { actorUserId: owner.id, sessionId: otherSession.id },
        { jobOrderId: draft.id, expectedVersion: draft.version },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("rejects a stale expectedVersion with CONCURRENT_MODIFICATION", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    await expect(
      svc.submit({ actorUserId: owner.id }, { jobOrderId: draft.id, expectedVersion: draft.version + 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION", status: 409 });
  });

  it("rejects invalid transitions: approve a never-submitted DRAFT, release a SUBMITTED (not yet approved)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    await expect(
      svc.approve({ actorUserId: approver.id }, { jobOrderId: draft.id, expectedVersion: draft.version }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });

    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );

    await expect(
      svc.release({ actorUserId: approver.id }, { jobOrderId: draft.id, expectedVersion: submitted.version }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("release is idempotent on replay: calling twice returns the same linked documents with no duplicates", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    const approved = await svc.approve(
      { actorUserId: approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    const releasedFirst = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );
    // Replay: same expectedVersion argument as the first release call is
    // irrelevant here since release() skips the version check once RELEASED.
    const releasedSecond = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );

    expect(releasedSecond.consumeDocumentId).toBe(releasedFirst.consumeDocumentId);
    expect(releasedSecond.outputDocumentId).toBe(releasedFirst.outputDocumentId);
    expect(releasedSecond.version).toBe(releasedFirst.version);

    const consumeDocs = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_CONSUME"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    const outputDocs = await db
      .select()
      .from(operationalDocuments)
      .where(and(eq(operationalDocuments.module, "PRODUCTION_OUTPUT"), eq(operationalDocuments.documentNo, draft.jobOrderNo)));
    expect(consumeDocs).toHaveLength(1);
    expect(outputDocs).toHaveLength(1);
  });

  it("cancels a DRAFT with a reason, rejects a blank reason, and refuses cancel once IN_PROGRESS", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = jobService();

    // Cancel a DRAFT.
    const { draft: draftToCancel } = await createDraftJobOrder(owner.id);
    await expect(
      svc.cancel(
        { actorUserId: owner.id },
        { jobOrderId: draftToCancel.id, expectedVersion: draftToCancel.version, reason: "   " },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });

    const cancelled = await svc.cancel(
      { actorUserId: owner.id },
      { jobOrderId: draftToCancel.id, expectedVersion: draftToCancel.version, reason: "No longer needed" },
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelReason).toBe("No longer needed");

    // Cancel is refused once IN_PROGRESS.
    const { draft, location } = await createDraftJobOrder(owner.id);
    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    const approved = await svc.approve(
      { actorUserId: approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    const released = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );
    const operator = await makeEmployee({ locationId: location.id });
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );

    await expect(
      svc.cancel(
        { actorUserId: owner.id },
        { jobOrderId: started.id, expectedVersion: started.version, reason: "Too late" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("fails only from IN_PROGRESS: rejects failing a RELEASED job order, succeeds on IN_PROGRESS with reason", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = jobService();

    const { draft, location } = await createDraftJobOrder(owner.id);
    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    const approved = await svc.approve(
      { actorUserId: approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    const released = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );

    await expect(
      svc.fail({ actorUserId: owner.id }, { jobOrderId: released.id, expectedVersion: released.version, reason: "oops" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });

    const operator = await makeEmployee({ locationId: location.id });
    const started = await svc.start(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
    );

    const failed = await svc.fail(
      { actorUserId: owner.id },
      { jobOrderId: started.id, expectedVersion: started.version, reason: "Equipment malfunction" },
    );
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("Equipment malfunction");
  });

  it("start() validates operator employee: NOT_FOUND, inactive VALIDATION, cross-outlet SCOPE_MISMATCH", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const svc = jobService();

    const { draft, location } = await createDraftJobOrder(owner.id);
    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    const approved = await svc.approve(
      { actorUserId: approver.id },
      { jobOrderId: draft.id, expectedVersion: submitted.version },
    );
    const released = await svc.release(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: approved.version },
    );

    await expect(
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const inactiveEmployee = await makeEmployee({ locationId: location.id, status: "INACTIVE" });
    await expect(
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: inactiveEmployee.id },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });

    const otherLocation = await makeLocation();
    const crossOutletEmployee = await makeEmployee({ locationId: otherLocation.id });
    await expect(
      svc.start(
        { actorUserId: owner.id },
        { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: crossOutletEmployee.id },
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH", status: 409 });
  });

  it("keeps every transition dark until stock.production is enabled", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const { draft } = await createDraftJobOrder(owner.id);
    const svc = jobService();

    await setFlags(false);

    await expect(
      svc.submit({ actorUserId: owner.id }, { jobOrderId: draft.id, expectedVersion: draft.version }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });

    await setFlags(true);
    const submitted = await svc.submit(
      { actorUserId: owner.id },
      { jobOrderId: draft.id, expectedVersion: draft.version },
    );
    await setFlags(false);

    await expect(
      svc.approve({ actorUserId: approver.id }, { jobOrderId: draft.id, expectedVersion: submitted.version }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });

    await setFlags(true);
  });
});
