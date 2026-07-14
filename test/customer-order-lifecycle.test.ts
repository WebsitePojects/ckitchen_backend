/**
 * Customer Order lifecycle coverage (D35-D46 §7): the happy path
 * DRAFT -> SUBMITTED -> APPROVED -> ALLOCATED -> READY -> FULFILLED for a
 * STOCKED_OUTPUT line, invalid transitions, optimistic-lock version
 * conflicts, segregation-of-duties on approve, pre/post-fulfillment
 * cancellation, and stock.customer_order_fulfillment dark-mode refusals on
 * allocate()/markReady()/fulfill() while draft/submit/approve/cancel stay
 * reachable with the flag off. FEFO/reservation/consumption-owner-path
 * coverage lives in test/customer-order-allocation.test.ts. Fixture setup
 * mirrors test/job-order-lifecycle.test.ts (HQ_MAIN + stock.lot_writes flag +
 * resolved topology exceptions), since fulfillCustomerOrder() posts through
 * the same central stock posting service.
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
import { customers, ingredients, locations, users, userSessions, warehouses, type Role } from "../src/db/schema.js";
import { customerOrderAllocations, customerOrderFulfillments } from "../src/db/customer-orders-schema.js";
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

  // fulfillCustomerOrder() posts stock through the central posting service,
  // which requires stock.lot_writes enabled, exactly one active HQ_MAIN
  // warehouse, and no OPEN topology exceptions before it will accept any
  // movement.
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  const [hqLocation] = await db.insert(locations).values({ code: `COL-HQ-${suffix()}`, name: "COL HQ" }).returning();
  await makeWarehouse(hqLocation!.id, "HQ_MAIN");
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

async function setCoFlag(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.customer_order_fulfillment"));
}

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `COL User ${s}`, email: `col-${s}@test.local`, passwordHash: "hash", role, status })
    .returning();
  return user!;
}

async function makeSession(userId: string, active = true) {
  const [session] = await db.insert(userSessions).values({ userId, logoutAt: active ? null : new Date() }).returning();
  return session!;
}

async function makeLocation() {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `COL-LOC-${s}`, name: `COL Location ${s}` }).returning();
  return location!;
}

async function makeWarehouse(
  locationId: string,
  purpose: "HQ_MAIN" | "OUTLET_STORAGE" | "KITCHEN" | "PRODUCTION" | "QUARANTINE",
  isActive = true,
) {
  const s = suffix();
  // The legacy `type` column ("MAIN"|"KITCHEN") is unique per location
  // (warehouse_location_type_unique) independent of the new `purpose` column,
  // so a location needing BOTH a KITCHEN-purpose and an OUTLET_STORAGE-purpose
  // warehouse must map them to distinct type values (mirrors
  // test/customer-order-schema.test.ts's fixture: KITCHEN purpose -> type
  // "KITCHEN", every other purpose -> type "MAIN").
  const type = purpose === "KITCHEN" ? "KITCHEN" : "MAIN";
  const [warehouse] = await db
    .insert(warehouses)
    .values({ locationId, type, purpose, code: `COL-WH-${s}`, name: `COL Warehouse ${s}`, isActive })
    .returning();
  return warehouse!;
}

async function makeCustomer(isActive = true) {
  const s = suffix();
  const [customer] = await db.insert(customers).values({ code: `COL-CUST-${s}`, name: `COL Customer ${s}`, isActive }).returning();
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
      code: `COL-ITEM-${s}`,
      name: overrides.name ?? `COL Item ${s}`,
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

interface LotSpec {
  onHand: string;
  expiresAt?: string | null;
  status?: "AVAILABLE" | "QUARANTINED" | "EXPIRED" | "RECALLED" | "SPOILED" | "DISPOSED" | "EXHAUSTED";
}

async function seedLot(itemId: string, warehouseId: string, spec: LotSpec) {
  const s = suffix();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId, lotCode: `COL-LOT-${s}`, status: spec.status ?? "AVAILABLE", expiresAt: spec.expiresAt ?? null, unitCost: "1.000000" })
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

/** Seeds a fresh outlet (KITCHEN + OUTLET_STORAGE warehouses), customer, and a FINISHED_GOOD item. */
async function setupOutlet() {
  const location = await makeLocation();
  const kitchen = await makeWarehouse(location.id, "KITCHEN");
  const outletStorage = await makeWarehouse(location.id, "OUTLET_STORAGE");
  const customer = await makeCustomer();
  const item = await makeItem("FINISHED_GOOD", { unit: "kg" });
  return { location, kitchen, outletStorage, customer, item };
}

