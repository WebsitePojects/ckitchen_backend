/**
 * Analytics Service — CK1-API-003 §9 + CK1-ARC-002 §5.2
 *
 * Read-only aggregations:
 *   getBrandsAnalytics      — per-brand revenue/orders/avg ranked top→weak; weakest flagged
 *   getOrdersByHour         — hourly order counts for a single date (peak-load view)
 *   getOrdersByHourByBrand  — MOTM 2026-07-01 #9: same, broken down per-brand per-hour
 *   getAggregatorsAnalytics — revenue+count split by FOODPANDA / GRABFOOD / OTHER
 *   getMarginsAnalytics     — per-brand margin using recipe costing (§5.2):
 *                             recipe_cost = Σ(portion_qty × unit_cost)
 *                             margin = price − recipe_cost, aggregated weighted by sales qty
 *   getProductPerformance   — MOTM 2026-07-01 #8: per menu-item qty sold/revenue/orders
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

/**
 * One 24-hour bucket's per-brand order counts (MOTM 2026-07-01 #9).
 * `brands` is dense — every brand in the system appears in every hour bucket,
 * with count=0 where that brand had no orders that hour — so a stacked/grouped
 * bar chart can render all 24 x-axis ticks with a consistent, complete series
 * set (no per-hour key gaps to normalize on the frontend).
 */
export interface HourlyBrandBucket {
  hour: number;
  brands: Array<{
    brandId: string;
    brandName: string;
    count: number;
  }>;
}

/** Per menu-item sales performance over a date range (MOTM 2026-07-01 #8). */
export interface ProductPerformance {
  menuItemId: string;
  name: string;
  brandId: string;
  brandName: string;
  qtySold: number;
  revenue: number;
  orders: number;
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
// getOrdersByHourByBrand — GET /analytics/orders-by-hour-by-brand?date
// ---------------------------------------------------------------------------

/**
 * Same peak-load view as getOrdersByHour, broken down by brand (MOTM
 * 2026-07-01 #9: "the order by hour is good, but they want to see which
 * brand it is").
 *
 * Returns a DENSE 24-entry array (hour 0..23, always all 24 — unlike the
 * sparse getOrdersByHour) so the frontend can render a fixed set of x-axis
 * ticks. Within each hour bucket, `brands` lists EVERY brand in the system
 * (dense, LEFT JOIN — same "preserve zero rows" convention as
 * getBrandsAnalytics/getMarginsAnalytics) with count=0 where that brand had
 * no orders that hour, so a stacked/grouped bar chart has a stable series
 * key set across every bar.
 *
 * Status is NOT filtered (CANCELLED orders included) — this intentionally
 * mirrors getOrdersByHour's own behavior (which also does not filter status)
 * so the per-brand counts in this endpoint sum to the same per-hour totals
 * the existing /analytics/orders-by-hour endpoint already returns.
 */
export async function getOrdersByHourByBrand(db: DB, date: string): Promise<HourlyBrandBucket[]> {
  const startOfDay = new Date(date + "T00:00:00.000Z");
  const endOfDay = new Date(date + "T23:59:59.999Z");

  // generate_series(0,23) gives the dense hour axis; CROSS JOIN brand gives
  // the dense brand axis; LEFT JOIN "order" (matched on brand + exact hour +
  // date range) fills in real counts, defaulting to 0 via COALESCE/COUNT.
  const raw = await db.execute(sql`
    SELECT
      h.hour::integer                       AS hour,
      b.id                                   AS brand_id,
      b.name                                 AS brand_name,
      COUNT(o.id)::integer                   AS count
    FROM generate_series(0, 23) AS h(hour)
    CROSS JOIN brand b
    LEFT JOIN "order" o
           ON o.brand_id   = b.id
          AND o.placed_at >= ${startOfDay.toISOString()}
          AND o.placed_at <= ${endOfDay.toISOString()}
          AND EXTRACT(HOUR FROM o.placed_at AT TIME ZONE 'UTC')::integer = h.hour
    GROUP BY h.hour, b.id, b.name
    ORDER BY h.hour, b.name
  `);

  type BucketRow = {
    hour: string | number;
    brand_id: string;
    brand_name: string;
    count: string | number;
  };

  const rows = toRows<BucketRow>(raw);

  // Group flat hour x brand rows into 24 dense hour buckets.
  const buckets: HourlyBrandBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    brands: [],
  }));

  for (const row of rows) {
    const hour = Number(row.hour);
    buckets[hour].brands.push({
      brandId: row.brand_id,
      brandName: row.brand_name,
      count: Number(row.count),
    });
  }

  return buckets;
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

