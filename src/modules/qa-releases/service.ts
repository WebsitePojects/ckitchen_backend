/**
 * QA Release service: create/update/submit/approve/cancel/read plus the
 * single stock-posting release() phase, routed through the central
 * src/modules/stock/posting-service.ts (QA_RELEASE route class) against the
 * release's own release operational_document row (transfer-orders-schema.ts's
 * `releaseDocumentId` column — set once, never repointed).
 *
 * Architectural template: src/modules/transfers/service.ts (closest
 * single-stock-affecting-phase module — QA Release's release() mirrors
 * transfers' dispatchTransferOrder()/receiveTransferOrder() shape, but as
 * ONE phase instead of two, matching this module's own single `RELEASED`
 * terminal status). Line/UOM resolution borrows from
 * src/modules/stock-returns/service.ts's resolveAndValidateLines(), adapted
 * for qa_release_line's single `releaseQuantity` (base-quantity) column
 * instead of returns'/transfers' separate entered/base quantity pair.
 *
 * D35-D46 §5 invariant this module exists to enforce: "a reusable return may
 * remain quarantined until a separate QA Release moves it to HQ_MAIN" — and,
 * by construction, disposition-reason stock (SPOILED/EXPIRED/DAMAGED/
 * RECALLED) can NEVER reach HQ_MAIN through this module (see
 * QA_RELEASE_RELEASABLE_REASONS in policies.ts and the REASON_NOT_RELEASABLE
 * gate in resolveAndValidateLines() below).
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
import { stockReturnReceiptLines } from "../../db/returns-schema.js";
import { auditLogs, ingredients, userOutletAccess, users, userSessions, warehouses } from "../../db/schema.js";
import type { Role } from "../../db/schema.js";
import { qaReleaseLines, qaReleases } from "../../db/transfer-orders-schema.js";
import { normalizeRole, outletScopeForRole } from "../auth/roles.js";
import { DecimalValidationError, formatFixed, multiplyFixedExact, normalizeFixed, parseFixed } from "../stock/decimal.js";
import { createStockPostingService } from "../stock/posting-service.js";
import type { StockPostingInput, StockPostingResult } from "../stock/types.js";
import { QaReleaseError } from "./errors.js";
import {
  QA_RELEASE_APPROVE_ROLES,
  QA_RELEASE_FEATURE_KEY,
  QA_RELEASE_MAX_LINES,
  QA_RELEASE_MIN_LINES,
  QA_RELEASE_MODULE,
  QA_RELEASE_POSTING_POLICY,
  QA_RELEASE_RELEASABLE_REASONS,
  QA_RELEASE_ROLES,
} from "./policies.js";
import type {
  ApproveQaReleaseInput,
  CancelQaReleaseInput,
  CreateQaReleaseInput,
  GetQaReleaseInput,
  ListQaReleasesInput,
  QaRelease,
  QaReleaseLine,
  QaReleaseLineInput,
  QaReleaseWithLines,
  ReleaseQaReleaseInput,
  SubmitQaReleaseInput,
  UpdateQaReleaseInput,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

interface ResolvedLine {
  lineNo: number;
  itemId: string;
  quarantineLotId: string;
  sourceReturnReceiptLineId: string;
  /** Base-UOM quantity (qa_release_line has one quantity column, unlike
   * transfer_order_line/stock_return_batch_line's entered+base pair). */
  releaseQuantity: string;
  enteredUom: string;
  conversionFactor: string;
  remarks: string | null;
}

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
    throw new QaReleaseError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this QA release operation.",
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
      throw new QaReleaseError("UNAUTHORIZED", "The actor session is not active.", 401);
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
    throw new QaReleaseError("UNAUTHORIZED", "The QA release is outside the actor's outlet scope.", 403);
  }
}

async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, QA_RELEASE_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new QaReleaseError(
      "FEATURE_DISABLED",
      `Operational feature "${QA_RELEASE_FEATURE_KEY}" is disabled.`,
      503,
      { feature: QA_RELEASE_FEATURE_KEY },
    );
  }
}

/**
 * Resolves the fixed QUARANTINE -> HQ_MAIN route's two warehouses server-side
 * (never caller-supplied — same "never trust a client-declared route"
 * convention as stock-returns/service.ts's resolveHqDestination(), which this
 * mirrors). Also enforced independently at the DB layer by the
 * qa_release_route_check trigger (drizzle/0031) once the header is inserted.
 */
