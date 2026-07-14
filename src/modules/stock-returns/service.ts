/**
 * Stock Return Batch service: create/update/submit/approve/cancel/read plus
 * the dispatch and receive-and-dispose stock posting steps, both routed
 * through the central src/modules/stock/posting-service.ts against the two
 * operationalDocuments rows this service creates at submit time.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLotGenealogy,
  inventoryLots,
  itemUomConversions,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
  topologyMigrationExceptions,
} from "../../db/enterprise-schema.js";
import {
  stockReturnBatchLines,
  stockReturnBatches,
  stockReturnReasonEnum,
  stockReturnReceiptLines,
} from "../../db/returns-schema.js";
import {
  auditLogs,
  ingredients,
  userOutletAccess,
  users,
  userSessions,
  warehouses,
} from "../../db/schema.js";
import type { Role } from "../../db/schema.js";
import { normalizeRole, outletScopeForRole } from "../auth/roles.js";
import { DecimalValidationError, multiplyFixedExact, normalizeFixed, parseFixed } from "../stock/decimal.js";
import { createStockPostingService } from "../stock/posting-service.js";
import type { StockPostingInput, StockPostingResult } from "../stock/types.js";
import { QA_RELEASE_RELEASABLE_REASONS } from "../qa-releases/policies.js";
import { StockReturnError } from "./errors.js";
import {
  STOCK_RETURN_APPROVE_ROLES,
  STOCK_RETURN_DISPATCH_MODULE,
  STOCK_RETURN_DISPATCH_POLICY,
  STOCK_RETURN_FEATURE_KEY,
  STOCK_RETURN_MAX_LINES,
  STOCK_RETURN_MIN_LINES,
  STOCK_RETURN_RECEIPT_MODULE,
  STOCK_RETURN_RECEIPT_POLICY,
  STOCK_RETURN_RECEIVE_ROLES,
  STOCK_RETURN_ROLES,
  STOCK_RETURN_SOURCE_WAREHOUSE_PURPOSES,
} from "./policies.js";
import type {
  ApproveStockReturnBatchInput,
  CancelStockReturnBatchInput,
  CreateStockReturnBatchInput,
  GetStockReturnBatchInput,
  ListStockReturnBatchesInput,
  ListStockReturnBatchesPage,
  ReceiptLineInput,
  ReceiveAndDisposeStockReturnBatchInput,
  StockReturnBatch,
  StockReturnBatchLine,
  StockReturnBatchWithLines,
  StockReturnLineInput,
  SubmitStockReturnBatchInput,
  UpdateStockReturnBatchInput,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * createStockReturnDraft's actual input carries the optional
 * caller-declared destination fields the service facade forwards
 * (see CreateDraftServiceInput below); CreateStockReturnBatchInput
 * itself has no client-supplied destination to prevent a route being
 * smuggled in undetected.
 */
type CreateStockReturnDraftInput = CreateStockReturnBatchInput & {
  destinationLocationId?: string;
  destinationWarehouseId?: string;
};

interface ResolvedLine {
  lineNo: number;
  itemId: string;
  lotId: string;
  sourceWarehouseId: string;
  quantity: string;
  enteredQuantity: string;
  enteredUom: string;
  conversionFactor: string;
  reasonCode: StockReturnLineInput["reasonCode"];
  remarks: string | null;
  evidenceRef: string | null;
}

const VALID_REASON_CODES = new Set<string>(stockReturnReasonEnum.enumValues);
const ELIGIBLE_SOURCE_PURPOSES = new Set<string>(STOCK_RETURN_SOURCE_WAREHOUSE_PURPOSES);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
    throw new StockReturnError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this stock return operation.",
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
      throw new StockReturnError("UNAUTHORIZED", "The actor session is not active.", 401);
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
    throw new StockReturnError(
      "UNAUTHORIZED",
      "The stock return document is outside the actor's outlet scope.",
      403,
    );
  }
}

async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, STOCK_RETURN_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new StockReturnError(
      "FEATURE_DISABLED",
      `Operational feature "${STOCK_RETURN_FEATURE_KEY}" is disabled.`,
      503,
      { feature: STOCK_RETURN_FEATURE_KEY },
    );
  }
}

async function resolveHqDestination(
  tx: Tx,
): Promise<{ locationId: string; warehouseId: string; quarantineWarehouseId: string }> {
  const hqRows = await tx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.purpose, "HQ_MAIN"), eq(warehouses.isActive, true)))
    .for("update");
  const openExceptions = await tx
    .select({ id: topologyMigrationExceptions.id })
    .from(topologyMigrationExceptions)
    .where(eq(topologyMigrationExceptions.status, "OPEN"))
    .for("update");
  if (openExceptions.length > 0 || hqRows.length !== 1) {
    throw new StockReturnError(
      "TOPOLOGY_NOT_READY",
      "Enterprise warehouse topology is not ready for stock returns.",
      503,
      { activeHqMainCount: hqRows.length, openTopologyExceptions: openExceptions.length },
    );
  }
  const hq = hqRows[0]!;

  const quarantineRows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.locationId, hq.locationId),
        eq(warehouses.purpose, "QUARANTINE"),
        eq(warehouses.isActive, true),
      ),
    )
    .for("update");
  if (quarantineRows.length !== 1) {
    throw new StockReturnError(
      "TOPOLOGY_NOT_READY",
      "HQ does not have exactly one active quarantine warehouse configured.",
      503,
      { activeQuarantineCount: quarantineRows.length },
    );
  }

  return { locationId: hq.locationId, warehouseId: hq.id, quarantineWarehouseId: quarantineRows[0]!.id };
}

