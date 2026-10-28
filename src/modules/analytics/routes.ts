/**
 * Analytics Router — CK1-API-003 §9
 *
 * All endpoints are read-only GET. Every one goes through analytics/scope.ts:
 *   OWNER / ACCOUNTING - the whole workspace, or the outlet picked in X-Outlet-Id
 *   BRAND_MANAGER      - only their assigned brands (user_brand), only their outlets
 *   OUTLET_MANAGER     - brand performance only, their outlets only
 *
 * Endpoints (all under /api/v1):
 *   GET /analytics/brands?from&to                — brand revenue ranking + weakest flag
 *   GET /analytics/orders-by-hour?date            — hourly order counts for a date
 *   GET /analytics/orders-by-hour-by-brand?date   — MOTM #9: hourly order counts, per brand
 *   GET /analytics/aggregators?from&to            — revenue+count split by aggregator
 *   GET /analytics/margins?from&to                — per-brand recipe-cost margin
 *   GET /analytics/products?from&to               — MOTM #8: per menu-item performance
 *   GET /analytics/brand-performance?months&brand_ids — D59: monthly P&L, trend, projection,
 *                                                    verdict; brand- and outlet-scoped
 */
import { Router } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { getBrandPerformance } from "./brand-performance.js";
import { resolveAnalyticsScope } from "./scope.js";
import { sendError, sendInternalError } from "../http-errors.js";
import {
  getAggregatorsAnalytics,
  getBrandsAnalytics,
  getMarginsAnalytics,
  getOrdersByHour,
  getOrdersByHourByBrand,
  getProductPerformance,
} from "./service.js";

// ---------------------------------------------------------------------------
// RBAC — CK1-API-003 §1 role matrix
// ---------------------------------------------------------------------------

const ANALYTICS_ROLES = ["OWNER", "BRAND_MANAGER", "ACCOUNTING"] as const;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const dateRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const brandPerformanceSchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
  brand_ids: z
    .string()
    .optional()
    .transform((v) => (v ? [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))] : undefined))
    .pipe(z.array(z.string().uuid()).max(50).optional()),
});

/**
 * Brand performance is money, so it is scoped twice: a BRAND_MANAGER sees only the brands
 * assigned to them (user_brand), and an outlet-scoped reader only orders placed at their
 * outlets. OWNER and ACCOUNTING see the whole workspace (or the outlet picked in the header).
 */
const BRAND_PERFORMANCE_ROLES = ["OWNER", "ACCOUNTING", "BRAND_MANAGER", "OUTLET_MANAGER"] as const;

const dateSchema = z.object({
  date: z.string().min(1, { message: "Query param 'date' is required." }),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAnalyticsRouter(db: DB): Router {
  const router = Router();

  // ── GET /analytics/brands?from&to ─────────────────────────────────────────
  router.get(
    "/analytics/brands",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getBrandsAnalytics(db, parsed.data.from, parsed.data.to, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/orders-by-hour?date ────────────────────────────────────
  router.get(
    "/analytics/orders-by-hour",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Query param 'date' is required (YYYY-MM-DD).",
          parsed.error.issues,
        );
        return;
      }

      try {
        const data = await getOrdersByHour(db, parsed.data.date, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/orders-by-hour-by-brand?date ───────────────────────────
  // MOTM 2026-07-01 #9: "the order by hour is good, but they want to see
  // which brand it is." Same date validation as /analytics/orders-by-hour;
  // the sibling endpoint above is left untouched for backward compatibility.
  router.get(
    "/analytics/orders-by-hour-by-brand",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Query param 'date' is required (YYYY-MM-DD).",
          parsed.error.issues,
        );
        return;
      }

      try {
        const data = await getOrdersByHourByBrand(db, parsed.data.date, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/aggregators?from&to ────────────────────────────────────
  router.get(
    "/analytics/aggregators",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getAggregatorsAnalytics(db, parsed.data.from, parsed.data.to, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/margins?from&to ────────────────────────────────────────
  router.get(
    "/analytics/margins",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getMarginsAnalytics(db, parsed.data.from, parsed.data.to, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/products?from&to ───────────────────────────────────────
  // MOTM 2026-07-01 #8: "Brand and Product Performance" — product side.
  router.get(
    "/analytics/products",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getProductPerformance(db, parsed.data.from, parsed.data.to, await resolveAnalyticsScope(db, req));
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  // ── GET /analytics/brand-performance?months&brand_ids ─────────────────────
  router.get(
    "/analytics/brand-performance",
    requireAuth,
    requireRole(...BRAND_PERFORMANCE_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = brandPerformanceSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "months must be 1-24; brand_ids a comma list of UUIDs.", parsed.error.issues);
        return;
      }
      try {
        const scope = await resolveAnalyticsScope(db, req);
        const requested = parsed.data.brand_ids ?? null;
        if (requested && scope.brandIds && requested.some((id) => !scope.brandIds!.includes(id))) {
          sendError(res, 403, "FORBIDDEN", "That brand is not assigned to you.");
          return;
        }
        const data = await getBrandPerformance(db, {
          brandIds: requested ?? scope.brandIds,
          locationIds: scope.locationIds,
          months: parsed.data.months,
        });
        res.json(data);
      } catch (err) {
        sendInternalError(res, err, "analytics");
      }
    },
  );

  return router;
}
