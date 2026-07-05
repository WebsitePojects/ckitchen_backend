/**
 * Orders Service — CK1-API-003 §7 + CK1-ARC-002 §5.1
 *
 * Cardinal Business Rules:
 *   #2  Deduct at PREPARING; cancel-after → compensating restock.
 *   #3  Shared ingredient, per-recipe portion_qty (one pool, brand-specific deduction).
 *   #5  Idempotent ingestion, listing-scoped on (aggregator_account_id, external_ref):
 *       a replay on the SAME channel listing is a no-op; the same external_ref via a
 *       DIFFERENT listing (e.g. a different outlet's Foodpanda account) is distinct.
 *
 * All multi-step writes run inside db.transaction() for atomicity.
 *
 * Design note: low-stock events are RETURNED from advanceOrder so the caller
 * (route handler / Task 8 realtime layer) can emit `lowstock.alert` over Socket.IO.
 * The service itself does NOT emit — separation of concerns for Task 8.
 *
 * Correctness fixes (Opus review):
 *   FIX A — conditional update (WHERE status=expected) prevents concurrent double-deduction
 *   FIX B — consumption_log with order_id tracks what was actually deducted; cancel uses
 *            the ledger (not current recipe) and deletes rows to prevent double-restock
 *   FIX C — unique constraint violation on (aggregator_account_id,external_ref) is
 *            caught and returned as DUPLICATE_ORDER instead of a 500
 *   FIX D — missing KITCHEN inventory_stock row is created at qty=0 before deducting,
 *            allowing the balance to go visibly negative (prototype allows oversell;
 *            production should decide INSUFFICIENT_STOCK block vs allow+flag)
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  aggregatorAccounts,
  brands,
  consumptionLogs,
  ingredients,
  inventoryStock,
  kitchenStations,
  menuItems,
  orderItems,
  orders,
  printJobs,
  recipeLines,
  warehouses,
} from "../../db/schema.js";
import { postLedger } from "../inventory/ledger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestOrderInput {
  brand_id: string;
  aggregator: "FOODPANDA" | "GRABFOOD" | "OTHER";
  external_ref: string;
  customer_name?: string;
  placed_at?: string;
  items: Array<{
    menu_item_id: string;
    qty: number;
    notes?: string;
  }>;
}

export interface PrintJobSummary {
  id: string;
  station: string;
  printer: string | null;
}

export interface IngestResult {
  order_id: string;
  status: string;
  print_jobs: PrintJobSummary[];
  /** Present only on DUPLICATE_ORDER responses. */
  code?: "DUPLICATE_ORDER";
}

export interface LowStockEvent {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  threshold: number;
}

/**
 * Represents a single ingredient balance change in the KITCHEN warehouse after
 * deduction.  Returned from advanceOrder so the route handler (Task 8) can emit
 * `stock.updated` without an extra DB round-trip.
 */
export interface StockUpdateEvent {
  ingredientId: string;
  ingredientName: string;
  /** Always "KITCHEN" for deduction-triggered events. */
  warehouseType: "KITCHEN" | "MAIN";
  /** New balance after the deduction (may be negative — prototype allows oversell). */
  quantity: number;
}

export interface AdvanceResult {
  order_id: string;
  status: string;
  /** prepAt / readyAt / completedAt as ISO strings (nullable). */
  prepAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  /** Low-stock events emitted by this stage transition (emit via Task 8 realtime). */
  lowStockEvents: LowStockEvent[];
  /** All stock changes from this transition (emit `stock.updated` for each). */
  stockUpdates: StockUpdateEvent[];
}

// ---------------------------------------------------------------------------
// Custom error classes (caught in route handler and mapped to HTTP responses)
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
    this.name = "ValidationError";
  }
}

/** FIX A — thrown when a concurrent advance wins the conditional update race. */
export class ConflictError extends ServiceError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

// ---------------------------------------------------------------------------
// Stage progression
// ---------------------------------------------------------------------------

const STAGE_ORDER = ["NEW", "PREPARING", "READY", "COMPLETED"] as const;
type OrderStatus = typeof orders.$inferSelect["status"];

function nextStage(current: OrderStatus): OrderStatus {
  const idx = STAGE_ORDER.indexOf(current as typeof STAGE_ORDER[number]);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) {
    throw new ValidationError(
      `Order is ${current} and cannot be advanced further.`,
    );
  }
  return STAGE_ORDER[idx + 1] as OrderStatus;
}