async function resolveAndValidateLines(
  tx: Tx,
  sourceLocationId: string,
  lines: StockReturnLineInput[],
): Promise<ResolvedLine[]> {
  if (lines.length < STOCK_RETURN_MIN_LINES || lines.length > STOCK_RETURN_MAX_LINES) {
    throw new StockReturnError(
      "VALIDATION",
      `A stock return batch must contain between ${STOCK_RETURN_MIN_LINES} and ${STOCK_RETURN_MAX_LINES} line(s).`,
      400,
    );
  }

  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.itemId}:${line.lotId}:${line.sourceWarehouseId}`;
    if (seen.has(key)) {
      throw new StockReturnError(
        "DUPLICATE_LINE",
        `Duplicate line for item/lot/warehouse combination ${key}.`,
        400,
        { key },
      );
    }
    seen.add(key);
  }

  lines.forEach((line, index) => {
    if (!line.enteredUom.trim()) {
      throw new StockReturnError("VALIDATION", `Line ${index + 1} is missing an entered UOM.`, 400);
    }
    if (!VALID_REASON_CODES.has(line.reasonCode)) {
      throw new StockReturnError("VALIDATION", `Line ${index + 1} has an invalid reason code.`, 400);
    }
    try {
      if (parseFixed(line.enteredQuantity, 6) <= 0n) {
        throw new StockReturnError("VALIDATION", `Line ${index + 1} quantity must be positive.`, 400);
      }
    } catch (error) {
      if (error instanceof StockReturnError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockReturnError("VALIDATION", `Line ${index + 1}: ${error.message}`, 400);
      }
      throw error;
    }
  });

  const warehouseIds = [...new Set(lines.map((line) => line.sourceWarehouseId))];
  const warehouseRows = await tx.select().from(warehouses).where(inArray(warehouses.id, warehouseIds));
  const warehousesById = new Map(warehouseRows.map((row) => [row.id, row]));
  for (const warehouseId of warehouseIds) {
    const warehouse = warehousesById.get(warehouseId);
    if (!warehouse || !warehouse.isActive) {
      throw new StockReturnError(
        "FORBIDDEN_ROUTE",
        `Source warehouse ${warehouseId} is missing or inactive.`,
        409,
      );
    }
    if (warehouse.locationId !== sourceLocationId) {
      throw new StockReturnError(
        "VALIDATION",
        `Source warehouse ${warehouseId} does not belong to the batch's source outlet.`,
        400,
      );
    }
    if (!warehouse.purpose || !ELIGIBLE_SOURCE_PURPOSES.has(warehouse.purpose)) {
      throw new StockReturnError(
        "FORBIDDEN_ROUTE",
        `Source warehouse ${warehouseId} is not an eligible stock return source.`,
        409,
      );
    }
  }

  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));
  for (const itemId of itemIds) {
    const item = itemsById.get(itemId);
    if (!item || !item.isActive) {
      throw new StockReturnError("VALIDATION", `Item ${itemId} is missing or inactive.`, 409);
    }
  }

  const lotIds = [...new Set(lines.map((line) => line.lotId))];
  const lotRows = await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, lotIds));
  const lotsById = new Map(lotRows.map((row) => [row.id, row]));

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
      throw new StockReturnError(
        "UOM_MISMATCH",
        `No active ${enteredUom} conversion exists for item ${itemId}.`,
        409,
      );
    }
    conversionByKey.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  const resolved: ResolvedLine[] = [];
  lines.forEach((line, index) => {
    const lot = lotsById.get(line.lotId);
    if (!lot) {
      throw new StockReturnError("VALIDATION", `Lot ${line.lotId} was not found.`, 404);
    }
    if (lot.itemId !== line.itemId) {
      throw new StockReturnError(
        "VALIDATION",
        `Lot ${line.lotId} does not belong to item ${line.itemId}.`,
        409,
      );
    }
    if (lot.status === "DISPOSED" || lot.status === "EXHAUSTED") {
      throw new StockReturnError(
        "LOT_NOT_ELIGIBLE",
        `Lot ${lot.lotCode} (${lot.status}) is not eligible for a stock return.`,
        409,
        { lotId: lot.id, status: lot.status },
      );
    }

    const conversionKey = `${line.itemId}:${line.enteredUom.trim().toLowerCase()}`;
    const conversionFactor = conversionByKey.get(conversionKey)!;
    let quantity: string;
    try {
      quantity = multiplyFixedExact(line.enteredQuantity, 6, conversionFactor, 8, 6);
    } catch (error) {
      if (error instanceof DecimalValidationError) {
        throw new StockReturnError(
          "UOM_MISMATCH",
          `Line ${index + 1}: ${error.message}`,
          409,
        );
      }
      throw error;
    }

    resolved.push({
      lineNo: index + 1,
      itemId: line.itemId,
      lotId: line.lotId,
      sourceWarehouseId: line.sourceWarehouseId,
      quantity,
      enteredQuantity: normalizeFixed(line.enteredQuantity, 6),
      enteredUom: line.enteredUom,
      conversionFactor,
      reasonCode: line.reasonCode,
      remarks: line.remarks ?? null,
      evidenceRef: line.evidenceRef ?? null,
    });
  });

  return resolved;
}

/** Idempotent insert-or-fetch for a (module, documentNo) operational_document row. */
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
    throw new StockReturnError(
      "CONCURRENT_MODIFICATION",
      `Failed to establish ${module} document ${documentNo}.`,
      409,
    );
  }
  return existing;
}

async function fetchLines(tx: Tx, batchId: string): Promise<StockReturnBatchLine[]> {
  return tx
    .select()
    .from(stockReturnBatchLines)
    .where(eq(stockReturnBatchLines.batchId, batchId))
    .orderBy(asc(stockReturnBatchLines.lineNo));
}

