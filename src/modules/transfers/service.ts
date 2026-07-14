/**
 * HQ Transfer Order service: create/update/submit/approve/cancel/read plus
 * the dispatch and receive stock posting phases, both routed through the
 * central src/modules/stock/posting-service.ts against the order's own
 * dispatch/receipt operational_document rows (transfer-orders-schema.ts's
 * `dispatchDocumentId`/`receiptDocumentId` columns — set once, never
 * repointed). Architectural template: src/modules/stock-returns/service.ts
 * (closest two-phase stock document in this codebase), adapted for a
 * single-document-per-phase shape rather than returns' extra header-linked
 * document pair, per this module's own schema doc comment (see
 * src/db/transfer-orders-schema.ts).
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLotBalances,
  inventoryLots,
  itemUomConversions,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
} from "../../db/enterprise-schema.js";
import { auditLogs, ingredients, userOutletAccess, users, userSessions, warehouses } from "../../db/schema.js";
import type { Role } from "../../db/schema.js";
import { transferOrderLines, transferOrders } from "../../db/transfer-orders-schema.js";
import { normalizeRole, outletScopeForRole } from "../auth/roles.js";
import { DecimalValidationError, formatFixed, multiplyFixedExact, normalizeFixed, parseFixed } from "../stock/decimal.js";
import { createStockPostingService } from "../stock/posting-service.js";
import type { StockPostingInput, StockPostingResult } from "../stock/types.js";
import { TransferOrderError } from "./errors.js";
import {
  TRANSFER_ALLOWED_ROUTE_PAIRS,
  TRANSFER_APPROVE_ROLES,
  TRANSFER_DISPATCH_ROLES,
  TRANSFER_FEATURE_KEY,
  TRANSFER_MAX_LINES,
  TRANSFER_MIN_LINES,
  TRANSFER_ORDER_DISPATCH_MODULE,
  TRANSFER_ORDER_DISPATCH_POLICY,
  TRANSFER_ORDER_RECEIPT_MODULE,
  TRANSFER_ORDER_RECEIPT_POLICY,
  TRANSFER_RECEIVE_ROLES,
  TRANSFER_ROLES,
} from "./policies.js";
import type {
  ApproveTransferOrderInput,
  CancelTransferOrderInput,
  CreateTransferOrderInput,
  DispatchTransferOrderInput,
  GetTransferOrderInput,
  ListTransferOrdersInput,
  ReceiveTransferOrderInput,
  SubmitTransferOrderInput,
  TransferOrder,
  TransferOrderLine,
  TransferOrderLineInput,
  TransferOrderReceiptLineInput,
  TransferOrderWithLines,
  UpdateTransferOrderInput,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type WarehouseRow = typeof warehouses.$inferSelect;

interface ResolvedLine {
  lineNo: number;
  itemId: string;
  lotId: string | null;
  enteredUom: string;
  enteredQuantity: string;
  conversionFactor: string;
  baseQuantity: string;
  remarks: string | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function manilaDate(): string {
  // Asia/Manila has no DST and is fixed UTC+08:00.
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    throw new TransferOrderError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this transfer order operation.",
      403,
    );
  }

  if (sessionId) {
    const [session] = await tx
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.id, sessionId),
          eq(userSessions.userId, actor.id),
          sql`${userSessions.logoutAt} IS NULL`,
        ),
      );
    if (!session) {
      throw new TransferOrderError("UNAUTHORIZED", "The actor session is not active.", 401);
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
    throw new TransferOrderError(
      "UNAUTHORIZED",
      "The transfer order is outside the actor's outlet scope.",
      403,
    );
  }
}

async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, TRANSFER_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new TransferOrderError(
      "FEATURE_DISABLED",
      `Operational feature "${TRANSFER_FEATURE_KEY}" is disabled.`,
      503,
      { feature: TRANSFER_FEATURE_KEY },
    );
  }
}

/**
 * Validates the (source, destination) warehouse pair against D35-D46 §2's
 * route table (TRANSFER_ALLOWED_ROUTE_PAIRS) — the service-level check the
 * schema's own header comment says a DB CHECK constraint cannot express.
 */