// ---------------------------------------------------------------------------
// Helper: detect PostgreSQL unique-violation from pglite/drizzle errors
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // PGlite surfaces PG error code on the error object
    if (e["code"] === "23505") return true;
    // Some wrappers nest it under cause
    if (e["cause"] && typeof e["cause"] === "object") {
      const cause = e["cause"] as Record<string, unknown>;
      if (cause["code"] === "23505") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ingestOrder — POST /ingest/order
// ---------------------------------------------------------------------------

export async function ingestOrder(db: DB, input: IngestOrderInput): Promise<IngestResult> {
  // ── VALIDATE BRAND ───────────────────────────────────────────────────────
  const [brand] = await db.select().from(brands).where(eq(brands.id, input.brand_id));
  if (!brand) throw new NotFoundError(`Brand ${input.brand_id} not found.`);

  // ── RESOLVE AGGREGATOR ACCOUNT (the channel listing) ─────────────────────
  // Must happen BEFORE the idempotency check: idempotency is scoped to the
  // listing (aggregator_account_id), not the raw aggregator enum, so the
  // account has to be resolved first (Rule #5, listing-scoped variant).
  const [account] = await db
    .select()
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.brandId, input.brand_id),
        eq(aggregatorAccounts.aggregator, input.aggregator),
      ),
    );
  if (!account) {
    throw new NotFoundError(
      `No aggregator account found for brand ${input.brand_id} + ${input.aggregator}.`,
    );
  }

  // ── IDEMPOTENCY CHECK (Rule #5 — listing-scoped) ─────────────────────────
  // Scoped to (aggregator_account_id, external_ref): a replay of the same
  // external_ref on the SAME channel listing is an idempotent no-op. The same
  // external_ref arriving via a DIFFERENT listing (different
  // aggregator_account_id — e.g. a different outlet's Foodpanda listing) is a
  // distinct order, matching the new order_listing_external_ref_unique index.
  const [existing] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.aggregatorAccountId, account.id),
        eq(orders.externalRef, input.external_ref),
      ),
    );

  if (existing) {
    return buildDuplicateResponse(db, existing);
  }

  // ── VALIDATE ITEMS, RESOLVE STATIONS ────────────────────────────────────
  if (!input.items || input.items.length === 0) {
    throw new ValidationError("Order must have at least one item.");
  }

  type ResolvedItem = {
    menuItemId: string;
    stationId: string;
    stationName: string;
    qty: number;
    notes?: string;
    price: string;
    name: string;
  };

  const resolvedItems: ResolvedItem[] = [];

  for (const item of input.items) {
    const rows = await db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        price: menuItems.price,
        stationId: menuItems.stationId,
        stationName: kitchenStations.name,
      })
      .from(menuItems)
      .leftJoin(kitchenStations, eq(menuItems.stationId, kitchenStations.id))
      .where(eq(menuItems.id, item.menu_item_id));

    const menuItem = rows[0];
    if (!menuItem) throw new NotFoundError(`Menu item ${item.menu_item_id} not found.`);
    if (!menuItem.stationId) {
      throw new ValidationError(`Menu item "${menuItem.name}" has no station assigned.`);
    }

    resolvedItems.push({
      menuItemId: menuItem.id,
      stationId: menuItem.stationId,
      stationName: menuItem.stationName ?? menuItem.stationId,
      qty: item.qty,
      notes: item.notes,
      price: menuItem.price,
      name: menuItem.name,
    });
  }

  // ── COMPUTE TOTAL ────────────────────────────────────────────────────────
  const total = resolvedItems
    .reduce((sum, item) => sum + Number(item.price) * item.qty, 0)
    .toFixed(2);

  // ── GROUP ITEMS BY STATION ───────────────────────────────────────────────
  const stationGroupMap = new Map<string, { stationName: string; items: ResolvedItem[] }>();
  for (const item of resolvedItems) {
    const g = stationGroupMap.get(item.stationId) ?? {
      stationName: item.stationName,
      items: [],
    };
    g.items.push(item);
    stationGroupMap.set(item.stationId, g);
  }

  const placedAt = input.placed_at ? new Date(input.placed_at) : new Date();

  // ── TRANSACTION: order + order_items + print_jobs ────────────────────────
  let createdOrderId = "";
  let createdOrderStatus = "NEW";
  const createdPrintJobs: PrintJobSummary[] = [];

  try {
    await db.transaction(async (tx) => {
      // Create the order
      const [createdOrder] = await tx
        .insert(orders)
        .values({
          brandId: input.brand_id,
          aggregatorAccountId: account.id,
          aggregator: input.aggregator,
          externalRef: input.external_ref,
          customerName: input.customer_name,
          status: "NEW",
          total,
          placedAt,
        })
        .returning();

      createdOrderId = createdOrder.id;
      createdOrderStatus = createdOrder.status;

      // Create order items
      await tx.insert(orderItems).values(
        resolvedItems.map((item) => ({
          orderId: createdOrder.id,
          menuItemId: item.menuItemId,
          qty: item.qty,
          stationId: item.stationId,
          notes: item.notes ?? null,
        })),
      );

      // Create ONE print job per distinct station
      for (const [stationId, group] of stationGroupMap.entries()) {
        // Fetch station default printer
        const [station] = await tx
          .select()
          .from(kitchenStations)
          .where(eq(kitchenStations.id, stationId));

        const kotPayload = {
          type: "KOT",
          brand: brand.name,
          aggregator: input.aggregator,
          order_ref: input.external_ref,
          station: group.stationName,
          placed_at: placedAt.toISOString(),
          customer: input.customer_name ?? null,
          items: group.items.map((i) => ({
            qty: i.qty,
            name: i.name,
            notes: i.notes ?? null,
          })),
          footer: "CloudKitchen ONE",
        };

        const [printJob] = await tx
          .insert(printJobs)
          .values({
            orderId: createdOrder.id,
            stationId,
            printerId: station?.defaultPrinterId ?? null,
            payload: kotPayload,
            status: "PENDING",
          })
          .returning();

        createdPrintJobs.push({
          id: printJob.id,
          station: group.stationName,
          printer: printJob.printerId,
        });
      }
    });
  } catch (err) {
    // FIX C — graceful handling of concurrent duplicate ingests.
    // If two requests with the same (aggregator_account_id, external_ref) race
    // past the pre-check above, one INSERT wins and the other hits a UNIQUE
    // violation (PG code 23505) on order_listing_external_ref_unique. Return
    // the existing order instead of a 500. Scoped to the listing (account.id),
    // matching the idempotency check above.
    if (isUniqueViolation(err)) {
      const [raceExisting] = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.aggregatorAccountId, account.id),
            eq(orders.externalRef, input.external_ref),
          ),
        );
      if (raceExisting) {
        return buildDuplicateResponse(db, raceExisting);
      }
    }
    throw err;
  }

  return {
    order_id: createdOrderId,
    status: createdOrderStatus,
    print_jobs: createdPrintJobs,
  };
}