/**
 * Requires exactly one receipt input per batch line: no duplicates, none
 * missing, none referencing a batch line outside this batch.
 */
function validateReceiptLines(
  lines: StockReturnBatchLine[],
  receiptLines: ReceiptLineInput[],
): Map<string, ReceiptLineInput> {
  if (receiptLines.length !== lines.length) {
    throw new StockReturnError(
      "VALIDATION",
      `Exactly one receipt line is required per batch line (expected ${lines.length}, received ${receiptLines.length}).`,
      400,
    );
  }
  const byBatchLineId = new Map<string, ReceiptLineInput>();
  for (const receiptLine of receiptLines) {
    if (byBatchLineId.has(receiptLine.batchLineId)) {
      throw new StockReturnError(
        "DUPLICATE_LINE",
        `Duplicate receipt input for batch line ${receiptLine.batchLineId}.`,
        400,
        { batchLineId: receiptLine.batchLineId },
      );
    }
    if (!VALID_REASON_CODES.has(receiptLine.dispositionReasonCode)) {
      throw new StockReturnError(
        "VALIDATION",
        `Receipt input for batch line ${receiptLine.batchLineId} has an invalid disposition reason code.`,
        400,
      );
    }
    byBatchLineId.set(receiptLine.batchLineId, receiptLine);
  }
  for (const line of lines) {
    if (!byBatchLineId.has(line.id)) {
      throw new StockReturnError("VALIDATION", `Batch line ${line.id} is missing a receipt input.`, 400);
    }
  }
  return byBatchLineId;
}

/**
 * Idempotent insert-or-fetch for the deterministic HQ quarantine lot a batch
 * line's return receipt lands in (`RETURN:<batchId>:<lineNo>`), so a retried
 * receiveAndDispose() call always reuses the same lot instead of minting a
 * duplicate under the (item, lot_code) unique index.
 */
async function ensureQuarantineLot(
  tx: Tx,
  itemId: string,
  lotCode: string,
  unitCost: string,
  sourceDocumentId: string,
): Promise<{ id: string }> {
  const [inserted] = await tx
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode,
      status: "QUARANTINED",
      unitCost,
      sourceDocumentType: "STOCK_RETURN_RECEIPT",
      sourceDocumentId,
    })
    .onConflictDoNothing()
    .returning({ id: inventoryLots.id });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({ id: inventoryLots.id })
    .from(inventoryLots)
    .where(and(eq(inventoryLots.itemId, itemId), eq(inventoryLots.lotCode, lotCode)));
  if (!existing) {
    throw new StockReturnError("CONCURRENT_MODIFICATION", `Failed to establish quarantine lot ${lotCode}.`, 409);
  }
  return existing;
}

/** Idempotent insert-or-ignore for the outlet-lot -> quarantine-lot genealogy link. */
async function ensureLotGenealogy(
  tx: Tx,
  parentLotId: string,
  childLotId: string,
  quantityConsumed: string,
  productionDocumentNo: string,
): Promise<void> {
  await tx
    .insert(inventoryLotGenealogy)
    .values({ parentLotId, childLotId, quantityConsumed, productionDocumentNo })
    .onConflictDoNothing();
}

/**
 * Idempotent insert-or-fetch for a stock_return_receipt_line row. The unique
 * `batch_line_id` index makes this append-only: a retried call can only ever
 * fetch the row a prior attempt already wrote, never insert a second one.
 * `dispositionOutPostingLineId` is null for a reusable-reason (QA_RELEASE_
 * RELEASABLE_REASONS) line, which never posts a disposition OUT (D35-D46 §5).
 */
async function ensureReceiptLine(
  tx: Tx,
  batchLineId: string,
  quarantineLotId: string,
  receivedQuantity: string,
  dispositionReasonCode: string,
  dispositionRemarks: string | null,
  quarantineInPostingLineId: string,
  dispositionOutPostingLineId: string | null,
): Promise<void> {
  const [inserted] = await tx
    .insert(stockReturnReceiptLines)
    .values({
      batchLineId,
      quarantineLotId,
      receivedQuantity,
      dispositionReasonCode: dispositionReasonCode as (typeof stockReturnReasonEnum.enumValues)[number],
      dispositionRemarks,
      quarantineInPostingLineId,
      dispositionOutPostingLineId,
    })
    .onConflictDoNothing()
    .returning({ id: stockReturnReceiptLines.id });
  if (inserted) return;
  const [existing] = await tx
    .select({ id: stockReturnReceiptLines.id })
    .from(stockReturnReceiptLines)
    .where(eq(stockReturnReceiptLines.batchLineId, batchLineId));
  if (!existing) {
    throw new StockReturnError(
      "CONCURRENT_MODIFICATION",
      `Failed to establish the receipt evidence for batch line ${batchLineId}.`,
      409,
    );
  }
}

/**
 * Runs the same actor-role and outlet-scope checks the lifecycle functions
 * use, without performing any stock-affecting work.
 */
async function assertBatchActorAuthorized(
  db: DB,
  ctx: StockReturnActorContext,
  batchId: string,
  allowedRoles: readonly Role[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, ctx.actorUserId, ctx.sessionId, allowedRoles, false);
    const batch = await lockBatch(tx, batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);
  });
}

