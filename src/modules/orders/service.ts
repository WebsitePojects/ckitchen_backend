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
 * Design note: low-stock / stock-update events are RETURNED from the service so
 * the caller (route handler / realtime layer) can emit them over Socket.IO.
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
 *
 * S-wave fixes (2026-07-08):
 *   S3 — cancelOrder races: the CANCELLED update is now CONDITIONAL (WHERE
 *        status=expected, mirroring FIX A) and the restock decision is driven by
 *        whether consumption_log rows EXIST for the order (the ledger is the
 *        source of truth of what was actually deducted) — never by a status
 *        read taken before the transaction.
 *   S4 — stock reservation system (soft holds). Ingest inserts one
 *        stock_reservation row per recipe ingredient against the order's outlet
 *        KITCHEN warehouse. available = on-hand − SUM(active reservations).
 *        Shortfall policy: FOODPANDA/GRABFOOD orders are STILL created (the
 *        platform already took payment) but the result carries `stock_risk`;
 *        OTHER (walk-in/manual) throws InsufficientStockError → 409, unless
 *        `allow_oversell: true`. Rule #2 is UNCHANGED: real deduction still
 *        fires at NEW→PREPARING, which deletes this order's reservations in the
 *        same tx (the deduction replaces the hold). Cancel also deletes them.
 *   S5 — cancelOrder returns stockUpdates (new balances after compensating
 *        restock, same shape as advanceOrder) so the route can emit
 *        `stock.updated` per ingredient.
 *   S7 — N+1 kills: ingest batches menu-item/station resolution with inArray
 *        (and reads the station default printer off the same join); the
 *        deduction engine pre-fetches recipe lines / ingredients / stock rows
 *        in one query each, aggregates the deduction per ingredient, keeps the
 *        per-ingredient atomic UPDATE statements, and does one batched
 *        read-back. Event semantics preserved (last-write-wins per ingredient,
 *        deduped lowstock events).
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
  stockReservations,
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
  /**
   * S4 — OTHER (walk-in/manual) orders are rejected with INSUFFICIENT_STOCK
   * when required > available. Setting this true bypasses the block and
   * behaves like the aggregator path (order created + stock_risk returned).
   * Ignored for FOODPANDA/GRABFOOD (they never block).
   */
  allow_oversell?: boolean;
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

/** S4 — one per ingredient whose required qty exceeds available (on-hand − reserved). */
export interface StockShortfall {
  ingredient_id: string;
  ingredient_name: string;
  required: number;
  available: number;
}

export interface IngestResult {
  order_id: string;
  status: string;
  print_jobs: PrintJobSummary[];
  /** Present only on DUPLICATE_ORDER responses. */
  code?: "DUPLICATE_ORDER";
  /**
   * S4 — present ONLY when the order was created despite insufficient available
   * stock (aggregator order, or OTHER with allow_oversell). The route/simulator
   * emits `stock.risk` to the outlet room when this is set.
   */
  stock_risk?: StockShortfall[];
}

export interface LowStockEvent {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  threshold: number;
}

/**
 * Represents a single ingredient balance change in the KITCHEN warehouse after
 * deduction (advance) or compensating restock (cancel).  Returned so the route
 * handler can emit `stock.updated` without an extra DB round-trip.
 */
