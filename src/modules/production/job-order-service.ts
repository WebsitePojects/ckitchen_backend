/**
 * Job Order draft planning service: creates a DRAFT Job Order against an
 * explicit ACTIVE BOM version and derives its component allocation plan.
 * Deliberately stops at DRAFT — no submit/approve/release/complete/cancel
 * transition, no posting, no inventory mutation, no lot selection (per
 * `.claude/rules/business-rules.md` D46's "no inventory mutation" boundary
 * for this module).
 */
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLotBalances,
  inventoryLotGenealogy,
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  stockPostingLines,
} from "../../db/enterprise-schema.js";
import {
  bomComponents,
  bomHeaders,
  bomVersions,
  jobOrderComponentAllocations,
  jobOrderOutputLots,
  jobOrders,
  type BomComponent,
  type JobOrder,
  type JobOrderComponentAllocation,
} from "../../db/production-schema.js";
import {
  auditLogs,
  employees,
  ingredients,
  locations,
  userOutletAccess,
  users,
  userSessions,
  warehouses,
  type Role,
} from "../../db/schema.js";
import { outletScopeForRole, normalizeRole } from "../auth/roles.js";
import { DecimalValidationError, formatFixed, parseFixed } from "../stock/decimal.js";
import { createStockPostingService } from "../stock/posting-service.js";
import type { StockPostingInput, StockPostingResult } from "../stock/types.js";
import { StockProductionError } from "./errors.js";
import {
  PRODUCTION_CONSUME_MODULE,
  PRODUCTION_CONSUME_POLICY,
  PRODUCTION_OUTPUT_MODULE,
  PRODUCTION_OUTPUT_POLICY,
  STOCK_PRODUCTION_FEATURE_KEY,
  STOCK_PRODUCTION_ROLES,
} from "./policies.js";
import type {
  ApproveJobOrderInput,
  CancelJobOrderInput,
  CompleteJobOrderInput,
  CreateJobOrderDraftInput,
  FailJobOrderInput,
  GetJobOrderInput,
  JobOrderWithAllocations,
  ListJobOrdersInput,
  ListJobOrdersPage,
  ReleaseJobOrderInput,
  StartJobOrderInput,
  SubmitJobOrderInput,
} from "./types.js";

/** Minimal shape the Job Order lifecycle service needs from the central stock posting service. */
interface StockPostingServiceLike {
  post(input: StockPostingInput): Promise<StockPostingResult>;
}

/** Asia/Manila has no DST and is fixed UTC+08:00 (mirrors posting-service.ts). */
function manilaDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Today (Asia/Manila) plus `days` calendar days, as a `YYYY-MM-DD` date string. */
function addDaysToManilaDate(days: number): string {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
  today.setUTCDate(today.getUTCDate() + days);
  return today.toISOString().slice(0, 10);
}

/**
 * Rounded (half-up) BigInt division formatted as a fixed-scale decimal
 * string: `round(numerator / denominator * 10^scale) / 10^scale`. Used for
 * `completeJobOrder`'s output unit cost, which is a genuinely non-terminating
 * division in general (total consumed cost / actual output qty) — unlike
 * `derivePlannedAllocationQty`'s exact-division requirement, a rounded result
 * is the correct and expected behavior here.
 */
function divideFixedRounded(numerator: bigint, denominator: bigint, scale: number): string {
  if (denominator === 0n) {
    throw new StockProductionError("VALIDATION", "Division by zero while computing a fixed-point quantity.", 400);
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const scaled = absNumerator * 10n ** BigInt(scale);
  const quotient = scaled / absDenominator;
  const remainder = scaled % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return formatFixed(negative ? -rounded : rounded, scale);
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Detects a PostgreSQL unique-violation from pglite/postgres-js/drizzle errors. */
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
  lock: boolean,
): Promise<{ id: string; name: string; role: Role; allowedLocationIds: string[] | null }> {
  const query = tx
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId));
  const rows = lock ? await query.for("update") : await query;
  const actor = rows[0];
  const role = normalizeRole(actor?.role);
  if (!actor || actor.status !== "ACTIVE" || !role || !STOCK_PRODUCTION_ROLES.includes(role)) {
    throw new StockProductionError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this Job Order operation.",
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
      throw new StockProductionError("UNAUTHORIZED", "The actor session is not active.", 401);
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
    throw new StockProductionError(
      "UNAUTHORIZED",
      "The target location is outside the actor's outlet scope.",
      403,
    );
  }
}

async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, STOCK_PRODUCTION_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new StockProductionError(
      "FEATURE_DISABLED",
      `Operational feature "${STOCK_PRODUCTION_FEATURE_KEY}" is disabled.`,
      503,
      { feature: STOCK_PRODUCTION_FEATURE_KEY },
    );
  }
}

/**
 * Derives one planned allocation quantity from a BOM component line:
 * `componentBaseQty * (plannedOutputQty / bomOutputYieldQty) * (1 + scrapAllowancePct / 100)`,
 * computed as an exact BigInt rational (no floating point) at the
 * component's stock scale (6 decimals). Rejects a non-terminating result
 * rather than silently rounding, mirroring `multiplyFixedExact`.
 */