async function lockBatch(tx: Tx, batchId: string) {
  const [batch] = await tx
    .select()
    .from(stockReturnBatches)
    .where(eq(stockReturnBatches.id, batchId))
    .for("update");
  if (!batch) {
    throw new StockReturnError("NOT_FOUND", `Stock return batch ${batchId} was not found.`, 404);
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Exported lifecycle functions
// ---------------------------------------------------------------------------

export async function createStockReturnDraft(
  db: DB,
  input: CreateStockReturnDraftInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, true);
    assertLocationInScope(actor.allowedLocationIds, input.sourceLocationId);

    const { locationId: destinationLocationId, warehouseId: destinationWarehouseId } =
      await resolveHqDestination(tx);
    if (input.sourceLocationId === destinationLocationId) {
      throw new StockReturnError(
        "VALIDATION",
        "Source outlet cannot be the configured HQ location; HQ cannot return stock to itself.",
        400,
      );
    }
    if (
      input.destinationLocationId !== undefined &&
      input.destinationLocationId !== destinationLocationId
    ) {
      throw new StockReturnError(
        "FORBIDDEN_ROUTE",
        "The declared destination outlet does not match the server-resolved HQ_MAIN route.",
        409,
      );
    }
    if (
      input.destinationWarehouseId !== undefined &&
      input.destinationWarehouseId !== destinationWarehouseId
    ) {
      throw new StockReturnError(
        "FORBIDDEN_ROUTE",
        "The declared destination warehouse does not match the server-resolved HQ_MAIN route.",
        409,
      );
    }

    const resolvedLines = await resolveAndValidateLines(tx, input.sourceLocationId, input.lines);

    const [batch] = await tx
      .insert(stockReturnBatches)
      .values({
        documentNo: `SRB-${randomUUID()}`,
        sourceLocationId: input.sourceLocationId,
        destinationLocationId,
        destinationWarehouseId,
        remarks: input.remarks ?? null,
        createdBy: actor.id,
      })
      .returning();

    const lines = await tx
      .insert(stockReturnBatchLines)
      .values(resolvedLines.map((line) => ({ ...line, batchId: batch!.id })))
      .returning();
    lines.sort((a, b) => a.lineNo - b.lineNo);

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: input.sourceLocationId,
      action: "stock_return.created",
      description: `Created stock return batch ${batch!.documentNo} with ${lines.length} line(s).`,
      entityType: "stock_return_batch",
      entityId: batch!.id,
    });

    return { ...batch!, lines };
  });
}

export async function updateStockReturnDraft(
  db: DB,
  input: UpdateStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, true);

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    if (batch.status !== "DRAFT") {
      throw new StockReturnError("INVALID_TRANSITION", "Only DRAFT batches may be edited.", 409);
    }
    if (batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    let lines: StockReturnBatchLine[];
    if (input.lines) {
      const resolvedLines = await resolveAndValidateLines(tx, batch.sourceLocationId, input.lines);
      await tx.delete(stockReturnBatchLines).where(eq(stockReturnBatchLines.batchId, batch.id));
      lines = await tx
        .insert(stockReturnBatchLines)
        .values(resolvedLines.map((line) => ({ ...line, batchId: batch.id })))
        .returning();
      lines.sort((a, b) => a.lineNo - b.lineNo);
    } else {
      lines = await fetchLines(tx, batch.id);
    }

    const setClause: Partial<typeof stockReturnBatches.$inferInsert> = {
      version: batch.version + 1,
      updatedAt: new Date(),
    };
    if ("remarks" in input) {
      setClause.remarks = input.remarks ?? null;
    }

    const [updated] = await tx
      .update(stockReturnBatches)
      .set(setClause)
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.version, input.expectedVersion),
          eq(stockReturnBatches.status, "DRAFT"),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    return { ...updated, lines };
  });
}

export async function submitStockReturnBatch(
  db: DB,
  input: SubmitStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, true);

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    if (batch.status !== "DRAFT") {
      throw new StockReturnError(
        "INVALID_TRANSITION",
        `Stock return batch ${batch.documentNo} is ${batch.status}; expected DRAFT.`,
        409,
      );
    }
    if (batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const storedLines = await fetchLines(tx, batch.id);
    if (storedLines.length === 0) {
      throw new StockReturnError(
        "VALIDATION",
        `Stock return batch ${batch.documentNo} has no lines to submit.`,
        400,
      );
    }

    // Eligibility (warehouse/item/lot/uom) may have drifted since DRAFT
    // creation; re-run the same validation against the stored lines.
    await resolveAndValidateLines(
      tx,
      batch.sourceLocationId,
      storedLines.map((line) => ({
        itemId: line.itemId,
        lotId: line.lotId,
        sourceWarehouseId: line.sourceWarehouseId,
        enteredQuantity: line.enteredQuantity,
        enteredUom: line.enteredUom,
        reasonCode: line.reasonCode,
        remarks: line.remarks,
        evidenceRef: line.evidenceRef,
      })),
    );

    const hq = await resolveHqDestination(tx);
    if (hq.locationId !== batch.destinationLocationId || hq.warehouseId !== batch.destinationWarehouseId) {
      throw new StockReturnError(
        "TOPOLOGY_NOT_READY",
        "HQ_MAIN topology changed since this batch was drafted.",
        503,
      );
    }

    const dispatchDoc = await ensureOperationalDocument(
      tx,
      STOCK_RETURN_DISPATCH_MODULE,
      batch.documentNo,
      batch.sourceLocationId,
      "APPROVED",
      actor.id,
    );
    const receiptDoc = await ensureOperationalDocument(
      tx,
      STOCK_RETURN_RECEIPT_MODULE,
      batch.documentNo,
      batch.destinationLocationId,
      "DISPATCHED",
      actor.id,
    );

    const [updated] = await tx
      .update(stockReturnBatches)
      .set({
        status: "SUBMITTED",
        submittedBy: actor.id,
        submittedAt: new Date(),
        dispatchDocumentId: dispatchDoc.id,
        receiptDocumentId: receiptDoc.id,
        version: batch.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.status, "DRAFT"),
          eq(stockReturnBatches.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: batch.sourceLocationId,
      action: "stock_return.submitted",
      description: `Submitted stock return batch ${batch.documentNo}.`,
      entityType: "stock_return_batch",
      entityId: batch.id,
    });

    return { ...updated, lines: storedLines };
  });
}