async function resolveHqTopology(
  tx: Tx,
): Promise<{ hqLocationId: string; hqMainWarehouseId: string; quarantineWarehouseId: string }> {
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
    throw new QaReleaseError(
      "TOPOLOGY_NOT_READY",
      "Enterprise warehouse topology is not ready for QA release.",
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
    throw new QaReleaseError(
      "TOPOLOGY_NOT_READY",
      "HQ does not have exactly one active quarantine warehouse configured.",
      503,
      { activeQuarantineCount: quarantineRows.length },
    );
  }

  return { hqLocationId: hq.locationId, hqMainWarehouseId: hq.id, quarantineWarehouseId: quarantineRows[0]!.id };
}

/**
 * Resolves + validates a QA release's line set against its provenance
 * (stock_return_receipt_line), enforcing:
 *  - REASON_NOT_RELEASABLE for any disposition reason outside
 *    QA_RELEASE_RELEASABLE_REASONS (D35-D46 §5's core invariant: disposition-
 *    reason stock never becomes allocatable HQ stock);
 *  - INSUFFICIENT_QUARANTINE_BALANCE against the receipt line's own
 *    receivedQuantity minus every sibling (other QA release) ACTIVE/RELEASED
 *    releaseQuantity already booked against it.
 *
 * Concurrency: locks each distinct referenced stock_return_receipt_line row
 * FOR UPDATE, sorted by id, BEFORE summing sibling qa_release_line rows —
 * this function's own INSERT (via the caller) is the only write, with no
 * subsequent posting-service call to serve as a safety net at booking time
 * (unlike dispatch/receive's FEFO lot selection, whose real safety net is the
 * posting service's own balance check), so this function itself must be the
 * serialization point. Mirrors
 * src/modules/customer-orders/allocation.ts's selectFefoAllocationPortions()
 * doc comment describing the identical pattern for allocate().
 */