// Helper shared by idempotency check and race-condition catch
async function buildDuplicateResponse(
  db: DB,
  existing: typeof orders.$inferSelect,
): Promise<IngestResult> {
  const existingJobs = await db
    .select({
      id: printJobs.id,
      stationId: printJobs.stationId,
      printerId: printJobs.printerId,
    })
    .from(printJobs)
    .where(eq(printJobs.orderId, existing.id));

  const stationIds = [...new Set(existingJobs.map((j) => j.stationId))];
  const stationRows =
    stationIds.length > 0
      ? await db
          .select({ id: kitchenStations.id, name: kitchenStations.name })
          .from(kitchenStations)
          .where(inArray(kitchenStations.id, stationIds))
      : [];
  const stationNameById = new Map(stationRows.map((s) => [s.id, s.name]));

  return {
    order_id: existing.id,
    status: existing.status,
    print_jobs: existingJobs.map((j) => ({
      id: j.id,
      station: stationNameById.get(j.stationId) ?? j.stationId,
      printer: j.printerId,
    })),
    code: "DUPLICATE_ORDER",
  };
}

// ---------------------------------------------------------------------------
// advanceOrder — POST /orders/:id/advance
// On NEW→PREPARING: runs the deduction engine in the same transaction.
// ---------------------------------------------------------------------------