async function resolveHeaderRoute(
  tx: Tx,
  sourceWarehouseId: string,
  destinationWarehouseId: string,
): Promise<{ source: WarehouseRow; destination: WarehouseRow }> {
  if (sourceWarehouseId === destinationWarehouseId) {
    throw new TransferOrderError(
      "VALIDATION",
      "Source and destination warehouse must be different.",
      400,
    );
  }
  const rows = await tx
    .select()
    .from(warehouses)
    .where(inArray(warehouses.id, [sourceWarehouseId, destinationWarehouseId]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const source = byId.get(sourceWarehouseId);
  const destination = byId.get(destinationWarehouseId);
  if (!source || !source.isActive) {
    throw new TransferOrderError(
      "VALIDATION",
      `Source warehouse ${sourceWarehouseId} is missing or inactive.`,
      400,
    );
  }
  if (!destination || !destination.isActive) {
    throw new TransferOrderError(
      "VALIDATION",
      `Destination warehouse ${destinationWarehouseId} is missing or inactive.`,
      400,
    );
  }
  const pairKey = `${source.purpose ?? ""}:${destination.purpose ?? ""}`;
  if (!TRANSFER_ALLOWED_ROUTE_PAIRS.has(pairKey)) {
    throw new TransferOrderError(
      "ROUTE_NOT_ALLOWED",
      `Transfer route ${source.purpose ?? "UNKNOWN"} -> ${destination.purpose ?? "UNKNOWN"} is not permitted.`,
      409,
      { sourcePurpose: source.purpose, destinationPurpose: destination.purpose },
    );
  }
  return { source, destination };
}

async function resolveAndValidateLines(tx: Tx, lines: TransferOrderLineInput[]): Promise<ResolvedLine[]> {
  if (lines.length < TRANSFER_MIN_LINES || lines.length > TRANSFER_MAX_LINES) {
    throw new TransferOrderError(
      "VALIDATION",
      `A transfer order must contain between ${TRANSFER_MIN_LINES} and ${TRANSFER_MAX_LINES} line(s).`,
      400,
    );
  }

  const seenLots = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.enteredUom.trim()) {
      throw new TransferOrderError("VALIDATION", `Line ${index + 1} is missing an entered UOM.`, 400);
    }
    if (line.lotId) {
      if (seenLots.has(line.lotId)) {
        throw new TransferOrderError(
          "DUPLICATE_LINE",
          `Duplicate pinned lot ${line.lotId} across lines.`,
          400,
          { lotId: line.lotId },
        );
      }
      seenLots.add(line.lotId);
    }
    try {
      if (parseFixed(line.enteredQuantity, 6) <= 0n) {
        throw new TransferOrderError("VALIDATION", `Line ${index + 1} quantity must be positive.`, 400);
      }
    } catch (error) {
      if (error instanceof TransferOrderError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new TransferOrderError("VALIDATION", `Line ${index + 1}: ${error.message}`, 400);
      }
      throw error;
    }
  });

  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));
  for (const itemId of itemIds) {
    const item = itemsById.get(itemId);
    if (!item || !item.isActive) {
      throw new TransferOrderError("VALIDATION", `Item ${itemId} is missing or inactive.`, 409);
    }
  }

  const conversionByKey = new Map<string, string>();
  const conversionKeys = [
    ...new Set(lines.map((line) => `${line.itemId}:${line.enteredUom.trim().toLowerCase()}`)),
  ];
  for (const conversionKey of conversionKeys) {
    const separator = conversionKey.indexOf(":");
    const itemId = conversionKey.slice(0, separator);
    const enteredUom = conversionKey.slice(separator + 1);
    const item = itemsById.get(itemId)!;
    if (item.unit.trim().toLowerCase() === enteredUom) {
      conversionByKey.set(conversionKey, "1.00000000");
      continue;
    }
    const [conversion] = await tx
      .select()
      .from(itemUomConversions)
      .where(
        and(
          eq(itemUomConversions.itemId, itemId),
          sql`lower(${itemUomConversions.fromUom}) = ${enteredUom}`,
          eq(itemUomConversions.isActive, true),
        ),
      );
    if (!conversion) {
      throw new TransferOrderError(
        "UOM_MISMATCH",
        `No active ${enteredUom} conversion exists for item ${itemId}.`,
        409,
      );
    }
    conversionByKey.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  const lotIds = [...new Set(lines.filter((line) => line.lotId).map((line) => line.lotId!))];
  const lotRows = lotIds.length
    ? await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, lotIds))
    : [];
  const lotsById = new Map(lotRows.map((row) => [row.id, row]));

  const resolved: ResolvedLine[] = [];
  lines.forEach((line, index) => {
    if (line.lotId) {
      const lot = lotsById.get(line.lotId);
      if (!lot) {
        throw new TransferOrderError("VALIDATION", `Lot ${line.lotId} was not found.`, 404);
      }
      if (lot.itemId !== line.itemId) {
        throw new TransferOrderError(
          "VALIDATION",
          `Lot ${line.lotId} does not belong to item ${line.itemId}.`,
          409,
        );
      }
      if (lot.status === "DISPOSED" || lot.status === "EXHAUSTED") {
        throw new TransferOrderError(
          "LOT_NOT_ELIGIBLE",
          `Lot ${lot.lotCode} (${lot.status}) is not eligible for a transfer.`,
          409,
          { lotId: lot.id, status: lot.status },
        );
      }
    }

    const conversionKey = `${line.itemId}:${line.enteredUom.trim().toLowerCase()}`;
    const conversionFactor = conversionByKey.get(conversionKey)!;
    let baseQuantity: string;
    try {
      baseQuantity = multiplyFixedExact(line.enteredQuantity, 6, conversionFactor, 8, 6);
    } catch (error) {
      if (error instanceof DecimalValidationError) {
        throw new TransferOrderError("UOM_MISMATCH", `Line ${index + 1}: ${error.message}`, 409);
      }
      throw error;
    }

    resolved.push({
      lineNo: index + 1,
      itemId: line.itemId,
      lotId: line.lotId ?? null,
      enteredUom: line.enteredUom,
      enteredQuantity: normalizeFixed(line.enteredQuantity, 6),
      conversionFactor,
      baseQuantity,
      remarks: line.remarks ?? null,
    });
  });

  return resolved;
}