async function resolveAndValidateLines(
  tx: Tx,
  lines: QaReleaseLineInput[],
  excludeReleaseId?: string,
): Promise<ResolvedLine[]> {
  if (lines.length < QA_RELEASE_MIN_LINES || lines.length > QA_RELEASE_MAX_LINES) {
    throw new QaReleaseError(
      "VALIDATION",
      `A QA release must contain between ${QA_RELEASE_MIN_LINES} and ${QA_RELEASE_MAX_LINES} line(s).`,
      400,
    );
  }

  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (seen.has(line.sourceReturnReceiptLineId)) {
      throw new QaReleaseError(
        "DUPLICATE_LINE",
        `Duplicate line for return receipt line ${line.sourceReturnReceiptLineId}.`,
        400,
        { sourceReturnReceiptLineId: line.sourceReturnReceiptLineId },
      );
    }
    seen.add(line.sourceReturnReceiptLineId);
    if (!line.enteredUom.trim()) {
      throw new QaReleaseError("VALIDATION", `Line ${index + 1} is missing an entered UOM.`, 400);
    }
    try {
      if (parseFixed(line.enteredQuantity, 6) <= 0n) {
        throw new QaReleaseError("VALIDATION", `Line ${index + 1} quantity must be positive.`, 400);
      }
    } catch (error) {
      if (error instanceof QaReleaseError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new QaReleaseError("VALIDATION", `Line ${index + 1}: ${error.message}`, 400);
      }
      throw error;
    }
  });

  const sortedReceiptLineIds = [...new Set(lines.map((line) => line.sourceReturnReceiptLineId))].sort();
  const receiptRows: (typeof stockReturnReceiptLines.$inferSelect)[] = [];
  for (const id of sortedReceiptLineIds) {
    const [row] = await tx
      .select()
      .from(stockReturnReceiptLines)
      .where(eq(stockReturnReceiptLines.id, id))
      .for("update");
    if (!row) {
      throw new QaReleaseError(
        "VALIDATION",
        `Stock return receipt line ${id} was not found.`,
        404,
        { sourceReturnReceiptLineId: id },
      );
    }
    receiptRows.push(row);
  }
  const receiptById = new Map(receiptRows.map((row) => [row.id, row]));

  const lotIds = [...new Set(receiptRows.map((row) => row.quarantineLotId))];
  const lotRows = await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, lotIds));
  const lotsById = new Map(lotRows.map((row) => [row.id, row]));

  const itemIds = [...new Set(lotRows.map((row) => row.itemId))];
  const itemRows = itemIds.length ? await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds)) : [];
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));

  const conversionByKey = new Map<string, string>();
  const conversionKeys = [
    ...new Set(
      lines.map((line) => {
        const receipt = receiptById.get(line.sourceReturnReceiptLineId)!;
        const lot = lotsById.get(receipt.quarantineLotId);
        const itemId = lot?.itemId ?? "";
        return `${itemId}:${line.enteredUom.trim().toLowerCase()}`;
      }),
    ),
  ];
  for (const conversionKey of conversionKeys) {
    const separator = conversionKey.indexOf(":");
    const itemId = conversionKey.slice(0, separator);
    const enteredUom = conversionKey.slice(separator + 1);
    const item = itemsById.get(itemId);
    if (!item) continue; // resolved to LOT_NOT_ELIGIBLE/VALIDATION below
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
      throw new QaReleaseError(
        "UOM_MISMATCH",
        `No active ${enteredUom} conversion exists for item ${itemId}.`,
        409,
      );
    }
    conversionByKey.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  // Sibling releaseQuantity sums: lock qa_release_line rows referencing the
  // same receipt lines (single-table lock, mirroring allocation.ts's
  // customerOrderAllocations FOR UPDATE), then read the parent qa_release
  // rows' status separately (plain SELECT — READ COMMITTED already sees
  // every row the lock above serialized against).
  const siblingLineRows = await tx
    .select({
      sourceReturnReceiptLineId: qaReleaseLines.sourceReturnReceiptLineId,
      releaseQuantity: qaReleaseLines.releaseQuantity,
      releaseId: qaReleaseLines.releaseId,
    })
    .from(qaReleaseLines)
    .where(inArray(qaReleaseLines.sourceReturnReceiptLineId, sortedReceiptLineIds))
    .for("update");
  const siblingReleaseIds = [...new Set(siblingLineRows.map((row) => row.releaseId))];
  const siblingReleaseRows = siblingReleaseIds.length
    ? await tx
        .select({ id: qaReleases.id, status: qaReleases.status })
        .from(qaReleases)
        .where(inArray(qaReleases.id, siblingReleaseIds))
    : [];
  const releaseStatusById = new Map(siblingReleaseRows.map((row) => [row.id, row.status]));

  const siblingSumById = new Map<string, bigint>();
  for (const row of siblingLineRows) {
    if (releaseStatusById.get(row.releaseId) === "CANCELLED") continue;
    if (excludeReleaseId && row.releaseId === excludeReleaseId) continue;
    const current = siblingSumById.get(row.sourceReturnReceiptLineId) ?? 0n;
    siblingSumById.set(row.sourceReturnReceiptLineId, current + parseFixed(row.releaseQuantity, 6));
  }

  const resolved: ResolvedLine[] = [];
  lines.forEach((line, index) => {
    const receipt = receiptById.get(line.sourceReturnReceiptLineId)!;
    const lot = lotsById.get(receipt.quarantineLotId);
    if (!lot) {
      throw new QaReleaseError(
        "VALIDATION",
        `Quarantine lot ${receipt.quarantineLotId} was not found.`,
        404,
      );
    }
    if (lot.status === "DISPOSED" || lot.status === "EXHAUSTED") {
      throw new QaReleaseError(
        "LOT_NOT_ELIGIBLE",
        `Lot ${lot.lotCode} (${lot.status}) is not eligible for QA release.`,
        409,
        { lotId: lot.id, status: lot.status },
      );
    }
    if (!QA_RELEASE_RELEASABLE_REASONS.has(receipt.dispositionReasonCode)) {
      throw new QaReleaseError(
        "REASON_NOT_RELEASABLE",
        `Return receipt line ${receipt.id} was received under disposition reason ${receipt.dispositionReasonCode}, which is never releasable to HQ_MAIN.`,
        409,
        { sourceReturnReceiptLineId: receipt.id, dispositionReasonCode: receipt.dispositionReasonCode },
      );
    }

    const conversionKey = `${lot.itemId}:${line.enteredUom.trim().toLowerCase()}`;
    const conversionFactor = conversionByKey.get(conversionKey)!;
    let baseQuantity: string;
    try {
      baseQuantity = multiplyFixedExact(line.enteredQuantity, 6, conversionFactor, 8, 6);
    } catch (error) {
      if (error instanceof DecimalValidationError) {
        throw new QaReleaseError("UOM_MISMATCH", `Line ${index + 1}: ${error.message}`, 409);
      }
      throw error;
    }

    const receivedBase = parseFixed(receipt.receivedQuantity, 6);
    const alreadyReleased = siblingSumById.get(receipt.id) ?? 0n;
    const remaining = receivedBase - alreadyReleased;
    const requestedBase = parseFixed(baseQuantity, 6);
    if (requestedBase > remaining) {
      throw new QaReleaseError(
        "INSUFFICIENT_QUARANTINE_BALANCE",
        `Line ${index + 1} requests ${formatFixed(requestedBase, 6)} but only ${formatFixed(
          remaining < 0n ? 0n : remaining,
          6,
        )} remains quarantined for receipt line ${receipt.id}.`,
        409,
        {
          sourceReturnReceiptLineId: receipt.id,
          remaining: formatFixed(remaining < 0n ? 0n : remaining, 6),
          requested: formatFixed(requestedBase, 6),
        },
      );
    }

    resolved.push({
      lineNo: index + 1,
      itemId: lot.itemId,
      quarantineLotId: lot.id,
      sourceReturnReceiptLineId: receipt.id,
      releaseQuantity: baseQuantity,
      enteredUom: line.enteredUom,
      conversionFactor,
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
    throw new QaReleaseError(
      "CONCURRENT_MODIFICATION",
      `Failed to establish ${moduleName} document ${documentNo}.`,
      409,
    );
  }
  return existing;
}

/**
 * Idempotent insert-or-fetch for the deterministic HQ_MAIN lot a QA release
 * line's released quantity lands in (`QA-RELEASE:<releaseId>:<lineNo>`), so a
 * retried release() call always reuses the same lot instead of minting a
 * duplicate under the (item, lot_code) unique index. Status AVAILABLE: this
 * IS the moment reusable quarantined stock becomes allocatable HQ_MAIN
 * inventory (D35-D46 §5).
 */
async function ensureReleasedLot(
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
      status: "AVAILABLE",
      unitCost,
      sourceDocumentType: "QA_RELEASE",
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
    throw new QaReleaseError("CONCURRENT_MODIFICATION", `Failed to establish released lot ${lotCode}.`, 409);
  }
  return existing;
}

/** Idempotent insert-or-ignore for the quarantine-lot -> released-lot genealogy link. */
async function ensureLotGenealogy(
  tx: Tx,
  parentLotId: string,
  childLotId: string,
  quantityConsumed: string,
  releaseDocumentNo: string,
): Promise<void> {
  await tx
    .insert(inventoryLotGenealogy)
    .values({ parentLotId, childLotId, quantityConsumed, productionDocumentNo: releaseDocumentNo })
    .onConflictDoNothing();
}

async function lockRelease(tx: Tx, releaseId: string): Promise<QaRelease> {
  const [release] = await tx.select().from(qaReleases).where(eq(qaReleases.id, releaseId)).for("update");
  if (!release) {
    throw new QaReleaseError("NOT_FOUND", `QA release ${releaseId} was not found.`, 404);
  }
  return release;
}

async function fetchLines(tx: Tx, releaseId: string): Promise<QaReleaseLine[]> {
  return tx
    .select()
    .from(qaReleaseLines)
    .where(eq(qaReleaseLines.releaseId, releaseId))
    .orderBy(asc(qaReleaseLines.lineNo));
}

// ---------------------------------------------------------------------------
// Exported lifecycle functions
// ---------------------------------------------------------------------------

export async function createQaReleaseDraft(db: DB, input: CreateQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, true);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    const resolvedLines = await resolveAndValidateLines(tx, input.lines);

    const [release] = await tx
      .insert(qaReleases)
      .values({
        documentNo: `QAR-${randomUUID()}`,
        sourceWarehouseId: topology.quarantineWarehouseId,
        destinationWarehouseId: topology.hqMainWarehouseId,
        remarks: input.remarks ?? null,
        createdBy: actor.id,
      })
      .returning();

    const lines = await tx
      .insert(qaReleaseLines)
      .values(resolvedLines.map((line) => ({ ...line, releaseId: release!.id })))
      .returning();
    lines.sort((a, b) => a.lineNo - b.lineNo);

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: topology.hqLocationId,
      action: "qa_release.created",
      description: `Created QA release ${release!.documentNo} with ${lines.length} line(s).`,
      entityType: "qa_release",
      entityId: release!.id,
    });

    return { ...release!, lines };
  });
}

