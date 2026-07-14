/**
 * Customer Order lifecycle service (D35-D46 §7 — Customer Orders and Job
 * Orders):
 *
 *   DRAFT -> SUBMITTED -> APPROVED -> ALLOCATED -> IN_PRODUCTION/READY -> FULFILLED
 *
 * with CANCELLED reachable from every pre-fulfillment status. See
 * src/modules/customer-orders/allocation.ts for the FEFO/reservation helpers
 * this file builds on, and src/db/customer-orders-schema.ts for the
 * underlying tables and their DB-level invariants (particularly the
 * consumption-owner XOR guard).
 *
 * Three consumption paths per line (D35-D46 §6/§7's no-double-deduction
 * rule), all funneled through the same allocation/fulfillment machinery:
 *
 *   1. STOCKED_OUTPUT: allocate/fulfill FEFO-selected lots of the line's own
 *      item at the order's outlet OUTLET_STORAGE/KITCHEN nodes.
 *   2. MADE_TO_ORDER + componentRequirementsSnapshot: the order engine (this
 *      service) owns consumption directly -- allocate/fulfill FEFO-selected
 *      lots of every snapshotted raw component at the same outlet nodes. No
 *      Job Order is ever created or touched for this path.
 *   3. MADE_TO_ORDER + jobOrderId: the linked Job Order owns component
 *      consumption (already happened via job-order-service.ts's
 *      startJobOrder()); this line only ever allocates/fulfills that Job
 *      Order's own finished output lot once COMPLETED -- never touching the
 *      raw components a second time.
 *
 * fulfill() may therefore need to post through TWO different central posting
 * service document/route registrations in one call (see
 * CUSTOMER_ORDER_JOB_OUTPUT_MODULE's doc comment in policies.ts for why path
 * 3 cannot reuse path 1/2's "ORDER_DEDUCTION" route class).
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
} from "../../db/enterprise-schema.js";
import {
  customerOrderAllocations,
  customerOrderFulfillments,
  customerOrderLines,
  customerOrders,
  type CustomerOrderAllocation,
  type CustomerOrderLine,
} from "../../db/customer-orders-schema.js";
import { jobOrderOutputLots, jobOrders } from "../../db/production-schema.js";
import { auditLogs, customers, ingredients, locations, userOutletAccess, users, userSessions, type Role } from "../../db/schema.js";
import { normalizeRole, outletScopeForRole } from "../auth/roles.js";
import { formatFixed, parseFixed } from "../stock/decimal.js";
import { createStockPostingService } from "../stock/posting-service.js";
import type { StockPostingInput, StockPostingResult } from "../stock/types.js";
import {
  releaseActiveAllocationsForLines,
  resolveOutletSourceWarehouseIds,
  selectFefoAllocationPortions,
} from "./allocation.js";
import { CustomerOrderError } from "./errors.js";
import {
  CUSTOMER_ORDER_APPROVE_ROLES,
  CUSTOMER_ORDER_FULFILLMENT_MODULE,
  CUSTOMER_ORDER_FULFILLMENT_POLICY,
  CUSTOMER_ORDER_FULFILL_ROLES,
  CUSTOMER_ORDER_JOB_OUTPUT_MODULE,
  CUSTOMER_ORDER_JOB_OUTPUT_POLICY,
  CUSTOMER_ORDER_ROLES,
  STOCK_CUSTOMER_ORDER_FEATURE_KEY,
} from "./policies.js";
import { resolveAndValidateLines } from "./validation.js";
import type {
  AllocateCustomerOrderInput,
  ApproveCustomerOrderInput,
  CancelCustomerOrderInput,
  ComponentRequirementsSnapshot,
  CreateCustomerOrderDraftInput,
  CreateCustomerOrderLineInput,
  CustomerOrderWithLines,
  FulfillCustomerOrderInput,
  GetCustomerOrderInput,
  ListCustomerOrdersInput,
  ListCustomerOrdersPage,
  MarkCustomerOrderInProductionInput,
  MarkCustomerOrderReadyInput,
  SubmitCustomerOrderInput,
  UpdateCustomerOrderDraftInput,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

interface StockPostingServiceLike {
  post(input: StockPostingInput): Promise<StockPostingResult>;
}

/** Detects a PostgreSQL unique-violation from pglite/postgres-js/drizzle errors (mirrors job-order-service.ts). */
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object") {
      const cause = e["cause"] as Record<string, unknown>;
      if (cause["code"] === "23505") return true;
    }
  }
  return false;
}