/** Idempotent insert-or-fetch for a (module, documentNo) operational_document row. */
async function ensureOperationalDocument(
  tx: Tx,
  moduleName: string,
  documentNo: string,
  locationId: string,
  status: string,
  createdBy: string,
): Promise<{ id: string }> {
  const [inserted] = await tx
    .insert(operationalDocuments)
    .values({ module: moduleName, documentNo, locationId, status, createdBy })
    .onConflictDoNothing()
    .returning({ id: operationalDocuments.id });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({ id: operationalDocuments.id })
    .from(operationalDocuments)
    .where(and(eq(operationalDocuments.module, moduleName), eq(operationalDocuments.documentNo, documentNo)));
  if (!existing) {
    throw new TransferOrderError(
      "CONCURRENT_MODIFICATION",
      `Failed to establish ${moduleName} document ${documentNo}.`,
      409,
    );
  }
  return existing;
}

async function lockOrder(tx: Tx, orderId: string): Promise<TransferOrder> {
  const [order] = await tx.select().from(transferOrders).where(eq(transferOrders.id, orderId)).for("update");
  if (!order) {
    throw new TransferOrderError("NOT_FOUND", `Transfer order ${orderId} was not found.`, 404);
  }
  return order;
}

async function fetchLines(tx: Tx, orderId: string): Promise<TransferOrderLine[]> {
  return tx
    .select()
    .from(transferOrderLines)
    .where(eq(transferOrderLines.orderId, orderId))
    .orderBy(asc(transferOrderLines.lineNo));
}

/**
 * FEFO (first-expiry-first-out) selection of a SINGLE eligible lot covering
 * `neededBase` at `warehouseId` for `itemId`. transfer_order_line has exactly
 * one nullable `lot_id` column (no sibling allocation/split table like Job
 * Order's component allocations), so unlike production's FEFO helper this
 * cannot split one line's need across multiple lots — only `AVAILABLE`,
 * non-expired lots are eligible, ordered soonest-expiry-first (nulls/never-
 * expiring last), tiebroken by lot code for determinism. Plain (non-locking)
 * SELECT: this runs in the "prepare" transaction before any row is written;
 * the central stock posting service performs its own authoritative
 * `SELECT ... FOR UPDATE` + balance-sufficiency check at actual-post time.
 */
async function selectFefoLot(
  tx: Tx,
  itemId: string,
  warehouseId: string,
  neededBase: bigint,
  itemCode: string,
): Promise<{ lotId: string; lotCode: string }> {
  const today = manilaDate();
  const candidates = await tx
    .select({
      lotId: inventoryLots.id,
      lotCode: inventoryLots.lotCode,
      expiresAt: inventoryLots.expiresAt,
      onHand: inventoryLotBalances.onHand,
      reserved: inventoryLotBalances.reserved,
    })
    .from(inventoryLotBalances)
    .innerJoin(inventoryLots, eq(inventoryLotBalances.lotId, inventoryLots.id))
    .where(
      and(
        eq(inventoryLots.itemId, itemId),
        eq(inventoryLotBalances.warehouseId, warehouseId),
        eq(inventoryLots.status, "AVAILABLE"),
        sql`(${inventoryLots.expiresAt} IS NULL OR ${inventoryLots.expiresAt} >= ${today})`,
      ),
    )
    .orderBy(sql`${inventoryLots.expiresAt} ASC NULLS LAST`, asc(inventoryLots.lotCode));

  for (const candidate of candidates) {
    const available = parseFixed(candidate.onHand, 6) - parseFixed(candidate.reserved, 6);
    if (available >= neededBase) {
      return { lotId: candidate.lotId, lotCode: candidate.lotCode };
    }
  }

  throw new TransferOrderError(
    "INSUFFICIENT_STOCK",
    `No single eligible lot for item ${itemCode} at warehouse ${warehouseId} covers the requested quantity.`,
    409,
    { itemId, warehouseId },
  );
}

// ---------------------------------------------------------------------------
// Exported lifecycle functions
// ---------------------------------------------------------------------------

