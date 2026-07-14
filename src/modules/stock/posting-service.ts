import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLotBalances,
  inventoryLots,
  itemUomConversions,
  operationalDocuments,
  operationalFeatureFlags,
  outboxEvents,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../../db/enterprise-schema.js";
import {
  auditLogs,
  ingredients,
  userOutletAccess,
  users,
  userSessions,
  warehouses,
} from "../../db/schema.js";
import { normalizeRole, outletScopeForRole } from "../auth/roles.js";
import { canonicalizePosting, hashPostingLine, STOCK_POSTING_HASH_VERSION } from "./canonical.js";
import { formatFixed, multiplyFixedExact, normalizeFixed, parseFixed } from "./decimal.js";
import { findSqlState, StockPostingError } from "./errors.js";
import type {
  SourceEligibilityPolicy,
  StockDocumentPolicy,
  StockPostingDependencies,
  StockPostingInput,
  StockPostingLineResult,
  StockPostingResult,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type LotRow = typeof inventoryLots.$inferSelect;
type BalanceRow = typeof inventoryLotBalances.$inferSelect;
type WarehouseRow = typeof warehouses.$inferSelect;

interface LockedKeyState {
  key: string;
  lot: LotRow;
  balance: BalanceRow;
  warehouse: WarehouseRow;
  initialOnHand: bigint;
  currentOnHand: bigint;
  reserved: bigint;
}

function keyOf(movement: StockPostingInput["movements"][number]): string {
  return [movement.warehouseId, movement.itemId, movement.lotId].join(":");
}

function manilaDate(): string {
  // Asia/Manila has no DST and is fixed UTC+08:00.
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isOutEligible(lot: LotRow, policy: SourceEligibilityPolicy, today: string): boolean {
  if (policy === "ALLOCATABLE") {
    return lot.status === "AVAILABLE" && (!lot.expiresAt || lot.expiresAt >= today);
  }
  if (policy === "CUSTODY_MOVE") {
    return lot.status !== "DISPOSED" && lot.status !== "EXHAUSTED";
  }
  // DISPOSITION (return disposition OUT) and QUARANTINE_RELEASE (QA release
  // OUT) share this same quarantine-adjacent eligibility set — only a lot
  // already sitting in a quarantine/disposition-eligible status may leave.
  return ["QUARANTINED", "EXPIRED", "SPOILED", "RECALLED"].includes(lot.status);
}

function validateInput(input: StockPostingInput): void {
  if (!input.actorUserId) {
    throw new StockPostingError("UNAUTHORIZED", "A server-authenticated actor is required.", 401);
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new StockPostingError("INVALID_MOVEMENT", "A bounded idempotency key is required.", 400);
  }
  if (!input.correlationId.trim() || input.correlationId.length > 200) {
    throw new StockPostingError("INVALID_MOVEMENT", "A bounded correlation ID is required.", 400);
  }
  if (!input.sourceModule.trim() || !input.sourceDocumentNo.trim()) {
    throw new StockPostingError(
      "INVALID_MOVEMENT",
      "sourceModule and sourceDocumentNo are required.",
      400,
    );
  }
  if (input.movements.length === 0 || input.movements.length > 500) {
    throw new StockPostingError(
      "INVALID_MOVEMENT",
      "A posting must contain between 1 and 500 movement lines.",
      400,
    );
  }
  for (const [index, movement] of input.movements.entries()) {
    if (!movement.warehouseId || !movement.itemId || !movement.lotId || !movement.enteredUom.trim()) {
      throw new StockPostingError(
        "INVALID_MOVEMENT",
        `Movement ${index + 1} is missing an identity or UOM.`,
        400,
      );
    }
    if (parseFixed(movement.quantity, 6) <= 0n) {
      throw new StockPostingError(
        "INVALID_MOVEMENT",
        `Movement ${index + 1} quantity must be positive.`,
        400,
      );
    }
  }
}

async function assertFeatureFlags(tx: Tx, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    const [flag] = await tx
      .select()
      .from(operationalFeatureFlags)
      .where(eq(operationalFeatureFlags.key, key))
      .for("update");
    if (!flag?.enabled) {
      throw new StockPostingError(
        "FEATURE_DISABLED",
        `Operational feature "${key}" is disabled.`,
        503,
        { feature: key },
      );
    }
  }
}

async function assertTopologyReady(tx: Tx): Promise<void> {
  const hqRows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.purpose, "HQ_MAIN"), eq(warehouses.isActive, true)))
    .for("update");
  const openExceptions = await tx
    .select({ id: topologyMigrationExceptions.id })
    .from(topologyMigrationExceptions)
    .where(eq(topologyMigrationExceptions.status, "OPEN"))
    .for("update");
  if (hqRows.length !== 1 || openExceptions.length > 0) {
    throw new StockPostingError(
      "FEATURE_DISABLED",
      "Enterprise warehouse topology is not ready for stock posting.",
      503,
      { activeHqMainCount: hqRows.length, openTopologyExceptions: openExceptions.length },
    );
  }
}

