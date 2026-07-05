/**
 * Sales Report Service — client requirement #10 (D33), spec platform-ia-navigation.md §8 W3.
 *
 * GET /reports/sales — gross + net sales, grouped by day | brand | outlet | aggregator.
 *
 * Money conventions (reused from src/modules/analytics/service.ts):
 *   - `order.total` (numeric(14,2)) is the exact revenue field per order.
 *   - Only `COMPLETED` orders count as revenue. NOT `NEW`/`PREPARING`/`READY` (not yet
 *     realized) and NOT `CANCELLED` (never realized) — this is a deliberate choice,
 *     not an oversight: a report showing money for orders that never finished would
 *     mislead accounting. If the business later wants a "pipeline" view alongside the
 *     realized-revenue view, that should be a separate report, not a status change here.
 *
 * Gross vs net:
 *   gross_sales = SUM(order.total) for COMPLETED orders in range
 *   net_sales   = gross_sales - commission, where commission is computed PER ORDER from
 *                 its channel listing's `aggregator_account.commission_rate` (percent,
 *                 0-100; migration 0014). commission_rate is NULL until the client
 *                 supplies real per-listing rates (CLIENT_QUESTIONS Part 2) — NULL is
 *                 treated as 0, so gross == net for every listing until a rate is
 *                 configured. This is intentional, not a bug: do not "fix" it by
 *                 inventing a default nonzero rate.
 *
 * Tenancy (D22/D31): every query is scoped through `brand.location_id` (a "location"
 * row IS the outlet/W1 tenancy unit). The caller passes the resolved OutletContext
 * (from resolveOutletContext) — ALL-scope users see everything (unless they've
 * selected one specific outlet via X-Outlet-Id), ASSIGNED-scope users only ever see
 * their `outlet_ids`.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SalesGroupBy = "day" | "brand" | "outlet" | "aggregator";

export interface SalesReportRow {
  key: string;
  orders_count: number;
  gross_sales: number;
  net_sales: number;
}

export interface SalesReportTotals extends SalesReportRow {
  key: "TOTAL";
}

export interface SalesReport {
  from: string;
  to: string;
  group_by: SalesGroupBy;
  rows: SalesReportRow[];
  totals: SalesReportTotals;
}

/** Resolved outlet-scoping input for a query (mirrors req.outletContext from W1). */
export interface OutletFilter {
  scope: "ALL" | "ASSIGNED";
  outletIds: string[];
  selectedOutletId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Same PGlite-vs-postgres-js row unwrap as analytics/service.ts. */
function toRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const r = raw as { rows?: T[] };
  return r.rows ?? [];
}

/**
 * Builds the `AND ...` outlet-scoping fragment applied to every sales query.
 *
 * - A selected outlet (X-Outlet-Id, already membership-checked by
 *   resolveOutletContext) always wins and narrows to that one outlet, for
 *   both ALL- and ASSIGNED-scope users.
 * - No selection + ALL scope => no filter (sees every outlet).
 * - No selection + ASSIGNED scope => restricted to the user's outlet_ids.
 *   An ASSIGNED user with zero granted outlets gets a filter that matches
 *   nothing (fails closed, never "shows everything").
 */