export async function createTransferOrderDraft(
  db: DB,
  input: CreateTransferOrderInput,
): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, true);
    const { source, destination } = await resolveHeaderRoute(
      tx,
      input.sourceWarehouseId,
      input.destinationWarehouseId,
    );
    assertLocationInScope(actor.allowedLocationIds, source.locationId);

    const resolvedLines = await resolveAndValidateLines(tx, input.lines);

    const [order] = await tx
      .insert(transferOrders)
      .values({
        documentNo: `TO-${randomUUID()}`,
        sourceWarehouseId: source.id,
        destinationWarehouseId: destination.id,
        sourceLocationId: source.locationId,
        destinationLocationId: destination.locationId,
        remarks: input.remarks ?? null,
        createdBy: actor.id,
      })
      .returning();

    const lines = await tx
      .insert(transferOrderLines)
      .values(resolvedLines.map((line) => ({ ...line, orderId: order!.id })))
      .returning();
    lines.sort((a, b) => a.lineNo - b.lineNo);

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: source.locationId,
      action: "transfer_order.created",
      description: `Created transfer order ${order!.documentNo} with ${lines.length} line(s).`,
      entityType: "transfer_order",
      entityId: order!.id,
    });

    return { ...order!, lines };
  });
}

export async function updateTransferOrderDraft(
  db: DB,
  input: UpdateTransferOrderInput,
): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.sourceLocationId);

    if (order.status !== "DRAFT") {
      throw new TransferOrderError("INVALID_TRANSITION", "Only DRAFT orders may be edited.", 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    let lines: TransferOrderLine[];
    if (input.lines) {
      const resolvedLines = await resolveAndValidateLines(tx, input.lines);
      await tx.delete(transferOrderLines).where(eq(transferOrderLines.orderId, order.id));
      lines = await tx
        .insert(transferOrderLines)
        .values(resolvedLines.map((line) => ({ ...line, orderId: order.id })))
        .returning();
      lines.sort((a, b) => a.lineNo - b.lineNo);
    } else {
      lines = await fetchLines(tx, order.id);
    }

    const setClause: Partial<typeof transferOrders.$inferInsert> = {
      version: order.version + 1,
      updatedAt: new Date(),
    };
    if ("remarks" in input) {
      setClause.remarks = input.remarks ?? null;
    }

    const [updated] = await tx
      .update(transferOrders)
      .set(setClause)
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.version, input.expectedVersion),
          eq(transferOrders.status, "DRAFT"),
        ),
      )
      .returning();
    if (!updated) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    return { ...updated, lines };
  });
}

export async function submitTransferOrder(
  db: DB,
  input: SubmitTransferOrderInput,
): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.sourceLocationId);

    if (order.status !== "DRAFT") {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} is ${order.status}; expected DRAFT.`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    if (lines.length === 0) {
      throw new TransferOrderError("VALIDATION", `Transfer order ${order.documentNo} has no lines to submit.`, 400);
    }

    // Route/warehouse eligibility may have drifted since DRAFT creation.
    await resolveHeaderRoute(tx, order.sourceWarehouseId, order.destinationWarehouseId);

    const [updated] = await tx
      .update(transferOrders)
      .set({
        status: "SUBMITTED",
        requestedBy: actor.id,
        requestedAt: new Date(),
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.status, "DRAFT"),
          eq(transferOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.sourceLocationId,
      action: "transfer_order.submitted",
      description: `Submitted transfer order ${order.documentNo}.`,
      entityType: "transfer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

export async function approveTransferOrder(
  db: DB,
  input: ApproveTransferOrderInput,
): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_APPROVE_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.sourceLocationId);

    if (order.status !== "SUBMITTED") {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} is ${order.status}; expected SUBMITTED.`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (actor.id === order.requestedBy) {
      throw new TransferOrderError(
        "SEGREGATION_OF_DUTIES",
        "The submitter and approver must be different actors.",
        409,
      );
    }

    const [updated] = await tx
      .update(transferOrders)
      .set({
        status: "APPROVED",
        approvedBy: actor.id,
        approvedAt: new Date(),
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.status, "SUBMITTED"),
          eq(transferOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.sourceLocationId,
      action: "transfer_order.approved",
      description: `Approved transfer order ${order.documentNo}.`,
      entityType: "transfer_order",
      entityId: order.id,
    });

    const lines = await fetchLines(tx, order.id);
    return { ...updated, lines };
  });
}