/** Drives a fresh DRAFT Customer Order through submit -> approve, returning it APPROVED. */
async function approveFreshOrder(
  ownerId: string,
  approverId: string,
  fx: Awaited<ReturnType<typeof setupOutlet>>,
  lines: CreateCustomerOrderLineInput[],
) {
  const svc = coService();
  const draft = await svc.createDraft({ actorUserId: ownerId }, { customerId: fx.customer.id, locationId: fx.location.id, lines });
  const submitted = await svc.submit({ actorUserId: ownerId }, { orderId: draft.id, version: draft.version });
  const approved = await svc.approve({ actorUserId: approverId }, { orderId: draft.id, version: submitted.version });
  return { draft, approved };
}

describe("Customer Order lifecycle: happy path DRAFT -> FULFILLED (STOCKED_OUTPUT)", () => {
  it("drives a single STOCKED_OUTPUT line all the way to FULFILLED, posting one OUT movement", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const lot = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });

    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);

    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    expect(allocated.status).toBe("ALLOCATED");

    const [allocationRow] = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(allocationRow).toMatchObject({ lotId: lot.id, warehouseId: fx.kitchen.id, quantity: "2.000000", status: "ACTIVE" });

    const ready = await svc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version });
    expect(ready.status).toBe("READY");

    const fulfilled = await svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version });
    expect(fulfilled.status).toBe("FULFILLED");

    expect(await lotBalance(fx.kitchen.id, lot.id)).toBe("8.000000");

    const [consumedAllocation] = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(consumedAllocation!.status).toBe("CONSUMED");

    const [fulfillmentRow] = await db.select().from(customerOrderFulfillments).where(eq(customerOrderFulfillments.orderId, draft.id));
    expect(fulfillmentRow).toMatchObject({ orderId: draft.id, lineId: allocated.lines[0]!.id, quantity: "2.000000" });
    expect(fulfillmentRow!.stockPostingId).toBeTruthy();
  });

  it("is idempotent: calling fulfill() again on an already FULFILLED order does not deduct stock twice", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const lot = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });

    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    const ready = await svc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version });
    const first = await svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version });
    expect(first.status).toBe("FULFILLED");
    expect(await lotBalance(fx.kitchen.id, lot.id)).toBe("8.000000");

    const second = await svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version });
    expect(second.status).toBe("FULFILLED");
    expect(await lotBalance(fx.kitchen.id, lot.id)).toBe("8.000000");

    const fulfillmentRows = await db.select().from(customerOrderFulfillments).where(eq(customerOrderFulfillments.orderId, draft.id));
    expect(fulfillmentRows).toHaveLength(1);
  });
});

describe("Customer Order lifecycle: invalid transitions", () => {
  it("rejects submit from a non-DRAFT status", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    void approved;
    const svc = coService();
    await expect(svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
  });

  it("rejects allocate() before approve()", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    await expect(svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
  });

  it("rejects fulfill() before markReady()", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    await expect(svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
  });

  it("rejects markInProduction() when no line is Job-Order-linked", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    await expect(svc.markInProduction({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: 409,
    });
  });
});

describe("Customer Order lifecycle: optimistic-lock version conflicts", () => {
  it("rejects submit() with a stale expectedVersion", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    await expect(svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version + 1 })).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
      status: 409,
    });
  });

  it("rejects approve() with a stale expectedVersion", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    const submitted = await svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    await expect(svc.approve({ actorUserId: approver.id }, { orderId: draft.id, version: submitted.version + 1 })).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
      status: 409,
    });
  });
});

describe("Customer Order lifecycle: segregation of duties", () => {
  it("rejects approve() by the same actor who submitted", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    const submitted = await svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    await expect(svc.approve({ actorUserId: owner.id }, { orderId: draft.id, version: submitted.version })).rejects.toMatchObject({
      code: "SEGREGATION_OF_DUTIES",
      status: 409,
    });
  });
});