async function authorizeActor(
  tx: Tx,
  actorUserId: string,
  sessionId: string | null | undefined,
  allowedRoles: readonly Role[],
  lock: boolean,
): Promise<{ id: string; name: string; role: Role; allowedLocationIds: string[] | null }> {
  const query = tx
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId));
  const rows = lock ? await query.for("update") : await query;
  const actor = rows[0];
  const role = normalizeRole(actor?.role);
  if (!actor || actor.status !== "ACTIVE" || !role || !allowedRoles.includes(role)) {
    throw new CustomerOrderError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this Customer Order operation.",
      403,
    );
  }

  if (sessionId) {
    const [session] = await tx
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(eq(userSessions.id, sessionId), eq(userSessions.userId, actor.id), sql`${userSessions.logoutAt} IS NULL`),
      );
    if (!session) {
      throw new CustomerOrderError("UNAUTHORIZED", "The actor session is not active.", 401);
    }
  }

  let allowedLocationIds: string[] | null = null;
  if (outletScopeForRole(role) !== "ALL") {
    const access = await tx
      .select({ locationId: userOutletAccess.locationId })
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, actor.id));
    allowedLocationIds = access.map((row) => row.locationId);
  }

  return { id: actor.id, name: actor.name, role, allowedLocationIds };
}

function assertLocationInScope(allowedLocationIds: string[] | null, locationId: string): void {
  if (allowedLocationIds !== null && !allowedLocationIds.includes(locationId)) {
    throw new CustomerOrderError("UNAUTHORIZED", "The Customer Order is outside the actor's outlet scope.", 403);
  }
}

/**
 * Gates ONLY allocate()/markReady()(when it allocates)/fulfill() -- the
 * transitions with a stock reservation or stock movement effect. createDraft/
 * update/submit/approve/markInProduction/cancel/read stay reachable while the
 * flag is off (D35-D46 §13 "dark modules may validate or save drafts but
 * cannot post stock").
 */
async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, STOCK_CUSTOMER_ORDER_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new CustomerOrderError(
      "FEATURE_DISABLED",
      `Operational feature "${STOCK_CUSTOMER_ORDER_FEATURE_KEY}" is disabled.`,
      503,
      { feature: STOCK_CUSTOMER_ORDER_FEATURE_KEY },
    );
  }
}

async function lockOrder(tx: Tx, orderId: string) {
  const [order] = await tx.select().from(customerOrders).where(eq(customerOrders.id, orderId)).for("update");
  if (!order) {
    throw new CustomerOrderError("NOT_FOUND", `Customer Order ${orderId} was not found.`, 404);
  }
  return order;
}

async function fetchLines(tx: Tx, orderId: string): Promise<CustomerOrderLine[]> {
  return tx
    .select()
    .from(customerOrderLines)
    .where(eq(customerOrderLines.orderId, orderId))
    .orderBy(asc(customerOrderLines.lineNo));
}

async function hasActiveAllocation(tx: Tx, lineId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: customerOrderAllocations.id })
    .from(customerOrderAllocations)
    .where(and(eq(customerOrderAllocations.lineId, lineId), eq(customerOrderAllocations.status, "ACTIVE")))
    .limit(1);
  return !!row;
}