async function authorizeActor(
  tx: Tx,
  input: StockPostingInput,
  policy: StockDocumentPolicy,
): Promise<{ id: string; name: string; role: string; allowedLocationIds: string[] | null }> {
  const [actor] = await tx
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .for("update");
  const role = normalizeRole(actor?.role);
  if (!actor || actor.status !== "ACTIVE" || !role || !policy.allowedRoles.includes(role)) {
    throw new StockPostingError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to execute this stock document.",
      403,
    );
  }

  if (input.sessionId) {
    const [session] = await tx
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.id, input.sessionId),
          eq(userSessions.userId, actor.id),
          sql`${userSessions.logoutAt} IS NULL`,
        ),
      );
    if (!session) {
      throw new StockPostingError("UNAUTHORIZED", "The actor session is not active.", 401);
    }
  }

  let allowedLocationIds: string[] | null = null;
  if (outletScopeForRole(role) !== "ALL") {
    const access = await tx
      .select({ locationId: userOutletAccess.locationId })
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, actor.id));
    allowedLocationIds = access.map((row) => row.locationId);
    if (!allowedLocationIds.includes(input.locationId)) {
      throw new StockPostingError(
        "UNAUTHORIZED",
        "The stock document is outside the actor's outlet scope.",
        403,
      );
    }
  }
  return { id: actor.id, name: actor.name, role, allowedLocationIds };
}

async function lockOperationalDocument(tx: Tx, input: StockPostingInput) {
  const [document] = await tx
    .select()
    .from(operationalDocuments)
    .where(
      and(
        eq(operationalDocuments.module, input.sourceModule),
        eq(operationalDocuments.documentNo, input.sourceDocumentNo),
      ),
    )
    .for("update");
  if (!document) {
    throw new StockPostingError(
      "DOCUMENT_NOT_FOUND",
      `${input.sourceModule} document ${input.sourceDocumentNo} was not found.`,
      404,
    );
  }
  if (document.locationId !== input.locationId) {
    throw new StockPostingError(
      "UNAUTHORIZED",
      "The posting outlet does not match the server-owned document outlet.",
      403,
    );
  }
  return document;
}