function derivePlannedAllocationQty(
  componentBaseQty: string,
  plannedOutputQty: string,
  outputYieldQty: string,
  scrapAllowancePct: string,
): string {
  const cbq = parseFixed(componentBaseQty, 6);
  const plan = parseFixed(plannedOutputQty, 6);
  const yieldQty = parseFixed(outputYieldQty, 6);
  const scrap = parseFixed(scrapAllowancePct, 4);

  const scrapFactorScale6 = 1_000_000n + scrap;
  const numerator = cbq * plan * scrapFactorScale6;
  const denominator = 1_000_000n * yieldQty;

  if (numerator % denominator !== 0n) {
    throw new StockProductionError(
      "VALIDATION",
      "Planned output quantity does not divide exactly into whole component allocation quantities at 6-decimal precision.",
      400,
      { componentBaseQty, plannedOutputQty, outputYieldQty, scrapAllowancePct },
    );
  }

  return formatFixed(numerator / denominator, 6);
}

export async function createJobOrderDraft(db: DB, input: CreateJobOrderDraftInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrderNo = input.jobOrderNo.trim();
    if (!jobOrderNo) {
      throw new StockProductionError("VALIDATION", "A Job Order number is required.", 400);
    }

    const [location] = await tx.select().from(locations).where(eq(locations.id, input.locationId));
    if (!location) {
      throw new StockProductionError("NOT_FOUND", `Location ${input.locationId} was not found.`, 404);
    }
    assertLocationInScope(actor.allowedLocationIds, location.id);

    const [version] = await tx.select().from(bomVersions).where(eq(bomVersions.id, input.bomVersionId)).for("update");
    if (!version) {
      throw new StockProductionError("NOT_FOUND", `BOM version ${input.bomVersionId} was not found.`, 404);
    }
    if (version.status !== "ACTIVE") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `BOM version ${version.id} is ${version.status}; a Job Order may only be drafted against an ACTIVE version.`,
        409,
      );
    }

    const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, version.bomHeaderId));
    if (!header || !header.isActive) {
      throw new StockProductionError("NOT_FOUND", `BOM header ${version.bomHeaderId} was not found.`, 404);
    }

    const plannedOutputUom = input.plannedOutputUom.trim();
    if (!plannedOutputUom) {
      throw new StockProductionError("VALIDATION", "A planned output UOM is required.", 400);
    }
    if (plannedOutputUom.toLowerCase() !== version.outputUom.trim().toLowerCase()) {
      throw new StockProductionError(
        "UOM_MISMATCH",
        `Planned output UOM "${plannedOutputUom}" does not match BOM version output UOM "${version.outputUom}".`,
        409,
      );
    }

    let plannedOutputQty: string;
    try {
      const units = parseFixed(input.plannedOutputQty, 6);
      if (units <= 0n) {
        throw new StockProductionError("VALIDATION", "Planned output quantity must be positive.", 400);
      }
      plannedOutputQty = formatFixed(units, 6);
    } catch (error) {
      if (error instanceof StockProductionError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("VALIDATION", `Planned output quantity: ${error.message}`, 400);
      }
      throw error;
    }

    const [productionWarehouse] = await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.locationId, location.id),
          eq(warehouses.purpose, "PRODUCTION"),
          eq(warehouses.isActive, true),
        ),
      );
    if (!productionWarehouse) {
      throw new StockProductionError(
        "WAREHOUSE_MISMATCH",
        `Location ${location.id} has no active PRODUCTION-purpose warehouse.`,
        409,
        { locationId: location.id },
      );
    }

    const components: BomComponent[] = await tx
      .select()
      .from(bomComponents)
      .where(eq(bomComponents.bomVersionId, version.id))
      .orderBy(asc(bomComponents.lineNo));
    if (components.length === 0) {
      throw new StockProductionError(
        "VALIDATION",
        `BOM version ${version.id} has no components to plan allocations from.`,
        400,
      );
    }

    const plannedAllocations = components.map((component) => ({
      lineNo: component.lineNo,
      bomComponentId: component.id,
      componentItemId: component.componentItemId,
      sourceWarehouseId: productionWarehouse.id,
      plannedQuantity: derivePlannedAllocationQty(
        component.baseQuantity,
        plannedOutputQty,
        version.outputYieldQty,
        component.scrapAllowancePct,
      ),
      enteredUom: component.componentUom,
      conversionFactor: "1.00000000",
    }));

    let jobOrder: JobOrder;
    try {
      const [inserted] = await tx
        .insert(jobOrders)
        .values({
          jobOrderNo,
          bomHeaderId: header.id,
          bomVersionId: version.id,
          locationId: location.id,
          productionWarehouseId: productionWarehouse.id,
          status: "DRAFT",
          plannedOutputQty,
          outputUom: version.outputUom,
          remarks: input.remarks ?? null,
          createdBy: actor.id,
        })
        .returning();
      jobOrder = inserted!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StockProductionError(
          "VALIDATION",
          `Job Order number "${jobOrderNo}" is already in use.`,
          409,
          { jobOrderNo },
        );
      }
      throw error;
    }

    const allocations: JobOrderComponentAllocation[] = await tx
      .insert(jobOrderComponentAllocations)
      .values(
        plannedAllocations.map((allocation) => ({
          ...allocation,
          jobOrderId: jobOrder.id,
        })),
      )
      .returning();
    allocations.sort((a, b) => a.lineNo - b.lineNo);

    return { ...jobOrder, allocations };
  });
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
    throw new StockProductionError(
      "CONCURRENT_MODIFICATION",
      `Failed to establish ${module} document ${documentNo}.`,
      409,
    );
  }
  return existing;
}

/**
 * Idempotent insert-or-fetch for a Job Order output lot, keyed on the
 * deterministic `(itemId, lotCode)` unique index (`lotCode` is always
 * `JOBORDER:<jobOrderId>`, so a retry after a mid-flight failure always
 * reuses the same lot instead of minting a duplicate). Mirrors
 * `ensureQuarantineLot` in src/modules/stock-returns/service.ts.
 */