export async function cancelTransferOrder(
  db: DB,
  input: CancelTransferOrderInput,
): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, true);
    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.sourceLocationId);

    // Pre-dispatch only (DRAFT/SUBMITTED/APPROVED). Once DISPATCHED, a
    // Transfer Order has already moved stock out of the source node;
    // correction after that point is a linked compensating document, never a
    // cancel of this one (D35-D46 §5's "cancellation is allowed only before
    // dispatch" convention, carried over from Stock Return Batch).
    if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(order.status)) {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} is ${order.status}; cancel only allowed before dispatch.`,
        409,
      );
    }
    if (order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (!input.cancelReason?.trim()) {
      throw new TransferOrderError("VALIDATION", "A cancellation reason is required.", 400);
    }

    const [updated] = await tx
      .update(transferOrders)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.id,
        cancelledAt: new Date(),
        cancelReason: input.cancelReason,
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.status, order.status),
          eq(transferOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.sourceLocationId,
      action: "transfer_order.cancelled",
      description: `Cancelled transfer order ${order.documentNo}: ${input.cancelReason}.`,
      entityType: "transfer_order",
      entityId: order.id,
    });

    const lines = await fetchLines(tx, order.id);
    return { ...updated, lines };
  });
}

interface StockPostingServiceLike {
  post(input: StockPostingInput): Promise<StockPostingResult>;
}

/**
 * Posts one OUT movement per line (pinned lot, or FEFO-selected when none
 * was pinned) from the order's source warehouse, through the central stock
 * posting service, then advances the order APPROVED -> DISPATCHED. Three-step
 * shape (mirrors dispatchStockReturnBatch/receiveAndDisposeStockReturnBatch,
 * and startJobOrder's own doc comment on the same constraint): "prepare"
 * computes the full line/lot plan and the dispatch operational_document;
 * the posting call happens outside any transaction (the posting service owns
 * its own db.transaction internally and cannot be nested inside another
 * transaction on the same `db` without a self-deadlock risk); "finalize"
 * re-verifies state and writes the order's own rows.
 *  - The dispatch operational_document is looked up/created idempotently
 *    from the order's own document number (module TRANSFER_ORDER_DISPATCH),
 *    then compensated (deleted) if the posting call fails, so a failed
 *    dispatch never leaves a dangling document behind.
 *  - The idempotency/correlation id for the posting call is derived from the
 *    order's own document number alone (`${documentNo}:DISPATCH`), so a retry
 *    with the same order always replays the same posting instead of double-
 *    posting.
 *  - On replay (order already DISPATCHED), a line whose `dispatch_posting_
 *    line_id` is already set is left untouched — the DB trigger allows
 *    re-setting it to the SAME value, but skipping avoids depending on that
 *    and keeps replay a true no-op against `transfer_order_line`.
 *  - The order's own APPROVED -> DISPATCHED update is a conditional UPDATE
 *    guarded by status+version; if it matches zero rows after a successful
 *    (possibly replayed) posting, the order was already advanced by an
 *    earlier attempt and the current row is returned as-is (replay-safe).
 */
export async function dispatchTransferOrder(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: DispatchTransferOrderInput,
): Promise<TransferOrderWithLines> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_DISPATCH_ROLES, true);

    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.sourceLocationId);

    if (order.status !== "APPROVED" && order.status !== "DISPATCHED") {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} is ${order.status}; expected APPROVED.`,
        409,
      );
    }
    // Once DISPATCHED, a caller retrying with its original pre-dispatch
    // version is doing an idempotent replay, not a stale write.
    if (order.status === "APPROVED" && order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
    const itemCodeById = new Map(itemRows.map((row) => [row.id, row.code]));

    const resolvedLines: Array<{ line: TransferOrderLine; lotId: string }> = [];
    for (const line of lines) {
      if (line.lotId) {
        resolvedLines.push({ line, lotId: line.lotId });
        continue;
      }
      const selected = await selectFefoLot(
        tx,
        line.itemId,
        order.sourceWarehouseId,
        parseFixed(line.baseQuantity, 6),
        itemCodeById.get(line.itemId) ?? line.itemId,
      );
      resolvedLines.push({ line, lotId: selected.lotId });
    }

    const dispatchDoc = await ensureOperationalDocument(
      tx,
      TRANSFER_ORDER_DISPATCH_MODULE,
      order.documentNo,
      order.sourceLocationId,
      "APPROVED",
      actor.id,
    );

    return { actor, order, resolvedLines, dispatchDocId: dispatchDoc.id };
  });

  const { actor, order, resolvedLines, dispatchDocId } = prepared;
  const dispatchKey = `${order.documentNo}:DISPATCH`;

  const postingInput: StockPostingInput = {
    idempotencyKey: dispatchKey,
    sourceModule: TRANSFER_ORDER_DISPATCH_MODULE,
    sourceDocumentNo: order.documentNo,
    locationId: order.sourceLocationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: dispatchKey,
    movements: resolvedLines.map(({ line, lotId }) => ({
      warehouseId: order.sourceWarehouseId,
      itemId: line.itemId,
      lotId,
      movementType: "OUT",
      quantity: line.baseQuantity,
      enteredQuantity: line.enteredQuantity,
      enteredUom: line.enteredUom,
      conversionFactor: line.conversionFactor,
      metadata: { transferOrderLineId: line.id, lineNo: line.lineNo },
    })),
  };

  let postingResult: StockPostingResult;
  try {
    postingResult = await stockPostingService.post(postingInput);
  } catch (error) {
    // Compensate: only remove the document if it's still exactly as we left
    // it (untouched by any posting), so a document another attempt already
    // advanced is never disturbed.
    await db
      .delete(operationalDocuments)
      .where(
        and(
          eq(operationalDocuments.id, dispatchDocId),
          eq(operationalDocuments.status, "APPROVED"),
          sql`${operationalDocuments.stockPostingId} IS NULL`,
        ),
      );
    throw error;
  }

  return db.transaction(async (tx) => {
    const postingLineRows = await tx
      .select()
      .from(stockPostingLines)
      .where(eq(stockPostingLines.postingId, postingResult.postingId));
    const postingLineIdByLineId = new Map<string, string>();
    for (const row of postingLineRows) {
      const metadata = row.metadata as { transferOrderLineId?: string } | null;
      if (metadata?.transferOrderLineId) {
        postingLineIdByLineId.set(metadata.transferOrderLineId, row.id);
      }
    }

    for (const { line, lotId } of resolvedLines) {
      const postingLineId = postingLineIdByLineId.get(line.id);
      if (!postingLineId) {
        throw new TransferOrderError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the dispatch posting line for transfer order line ${line.id}.`,
          409,
        );
      }
      // Skip lines already finalized by a prior attempt (replay-safe): the
      // append-only trigger allows re-setting dispatch_posting_line_id to
      // the SAME value, but this WHERE guard keeps a replay a true no-op
      // against transfer_order_line instead of depending on that.
      await tx
        .update(transferOrderLines)
        .set({
          lotId,
          dispatchedQuantity: line.baseQuantity,
          dispatchPostingLineId: postingLineId,
          status: "DISPATCHED",
          updatedAt: new Date(),
        })
        .where(and(eq(transferOrderLines.id, line.id), sql`${transferOrderLines.dispatchPostingLineId} IS NULL`));
    }

    const [updated] = await tx
      .update(transferOrders)
      .set({
        status: "DISPATCHED",
        dispatchDocumentId: dispatchDocId,
        dispatchedBy: actor.id,
        dispatchedAt: new Date(),
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.status, "APPROVED"),
          eq(transferOrders.version, input.expectedVersion),
        ),
      )
      .returning();

    const lines = await fetchLines(tx, order.id);
    if (!updated) {
      const [current] = await tx.select().from(transferOrders).where(eq(transferOrders.id, order.id));
      if (current?.status === "DISPATCHED") {
        return { ...current, lines };
      }
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.sourceLocationId,
      action: "transfer_order.dispatched",
      description: `Dispatched transfer order ${order.documentNo}.`,
      entityType: "transfer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

/**
 * Posts one IN movement per dispatched line (full dispatched quantity unless
 * a caller-supplied `receivedQuantity` records transit shortage) at the
 * order's destination warehouse, through the central stock posting service,
 * then advances the order DISPATCHED -> RECEIVED. Same three-step shape as
 * dispatchTransferOrder() and for the same reason (the posting service owns
 * its own transaction).
 *  - Received-phase movements always use the item's own base UOM with a 1:1
 *    factor (rather than the line's originally entered UOM/conversion),
 *    since a partial receipt's quantity is expressed directly in base units
 *    (transfer_order_line.received_quantity, scale 6) and reusing the
 *    entered-UOM conversion would require reverse-deriving a partial entered
 *    quantity for no benefit.
 *  - The receipt operational_document and posting idempotency key follow the
 *    same idempotent/compensate-on-failure pattern as dispatch.
 *  - A line whose `receipt_posting_line_id` is already set is left untouched
 *    on replay: the DB trigger makes the ENTIRE row immutable (including
 *    same-value updates) once that column is set, so this guard is required,
 *    not just defensive.
 */
export async function receiveTransferOrder(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: ReceiveTransferOrderInput,
): Promise<TransferOrderWithLines> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_RECEIVE_ROLES, true);

    const order = await lockOrder(tx, input.orderId);
    assertLocationInScope(actor.allowedLocationIds, order.destinationLocationId);

    if (order.status !== "DISPATCHED" && order.status !== "RECEIVED") {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} is ${order.status}; expected DISPATCHED.`,
        409,
      );
    }
    if (order.status === "DISPATCHED" && order.version !== input.expectedVersion) {
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} version ${order.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, order.id);
    const overridesByLineId = new Map<string, TransferOrderReceiptLineInput>();
    for (const receiptLine of input.receiptLines ?? []) {
      if (overridesByLineId.has(receiptLine.lineId)) {
        throw new TransferOrderError(
          "DUPLICATE_LINE",
          `Duplicate receipt input for transfer order line ${receiptLine.lineId}.`,
          400,
          { lineId: receiptLine.lineId },
        );
      }
      overridesByLineId.set(receiptLine.lineId, receiptLine);
    }
    const knownLineIds = new Set(lines.map((line) => line.id));
    for (const lineId of overridesByLineId.keys()) {
      if (!knownLineIds.has(lineId)) {
        throw new TransferOrderError(
          "VALIDATION",
          `Receipt input references unknown transfer order line ${lineId}.`,
          400,
        );
      }
    }

    const undispatched = lines.filter((line) => !line.dispatchPostingLineId || !line.lotId || !line.dispatchedQuantity);
    if (undispatched.length > 0) {
      throw new TransferOrderError(
        "INVALID_TRANSITION",
        `Transfer order ${order.documentNo} has undispatched line(s); cannot receive.`,
        409,
      );
    }

    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
    const itemUnitById = new Map(itemRows.map((row) => [row.id, row.unit]));

    const resolvedLines = lines.map((line) => {
      const override = overridesByLineId.get(line.id);
      const dispatchedBase = parseFixed(line.dispatchedQuantity!, 6);
      let receivedBase = dispatchedBase;
      if (override?.receivedQuantity !== undefined) {
        try {
          receivedBase = parseFixed(override.receivedQuantity, 6);
        } catch (error) {
          if (error instanceof DecimalValidationError) {
            throw new TransferOrderError("VALIDATION", `Line ${line.lineNo}: ${error.message}`, 400);
          }
          throw error;
        }
      }
      if (receivedBase <= 0n) {
        throw new TransferOrderError(
          "VALIDATION",
          `Line ${line.lineNo} received quantity must be positive.`,
          400,
        );
      }
      if (receivedBase > dispatchedBase) {
        throw new TransferOrderError(
          "VALIDATION",
          `Line ${line.lineNo} received quantity cannot exceed the dispatched quantity.`,
          400,
        );
      }
      return {
        line,
        receivedQuantity: formatFixed(receivedBase, 6),
        unit: itemUnitById.get(line.itemId) ?? line.enteredUom,
      };
    });

    const receiptDoc = await ensureOperationalDocument(
      tx,
      TRANSFER_ORDER_RECEIPT_MODULE,
      order.documentNo,
      order.destinationLocationId,
      "DISPATCHED",
      actor.id,
    );

    return { actor, order, resolvedLines, receiptDocId: receiptDoc.id };
  });

  const { actor, order, resolvedLines, receiptDocId } = prepared;
  const receiveKey = `${order.documentNo}:RECEIVE`;

  const postingInput: StockPostingInput = {
    idempotencyKey: receiveKey,
    sourceModule: TRANSFER_ORDER_RECEIPT_MODULE,
    sourceDocumentNo: order.documentNo,
    locationId: order.destinationLocationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: receiveKey,
    movements: resolvedLines.map(({ line, receivedQuantity, unit }) => ({
      warehouseId: order.destinationWarehouseId,
      itemId: line.itemId,
      lotId: line.lotId!,
      movementType: "IN",
      quantity: receivedQuantity,
      enteredQuantity: receivedQuantity,
      enteredUom: unit,
      conversionFactor: "1.00000000",
      metadata: { transferOrderLineId: line.id, lineNo: line.lineNo },
    })),
  };

  let postingResult: StockPostingResult;
  try {
    postingResult = await stockPostingService.post(postingInput);
  } catch (error) {
    await db
      .delete(operationalDocuments)
      .where(
        and(
          eq(operationalDocuments.id, receiptDocId),
          eq(operationalDocuments.status, "DISPATCHED"),
          sql`${operationalDocuments.stockPostingId} IS NULL`,
        ),
      );
    throw error;
  }

  return db.transaction(async (tx) => {
    const postingLineRows = await tx
      .select()
      .from(stockPostingLines)
      .where(eq(stockPostingLines.postingId, postingResult.postingId));
    const postingLineIdByLineId = new Map<string, string>();
    for (const row of postingLineRows) {
      const metadata = row.metadata as { transferOrderLineId?: string } | null;
      if (metadata?.transferOrderLineId) {
        postingLineIdByLineId.set(metadata.transferOrderLineId, row.id);
      }
    }

    for (const { line, receivedQuantity } of resolvedLines) {
      const postingLineId = postingLineIdByLineId.get(line.id);
      if (!postingLineId) {
        throw new TransferOrderError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the receipt posting line for transfer order line ${line.id}.`,
          409,
        );
      }
      // The DB trigger makes the whole row immutable once receipt_posting_
      // line_id is set, so a replay MUST skip rows already finalized.
      await tx
        .update(transferOrderLines)
        .set({
          receivedQuantity,
          receiptPostingLineId: postingLineId,
          status: "RECEIVED",
          updatedAt: new Date(),
        })
        .where(and(eq(transferOrderLines.id, line.id), sql`${transferOrderLines.receiptPostingLineId} IS NULL`));
    }

    const [updated] = await tx
      .update(transferOrders)
      .set({
        status: "RECEIVED",
        receiptDocumentId: receiptDocId,
        receivedBy: actor.id,
        receivedAt: new Date(),
        version: order.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transferOrders.id, order.id),
          eq(transferOrders.status, "DISPATCHED"),
          eq(transferOrders.version, input.expectedVersion),
        ),
      )
      .returning();

    const lines = await fetchLines(tx, order.id);
    if (!updated) {
      const [current] = await tx.select().from(transferOrders).where(eq(transferOrders.id, order.id));
      if (current?.status === "RECEIVED") {
        return { ...current, lines };
      }
      throw new TransferOrderError(
        "CONCURRENT_MODIFICATION",
        `Transfer order ${order.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: order.destinationLocationId,
      action: "transfer_order.received",
      description: `Received transfer order ${order.documentNo}.`,
      entityType: "transfer_order",
      entityId: order.id,
    });

    return { ...updated, lines };
  });
}