export interface StockUpdateEvent {
  ingredientId: string;
  ingredientName: string;
  /** Always "KITCHEN" for deduction/restock-triggered events. */
  warehouseType: "KITCHEN" | "MAIN";
  /** New balance after the change (may be negative — prototype allows oversell). */
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

export interface CancelResult {
  status: string;
  /** S5 — new balances after compensating restock (empty when nothing was deducted). */
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

/** FIX A — thrown when a concurrent advance/cancel wins the conditional update race. */
export class ConflictError extends ServiceError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

/**
 * S4 — thrown for OTHER (walk-in/manual) ingests whose required qty exceeds
 * available (on-hand − reserved) and allow_oversell was not set. The route maps
 * this to 409 INSUFFICIENT_STOCK with the shortfall details.
 */
export class InsufficientStockError extends ServiceError {
  constructor(public readonly shortfalls: StockShortfall[]) {
    super(
      "INSUFFICIENT_STOCK",
      "Insufficient available stock to accept this order.",
    );
    this.name = "InsufficientStockError";
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
  // S4 note: the duplicate path returns HERE, before any reservation planning —
  // an idempotent replay can never double-reserve.
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

  // ── VALIDATE ITEMS, RESOLVE STATIONS (S7 — one batched query) ───────────
  if (!input.items || input.items.length === 0) {
    throw new ValidationError("Order must have at least one item.");
  }

  type ResolvedItem = {
    menuItemId: string;
    stationId: string;
    stationName: string;
    /** Station default printer, read off the same join (S7: no per-station query). */
    stationDefaultPrinterId: string | null;
    qty: number;
    notes?: string;
    price: string;
    name: string;
  };

  const requestedMenuItemIds = [...new Set(input.items.map((i) => i.menu_item_id))];
  const menuRows = await db
    .select({
      id: menuItems.id,
      name: menuItems.name,
      price: menuItems.price,
      stationId: menuItems.stationId,
      stationName: kitchenStations.name,
      stationDefaultPrinterId: kitchenStations.defaultPrinterId,
    })
    .from(menuItems)
    .leftJoin(kitchenStations, eq(menuItems.stationId, kitchenStations.id))
    .where(inArray(menuItems.id, requestedMenuItemIds));
  const menuById = new Map(menuRows.map((r) => [r.id, r]));

  const resolvedItems: ResolvedItem[] = [];

  // Iterate the INPUT order so the first missing/invalid item throws exactly
  // like the old per-item loop did (same error, same message).
  for (const item of input.items) {
    const menuItem = menuById.get(item.menu_item_id);
    if (!menuItem) throw new NotFoundError(`Menu item ${item.menu_item_id} not found.`);
    if (!menuItem.stationId) {
      throw new ValidationError(`Menu item "${menuItem.name}" has no station assigned.`);
    }

    resolvedItems.push({
      menuItemId: menuItem.id,
      stationId: menuItem.stationId,
      stationName: menuItem.stationName ?? menuItem.stationId,
      stationDefaultPrinterId: menuItem.stationDefaultPrinterId,
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
  const stationGroupMap = new Map<
    string,
    { stationName: string; defaultPrinterId: string | null; items: ResolvedItem[] }
  >();
  for (const item of resolvedItems) {
    const g = stationGroupMap.get(item.stationId) ?? {
      stationName: item.stationName,
      defaultPrinterId: item.stationDefaultPrinterId,
      items: [],
    };
    g.items.push(item);
    stationGroupMap.set(item.stationId, g);
  }

  const placedAt = input.placed_at ? new Date(input.placed_at) : new Date();

  // ── S4: RESERVATION PLANNING (soft hold — Rule #2 deduction unchanged) ───
  // Compute required qty per ingredient from recipe_lines (portion_qty × item
  // qty, summed across items sharing an ingredient), then compare against
  // available = on-hand − SUM(active reservations) in the brand's outlet
  // KITCHEN warehouse. A brand whose menu items have NO recipe lines reserves
  // nothing (works exactly as today).
  const lines =
    requestedMenuItemIds.length > 0
      ? await db
          .select()
          .from(recipeLines)
          .where(inArray(recipeLines.menuItemId, requestedMenuItemIds))
      : [];

  const linesByMenuItem = new Map<string, typeof lines>();
  for (const line of lines) {
    const arr = linesByMenuItem.get(line.menuItemId);
    if (arr) arr.push(line);
    else linesByMenuItem.set(line.menuItemId, [line]);
  }

  const requiredByIngredient = new Map<string, number>();
  for (const item of resolvedItems) {
    for (const line of linesByMenuItem.get(item.menuItemId) ?? []) {
      requiredByIngredient.set(
        line.ingredientId,
        (requiredByIngredient.get(line.ingredientId) ?? 0) +
          Number(line.portionQty) * item.qty,
      );
    }
  }

  let reservationWarehouseId: string | null = null;
  const shortfalls: StockShortfall[] = [];

  if (requiredByIngredient.size > 0) {
    // Same lookup advanceOrder uses: the order's outlet KITCHEN warehouse via
    // the brand's home location (D30 transition — see 0015 migration header).
    const [kitchenWarehouse] = await db
      .select()
      .from(warehouses)
      .where(
        and(eq(warehouses.type, "KITCHEN"), eq(warehouses.locationId, brand.locationId)),
      );

    if (kitchenWarehouse) {
      reservationWarehouseId = kitchenWarehouse.id;
      const ingredientIds = [...requiredByIngredient.keys()];

      // On-hand quantities (missing stock row ⇒ 0 on hand).
      const stockRows = await db
        .select({
          ingredientId: inventoryStock.ingredientId,
          quantity: inventoryStock.quantity,
        })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.warehouseId, kitchenWarehouse.id),
            inArray(inventoryStock.ingredientId, ingredientIds),
          ),
        );
      const onHandById = new Map(stockRows.map((r) => [r.ingredientId, Number(r.quantity)]));

      // Active reservations, grouped (one aggregate query — S7 spirit).
      const reservedRows = await db
        .select({
          ingredientId: stockReservations.ingredientId,
          reserved: sql<string>`COALESCE(SUM(${stockReservations.quantity}), 0)`,
        })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.warehouseId, kitchenWarehouse.id),
            inArray(stockReservations.ingredientId, ingredientIds),
          ),
        )
        .groupBy(stockReservations.ingredientId);
      const reservedById = new Map(reservedRows.map((r) => [r.ingredientId, Number(r.reserved)]));

