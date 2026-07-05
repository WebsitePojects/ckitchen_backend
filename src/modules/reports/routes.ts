/**
 * Reports Router — GET /reports/sales, GET /reports/sales/export (client req #10, D33).
 *
 * RBAC (platform-ia-navigation.md §3/§8 W3): OWNER + ACCOUNTING (v1 aliases SUPER_ADMIN /
 * ACCOUNTANT normalize to these via requireRole's normalizeRole — same pattern as every
 * other v2-aware router in this codebase).
 *
 * Tenancy (D22/D31): resolveOutletContext runs after requireRole so req.outletContext is
 * always set before the service layer scopes the query. ASSIGNED-scope users only ever
 * see their own outlet_ids; ALL-scope users see everything unless X-Outlet-Id narrows to
 * one specific outlet (already membership-checked by the middleware itself).
 */
import { Router } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { sendError } from "../http-errors.js";
import { getSalesReport, type OutletFilter, type SalesGroupBy } from "./service.js";
import { buildSalesReportPdf, buildSalesReportXlsx } from "./export.js";

const REPORTS_ROLES = ["OWNER", "ACCOUNTING"] as const;

const GROUP_BY_VALUES = ["day", "brand", "outlet", "aggregator"] as const;

const salesReportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  group_by: z.enum(GROUP_BY_VALUES).optional().default("day"),
});

const exportQuerySchema = salesReportQuerySchema.extend({
  format: z.enum(["xlsx", "pdf"]),
});

// ---------------------------------------------------------------------------
// Date range resolution — defaults to the current UTC calendar month (D33 #10:
// "date range defaulting to current month").
// ---------------------------------------------------------------------------

function currentMonthRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { from, to };
}

/**
 * Resolves { from, to } Date objects from optional query strings, defaulting
 * missing side(s) to the current month's bounds. Returns `null` (with the
 * response already sent as 400) when either date is unparseable or from > to.
 */
function resolveRange(
  from: string | undefined,
  to: string | undefined,
  res: Parameters<typeof sendError>[0],
): { from: Date; to: Date } | null {
  const defaults = currentMonthRange();
  const fromDate = from ? new Date(from) : defaults.from;
  const toDate = to ? new Date(to) : defaults.to;

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    sendError(res, 400, "VALIDATION_ERROR", "Invalid 'from'/'to' date.");
    return null;
  }
  if (fromDate.getTime() > toDate.getTime()) {
    sendError(res, 400, "VALIDATION_ERROR", "'from' must not be after 'to'.");
    return null;
  }
  return { from: fromDate, to: toDate };
}

function outletFilterFromRequest(ctx: {
  scope: "ALL" | "ASSIGNED";
  outletIds: string[];
  selectedOutletId?: string;
}): OutletFilter {
  return {
    scope: ctx.scope,
    outletIds: ctx.outletIds,
    selectedOutletId: ctx.selectedOutletId,
  };
}

function exportFilename(from: Date, format: "xlsx" | "pdf"): string {
  const year = from.getUTCFullYear();
  const month = String(from.getUTCMonth() + 1).padStart(2, "0");
  return `orion-sales-${year}-${month}.${format}`;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createReportsRouter(db: DB): Router {
  const router = Router();

  // ── GET /reports/sales ────────────────────────────────────────────────────
  router.get(
    "/reports/sales",
    requireAuth,
    requireRole(...REPORTS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = salesReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      const range = resolveRange(parsed.data.from, parsed.data.to, res);
      if (!range) return; // 400 already sent

      try {
        const report = await getSalesReport(db, {
          from: range.from,
          to: range.to,
          groupBy: parsed.data.group_by as SalesGroupBy,
          outletFilter: outletFilterFromRequest(req.outletContext!),
        });
        res.json(report);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  // ── GET /reports/sales/export?format=xlsx|pdf ────────────────────────────
  router.get(
    "/reports/sales/export",
    requireAuth,
    requireRole(...REPORTS_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = exportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
        return;
      }

      const range = resolveRange(parsed.data.from, parsed.data.to, res);
      if (!range) return; // 400 already sent

      try {
        const report = await getSalesReport(db, {
          from: range.from,
          to: range.to,
          groupBy: parsed.data.group_by as SalesGroupBy,
          outletFilter: outletFilterFromRequest(req.outletContext!),
        });

        const filename = exportFilename(range.from, parsed.data.format);

        if (parsed.data.format === "xlsx") {
          const buffer = await buildSalesReportXlsx(report);
          res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          );
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          res.send(buffer);
        } else {
          const buffer = await buildSalesReportPdf(report);
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
          res.send(buffer);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal server error.";
        sendError(res, 500, "INTERNAL_ERROR", message);
      }
    },
  );

  return router;
}
