/**
 * Analytics Service — CK1-API-003 §9 + CK1-ARC-002 §5.2
 *
 * Four read-only aggregations:
 *   getBrandsAnalytics    — per-brand revenue/orders/avg ranked top→weak; weakest flagged
 *   getOrdersByHour       — hourly order counts for a single date (peak-load view)
 *   getAggregatorsAnalytics — revenue+count split by FOODPANDA / GRABFOOD / OTHER
 *   getMarginsAnalytics   — per-brand margin using recipe costing (§5.2):
 *                           recipe_cost = Σ(portion_qty × unit_cost)
 *                           margin = price − recipe_cost, aggregated weighted by sales qty
 *
 * All functions accept optional from/to date-range strings (ISO-8601 UTC).
 * Default range 2000-01-01 → 2099-12-31 covers all-time when no filter is supplied.
 *
 * Raw SQL (db.execute + sql template) is used for the aggregation queries because
 * they require LEFT JOIN ON date-range conditions (to preserve brands with no orders
 * in range), groupBy expressions, and a CTE for the margins recipe-cost sub-query.
 * All parameter values are passed as drizzle sql bindings (no string interpolation).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrandAnalytics {
  brand_id: string;
  name: string;
  revenue: number;
  order_count: number;
  avg_order_value: number;
  is_weakest: boolean;
}

export interface HourlyOrderCount {
  hour: number;
  order_count: number;
}

export interface AggregatorAnalytics {
  aggregator: string;
  order_count: number;
  revenue: number;
}

export interface BrandMargin {
  brand_id: string;
  name: string;
  revenue: number;
  recipe_cost_total: number;
  margin: number;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Casts the raw PGlite execute result to a typed row array.
 * PGlite returns `{ rows: {[col]: value}[], fields: Field[] }`.
 * drizzle-orm wraps this but the rows property always contains plain objects.
 */
function toRows<T>(raw: unknown): T[] {
  // postgres-js (Supabase) returns the row array directly; PGlite returns { rows: [...] }.
  if (Array.isArray(raw)) return raw as T[];
  const r = raw as { rows?: T[] };
  return r.rows ?? [];
}

/**
 * Default wide date range used when caller does not supply from/to.
 * Covers all orders that could exist in the prototype lifetime.
 */
const DEFAULT_FROM = new Date("2000-01-01T00:00:00.000Z");
const DEFAULT_TO = new Date("2099-12-31T23:59:59.999Z");

// ---------------------------------------------------------------------------
// getBrandsAnalytics — GET /analytics/brands?from&to
// ---------------------------------------------------------------------------

/**
 * Per-brand revenue, order count, avg order value for the date range,
 * ranked top→weak by revenue.  The last entry is flagged `is_weakest=true`.
 *
 * Uses LEFT JOIN ON date-range condition so brands with zero orders in range
 * still appear with revenue=0 and order_count=0.
 */
export async function getBrandsAnalytics(
  db: DB,
  from?: string,
  to?: string,
): Promise<BrandAnalytics[]> {
  const fromDate = from ? new Date(from) : DEFAULT_FROM;
  const toDate = to ? new Date(to) : DEFAULT_TO;

  // LEFT JOIN keeps all brands; date range is applied in ON clause (not WHERE)
  // so brands with no orders within the window still appear with 0 aggregates.
  const raw = await db.execute(sql`
    SELECT
      b.id       AS brand_id,
      b.name,
      COALESCE(SUM(o.total::numeric), 0)         AS revenue,
      COUNT(o.id)                                AS order_count,
      COALESCE(AVG(o.total::numeric), 0)         AS avg_order_value
    FROM brand b
    LEFT JOIN "order" o
           ON o.brand_id   = b.id
          AND o.placed_at >= ${fromDate.toISOString()}
          AND o.placed_at <= ${toDate.toISOString()}
    GROUP BY b.id, b.name
    ORDER BY COALESCE(SUM(o.total::numeric), 0) DESC NULLS LAST
  `);

  type BrandRow = {
    brand_id: string;
    name: string;
    revenue: string | number;
    order_count: string | number;
    avg_order_value: string | number;
  };

  const rows = toRows<BrandRow>(raw);
  const total = rows.length;

  return rows.map((row, idx) => ({
    brand_id: row.brand_id,
    name: row.name,
    revenue: Number(row.revenue),
    order_count: Number(row.order_count),
    avg_order_value: Number(row.avg_order_value),
    // The last entry (lowest revenue) is the weakest; guard total > 0
    is_weakest: total > 0 && idx === total - 1,
  }));
}

// ---------------------------------------------------------------------------
// getOrdersByHour — GET /analytics/orders-by-hour?date
// ---------------------------------------------------------------------------

/**
 * Returns only hours that had at least one order on the given UTC date.
 * Sparse array — hours with no orders are omitted (peak-load view).
 */