function outletScopeCondition(filter: OutletFilter) {
  if (filter.selectedOutletId) {
    return sql`AND b.location_id = ${filter.selectedOutletId}::uuid`;
  }
  if (filter.scope === "ASSIGNED") {
    if (filter.outletIds.length === 0) {
      return sql`AND FALSE`;
    }
    const idList = sql.join(
      filter.outletIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    return sql`AND b.location_id IN (${idList})`;
  }
  return sql``;
}

type RawSalesRow = {
  key: string;
  orders_count: string | number;
  gross_sales: string | number;
  net_sales: string | number;
};

function toReportRow(row: RawSalesRow): SalesReportRow {
  return {
    key: row.key,
    orders_count: Number(row.orders_count),
    gross_sales: Number(row.gross_sales),
    net_sales: Number(row.net_sales),
  };
}

// ---------------------------------------------------------------------------
// getSalesReport
// ---------------------------------------------------------------------------

export async function getSalesReport(
  db: DB,
  params: {
    from: Date;
    to: Date;
    groupBy: SalesGroupBy;
    outletFilter: OutletFilter;
  },
): Promise<SalesReport> {
  const { from, to, groupBy, outletFilter } = params;
  const scopeCondition = outletScopeCondition(outletFilter);

  // The three JOINs below are all to NOT NULL FKs (order.brand_id, brand.location_id,
  // order.aggregator_account_id), so plain JOINs are correct — unlike the analytics
  // module's LEFT JOINs, this report never needs to show a zero-row group.
  let raw: unknown;

  if (groupBy === "day") {
    raw = await db.execute(sql`
      SELECT
        TO_CHAR(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS key,
        COUNT(o.id)::integer AS orders_count,
        COALESCE(SUM(o.total::numeric), 0) AS gross_sales,
        ROUND(
          COALESCE(
            SUM(o.total::numeric - (o.total::numeric * COALESCE(aa.commission_rate::numeric, 0) / 100)),
            0
          ),
          2
        ) AS net_sales
      FROM "order" o
      JOIN brand b ON b.id = o.brand_id
      JOIN aggregator_account aa ON aa.id = o.aggregator_account_id
      WHERE o.status = 'COMPLETED'
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <= ${to.toISOString()}
        ${scopeCondition}
      GROUP BY TO_CHAR(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      ORDER BY key ASC
    `);
  } else if (groupBy === "brand") {
    raw = await db.execute(sql`
      SELECT
        b.name AS key,
        COUNT(o.id)::integer AS orders_count,
        COALESCE(SUM(o.total::numeric), 0) AS gross_sales,
        ROUND(
          COALESCE(
            SUM(o.total::numeric - (o.total::numeric * COALESCE(aa.commission_rate::numeric, 0) / 100)),
            0
          ),
          2
        ) AS net_sales
      FROM "order" o
      JOIN brand b ON b.id = o.brand_id
      JOIN aggregator_account aa ON aa.id = o.aggregator_account_id
      WHERE o.status = 'COMPLETED'
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <= ${to.toISOString()}
        ${scopeCondition}
      GROUP BY b.id, b.name
      ORDER BY key ASC
    `);
  } else if (groupBy === "outlet") {
    raw = await db.execute(sql`
      SELECT
        loc.name AS key,
        COUNT(o.id)::integer AS orders_count,
        COALESCE(SUM(o.total::numeric), 0) AS gross_sales,
        ROUND(
          COALESCE(
            SUM(o.total::numeric - (o.total::numeric * COALESCE(aa.commission_rate::numeric, 0) / 100)),
            0
          ),
          2
        ) AS net_sales
      FROM "order" o
      JOIN brand b ON b.id = o.brand_id
      JOIN location loc ON loc.id = b.location_id
      JOIN aggregator_account aa ON aa.id = o.aggregator_account_id
      WHERE o.status = 'COMPLETED'
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <= ${to.toISOString()}
        ${scopeCondition}
      GROUP BY loc.id, loc.name
      ORDER BY key ASC
    `);
  } else {
    // groupBy === "aggregator"
    raw = await db.execute(sql`
      SELECT
        o.aggregator::text AS key,
        COUNT(o.id)::integer AS orders_count,
        COALESCE(SUM(o.total::numeric), 0) AS gross_sales,
        ROUND(
          COALESCE(
            SUM(o.total::numeric - (o.total::numeric * COALESCE(aa.commission_rate::numeric, 0) / 100)),
            0
          ),
          2
        ) AS net_sales
      FROM "order" o
      JOIN brand b ON b.id = o.brand_id
      JOIN aggregator_account aa ON aa.id = o.aggregator_account_id
      WHERE o.status = 'COMPLETED'
        AND o.placed_at >= ${from.toISOString()}
        AND o.placed_at <= ${to.toISOString()}
        ${scopeCondition}
      GROUP BY o.aggregator
      ORDER BY key ASC
    `);
  }

  const rows = toRows<RawSalesRow>(raw).map(toReportRow);

  const totals: SalesReportTotals = rows.reduce<SalesReportTotals>(
    (acc, row) => ({
      key: "TOTAL",
      orders_count: acc.orders_count + row.orders_count,
      gross_sales: acc.gross_sales + row.gross_sales,
      net_sales: acc.net_sales + row.net_sales,
    }),
    { key: "TOTAL", orders_count: 0, gross_sales: 0, net_sales: 0 },
  );

  // Round money totals to 2dp — summing floating JS numbers from many rows can
  // introduce sub-cent binary-float noise (e.g. 899.9999999999999).
  totals.gross_sales = Math.round(totals.gross_sales * 100) / 100;
  totals.net_sales = Math.round(totals.net_sales * 100) / 100;

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    group_by: groupBy,
    rows,
    totals,
  };
}