export async function approveStockReturnBatch(
  db: DB,
  input: ApproveStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(
      tx,
      input.actorUserId,
      input.sessionId,
      STOCK_RETURN_APPROVE_ROLES,
      true,
    );

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    if (batch.status !== "SUBMITTED") {
      throw new StockReturnError(
        "INVALID_TRANSITION",
        `Stock return batch ${batch.documentNo} is ${batch.status}; expected SUBMITTED.`,
        409,
      );
    }
    if (batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (actor.id === batch.submittedBy) {
      throw new StockReturnError(
        "SEGREGATION_OF_DUTIES",
        "The submitter and approver must be different actors.",
        409,
      );
    }

    const [updated] = await tx
      .update(stockReturnBatches)
      .set({
        status: "APPROVED",
        approvedBy: actor.id,
        approvedAt: new Date(),
        version: batch.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.status, "SUBMITTED"),
          eq(stockReturnBatches.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: batch.sourceLocationId,
      action: "stock_return.approved",
      description: `Approved stock return batch ${batch.documentNo}.`,
      entityType: "stock_return_batch",
      entityId: batch.id,
    });

    const lines = await fetchLines(tx, batch.id);
    return { ...updated, lines };
  });
}

export async function cancelStockReturnBatch(
  db: DB,
  input: CancelStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, true);

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    if (!["DRAFT", "SUBMITTED"].includes(batch.status)) {
      throw new StockReturnError(
        "INVALID_TRANSITION",
        `Stock return batch ${batch.documentNo} is ${batch.status}; cancel only allowed from DRAFT or SUBMITTED.`,
        409,
      );
    }
    if (batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (!input.cancelReason?.trim()) {
      throw new StockReturnError("VALIDATION", "A cancellation reason is required.", 400);
    }

    const [updated] = await tx
      .update(stockReturnBatches)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.id,
        cancelledAt: new Date(),
        cancelReason: input.cancelReason,
        version: batch.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.status, batch.status),
          eq(stockReturnBatches.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: batch.sourceLocationId,
      action: "stock_return.cancelled",
      description: `Cancelled stock return batch ${batch.documentNo}: ${input.cancelReason}.`,
      entityType: "stock_return_batch",
      entityId: batch.id,
    });

    const lines = await fetchLines(tx, batch.id);
    return { ...updated, lines };
  });
}

interface StockPostingServiceLike {
  post(input: StockPostingInput): Promise<StockPostingResult>;
}

interface DispatchStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
}

/**
 * Posts one OUT CUSTODY_MOVE stock movement per batch line, from the batch's
 * own source outlet, through the central stock posting service, then advances
 * the batch APPROVED -> DISPATCHED. The posting call and the batch update are
 * deliberately two separate transactions (posting-service owns its own
 * db.transaction internally; nesting a second db.transaction around it on the
 * same `db` would open a second connection and self-deadlock on the batch/
 * document rows already locked here). Safety across that gap:
 *  - The linked STOCK_RETURN_DISPATCH operational_document is looked up/created
 *    deterministically from the batch's own document number, then compensated
 *    (deleted) if the posting call fails, so a failed dispatch never leaves a
 *    dangling document behind.
 *  - The idempotency/correlation id for the posting call is derived from the
 *    batch's dispatch document number alone (never a per-call random value),
 *    so a retry with the same batch always replays the same posting instead
 *    of double-posting.
 *  - The batch's own APPROVED -> DISPATCHED update is a conditional UPDATE
 *    guarded by status+version; if it matches zero rows after a successful
 *    (possibly replayed) posting, the batch was already advanced by an
 *    earlier attempt and the current row is returned as-is (replay-safe).
 */
export async function dispatchStockReturnBatch(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: DispatchStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, true);

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    if (batch.status !== "APPROVED" && batch.status !== "DISPATCHED") {
      throw new StockReturnError(
        "INVALID_TRANSITION",
        `Stock return batch ${batch.documentNo} is ${batch.status}; expected APPROVED.`,
        409,
      );
    }
    // Once DISPATCHED, a caller retrying with its original pre-dispatch
    // version is doing an idempotent replay, not a stale write; only an
    // in-flight APPROVED batch enforces the optimistic version match.
    if (batch.status === "APPROVED" && batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, batch.id);
    const dispatchDocumentNo = `${batch.documentNo}:DISPATCH`;
    const dispatchDoc = await ensureOperationalDocument(
      tx,
      STOCK_RETURN_DISPATCH_MODULE,
      dispatchDocumentNo,
      batch.sourceLocationId,
      "APPROVED",
      actor.id,
    );

    return { actor, batch, lines, dispatchDocumentNo, dispatchDocId: dispatchDoc.id };
  });

  const { actor, batch, lines, dispatchDocumentNo, dispatchDocId } = prepared;

  const postingInput: StockPostingInput = {
    idempotencyKey: dispatchDocumentNo,
    sourceModule: STOCK_RETURN_DISPATCH_MODULE,
    sourceDocumentNo: dispatchDocumentNo,
    locationId: batch.sourceLocationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: dispatchDocumentNo,
    movements: lines.map((line) => ({
      warehouseId: line.sourceWarehouseId,
      itemId: line.itemId,
      lotId: line.lotId,
      movementType: "OUT",
      quantity: line.quantity,
      enteredQuantity: line.enteredQuantity,
      enteredUom: line.enteredUom,
      conversionFactor: line.conversionFactor,
      reasonCode: line.reasonCode,
      sourcePolicy: "CUSTODY_MOVE",
      metadata: { stockReturnBatchLineId: line.id, lineNo: line.lineNo },
    })),
  };

  try {
    await stockPostingService.post(postingInput);
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
    const [updated] = await tx
      .update(stockReturnBatches)
      .set({
        status: "DISPATCHED",
        dispatchedBy: actor.id,
        dispatchedAt: new Date(),
        version: batch.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.status, "APPROVED"),
          eq(stockReturnBatches.version, input.expectedVersion),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(stockReturnBatches).where(eq(stockReturnBatches.id, batch.id));
      if (current?.status === "DISPATCHED") {
        return { ...current, lines };
      }
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: batch.sourceLocationId,
      action: "stock_return.dispatched",
      description: `Dispatched stock return batch ${batch.documentNo}.`,
      entityType: "stock_return_batch",
      entityId: batch.id,
    });

    return { ...updated, lines };
  });
}