      const shortIngredientIds: string[] = [];
      for (const [ingredientId, required] of requiredByIngredient.entries()) {
        const available =
          (onHandById.get(ingredientId) ?? 0) - (reservedById.get(ingredientId) ?? 0);
        if (required > available) {
          shortIngredientIds.push(ingredientId);
          shortfalls.push({
            ingredient_id: ingredientId,
            ingredient_name: ingredientId, // resolved to the real name below
            required,
            available,
          });
        }
      }

      if (shortfalls.length > 0) {
        const nameRows = await db
          .select({ id: ingredients.id, name: ingredients.name })
          .from(ingredients)
          .where(inArray(ingredients.id, shortIngredientIds));
        const nameById = new Map(nameRows.map((r) => [r.id, r.name]));
        for (const s of shortfalls) {
          s.ingredient_name = nameById.get(s.ingredient_id) ?? s.ingredient_id;
        }

        // Policy: FOODPANDA/GRABFOOD orders are still created (the platform
        // already took the customer's payment) — the caller gets stock_risk and
        // emits `stock.risk`. OTHER (walk-in/manual) is blocked with 409
        // INSUFFICIENT_STOCK unless the caller explicitly allows overselling.
        if (input.aggregator === "OTHER" && input.allow_oversell !== true) {
          throw new InsufficientStockError(shortfalls);
        }
      }
    }
    // No KITCHEN warehouse configured for this outlet → reserve nothing
    // (matches today's behavior: the advance-time deduction will surface the
    // configuration problem; ingest never did).
  }

  // ── TRANSACTION: order + order_items + print_jobs + reservations ────────
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