// ---------------------------------------------------------------------------
// getProductPerformance — GET /analytics/products?from&to
// ---------------------------------------------------------------------------

/**
 * Per menu-item (product) sales performance over a date range (MOTM
 * 2026-07-01 #8: "Brand and Product Performance" — brand side already
 * existed via getBrandsAnalytics; this is the product side).
 *
 *   qtySold = Σ(order_item.qty)                     for orders in range
 *   revenue = qtySold × menu_item.price              (price is per-item, so
 *                                                      this equals Σ(qty × price) per line)
 *   orders  = COUNT(DISTINCT order_id)  containing this menu item, in range
 *
 * Defaults to the same all-time DEFAULT_FROM/DEFAULT_TO window as the
 * sibling functions when from/to are omitted.
 *
 * CANCELLED orders are explicitly excluded (unlike getBrandsAnalytics /
 * getAggregatorsAnalytics / getMarginsAnalytics / getOrdersByHour, none of
 * which filter by status today) — a cancelled order never actually sold the
 * product, so counting it would overstate qtySold/revenue for a "what sold"
 * report. This is a deliberate, documented divergence from the sibling
 * convention, not an oversight; see analytics.test.ts for the assertion.
 *
 * Uses the same two-step CTE pattern as getMarginsAnalytics: filter
 * order_item -> order first (date range + status), THEN LEFT JOIN that
 * onto the full menu_item x brand set so items with zero sales in range
 * still appear with qtySold=0/revenue=0/orders=0.
 */
export async function getProductPerformance(
  db: DB,
  from?: string,
  to?: string,
): Promise<ProductPerformance[]> {
  const fromDate = from ? new Date(from) : DEFAULT_FROM;
  const toDate = to ? new Date(to) : DEFAULT_TO;

  const raw = await db.execute(sql`
    WITH filtered_items AS (
      SELECT oi.menu_item_id, oi.order_id, oi.qty
      FROM order_item oi
      JOIN "order" o ON o.id = oi.order_id
      WHERE o.placed_at >= ${fromDate.toISOString()}
        AND o.placed_at <= ${toDate.toISOString()}
        AND o.status != 'CANCELLED'
    )
    SELECT
      mi.id                                        AS menu_item_id,
      mi.name,
      mi.brand_id,
      b.name                                        AS brand_name,
      COALESCE(SUM(fi.qty), 0)::integer             AS qty_sold,
      COALESCE(SUM(fi.qty * mi.price::numeric), 0)  AS revenue,
      COUNT(DISTINCT fi.order_id)::integer          AS orders
    FROM menu_item mi
    JOIN brand b ON b.id = mi.brand_id
    LEFT JOIN filtered_items fi ON fi.menu_item_id = mi.id
    GROUP BY mi.id, mi.name, mi.brand_id, b.name
    ORDER BY revenue DESC
  `);

  type ProductRow = {
    menu_item_id: string;
    name: string;
    brand_id: string;
    brand_name: string;
    qty_sold: string | number;
    revenue: string | number;
    orders: string | number;
  };

  return toRows<ProductRow>(raw).map((row) => ({
    menuItemId: row.menu_item_id,
    name: row.name,
    brandId: row.brand_id,
    brandName: row.brand_name,
    qtySold: Number(row.qty_sold),
    revenue: Number(row.revenue),
    orders: Number(row.orders),
  }));
}