export async function advanceOrder(
  db: DB,
  orderId: string,
  userId?: string,
): Promise<AdvanceResult> {
  // Load the order
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("Order not found.");

  if (order.status === "CANCELLED") {
    throw new ValidationError("A CANCELLED order cannot be advanced.");
  }

  const next = nextStage(order.status); // throws ValidationError if COMPLETED
  const expectedCurrentStatus = order.status; // captured for the conditional update

  // Captured via closure from inside the transaction
  let updatedOrder!: typeof orders.$inferSelect;
  const lowStockEvents: LowStockEvent[] = [];
  // Map: ingredientId → latest StockUpdateEvent (last write wins for same ingredient)
  const stockUpdateMap = new Map<string, StockUpdateEvent>();

  await db.transaction(async (tx) => {
    // FIX A — Conditional update: only update if status hasn't changed since we read.
    // This is the double-deduction guard. If a concurrent advance already moved the
    // order to the next status, this update finds 0 rows and we abort immediately,
    // preventing duplicate stock deduction.
    const now = new Date();
    const updateSet: Partial<typeof orders.$inferInsert> = {
      status: next,
      updatedAt: now,
    };
    if (next === "PREPARING") updateSet.prepAt = now;
    if (next === "READY") updateSet.readyAt = now;
    if (next === "COMPLETED") updateSet.completedAt = now;

    const updatedRows = await tx
      .update(orders)
      .set(updateSet)
      .where(and(eq(orders.id, orderId), eq(orders.status, expectedCurrentStatus)))
      .returning();

    if (updatedRows.length === 0) {
      // Another concurrent request already advanced this order.
      // Abort the transaction without deducting stock.
      throw new ConflictError(
        "Order was modified concurrently. Another advance is already in progress.",
      );
    }

    updatedOrder = updatedRows[0];

    // ── DEDUCTION ENGINE (fires ONLY on NEW → PREPARING) ──────────────────
    // CK1-ARC-002 §5.1, Cardinal Rule #2
    // Deduction runs here ONLY because the conditional update above succeeded —
    // guaranteeing exactly-once deduction even under concurrent advance calls.
    if (next === "PREPARING") {
      // Locate THIS ORDER'S KITCHEN warehouse. Cardinal rule: an outlet owns its
      // own inventory — deduction must hit the KITCHEN warehouse of the order's
      // own outlet, never "the first KITCHEN warehouse" globally (which would let
      // an outlet-2 order deduct outlet-1 stock). The order's outlet is derived
      // from its brand's home location (D30 transition: orders still key on
      // brand.location_id; see 0015 migration header).
      const [orderBrand] = await tx
        .select({ locationId: brands.locationId })
        .from(brands)
        .where(eq(brands.id, order.brandId));
      if (!orderBrand) throw new Error("Order's brand not found.");

      const [kitchenWarehouse] = await tx
        .select()
        .from(warehouses)
        .where(
          and(
            eq(warehouses.type, "KITCHEN"),
            eq(warehouses.locationId, orderBrand.locationId),
          ),
        );

      if (!kitchenWarehouse) {
        throw new Error("KITCHEN warehouse not configured for this outlet.");
      }

      // Load all order items for this order
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      for (const item of items) {
        // Load recipe lines for this item's menu item
        const lines = await tx
          .select()
          .from(recipeLines)
          .where(eq(recipeLines.menuItemId, item.menuItemId));

        for (const line of lines) {
          // qty = portion_qty * order_item.qty  (Rule #3: brand-specific portion)
          const qtyToDeduct = Number(line.portionQty) * item.qty;

          // FIX D — Ensure the KITCHEN inventory_stock row exists before deducting.
          // If the row is absent (ingredient never received into KITCHEN), create it
          // at qty=0 and allow the balance to go negative. This makes "oversell"
          // visible rather than silently skipping the deduction.
          //
          // prototype allows oversell; production should decide
          // INSUFFICIENT_STOCK block vs allow+flag
          const [existingStock] = await tx
            .select()
            .from(inventoryStock)
            .where(
              and(
                eq(inventoryStock.warehouseId, kitchenWarehouse.id),
                eq(inventoryStock.ingredientId, line.ingredientId),
              ),
            );

          if (!existingStock) {
            await tx.insert(inventoryStock).values({
              warehouseId: kitchenWarehouse.id,
              ingredientId: line.ingredientId,
              quantity: "0",
            });
          }

          // Decrement the SHARED KITCHEN pool for this ingredient
          await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} - ${String(qtyToDeduct)}::numeric`,
            })
            .where(
              and(
                eq(inventoryStock.warehouseId, kitchenWarehouse.id),
                eq(inventoryStock.ingredientId, line.ingredientId),
              ),
            );

          // FIX B — Record what was actually deducted in the consumption ledger.
          // Tagged with orderId so cancelOrder can look up the exact amounts and
          // restock from this record (not from the current recipe, which may have
          // changed since the order was placed).
          await tx.insert(consumptionLogs).values({
            ingredientId: line.ingredientId,
            quantity: String(qtyToDeduct),
            loggedBy: userId ?? null,
            orderId,
          });

          // ERP R1: post ORDER_DEDUCTION OUT ledger row (same tx, atomic)
          await postLedger(tx, {
            sourceModule: "ORDER_DEDUCTION",
            sourceDocumentNo: orderId,
            sourceLineNo: line.ingredientId,
            ingredientId: line.ingredientId,
            warehouseId: kitchenWarehouse.id,
            movementType: "OUT",
            quantity: qtyToDeduct,
            encoderUserId: userId ?? null,
          });

          // Read back the new balance to check threshold
          const [stockRow] = await tx
            .select({
              quantity: inventoryStock.quantity,
            })
            .from(inventoryStock)
            .where(
              and(
                eq(inventoryStock.warehouseId, kitchenWarehouse.id),
                eq(inventoryStock.ingredientId, line.ingredientId),
              ),
            );

          if (stockRow) {
            const [ing] = await tx
              .select()
              .from(ingredients)
              .where(eq(ingredients.id, line.ingredientId));

            const newQty = Number(stockRow.quantity);
            const threshold = Number(ing?.lowStockThreshold ?? 0);
            const ingName = ing?.name ?? line.ingredientId;

            // Record stock update (Task 8: emit `stock.updated`).
            // The map upsert means if multiple recipe lines share the same ingredient
            // we report the final balance (last write wins).
            stockUpdateMap.set(line.ingredientId, {
              ingredientId: line.ingredientId,
              ingredientName: ingName,
              warehouseType: "KITCHEN",
              quantity: newQty,
            });

            // Emit low-stock event if qty is at/below threshold OR has gone negative.
            // FIX D — negative qty must never be silent (prototype oversell policy).
            if (newQty <= threshold || newQty < 0) {
              const alreadyAdded = lowStockEvents.some(
                (e) => e.ingredientId === line.ingredientId,
              );
              if (!alreadyAdded) {
                lowStockEvents.push({
                  ingredientId: line.ingredientId,
                  ingredientName: ingName,
                  quantity: newQty,
                  threshold,
                });
              }
            }
          }
        }
      }
    }
    // ── END DEDUCTION ENGINE ───────────────────────────────────────────────
  });

  return {
    order_id: updatedOrder.id,
    status: updatedOrder.status,
    prepAt: updatedOrder.prepAt?.toISOString() ?? null,
    readyAt: updatedOrder.readyAt?.toISOString() ?? null,
    completedAt: updatedOrder.completedAt?.toISOString() ?? null,
    lowStockEvents,
    stockUpdates: [...stockUpdateMap.values()],
  };
}

// ---------------------------------------------------------------------------
// cancelOrder — POST /orders/:id/cancel
// If at/after PREPARING: compensating restock (Rule #2).
// ---------------------------------------------------------------------------

export async function cancelOrder(
  db: DB,
  orderId: string,
  reason: string,
): Promise<{ status: string }> {
  // MOTM 2026-07-01: a cancellation must record WHY.
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length === 0) {
    throw new ValidationError("A cancellation reason is required.");
  }
  if (trimmedReason.length > 500) {
    throw new ValidationError("Cancellation reason must be 500 characters or fewer.");
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("Order not found.");

  if (order.status === "CANCELLED") {
    throw new ValidationError("Order is already CANCELLED.");
  }
  if (order.status === "COMPLETED") {
    throw new ValidationError("A COMPLETED order cannot be cancelled.");
  }

  // Did deduction already happen? It fires on NEW → PREPARING, so any status
  // at or after PREPARING means the stock was deducted.
  const STAGES_AFTER_PREPARING = new Set<string>(["PREPARING", "READY"]);
  const needsRestock = STAGES_AFTER_PREPARING.has(order.status);

  await db.transaction(async (tx) => {
    if (needsRestock) {
      // ── COMPENSATING RESTOCK ───────────────────────────────────────────
      // FIX B — Restock using the RECORDED consumption ledger for this order,
      // NOT by re-deriving from the current recipe_lines. This is correct even
      // if the recipe was changed after the order was placed.
      //
      // We also DELETE the log rows so a double-cancel cannot double-restock.
      const logRows = await tx
        .select()
        .from(consumptionLogs)
        .where(eq(consumptionLogs.orderId, orderId));

      if (logRows.length > 0) {
        // Symmetric to advanceOrder: restock THIS ORDER'S outlet KITCHEN only,
        // derived from the brand's home location. Restocking "the first KITCHEN
        // warehouse" would credit outlet-1 for stock deducted from outlet-2.
        const [orderBrand] = await tx
          .select({ locationId: brands.locationId })
          .from(brands)
          .where(eq(brands.id, order.brandId));
        if (!orderBrand) throw new Error("Order's brand not found.");

        const [kitchenWarehouse] = await tx
          .select()
          .from(warehouses)
          .where(
            and(
              eq(warehouses.type, "KITCHEN"),
              eq(warehouses.locationId, orderBrand.locationId),
            ),
          );

        if (!kitchenWarehouse) {
          throw new Error("KITCHEN warehouse not configured for this outlet.");
        }

        // Aggregate per ingredient (a single ingredient may appear in multiple log rows
        // if the order had multiple line items using the same ingredient)
        const restockByIngredient = new Map<string, number>();
        for (const row of logRows) {
          const prev = restockByIngredient.get(row.ingredientId) ?? 0;
          restockByIngredient.set(row.ingredientId, prev + Number(row.quantity));
        }

        for (const [ingredientId, qtyToRestore] of restockByIngredient.entries()) {
          await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} + ${String(qtyToRestore)}::numeric`,
            })
            .where(
              and(
                eq(inventoryStock.warehouseId, kitchenWarehouse.id),
                eq(inventoryStock.ingredientId, ingredientId),
              ),
            );

          // ERP R1: post RESTOCK IN ledger row (compensating entry, same tx)
          await postLedger(tx, {
            sourceModule: "RESTOCK",
            sourceDocumentNo: orderId,
            sourceLineNo: ingredientId,
            ingredientId,
            warehouseId: kitchenWarehouse.id,
            movementType: "IN",
            quantity: qtyToRestore,
          });
        }

        // Delete the consumption log rows for this order AFTER restocking.
        // This is the double-cancel guard: if cancelOrder is called again,
        // logRows will be empty and no restock will happen.
        await tx
          .delete(consumptionLogs)
          .where(eq(consumptionLogs.orderId, orderId));
      }
    }

    // Mark the order CANCELLED with the recorded reason
    await tx
      .update(orders)
      .set({ status: "CANCELLED", cancelReason: trimmedReason, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  });

  return { status: "CANCELLED" };
}