/**
 * Posts a QUARANTINE-IN per batch line, against a deterministic precreated
 * (or idempotently created) quarantine lot, through the central stock posting
 * service, then advances the batch DISPATCHED -> RECEIVED_DISPOSED. Whether a
 * line also posts a paired DISPOSITION-OUT for the same quantity depends on
 * its HQ-assigned dispositionReasonCode (D35-D46 §5): every disposition
 * reason (everything outside QA_RELEASE_RELEASABLE_REASONS) keeps the
 * original atomic IN+OUT write-off behavior unchanged; a reusable reason
 * (currently only OTHER) posts the IN alone, tagged QUARANTINE_HOLD, leaving
 * a positive quarantine balance a separate QA Release can later move to
 * HQ_MAIN. Mirrors dispatchStockReturnBatch()'s two-transaction shape
 * (prepare / post / finalize) for the same reason: the posting call owns its
 * own db.transaction internally, so it can't be nested inside either
 * surrounding transaction without self-deadlocking on the batch/document rows
 * already locked here.
 *  - The quarantine lot, its outlet-lot genealogy link, and the linked
 *    STOCK_RETURN_RECEIPT operational_document are all established
 *    idempotently in the prepare transaction, so a retry after a mid-flight
 *    failure always reuses the same lot/genealogy/document instead of
 *    minting duplicates.
 *  - The idempotency/correlation id for the posting call is derived from the
 *    batch's own receipt document number alone, so a retry with the same
 *    batch + receipt inputs always replays the same posting instead of
 *    double-posting.
 *  - Posting-line ids are recovered from the completed/replayed posting by
 *    metadata (batch line id + movement type), not by array position, since
 *    the posting service internally sorts/groups movements and no longer
 *    guarantees the caller's original ordering.
 *  - The batch's own DISPATCHED -> RECEIVED_DISPOSED update is a conditional
 *    UPDATE guarded by status+version; if it matches zero rows after a
 *    successful (possibly replayed) posting, the batch was already advanced
 *    by an earlier attempt and the current row is returned as-is.
 */
