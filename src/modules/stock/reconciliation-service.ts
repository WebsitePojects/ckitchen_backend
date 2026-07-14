import { eq, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  inventoryLotBalances,
  inventoryLots,
  inventoryReconciliationRuns,
  operationalFeatureFlags,
  outboxEvents,
} from "../../db/enterprise-schema.js";
import { auditLogs, inventoryStock, users } from "../../db/schema.js";
import { normalizeRole } from "../auth/roles.js";
import { formatFixed, parseFixed } from "./decimal.js";
import { StockPostingError } from "./errors.js";

export interface ReconciliationInput {
  actorUserId: string;
  correlationId: string;
  warehouseId?: string;
}

export interface ReconciliationDrift {
  warehouseId: string;
  itemId: string;
  legacyQuantity: string;
  lotQuantity: string;
  driftQuantity: string;
}

export interface ReconciliationResult {
  runId: string;
  status: "PASSED" | "DRIFT_DETECTED";
  drift: ReconciliationDrift[];
  postingDisabled: boolean;
}

function balanceKey(warehouseId: string, itemId: string): string {
  return `${warehouseId}:${itemId}`;
}

export async function runInventoryReconciliation(
  db: DB,
  input: ReconciliationInput,
): Promise<ReconciliationResult> {
  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, input.actorUserId))
      .for("update");
    const role = normalizeRole(actor?.role);
    if (!actor || actor.status !== "ACTIVE" || !role || !["OWNER", "WAREHOUSE_MAIN"].includes(role)) {
      throw new StockPostingError(
        "UNAUTHORIZED",
        "Only an active OWNER or WAREHOUSE_MAIN actor may reconcile inventory.",
        403,
      );
    }

    // Posting transactions lock this same row before any movement. Holding it
    // gives reconciliation a quiescent snapshot and blocks new postings until
    // PASS or the drift kill-switch update commits.
    const [postingFlag] = await tx
      .select()
      .from(operationalFeatureFlags)
      .where(eq(operationalFeatureFlags.key, "stock.lot_writes"))
      .for("update");
    if (!postingFlag) {
      throw new StockPostingError(
        "FEATURE_DISABLED",
        "The stock.lot_writes operational flag is not configured.",
        503,
      );
    }

    const legacyQuery = tx
      .select({
        warehouseId: inventoryStock.warehouseId,
        itemId: inventoryStock.ingredientId,
        quantity: inventoryStock.quantity,
      })
      .from(inventoryStock);
    const legacyRows = input.warehouseId
      ? await legacyQuery.where(eq(inventoryStock.warehouseId, input.warehouseId))
      : await legacyQuery;

    const lotQuery = tx
      .select({
        warehouseId: inventoryLotBalances.warehouseId,
        itemId: inventoryLots.itemId,
        quantity: sql<string>`COALESCE(SUM(${inventoryLotBalances.onHand}), 0)`,
      })
      .from(inventoryLotBalances)
      .innerJoin(inventoryLots, eq(inventoryLotBalances.lotId, inventoryLots.id))
      .groupBy(inventoryLotBalances.warehouseId, inventoryLots.itemId);
    const lotRows = input.warehouseId
      ? await lotQuery.where(eq(inventoryLotBalances.warehouseId, input.warehouseId))
      : await lotQuery;

    const legacy = new Map(
      legacyRows.map((row) => [balanceKey(row.warehouseId, row.itemId), parseFixed(row.quantity, 6)]),
    );
    const lots = new Map(
      lotRows.map((row) => [balanceKey(row.warehouseId, row.itemId), parseFixed(row.quantity, 6)]),
    );
    const drift: ReconciliationDrift[] = [];
    for (const key of [...new Set([...legacy.keys(), ...lots.keys()])].sort()) {
      const separator = key.indexOf(":");
      const warehouseId = key.slice(0, separator);
      const itemId = key.slice(separator + 1);
      const legacyQuantity = legacy.get(key) ?? 0n;
      const lotQuantity = lots.get(key) ?? 0n;
      const difference = lotQuantity - legacyQuantity;
      if (difference !== 0n) {
        drift.push({
          warehouseId,
          itemId,
          legacyQuantity: formatFixed(legacyQuantity, 6),
          lotQuantity: formatFixed(lotQuantity, 6),
          driftQuantity: formatFixed(difference, 6),
        });
      }
    }

    const status = drift.length === 0 ? "PASSED" : "DRIFT_DETECTED";
    const legacyTotal = [...legacy.values()].reduce((sum, quantity) => sum + quantity, 0n);
    const lotTotal = [...lots.values()].reduce((sum, quantity) => sum + quantity, 0n);
    const [run] = await tx
      .insert(inventoryReconciliationRuns)
      .values({
        status,
        scopeWarehouseId: input.warehouseId ?? null,
        legacyTotal: formatFixed(legacyTotal, 6),
        lotTotal: formatFixed(lotTotal, 6),
        driftQuantity: formatFixed(lotTotal - legacyTotal, 6),
        details: { drift },
        startedBy: actor.id,
        completedAt: new Date(),
      })
      .returning();

    if (drift.length > 0) {
      await tx
        .update(operationalFeatureFlags)
        .set({
          enabled: false,
          version: sql`${operationalFeatureFlags.version} + 1`,
          updatedBy: actor.id,
          updatedAt: new Date(),
        })
        .where(eq(operationalFeatureFlags.id, postingFlag.id));
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      correlationId: input.correlationId,
      action: `stock.reconciliation.${status.toLowerCase()}`,
      description:
        status === "PASSED"
          ? "Inventory lot balances reconcile to the compatibility aggregate."
          : `Inventory reconciliation found ${drift.length} drift row(s); stock posting was disabled.`,
      entityType: "inventory_reconciliation_run",
      entityId: run.id,
      metadata: { driftCount: drift.length, scopeWarehouseId: input.warehouseId ?? null },
    });
    await tx.insert(outboxEvents).values({
      eventType: `stock.reconciliation.${status.toLowerCase()}`,
      aggregateType: "inventory_reconciliation_run",
      aggregateId: run.id,
      correlationId: input.correlationId,
      payload: { runId: run.id, status, driftCount: drift.length },
    });

    return {
      runId: run.id,
      status,
      drift,
      postingDisabled: drift.length > 0 || !postingFlag.enabled,
    };
  });
}
