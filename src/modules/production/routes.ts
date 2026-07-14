/**
 * Production Router (D35-D46 §6 — BOM authoring/version-lifecycle + Job Order
 * planning/lifecycle).
 *
 * Endpoints (all requireAuth):
 *
 *   GET  /boms                                — bounded/paginated list
 *   GET  /boms/:id                             — header + versions
 *   POST /boms                                 — create header
 *   POST /boms/:id/versions                    — create draft version
 *   POST /boms/versions/:versionId/components  — replace draft component lines (full replace)
 *   POST /boms/versions/:versionId/activate    — DRAFT -> ACTIVE (auto-retires prior ACTIVE)
 *   POST /boms/versions/:versionId/retire      — ACTIVE -> RETIRED
 *
 *   GET  /job-orders                           — bounded/paginated list, scoped to the
 *                                                caller's outlets by the service layer
 *   GET  /job-orders/:id                       — job order + component allocations
 *   POST /job-orders                           — create DRAFT
 *   POST /job-orders/:id/submit
 *   POST /job-orders/:id/approve
 *   POST /job-orders/:id/release
 *   POST /job-orders/:id/start                 — requires Idempotency-Key + X-Correlation-ID
 *   POST /job-orders/:id/cancel
 *   POST /job-orders/:id/fail
 *   POST /job-orders/:id/complete              — requires Idempotency-Key + X-Correlation-ID
 *
 * The authenticated actor (id + session) is read exclusively from `req.user`
 * (set by requireAuth) — every write body schema below is `.strict()` and
 * deliberately has no actor/session field, so a client cannot smuggle
 * `actorUserId`/`sessionId` in through the JSON body; Zod rejects any unknown
 * key with 400 before the handler runs.
 *
 * `BomHeader`/`BomVersion` carry no `locationId` (BOM entities are global,
 * not outlet-scoped), so there is no location room to target — BOM routes
 * below never call `hub.emitToLocation`. Job Orders DO carry a `locationId`,
 * so every Job Order create/lifecycle transition below emits
 * `job_order.updated` to that location's room after it commits.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { bomVersionStatusEnum, jobOrderStatusEnum } from "../../db/production-schema.js";
import { requireAuth } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { BOM_COMPONENT_MAX_LINES } from "./policies.js";
import { StockProductionError } from "./errors.js";
import { StockPostingError } from "../stock/errors.js";
import { createBomService } from "./service.js";
import { createJobOrderService } from "./job-order-service.js";
import type { BomHeaderWithVersions, BomVersionWithComponents, JobOrderWithAllocations } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_CODE_LEN = 100;
const MAX_NAME_LEN = 200;
const MAX_UOM_LEN = 32;
const MAX_REMARKS_LEN = 500;
const MAX_HEADER_LEN = 200;
const MAX_SEARCH_LEN = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;
const MAX_EVIDENCE_REF_LEN = 500;
const MAX_JOB_ORDER_NO_LEN = 100;

// Bounded exact decimal string: up to 14 whole digits + up to 6 fraction
// digits, matching the numeric(20,6) columns these ultimately validate
// against (mirrors src/modules/stock-returns/routes.ts's DECIMAL_RE).
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;
// Bounded scrap-allowance-percent decimal string: up to 3 whole digits + up
// to 4 fraction digits, matching numeric(6,4); the service additionally
// enforces 0 <= x < 100.
const SCRAP_PCT_RE = /^\d{1,3}(\.\d{1,4})?$/;

const BOM_VERSION_STATUSES = bomVersionStatusEnum.enumValues;
const JOB_ORDER_STATUSES = jobOrderStatusEnum.enumValues;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── BOM schemas ──────────────────────────────────────────────────────────

const listBomsQuerySchema = z.object({
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  output_item_id: uuidSchema.optional(),
  is_active: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

const createBomHeaderSchema = z
  .object({
    code: z.string().trim().min(1).max(MAX_CODE_LEN),
    name: z.string().trim().min(1).max(MAX_NAME_LEN),
    output_item_id: uuidSchema,
    production_mode: z.string().optional(),
  })
  .strict();

const createDraftVersionSchema = z
  .object({
    output_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    output_yield_qty: z.string().regex(DECIMAL_RE, "output_yield_qty must be a bounded decimal string."),
    effective_from: dateOnlySchema,
    effective_to: dateOnlySchema.nullable().optional(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const bomComponentLineSchema = z
  .object({
    component_item_id: uuidSchema,
    entered_quantity: z.string().regex(DECIMAL_RE, "entered_quantity must be a bounded decimal string."),
    entered_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    scrap_allowance_pct: z.string().regex(SCRAP_PCT_RE, "scrap_allowance_pct must be a bounded decimal string.").optional(),
  })
  .strict();

const replaceComponentsSchema = z
  .object({
    lines: z.array(bomComponentLineSchema).min(1).max(BOM_COMPONENT_MAX_LINES),
  })
  .strict();

const emptyBodySchema = z.object({}).strict();

// ── Job Order schemas ───────────────────────────────────────────────────

const listJobOrdersQuerySchema = z.object({
  location_id: uuidSchema.optional(),
  bom_header_id: uuidSchema.optional(),
  status: z.enum(JOB_ORDER_STATUSES as [string, ...string[]]).optional(),
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

const createJobOrderDraftSchema = z
  .object({
    job_order_no: z.string().trim().min(1).max(MAX_JOB_ORDER_NO_LEN),
    bom_version_id: uuidSchema,
    location_id: uuidSchema,
    planned_output_qty: z.string().regex(DECIMAL_RE, "planned_output_qty must be a bounded decimal string."),
    planned_output_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const transitionSchema = z.object({ expected_version: z.number().int().nonnegative() }).strict();

const startSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    operator_employee_id: uuidSchema,
  })
  .strict();

const reasonSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(MAX_REMARKS_LEN),
  })
  .strict();

const completeSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    actual_output_qty: z.string().regex(DECIMAL_RE, "actual_output_qty must be a bounded decimal string."),
    evidence_ref: z.string().max(MAX_EVIDENCE_REF_LEN).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no SQL/internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof StockProductionError || err instanceof StockPostingError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[production] unhandled error", err);
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

/** Bounded, required header read; 400s the request and returns null if missing/oversized. */
function requireBoundedHeader(req: { header(name: string): string | undefined }, res: Response, name: string): string | null {
  const raw = req.header(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > MAX_HEADER_LEN) {
    sendError(res, 400, "VALIDATION_ERROR", `${name} header is required and must be at most ${MAX_HEADER_LEN} characters.`);
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Realtime helper
// ---------------------------------------------------------------------------

function emitJobOrderUpdated(hub: RealtimeHub, jobOrder: JobOrderWithAllocations): void {
  hub.emitToLocation(jobOrder.locationId, "job_order.updated", {
    job_order_id: jobOrder.id,
    job_order_no: jobOrder.jobOrderNo,
    status: jobOrder.status,
    version: jobOrder.version,
  });
}

function toBomHeaderResponse(header: BomHeaderWithVersions) {
  return header;
}

function toBomVersionResponse(version: BomVersionWithComponents | { id: string }) {
  return version;
}

function toJobOrderResponse(jobOrder: JobOrderWithAllocations) {
  return jobOrder;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createProductionRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();
  const bomService = createBomService(db);
  const jobOrderService = createJobOrderService(db);

  function actorCtx(req: { user?: { id: string; sessionId?: string } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null };
  }

  // ═════════════════════════════════════════════════════════════════════
  // BOM endpoints
  // ═════════════════════════════════════════════════════════════════════

  // ── GET /boms ───────────────────────────────────────────────────────
  router.get("/boms", requireAuth, async (req, res) => {
    const parsed = listBomsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { search, output_item_id, is_active, limit, offset } = parsed.data;
    const listInput = {
      search,
      outputItemId: output_item_id,
      isActive: is_active === undefined ? undefined : is_active === "true",
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };

    try {
      const { items, total } = await bomService.listHeaders(actorCtx(req), listInput);
      res.json({ items, total, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /boms/:id ───────────────────────────────────────────────────
  router.get("/boms/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const header = await bomService.getHeader(actorCtx(req), { bomHeaderId: id });
      res.json(toBomHeaderResponse(header));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /boms ──────────────────────────────────────────────────────
  router.post("/boms", requireAuth, async (req, res) => {
    const parsed = createBomHeaderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid BOM header payload.", parsed.error.issues);
      return;
    }
    const { code, name, output_item_id, production_mode } = parsed.data;
    try {
      const header = await bomService.createHeader(actorCtx(req), {
        code,
        name,
        outputItemId: output_item_id,
        ...(production_mode !== undefined
          ? { productionMode: production_mode as Parameters<typeof bomService.createHeader>[1]["productionMode"] }
          : {}),
      });
      res.status(201).json(header);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /boms/:id/versions ─────────────────────────────────────────
  router.post("/boms/:id/versions", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = createDraftVersionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid BOM version payload.", parsed.error.issues);
      return;
    }
    const { output_uom, output_yield_qty, effective_from, effective_to, remarks } = parsed.data;
    try {
      const version = await bomService.createDraftVersion(actorCtx(req), {
        bomHeaderId: id,
        outputUom: output_uom,
        outputYieldQty: output_yield_qty,
        effectiveFrom: effective_from,
        effectiveTo: effective_to ?? null,
        remarks: remarks ?? null,
      });
      res.status(201).json(version);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /boms/versions/:versionId/components ──────────────────────
  router.post("/boms/versions/:versionId/components", requireAuth, async (req, res) => {
    const versionId = paramAsString(req.params.versionId);
    const parsed = replaceComponentsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid BOM component lines payload.", parsed.error.issues);
      return;
    }
    try {
      const components = await bomService.replaceDraftComponents(actorCtx(req), {
        bomVersionId: versionId,
        lines: parsed.data.lines.map((line) => ({
          componentItemId: line.component_item_id,
          enteredQuantity: line.entered_quantity,
          enteredUom: line.entered_uom,
          ...(line.scrap_allowance_pct !== undefined ? { scrapAllowancePct: line.scrap_allowance_pct } : {}),
        })),
      });
      res.json({ items: components });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /boms/versions/:versionId/activate ─────────────────────────
  // No realtime emit here: bom_version/bom_header carry no `locationId`,
  // so there is no location room to target (see file header comment).
  router.post("/boms/versions/:versionId/activate", requireAuth, async (req, res) => {
    const versionId = paramAsString(req.params.versionId);
    const parsed = emptyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid activate payload.", parsed.error.issues);
      return;
    }
    try {
      const version = await bomService.activateVersion(actorCtx(req), { bomVersionId: versionId });
      res.json(toBomVersionResponse(version));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /boms/versions/:versionId/retire ───────────────────────────
  // No realtime emit here: bom_version/bom_header carry no `locationId`,
  // so there is no location room to target (see file header comment).
  router.post("/boms/versions/:versionId/retire", requireAuth, async (req, res) => {
    const versionId = paramAsString(req.params.versionId);
    const parsed = emptyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid retire payload.", parsed.error.issues);
      return;
    }
    try {
      const version = await bomService.retireVersion(actorCtx(req), { bomVersionId: versionId });
      res.json(toBomVersionResponse(version));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // Job Order endpoints
  // ═════════════════════════════════════════════════════════════════════

  // ── GET /job-orders ─────────────────────────────────────────────────
  router.get("/job-orders", requireAuth, async (req, res) => {
    const parsed = listJobOrdersQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { location_id, bom_header_id, status, search, limit, offset } = parsed.data;
    const listInput = {
      locationId: location_id,
      bomHeaderId: bom_header_id,
      status: status as (typeof JOB_ORDER_STATUSES)[number] | undefined,
      search,
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };
    try {
      const { items, total } = await jobOrderService.list(actorCtx(req), listInput);
      res.json({ items, total, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /job-orders/:id ──────────────────────────────────────────────
  router.get("/job-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const jobOrder = await jobOrderService.get(actorCtx(req), { jobOrderId: id });
      res.json(toJobOrderResponse(jobOrder));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders ─────────────────────────────────────────────────
  router.post("/job-orders", requireAuth, async (req, res) => {
    const parsed = createJobOrderDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid Job Order payload.", parsed.error.issues);
      return;
    }
    const { job_order_no, bom_version_id, location_id, planned_output_qty, planned_output_uom, remarks } = parsed.data;
    try {
      const jobOrder = await jobOrderService.createDraft(actorCtx(req), {
        jobOrderNo: job_order_no,
        bomVersionId: bom_version_id,
        locationId: location_id,
        plannedOutputQty: planned_output_qty,
        plannedOutputUom: planned_output_uom,
        remarks: remarks ?? null,
      });
      res.status(201).json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/submit ──────────────────────────────────────
  router.post("/job-orders/:id/submit", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = transitionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid submit payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.submit(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/approve ─────────────────────────────────────
  router.post("/job-orders/:id/approve", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = transitionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid approve payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.approve(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/release ─────────────────────────────────────
  router.post("/job-orders/:id/release", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = transitionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid release payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.release(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/start ───────────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-
  // level replay guard on top of the service's own document-derived
  // idempotency — see startJobOrder() in ./job-order-service.ts).
  router.post("/job-orders/:id/start", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid start payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.start(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
        operatorEmployeeId: parsed.data.operator_employee_id,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/cancel ──────────────────────────────────────
  router.post("/job-orders/:id/cancel", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = reasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid cancel payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.cancel(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
        reason: parsed.data.reason,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/fail ─────────────────────────────────────────
  router.post("/job-orders/:id/fail", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = reasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid fail payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.fail(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
        reason: parsed.data.reason,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /job-orders/:id/complete ────────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-
  // level replay guard on top of the service's own document-derived
  // idempotency — see completeJobOrder() in ./job-order-service.ts).
  router.post("/job-orders/:id/complete", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid complete payload.", parsed.error.issues);
      return;
    }
    try {
      const jobOrder = await jobOrderService.complete(actorCtx(req), {
        jobOrderId: id,
        expectedVersion: parsed.data.expected_version,
        actualOutputQty: parsed.data.actual_output_qty,
        evidenceRef: parsed.data.evidence_ref ?? null,
      });
      res.json(toJobOrderResponse(jobOrder));
      emitJobOrderUpdated(hub, jobOrder);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
