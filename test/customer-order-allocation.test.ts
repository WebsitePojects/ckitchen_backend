/**
 * Customer Order allocation coverage (D35-D46 §4/§6/§7): FEFO ordering
 * (including expiry tie-breaks and excluded lot statuses), reserved-stock
 * respect across concurrent orders, insufficient-stock all-or-nothing
 * behavior, both MADE_TO_ORDER consumption-owner paths (component snapshot
 * vs linked Job Order), and the no-double-deduction proof: once a Job Order
 * has produced its output lot, a linked Customer Order's fulfillment consumes
 * ONLY that output lot -- the raw components the Job Order already consumed
 * are never touched again. Basic lifecycle/transition/dark-mode coverage
 * lives in test/customer-order-lifecycle.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLotBalances,
  inventoryLots,
  operationalFeatureFlags,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { customers, employees, ingredients, locations, users, warehouses, type Role } from "../src/db/schema.js";
import { customerOrderAllocations } from "../src/db/customer-orders-schema.js";
import { createBomService } from "../src/modules/production/service.js";
import { createJobOrderService } from "../src/modules/production/job-order-service.js";
import type { BomVersion } from "../src/modules/production/types.js";
import { createCustomerOrderService } from "../src/modules/customer-orders/service.js";
import type { CreateCustomerOrderLineInput } from "../src/modules/customer-orders/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  const [hqLocation] = await db.insert(locations).values({ code: `COA-HQ-${suffix()}`, name: "COA HQ" }).returning();
  await makeWarehouse(hqLocation!.id, "HQ_MAIN");
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.production"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.customer_order_fulfillment"));
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `COA User ${s}`, email: `coa-${s}@test.local`, passwordHash: "hash", role, status })
    .returning();
  return user!;
}

async function makeLocation() {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `COA-LOC-${s}`, name: `COA Location ${s}` }).returning();
  return location!;
}

async function makeWarehouse(
  locationId: string,
  purpose: "HQ_MAIN" | "OUTLET_STORAGE" | "KITCHEN" | "PRODUCTION" | "QUARANTINE",
  isActive = true,
) {
  const s = suffix();
  // warehouse_location_type_unique makes the legacy `type` column unique per
  // location independent of `purpose`; map KITCHEN purpose -> type "KITCHEN"
  // so a location needing both a KITCHEN and an OUTLET_STORAGE/PRODUCTION
  // warehouse never collides (mirrors test/customer-order-schema.test.ts's fixture).
  const type = purpose === "KITCHEN" ? "KITCHEN" : "MAIN";
  const [warehouse] = await db
    .insert(warehouses)
    .values({ locationId, type, purpose, code: `COA-WH-${s}`, name: `COA Warehouse ${s}`, isActive })
    .returning();
  return warehouse!;
}

async function makeCustomer() {
  const s = suffix();
  const [customer] = await db.insert(customers).values({ code: `COA-CUST-${s}`, name: `COA Customer ${s}` }).returning();
  return customer!;
}

async function makeItem(
  itemType: "RAW" | "WIP" | "FINISHED_GOOD" | "CONSUMABLE" | "PACKAGING" | "SERVICE",
  overrides: Partial<{ unit: string; isActive: boolean; name: string }> = {},
) {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `COA-ITEM-${s}`,
      name: overrides.name ?? `COA Item ${s}`,
      unit: overrides.unit ?? "kg",
      itemType,
      lotTracked: false,
      isActive: overrides.isActive ?? true,
      unitCost: "1.000000",
      lowStockThreshold: "0.0000",
    })
    .returning();
  return item!;
}

async function makeEmployee(locationId: string) {
  const s = suffix();
  const [employee] = await db
    .insert(employees)
    .values({ employeeNo: `COA-EMP-${s}`, fullName: `COA Employee ${s}`, department: "KITCHEN", status: "ACTIVE", locationId })
    .returning();
  return employee!;
}

interface LotSpec {
  onHand: string;
  expiresAt?: string | null;
  status?: "AVAILABLE" | "QUARANTINED" | "EXPIRED" | "RECALLED" | "SPOILED" | "DISPOSED" | "EXHAUSTED";
  lotCodeSuffix?: string;
}

async function seedLot(itemId: string, warehouseId: string, spec: LotSpec) {
  const s = spec.lotCodeSuffix ?? suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId, lotCode: `COA-LOT-${s}`, status: spec.status ?? "AVAILABLE", expiresAt: spec.expiresAt ?? null, unitCost: "1.000000" })
    .returning();
  await db.insert(inventoryLotBalances).values({ warehouseId, lotId: lot!.id, onHand: spec.onHand, reserved: "0" });
  return lot!;
}

async function lotBalance(warehouseId: string, lotId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row!.onHand;
}

function coService() {
  return createCustomerOrderService(db);
}

function jobService() {
  return createJobOrderService(db);
}

function bomService() {
  return createBomService(db);
}

function stockedOutputLine(itemId: string, overrides: Partial<CreateCustomerOrderLineInput> = {}): CreateCustomerOrderLineInput {
  return {
    itemId,
    enteredUom: "kg",
    enteredQuantity: "2.000000",
    unitPrice: "100.000000",
    consumptionMode: "STOCKED_OUTPUT",
    ...overrides,
  };
}

async function setupOutlet() {
  const location = await makeLocation();
  const kitchen = await makeWarehouse(location.id, "KITCHEN");
  const outletStorage = await makeWarehouse(location.id, "OUTLET_STORAGE");
  const customer = await makeCustomer();
  const item = await makeItem("FINISHED_GOOD", { unit: "kg" });
  return { location, kitchen, outletStorage, customer, item };
}

async function approveFreshOrder(
  ownerId: string,
  approverId: string,
  fx: { location: { id: string }; customer: { id: string } },
  lines: CreateCustomerOrderLineInput[],
) {
  const svc = coService();
  const draft = await svc.createDraft({ actorUserId: ownerId }, { customerId: fx.customer.id, locationId: fx.location.id, lines });
  const submitted = await svc.submit({ actorUserId: ownerId }, { orderId: draft.id, version: draft.version });
  const approved = await svc.approve({ actorUserId: approverId }, { orderId: draft.id, version: submitted.version });
  return { draft, approved };
}

describe("Customer Order allocation: FEFO ordering", () => {
  it("drains the earlier-expiry lot first, splitting across two AVAILABLE lots", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const lotA = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "1.000000", expiresAt: "2030-01-01" });
    const lotB = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "5.000000", expiresAt: "2031-01-01" });

    // Need 2kg total: 1kg from lot A (earlier expiry, drained) + 1kg from lot B.
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    expect(allocated.status).toBe("ALLOCATED");

    const rows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(rows).toHaveLength(2);
    const byLot = new Map(rows.map((r) => [r.lotId, r]));
    expect(byLot.get(lotA.id)!.quantity).toBe("1.000000");
    expect(byLot.get(lotB.id)!.quantity).toBe("1.000000");
  });

  it("breaks an expiry tie by lot code", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    // Same expiry; lotCodeSuffix controls the deterministic tie-break order (lower code first).
    const lotFirst = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "1.000000", expiresAt: "2030-06-01", lotCodeSuffix: "0-aaa" });
    const lotSecond = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "5.000000", expiresAt: "2030-06-01", lotCodeSuffix: "1-zzz" });

    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });

    const rows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    const byLot = new Map(rows.map((r) => [r.lotId, r]));
    expect(byLot.get(lotFirst.id)!.quantity).toBe("1.000000"); // fully drained first (lexically-earlier lot code)
    expect(byLot.get(lotSecond.id)!.quantity).toBe("1.000000"); // remainder
  });

  it("skips a QUARANTINED lot and an EXPIRED-status lot even with ample on-hand, consuming a valid lot instead", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const quarantined = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "100.000000", status: "QUARANTINED" });
    const expiredStatus = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "100.000000", status: "EXPIRED" });
    const pastDate = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "100.000000", expiresAt: "2020-01-01" });
    const valid = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "2.000000" });

    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });

    const rows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lotId).toBe(valid.id);
    expect(await lotBalance(fx.kitchen.id, quarantined.id)).toBe("100.000000");
    expect(await lotBalance(fx.kitchen.id, expiredStatus.id)).toBe("100.000000");
    expect(await lotBalance(fx.kitchen.id, pastDate.id)).toBe("100.000000");
  });
});

describe("Customer Order allocation: reserved-stock respect across orders", () => {
  it("a second order cannot allocate stock already ACTIVE-reserved by a first order's allocation", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "2.000000" }); // exactly enough for ONE order's 2kg line

    const svc = coService();
    const { draft: draft1, approved: approved1 } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const allocated1 = await svc.allocate({ actorUserId: owner.id }, { orderId: draft1.id, version: approved1.version });
    expect(allocated1.status).toBe("ALLOCATED");

    const { draft: draft2, approved: approved2 } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    await expect(svc.allocate({ actorUserId: owner.id }, { orderId: draft2.id, version: approved2.version })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      status: 409,
    });

    // Second order's allocate() must have written NOTHING (all-or-nothing).
    const draft2Lines = await svc.get({ actorUserId: owner.id }, { orderId: draft2.id });
    const rows2 = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, draft2Lines.lines[0]!.id));
    expect(rows2).toHaveLength(0);
    const [draft2Current] = await db.select().from(customerOrderAllocations); // sanity query executes without error
    void draft2Current;
  });
});

describe("Customer Order allocation: insufficient stock is all-or-nothing", () => {
  it("rejects allocate() entirely when the line's needed quantity exceeds available stock, leaving no allocation rows", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "0.500000" }); // line needs 2kg

    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();

    await expect(svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      status: 409,
    });

    const current = await svc.get({ actorUserId: owner.id }, { orderId: draft.id });
    expect(current.status).toBe("APPROVED"); // never advanced to ALLOCATED
    const rows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, current.lines[0]!.id));
    expect(rows).toHaveLength(0);
  });
});

describe("Customer Order allocation: MADE_TO_ORDER consumption-owner paths", () => {
  it("allocates every snapshotted component's OWN item for a componentRequirementsSnapshot line (not the line's own item)", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    await seedLot(chicken.id, fx.kitchen.id, { onHand: "5.000000" });
    await seedLot(salt.id, fx.kitchen.id, { onHand: "5.000000" });

    const line: CreateCustomerOrderLineInput = {
      itemId: fx.item.id,
      enteredUom: "kg",
      enteredQuantity: "1.000000",
      unitPrice: "150.000000",
      consumptionMode: "MADE_TO_ORDER",
      componentRequirementsSnapshot: {
        components: [
          { itemId: chicken.id, quantity: "1.000000" },
          { itemId: salt.id, quantity: "0.050000" },
        ],
      },
    };
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [line]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    expect(allocated.status).toBe("ALLOCATED");

    const rows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(rows).toHaveLength(2);
    const lotIds = rows.map((r) => r.lotId);
    const lots = await db.select().from(inventoryLots).where(and(eq(inventoryLots.id, lotIds[0]!)));
    void lots; // (existence already implied by FK; itemId cross-check below)

    const byItemQty = new Map<string, string>();
    for (const row of rows) {
      const [lot] = await db.select().from(inventoryLots).where(eq(inventoryLots.id, row.lotId));
      byItemQty.set(lot!.itemId, row.quantity);
    }
    expect(byItemQty.get(chicken.id)).toBe("1.000000");
    expect(byItemQty.get(salt.id)).toBe("0.050000");
    // The line's OWN item (fx.item, a FINISHED_GOOD) is never itself allocated for this path.
    expect([...byItemQty.keys()]).not.toContain(fx.item.id);
  });
});

/** BOM + Job Order helpers (mirrors test/job-order-consumption.test.ts). */
interface ComponentSpec {
  item: { id: string };
  qty: string;
  uom: string;
}