export async function getOrdersByHour(db: DB, date: string): Promise<HourlyOrderCount[]> {
  const startOfDay = new Date(date + "T00:00:00.000Z");
  const endOfDay = new Date(date + "T23:59:59.999Z");

  // EXTRACT on TIMESTAMPTZ in PostgreSQL/PGlite is relative to the session timezone.
  // PGlite defaults to UTC, and we store all timestamps as UTC, so this is correct.
  // The explicit AT TIME ZONE 'UTC' ensures correctness even if session TZ differs.
  const raw = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM placed_at AT TIME ZONE 'UTC')::integer AS hour,
      COUNT(id)::integer                                        AS order_count
    FROM "order"
    WHERE placed_at >= ${startOfDay.toISOString()}
      AND placed_at <= ${endOfDay.toISOString()}
    GROUP BY EXTRACT(HOUR FROM placed_at AT TIME ZONE 'UTC')
    ORDER BY hour
  `);

  type HourRow = { hour: string | number; order_count: string | number };
  return toRows<HourRow>(raw).map((row) => ({
    hour: Number(row.hour),
    order_count: Number(row.order_count),
  }));
}

// ---------------------------------------------------------------------------
// getAggregatorsAnalytics — GET /analytics/aggregators?from&to
// ---------------------------------------------------------------------------

/**
 * Revenue and order-count split by FOODPANDA / GRABFOOD / OTHER for the
 * date range.  Only aggregators that have at least one order in the range
 * are returned.
 */
export async function getAggregatorsAnalytics(
  db: DB,
  from?: string,
  to?: string,
): Promise<AggregatorAnalytics[]> {
  const fromDate = from ? new Date(from) : DEFAULT_FROM;
  const toDate = to ? new Date(to) : DEFAULT_TO;

  const raw = await db.execute(sql`
    SELECT
      aggregator,
      COUNT(id)::integer                 AS order_count,
      COALESCE(SUM(total::numeric), 0)   AS revenue
    FROM "order"
    WHERE placed_at >= ${fromDate.toISOString()}
      AND placed_at <= ${toDate.toISOString()}
    GROUP BY aggregator
    ORDER BY revenue DESC
  `);

  type AggRow = { aggregator: string; order_count: string | number; revenue: string | number };
  return toRows<AggRow>(raw).map((row) => ({
    aggregator: row.aggregator,
    order_count: Number(row.order_count),
    revenue: Number(row.revenue),
  }));
}

// ---------------------------------------------------------------------------
// getMarginsAnalytics — GET /analytics/margins?from&to
// ---------------------------------------------------------------------------

/**
 * Per-brand margin using recipe costing (CK1-ARC-002 §5.2):
 *
 *   recipe_cost(menu_item) = Σ over recipe_lines of (portion_qty × ingredient.unit_cost)
 *   margin(menu_item)      = price − recipe_cost
 *   brand revenue          = Σ(order_item.qty × menu_item.price)        for orders in range
 *   brand recipe_cost_total= Σ(order_item.qty × recipe_cost)            for orders in range
 *   brand margin           = brand revenue − brand recipe_cost_total
 *
 * Uses a two-CTE query:
 *   1. recipe_costs  — pre-computes recipe_cost per menu_item
 *   2. filtered_items— joins order_items with their parent orders filtered to the date range
 *
 * LEFT JOINs from brand → menu_item → filtered_items ensure all brands appear
 * even when they have no orders in the requested window (values default to 0).
 */
export async function getMarginsAnalytics(
  db: DB,
  from?: string,
  to?: string,
): Promise<BrandMargin[]> {
  const fromDate = from ? new Date(from) : DEFAULT_FROM;
  const toDate = to ? new Date(to) : DEFAULT_TO;

  const raw = await db.execute(sql`
    WITH recipe_costs AS (
      SELECT
        rl.menu_item_id,
        SUM(rl.portion_qty::numeric * i.unit_cost::numeric) AS recipe_cost
      FROM recipe_line rl
      JOIN ingredient i ON i.id = rl.ingredient_id
      GROUP BY rl.menu_item_id
    ),
    filtered_items AS (
      SELECT oi.menu_item_id, oi.qty
      FROM order_item oi
      JOIN "order" o ON o.id = oi.order_id
      WHERE o.placed_at >= ${fromDate.toISOString()}
        AND o.placed_at <= ${toDate.toISOString()}
    )
    SELECT
      b.id AS brand_id,
      b.name,
      COALESCE(SUM(fi.qty * mi.price::numeric),                   0) AS revenue,
      COALESCE(SUM(fi.qty * COALESCE(rc.recipe_cost, 0)),         0) AS recipe_cost_total,
      COALESCE(SUM(fi.qty * (mi.price::numeric - COALESCE(rc.recipe_cost, 0))), 0) AS margin
    FROM brand b
    LEFT JOIN menu_item mi ON mi.brand_id = b.id
    LEFT JOIN recipe_costs rc ON rc.menu_item_id = mi.id
    LEFT JOIN filtered_items fi ON fi.menu_item_id = mi.id
    GROUP BY b.id, b.name
  `);

  type MarginRow = {
    brand_id: string;
    name: string;
    revenue: string | number;
    recipe_cost_total: string | number;
    margin: string | number;
  };

  return toRows<MarginRow>(raw).map((row) => ({
    brand_id: row.brand_id,
    name: row.name,
    revenue: Number(row.revenue),
    recipe_cost_total: Number(row.recipe_cost_total),
    margin: Number(row.margin),
  }));
}