export async function getTransferOrder(db: DB, input: GetTransferOrderInput): Promise<TransferOrderWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, false);

    const [order] = await tx.select().from(transferOrders).where(eq(transferOrders.id, input.orderId));
    if (!order) {
      throw new TransferOrderError("NOT_FOUND", `Transfer order ${input.orderId} was not found.`, 404);
    }
    if (
      actor.allowedLocationIds !== null &&
      !actor.allowedLocationIds.includes(order.sourceLocationId) &&
      !actor.allowedLocationIds.includes(order.destinationLocationId)
    ) {
      throw new TransferOrderError("UNAUTHORIZED", "The transfer order is outside the actor's outlet scope.", 403);
    }

    const lines = await fetchLines(tx, order.id);
    return { ...order, lines };
  });
}

export async function listTransferOrders(db: DB, input: ListTransferOrdersInput): Promise<TransferOrder[]> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, TRANSFER_ROLES, false);

    const conditions = [];
    if (actor.allowedLocationIds !== null) {
      const scoped = or(
        inArray(transferOrders.sourceLocationId, actor.allowedLocationIds),
        inArray(transferOrders.destinationLocationId, actor.allowedLocationIds),
      );
      conditions.push(scoped);
    }
    if (input.sourceLocationId) {
      conditions.push(eq(transferOrders.sourceLocationId, input.sourceLocationId));
    }
    if (input.destinationLocationId) {
      conditions.push(eq(transferOrders.destinationLocationId, input.destinationLocationId));
    }
    if (input.status) {
      conditions.push(eq(transferOrders.status, input.status));
    }
    if (input.search?.trim()) {
      conditions.push(ilike(transferOrders.documentNo, `%${input.search.trim()}%`));
    }

    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;

    const query = tx.select().from(transferOrders);
    const ordered =
      conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(transferOrders.createdAt))
        : query.orderBy(desc(transferOrders.createdAt));
    return ordered.limit(limit).offset(offset);
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface TransferOrderActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