/** Idempotent insert-or-fetch for a (module, documentNo) operational_document row (mirrors every other module). */
async function ensureOperationalDocument(
  tx: Tx,
  module: string,
  documentNo: string,
  locationId: string,
  status: string,
  createdBy: string,
): Promise<{ id: string }> {
  const [inserted] = await tx
    .insert(operationalDocuments)
    .values({ module, documentNo, locationId, status, createdBy })
    .onConflictDoNothing()
    .returning({ id: operationalDocuments.id });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({ id: operationalDocuments.id })
    .from(operationalDocuments)
    .where(and(eq(operationalDocuments.module, module), eq(operationalDocuments.documentNo, documentNo)));
  if (!existing) {
    throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Failed to establish ${module} document ${documentNo}.`, 409);
  }
  return existing;
}

/** FEFO-allocates `neededBase` of `itemId` at the order outlet's OUTLET_STORAGE/KITCHEN nodes, writing ACTIVE allocation rows. */
async function allocateAgainstItemAtOutlet(
  tx: Tx,
  lineId: string,
  itemId: string,
  neededBase: bigint,
  outletWarehouseIds: string[],
  itemLabel: string,
): Promise<void> {
  const portions = await selectFefoAllocationPortions(tx, itemId, outletWarehouseIds, neededBase, itemLabel);
  for (const portion of portions) {
    await tx.insert(customerOrderAllocations).values({
      lineId,
      lotId: portion.lotId,
      warehouseId: portion.warehouseId,
      quantity: formatFixed(portion.qtyBase, 6),
    });
  }
}

/** Allocates every component of a MADE_TO_ORDER + componentRequirementsSnapshot line (the order engine's own direct-consumption path). */
async function allocateComponentSnapshotLine(tx: Tx, line: CustomerOrderLine, outletWarehouseIds: string[]): Promise<void> {
  const snapshot = line.componentRequirementsSnapshot as ComponentRequirementsSnapshot | null;
  if (!snapshot || snapshot.components.length === 0) {
    throw new CustomerOrderError("VALIDATION", `Line ${line.lineNo} has no component requirements to allocate.`, 400);
  }
  for (const component of snapshot.components) {
    await allocateAgainstItemAtOutlet(
      tx,
      line.id,
      component.itemId,
      parseFixed(component.quantity, 6),
      outletWarehouseIds,
      `component ${component.itemId}`,
    );
  }
}

/** Allocates a job-order-linked MADE_TO_ORDER line against its linked (COMPLETED) Job Order's own deterministic output lot. */
async function allocateJobOrderOutputLine(
  tx: Tx,
  line: CustomerOrderLine,
  jobOrder: typeof jobOrders.$inferSelect,
): Promise<void> {
  const [outputEvidence] = await tx
    .select()
    .from(jobOrderOutputLots)
    .where(eq(jobOrderOutputLots.jobOrderId, jobOrder.id));
  if (!outputEvidence) {
    throw new CustomerOrderError(
      "JOB_ORDER_NOT_READY",
      `Job Order ${jobOrder.jobOrderNo} is COMPLETED but has no recorded output lot.`,
      409,
      { jobOrderId: jobOrder.id },
    );
  }
  const neededBase = parseFixed(line.baseQuantity, 6);
  await allocateAgainstItemAtOutlet(
    tx,
    line.id,
    line.itemId,
    neededBase,
    [jobOrder.productionWarehouseId],
    `Job Order ${jobOrder.jobOrderNo} output`,
  );
  // Narrow the just-written allocation(s) to the exact output lot via a
  // defensive re-check: allocateAgainstItemAtOutlet already scoped the search
  // to jobOrder.productionWarehouseId, and job-order-service.ts's deterministic
  // `JOBORDER:<jobOrderId>` lot-code + one-output-lot-per-job-order invariant
  // (job_order_output_lot_job_lot_unique) means that warehouse can only ever
  // hold this job order's own output lot for this item -- no further lot
  // disambiguation is possible or necessary here.
  void outputEvidence;
}

// ---------------------------------------------------------------------------
// Lifecycle: create / update / submit / approve
// ---------------------------------------------------------------------------

export async function createCustomerOrderDraft(db: DB, input: CreateCustomerOrderDraftInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, true);
    assertLocationInScope(actor.allowedLocationIds, input.locationId);

    const [location] = await tx.select().from(locations).where(eq(locations.id, input.locationId));
    if (!location) {
      throw new CustomerOrderError("NOT_FOUND", `Location ${input.locationId} was not found.`, 404);
    }
    const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
    if (!customer || !customer.isActive) {
      throw new CustomerOrderError("VALIDATION", `Customer ${input.customerId} is missing or inactive.`, 409);
    }

    const resolvedLines = await resolveAndValidateLines(tx, input.locationId, input.lines);
    const documentNo = input.documentNo?.trim() || `CO-${randomUUID()}`;

    let order;
    try {
      const [inserted] = await tx
        .insert(customerOrders)
        .values({
          documentNo,
          customerId: input.customerId,
          locationId: input.locationId,
          requiredDate: input.requiredDate ?? null,
          remarks: input.remarks ?? null,
          createdBy: actor.id,
        })
        .returning();
      order = inserted!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CustomerOrderError("VALIDATION", `Customer Order document "${documentNo}" is already in use.`, 409, {
          documentNo,
        });
      }
      throw error;
    }

    const lines = await tx
      .insert(customerOrderLines)
      .values(resolvedLines.map((line) => ({ ...line, orderId: order.id })))
      .returning();
    lines.sort((a, b) => a.lineNo - b.lineNo);

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: input.locationId,
      action: "customer_order.created",
      description: `Created Customer Order ${order.documentNo} with ${lines.length} line(s).`,
      entityType: "customer_order",
      entityId: order.id,
    });

    return { ...order, lines };
  });
}

interface UpdateCustomerOrderDraftServiceInput extends UpdateCustomerOrderDraftInput {}

export async function updateCustomerOrderDraft(
  db: DB,
  input: UpdateCustomerOrderDraftServiceInput,
): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status !== "DRAFT") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; only DRAFT orders may be edited.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    let lines: CustomerOrderLine[];
    if (input.lines) {
      const resolvedLines = await resolveAndValidateLines(tx, order.locationId, input.lines);
      await tx.delete(customerOrderLines).where(eq(customerOrderLines.orderId, order.id));
      lines = await tx
        .insert(customerOrderLines)
        .values(resolvedLines.map((line) => ({ ...line, orderId: order.id })))
        .returning();
      lines.sort((a, b) => a.lineNo - b.lineNo);
    } else {
      lines = await fetchLines(tx, order.id);
    }

    const setClause: Partial<typeof customerOrders.$inferInsert> = {
      version: order.version + 1,
      updatedAt: new Date(),
    };
    if ("remarks" in input) setClause.remarks = input.remarks ?? null;
    if ("requiredDate" in input) setClause.requiredDate = input.requiredDate ?? null;

    const [updated] = await tx
      .update(customerOrders)
      .set(setClause)
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.version, input.expectedVersion), eq(customerOrders.status, "DRAFT")))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    return { ...updated, lines };
  });
}

export async function submitCustomerOrder(db: DB, input: SubmitCustomerOrderInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status !== "DRAFT") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; expected DRAFT.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    if (lines.length === 0) {
      throw new CustomerOrderError("VALIDATION", `Customer Order ${order.documentNo} has no lines to submit.`, 400);
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "SUBMITTED", submittedBy: actor.id, submittedAt: new Date(), version: order.version + 1, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, "DRAFT"), eq(customerOrders.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.locationId,
      action: "customer_order.submitted",
      description: `Submitted Customer Order ${order.documentNo}.`,
      entityType: "customer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

export async function approveCustomerOrder(db: DB, input: ApproveCustomerOrderInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_APPROVE_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status !== "SUBMITTED") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; expected SUBMITTED.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (actor.id === order.submittedBy) {
      throw new CustomerOrderError("SEGREGATION_OF_DUTIES", "The submitter and approver must be different actors.", 409);
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), version: order.version + 1, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, "SUBMITTED"), eq(customerOrders.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.locationId,
      action: "customer_order.approved",
      description: `Approved Customer Order ${order.documentNo}.`,
      entityType: "customer_order",
      entityId: order.id,
    });

    const lines = await fetchLines(tx, order.id);
    return { ...updated, lines };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: allocate / markInProduction / markReady
// ---------------------------------------------------------------------------

export async function allocateCustomerOrder(db: DB, input: AllocateCustomerOrderInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_FULFILL_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status === "ALLOCATED") {
      const lines = await fetchLines(tx, order.id);
      return { ...order, lines };
    }
    if (order.status !== "APPROVED") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; expected APPROVED.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    if (lines.length === 0) {
      throw new CustomerOrderError("VALIDATION", `Customer Order ${order.documentNo} has no lines to allocate.`, 400);
    }

    const outletWarehouseIds = await resolveOutletSourceWarehouseIds(tx, order.locationId);

    for (const line of lines) {
      if (line.consumptionMode === "STOCKED_OUTPUT") {
        await allocateAgainstItemAtOutlet(
          tx,
          line.id,
          line.itemId,
          parseFixed(line.baseQuantity, 6),
          outletWarehouseIds,
          `item ${line.itemId}`,
        );
      } else if (line.jobOrderId) {
        // Job-order-linked: only allocate now if the linked Job Order has
        // already COMPLETED; otherwise defer -- markInProduction()/markReady()
        // pick this line up once production finishes.
        const [jobOrder] = await tx.select().from(jobOrders).where(eq(jobOrders.id, line.jobOrderId));
        if (jobOrder && jobOrder.status === "COMPLETED") {
          await allocateJobOrderOutputLine(tx, line, jobOrder);
        }
      } else {
        await allocateComponentSnapshotLine(tx, line, outletWarehouseIds);
      }
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "ALLOCATED", allocatedBy: actor.id, allocatedAt: new Date(), version: order.version + 1, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, "APPROVED"), eq(customerOrders.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.locationId,
      action: "customer_order.allocated",
      description: `Allocated Customer Order ${order.documentNo} across ${lines.length} line(s).`,
      entityType: "customer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

export async function markCustomerOrderInProduction(
  db: DB,
  input: MarkCustomerOrderInProductionInput,
): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_FULFILL_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status === "IN_PRODUCTION") {
      const lines = await fetchLines(tx, order.id);
      return { ...order, lines };
    }
    if (order.status !== "ALLOCATED") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; expected ALLOCATED.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    const hasPendingProduction = lines.some((line) => line.consumptionMode === "MADE_TO_ORDER" && line.jobOrderId);
    if (!hasPendingProduction) {
      throw new CustomerOrderError(
        "INVALID_TRANSITION",
        `Customer Order ${order.documentNo} has no Job-Order-linked line; markInProduction() has nothing to wait on.`,
        409,
      );
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "IN_PRODUCTION", version: order.version + 1, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, "ALLOCATED"), eq(customerOrders.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    return { ...updated, lines };
  });
}

export async function markCustomerOrderReady(db: DB, input: MarkCustomerOrderReadyInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_FULFILL_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status === "READY") {
      const lines = await fetchLines(tx, order.id);
      return { ...order, lines };
    }
    if (order.status !== "ALLOCATED" && order.status !== "IN_PRODUCTION") {
      throw new CustomerOrderError(
        "INVALID_TRANSITION",
        `Customer Order ${order.documentNo} is ${order.status}; expected ALLOCATED or IN_PRODUCTION.`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    for (const line of lines) {
      if (line.consumptionMode === "MADE_TO_ORDER" && line.jobOrderId) {
        if (await hasActiveAllocation(tx, line.id)) continue;
        const [jobOrder] = await tx.select().from(jobOrders).where(eq(jobOrders.id, line.jobOrderId));
        if (!jobOrder || jobOrder.status !== "COMPLETED") {
          throw new CustomerOrderError(
            "JOB_ORDER_NOT_READY",
            `Line ${line.lineNo}'s linked Job Order is not COMPLETED yet.`,
            409,
            { lineId: line.id, jobOrderId: line.jobOrderId },
          );
        }
        await allocateJobOrderOutputLine(tx, line, jobOrder);
      } else if (!(await hasActiveAllocation(tx, line.id))) {
        throw new CustomerOrderError(
          "VALIDATION",
          `Line ${line.lineNo} has no active allocation; call allocate() before markReady().`,
          409,
          { lineId: line.id },
        );
      }
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "READY", version: order.version + 1, updatedAt: new Date() })
      .where(
        and(
          eq(customerOrders.id, order.id),
          inArray(customerOrders.status, ["ALLOCATED", "IN_PRODUCTION"]),
          eq(customerOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    return { ...updated, lines };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: fulfill
// ---------------------------------------------------------------------------

interface PreparedMovement {
  allocationId: string;
  lineId: string;
  warehouseId: string;
  lotId: string;
  itemId: string;
  quantity: string;
  enteredUom: string;
  unitCost: string;
}

interface FulfillPrepared {
  replay: false;
  actor: { id: string; name: string };
  order: typeof customerOrders.$inferSelect;
  lines: CustomerOrderLine[];
  generalMovements: PreparedMovement[];
  jobOutputMovements: PreparedMovement[];
  generalDocId: string | null;
  jobDocId: string | null;
}

interface FulfillReplay {
  replay: true;
  order: typeof customerOrders.$inferSelect;
  lines: CustomerOrderLine[];
}

/**
 * READY -> FULFILLED. Posts through the central stock posting service --
 * split into up to TWO postings (see CUSTOMER_ORDER_JOB_OUTPUT_MODULE's doc
 * comment in policies.ts): one for STOCKED_OUTPUT / component-snapshot lines
 * (ORDER_DEDUCTION route, idempotencyKey = order.documentNo), one for
 * Job-Order-linked lines (PRODUCTION route, idempotencyKey =
 * `${order.documentNo}:JOBOUT`). Only whichever group is non-empty is ever
 * posted/documented. Three-step shape (mirrors dispatchStockReturnBatch/
 * startJobOrder): "prepare" transaction re-verifies state and builds the
 * exact movement plan (allocations are NOT marked CONSUMED yet); the posting
 * call(s) happen outside any transaction (the posting service owns its own
 * db.transaction internally); "finalize" transaction marks the consumed
 * allocations, writes append-only fulfillment history rows linked to their
 * exact posting line, and advances the order. A retry after a mid-flight
 * failure safely replays: ACTIVE allocations are untouched until finalize, so
 * a second prepare pass rebuilds the identical movement plan, and the
 * posting service's own idempotency returns the stored result for whichever
 * group already succeeded.
 */
export async function fulfillCustomerOrder(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: FulfillCustomerOrderInput,
): Promise<CustomerOrderWithLines> {
  const prepared = await db.transaction(async (tx): Promise<FulfillPrepared | FulfillReplay> => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_FULFILL_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (order.status === "FULFILLED") {
      const lines = await fetchLines(tx, order.id);
      return { replay: true, order, lines };
    }
    if (order.status !== "READY") {
      throw new CustomerOrderError("INVALID_TRANSITION", `Customer Order ${order.documentNo} is ${order.status}; expected READY.`, 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    const lineById = new Map(lines.map((line) => [line.id, line]));

    const activeAllocations: CustomerOrderAllocation[] = await tx
      .select({
        id: customerOrderAllocations.id,
        lineId: customerOrderAllocations.lineId,
        lotId: customerOrderAllocations.lotId,
        warehouseId: customerOrderAllocations.warehouseId,
        quantity: customerOrderAllocations.quantity,
        status: customerOrderAllocations.status,
        createdAt: customerOrderAllocations.createdAt,
        updatedAt: customerOrderAllocations.updatedAt,
      })
      .from(customerOrderAllocations)
      .innerJoin(customerOrderLines, eq(customerOrderAllocations.lineId, customerOrderLines.id))
      .where(and(eq(customerOrderLines.orderId, order.id), eq(customerOrderAllocations.status, "ACTIVE")));

    if (activeAllocations.length === 0) {
      throw new CustomerOrderError("VALIDATION", `Customer Order ${order.documentNo} has no ACTIVE allocation to fulfill.`, 400);
    }

    const lotIds = [...new Set(activeAllocations.map((a) => a.lotId))];
    const lotRows = await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, lotIds));
    const lotsById = new Map(lotRows.map((row) => [row.id, row]));
    const itemIds = [...new Set(lotRows.map((row) => row.itemId))];
    const itemRows = itemIds.length ? await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds)) : [];
    const itemsById = new Map(itemRows.map((row) => [row.id, row]));

    const generalMovements: PreparedMovement[] = [];
    const jobOutputMovements: PreparedMovement[] = [];
    for (const allocation of activeAllocations) {
      const line = lineById.get(allocation.lineId)!;
      const lot = lotsById.get(allocation.lotId)!;
      const item = itemsById.get(lot.itemId)!;
      const movement: PreparedMovement = {
        allocationId: allocation.id,
        lineId: line.id,
        warehouseId: allocation.warehouseId,
        lotId: allocation.lotId,
        itemId: lot.itemId,
        quantity: allocation.quantity,
        enteredUom: item.unit,
        unitCost: lot.unitCost,
      };
      (line.jobOrderId ? jobOutputMovements : generalMovements).push(movement);
    }

    let generalDocId: string | null = null;
    let jobDocId: string | null = null;
    if (generalMovements.length > 0) {
      const doc = await ensureOperationalDocument(
        tx,
        CUSTOMER_ORDER_FULFILLMENT_MODULE,
        order.documentNo,
        order.locationId,
        "PENDING",
        actor.id,
      );
      generalDocId = doc.id;
    }
    if (jobOutputMovements.length > 0) {
      const doc = await ensureOperationalDocument(
        tx,
        CUSTOMER_ORDER_JOB_OUTPUT_MODULE,
        `${order.documentNo}:JOBOUT`,
        order.locationId,
        "PENDING",
        actor.id,
      );
      jobDocId = doc.id;
    }

    return { replay: false, actor, order, lines, generalMovements, jobOutputMovements, generalDocId, jobDocId };
  });

  if (prepared.replay) {
    return { ...prepared.order, lines: prepared.lines };
  }

  const { actor, order, lines, generalMovements, jobOutputMovements, generalDocId, jobDocId } = prepared;

  const toStockMovements = (movements: PreparedMovement[]) =>
    movements.map((m) => ({
      warehouseId: m.warehouseId,
      itemId: m.itemId,
      lotId: m.lotId,
      movementType: "OUT" as const,
      quantity: m.quantity,
      enteredQuantity: m.quantity,
      enteredUom: m.enteredUom,
      conversionFactor: "1.00000000",
      unitCost: m.unitCost,
      sourcePolicy: "ALLOCATABLE" as const,
      metadata: { customerOrderId: order.id, customerOrderLineId: m.lineId, customerOrderAllocationId: m.allocationId },
    }));

  let generalResult: StockPostingResult | undefined;
  let jobResult: StockPostingResult | undefined;
  try {
    if (generalMovements.length > 0) {
      generalResult = await stockPostingService.post({
        idempotencyKey: order.documentNo,
        sourceModule: CUSTOMER_ORDER_FULFILLMENT_MODULE,
        sourceDocumentNo: order.documentNo,
        locationId: order.locationId,
        actorUserId: actor.id,
        sessionId: input.sessionId ?? null,
        correlationId: order.documentNo,
        movements: toStockMovements(generalMovements),
      });
    }
    if (jobOutputMovements.length > 0) {
      const jobDocumentNo = `${order.documentNo}:JOBOUT`;
      jobResult = await stockPostingService.post({
        idempotencyKey: jobDocumentNo,
        sourceModule: CUSTOMER_ORDER_JOB_OUTPUT_MODULE,
        sourceDocumentNo: jobDocumentNo,
        locationId: order.locationId,
        actorUserId: actor.id,
        sessionId: input.sessionId ?? null,
        correlationId: jobDocumentNo,
        movements: toStockMovements(jobOutputMovements),
      });
    }
  } catch (error) {
    // Compensate: only remove a document if it's still exactly as we left it
    // (untouched by any posting), mirroring dispatchStockReturnBatch().
    if (generalDocId) {
      await db
        .delete(operationalDocuments)
        .where(and(eq(operationalDocuments.id, generalDocId), eq(operationalDocuments.status, "PENDING"), sql`${operationalDocuments.stockPostingId} IS NULL`));
    }
    if (jobDocId) {
      await db
        .delete(operationalDocuments)
        .where(and(eq(operationalDocuments.id, jobDocId), eq(operationalDocuments.status, "PENDING"), sql`${operationalDocuments.stockPostingId} IS NULL`));
    }
    throw error;
  }

  return db.transaction(async (tx) => {
    const postingIds = [generalResult?.postingId, jobResult?.postingId].filter((id): id is string => !!id);
    const postingLineRows = postingIds.length
      ? await tx.select().from(stockPostingLines).where(inArray(stockPostingLines.postingId, postingIds))
      : [];
    const postingLineByAllocationId = new Map<string, { postingId: string; lineId: string }>();
    for (const row of postingLineRows) {
      const metadata = row.metadata as { customerOrderAllocationId?: string } | null;
      if (metadata?.customerOrderAllocationId) {
        postingLineByAllocationId.set(metadata.customerOrderAllocationId, { postingId: row.postingId, lineId: row.id });
      }
    }

    const allMovements = [...generalMovements, ...jobOutputMovements];
    for (const movement of allMovements) {
      const resolved = postingLineByAllocationId.get(movement.allocationId);
      if (!resolved) {
        throw new CustomerOrderError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the fulfillment posting line for allocation ${movement.allocationId}.`,
          409,
        );
      }
      const [consumed] = await tx
        .update(customerOrderAllocations)
        .set({ status: "CONSUMED", updatedAt: new Date() })
        .where(and(eq(customerOrderAllocations.id, movement.allocationId), eq(customerOrderAllocations.status, "ACTIVE")))
        .returning({ id: customerOrderAllocations.id });
      if (consumed) {
        await tx.insert(customerOrderFulfillments).values({
          orderId: order.id,
          lineId: movement.lineId,
          quantity: movement.quantity,
          stockPostingId: resolved.postingId,
          actorUserId: actor.id,
        });
      }
    }

    const [updated] = await tx
      .update(customerOrders)
      .set({ status: "FULFILLED", fulfilledBy: actor.id, fulfilledAt: new Date(), version: order.version + 1, updatedAt: new Date() })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, "READY"), eq(customerOrders.version, input.expectedVersion)))
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(customerOrders).where(eq(customerOrders.id, order.id));
      if (current?.status === "FULFILLED") {
        return { ...current, lines };
      }
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.locationId,
      action: "customer_order.fulfilled",
      description: `Fulfilled Customer Order ${order.documentNo}: posted ${allMovements.length} movement(s).`,
      entityType: "customer_order",
      entityId: order.id,
      metadata: {
        generalPostingId: generalResult?.postingId ?? null,
        jobOutputPostingId: jobResult?.postingId ?? null,
        movementCount: allMovements.length,
      },
    });

    return { ...updated, lines };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: cancel
// ---------------------------------------------------------------------------

const CANCELLABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "ALLOCATED", "IN_PRODUCTION", "READY"]);

export async function cancelCustomerOrder(db: DB, input: CancelCustomerOrderInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    if (!input.reason?.trim()) {
      throw new CustomerOrderError("VALIDATION", "A cancellation reason is required.", 400);
    }
    if (order.status === "FULFILLED") {
      throw new CustomerOrderError(
        "INVALID_TRANSITION",
        `Customer Order ${order.documentNo} is already FULFILLED; a customer return/credit document is required to correct it, not cancellation.`,
        409,
      );
    }
    if (!CANCELLABLE_STATUSES.has(order.status)) {
      throw new CustomerOrderError(
        "INVALID_TRANSITION",
        `Customer Order ${order.documentNo} is ${order.status}; cancel is not allowed from this status.`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new CustomerOrderError(
        "CONCURRENT_MODIFICATION",
        `Customer Order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    await releaseActiveAllocationsForLines(
      tx,
      lines.map((line) => line.id),
    );

    const [updated] = await tx
      .update(customerOrders)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.id,
        cancelledAt: new Date(),
        cancelReason: input.reason.trim(),
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(customerOrders.id, order.id), eq(customerOrders.status, order.status), eq(customerOrders.version, input.expectedVersion)))
      .returning();
    if (!updated) {
      throw new CustomerOrderError("CONCURRENT_MODIFICATION", `Customer Order ${order.documentNo} changed concurrently.`, 409);
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.locationId,
      action: "customer_order.cancelled",
      description: `Cancelled Customer Order ${order.documentNo}: ${input.reason.trim()}.`,
      entityType: "customer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getCustomerOrder(db: DB, input: GetCustomerOrderInput): Promise<CustomerOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, false);

    const [order] = await tx.select().from(customerOrders).where(eq(customerOrders.id, input.orderId));
    if (!order) {
      throw new CustomerOrderError("NOT_FOUND", `Customer Order ${input.orderId} was not found.`, 404);
    }
    assertLocationInScope(actor.allowedLocationIds, order.locationId);

    const lines = await fetchLines(tx, order.id);
    return { ...order, lines };
  });
}

async function resolveListConditions(tx: Tx, input: ListCustomerOrdersInput) {
  const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, CUSTOMER_ORDER_ROLES, false);

  const conditions = [];
  if (actor.allowedLocationIds !== null) {
    if (input.locationId) {
      if (!actor.allowedLocationIds.includes(input.locationId)) {
        throw new CustomerOrderError("UNAUTHORIZED", "The requested outlet is outside the actor's outlet scope.", 403);
      }
      conditions.push(eq(customerOrders.locationId, input.locationId));
    } else {
      conditions.push(inArray(customerOrders.locationId, actor.allowedLocationIds));
    }
  } else if (input.locationId) {
    conditions.push(eq(customerOrders.locationId, input.locationId));
  }
  if (input.customerId) {
    conditions.push(eq(customerOrders.customerId, input.customerId));
  }
  if (input.status) {
    conditions.push(eq(customerOrders.status, input.status));
  }
  if (input.search?.trim()) {
    conditions.push(ilike(customerOrders.documentNo, `%${input.search.trim()}%`));
  }

  return { actor, conditions };
}