async function ensureOutputLot(
  tx: Tx,
  itemId: string,
  lotCode: string,
  unitCost: string,
  expiresAt: string | null,
  jobOrderId: string,
): Promise<{ id: string }> {
  const [inserted] = await tx
    .insert(inventoryLots)
    .values({
      itemId,
      lotCode,
      status: "AVAILABLE",
      unitCost,
      expiresAt,
      sourceDocumentType: "JOB_ORDER_OUTPUT",
      sourceDocumentId: jobOrderId,
    })
    .onConflictDoNothing()
    .returning({ id: inventoryLots.id });
  if (inserted) return inserted;
  const [existing] = await tx
    .select({ id: inventoryLots.id })
    .from(inventoryLots)
    .where(and(eq(inventoryLots.itemId, itemId), eq(inventoryLots.lotCode, lotCode)));
  if (!existing) {
    throw new StockProductionError("CONCURRENT_MODIFICATION", `Failed to establish output lot ${lotCode}.`, 409);
  }
  return existing;
}

/** Idempotent insert-or-ignore for a component-lot -> output-lot genealogy link. */
async function ensureOutputLotGenealogy(
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

async function fetchAllocations(tx: Tx, jobOrderId: string): Promise<JobOrderComponentAllocation[]> {
  return tx
    .select()
    .from(jobOrderComponentAllocations)
    .where(eq(jobOrderComponentAllocations.jobOrderId, jobOrderId))
    .orderBy(asc(jobOrderComponentAllocations.lineNo));
}

async function lockJobOrder(tx: Tx, jobOrderId: string): Promise<JobOrder> {
  const [jobOrder] = await tx.select().from(jobOrders).where(eq(jobOrders.id, jobOrderId)).for("update");
  if (!jobOrder) {
    throw new StockProductionError("NOT_FOUND", `Job Order ${jobOrderId} was not found.`, 404);
  }
  return jobOrder;
}

export async function submitJobOrder(db: DB, input: SubmitJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (jobOrder.status !== "DRAFT") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected DRAFT.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "SUBMITTED",
        submittedBy: actor.id,
        submittedAt: new Date(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "DRAFT"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

export async function approveJobOrder(db: DB, input: ApproveJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (jobOrder.status !== "SUBMITTED") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected SUBMITTED.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }
    if (actor.id === jobOrder.submittedBy) {
      throw new StockProductionError(
        "SEGREGATION_OF_DUTIES",
        "The submitter and approver must be different actors.",
        409,
      );
    }

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "APPROVED",
        approvedBy: actor.id,
        approvedAt: new Date(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "SUBMITTED"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

/**
 * APPROVED -> RELEASED, creating and linking the PRODUCTION_CONSUME and
 * PRODUCTION_OUTPUT operational_documents exactly once. If the job order is
 * already RELEASED (a replay of a call that already succeeded), this is a
 * safe no-op that returns the current row unchanged — no version check, no
 * further mutation, since nothing needs to happen again.
 */
export async function releaseJobOrder(db: DB, input: ReleaseJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (jobOrder.status === "RELEASED") {
      const allocations = await fetchAllocations(tx, jobOrder.id);
      return { ...jobOrder, allocations };
    }

    if (jobOrder.status !== "APPROVED") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected APPROVED.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const consumeDoc = await ensureOperationalDocument(
      tx,
      PRODUCTION_CONSUME_MODULE,
      jobOrder.jobOrderNo,
      jobOrder.locationId,
      "PENDING",
      actor.id,
    );
    const outputDoc = await ensureOperationalDocument(
      tx,
      PRODUCTION_OUTPUT_MODULE,
      jobOrder.jobOrderNo,
      jobOrder.locationId,
      "PENDING",
      actor.id,
    );

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "RELEASED",
        releasedBy: actor.id,
        releasedAt: new Date(),
        consumeDocumentId: consumeDoc.id,
        outputDocumentId: outputDoc.id,
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "APPROVED"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

/** One FEFO-selected lot portion drawn against a single component allocation line. */
interface FefoLotPortion {
  lotId: string;
  lotCode: string;
  qtyBase: bigint;
  unitCost: string;
}

/**
 * FEFO (first-expiry-first-out) candidate selection for one component item at
 * one PRODUCTION warehouse: only `AVAILABLE`, non-expired lots are eligible,
 * ordered soonest-expiry-first (nulls/never-expiring last), tiebroken by lot
 * code for determinism. Walks the sorted candidates taking
 * `min(remaining need, onHand - reserved)` from each until `neededBase` is
 * fully covered, or throws `INSUFFICIENT_STOCK` if candidates run out first.
 * Plain (non-locking) SELECT: this runs in the "prepare" transaction before
 * any row is written, and the central stock posting service performs its own
 * authoritative `SELECT ... FOR UPDATE` + balance-sufficiency checks at
 * actual-post time, so a race against this plan surfaces there instead.
 */
async function selectFefoLots(
  tx: Tx,
  itemId: string,
  warehouseId: string,
  neededBase: bigint,
  itemCode: string,
): Promise<FefoLotPortion[]> {
  const today = manilaDate();
  const candidates = await tx
    .select({
      lotId: inventoryLots.id,
      lotCode: inventoryLots.lotCode,
      expiresAt: inventoryLots.expiresAt,
      unitCost: inventoryLots.unitCost,
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

  const portions: FefoLotPortion[] = [];
  let remaining = neededBase;
  for (const candidate of candidates) {
    if (remaining <= 0n) break;
    const available = parseFixed(candidate.onHand, 6) - parseFixed(candidate.reserved, 6);
    if (available <= 0n) continue;
    const take = available < remaining ? available : remaining;
    portions.push({ lotId: candidate.lotId, lotCode: candidate.lotCode, qtyBase: take, unitCost: candidate.unitCost });
    remaining -= take;
  }

  if (remaining > 0n) {
    throw new StockProductionError(
      "INSUFFICIENT_STOCK",
      `Insufficient available AVAILABLE, non-expired stock for item ${itemCode} at warehouse ${warehouseId} (short by ${formatFixed(remaining, 6)}).`,
      409,
      { itemId, warehouseId, shortBy: formatFixed(remaining, 6) },
    );
  }
  return portions;
}

interface StartJobOrderPlanRow {
  isNewRow: boolean;
  allocationId: string | null;
  lineNo: number;
  bomComponentId: string | null;
  componentItemId: string;
  sourceWarehouseId: string;
  enteredUom: string;
  conversionFactor: string;
  lotId: string;
  qtyBase: bigint;
  unitCost: string;
}

/**
 * RELEASED -> IN_PROGRESS: FEFO-selects component lots against the job's own
 * PRODUCTION warehouse for every planned component allocation, posts one OUT
 * ALLOCATABLE movement per selected lot through the central stock posting
 * service (which itself advances the PRODUCTION_CONSUME operational_document
 * PENDING -> CONSUMED), then records the concrete lot draw(s) back onto
 * `job_order_component_allocation` (splitting into extra rows when a single
 * component's plan needed more than one lot) and advances the job order.
 *
 * Three-step shape (mirrors dispatchStockReturnBatch/receiveAndDisposeStockReturnBatch
 * in src/modules/stock-returns/service.ts): "prepare" transaction computes the
 * full FEFO plan and returns a plain object; the posting call happens outside
 * any transaction (the posting service owns its own db.transaction internally
 * and cannot be nested inside another transaction on the same `db` without a
 * self-deadlock risk); "finalize" transaction re-verifies state and writes the
 * job's own rows. No compensation is needed if the posting call fails: unlike
 * dispatch/receive-and-dispose, this flow does not create or mutate any
 * durable row of its own in the prepare step (the PRODUCTION_CONSUME document
 * already exists from releaseJobOrder and is owned/advanced by the posting
 * service itself) — a thrown INSUFFICIENT_STOCK/route/topology error during
 * FEFO selection rolls back the prepare transaction with nothing persisted,
 * and a failure inside `.post()` leaves the document at PENDING untouched.
 */
export async function startJobOrder(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: StartJobOrderInput,
): Promise<JobOrderWithAllocations> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (jobOrder.status === "IN_PROGRESS") {
      const allocations = await fetchAllocations(tx, jobOrder.id);
      return { replay: true as const, jobOrder, allocations };
    }

    if (jobOrder.status !== "RELEASED") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected RELEASED.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const [employee] = await tx.select().from(employees).where(eq(employees.id, input.operatorEmployeeId));
    if (!employee) {
      throw new StockProductionError(
        "NOT_FOUND",
        `Employee ${input.operatorEmployeeId} was not found.`,
        404,
      );
    }
    if (employee.status !== "ACTIVE") {
      throw new StockProductionError(
        "VALIDATION",
        `Employee ${employee.employeeNo} is ${employee.status}; only an ACTIVE employee may be assigned as operator.`,
        400,
      );
    }
    if (employee.locationId !== null && employee.locationId !== jobOrder.locationId) {
      throw new StockProductionError(
        "SCOPE_MISMATCH",
        `Employee ${employee.employeeNo} is assigned to a different outlet than Job Order ${jobOrder.jobOrderNo}.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    let nextLineNo = allocations.reduce((max, a) => Math.max(max, a.lineNo), 0) + 1;

    const planRows: StartJobOrderPlanRow[] = [];
    for (const allocation of allocations) {
      const neededBase = parseFixed(allocation.plannedQuantity, 6);
      const portions = await selectFefoLots(
        tx,
        allocation.componentItemId,
        allocation.sourceWarehouseId,
        neededBase,
        allocation.componentItemId,
      );
      portions.forEach((portion, index) => {
        if (index === 0) {
          planRows.push({
            isNewRow: false,
            allocationId: allocation.id,
            lineNo: allocation.lineNo,
            bomComponentId: allocation.bomComponentId,
            componentItemId: allocation.componentItemId,
            sourceWarehouseId: allocation.sourceWarehouseId,
            enteredUom: allocation.enteredUom,
            conversionFactor: allocation.conversionFactor,
            lotId: portion.lotId,
            qtyBase: portion.qtyBase,
            unitCost: portion.unitCost,
          });
        } else {
          planRows.push({
            isNewRow: true,
            allocationId: null,
            lineNo: nextLineNo++,
            bomComponentId: allocation.bomComponentId,
            componentItemId: allocation.componentItemId,
            sourceWarehouseId: allocation.sourceWarehouseId,
            enteredUom: allocation.enteredUom,
            conversionFactor: allocation.conversionFactor,
            lotId: portion.lotId,
            qtyBase: portion.qtyBase,
            unitCost: portion.unitCost,
          });
        }
      });
    }

    return {
      replay: false as const,
      actor,
      jobOrder,
      employee,
      componentCount: allocations.length,
      planRows,
    };
  });

  if (prepared.replay) {
    return { ...prepared.jobOrder, allocations: prepared.allocations };
  }

  const { actor, jobOrder, employee, componentCount, planRows } = prepared;

  const postingInput: StockPostingInput = {
    idempotencyKey: jobOrder.jobOrderNo,
    sourceModule: PRODUCTION_CONSUME_MODULE,
    sourceDocumentNo: jobOrder.jobOrderNo,
    locationId: jobOrder.locationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: jobOrder.jobOrderNo,
    movements: planRows.map((row) => ({
      warehouseId: row.sourceWarehouseId,
      itemId: row.componentItemId,
      lotId: row.lotId,
      movementType: "OUT",
      quantity: formatFixed(row.qtyBase, 6),
      enteredQuantity: formatFixed(row.qtyBase, 6),
      enteredUom: row.enteredUom,
      conversionFactor: row.conversionFactor,
      unitCost: row.unitCost,
      sourcePolicy: "ALLOCATABLE",
      metadata: { jobOrderId: jobOrder.id, jobOrderNo: jobOrder.jobOrderNo, lineNo: row.lineNo },
    })),
  };

  const postingResult = await stockPostingService.post(postingInput);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "IN_PROGRESS",
        operatorId: employee.id,
        operatorAssignedAt: new Date(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "RELEASED"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(jobOrders).where(eq(jobOrders.id, jobOrder.id));
      if (current?.status === "IN_PROGRESS") {
        const allocations = await fetchAllocations(tx, jobOrder.id);
        return { ...current, allocations };
      }
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const postingLineRows = await tx
      .select()
      .from(stockPostingLines)
      .where(eq(stockPostingLines.postingId, postingResult.postingId));
    const postingLineIdByKey = new Map<string, string>();
    for (const row of postingLineRows) {
      postingLineIdByKey.set(`${row.itemId}:${row.lotId}`, row.id);
    }

    for (const row of planRows) {
      const postingLineId = postingLineIdByKey.get(`${row.componentItemId}:${row.lotId}`);
      if (!postingLineId) {
        throw new StockProductionError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the consume posting line for item ${row.componentItemId}, lot ${row.lotId}.`,
          409,
        );
      }
      if (row.isNewRow) {
        await tx.insert(jobOrderComponentAllocations).values({
          jobOrderId: jobOrder.id,
          lineNo: row.lineNo,
          bomComponentId: row.bomComponentId,
          componentItemId: row.componentItemId,
          sourceLotId: row.lotId,
          sourceWarehouseId: row.sourceWarehouseId,
          plannedQuantity: formatFixed(row.qtyBase, 6),
          allocatedQuantity: formatFixed(row.qtyBase, 6),
          enteredUom: row.enteredUom,
          conversionFactor: row.conversionFactor,
          consumePostingLineId: postingLineId,
        });
      } else {
        await tx
          .update(jobOrderComponentAllocations)
          .set({
            sourceLotId: row.lotId,
            allocatedQuantity: formatFixed(row.qtyBase, 6),
            consumePostingLineId: postingLineId,
          })
          .where(eq(jobOrderComponentAllocations.id, row.allocationId!));
      }
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: jobOrder.locationId,
      action: "job_order.started",
      description: `Started Job Order ${jobOrder.jobOrderNo}: consumed ${planRows.length} component lot line(s) across ${componentCount} planned component(s).`,
      entityType: "job_order",
      entityId: jobOrder.id,
      metadata: { componentCount, lineCount: planRows.length, postingId: postingResult.postingId },
    });

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

const CANCELLABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "RELEASED"]);

export async function cancelJobOrder(db: DB, input: CancelJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (!input.reason?.trim()) {
      throw new StockProductionError("VALIDATION", "A cancellation reason is required.", 400);
    }
    if (!CANCELLABLE_STATUSES.has(jobOrder.status)) {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; cancel only allowed from DRAFT, SUBMITTED, APPROVED, or RELEASED.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.id,
        cancelledAt: new Date(),
        cancelReason: input.reason.trim(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, jobOrder.status),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

export async function failJobOrder(db: DB, input: FailJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (!input.reason?.trim()) {
      throw new StockProductionError("VALIDATION", "A failure reason is required.", 400);
    }
    if (jobOrder.status !== "IN_PROGRESS") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected IN_PROGRESS.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "FAILED",
        failedAt: new Date(),
        failureReason: input.reason.trim(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "IN_PROGRESS"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

/**
 * IN_PROGRESS -> COMPLETED: computes the actual production cost from the
 * exact component lots/costs already consumed by `startJobOrder()` (never
 * re-derives from the BOM plan), mints a deterministic output lot for the
 * actual yield, posts one IN movement through the central stock posting
 * service (which itself advances the PRODUCTION_OUTPUT operational_document
 * PENDING -> COMPLETED), links component-lot -> output-lot genealogy, and
 * advances the job order. If the job order is already COMPLETED (a replay of
 * a call that already succeeded), this is a safe no-op that returns the
 * current row unchanged — no version check, no further mutation.
 *
 * Three-step shape (mirrors `startJobOrder()` above and
 * `receiveAndDisposeStockReturnBatch()` in
 * src/modules/stock-returns/service.ts): "prepare" transaction computes the
 * cost and mints/reuses the output lot + genealogy + evidence row
 * idempotently, then returns a plain object; the posting call happens
 * outside any transaction (the posting service owns its own db.transaction
 * internally and cannot be nested inside another transaction on the same
 * `db` without a self-deadlock risk); "finalize" transaction re-verifies
 * state, links the evidence row to its posting line, and writes the job's
 * own rows. Unlike dispatch/receive-and-dispose in the stock-returns module,
 * no compensation is needed if `.post()` fails: the output lot, its
 * genealogy links, and its evidence row are all idempotent-safe to leave in
 * place for a retry to reuse (mirrors the comment on `startJobOrder()` above
 * about why no compensation is needed there either).
 */
export async function completeJobOrder(
  db: DB,
  stockPostingService: StockPostingServiceLike,
  input: CompleteJobOrderInput,
): Promise<JobOrderWithAllocations> {
  const prepared = await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, true);

    const jobOrder = await lockJobOrder(tx, input.jobOrderId);
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    if (jobOrder.status === "COMPLETED") {
      const allocations = await fetchAllocations(tx, jobOrder.id);
      return { replay: true as const, jobOrder, allocations };
    }

    if (jobOrder.status !== "IN_PROGRESS") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `Job Order ${jobOrder.jobOrderNo} is ${jobOrder.status}; expected IN_PROGRESS.`,
        409,
      );
    }
    if (jobOrder.version !== input.expectedVersion) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} version ${jobOrder.version} does not match expected ${input.expectedVersion}.`,
        409,
      );
    }

    let actualOutputQty: string;
    let outputQtyBase: bigint;
    try {
      outputQtyBase = parseFixed(input.actualOutputQty, 6);
      if (outputQtyBase <= 0n) {
        throw new StockProductionError("VALIDATION", "Actual output quantity must be positive.", 400);
      }
      actualOutputQty = formatFixed(outputQtyBase, 6);
    } catch (error) {
      if (error instanceof StockProductionError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("VALIDATION", `Actual output quantity: ${error.message}`, 400);
      }
      throw error;
    }

    const allocations = await fetchAllocations(tx, jobOrder.id);
    if (allocations.length === 0) {
      throw new StockProductionError(
        "VALIDATION",
        `Job Order ${jobOrder.jobOrderNo} has no component allocations to complete against.`,
        400,
      );
    }
    const consumePostingLineIds: string[] = [];
    for (const allocation of allocations) {
      if (!allocation.consumePostingLineId || !allocation.sourceLotId || allocation.allocatedQuantity == null) {
        throw new StockProductionError(
          "VALIDATION",
          `Job Order ${jobOrder.jobOrderNo} allocation line ${allocation.lineNo} was never consumed against stock.`,
          400,
        );
      }
      consumePostingLineIds.push(allocation.consumePostingLineId);
    }

    const consumedLines = await tx
      .select()
      .from(stockPostingLines)
      .where(inArray(stockPostingLines.id, consumePostingLineIds));
    const consumedLineById = new Map(consumedLines.map((line) => [line.id, line]));

    // Total consumed cost as an exact BigInt at implied scale 12 (a
    // scale-6 quantity times a scale-6 unit cost) — summed before any
    // rounding, so per-line rounding error can never accumulate across
    // components.
    let totalCostScale12 = 0n;
    for (const allocation of allocations) {
      const line = consumedLineById.get(allocation.consumePostingLineId!);
      if (!line) {
        throw new StockProductionError(
          "CONCURRENT_MODIFICATION",
          `Could not resolve the consume posting line for allocation line ${allocation.lineNo}.`,
          409,
        );
      }
      totalCostScale12 += parseFixed(line.quantity, 6) * parseFixed(line.unitCost, 6);
    }

    const totalConsumedCost = divideFixedRounded(totalCostScale12, 10n ** 12n, 6);
    // outputUnitCost = totalConsumedCost / actualOutputQty. Both operands are
    // scale-6 fixed-point values, so this simplifies to
    // round(totalCostScale12 / outputQtyBase) at scale 6 (see the derivation
    // in job-order-service.ts's completeJobOrder implementation notes).
    const outputUnitCost = divideFixedRounded(totalCostScale12, 1_000_000n * outputQtyBase, 6);

    const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, jobOrder.bomHeaderId));
    if (!header) {
      throw new StockProductionError("NOT_FOUND", `BOM header ${jobOrder.bomHeaderId} was not found.`, 404);
    }
    const [outputItem] = await tx.select().from(ingredients).where(eq(ingredients.id, header.outputItemId));
    if (!outputItem) {
      throw new StockProductionError("NOT_FOUND", `Output item ${header.outputItemId} was not found.`, 404);
    }
    if (outputItem.unit.trim().toLowerCase() !== jobOrder.outputUom.trim().toLowerCase()) {
      throw new StockProductionError(
        "UOM_MISMATCH",
        `Output item base UOM "${outputItem.unit}" does not match Job Order output UOM "${jobOrder.outputUom}".`,
        409,
      );
    }

    const expiresAt = outputItem.shelfLifeDays != null ? addDaysToManilaDate(outputItem.shelfLifeDays) : null;

    const lotCode = `JOBORDER:${jobOrder.id}`;
    const outputLot = await ensureOutputLot(tx, outputItem.id, lotCode, outputUnitCost, expiresAt, jobOrder.id);

    for (const allocation of allocations) {
      await ensureOutputLotGenealogy(
        tx,
        allocation.sourceLotId!,
        outputLot.id,
        allocation.allocatedQuantity!,
        jobOrder.jobOrderNo,
      );
    }

    const [insertedEvidence] = await tx
      .insert(jobOrderOutputLots)
      .values({
        jobOrderId: jobOrder.id,
        outputLotId: outputLot.id,
        quantity: actualOutputQty,
        evidenceRef: input.evidenceRef ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!insertedEvidence) {
      const [existingEvidence] = await tx
        .select({ id: jobOrderOutputLots.id })
        .from(jobOrderOutputLots)
        .where(
          and(eq(jobOrderOutputLots.jobOrderId, jobOrder.id), eq(jobOrderOutputLots.outputLotId, outputLot.id)),
        );
      if (!existingEvidence) {
        throw new StockProductionError(
          "CONCURRENT_MODIFICATION",
          `Failed to establish output evidence for Job Order ${jobOrder.jobOrderNo}.`,
          409,
        );
      }
    }

    return {
      replay: false as const,
      actor,
      jobOrder,
      outputItemId: outputItem.id,
      outputLotId: outputLot.id,
      actualOutputQty,
      outputUnitCost,
      componentCount: allocations.length,
      totalConsumedCost,
    };
  });

  if (prepared.replay) {
    return { ...prepared.jobOrder, allocations: prepared.allocations };
  }

  const { actor, jobOrder, outputItemId, outputLotId, actualOutputQty, outputUnitCost, componentCount, totalConsumedCost } =
    prepared;

  // NOTE (deviation from the literal task spec): `stock_posting.idempotency_key`
  // is globally unique (not scoped per sourceModule), and startJobOrder()'s
  // PRODUCTION_CONSUME posting already claims the bare `jobOrder.jobOrderNo`
  // as ITS idempotency key. Reusing the same bare key here would collide
  // with that CONSUME posting (IDEMPOTENCY_KEY_REUSED, since the movement
  // plans differ), so the OUTPUT posting suffixes its own key/correlation id
  // — mirrors how src/modules/stock-returns/service.ts's
  // receiveAndDisposeStockReturnBatch() suffixes its receipt document number
  // (`${batch.documentNo}:RECEIPT`) to stay distinct from the dispatch
  // posting's own `batch.documentNo` key. `sourceDocumentNo` stays the bare
  // jobOrderNo since operational_documents' uniqueness is (module,
  // documentNo) and PRODUCTION_OUTPUT is already a distinct module.
  const outputIdempotencyKey = `${jobOrder.jobOrderNo}:OUTPUT`;
  const postingInput: StockPostingInput = {
    idempotencyKey: outputIdempotencyKey,
    sourceModule: PRODUCTION_OUTPUT_MODULE,
    sourceDocumentNo: jobOrder.jobOrderNo,
    locationId: jobOrder.locationId,
    actorUserId: actor.id,
    sessionId: input.sessionId ?? null,
    correlationId: outputIdempotencyKey,
    movements: [
      {
        warehouseId: jobOrder.productionWarehouseId,
        itemId: outputItemId,
        lotId: outputLotId,
        movementType: "IN",
        quantity: actualOutputQty,
        enteredQuantity: actualOutputQty,
        enteredUom: jobOrder.outputUom,
        conversionFactor: "1.00000000",
        unitCost: outputUnitCost,
        metadata: { jobOrderId: jobOrder.id, jobOrderNo: jobOrder.jobOrderNo },
      },
    ],
  };

  const postingResult = await stockPostingService.post(postingInput);

  return db.transaction(async (tx) => {
    const [postingLine] = await tx
      .select()
      .from(stockPostingLines)
      .where(eq(stockPostingLines.postingId, postingResult.postingId));
    if (!postingLine) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Could not resolve the output posting line for Job Order ${jobOrder.jobOrderNo}.`,
        409,
      );
    }

    const [linked] = await tx
      .update(jobOrderOutputLots)
      .set({ outputPostingLineId: postingLine.id })
      .where(
        and(
          eq(jobOrderOutputLots.jobOrderId, jobOrder.id),
          eq(jobOrderOutputLots.outputLotId, outputLotId),
          sql`${jobOrderOutputLots.outputPostingLineId} IS NULL`,
        ),
      )
      .returning({ id: jobOrderOutputLots.id, outputPostingLineId: jobOrderOutputLots.outputPostingLineId });
    if (!linked) {
      const [existing] = await tx
        .select({ outputPostingLineId: jobOrderOutputLots.outputPostingLineId })
        .from(jobOrderOutputLots)
        .where(
          and(eq(jobOrderOutputLots.jobOrderId, jobOrder.id), eq(jobOrderOutputLots.outputLotId, outputLotId)),
        );
      if (!existing || (existing.outputPostingLineId !== null && existing.outputPostingLineId !== postingLine.id)) {
        throw new StockProductionError(
          "CONCURRENT_MODIFICATION",
          `Output evidence for Job Order ${jobOrder.jobOrderNo} was already linked to a different posting line.`,
          409,
        );
      }
    }

    const [updated] = await tx
      .update(jobOrders)
      .set({
        status: "COMPLETED",
        actualOutputQty,
        completedBy: actor.id,
        completedAt: new Date(),
        version: jobOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOrders.id, jobOrder.id),
          eq(jobOrders.status, "IN_PROGRESS"),
          eq(jobOrders.version, input.expectedVersion),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(jobOrders).where(eq(jobOrders.id, jobOrder.id));
      if (current?.status === "COMPLETED") {
        const allocations = await fetchAllocations(tx, jobOrder.id);
        return { ...current, allocations };
      }
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `Job Order ${jobOrder.jobOrderNo} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      locationId: jobOrder.locationId,
      action: "job_order.completed",
      description: `Completed Job Order ${jobOrder.jobOrderNo}: produced ${actualOutputQty} ${jobOrder.outputUom} against ${componentCount} consumed component(s).`,
      entityType: "job_order",
      entityId: jobOrder.id,
      metadata: {
        actualOutputQty,
        outputUnitCost,
        componentCount,
        totalConsumedCost,
        postingId: postingResult.postingId,
        outputLotId,
      },
    });

    const allocations = await fetchAllocations(tx, jobOrder.id);
    return { ...updated, allocations };
  });
}

export async function getJobOrder(db: DB, input: GetJobOrderInput): Promise<JobOrderWithAllocations> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, false);

    const [jobOrder] = await tx.select().from(jobOrders).where(eq(jobOrders.id, input.jobOrderId));
    if (!jobOrder) {
      throw new StockProductionError("NOT_FOUND", `Job Order ${input.jobOrderId} was not found.`, 404);
    }
    assertLocationInScope(actor.allowedLocationIds, jobOrder.locationId);

    const allocations = await tx
      .select()
      .from(jobOrderComponentAllocations)
      .where(eq(jobOrderComponentAllocations.jobOrderId, jobOrder.id))
      .orderBy(asc(jobOrderComponentAllocations.lineNo));

    return { ...jobOrder, allocations };
  });
}

export async function listJobOrders(db: DB, input: ListJobOrdersInput): Promise<ListJobOrdersPage> {
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, false);

    const conditions = [];
    if (actor.allowedLocationIds !== null) {
      if (actor.allowedLocationIds.length === 0) {
        return { items: [], total: 0 };
      }
      conditions.push(sql`${jobOrders.locationId} = ANY(${actor.allowedLocationIds})`);
    }
    if (input.locationId) {
      assertLocationInScope(actor.allowedLocationIds, input.locationId);
      conditions.push(eq(jobOrders.locationId, input.locationId));
    }
    if (input.bomHeaderId) {
      conditions.push(eq(jobOrders.bomHeaderId, input.bomHeaderId));
    }
    if (input.status) {
      conditions.push(eq(jobOrders.status, input.status));
    }
    if (input.search?.trim()) {
      conditions.push(ilike(jobOrders.jobOrderNo, `%${input.search.trim()}%`));
    }

    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const baseQuery = tx.select().from(jobOrders);
    const items = await (whereClause
      ? baseQuery.where(whereClause).orderBy(desc(jobOrders.createdAt))
      : baseQuery.orderBy(desc(jobOrders.createdAt))
    )
      .limit(limit)
      .offset(offset);

    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(jobOrders)
      .where(whereClause ?? sql`true`);

    return { items, total: row?.count ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface JobOrderActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

type CreateDraftServiceInput = Omit<CreateJobOrderDraftInput, "actorUserId" | "sessionId">;
type GetServiceInput = Omit<GetJobOrderInput, "actorUserId" | "sessionId">;
type ListServiceInput = Omit<ListJobOrdersInput, "actorUserId" | "sessionId">;
type SubmitServiceInput = Omit<SubmitJobOrderInput, "actorUserId" | "sessionId">;
type ApproveServiceInput = Omit<ApproveJobOrderInput, "actorUserId" | "sessionId">;
type ReleaseServiceInput = Omit<ReleaseJobOrderInput, "actorUserId" | "sessionId">;
type StartServiceInput = Omit<StartJobOrderInput, "actorUserId" | "sessionId">;
type CancelServiceInput = Omit<CancelJobOrderInput, "actorUserId" | "sessionId">;
type FailServiceInput = Omit<FailJobOrderInput, "actorUserId" | "sessionId">;
type CompleteServiceInput = Omit<CompleteJobOrderInput, "actorUserId" | "sessionId">;

/** Facade over the standalone Job Order draft-planning + lifecycle functions above. */
export function createJobOrderService(db: DB) {
  const stockPostingService = createStockPostingService(db, {
    documentPolicies: {
      [PRODUCTION_CONSUME_MODULE]: PRODUCTION_CONSUME_POLICY,
      [PRODUCTION_OUTPUT_MODULE]: PRODUCTION_OUTPUT_POLICY,
    },
  });
  return {
    createDraft(ctx: JobOrderActorContext, input: CreateDraftServiceInput) {
      return createJobOrderDraft(db, { ...ctx, ...input });
    },
    get(ctx: JobOrderActorContext, input: GetServiceInput) {
      return getJobOrder(db, { ...ctx, ...input });
    },
    list(ctx: JobOrderActorContext, input: ListServiceInput) {
      return listJobOrders(db, { ...ctx, ...input });
    },
    submit(ctx: JobOrderActorContext, input: SubmitServiceInput) {
      return submitJobOrder(db, { ...ctx, ...input });
    },
    approve(ctx: JobOrderActorContext, input: ApproveServiceInput) {
      return approveJobOrder(db, { ...ctx, ...input });
    },
    release(ctx: JobOrderActorContext, input: ReleaseServiceInput) {
      return releaseJobOrder(db, { ...ctx, ...input });
    },
    start(ctx: JobOrderActorContext, input: StartServiceInput) {
      return startJobOrder(db, stockPostingService, { ...ctx, ...input });
    },
    cancel(ctx: JobOrderActorContext, input: CancelServiceInput) {
      return cancelJobOrder(db, { ...ctx, ...input });
    },
    fail(ctx: JobOrderActorContext, input: FailServiceInput) {
      return failJobOrder(db, { ...ctx, ...input });
    },
    complete(ctx: JobOrderActorContext, input: CompleteServiceInput) {
      return completeJobOrder(db, stockPostingService, { ...ctx, ...input });
    },
  };
}