interface CreateDraftServiceInput {
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  remarks?: string | null;
  lines: TransferOrderLineInput[];
}

interface UpdateDraftServiceInput {
  orderId: string;
  version: number;
  remarks?: string | null;
  lines?: TransferOrderLineInput[];
}

interface SubmitServiceInput {
  orderId: string;
  version: number;
}

interface ApproveServiceInput {
  orderId: string;
  version: number;
}

interface CancelServiceInput {
  orderId: string;
  version: number;
  cancelReason: string;
}

interface DispatchServiceInput {
  orderId: string;
  version: number;
}

interface ReceiveServiceInput {
  orderId: string;
  version: number;
  receiptLines?: TransferOrderReceiptLineInput[];
}

interface GetServiceInput {
  orderId: string;
}

type ListServiceInput = Omit<ListTransferOrdersInput, "actorUserId" | "sessionId">;

/** Facade over the standalone lifecycle functions above. */
export function createTransferOrderService(db: DB) {
  const stockPostingService = createStockPostingService(db, {
    documentPolicies: {
      [TRANSFER_ORDER_DISPATCH_MODULE]: TRANSFER_ORDER_DISPATCH_POLICY,
      [TRANSFER_ORDER_RECEIPT_MODULE]: TRANSFER_ORDER_RECEIPT_POLICY,
    },
  });
  return {
    createDraft(ctx: TransferOrderActorContext, input: CreateDraftServiceInput) {
      return createTransferOrderDraft(db, { ...ctx, ...input });
    },
    updateDraft(ctx: TransferOrderActorContext, input: UpdateDraftServiceInput) {
      const { orderId, version, ...rest } = input;
      return updateTransferOrderDraft(db, { ...ctx, orderId, expectedVersion: version, ...rest });
    },
    submit(ctx: TransferOrderActorContext, input: SubmitServiceInput) {
      return submitTransferOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    approve(ctx: TransferOrderActorContext, input: ApproveServiceInput) {
      return approveTransferOrder(db, { ...ctx, orderId: input.orderId, expectedVersion: input.version });
    },
    cancel(ctx: TransferOrderActorContext, input: CancelServiceInput) {
      return cancelTransferOrder(db, {
        ...ctx,
        orderId: input.orderId,
        expectedVersion: input.version,
        cancelReason: input.cancelReason,
      });
    },
    dispatch(ctx: TransferOrderActorContext, input: DispatchServiceInput): Promise<TransferOrderWithLines> {
      return dispatchTransferOrder(db, stockPostingService, {
        ...ctx,
        orderId: input.orderId,
        expectedVersion: input.version,
      });
    },
    receive(ctx: TransferOrderActorContext, input: ReceiveServiceInput): Promise<TransferOrderWithLines> {
      return receiveTransferOrder(db, stockPostingService, {
        ...ctx,
        orderId: input.orderId,
        expectedVersion: input.version,
        receiptLines: input.receiptLines,
      });
    },
    get(ctx: TransferOrderActorContext, input: GetServiceInput) {
      return getTransferOrder(db, { ...ctx, orderId: input.orderId });
    },
    list(ctx: TransferOrderActorContext, input: ListServiceInput) {
      return listTransferOrders(db, { ...ctx, ...input });
    },
  };
}
