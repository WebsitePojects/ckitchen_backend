/**
 * Brand performance: per-brand monthly P&L, trend, projection and a plain verdict (D59).
 *
 * Money per brand per business month (cancelled orders excluded):
 *   gross sales   = Σ qty × unit_price frozen on the order line
 *   discounts     = Σ APPROVED order_discount.amount
 *   net sales     = gross − discounts
 *   food cost     = Σ qty × unit_cost frozen on the order line (current recipe cost only for
 *                   rows older than the snapshot)
 *   channel fees  = gross × (commission + marketing) % snapshotted on the order
 *   contribution  = net sales − food cost − channel fees
 *
 * "Contribution" is what the brand adds before rent, wages and utilities, which ORION does
 * not split per brand. The page says so; a brand with a healthy contribution can still be
 * loss-making once shared overheads land, but a brand with a negative contribution loses
 * money on every order no matter how overheads are split.
 *
 * Projection is a straight-line (least-squares) trend over the brand's completed months,
 * with a ±1 residual standard deviation band, plus a run-rate for the month in progress. It
 * is deliberately simple: owners must be able to check it against the monthly table.
 *
 * Everything heavy runs as grouped SQL (one row per brand per month); the analysis below is
 * pure arithmetic over at most brands × 25 points.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { toRows } from "../../db/rows.js";
import { businessDateSql, localDate, localMonthRange } from "../business-time.js";
import { brandScopeSql, orderScopeSql } from "./scope.js";

/** Rule-of-thumb food cost ceiling for a delivery kitchen; above it margins get thin. */
export const FOOD_COST_TARGET = 0.35;
/** Below this contribution margin a brand is "thin": one bad month away from losing money. */
export const THIN_MARGIN = 0.1;
/** Month-on-month trend (as a share of average monthly sales) that counts as growth or decline. */
export const MOMENTUM_THRESHOLD = 0.05;
/** One product above this share of a brand's sales is a concentration risk. */
export const CONCENTRATION_LIMIT = 0.6;
/** Completed months of sales needed before a trend or projection is shown. */
export const MIN_HISTORY_MONTHS = 3;

export interface MonthPoint {
  month: string;
  grossSales: number;
  discounts: number;
  netSales: number;
  foodCost: number;
  channelFees: number;
  contribution: number;
  orders: number;
  cancelledOrders: number;
}

export type ProfitStatus = "NO_SALES" | "LOSING" | "THIN" | "PROFITABLE";
export type Momentum = "INSUFFICIENT_HISTORY" | "GROWING" | "STABLE" | "DECLINING";

export interface Signal {
  tone: "good" | "warn" | "bad";
  text: string;
}

export interface BrandAnalysis {
  totals: Omit<MonthPoint, "month">;
  contributionMargin: number | null;
  foodCostShare: number | null;
  channelFeeShare: number | null;
  cancellationRate: number | null;
  averageOrderValue: number | null;
  trend: { historyMonths: number; salesSlope: number; contributionSlope: number; r2: number | null; confidence: "NONE" | "LOW" | "MEDIUM" | "HIGH" };
  projection: {
    currentMonth: { netSales: number; contribution: number } | null;
    nextMonth: { netSales: number; contribution: number; contributionLow: number; contributionHigh: number } | null;
  };
  verdict: { status: ProfitStatus; momentum: Momentum; headline: string; signals: Signal[] };
}

export interface ProductLine {
  menuItemId: string;
  name: string;
  qty: number;
  netSales: number;
  foodCost: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const peso = (n: number) => `₱${Math.round(n).toLocaleString("en-PH")}`;
/** Whole percent, but one decimal under 10% so "5.2%" never reads as a contradictory "5%". */
const pct = (n: number) => (Math.abs(n) < 0.1 ? `${(Math.round(n * 1000) / 10).toString()}%` : `${Math.round(n * 100)}%`);

/** Least-squares line through (0, y0), (1, y1)...: slope, intercept, r² and residual sd. */
export function linearFit(ys: number[]): { slope: number; intercept: number; r2: number | null; residualSd: number } {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: null, residualSd: 0 };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let x = 0; x < n; x++) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (ys[x]! - meanY);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let x = 0; x < n; x++) {
    ssRes += (ys[x]! - (intercept + slope * x)) ** 2;
    ssTot += (ys[x]! - meanY) ** 2;
  }
  return {
    slope,
    intercept,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
    residualSd: n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0,
  };
}