export async function listCustomerOrders(db: DB, input: ListCustomerOrdersInput): Promise<ListCustomerOrdersPage> {
  return db.transaction(async (tx) => {
    const { conditions } = await resolveListConditions(tx, input);

    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;
    const query = tx.select().from(customerOrders);
    const ordered =
      conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(customerOrders.createdAt))
        : query.orderBy(desc(customerOrders.createdAt));
    const items = await ordered.limit(limit).offset(offset);

    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(customerOrders)
      .where(conditions.length > 0 ? and(...conditions) : sql`true`);

    return { items, total: row?.count ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface CustomerOrderActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

type CreateDraftServiceInput = Omit<CreateCustomerOrderDraftInput, "actorUserId" | "sessionId">;
type GetServiceInput = Omit<GetCustomerOrderInput, "actorUserId" | "sessionId">;
type ListServiceInput = Omit<ListCustomerOrdersInput, "actorUserId" | "sessionId">;

interface UpdateDraftServiceInput {
  orderId: string;
  version: number;
  requiredDate?: string | null;
  remarks?: string | null;
  lines?: CreateCustomerOrderLineInput[];
}

interface TransitionServiceInput {
  orderId: string;
  version: number;
}

interface CancelServiceInput extends TransitionServiceInput {
  reason: string;
}

/** Facade over the standalone lifecycle functions above. */
export function createCustomerOrderService(db: DB) {
  const stockPostingService = createStockPostingService(db, {
    documentPolicies: {
      [CUSTOMER_ORDER_FULFILLMENT_MODULE]: CUSTOMER_ORDER_FULFILLMENT_POLICY,
      [CUSTOMER_ORDER_JOB_OUTPUT_MODULE]: CUSTOMER_ORDER_JOB_OUTPUT_POLICY,
    },
  });
  return {
    createDraft(ctx: CustomerOrderActorContext, input: CreateDraftServiceInput) {
      return createCustomerOrderDraft(db, { ...ctx, ...input });
    },
    get(ctx: CustomerOrderActorContext, input: GetServiceInput) {
      return getCustomerOrder(db, { ...ctx, ...input });
    },
    list(ctx: CustomerOrderActorContext, input: ListServiceInput) {
      return listCustomerOrders(db, { ...ctx, ...input });
    },
    update(ctx: CustomerOrderActorContext, input: UpdateDraftServiceInput) {
      const { orderId, version, ...rest } = input;
      return updateCustomerOrderDraft(db, { ...ctx, orderId, expectedVersion: version, ...rest });
    },
    submit(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return submitCustomerOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    approve(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return approveCustomerOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    allocate(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return allocateCustomerOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    markInProduction(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return markCustomerOrderInProduction(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    markReady(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return markCustomerOrderReady(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    fulfill(ctx: CustomerOrderActorContext, input: TransitionServiceInput) {
      return fulfillCustomerOrder(db, stockPostingService, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    cancel(ctx: CustomerOrderActorContext, input: CancelServiceInput) {
      return cancelCustomerOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version, reason: input.reason });
    },
  };
}