// ---------------------------------------------------------------------------
// listOrders — GET /orders
// Filters: brand_id, aggregator, station_id, status, from, to
// ---------------------------------------------------------------------------

export async function listOrders(
  db: DB,
  filters: {
    brand_id?: string;
    aggregator?: string;
    station_id?: string;
    status?: string | string[];
    from?: string;
    to?: string;
  },
): Promise<(typeof orders.$inferSelect)[]> {
  // Build WHERE conditions on the orders table
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.brand_id) conditions.push(eq(orders.brandId, filters.brand_id));
  if (filters.aggregator) {
    conditions.push(
      eq(orders.aggregator, filters.aggregator as typeof orders.$inferSelect["aggregator"]),
    );
  }
  if (filters.status) {
    const statuses = (Array.isArray(filters.status)
      ? filters.status
      : [filters.status]) as (typeof orders.$inferSelect)["status"][];
    if (statuses.length === 1) {
      conditions.push(eq(orders.status, statuses[0]));
    } else if (statuses.length > 1) {
      conditions.push(inArray(orders.status, statuses));
    }
  }
  if (filters.from) conditions.push(gte(orders.placedAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(orders.placedAt, new Date(filters.to)));

  // station_id filter: use a subquery to find orders with items at that station
  if (filters.station_id) {
    const orderIdsAtStation = await db
      .selectDistinct({ orderId: orderItems.orderId })
      .from(orderItems)
      .where(eq(orderItems.stationId, filters.station_id));

    const ids = orderIdsAtStation.map((r) => r.orderId);
    if (ids.length === 0) return [];

    conditions.push(inArray(orders.id, ids));
  }

  const rows =
    conditions.length > 0
      ? await db
          .select()
          .from(orders)
          .where(and(...(conditions as Parameters<typeof and>)))
      : await db.select().from(orders);

  return rows;
}

// ---------------------------------------------------------------------------
// getOrderDetail — GET /orders/:id
// Returns order + its items + its print jobs
// ---------------------------------------------------------------------------

export async function getOrderDetail(
  db: DB,
  orderId: string,
): Promise<{
  order: typeof orders.$inferSelect;
  items: (typeof orderItems.$inferSelect)[];
  print_jobs: (typeof printJobs.$inferSelect)[];
} | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const jobs = await db
    .select()
    .from(printJobs)
    .where(eq(printJobs.orderId, orderId));

  return { order, items, print_jobs: jobs };
}