      // Create ONE print job per distinct station (S7: printer id comes from
      // the batched menu/station join — no per-station query in the tx).
      for (const [stationId, group] of stationGroupMap.entries()) {
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
            printerId: group.defaultPrinterId,
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

      // S4 — insert the soft hold: one reservation row per ingredient. Only on
      // this genuinely-new-order path (duplicates returned earlier; a lost
      // unique-violation race rolls this back with the whole tx), so replays
      // can never double-reserve.
      if (reservationWarehouseId && requiredByIngredient.size > 0) {
        await tx.insert(stockReservations).values(
          [...requiredByIngredient.entries()].map(([ingredientId, quantity]) => ({
            orderId: createdOrder.id,
            ingredientId,
            warehouseId: reservationWarehouseId as string,
            quantity: String(quantity),
          })),
        );
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

  const result: IngestResult = {
    order_id: createdOrderId,
    status: createdOrderStatus,
    print_jobs: createdPrintJobs,
  };
  if (shortfalls.length > 0) {
    result.stock_risk = shortfalls;
  }
  return result;
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

      // S7 — batched deduction. Old shape: per order item → per recipe line →
      // 3 queries per line (stock select, ingredient select, read-back). New
      // shape: ONE query each for order items, recipe lines, ingredients, and
      // stock rows; the deduction is aggregated PER INGREDIENT (Rule #3 math is
      // identical: Σ portion_qty × item qty), then applied with the same atomic
      // per-ingredient `UPDATE ... SET quantity = quantity - X` statements, and
      // read back with one final inArray query.
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
      const lines =
        menuItemIds.length > 0
          ? await tx
              .select()
              .from(recipeLines)
              .where(inArray(recipeLines.menuItemId, menuItemIds))
          : [];

      const linesByMenuItem = new Map<string, typeof lines>();
      for (const line of lines) {
        const arr = linesByMenuItem.get(line.menuItemId);
        if (arr) arr.push(line);
        else linesByMenuItem.set(line.menuItemId, [line]);
      }

      // qty = Σ portion_qty * order_item.qty per ingredient (Rule #3)
      const deductByIngredient = new Map<string, number>();
      for (const item of items) {
        for (const line of linesByMenuItem.get(item.menuItemId) ?? []) {
          deductByIngredient.set(
            line.ingredientId,
            (deductByIngredient.get(line.ingredientId) ?? 0) +
              Number(line.portionQty) * item.qty,
          );
        }
      }

      const ingredientIds = [...deductByIngredient.keys()];
      if (ingredientIds.length > 0) {
        // Pre-fetch all relevant ingredients (names + thresholds) in one query.
        const ingredientRows = await tx
          .select()
          .from(ingredients)
          .where(inArray(ingredients.id, ingredientIds));
        const ingredientById = new Map(ingredientRows.map((i) => [i.id, i]));

        // FIX D — Ensure every KITCHEN inventory_stock row exists before
        // deducting. Missing rows (ingredient never received into KITCHEN) are
        // created at qty=0 in one batched insert so the balance can go visibly
        // negative rather than the deduction being silently skipped.
        const existingStockRows = await tx
          .select({ ingredientId: inventoryStock.ingredientId })
          .from(inventoryStock)
          .where(
            and(
              eq(inventoryStock.warehouseId, kitchenWarehouse.id),
              inArray(inventoryStock.ingredientId, ingredientIds),
            ),
          );
        const haveStockRow = new Set(existingStockRows.map((r) => r.ingredientId));
        const missingIds = ingredientIds.filter((id) => !haveStockRow.has(id));
        if (missingIds.length > 0) {
          await tx.insert(inventoryStock).values(
            missingIds.map((ingredientId) => ({
              warehouseId: kitchenWarehouse.id,
              ingredientId,
              quantity: "0",
            })),
          );
        }

        // Per-ingredient ATOMIC decrement of the shared KITCHEN pool.
        for (const [ingredientId, qtyToDeduct] of deductByIngredient.entries()) {
          await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} - ${String(qtyToDeduct)}::numeric`,
            })
            .where(
              and(
                eq(inventoryStock.warehouseId, kitchenWarehouse.id),
                eq(inventoryStock.ingredientId, ingredientId),
              ),
            );

          // ERP R1: post ORDER_DEDUCTION OUT ledger row (same tx, atomic).
          // Aggregated per ingredient — matches the ledger's idempotency key
          // (sourceModule, orderId, ingredientId), which only ever admitted one
          // row per ingredient anyway.
          await postLedger(tx, {
            sourceModule: "ORDER_DEDUCTION",
            sourceDocumentNo: orderId,
            sourceLineNo: ingredientId,
            ingredientId,
            warehouseId: kitchenWarehouse.id,
            movementType: "OUT",
            quantity: qtyToDeduct,
            encoderUserId: userId ?? null,
          });
        }

        // FIX B — Record what was actually deducted in the consumption ledger
        // (one batched insert, one row per ingredient with the aggregated qty).
        // Tagged with orderId + warehouseId so cancelOrder restocks the exact
        // amounts into the exact warehouse (L4c), regardless of later recipe
        // or brand-location changes.
        await tx.insert(consumptionLogs).values(
          [...deductByIngredient.entries()].map(([ingredientId, qty]) => ({
            ingredientId,
            quantity: String(qty),
            loggedBy: userId ?? null,
            orderId,
            warehouseId: kitchenWarehouse.id,
          })),
        );

        // One batched read-back of the new balances (S7).
        const readBack = await tx
          .select({
            ingredientId: inventoryStock.ingredientId,
            quantity: inventoryStock.quantity,
          })
          .from(inventoryStock)
          .where(
            and(
              eq(inventoryStock.warehouseId, kitchenWarehouse.id),
              inArray(inventoryStock.ingredientId, ingredientIds),
            ),
          );

        for (const stockRow of readBack) {
          const ing = ingredientById.get(stockRow.ingredientId);
          const newQty = Number(stockRow.quantity);
          const threshold = Number(ing?.lowStockThreshold ?? 0);
          const ingName = ing?.name ?? stockRow.ingredientId;

          // Record stock update (emit `stock.updated`). The map upsert keeps
          // the last-write-wins semantics for any duplicate ingredient.
          stockUpdateMap.set(stockRow.ingredientId, {
            ingredientId: stockRow.ingredientId,
            ingredientName: ingName,
            warehouseType: "KITCHEN",
            quantity: newQty,
          });

          // Emit low-stock event if qty is at/below threshold OR has gone negative.
          // FIX D — negative qty must never be silent (prototype oversell policy).
          if (newQty <= threshold || newQty < 0) {
            const alreadyAdded = lowStockEvents.some(
              (e) => e.ingredientId === stockRow.ingredientId,
            );
            if (!alreadyAdded) {
              lowStockEvents.push({
                ingredientId: stockRow.ingredientId,
                ingredientName: ingName,
                quantity: newQty,
                threshold,
              });
            }
          }
        }
      }

      // S4 — the real deduction replaces the soft hold: release this order's
      // reservations in the SAME transaction. (Also runs when the order had no
      // recipe lines — harmless no-op.)
      await tx.delete(stockReservations).where(eq(stockReservations.orderId, orderId));
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
// Compensating restock (Rule #2) driven by the consumption ledger.
// ---------------------------------------------------------------------------

export async function cancelOrder(
  db: DB,
  orderId: string,
  reason: string,
): Promise<CancelResult> {
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

  const expectedCurrentStatus = order.status;
  // Map: ingredientId → latest StockUpdateEvent (last write wins per ingredient)
  const stockUpdateMap = new Map<string, StockUpdateEvent>();

  await db.transaction(async (tx) => {
    // S3 (mirrors FIX A) — CONDITIONAL cancel: only flips to CANCELLED if the
    // status is still what we read. If a concurrent advance (or another cancel)
    // changed it in between, this finds 0 rows and we abort with 409 — closing
    // the race where the old code decided "needsRestock" from a stale pre-read
    // status and could leak stock (cancel-as-NEW racing an advance would skip
    // the restock for a deduction that DID happen).
    const updatedRows = await tx
      .update(orders)
      .set({ status: "CANCELLED", cancelReason: trimmedReason, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, expectedCurrentStatus)))
      .returning();

    if (updatedRows.length === 0) {
      throw new ConflictError(
        "Order was modified concurrently. Another status change is already in progress.",
      );
    }

    // S4 — release the reservation hold (frees availability for NEW-status
    // cancels; harmless no-op after PREPARING, where advance already deleted).
    await tx.delete(stockReservations).where(eq(stockReservations.orderId, orderId));

    // S3 — restock decision: the consumption ledger is the source of truth of
    // what was ACTUALLY deducted. Rows exist ⇔ the deduction ran ⇔ restock.
    // (Not the pre-read status: under the conditional update above the status
    // can no longer lie, but the ledger check also keeps the existing
    // delete-logs-after-restock double-cancel guard — an already-restocked
    // order has no rows left.)
    const logRows = await tx
      .select()
      .from(consumptionLogs)
      .where(eq(consumptionLogs.orderId, orderId));

    if (logRows.length > 0) {
      // ── COMPENSATING RESTOCK ───────────────────────────────────────────
      // FIX B — Restock using the RECORDED consumption ledger for this order,
      // NOT by re-deriving from the current recipe_lines. This is correct even
      // if the recipe was changed after the order was placed.
      //
      // L4c — restock the EXACT warehouse each deduction hit, read straight off
      // the consumption_log row (advanceOrder stamps warehouse_id). Legacy rows
      // written before L4c have a null warehouse_id; for those we fall back to
      // the order's own outlet KITCHEN warehouse.
      let fallbackKitchenWarehouseId: string | null = null;
      const resolveFallback = async (): Promise<string> => {
        if (fallbackKitchenWarehouseId) return fallbackKitchenWarehouseId;
        const [orderBrand] = await tx
          .select({ locationId: brands.locationId })
          .from(brands)
          .where(eq(brands.id, order.brandId));
        if (!orderBrand) throw new Error("Order's brand not found.");
        const [kitchenWarehouse] = await tx
          .select({ id: warehouses.id })
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
        fallbackKitchenWarehouseId = kitchenWarehouse.id;
        return kitchenWarehouse.id;
      };

      // Aggregate per (warehouse, ingredient) — a single ingredient may appear in
      // multiple log rows, and (defensively) across warehouses.
      const restockByWarehouseIngredient = new Map<string, number>();
      for (const row of logRows) {
        const warehouseId = row.warehouseId ?? (await resolveFallback());
        const key = `${warehouseId}|${row.ingredientId}`;
        restockByWarehouseIngredient.set(
          key,
          (restockByWarehouseIngredient.get(key) ?? 0) + Number(row.quantity),
        );
      }

      for (const [key, qtyToRestore] of restockByWarehouseIngredient.entries()) {
        const [warehouseId, ingredientId] = key.split("|");
        await tx
          .update(inventoryStock)
          .set({
            quantity: sql`${inventoryStock.quantity} + ${String(qtyToRestore)}::numeric`,
          })
          .where(
            and(
              eq(inventoryStock.warehouseId, warehouseId),
              eq(inventoryStock.ingredientId, ingredientId),
            ),
          );

        // ERP R1: post RESTOCK IN ledger row (compensating entry, same tx)
        await postLedger(tx, {
          sourceModule: "RESTOCK",
          sourceDocumentNo: orderId,
          sourceLineNo: ingredientId,
          ingredientId,
          warehouseId,
          movementType: "IN",
          quantity: qtyToRestore,
        });
      }

      // S5 — read back the new balances (batched per warehouse; in practice a
      // single KITCHEN warehouse) + ingredient names so the route can emit
      // `stock.updated` per ingredient, same shape as advanceOrder.
      const ingredientIdsByWarehouse = new Map<string, string[]>();
      for (const key of restockByWarehouseIngredient.keys()) {
        const [warehouseId, ingredientId] = key.split("|");
        const arr = ingredientIdsByWarehouse.get(warehouseId);
        if (arr) arr.push(ingredientId);
        else ingredientIdsByWarehouse.set(warehouseId, [ingredientId]);
      }

      const allIngredientIds = [...new Set(logRows.map((r) => r.ingredientId))];
      const nameRows = await tx
        .select({ id: ingredients.id, name: ingredients.name })
        .from(ingredients)
        .where(inArray(ingredients.id, allIngredientIds));
      const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

      for (const [warehouseId, ingIds] of ingredientIdsByWarehouse.entries()) {
        const readBack = await tx
          .select({
            ingredientId: inventoryStock.ingredientId,
            quantity: inventoryStock.quantity,
          })
          .from(inventoryStock)
          .where(
            and(
              eq(inventoryStock.warehouseId, warehouseId),
              inArray(inventoryStock.ingredientId, ingIds),
            ),
          );
        for (const row of readBack) {
          stockUpdateMap.set(row.ingredientId, {
            ingredientId: row.ingredientId,
            ingredientName: nameById.get(row.ingredientId) ?? row.ingredientId,
            warehouseType: "KITCHEN",
            quantity: Number(row.quantity),
          });
        }
      }

      // Delete the consumption log rows for this order AFTER restocking.
      // This is the double-cancel guard: if cancelOrder is called again,
      // logRows will be empty and no restock will happen.
      await tx
        .delete(consumptionLogs)
        .where(eq(consumptionLogs.orderId, orderId));
    }
  });

  return { status: "CANCELLED", stockUpdates: [...stockUpdateMap.values()] };
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
    /**
     * H2 tenancy: restrict to orders whose outlet (brand.location_id, W3b pattern)
     * is in this set. `undefined` = no location filter (ALL-scope, all outlets);
     * `[]` = caller has no outlets in scope → empty result.
     */
    location_ids?: string[];
  },
): Promise<(typeof orders.$inferSelect)[]> {
  // Build WHERE conditions on the orders table
  const conditions: ReturnType<typeof eq>[] = [];

  // H2 — outlet scoping. Derive the order's outlet via order→brand.location_id and
  // keep only orders at an in-scope outlet. Resolving brand ids first keeps the
  // return shape a flat orders[] (no join reshaping).
  if (filters.location_ids !== undefined) {
    if (filters.location_ids.length === 0) return [];
    const brandRows = await db
      .select({ id: brands.id })
      .from(brands)
      .where(inArray(brands.locationId, filters.location_ids));
    const brandIds = brandRows.map((b) => b.id);
    if (brandIds.length === 0) return [];
    conditions.push(inArray(orders.brandId, brandIds));
  }

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
// listOrdersWithDetail — GET /orders?detail=1
//
// Perf fix (N+1 KDS fetch): the frontend used to call GET /orders for a
// summary list, then GET /orders/:id ONCE PER ORDER to hydrate items +
// print_jobs for the kitchen display (see ckitchen_frontend
// src/hooks/useKitchenOrders.ts). That is dozens of extra round-trips on a
// busy board, each paying Supabase latency.
//
// Fix: reuse listOrders() for filtering/outlet-scoping (unchanged, one query
// plus whatever extra lookups the filters already need — station_id /
// location_ids), then fetch ALL items and ALL print_jobs for the resulting
// order set in exactly two bulk queries (`WHERE order_id IN (...)`), and
// assemble the per-order item/print_jobs arrays in memory. Total query count
// is O(1) in the number of orders returned — NOT one extra query per order.
// ---------------------------------------------------------------------------

export interface OrderWithDetail {
  order: typeof orders.$inferSelect;
  items: (typeof orderItems.$inferSelect)[];
  print_jobs: (typeof printJobs.$inferSelect)[];
}

export async function listOrdersWithDetail(
  db: DB,
  filters: Parameters<typeof listOrders>[1],
): Promise<OrderWithDetail[]> {
  const rows = await listOrders(db, filters);
  if (rows.length === 0) return [];

  const orderIds = rows.map((o) => o.id);

  // Bulk fetch #1: every order_item for every order in the result set.
  const items = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
  // Bulk fetch #2: every print_job for every order in the result set.
  const jobs = await db.select().from(printJobs).where(inArray(printJobs.orderId, orderIds));

  const itemsByOrder = new Map<string, (typeof orderItems.$inferSelect)[]>();
  for (const item of items) {
    const arr = itemsByOrder.get(item.orderId);
    if (arr) arr.push(item);
    else itemsByOrder.set(item.orderId, [item]);
  }

  const jobsByOrder = new Map<string, (typeof printJobs.$inferSelect)[]>();
  for (const job of jobs) {
    const arr = jobsByOrder.get(job.orderId);
    if (arr) arr.push(job);
    else jobsByOrder.set(job.orderId, [job]);
  }

  return rows.map((order) => ({
    order,
    items: itemsByOrder.get(order.id) ?? [],
    print_jobs: jobsByOrder.get(order.id) ?? [],
  }));
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