async function createActiveBom(
  ownerId: string,
  outputItem: { id: string },
  componentSpecs: ComponentSpec[],
  outputYieldQty = "1.000000",
  outputUom = "kg",
): Promise<BomVersion> {
  const svc = bomService();
  const header = await svc.createHeader({ actorUserId: ownerId }, { code: `COA-BOM-${suffix()}`, name: "COA Test BOM", outputItemId: outputItem.id });
  const version = await svc.createDraftVersion({ actorUserId: ownerId }, { bomHeaderId: header.id, outputUom, outputYieldQty, effectiveFrom: "2026-01-01" });
  await svc.replaceDraftComponents({
    actorUserId: ownerId,
  }, {
    bomVersionId: version.id,
    lines: componentSpecs.map((c) => ({ componentItemId: c.item.id, enteredQuantity: c.qty, enteredUom: c.uom })),
  });
  return svc.activateVersion({ actorUserId: ownerId }, { bomVersionId: version.id });
}

async function completeFreshJobOrder(
  ownerId: string,
  approverId: string,
  bomVersionId: string,
  locationId: string,
  productionWarehouseId: string,
  plannedOutputQty = "1.000000",
) {
  const svc = jobService();
  const draft = await svc.createDraft(
    { actorUserId: ownerId },
    { jobOrderNo: `COA-JO-${suffix()}`, bomVersionId, locationId, plannedOutputQty, plannedOutputUom: "kg" },
  );
  const submitted = await svc.submit({ actorUserId: ownerId }, { jobOrderId: draft.id, expectedVersion: draft.version });
  const approved = await svc.approve({ actorUserId: approverId }, { jobOrderId: draft.id, expectedVersion: submitted.version });
  const released = await svc.release({ actorUserId: ownerId }, { jobOrderId: draft.id, expectedVersion: approved.version });
  const operator = await makeEmployee(locationId);
  const started = await svc.start(
    { actorUserId: ownerId },
    { jobOrderId: draft.id, expectedVersion: released.version, operatorEmployeeId: operator.id },
  );
  const completed = await svc.complete(
    { actorUserId: ownerId },
    { jobOrderId: draft.id, expectedVersion: started.version, actualOutputQty: plannedOutputQty },
  );
  void productionWarehouseId;
  return completed;
}