function validateRoute(
  policy: StockDocumentPolicy,
  input: StockPostingInput,
  warehousesById: Map<string, WarehouseRow>,
): void {
  const movements = input.movements;
  const reject = (message: string): never => {
    throw new StockPostingError("FORBIDDEN_ROUTE", message, 409);
  };
  const matches = (
    movement: StockPostingInput["movements"][number],
    directions: Array<"IN" | "OUT">,
    purposes: string[],
  ) => {
    const warehouse = warehousesById.get(movement.warehouseId)!;
    return directions.includes(movement.movementType) && !!warehouse.purpose && purposes.includes(warehouse.purpose);
  };

  // D36: these route classes are outlet-local by contract. Locked warehouse
  // location is server-owned truth, so this check holds regardless of the
  // actor's outlet scope (an ALL-scope actor must not be able to smuggle a
  // second physical outlet in via a route whose purpose check alone can't see it).
  const singleOutletRouteClasses: ReadonlySet<string> = new Set([
    "RECEIVE",
    "ORDER_DEDUCTION",
    "ADJUSTMENT",
    "INTERNAL_TRANSFER",
    "OUTLET_RETURN_DISPATCH",
    // QA_RELEASE's fixed route (QUARANTINE -> HQ_MAIN, both HQ-only purposes)
    // is always single-location by construction, but this generic check adds
    // defense-in-depth for free, same as OUTLET_RETURN_DISPATCH.
    "QA_RELEASE",
  ]);
  if (singleOutletRouteClasses.has(policy.routeClass)) {
    const locationIds = new Set(movements.map((m) => warehousesById.get(m.warehouseId)!.locationId));
    if (locationIds.size > 1) {
      reject("A single posting cannot move stock directly between outlet locations.");
    }
    if (policy.routeClass === "INTERNAL_TRANSFER" && [...locationIds][0] !== input.locationId) {
      reject("Internal transfers must stay within the posting's own outlet location.");
    }
  }

  if (policy.routeClass === "RECEIVE") {
    if (!movements.every((m) => matches(m, ["IN"], ["HQ_MAIN"]))) reject("Receipts may enter HQ_MAIN only.");
  } else if (policy.routeClass === "ORDER_DEDUCTION") {
    if (!movements.every((m) => matches(m, ["OUT"], ["KITCHEN", "OUTLET_STORAGE"]))) {
      reject("Order deductions may leave the order outlet's KITCHEN/OUTLET_STORAGE only.");
    }
    if (!movements.every((m) => (m.sourcePolicy ?? "ALLOCATABLE") === "ALLOCATABLE")) {
      reject("Order deductions require allocatable lots.");
    }
  } else if (policy.routeClass === "OUTLET_RETURN_DISPATCH") {
    if (!movements.every((m) => matches(m, ["OUT"], ["OUTLET_STORAGE", "KITCHEN"]))) {
      reject("Outlet return dispatch may leave outlet storage or kitchen only.");
    }
    if (!movements.every((m) => m.sourcePolicy === "CUSTODY_MOVE")) {
      reject("Outlet return dispatch requires custody-move policy.");
    }
  } else if (policy.routeClass === "RETURN_DISPOSITION") {
    if (!movements.every((m) => matches(m, ["IN", "OUT"], ["QUARANTINE"]))) {
      reject("Return receipt/disposition must remain inside HQ quarantine custody.");
    }
    // D35-D46 §5: a reusable-reason receipt line posts an unpaired quarantine
    // IN (tagged QUARANTINE_HOLD) with no compensating disposition OUT ever
    // following, so the balance survives receipt for a later QA Release to
    // move out. That IN is excluded from the net-zero check below; every
    // disposition-reason IN/OUT pair still nets to zero exactly as before.
    const netByItemLot = new Map<string, bigint>();
    for (const movement of movements) {
      if (movement.movementType === "OUT" && movement.sourcePolicy !== "DISPOSITION") {
        reject("Quarantine disposition OUT requires DISPOSITION policy.");
      }
      if (movement.movementType === "IN" && movement.sourcePolicy === "QUARANTINE_HOLD") {
        continue;
      }
      const key = `${movement.itemId}:${movement.lotId}`;
      const signed = movement.movementType === "IN" ? parseFixed(movement.quantity, 6) : -parseFixed(movement.quantity, 6);
      netByItemLot.set(key, (netByItemLot.get(key) ?? 0n) + signed);
    }
    if ([...netByItemLot.values()].some((net) => net !== 0n)) {
      reject("Immediate return disposition must have equal quarantine IN and OUT quantities.");
    }
  } else if (policy.routeClass === "QA_RELEASE") {
    // D35-D46 §2: "HQ QUARANTINE -> HQ_MAIN | QA Release | Yes, only for
    // reusable stock" is the ONLY legal route for this class — no other
    // existing route class permits an OUT@QUARANTINE movement (RETURN_
    // DISPOSITION confines both IN and OUT to QUARANTINE and forces a net-
    // zero same-lot pair; HQ_TRANSFER's OUT allowlist is HQ_MAIN/PRODUCTION
    // only, deliberately excluding QUARANTINE per transfers/policies.ts's own
    // route-pair comment: "QUARANTINE moves are QA Release — none of those go
    // through this module"). Each movement must independently be either the
    // QUARANTINE-side OUT or the HQ_MAIN-side IN of that route.
    if (
      !movements.every(
        (m) => matches(m, ["OUT"], ["QUARANTINE"]) || matches(m, ["IN"], ["HQ_MAIN"]),
      )
    ) {
      reject("QA release may only move stock from HQ quarantine custody to HQ_MAIN.");
    }
    if (!movements.every((m) => m.movementType !== "OUT" || m.sourcePolicy === "QUARANTINE_RELEASE")) {
      reject("QA release OUT movements require QUARANTINE_RELEASE policy.");
    }
  } else if (policy.routeClass === "INTERNAL_TRANSFER") {
    if (
      !movements.every(
        (m) =>
          matches(m, ["OUT"], ["OUTLET_STORAGE"]) || matches(m, ["IN"], ["KITCHEN"]),
      )
    ) {
      reject("Internal transfers are OUTLET_STORAGE to KITCHEN only.");
    }
  } else if (policy.routeClass === "HQ_TRANSFER") {
    if (
      !movements.every(
        (m) =>
          matches(m, ["OUT"], ["HQ_MAIN", "PRODUCTION"]) ||
          matches(m, ["IN"], ["OUTLET_STORAGE", "PRODUCTION", "HQ_MAIN"]),
      )
    ) {
      reject("HQ transfers must originate from HQ_MAIN/PRODUCTION and terminate at an approved node.");
    }
    const nonHqLocations = new Set(
      movements
        .map((m) => warehousesById.get(m.warehouseId)!)
        .filter((w) => !["HQ_MAIN", "QUARANTINE"].includes(w.purpose ?? ""))
        .map((w) => w.locationId),
    );
    if (nonHqLocations.size > 1) reject("A single posting cannot move stock directly between outlets.");
  } else if (policy.routeClass === "PRODUCTION") {
    if (!movements.every((m) => ["HQ_MAIN", "PRODUCTION"].includes(warehousesById.get(m.warehouseId)?.purpose ?? ""))) {
      reject("Production postings may use HQ_MAIN or PRODUCTION nodes only.");
    }
  } else if (policy.routeClass === "OPENING_BALANCE") {
    if (!movements.every((m) => m.movementType === "IN")) reject("Opening balances are IN-only.");
  } else if (policy.routeClass === "ADJUSTMENT") {
    if (new Set(movements.map((m) => m.warehouseId)).size !== 1) {
      reject("An adjustment posting is scoped to one warehouse.");
    }
  }
}