export async function receiveAndDisposeStockReturnBatch(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: ReceiveAndDisposeStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_RECEIVE_ROLES, true);

    const batch = await lockBatch(tx, input.batchId);
    assertLocationInScope(actor.allowedLocationIds, batch.destinationLocationId);

    if (batch.status !== "DISPATCHED" && batch.status !== "RECEIVED_DISPOSED") {
      throw new StockReturnError(
        "INVALID_TRANSITION",
        `Stock return batch ${batch.documentNo} is ${batch.status}; expected DISPATCHED.`,
        409,
      );
    }
    // Once RECEIVED_DISPOSED, a caller retrying with its original pre-receipt
    // version is doing an idempotent replay, not a stale write; only an
    // in-flight DISPATCHED batch enforces the optimistic version match.
    if (batch.status === "DISPATCHED" && batch.version !== input.expectedVersion) {
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} version ${batch.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, batch.id);
    const receiptByBatchLineId = validateReceiptLines(lines, input.receiptLines);

    const hq = await resolveHqDestination(tx);
    if (hq.locationId !== batch.destinationLocationId || hq.warehouseId !== batch.destinationWarehouseId) {
      throw new StockReturnError(
        "TOPOLOGY_NOT_READY",
        "HQ_MAIN topology changed since this batch was dispatched.",
        503,
      );
    }

    const receiptDocumentNo = `${batch.documentNo}:RECEIPT`;
    const receiptDoc = await ensureOperationalDocument(
      tx,
      STOCK_RETURN_RECEIPT_MODULE,
      receiptDocumentNo,
      batch.destinationLocationId,
      "DISPATCHED",
      actor.id,
    );

    const lotIds = [...new Set(lines.map((line) => line.lotId))];
    const lotRows = await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, lotIds));
    const lotsById = new Map(lotRows.map((row) => [row.id, row]));

    const quarantineLotByLineId = new Map<string, string>();
    for (const line of lines) {
      const originalLot = lotsById.get(line.lotId)!;
      const lotCode = `RETURN:${batch.id}:${line.lineNo}`;
      const qLot = await ensureQuarantineLot(tx, line.itemId, lotCode, originalLot.unitCost, line.id);
      await ensureLotGenealogy(tx, line.lotId, qLot.id, line.quantity, receiptDocumentNo);
      quarantineLotByLineId.set(line.id, qLot.id);
    }

    return {
      actor,
      batch,
      lines,
      receiptByBatchLineId,
      receiptDocumentNo,
      receiptDocId: receiptDoc.id,
      quarantineWarehouseId: hq.quarantineWarehouseId,
      quarantineLotByLineId,
    };
  });

  const {
    actor,
    batch,
    lines,
    receiptByBatchLineId,
    receiptDocumentNo,
    receiptDocId,
    quarantineWarehouseId,
    quarantineLotByLineId,
  } = prepared;

  const movements: StockPostingInput["movements"] = [];
  for (const line of lines) {
    const qLotId = quarantineLotByLineId.get(line.id)!;
    const receiptLine = receiptByBatchLineId.get(line.id)!;
    // D35-D46 §5: only a reusable disposition reason (QA_RELEASE_RELEASABLE_
    // REASONS, currently just OTHER) leaves stock quarantined for a later QA
    // Release; every other reason keeps today's atomic write-off unchanged.
    const isReusable = QA_RELEASE_RELEASABLE_REASONS.has(receiptLine.dispositionReasonCode);
    movements.push({
      warehouseId: quarantineWarehouseId,
      itemId: line.itemId,
      lotId: qLotId,
      movementType: "IN",
      quantity: line.quantity,
      enteredQuantity: line.enteredQuantity,
      enteredUom: line.enteredUom,
      conversionFactor: line.conversionFactor,
      reasonCode: line.reasonCode,
      sourcePolicy: isReusable ? "QUARANTINE_HOLD" : undefined,
      metadata: { stockReturnBatchLineId: line.id, lineNo: line.lineNo },
    });
    if (!isReusable) {
      movements.push({
        warehouseId: quarantineWarehouseId,
        itemId: line.itemId,
        lotId: qLotId,
        movementType: "OUT",
        quantity: line.quantity,
        enteredQuantity: line.enteredQuantity,
        enteredUom: line.enteredUom,
        conversionFactor: line.conversionFactor,
        reasonCode: receiptLine.dispositionReasonCode,
        sourcePolicy: "DISPOSITION",
        metadata: {
          stockReturnBatchLineId: line.id,
          lineNo: line.lineNo,
          dispositionRemarks: receiptLine.dispositionRemarks ?? null,
        },
      });
    }
  }

  const postingInput: StockPostingInput = {
    idempotencyKey: receiptDocumentNo,
    sourceModule: STOCK_RETURN_RECEIPT_MODULE,
    sourceDocumentNo: receiptDocumentNo,
    locationId: batch.destinationLocationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: receiptDocumentNo,
    movements,
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
    const postingLineIdByKey = new Map<string, string>();
    for (const row of postingLineRows) {
      const metadata = row.metadata as { stockReturnBatchLineId?: string } | null;
      if (metadata?.stockReturnBatchLineId) {
        postingLineIdByKey.set(`${metadata.stockReturnBatchLineId}:${row.movementType}`, row.id);
      }
    }

    for (const line of lines) {
      const receiptLine = receiptByBatchLineId.get(line.id)!;
      const qLotId = quarantineLotByLineId.get(line.id)!;
      const isReusable = QA_RELEASE_RELEASABLE_REASONS.has(receiptLine.dispositionReasonCode);
      const inId = postingLineIdByKey.get(`${line.id}:IN`);
      const outId = postingLineIdByKey.get(`${line.id}:OUT`) ?? null;
      if (!inId || (!isReusable && !outId)) {
        throw new StockReturnError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve posting lines for batch line ${line.id}.`,
          409,
        );
      }
      await ensureReceiptLine(
        tx,
        line.id,
        qLotId,
        line.quantity,
        receiptLine.dispositionReasonCode,
        receiptLine.dispositionRemarks ?? null,
        inId,
        outId,
      );
    }

    const [updated] = await tx
      .update(stockReturnBatches)
      .set({
        status: "RECEIVED_DISPOSED",
        receivedBy: actor.id,
        receivedAt: new Date(),
        version: batch.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockReturnBatches.id, batch.id),
          eq(stockReturnBatches.status, "DISPATCHED"),
          eq(stockReturnBatches.version, input.expectedVersion),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(stockReturnBatches).where(eq(stockReturnBatches.id, batch.id));
      if (current?.status === "RECEIVED_DISPOSED") {
        return { ...current, lines };
      }
      throw new StockReturnError(
        "CONCURRENT_MODIFICATION",
        `Stock return batch ${batch.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: batch.destinationLocationId,
      action: "stock_return.received_disposed",
      description: `Received and disposed stock return batch ${batch.documentNo}.`,
      entityType: "stock_return_batch",
      entityId: batch.id,
    });

    return { ...updated, lines };
  });
}

export async function getStockReturnBatch(
  db: DB,
  input: GetStockReturnBatchInput,
): Promise<StockReturnBatchWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, false);

    const [batch] = await tx.select().from(stockReturnBatches).where(eq(stockReturnBatches.id, input.batchId));
    if (!batch) {
      throw new StockReturnError("NOT_FOUND", `Stock return batch ${input.batchId} was not found.`, 404);
    }
    assertLocationInScope(actor.allowedLocationIds, batch.sourceLocationId);

    const lines = await fetchLines(tx, batch.id);
    return { ...batch, lines };
  });
}

/**
 * Shared actor-scope + filter resolution for the two read paths below (list
 * page contents and its total count), so a caller can never see a total that
 * was computed under different scoping than the rows it paginates.
 */