describe("Customer Order allocation: job-order-linked MADE_TO_ORDER path + no-double-deduction", () => {
  it("allocates and fulfills a job-order-linked line against the Job Order's own output lot only, leaving raw components untouched by the Customer Order", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const location = await makeLocation();
    const productionWarehouse = await makeWarehouse(location.id, "PRODUCTION");
    const kitchen = await makeWarehouse(location.id, "KITCHEN");
    const customer = await makeCustomer();

    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const roastChicken = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Roast Chicken" });

    const chickenLot = await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });
    const saltLot = await seedLot(salt.id, productionWarehouse.id, { onHand: "10.000000" });

    const activeVersion = await createActiveBom(
      owner.id,
      roastChicken,
      [
        { item: chicken, qty: "1.000000", uom: "kg" },
        { item: salt, qty: "0.050000", uom: "kg" },
      ],
      "1.000000",
      "kg",
    );

    const completedJobOrder = await completeFreshJobOrder(owner.id, approver.id, activeVersion.id, location.id, productionWarehouse.id, "1.000000");
    expect(completedJobOrder.status).toBe("COMPLETED");

    // Job Order consumption already happened: chicken/salt are down by the BOM's exact amounts.
    const chickenAfterProduction = await lotBalance(productionWarehouse.id, chickenLot.id);
    const saltAfterProduction = await lotBalance(productionWarehouse.id, saltLot.id);
    expect(chickenAfterProduction).toBe("9.000000");
    expect(saltAfterProduction).toBe("9.950000");

    // Now place a Customer Order at the SAME outlet for 1kg of roast chicken, linked to that Job Order.
    const line: CreateCustomerOrderLineInput = {
      itemId: roastChicken.id,
      enteredUom: "kg",
      enteredQuantity: "1.000000",
      unitPrice: "300.000000",
      consumptionMode: "MADE_TO_ORDER",
      jobOrderId: completedJobOrder.id,
    };
    const coSvc = coService();
    const draft = await coSvc.createDraft({ actorUserId: owner.id }, { customerId: customer.id, locationId: location.id, lines: [line] });
    const submitted = await coSvc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    const approved = await coSvc.approve({ actorUserId: approver.id }, { orderId: draft.id, version: submitted.version });
    const allocated = await coSvc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    expect(allocated.status).toBe("ALLOCATED");

    const allocationRows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(allocationRows).toHaveLength(1);
    expect(allocationRows[0]!.warehouseId).toBe(productionWarehouse.id);

    const ready = await coSvc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version });
    expect(ready.status).toBe("READY");
    const fulfilled = await coSvc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version });
    expect(fulfilled.status).toBe("FULFILLED");

    // No-double-deduction proof: raw component balances are EXACTLY what they
    // were right after production completed -- the Customer Order's
    // fulfillment never re-touched chicken/salt.
    expect(await lotBalance(productionWarehouse.id, chickenLot.id)).toBe(chickenAfterProduction);
    expect(await lotBalance(productionWarehouse.id, saltLot.id)).toBe(saltAfterProduction);

    // The output lot itself (the ONLY thing the Customer Order deducted) is now fully consumed.
    const outputLotRows = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.sourceDocumentId, completedJobOrder.id), eq(inventoryLots.sourceDocumentType, "JOB_ORDER_OUTPUT")));
    expect(outputLotRows).toHaveLength(1);
    expect(await lotBalance(productionWarehouse.id, outputLotRows[0]!.id)).toBe("0.000000");

    void kitchen; // kitchen warehouse exists at this outlet but is unused by the job-order-output path
  });

  it("markReady() allocates a job-order-linked line only once its Job Order reaches COMPLETED, refusing with JOB_ORDER_NOT_READY before then", async () => {
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const location = await makeLocation();
    const productionWarehouse = await makeWarehouse(location.id, "PRODUCTION");
    const customer = await makeCustomer();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const roastChicken = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Roast Chicken 2" });
    await seedLot(chicken.id, productionWarehouse.id, { onHand: "10.000000" });

    const activeVersion = await createActiveBom(owner.id, roastChicken, [{ item: chicken, qty: "1.000000", uom: "kg" }]);

    // Create the Job Order but only take it to RELEASED (not started/completed).
    const jobSvc = jobService();
    const jobDraft = await jobSvc.createDraft(
      { actorUserId: owner.id },
      { jobOrderNo: `COA-JO-${suffix()}`, bomVersionId: activeVersion.id, locationId: location.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
    );
    const jobSubmitted = await jobSvc.submit({ actorUserId: owner.id }, { jobOrderId: jobDraft.id, expectedVersion: jobDraft.version });
    const jobApproved = await jobSvc.approve({ actorUserId: approver.id }, { jobOrderId: jobDraft.id, expectedVersion: jobSubmitted.version });
    await jobSvc.release({ actorUserId: owner.id }, { jobOrderId: jobDraft.id, expectedVersion: jobApproved.version });

    const line: CreateCustomerOrderLineInput = {
      itemId: roastChicken.id,
      enteredUom: "kg",
      enteredQuantity: "1.000000",
      unitPrice: "300.000000",
      consumptionMode: "MADE_TO_ORDER",
      jobOrderId: jobDraft.id,
    };
    const coSvc = coService();
    const draft = await coSvc.createDraft({ actorUserId: owner.id }, { customerId: customer.id, locationId: location.id, lines: [line] });
    const submitted = await coSvc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    const approved = await coSvc.approve({ actorUserId: approver.id }, { orderId: draft.id, version: submitted.version });

    // allocate() succeeds (moves to ALLOCATED) but deliberately does NOT
    // allocate this still-not-COMPLETED job-order-linked line.
    const allocated = await coSvc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    expect(allocated.status).toBe("ALLOCATED");
    const preAllocationRows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(preAllocationRows).toHaveLength(0);

    await expect(coSvc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version })).rejects.toMatchObject({
      code: "JOB_ORDER_NOT_READY",
      status: 409,
    });
  });
});