async function lockMovementKeys(
  tx: Tx,
  input: StockPostingInput,
  policy: StockDocumentPolicy,
  allowedLocationIds: string[] | null,
): Promise<Map<string, LockedKeyState>> {
  const groups = new Map<string, StockPostingInput["movements"]>();
  for (const movement of input.movements) {
    const key = keyOf(movement);
    const group = groups.get(key) ?? [];
    group.push(movement);
    groups.set(key, group);
  }

  // Global deterministic lock order used by every posting: warehouses, items,
  // UOM conversions, lots, then balances. No transaction interleaves lot and
  // balance locks, avoiding the overlapping multi-warehouse deadlock pattern.
  const warehousesById = new Map<string, WarehouseRow>();
  for (const warehouseId of [...new Set(input.movements.map((m) => m.warehouseId))].sort()) {
    const [warehouse] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .for("update");
    if (!warehouse || !warehouse.isActive || !warehouse.purpose) {
      throw new StockPostingError(
        "FORBIDDEN_ROUTE",
        `Warehouse ${warehouseId} is missing, inactive, or not mapped to an enterprise purpose.`,
        409,
      );
    }
    if (allowedLocationIds && !allowedLocationIds.includes(warehouse.locationId)) {
      throw new StockPostingError(
        "UNAUTHORIZED",
        `Warehouse ${warehouseId} is outside the actor's outlet scope.`,
        403,
      );
    }
    warehousesById.set(warehouseId, warehouse);
  }
  validateRoute(policy, input, warehousesById);

  const itemsById = new Map<string, typeof ingredients.$inferSelect>();
  for (const itemId of [...new Set(input.movements.map((m) => m.itemId))].sort()) {
    const [item] = await tx.select().from(ingredients).where(eq(ingredients.id, itemId)).for("update");
    if (!item || !item.isActive || item.itemType === "SERVICE") {
      throw new StockPostingError(
        "INVALID_MOVEMENT",
        `Item ${itemId} is missing, inactive, or non-stock.`,
        409,
      );
    }
    itemsById.set(itemId, item);
  }

  const conversionByItemUom = new Map<string, string>();
  const conversionKeys = [
    ...new Set(input.movements.map((m) => `${m.itemId}:${m.enteredUom.trim().toLowerCase()}`)),
  ].sort();
  for (const conversionKey of conversionKeys) {
    const separator = conversionKey.indexOf(":");
    const itemId = conversionKey.slice(0, separator);
    const enteredUom = conversionKey.slice(separator + 1);
    const item = itemsById.get(itemId)!;
    if (item.unit.trim().toLowerCase() === enteredUom) {
      conversionByItemUom.set(conversionKey, "1.00000000");
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
      )
      .for("update");
    if (!conversion) {
      throw new StockPostingError(
        "UOM_MISMATCH",
        `No active ${enteredUom} conversion exists for item ${itemId}.`,
        409,
      );
    }
    conversionByItemUom.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  for (const movement of input.movements) {
    const conversionKey = `${movement.itemId}:${movement.enteredUom.trim().toLowerCase()}`;
    const configuredFactor = conversionByItemUom.get(conversionKey)!;
    if (normalizeFixed(movement.conversionFactor ?? "1", 8) !== configuredFactor) {
      throw new StockPostingError(
        "UOM_MISMATCH",
        `The snapshotted conversion factor for ${movement.enteredUom} is not current/approved.`,
        409,
      );
    }
    const calculatedBase = multiplyFixedExact(
      movement.enteredQuantity ?? movement.quantity,
      6,
      configuredFactor,
      8,
      6,
    );
    if (calculatedBase !== normalizeFixed(movement.quantity, 6)) {
      throw new StockPostingError(
        "UOM_MISMATCH",
        "Base quantity does not equal entered quantity multiplied by the approved conversion.",
        409,
        { calculatedBase, suppliedBase: normalizeFixed(movement.quantity, 6) },
      );
    }
  }

  const lotsById = new Map<string, LotRow>();
  for (const lotId of [...new Set(input.movements.map((m) => m.lotId))].sort()) {
    const [lot] = await tx.select().from(inventoryLots).where(eq(inventoryLots.id, lotId)).for("update");
    if (!lot) throw new StockPostingError("LOT_NOT_FOUND", `Inventory lot ${lotId} was not found.`, 404);
    lotsById.set(lotId, lot);
  }

  const today = manilaDate();
  for (const movement of input.movements) {
    const lot = lotsById.get(movement.lotId)!;
    if (lot.itemId !== movement.itemId) {
      throw new StockPostingError(
        "LOT_ITEM_MISMATCH",
        `Lot ${movement.lotId} does not belong to item ${movement.itemId}.`,
        409,
      );
    }
    if (movement.movementType === "OUT") {
      const sourcePolicy = movement.sourcePolicy ?? "ALLOCATABLE";
      if (!isOutEligible(lot, sourcePolicy, today)) {
        throw new StockPostingError(
          "LOT_NOT_ELIGIBLE",
          `Lot ${lot.lotCode} (${lot.status}) is not eligible under ${sourcePolicy}.`,
          409,
          { lotId: lot.id, status: lot.status, policy: sourcePolicy },
        );
      }
    }
  }

  // Create missing destination balances in sorted order before any balance lock.
  for (const key of [...groups.keys()].sort()) {
    const movements = groups.get(key)!;
    const first = movements[0]!;
    if (movements.some((movement) => movement.movementType === "IN")) {
      await tx
        .insert(inventoryLotBalances)
        .values({ warehouseId: first.warehouseId, lotId: first.lotId })
        .onConflictDoNothing();
    }
  }

  const states = new Map<string, LockedKeyState>();
  for (const key of [...groups.keys()].sort()) {
    const first = groups.get(key)![0]!;
    const [balance] = await tx
      .select()
      .from(inventoryLotBalances)
      .where(
        and(
          eq(inventoryLotBalances.warehouseId, first.warehouseId),
          eq(inventoryLotBalances.lotId, first.lotId),
        ),
      )
      .for("update");
    if (!balance) {
      throw new StockPostingError(
        "INSUFFICIENT_STOCK",
        `No source balance exists for warehouse ${first.warehouseId}, lot ${first.lotId}.`,
        409,
      );
    }
    states.set(key, {
      key,
      lot: lotsById.get(first.lotId)!,
      warehouse: warehousesById.get(first.warehouseId)!,
      balance,
      initialOnHand: parseFixed(balance.onHand, 6),
      currentOnHand: parseFixed(balance.onHand, 6),
      reserved: parseFixed(balance.reserved, 6),
    });
  }
  return states;
}

function storedReplay(row: typeof stockPostings.$inferSelect): StockPostingResult {
  if (row.status !== "COMPLETED" || !row.result) {
    throw new StockPostingError(
      "POSTING_IN_PROGRESS",
      `Posting ${row.idempotencyKey} is not in a replayable terminal state.`,
      409,
    );
  }
  const result = row.result as Omit<StockPostingResult, "replayed">;
  return { ...result, replayed: true };
}

async function executePosting(
  db: DB,
  input: StockPostingInput,
  dependencies: StockPostingDependencies,
): Promise<StockPostingResult> {
  validateInput(input);
  if (["1", "true", "yes"].includes((process.env.STOCK_POSTING_DISABLED ?? "").toLowerCase())) {
    throw new StockPostingError("FEATURE_DISABLED", "Emergency stock-posting switch is active.", 503);
  }

  const policy = dependencies.documentPolicies[input.sourceModule];
  if (!policy) {
    throw new StockPostingError(
      "INVALID_MOVEMENT",
      `No server-owned posting policy is registered for ${input.sourceModule}.`,
      409,
    );
  }

  const { requestHash, normalized } = canonicalizePosting(input);
  return db.transaction(async (tx) => {
    const actor = await authorizeActor(tx, normalized, policy);
    await assertFeatureFlags(
      tx,
      ["stock.lot_writes", policy.featureFlag].filter((value): value is string => !!value),
    );
    await assertTopologyReady(tx);
    const document = await lockOperationalDocument(tx, normalized);

    const [claimed] = await tx
      .insert(stockPostings)
      .values({
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        hashVersion: STOCK_POSTING_HASH_VERSION,
        status: "PROCESSING",
        sourceModule: normalized.sourceModule,
        sourceDocumentNo: normalized.sourceDocumentNo,
        locationId: normalized.locationId,
        actorUserId: actor.id,
        correlationId: normalized.correlationId,
      })
      .onConflictDoNothing()
      .returning();

    if (!claimed) {
      const [existing] = await tx
        .select()
        .from(stockPostings)
        .where(eq(stockPostings.idempotencyKey, normalized.idempotencyKey))
        .for("update");
      if (!existing) {
        throw new StockPostingError(
          "CONCURRENT_MODIFICATION",
          "Posting key was claimed concurrently but could not be read.",
          409,
        );
      }
      if (existing.requestHash !== requestHash || existing.hashVersion !== STOCK_POSTING_HASH_VERSION) {
        throw new StockPostingError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was already used for a different movement plan.",
          409,
          { idempotencyKey: normalized.idempotencyKey },
        );
      }
      return storedReplay(existing);
    }

    if (!policy.fromStatuses.includes(document.status)) {
      throw new StockPostingError(
        "INVALID_TRANSITION",
        `${normalized.sourceModule} ${normalized.sourceDocumentNo} is ${document.status}; expected ${policy.fromStatuses.join(" or ")}.`,
        409,
      );
    }

    await dependencies.faultInjector?.("after_claim");
    const states = await lockMovementKeys(tx, normalized, policy, actor.allowedLocationIds);

    const plannedLines: Array<
      StockPostingLineResult & {
        enteredQuantity: string;
        enteredUom: string;
        conversionFactor: string;
        unitCost: string;
        reasonCode?: string;
        metadata?: Record<string, unknown>;
        lineHash: string;
      }
    > = [];

    for (const [index, movement] of normalized.movements.entries()) {
      const state = states.get(keyOf(movement))!;
      const quantity = parseFixed(movement.quantity, 6);
      const before = state.currentOnHand;
      const after = movement.movementType === "IN" ? before + quantity : before - quantity;
      if (after < state.reserved || after < 0n) {
        throw new StockPostingError(
          "INSUFFICIENT_STOCK",
          `Insufficient available stock for lot ${state.lot.lotCode}.`,
          409,
          {
            warehouseId: movement.warehouseId,
            lotId: movement.lotId,
            onHand: formatFixed(before, 6),
            reserved: formatFixed(state.reserved, 6),
            requested: formatFixed(quantity, 6),
          },
        );
      }
      state.currentOnHand = after;
      const lineNo = index + 1;
      const lineBase = {
        lineNo,
        warehouseId: movement.warehouseId,
        itemId: movement.itemId,
        lotId: movement.lotId,
        movementType: movement.movementType,
        quantity: String(movement.quantity),
        enteredQuantity: String(movement.enteredQuantity ?? movement.quantity),
        enteredUom: movement.enteredUom,
        conversionFactor: String(movement.conversionFactor ?? "1"),
        unitCost: String(movement.unitCost ?? "0"),
        reasonCode: movement.reasonCode,
        balanceBefore: formatFixed(before, 6),
        balanceAfter: formatFixed(after, 6),
        metadata: movement.metadata,
      };
      plannedLines.push({ ...lineBase, lineHash: hashPostingLine(lineBase) });
    }

    const insertedLines = await tx
      .insert(stockPostingLines)
      .values(
        plannedLines.map((line) => ({
          postingId: claimed.id,
          lineNo: line.lineNo,
          warehouseId: line.warehouseId,
          itemId: line.itemId,
          lotId: line.lotId,
          movementType: line.movementType,
          quantity: line.quantity,
          enteredQuantity: line.enteredQuantity,
          enteredUom: line.enteredUom,
          conversionFactor: line.conversionFactor,
          unitCost: line.unitCost,
          reasonCode: line.reasonCode ?? null,
          balanceBefore: line.balanceBefore,
          balanceAfter: line.balanceAfter,
          lineHash: line.lineHash,
          metadata: line.metadata ?? null,
        })),
      )
      .returning({ lineNo: stockPostingLines.lineNo, lineHash: stockPostingLines.lineHash });

    const expectedLineHashes = new Map(plannedLines.map((line) => [line.lineNo, line.lineHash]));
    if (
      insertedLines.length !== plannedLines.length ||
      insertedLines.some((row) => expectedLineHashes.get(row.lineNo) !== row.lineHash)
    ) {
      throw new StockPostingError(
        "LEDGER_MISMATCH",
        "The immutable ledger did not accept the complete normalized movement plan.",
        500,
      );
    }
    await dependencies.faultInjector?.("after_ledger");

    for (const state of [...states.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      const [updated] = await tx
        .update(inventoryLotBalances)
        .set({
          onHand: formatFixed(state.currentOnHand, 6),
          version: sql`${inventoryLotBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryLotBalances.id, state.balance.id),
            eq(inventoryLotBalances.version, state.balance.version),
            sql`${inventoryLotBalances.onHand} = ${formatFixed(state.initialOnHand, 6)}::numeric`,
            sql`${formatFixed(state.currentOnHand, 6)}::numeric >= ${inventoryLotBalances.reserved}`,
          ),
        )
        .returning({ id: inventoryLotBalances.id });
      if (!updated) {
        throw new StockPostingError(
          "CONCURRENT_MODIFICATION",
          `Lot balance ${state.balance.id} changed concurrently.`,
          409,
        );
      }
    }
    await dependencies.faultInjector?.("after_balance");

    const [advancedDocument] = await tx
      .update(operationalDocuments)
      .set({
        status: policy.nextStatus,
        version: sql`${operationalDocuments.version} + 1`,
        stockPostingId: claimed.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(operationalDocuments.id, document.id),
          eq(operationalDocuments.status, document.status),
          eq(operationalDocuments.version, document.version),
          sql`${operationalDocuments.stockPostingId} IS NULL`,
        ),
      )
      .returning({ id: operationalDocuments.id });
    if (!advancedDocument) {
      throw new StockPostingError(
        "CONCURRENT_MODIFICATION",
        `Document ${normalized.sourceDocumentNo} changed concurrently.`,
        409,
      );
    }
    await dependencies.faultInjector?.("after_document");

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: normalized.sessionId ?? null,
      locationId: normalized.locationId,
      correlationId: normalized.correlationId,
      postingId: claimed.id,
      action: "stock.posting.completed",
      description: `Posted ${plannedLines.length} stock movement line(s) for ${normalized.sourceModule} ${normalized.sourceDocumentNo}`,
      entityType: "stock_posting",
      entityId: claimed.id,
      metadata: {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        lineCount: plannedLines.length,
        documentStatus: { from: document.status, to: policy.nextStatus },
      },
    });
    await dependencies.faultInjector?.("after_audit");

    await tx.insert(outboxEvents).values({
      eventType: "stock.posting.completed",
      aggregateType: "stock_posting",
      aggregateId: claimed.id,
      locationId: normalized.locationId,
      correlationId: normalized.correlationId,
      payload: {
        postingId: claimed.id,
        sourceModule: normalized.sourceModule,
        sourceDocumentNo: normalized.sourceDocumentNo,
        lineCount: plannedLines.length,
        documentStatus: policy.nextStatus,
      },
    });
    await dependencies.faultInjector?.("after_outbox");

    const result: StockPostingResult = {
      postingId: claimed.id,
      replayed: false,
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      sourceModule: normalized.sourceModule,
      sourceDocumentNo: normalized.sourceDocumentNo,
      lines: plannedLines.map((line) => ({
        lineNo: line.lineNo,
        warehouseId: line.warehouseId,
        itemId: line.itemId,
        lotId: line.lotId,
        movementType: line.movementType,
        quantity: line.quantity,
        balanceBefore: line.balanceBefore,
        balanceAfter: line.balanceAfter,
      })),
    };

    const [completedPosting] = await tx
      .update(stockPostings)
      .set({ status: "COMPLETED", result, completedAt: new Date() })
      .where(and(eq(stockPostings.id, claimed.id), eq(stockPostings.status, "PROCESSING")))
      .returning({ id: stockPostings.id });
    if (!completedPosting) {
      throw new StockPostingError(
        "CONCURRENT_MODIFICATION",
        `Posting ${claimed.id} could not reach COMPLETED.`,
        409,
      );
    }

    return result;
  });
}

export function createStockPostingService(db: DB, dependencies: StockPostingDependencies) {
  const maxRetries = Math.max(0, Math.min(dependencies.maxSerializationRetries ?? 3, 3));
  return {
    async post(input: StockPostingInput): Promise<StockPostingResult> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await executePosting(db, input, dependencies);
        } catch (error) {
          const retryable = ["40001", "40P01"].includes(findSqlState(error) ?? "");
          if (!retryable || attempt >= maxRetries) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 5 + attempt * 10));
        }
      }
    },
  };
}
