/**
 * Brand performance arithmetic (D59): the trend, projection and verdict are pure functions,
 * so owners can check them against the monthly table and these tests pin the rules.
 */
import { describe, expect, it } from "vitest";
import { analyzeBrand, linearFit, type MonthPoint, type ProductLine } from "../src/modules/analytics/brand-performance.js";

function month(i: number, netSales: number, opts: Partial<MonthPoint> = {}): MonthPoint {
  const foodCost = opts.foodCost ?? netSales * 0.3;
  const channelFees = opts.channelFees ?? netSales * 0.2;
  return {
    month: `2026-${String(i + 1).padStart(2, "0")}`,
    grossSales: netSales,
    discounts: 0,
    netSales,
    foodCost,
    channelFees,
    contribution: opts.contribution ?? netSales - foodCost - channelFees,
    orders: opts.orders ?? Math.round(netSales / 250),
    cancelledOrders: opts.cancelledOrders ?? 0,
  };
}

const progress = { daysElapsed: 10, daysInMonth: 30 };
const noProducts: ProductLine[] = [];

describe("linearFit", () => {
  it("recovers an exact line", () => {
    const fit = linearFit([10, 20, 30, 40]);
    expect(fit.slope).toBeCloseTo(10);
    expect(fit.intercept).toBeCloseTo(10);
    expect(fit.r2).toBeCloseTo(1);
    expect(fit.residualSd).toBeCloseTo(0);
  });

  it("flat data has zero slope and no r² (nothing to explain)", () => {
    const fit = linearFit([5, 5, 5]);
    expect(fit.slope).toBe(0);
    expect(fit.r2).toBeNull();
  });
});

describe("analyzeBrand", () => {
  it("growing, profitable brand: projects next month on the trend", () => {
    const series = [10_000, 12_000, 14_000, 16_000, 18_000, 20_000].map((s, i) => month(i, s));
    series.push(month(6, 7_000)); // month in progress, 10 of 30 days
    const a = analyzeBrand(series, progress, noProducts);

    expect(a.verdict.status).toBe("PROFITABLE");
    expect(a.verdict.momentum).toBe("GROWING");
    expect(a.verdict.headline).toBe("Profitable and growing");
    expect(a.trend.historyMonths).toBe(6);
    expect(a.trend.salesSlope).toBeCloseTo(2_000);
    expect(a.trend.confidence).toBe("HIGH");
    expect(a.projection.nextMonth!.netSales).toBeCloseTo(22_000);
    expect(a.projection.nextMonth!.contribution).toBeCloseTo(22_000 * 0.5);
    // Run-rate: 7,000 in 10 days -> 21,000 for 30 days.
    expect(a.projection.currentMonth!.netSales).toBeCloseTo(21_000);
    expect(a.contributionMargin).toBeCloseTo(0.5);
  });

  it("negative contribution recently = LOSING, with a loss projection signal", () => {
    const series = [8_000, 7_000, 6_000, 5_000].map((s, i) =>
      month(i, s, { foodCost: s * 0.6, channelFees: s * 0.5 }),
    );
    series.push(month(4, 0, { contribution: 0 }));
    const a = analyzeBrand(series, progress, noProducts);
    expect(a.verdict.status).toBe("LOSING");
    expect(a.verdict.momentum).toBe("DECLINING");
    expect(a.verdict.signals.some((s) => s.tone === "bad" && s.text.includes("loses"))).toBe(true);
    expect(a.verdict.signals.some((s) => s.text.includes("Food cost is 60%"))).toBe(true);
  });

  it("thin margin is not called profitable", () => {
    const series = [10_000, 10_000, 10_000].map((s, i) => month(i, s, { foodCost: s * 0.45, channelFees: s * 0.5 }));
    series.push(month(3, 0, { contribution: 0 }));
    const a = analyzeBrand(series, progress, noProducts);
    expect(a.verdict.status).toBe("THIN");
    expect(a.verdict.momentum).toBe("STABLE");
  });

  it("a new brand is not judged on months before its first sale, and gets no projection", () => {
    const series = [0, 0, 0, 0, 9_000, 11_000].map((s, i) => month(i, s));
    series.push(month(6, 4_000));
    const a = analyzeBrand(series, progress, noProducts);
    expect(a.trend.historyMonths).toBe(2);
    expect(a.verdict.momentum).toBe("INSUFFICIENT_HISTORY");
    expect(a.projection.nextMonth).toBeNull();
    expect(a.verdict.signals.some((s) => s.text.includes("too early"))).toBe(true);
    expect(a.verdict.headline).toBe("Profitable");
  });

  it("no sales at all", () => {
    const series = [0, 0, 0].map((s, i) => month(i, s, { contribution: 0 }));
    const a = analyzeBrand(series, progress, noProducts);
    expect(a.verdict.status).toBe("NO_SALES");
    expect(a.averageOrderValue).toBeNull();
    expect(a.contributionMargin).toBeNull();
  });

  it("run-rate waits for three days of the month", () => {
    const series = [month(0, 10_000), month(1, 10_000), month(2, 10_000), month(3, 1_000)];
    expect(analyzeBrand(series, { daysElapsed: 2, daysInMonth: 30 }, noProducts).projection.currentMonth).toBeNull();
    expect(analyzeBrand(series, { daysElapsed: 3, daysInMonth: 30 }, noProducts).projection.currentMonth).not.toBeNull();
  });

  it("flags a one-product brand and heavy cancellations", () => {
    const series = [month(0, 10_000, { orders: 40, cancelledOrders: 5 }), month(1, 10_000, { orders: 40, cancelledOrders: 5 }), month(2, 0, { contribution: 0 })];
    const products: ProductLine[] = [
      { menuItemId: "a", name: "Chicken Bowl", qty: 50, netSales: 15_000, foodCost: 4_000 },
      { menuItemId: "b", name: "Iced Tea", qty: 30, netSales: 5_000, foodCost: 1_000 },
    ];
    const a = analyzeBrand(series, progress, products);
    expect(a.verdict.signals.some((s) => s.text.startsWith("Chicken Bowl makes 75%"))).toBe(true);
    expect(a.verdict.signals.some((s) => s.tone === "bad" && s.text.includes("cancelled"))).toBe(true);
    expect(a.cancellationRate).toBeCloseTo(10 / 90);
  });
});