export async function updateQaReleaseDraft(db: DB, input: UpdateQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, true);
    const release = await lockRelease(tx, input.releaseId);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    if (release.status !== "DRAFT") {
      throw new QaReleaseError("INVALID_TRANSITION", "Only DRAFT QA releases may be edited.", 409);
    }
    if (release.version !== input.expectedVersion) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} version ${release.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    let lines: QaReleaseLine[];
    if (input.lines) {
      const resolvedLines = await resolveAndValidateLines(tx, input.lines, release.id);
      await tx.delete(qaReleaseLines).where(eq(qaReleaseLines.releaseId, release.id));
      lines = await tx
        .insert(qaReleaseLines)
        .values(resolvedLines.map((line) => ({ ...line, releaseId: release.id })))
        .returning();
      lines.sort((a, b) => a.lineNo - b.lineNo);
    } else {
      lines = await fetchLines(tx, release.id);
    }

    const setClause: Partial<typeof qaReleases.$inferInsert> = {
      version: release.version + 1,
      updatedAt: new Date(),
    };
    if ("remarks" in input) {
      setClause.remarks = input.remarks ?? null;
    }

    const [updated] = await tx
      .update(qaReleases)
      .set(setClause)
      .where(
        and(
          eq(qaReleases.id, release.id),
          eq(qaReleases.version, input.expectedVersion),
          eq(qaReleases.status, "DRAFT"),
        ),
      )
      .returning();
    if (!updated) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} changed concurrently.`,
        409,
      );
    }

    return { ...updated, lines };
  });
}

export async function submitQaRelease(db: DB, input: SubmitQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, true);
    const release = await lockRelease(tx, input.releaseId);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    if (release.status !== "DRAFT") {
      throw new QaReleaseError(
        "INVALID_TRANSITION",
        `QA release ${release.documentNo} is ${release.status}; expected DRAFT.`,
        409,
      );
    }
    if (release.version !== input.expectedVersion) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} version ${release.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const storedLines = await fetchLines(tx, release.id);
    if (storedLines.length === 0) {
      throw new QaReleaseError("VALIDATION", `QA release ${release.documentNo} has no lines to submit.`, 400);
    }

    // Eligibility (reason/lot/remaining quarantined balance) may have drifted
    // since DRAFT creation or a sibling release booking against the same
    // receipt line; re-run the same validation against the stored lines,
    // excluding this release's own existing lines from the sibling sum.
    await resolveAndValidateLines(
      tx,
      storedLines.map((line) => ({
        sourceReturnReceiptLineId: line.sourceReturnReceiptLineId,
        enteredQuantity: line.releaseQuantity,
        enteredUom: line.enteredUom,
        remarks: line.remarks,
      })),
      release.id,
    );

    const [updated] = await tx
      .update(qaReleases)
      .set({
        status: "SUBMITTED",
        requestedBy: actor.id,
        requestedAt: new Date(),
        version: release.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaReleases.id, release.id),
          eq(qaReleases.status, "DRAFT"),
          eq(qaReleases.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: topology.hqLocationId,
      action: "qa_release.submitted",
      description: `Submitted QA release ${release.documentNo}.`,
      entityType: "qa_release",
      entityId: release.id,
    });

    return { ...updated, lines: storedLines };
  });
}

export async function approveQaRelease(db: DB, input: ApproveQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_APPROVE_ROLES, true);
    const release = await lockRelease(tx, input.releaseId);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    if (release.status !== "SUBMITTED") {
      throw new QaReleaseError(
        "INVALID_TRANSITION",
        `QA release ${release.documentNo} is ${release.status}; expected SUBMITTED.`,
        409,
      );
    }
    if (release.version !== input.expectedVersion) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} version ${release.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (actor.id === release.requestedBy) {
      throw new QaReleaseError("SEGREGATION_OF_DUTIES", "The submitter and approver must be different actors.", 409);
    }

    const [updated] = await tx
      .update(qaReleases)
      .set({
        status: "APPROVED",
        approvedBy: actor.id,
        approvedAt: new Date(),
        version: release.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaReleases.id, release.id),
          eq(qaReleases.status, "SUBMITTED"),
          eq(qaReleases.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: topology.hqLocationId,
      action: "qa_release.approved",
      description: `Approved QA release ${release.documentNo}.`,
      entityType: "qa_release",
      entityId: release.id,
    });

    const lines = await fetchLines(tx, release.id);
    return { ...updated, lines };
  });
}

export async function cancelQaRelease(db: DB, input: CancelQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, true);
    const release = await lockRelease(tx, input.releaseId);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    // Pre-release only (DRAFT/SUBMITTED/APPROVED). Once RELEASED, stock has
    // already moved to HQ_MAIN; correction after that point is a linked
    // compensating document, never a cancel of this one (D35-D46 §5's
    // "cancellation is allowed only before dispatch" convention, carried
    // over from Stock Return Batch / Transfer Order).
    if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(release.status)) {
      throw new QaReleaseError(
        "INVALID_TRANSITION",
        `QA release ${release.documentNo} is ${release.status}; cancel only allowed before release.`,
        409,
      );
    }
    if (release.version !== input.expectedVersion) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} version ${release.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (!input.cancelReason?.trim()) {
      throw new QaReleaseError("VALIDATION", "A cancellation reason is required.", 400);
    }

    const [updated] = await tx
      .update(qaReleases)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.id,
        cancelledAt: new Date(),
        cancelReason: input.cancelReason,
        version: release.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaReleases.id, release.id),
          eq(qaReleases.status, release.status),
          eq(qaReleases.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: topology.hqLocationId,
      action: "qa_release.cancelled",
      description: `Cancelled QA release ${release.documentNo}: ${input.cancelReason}.`,
      entityType: "qa_release",
      entityId: release.id,
    });

    const lines = await fetchLines(tx, release.id);
    return { ...updated, lines };
  });
}

interface StockPostingServiceLike {
  post(input: StockPostingInput): Promise<StockPostingResult>;
}

/**
 * Posts one OUT@QUARANTINE + IN@HQ_MAIN movement pair per line through the
 * central stock posting service (QA_RELEASE route class), then advances the
 * release APPROVED -> RELEASED. Three-step shape (mirrors
 * dispatchTransferOrder()/receiveTransferOrder(), and for the identical
 * reason: the posting service owns its own db.transaction internally and
 * cannot be nested inside another transaction on the same `db` without a
 * self-deadlock risk). Movements always use each item's own base UOM with a
 * 1:1 conversion factor (matching receiveTransferOrder()'s own convention),
 * NOT the line's originally-entered UOM/factor, since releaseQuantity is
 * already a base-quantity snapshot and reusing the entered-UOM conversion
 * would require reverse-deriving a value this table never stored.
 *  - The destination HQ_MAIN lot, its quarantine-lot genealogy link, and the
 *    linked QA_RELEASE operational_document are all established idempotently
 *    in the prepare transaction, so a retry after a mid-flight failure always
 *    reuses the same lot/genealogy/document instead of minting duplicates.
 *  - The idempotency/correlation id for the posting call is derived from the
 *    release's own document number alone (`${documentNo}:RELEASE`), so a
 *    retry with the same release always replays the same posting instead of
 *    double-posting.
 *  - Posting-line ids are recovered from the completed/replayed posting by
 *    metadata (release line id + movement type), not by array position.
 *  - A line whose `release_posting_line_id` is already set is left untouched
 *    on replay: the qa_release_line_append_only trigger (0031) makes the
 *    ENTIRE row immutable once that column is set, so this guard is
 *    required, not just defensive.
 *  - The release's own APPROVED -> RELEASED update is a conditional UPDATE
 *    guarded by status+version; if it matches zero rows after a successful
 *    (possibly replayed) posting, the release was already advanced by an
 *    earlier attempt and the current row is returned as-is (replay-safe).
 */
export async function releaseQaRelease(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: ReleaseQaReleaseInput,
): Promise<QaReleaseWithLines> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, true);

    const release = await lockRelease(tx, input.releaseId);
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);
    if (
      release.sourceWarehouseId !== topology.quarantineWarehouseId ||
      release.destinationWarehouseId !== topology.hqMainWarehouseId
    ) {
      throw new QaReleaseError(
        "TOPOLOGY_NOT_READY",
        "HQ quarantine/HQ_MAIN topology changed since this QA release was drafted.",
        503,
      );
    }

    if (release.status !== "APPROVED" && release.status !== "RELEASED") {
      throw new QaReleaseError(
        "INVALID_TRANSITION",
        `QA release ${release.documentNo} is ${release.status}; expected APPROVED.`,
        409,
      );
    }
    // Once RELEASED, a caller retrying with its original pre-release version
    // is doing an idempotent replay, not a stale write; only an in-flight
    // APPROVED release enforces the optimistic version match.
    if (release.status === "APPROVED" && release.version !== input.expectedVersion) {
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} version ${release.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const lines = await fetchLines(tx, release.id);
    if (lines.length === 0) {
      throw new QaReleaseError("VALIDATION", `QA release ${release.documentNo} has no lines to release.`, 400);
    }

    const quarantineLotIds = [...new Set(lines.map((line) => line.quarantineLotId))];
    const quarantineLotRows = await tx.select().from(inventoryLots).where(inArray(inventoryLots.id, quarantineLotIds));
    const quarantineLotById = new Map(quarantineLotRows.map((row) => [row.id, row]));

    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
    const itemById = new Map(itemRows.map((row) => [row.id, row]));

    const releaseKey = `${release.documentNo}:RELEASE`;
    const releasedLotByLineId = new Map<string, string>();
    for (const line of lines) {
      const quarantineLot = quarantineLotById.get(line.quarantineLotId);
      if (!quarantineLot) {
        throw new QaReleaseError(
          "VALIDATION",
          `Quarantine lot ${line.quarantineLotId} was not found.`,
          404,
        );
      }
      if (quarantineLot.status === "DISPOSED" || quarantineLot.status === "EXHAUSTED") {
        throw new QaReleaseError(
          "LOT_NOT_ELIGIBLE",
          `Lot ${quarantineLot.lotCode} (${quarantineLot.status}) is not eligible for QA release.`,
          409,
          { lotId: quarantineLot.id, status: quarantineLot.status },
        );
      }
      const lotCode = `QA-RELEASE:${release.id}:${line.lineNo}`;
      const releasedLot = await ensureReleasedLot(tx, line.itemId, lotCode, quarantineLot.unitCost, release.id);
      await ensureLotGenealogy(tx, quarantineLot.id, releasedLot.id, line.releaseQuantity, releaseKey);
      releasedLotByLineId.set(line.id, releasedLot.id);
    }

    const releaseDoc = await ensureOperationalDocument(
      tx,
      QA_RELEASE_MODULE,
      releaseKey,
      topology.hqLocationId,
      "APPROVED",
      actor.id,
    );

    return { actor, release, lines, topology, itemById, releasedLotByLineId, releaseKey, releaseDocId: releaseDoc.id };
  });

  const { actor, release, lines, topology, itemById, releasedLotByLineId, releaseKey, releaseDocId } = prepared;

  const movements: StockPostingInput["movements"] = [];
  for (const line of lines) {
    const unit = itemById.get(line.itemId)?.unit ?? line.enteredUom;
    const releasedLotId = releasedLotByLineId.get(line.id)!;
    movements.push({
      warehouseId: release.sourceWarehouseId,
      itemId: line.itemId,
      lotId: line.quarantineLotId,
      movementType: "OUT",
      quantity: line.releaseQuantity,
      enteredQuantity: line.releaseQuantity,
      enteredUom: unit,
      conversionFactor: "1.00000000",
      sourcePolicy: "QUARANTINE_RELEASE",
      metadata: { qaReleaseLineId: line.id, lineNo: line.lineNo },
    });
    movements.push({
      warehouseId: release.destinationWarehouseId,
      itemId: line.itemId,
      lotId: releasedLotId,
      movementType: "IN",
      quantity: line.releaseQuantity,
      enteredQuantity: line.releaseQuantity,
      enteredUom: unit,
      conversionFactor: "1.00000000",
      metadata: { qaReleaseLineId: line.id, lineNo: line.lineNo },
    });
  }

  const postingInput: StockPostingInput = {
    idempotencyKey: releaseKey,
    sourceModule: QA_RELEASE_MODULE,
    sourceDocumentNo: releaseKey,
    locationId: topology.hqLocationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: releaseKey,
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
          eq(operationalDocuments.id, releaseDocId),
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
    const postingLineIdByKey = new Map<string, string>();
    for (const row of postingLineRows) {
      const metadata = row.metadata as { qaReleaseLineId?: string } | null;
      if (metadata?.qaReleaseLineId) {
        postingLineIdByKey.set(`${metadata.qaReleaseLineId}:${row.movementType}`, row.id);
      }
    }

    for (const line of lines) {
      const outId = postingLineIdByKey.get(`${line.id}:OUT`);
      if (!outId) {
        throw new QaReleaseError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the release posting line for QA release line ${line.id}.`,
          409,
        );
      }
      // The DB trigger makes the whole row immutable once
      // release_posting_line_id is set, so a replay MUST skip rows already
      // finalized.
      await tx
        .update(qaReleaseLines)
        .set({ releasePostingLineId: outId, updatedAt: new Date() })
        .where(and(eq(qaReleaseLines.id, line.id), sql`${qaReleaseLines.releasePostingLineId} IS NULL`));
    }

    const [updated] = await tx
      .update(qaReleases)
      .set({
        status: "RELEASED",
        releaseDocumentId: releaseDocId,
        releasedBy: actor.id,
        releasedAt: new Date(),
        version: release.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(qaReleases.id, release.id),
          eq(qaReleases.status, "APPROVED"),
          eq(qaReleases.version, input.expectedVersion),
        ),
      )
      .returning();

    const freshLines = await fetchLines(tx, release.id);
    if (!updated) {
      const [current] = await tx.select().from(qaReleases).where(eq(qaReleases.id, release.id));
      if (current?.status === "RELEASED") {
        return { ...current, lines: freshLines };
      }
      throw new QaReleaseError(
        "CONCURRENT_MODIFICATION",
        `QA release ${release.documentNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: topology.hqLocationId,
      action: "qa_release.released",
      description: `Released QA release ${release.documentNo}.`,
      entityType: "qa_release",
      entityId: release.id,
    });

    return { ...updated, lines: freshLines };
  });
}

export async function getQaRelease(db: DB, input: GetQaReleaseInput): Promise<QaReleaseWithLines> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, false);

    const [release] = await tx.select().from(qaReleases).where(eq(qaReleases.id, input.releaseId));
    if (!release) {
      throw new QaReleaseError("NOT_FOUND", `QA release ${input.releaseId} was not found.`, 404);
    }
    const topology = await resolveHqTopology(tx);
    assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

    const lines = await fetchLines(tx, release.id);
    return { ...release, lines };
  });
}

async function resolveListConditions(tx: Tx, input: ListQaReleasesInput) {
  const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, QA_RELEASE_ROLES, false);
  const topology = await resolveHqTopology(tx);
  assertLocationInScope(actor.allowedLocationIds, topology.hqLocationId);

  const conditions = [];
  if (input.status) {
    conditions.push(eq(qaReleases.status, input.status));
  }
  if (input.search?.trim()) {
    conditions.push(ilike(qaReleases.documentNo, `%${input.search.trim()}%`));
  }

  return { actor, conditions };
}

export async function listQaReleases(db: DB, input: ListQaReleasesInput): Promise<QaRelease[]> {
  return db.transaction(async (tx) => {
    const { conditions } = await resolveListConditions(tx, input);

    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;

    const query = tx.select().from(qaReleases);
    const ordered =
      conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(qaReleases.createdAt))
        : query.orderBy(desc(qaReleases.createdAt));
    return ordered.limit(limit).offset(offset);
  });
}

export async function countQaReleases(db: DB, input: ListQaReleasesInput): Promise<number> {
  return db.transaction(async (tx) => {
    const { conditions } = await resolveListConditions(tx, input);
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(qaReleases)
      .where(conditions.length > 0 ? and(...conditions) : sql`true`);
    return row?.count ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface QaReleaseActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

interface CreateDraftServiceInput {
  remarks?: string | null;
  lines: QaReleaseLineInput[];
}

interface UpdateDraftServiceInput {
  releaseId: string;
  version: number;
  remarks?: string | null;
  lines?: QaReleaseLineInput[];
}

interface SubmitServiceInput {
  releaseId: string;
  version: number;
}

interface ApproveServiceInput {
  releaseId: string;
  version: number;
}

interface CancelServiceInput {
  releaseId: string;
  version: number;
  cancelReason: string;
}

interface ReleaseServiceInput {
  releaseId: string;
  version: number;
}

interface GetServiceInput {
  releaseId: string;
}

type ListServiceInput = Omit<ListQaReleasesInput, "actorUserId" | "sessionId">;

/** Facade over the standalone lifecycle functions above. */
export function createQaReleaseService(db: DB) {
  const stockPostingService = createStockPostingService(db, {
    documentPolicies: {
      [QA_RELEASE_MODULE]: QA_RELEASE_POSTING_POLICY,
    },
  });
  return {
    createDraft(ctx: QaReleaseActorContext, input: CreateDraftServiceInput) {
      return createQaReleaseDraft(db, { ...ctx, ...input });
    },
    updateDraft(ctx: QaReleaseActorContext, input: UpdateDraftServiceInput) {
      const { releaseId, version, ...rest } = input;
      return updateQaReleaseDraft(db, { ...ctx, releaseId, expectedVersion: version, ...rest });
    },
    submit(ctx: QaReleaseActorContext, input: SubmitServiceInput) {
      return submitQaRelease(db, { ...ctx, releaseId: input.releaseId, expectedVersion: input.version });
    },
    approve(ctx: QaReleaseActorContext, input: ApproveServiceInput) {
      return approveQaRelease(db, { ...ctx, releaseId: input.releaseId, expectedVersion: input.version });
    },
    cancel(ctx: QaReleaseActorContext, input: CancelServiceInput) {
      return cancelQaRelease(db, {
        ...ctx,
        releaseId: input.releaseId,
        expectedVersion: input.version,
        cancelReason: input.cancelReason,
      });
    },
    release(ctx: QaReleaseActorContext, input: ReleaseServiceInput): Promise<QaReleaseWithLines> {
      return releaseQaRelease(db, stockPostingService, {
        ...ctx,
        releaseId: input.releaseId,
        expectedVersion: input.version,
      });
    },
    get(ctx: QaReleaseActorContext, input: GetServiceInput) {
      return getQaRelease(db, { ...ctx, releaseId: input.releaseId });
    },
    list(ctx: QaReleaseActorContext, input: ListServiceInput) {
      return listQaReleases(db, { ...ctx, ...input });
    },
    count(ctx: QaReleaseActorContext, input: ListServiceInput) {
      return countQaReleases(db, { ...ctx, ...input });
    },
  };
}
