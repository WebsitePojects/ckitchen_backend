/**
 * FEFO lot-selection + reservation-bookkeeping helpers for the Customer Order
 * lifecycle service (extracted from service.ts to keep that file's transition
 * logic readable). Nothing here ever writes to inventory_lot_balances or
 * calls the central stock posting service -- allocate() performs no stock
 * movement, only a reservation record (see selectFefoAllocationPortions doc
 * comment below for why that means this module owns its own serialization).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { inventoryLotBalances, inventoryLots } from "../../db/enterprise-schema.js";
import { warehouses } from "../../db/schema.js";
import { customerOrderAllocations } from "../../db/customer-orders-schema.js";
import { formatFixed, parseFixed } from "../stock/decimal.js";
import { CustomerOrderError } from "./errors.js";
import { CUSTOMER_ORDER_SOURCE_WAREHOUSE_PURPOSES } from "./policies.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Asia/Manila has no DST and is fixed UTC+08:00 (mirrors posting-service.ts). */
function manilaDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface FefoAllocationPortion {
  lotId: string;
  warehouseId: string;
  qtyBase: bigint;
}

/** Resolves an outlet's active OUTLET_STORAGE/KITCHEN warehouse ids (D35-D46 §7's "order's outlet nodes"). */
export async function resolveOutletSourceWarehouseIds(tx: Tx, locationId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.locationId, locationId),
        eq(warehouses.isActive, true),
        inArray(warehouses.purpose, [...CUSTOMER_ORDER_SOURCE_WAREHOUSE_PURPOSES]),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * FEFO-selects eligible AVAILABLE, non-expired lots of `itemId` across
 * `warehouseIds` (optionally narrowed to one specific `lotId`, used by the
 * job-order-output allocation path), respecting every OTHER currently ACTIVE
 * customer_order_allocation reservation against the same (lot, warehouse)
 * pair -- `available = onHand - reserved` where `reserved` is the SUM of
 * every ACTIVE allocation row against that exact pair, across every order and
 * line (D35-D46 §4's "Available stock excludes reserved... lots").
 *
 * This deliberately does NOT read or write `inventory_lot_balance.reserved` --
 * that column is authoritative ledger state the central posting service
 * would need to manage consistently (increment on reserve, decrement on
 * release/consume), and this service never calls the posting service until
 * fulfill(). Using customer_order_allocation's own ACTIVE rows as the
 * reservation ledger keeps this module's "ALL stock effects through posting
 * service, zero direct balance/ledger writes" boundary intact.
 *
 * Because allocate()'s only write is inserting new ACTIVE allocation rows
 * (no posting-service call, unlike job-order-service.ts's selectFefoLots(),
 * which can safely be a non-locking SELECT because the posting service's own
 * FOR UPDATE + balance check is the actual safety net at consume time), THIS
 * function must itself be the serialization point against a concurrent
 * allocate() call racing for the same lot. Locking each candidate
 * inventory_lot_balance row FOR UPDATE (single-table, sorted-key order,
 * mirroring posting-service.ts's lockMovementKeys()) achieves that: two
 * concurrent transactions both trying to lock the same balance row serialize
 * on it, so the second transaction's reserved-sum recomputation always
 * observes the first transaction's newly committed allocation row.
 */
export async function selectFefoAllocationPortions(
  tx: Tx,
  itemId: string,
  warehouseIds: string[],
  neededBase: bigint,
  itemLabel: string,
  options: { lotId?: string } = {},
): Promise<FefoAllocationPortion[]> {
  if (warehouseIds.length === 0) {
    throw new CustomerOrderError(
      "VALIDATION",
      `No eligible OUTLET_STORAGE/KITCHEN warehouse is configured for item ${itemLabel}'s order outlet.`,
      409,
      { itemId },
    );
  }

  const today = manilaDate();
  const conditions = [
    eq(inventoryLots.itemId, itemId),
    inArray(inventoryLotBalances.warehouseId, warehouseIds),
    eq(inventoryLots.status, "AVAILABLE"),
    sql`(${inventoryLots.expiresAt} IS NULL OR ${inventoryLots.expiresAt} >= ${today})`,
  ];
  if (options.lotId) {
    conditions.push(eq(inventoryLots.id, options.lotId));
  }

  // Plain (non-locking) join to discover FEFO order + candidate (lot,
  // warehouse) pairs; the actual balance read-and-lock happens per key below.
  const candidates = await tx
    .select({
      lotId: inventoryLots.id,
      lotCode: inventoryLots.lotCode,
      warehouseId: inventoryLotBalances.warehouseId,
    })
    .from(inventoryLotBalances)
    .innerJoin(inventoryLots, eq(inventoryLotBalances.lotId, inventoryLots.id))
    .where(and(...conditions))
    .orderBy(sql`${inventoryLots.expiresAt} ASC NULLS LAST`, asc(inventoryLots.lotCode));

  if (candidates.length === 0) {
    throw new CustomerOrderError(
      "INSUFFICIENT_STOCK",
      `No eligible AVAILABLE, non-expired lot of item ${itemLabel} exists at the order outlet's OUTLET_STORAGE/KITCHEN.`,
      409,
      { itemId, warehouseIds },
    );
  }

  const sortedKeys = [...new Set(candidates.map((c) => `${c.warehouseId}:${c.lotId}`))].sort();
  const onHandByKey = new Map<string, string>();
  for (const key of sortedKeys) {
    const [warehouseId, lotId] = key.split(":") as [string, string];
    const [balance] = await tx
      .select({ onHand: inventoryLotBalances.onHand })
      .from(inventoryLotBalances)
      .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)))
      .for("update");
    onHandByKey.set(key, balance?.onHand ?? "0");
  }

  const candidateLotIds = [...new Set(candidates.map((c) => c.lotId))];
  const activeAllocations = await tx
    .select({
      lotId: customerOrderAllocations.lotId,
      warehouseId: customerOrderAllocations.warehouseId,
      quantity: customerOrderAllocations.quantity,
    })
    .from(customerOrderAllocations)
    .where(and(inArray(customerOrderAllocations.lotId, candidateLotIds), eq(customerOrderAllocations.status, "ACTIVE")))
    .for("update");

  const reservedByKey = new Map<string, bigint>();
  for (const row of activeAllocations) {
    const key = `${row.warehouseId}:${row.lotId}`;
    reservedByKey.set(key, (reservedByKey.get(key) ?? 0n) + parseFixed(row.quantity, 6));
  }

  const portions: FefoAllocationPortion[] = [];
  let remaining = neededBase;
  for (const candidate of candidates) {
    if (remaining <= 0n) break;
    const key = `${candidate.warehouseId}:${candidate.lotId}`;
    const onHand = parseFixed(onHandByKey.get(key) ?? "0", 6);
    const reserved = reservedByKey.get(key) ?? 0n;
    const available = onHand - reserved;
    if (available <= 0n) continue;
    const take = available < remaining ? available : remaining;
    portions.push({ lotId: candidate.lotId, warehouseId: candidate.warehouseId, qtyBase: take });
    remaining -= take;
  }

  if (remaining > 0n) {
    throw new CustomerOrderError(
      "INSUFFICIENT_STOCK",
      `Insufficient available (on-hand minus other ACTIVE reservations) stock for item ${itemLabel} (short by ${formatFixed(remaining, 6)}).`,
      409,
      { itemId, shortBy: formatFixed(remaining, 6) },
    );
  }
  return portions;
}

/** Releases every ACTIVE allocation belonging to the given line ids to RELEASED (cancel()'s stock-effect-free undo). */
export async function releaseActiveAllocationsForLines(tx: Tx, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  await tx
    .update(customerOrderAllocations)
    .set({ status: "RELEASED", updatedAt: new Date() })
    .where(and(inArray(customerOrderAllocations.lineId, lineIds), eq(customerOrderAllocations.status, "ACTIVE")));
}
