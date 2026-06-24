/**
 * Analytics Router — CK1-API-003 §9
 *
 * All endpoints are read-only GET.  Auth matrix:
 *   SUPER_ADMIN  — sees all brands / all data
 *   BRAND_MANAGER— role permitted (prototype: same full view; per-brand filter is a
 *                  post-prototype enhancement once user_brand scoping is tested at scale)
 *   ACCOUNTANT   — sees all brands / all data (finance view)
 *
 * Endpoints (all under /api/v1):
 *   GET /analytics/brands?from&to         — brand revenue ranking + weakest flag
 *   GET /analytics/orders-by-hour?date    — hourly order counts for a date
 *   GET /analytics/aggregators?from&to    — revenue+count split by aggregator
 *   GET /analytics/margins?from&to        — per-brand recipe-cost margin
 */
import { Router } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { sendError } from "../http-errors.js";
import {
  getAggregatorsAnalytics,
  getBrandsAnalytics,
  getMarginsAnalytics,
  getOrdersByHour,
} from "./service.js";

// ---------------------------------------------------------------------------
// RBAC — CK1-API-003 §1 role matrix
// ---------------------------------------------------------------------------

const ANALYTICS_ROLES = ["SUPER_ADMIN", "BRAND_MANAGER", "ACCOUNTANT"] as const;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const dateRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

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
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getBrandsAnalytics(db, parsed.data.from, parsed.data.to);
        res.json(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  // ── GET /analytics/orders-by-hour?date ────────────────────────────────────
  router.get(
    "/analytics/orders-by-hour",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
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
        const data = await getOrdersByHour(db, parsed.data.date);
        res.json(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  // ── GET /analytics/aggregators?from&to ────────────────────────────────────
  router.get(
    "/analytics/aggregators",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getAggregatorsAnalytics(db, parsed.data.from, parsed.data.to);
        res.json(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  // ── GET /analytics/margins?from&to ────────────────────────────────────────
  router.get(
    "/analytics/margins",
    requireAuth,
    requireRole(...ANALYTICS_ROLES),
    async (req, res) => {
      const parsed = dateRangeSchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      try {
        const data = await getMarginsAnalytics(db, parsed.data.from, parsed.data.to);
        res.json(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  return router;
}