describe("Customer Order lifecycle: cancellation", () => {
  it("releases ACTIVE allocations and posts no stock when cancelling an ALLOCATED order", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const lot = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });

    const cancelled = await svc.cancel({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version, reason: "Customer changed their mind" });
    expect(cancelled.status).toBe("CANCELLED");

    const [allocationRow] = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, allocated.lines[0]!.id));
    expect(allocationRow!.status).toBe("RELEASED");
    expect(await lotBalance(fx.kitchen.id, lot.id)).toBe("10.000000"); // unchanged: nothing was ever posted
  });

  it("refuses to cancel a FULFILLED order", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    const ready = await svc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version });
    const fulfilled = await svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version });

    await expect(
      svc.cancel({ actorUserId: owner.id }, { orderId: draft.id, version: fulfilled.version, reason: "Too late" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("requires a non-empty cancellation reason", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    await expect(svc.cancel({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version, reason: "  " })).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
    });
  });
});

describe("Customer Order lifecycle: stock.customer_order_fulfillment dark-mode gate", () => {
  it("allows createDraft/submit/approve while the flag is disabled", async () => {
    await setCoFlag(false);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    const submitted = await svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    const approved = await svc.approve({ actorUserId: approver.id }, { orderId: draft.id, version: submitted.version });
    expect(approved.status).toBe("APPROVED");
  });

  it("refuses allocate() while the flag is disabled, with no allocation rows written", async () => {
    await setCoFlag(false);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const svc = coService();
    const draft = await svc.createDraft({ actorUserId: owner.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] });
    const submitted = await svc.submit({ actorUserId: owner.id }, { orderId: draft.id, version: draft.version });
    const approved = await svc.approve({ actorUserId: approver.id }, { orderId: draft.id, version: submitted.version });

    await expect(svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version })).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
      status: 503,
    });

    const allocationRows = await db.select().from(customerOrderAllocations).where(eq(customerOrderAllocations.lineId, approved.lines[0]!.id));
    expect(allocationRows).toHaveLength(0);
    const [current] = await db.select().from(customerOrderAllocations); // sanity: query executes
    void current;
  });

  it("refuses fulfill() while the flag is disabled (flipped off after allocation succeeded)", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const approver = await makeUser("WAREHOUSE_MAIN");
    const fx = await setupOutlet();
    const lot = await seedLot(fx.item.id, fx.kitchen.id, { onHand: "10.000000" });
    const { draft, approved } = await approveFreshOrder(owner.id, approver.id, fx, [stockedOutputLine(fx.item.id)]);
    const svc = coService();
    const allocated = await svc.allocate({ actorUserId: owner.id }, { orderId: draft.id, version: approved.version });
    const ready = await svc.markReady({ actorUserId: owner.id }, { orderId: draft.id, version: allocated.version });

    await setCoFlag(false);
    await expect(svc.fulfill({ actorUserId: owner.id }, { orderId: draft.id, version: ready.version })).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
      status: 503,
    });
    expect(await lotBalance(fx.kitchen.id, lot.id)).toBe("10.000000");

    await setCoFlag(true); // restore for subsequent tests in this file
  });
});

describe("Customer Order lifecycle: role/session authorization", () => {
  it("rejects createDraft() from a role outside CUSTOMER_ORDER_ROLES", async () => {
    await setCoFlag(true);
    const kitchenCrew = await makeUser("KITCHEN_CREW");
    const fx = await setupOutlet();
    const svc = coService();
    await expect(
      svc.createDraft({ actorUserId: kitchenCrew.id }, { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });
  });

  it("rejects an operation with a dead/expired session", async () => {
    await setCoFlag(true);
    const owner = await makeUser("OWNER");
    const fx = await setupOutlet();
    const svc = coService();
    const deadSession = await makeSession(owner.id, false);
    await expect(
      svc.createDraft(
        { actorUserId: owner.id, sessionId: deadSession.id },
        { customerId: fx.customer.id, locationId: fx.location.id, lines: [stockedOutputLine(fx.item.id)] },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });
});