/**
 * Turns a brand's month series (oldest first, the LAST entry being the month in progress)
 * into totals, trend, projection and verdict. Pure: same input, same answer.
 */
export function analyzeBrand(
  series: MonthPoint[],
  progress: { daysElapsed: number; daysInMonth: number },
  products: ProductLine[],
): BrandAnalysis {
  const sum = (key: keyof Omit<MonthPoint, "month">) => series.reduce((acc, m) => acc + m[key], 0);
  const totals = {
    grossSales: round2(sum("grossSales")),
    discounts: round2(sum("discounts")),
    netSales: round2(sum("netSales")),
    foodCost: round2(sum("foodCost")),
    channelFees: round2(sum("channelFees")),
    contribution: round2(sum("contribution")),
    orders: sum("orders"),
    cancelledOrders: sum("cancelledOrders"),
  };

  const completed = series.slice(0, -1);
  const current = series[series.length - 1];
  // History starts at the brand's first month with sales, so a brand launched last month is
  // not judged on months it did not exist.
  const firstSale = completed.findIndex((m) => m.netSales > 0);
  const history = firstSale === -1 ? [] : completed.slice(firstSale);

  const salesFit = linearFit(history.map((m) => m.netSales));
  const contributionFit = linearFit(history.map((m) => m.contribution));
  const enoughHistory = history.length >= MIN_HISTORY_MONTHS;
  const confidence: BrandAnalysis["trend"]["confidence"] = !enoughHistory
    ? "NONE"
    : history.length >= 6 && (salesFit.r2 ?? 0) >= 0.5
      ? "HIGH"
      : history.length >= 4
        ? "MEDIUM"
        : "LOW";

  const nextX = history.length;
  const nextMonth = enoughHistory
    ? (() => {
        const contribution = contributionFit.intercept + contributionFit.slope * nextX;
        return {
          netSales: round2(Math.max(0, salesFit.intercept + salesFit.slope * nextX)),
          contribution: round2(contribution),
          contributionLow: round2(contribution - contributionFit.residualSd),
          contributionHigh: round2(contribution + contributionFit.residualSd),
        };
      })()
    : null;

  // Run-rate needs a few days of the month, or one busy morning projects a record month.
  const currentMonth =
    current && progress.daysElapsed >= 3
      ? {
          netSales: round2((current.netSales / progress.daysElapsed) * progress.daysInMonth),
          contribution: round2((current.contribution / progress.daysElapsed) * progress.daysInMonth),
        }
      : null;

  const contributionMargin = ratio(totals.contribution, totals.netSales);
  const foodCostShare = ratio(totals.foodCost, totals.netSales);
  const channelFeeShare = ratio(totals.channelFees, totals.netSales);
  const placed = totals.orders + totals.cancelledOrders;
  const cancellationRate = ratio(totals.cancelledOrders, placed);

  // Profit judged on the last three months with data (recent reality, not the whole window).
  const recent = series.filter((m) => m.netSales > 0 || m.contribution !== 0).slice(-3);
  const recentSales = recent.reduce((a, m) => a + m.netSales, 0);
  const recentContribution = recent.reduce((a, m) => a + m.contribution, 0);
  const recentMargin = ratio(recentContribution, recentSales);
  const status: ProfitStatus =
    totals.netSales <= 0 ? "NO_SALES" : recentContribution < 0 ? "LOSING" : (recentMargin ?? 0) < THIN_MARGIN ? "THIN" : "PROFITABLE";

  const meanSales = history.length ? history.reduce((a, m) => a + m.netSales, 0) / history.length : 0;
  const relativeSlope = meanSales > 0 ? salesFit.slope / meanSales : 0;
  const momentum: Momentum = !enoughHistory
    ? "INSUFFICIENT_HISTORY"
    : relativeSlope > MOMENTUM_THRESHOLD
      ? "GROWING"
      : relativeSlope < -MOMENTUM_THRESHOLD
        ? "DECLINING"
        : "STABLE";

  const signals: Signal[] = [];
  if (foodCostShare !== null) {
    signals.push(
      foodCostShare > FOOD_COST_TARGET
        ? { tone: "warn", text: `Food cost is ${pct(foodCostShare)} of sales (aim for ${pct(FOOD_COST_TARGET)} or less): review portions or prices.` }
        : { tone: "good", text: `Food cost is ${pct(foodCostShare)} of sales, inside the ${pct(FOOD_COST_TARGET)} target.` },
    );
  }
  if (channelFeeShare !== null && channelFeeShare > 0.25) {
    signals.push({ tone: "warn", text: `Platform commission and marketing take ${pct(channelFeeShare)} of sales.` });
  }
  if (cancellationRate !== null && placed >= 20 && cancellationRate > 0.05) {
    signals.push({ tone: "bad", text: `${pct(cancellationRate)} of orders were cancelled (${totals.cancelledOrders} of ${placed}).` });
  }
  const topProduct = products[0];
  const topShare = topProduct ? ratio(topProduct.netSales, totals.netSales) : null;
  if (topProduct && topShare !== null && topShare > CONCENTRATION_LIMIT && products.length > 1) {
    signals.push({ tone: "warn", text: `${topProduct.name} makes ${pct(topShare)} of sales: the brand depends on one item.` });
  }
  if (nextMonth && nextMonth.contribution < 0) {
    signals.push({ tone: "bad", text: `On the current trend next month loses about ${peso(-nextMonth.contribution)} before overheads.` });
  } else if (momentum === "DECLINING") {
    signals.push({ tone: "warn", text: `Sales are falling about ${peso(-salesFit.slope)} a month.` });
  } else if (momentum === "GROWING") {
    signals.push({ tone: "good", text: `Sales are growing about ${peso(salesFit.slope)} a month.` });
  }
  if (!enoughHistory && totals.netSales > 0) {
    signals.push({ tone: "warn", text: `Only ${history.length} full month(s) of sales: too early to call a trend.` });
  }

  const statusWords: Record<ProfitStatus, string> = {
    NO_SALES: "No sales in this period",
    LOSING: "Losing money on every order",
    THIN: "Profitable, but thin",
    PROFITABLE: "Profitable",
  };
  const momentumWords: Record<Momentum, string> = {
    INSUFFICIENT_HISTORY: "",
    GROWING: " and growing",
    STABLE: " and steady",
    DECLINING: ", but declining",
  };
  const headline = status === "NO_SALES" ? statusWords.NO_SALES : `${statusWords[status]}${momentumWords[momentum]}`;

  return {
    totals,
    contributionMargin,
    foodCostShare,
    channelFeeShare,
    cancellationRate,
    averageOrderValue: totals.orders > 0 ? round2(totals.netSales / totals.orders) : null,
    trend: {
      historyMonths: history.length,
      salesSlope: round2(salesFit.slope),
      contributionSlope: round2(contributionFit.slope),
      r2: salesFit.r2 === null ? null : Math.round(salesFit.r2 * 100) / 100,
      confidence,
    },
    projection: { currentMonth, nextMonth },
    verdict: { status, momentum, headline, signals },
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface BrandPerformanceScope {
  /** null = every brand the workspace has. */
  brandIds: string[] | null;
  /** null = every outlet; otherwise only orders placed at these outlets. */
  locationIds: string[] | null;
  /** Completed months to look back over (the month in progress is added on top). */
  months: number;
}

const monthKeySql = (column: SQL) => sql`SUBSTRING(${businessDateSql(column)} FROM 1 FOR 7)`;

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getBrandPerformance(db: DB, scope: BrandPerformanceScope, now = new Date()) {
  const today = localDate(now);
  const currentMonth = today.slice(0, 7);
  const firstMonth = addMonths(currentMonth, -scope.months);
  const monthKeys = Array.from({ length: scope.months + 1 }, (_, i) => addMonths(firstMonth, i));
  const [fy, fm] = firstMonth.split("-").map(Number) as [number, number];
  const [cy, cm] = currentMonth.split("-").map(Number) as [number, number];
  const from = localMonthRange(fy, fm).start;
  const to = localMonthRange(cy, cm).end;
  const daysInMonth = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const daysElapsed = Number(today.slice(8, 10));

  // Same visibility rules as every other report (analytics/scope.ts).
  const brandFilter = brandScopeSql(scope);
  const orderFilter = orderScopeSql(scope);
  const window = sql`o.placed_at >= ${from.toISOString()} AND o.placed_at <= ${to.toISOString()}`;

  const [brandRows, lineRows, discountRows, cancelRows, productRows] = await Promise.all([
    db.execute(sql`
      SELECT b.id, b.name, b.color, b.logo_url, b.is_active
      FROM brand b
      WHERE TRUE ${brandFilter}
      ORDER BY b.name
    `),
    // Lines: one row per brand per month. Food cost falls back to today's recipe cost only for
    // order lines written before unit_cost was frozen on the line.
    db.execute(sql`
      WITH recipe_costs AS (
        SELECT rl.menu_item_id, SUM(rl.portion_qty::numeric * i.unit_cost::numeric) AS recipe_cost
        FROM recipe_line rl JOIN ingredient i ON i.id = rl.ingredient_id
        GROUP BY rl.menu_item_id
      )
      SELECT
        o.brand_id,
        ${monthKeySql(sql`o.placed_at`)} AS month,
        SUM(oi.qty * COALESCE(oi.unit_price::numeric, mi.price::numeric)) AS gross,
        SUM(oi.qty * COALESCE(oi.unit_cost::numeric, rc.recipe_cost, 0)) AS food_cost,
        SUM(oi.qty * COALESCE(oi.unit_price::numeric, mi.price::numeric)
            * (COALESCE(o.commission_rate_snapshot::numeric, 0) + COALESCE(o.marketing_rate_snapshot::numeric, 0)) / 100) AS channel_fees,
        COUNT(DISTINCT o.id) AS orders
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id
      JOIN menu_item mi ON mi.id = oi.menu_item_id
      LEFT JOIN recipe_costs rc ON rc.menu_item_id = oi.menu_item_id
      WHERE ${window} AND o.status <> 'CANCELLED' ${orderFilter}
      GROUP BY o.brand_id, month
    `),
    db.execute(sql`
      SELECT o.brand_id, ${monthKeySql(sql`o.placed_at`)} AS month, SUM(od.amount::numeric) AS discounts
      FROM order_discount od
      JOIN "order" o ON o.id = od.order_id
      WHERE ${window} AND o.status <> 'CANCELLED' AND od.status = 'APPROVED' ${orderFilter}
      GROUP BY o.brand_id, month
    `),
    db.execute(sql`
      SELECT o.brand_id, ${monthKeySql(sql`o.placed_at`)} AS month, COUNT(*) AS cancelled
      FROM "order" o
      WHERE ${window} AND o.status = 'CANCELLED' ${orderFilter}
      GROUP BY o.brand_id, month
    `),
    // Top five products per brand over the whole window, ranked in SQL.
    db.execute(sql`
      WITH recipe_costs AS (
        SELECT rl.menu_item_id, SUM(rl.portion_qty::numeric * i.unit_cost::numeric) AS recipe_cost
        FROM recipe_line rl JOIN ingredient i ON i.id = rl.ingredient_id
        GROUP BY rl.menu_item_id
      ),
      per_item AS (
        SELECT
          o.brand_id, mi.id AS menu_item_id, mi.name,
          SUM(oi.qty) AS qty,
          SUM(oi.qty * COALESCE(oi.unit_price::numeric, mi.price::numeric)) AS net_sales,
          SUM(oi.qty * COALESCE(oi.unit_cost::numeric, rc.recipe_cost, 0)) AS food_cost
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.id
        JOIN menu_item mi ON mi.id = oi.menu_item_id
        LEFT JOIN recipe_costs rc ON rc.menu_item_id = oi.menu_item_id
        WHERE ${window} AND o.status <> 'CANCELLED' ${orderFilter}
        GROUP BY o.brand_id, mi.id, mi.name
      )
      SELECT * FROM (
        SELECT per_item.*, ROW_NUMBER() OVER (PARTITION BY brand_id ORDER BY net_sales DESC) AS rank
        FROM per_item
      ) ranked
      WHERE rank <= 5
    `),
  ]);

  type BrandRow = { id: string; name: string; color: string; logo_url: string | null; is_active: boolean };
  type Keyed = { brand_id: string; month: string };
  const key = (brandId: string, month: string) => `${brandId}|${month}`;
  const lines = new Map(
    toRows<Keyed & { gross: string; food_cost: string; channel_fees: string; orders: string }>(lineRows).map((r) => [key(r.brand_id, r.month), r]),
  );
  const discounts = new Map(toRows<Keyed & { discounts: string }>(discountRows).map((r) => [key(r.brand_id, r.month), Number(r.discounts)]));
  const cancelled = new Map(toRows<Keyed & { cancelled: string }>(cancelRows).map((r) => [key(r.brand_id, r.month), Number(r.cancelled)]));
  const productsByBrand = new Map<string, ProductLine[]>();
  for (const r of toRows<{ brand_id: string; menu_item_id: string; name: string; qty: string; net_sales: string; food_cost: string; rank: string }>(productRows)) {
    const list = productsByBrand.get(r.brand_id) ?? [];
    list.push({ menuItemId: r.menu_item_id, name: r.name, qty: Number(r.qty), netSales: round2(Number(r.net_sales)), foodCost: round2(Number(r.food_cost)) });
    productsByBrand.set(r.brand_id, list);
  }

  const brands = toRows<BrandRow>(brandRows).map((b) => {
    const series: MonthPoint[] = monthKeys.map((month) => {
      const line = lines.get(key(b.id, month));
      const gross = Number(line?.gross ?? 0);
      const discount = discounts.get(key(b.id, month)) ?? 0;
      const foodCost = Number(line?.food_cost ?? 0);
      const channelFees = Number(line?.channel_fees ?? 0);
      const netSales = gross - discount;
      return {
        month,
        grossSales: round2(gross),
        discounts: round2(discount),
        netSales: round2(netSales),
        foodCost: round2(foodCost),
        channelFees: round2(channelFees),
        contribution: round2(netSales - foodCost - channelFees),
        orders: Number(line?.orders ?? 0),
        cancelledOrders: cancelled.get(key(b.id, month)) ?? 0,
      };
    });
    const products = (productsByBrand.get(b.id) ?? []).sort((x, y) => y.netSales - x.netSales);
    return {
      brand: { id: b.id, name: b.name, color: b.color, logoUrl: b.logo_url, isActive: b.is_active },
      series,
      topProducts: products,
      ...analyzeBrand(series, { daysElapsed, daysInMonth }, products),
    };
  });

  const portfolioSales = brands.reduce((a, b) => a + b.totals.netSales, 0);
  const ranked = brands
    .map((b) => ({ ...b, shareOfSales: ratio(b.totals.netSales, portfolioSales) }))
    .sort((x, y) => y.totals.contribution - x.totals.contribution);

  return {
    generatedAt: now.toISOString(),
    months: monthKeys,
    currentMonth: { month: currentMonth, daysElapsed, daysInMonth },
    assumptions: {
      foodCostTarget: FOOD_COST_TARGET,
      thinMargin: THIN_MARGIN,
      momentumThreshold: MOMENTUM_THRESHOLD,
      minHistoryMonths: MIN_HISTORY_MONTHS,
      excludes: "Rent, wages and utilities are not split per brand, so contribution is before overheads.",
    },
    portfolio: {
      netSales: round2(portfolioSales),
      contribution: round2(brands.reduce((a, b) => a + b.totals.contribution, 0)),
      orders: brands.reduce((a, b) => a + b.totals.orders, 0),
    },
    brands: ranked,
  };
}