async function resolveListConditions(tx: Tx, input: ListStockReturnBatchesInput) {
  const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_RETURN_ROLES, false);

  const conditions = [];
  if (actor.allowedLocationIds !== null) {
    if (input.sourceLocationId) {
      if (!actor.allowedLocationIds.includes(input.sourceLocationId)) {
        throw new StockReturnError(
          "UNAUTHORIZED",
          "The requested outlet is outside the actor's outlet scope.",
          403,
        );
      }
      conditions.push(eq(stockReturnBatches.sourceLocationId, input.sourceLocationId));
    } else {
      conditions.push(inArray(stockReturnBatches.sourceLocationId, actor.allowedLocationIds));
    }
  } else if (input.sourceLocationId) {
    conditions.push(eq(stockReturnBatches.sourceLocationId, input.sourceLocationId));
  }
  if (input.status) {
    conditions.push(eq(stockReturnBatches.status, input.status));
  }
  if (input.search?.trim()) {
    conditions.push(ilike(stockReturnBatches.documentNo, `%${input.search.trim()}%`));
  }

  return { actor, conditions };
}

export async function listStockReturnBatches(
  db: DB,
  input: ListStockReturnBatchesInput,
): Promise<StockReturnBatch[]> {
  return db.transaction(async (tx) => {
    const { conditions } = await resolveListConditions(tx, input);

    // Callers that don't pass limit/offset (e.g. the pre-existing lifecycle
    // test) get every matching row, exactly as before this function grew
    // pagination support.
    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;

    const query = tx.select().from(stockReturnBatches);
    const ordered =
      conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(stockReturnBatches.createdAt))
        : query.orderBy(desc(stockReturnBatches.createdAt));
    return ordered.limit(limit).offset(offset);
  });
}

/** Total row count for the same actor-scope + filters {@link listStockReturnBatches} applies. */
export async function countStockReturnBatches(
  db: DB,
  input: ListStockReturnBatchesInput,
): Promise<number> {
  return db.transaction(async (tx) => {
    const { conditions } = await resolveListConditions(tx, input);
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(stockReturnBatches)
      .where(conditions.length > 0 ? and(...conditions) : sql`true`);
    return row?.count ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface StockReturnActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

interface CreateDraftServiceInput {
  sourceLocationId: string;
  destinationLocationId?: string;
  destinationWarehouseId?: string;
  remarks?: string | null;
  lines: StockReturnLineInput[];
}

interface UpdateDraftLinesServiceInput {
  batchId: string;
  version: number;
  remarks?: string | null;
  lines?: StockReturnLineInput[];
}

interface SubmitServiceInput {
  batchId: string;
  version: number;
}

interface ApproveServiceInput {
  batchId: string;
  version: number;
}

interface CancelServiceInput {
  batchId: string;
  version: number;
  cancelReason: string;
}

interface DispatchServiceInput {
  batchId: string;
  version: number;
}

interface ReceiptLineServiceInput {
  batchLineId: string;
  dispositionReasonCode: string;
  dispositionRemarks?: string | null;
}

interface ReceiveAndDisposeServiceInput {
  batchId: string;
  version: number;
  receiptLines: ReceiptLineServiceInput[];
}

interface GetServiceInput {
  batchId: string;
}

type ListServiceInput = Omit<ListStockReturnBatchesInput, "actorUserId" | "sessionId">;

/** Facade over the standalone lifecycle functions above. */
export function createStockReturnService(db: DB) {
  const stockPostingService = createStockPostingService(db, {
    documentPolicies: {
      [STOCK_RETURN_DISPATCH_MODULE]: STOCK_RETURN_DISPATCH_POLICY,
      [STOCK_RETURN_RECEIPT_MODULE]: STOCK_RETURN_RECEIPT_POLICY,
    },
  });
  return {
    createDraft(ctx: StockReturnActorContext, input: CreateDraftServiceInput) {
      return createStockReturnDraft(db, { ...ctx, ...input });
    },
    updateDraftLines(ctx: StockReturnActorContext, input: UpdateDraftLinesServiceInput) {
      const { batchId, version, ...rest } = input;
      return updateStockReturnDraft(db, { ...ctx, batchId, expectedVersion: version, ...rest });
    },
    submit(ctx: StockReturnActorContext, input: SubmitServiceInput) {
      return submitStockReturnBatch(db, { ...ctx, batchId: input.batchId, expectedVersion: input.version });
    },
    approve(ctx: StockReturnActorContext, input: ApproveServiceInput) {
      return approveStockReturnBatch(db, { ...ctx, batchId: input.batchId, expectedVersion: input.version });
    },
    cancel(ctx: StockReturnActorContext, input: CancelServiceInput) {
      return cancelStockReturnBatch(db, {
        ...ctx,
        batchId: input.batchId,
        expectedVersion: input.version,
        cancelReason: input.cancelReason,
      });
    },
    dispatch(ctx: StockReturnActorContext, input: DispatchServiceInput): Promise<StockReturnBatchWithLines> {
      return dispatchStockReturnBatch(db, stockPostingService, {
        ...ctx,
        batchId: input.batchId,
        expectedVersion: input.version,
      });
    },
    receiveAndDispose(
      ctx: StockReturnActorContext,
      input: ReceiveAndDisposeServiceInput,
    ): Promise<StockReturnBatchWithLines> {
      return receiveAndDisposeStockReturnBatch(db, stockPostingService, {
        ...ctx,
        batchId: input.batchId,
        expectedVersion: input.version,
        receiptLines: input.receiptLines as ReceiptLineInput[],
      });
    },
    get(ctx: StockReturnActorContext, input: GetServiceInput) {
      return getStockReturnBatch(db, { ...ctx, batchId: input.batchId });
    },
    list(ctx: StockReturnActorContext, input: ListServiceInput) {
      return listStockReturnBatches(db, { ...ctx, ...input });
    },
    count(ctx: StockReturnActorContext, input: ListServiceInput) {
      return countStockReturnBatches(db, { ...ctx, ...input });
    },
  };
}
