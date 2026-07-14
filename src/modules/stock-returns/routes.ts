/**
 * Stock Return Batch Router (D35-D46 §5 — outlet return and disposition).
 *
 * Endpoints (all under /api/v1/stock-returns, all requireAuth):
 *   GET  /stock-returns              — bounded/paginated list (search, status,
 *                                      source_location_id), scoped to the
 *                                      caller's outlets by the service layer
 *   GET  /stock-returns/:id          — single batch with lines
 *   POST /stock-returns              — create DRAFT
 *   PATCH /stock-returns/:id         — edit DRAFT (remarks and/or lines)
 *   POST /stock-returns/:id/submit
 *   POST /stock-returns/:id/approve
 *   POST /stock-returns/:id/cancel
 *   POST /stock-returns/:id/dispatch          — requires Idempotency-Key + X-Correlation-ID
 *   POST /stock-returns/:id/receive-dispose    — requires Idempotency-Key + X-Correlation-ID
 *
 * The authenticated actor (id + session) is read exclusively from
 * `req.user` (set by requireAuth) — every write body schema below is
 * `.strict()` and deliberately has no actor/session field, so a client
 * cannot smuggle `actorUserId`/`sessionId` in through the JSON body; Zod
 * rejects any unknown key with 400 before the handler runs.
 *
 * `stock_return.updated` is emitted to the batch's source AND destination
 * (HQ) location rooms, but only after a lifecycle TRANSITION actually
 * commits (submit/approve/cancel/dispatch/receive-dispose) — never on
 * create/update, which don't change status. Source and destination are
 * always distinct (DB check `stock_return_batch_source_destination_distinct`),
 * so de-duplicating through a Set is defensive, not load-bearing.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { stockReturnBatchStatusEnum, stockReturnReasonEnum } from "../../db/returns-schema.js";
import { requireAuth } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { STOCK_RETURN_MAX_LINES } from "./policies.js";
import { StockReturnError } from "./errors.js";
import { StockPostingError } from "../stock/errors.js";
import { createStockReturnService } from "./service.js";
import type { StockReturnBatch, StockReturnBatchWithLines } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_REMARKS_LEN = 500;
const MAX_UOM_LEN = 32;
const MAX_EVIDENCE_REF_LEN = 500;
const MAX_SEARCH_LEN = 200;
const MAX_HEADER_LEN = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

// Bounded exact decimal string: up to 14 whole digits + up to 6 fraction
// digits, matching the numeric(20,6) column the value is ultimately parsed
// against in resolveAndValidateLines() (src/modules/stock-returns/service.ts).
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

const REASON_CODES = stockReturnReasonEnum.enumValues;
const BATCH_STATUSES = stockReturnBatchStatusEnum.enumValues;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const lineSchema = z
  .object({
    item_id: uuidSchema,
    lot_id: uuidSchema,
    source_warehouse_id: uuidSchema,
    entered_quantity: z.string().regex(DECIMAL_RE, "entered_quantity must be a bounded decimal string."),
    entered_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    reason_code: z.enum(REASON_CODES as [string, ...string[]]),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    evidence_ref: z.string().max(MAX_EVIDENCE_REF_LEN).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    source_location_id: uuidSchema,
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(STOCK_RETURN_MAX_LINES),
  })
  .strict();

const updateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(STOCK_RETURN_MAX_LINES).optional(),
  })
  .strict();

const versionSchema = z.object({ version: z.number().int().nonnegative() }).strict();

const cancelSchema = z
  .object({
    version: z.number().int().nonnegative(),
    cancel_reason: z.string().trim().min(1).max(MAX_REMARKS_LEN),
  })
  .strict();

const receiptLineSchema = z
  .object({
    batch_line_id: uuidSchema,
    disposition_reason_code: z.enum(REASON_CODES as [string, ...string[]]),
    disposition_remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const receiveDisposeSchema = z
  .object({
    version: z.number().int().nonnegative(),
    receipt_lines: z.array(receiptLineSchema).min(1).max(STOCK_RETURN_MAX_LINES),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum(BATCH_STATUSES as [string, ...string[]]).optional(),
  source_location_id: uuidSchema.optional(),
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no SQL/internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof StockReturnError || err instanceof StockPostingError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[stock-returns] unhandled error", err);
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

/** Emits `stock_return.updated` once per distinct location (source, HQ). */
function emitBatchUpdated(hub: RealtimeHub, batch: StockReturnBatch): void {
  const payload = {
    batch_id: batch.id,
    document_no: batch.documentNo,
    status: batch.status,
    version: batch.version,
  };
  const locationIds = new Set([batch.sourceLocationId, batch.destinationLocationId]);
  for (const locationId of locationIds) {
    hub.emitToLocation(locationId, "stock_return.updated", payload);
  }
}

function toBatchResponse(batch: StockReturnBatchWithLines) {
  return batch;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createStockReturnsRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();
  const service = createStockReturnService(db);

  function actorCtx(req: { user?: { id: string; sessionId?: string } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null };
  }

  // ── GET /stock-returns ─────────────────────────────────────────────────
  router.get("/stock-returns", requireAuth, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { status, source_location_id, search, limit, offset } = parsed.data;
    const listInput = {
      status: status as (typeof BATCH_STATUSES)[number] | undefined,
      sourceLocationId: source_location_id,
      search,
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };

    try {
      const ctx = actorCtx(req);
      const [items, total] = await Promise.all([
        service.list(ctx, listInput),
        service.count(ctx, listInput),
      ]);
      res.json({ items, total, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /stock-returns/:id ─────────────────────────────────────────────
  router.get("/stock-returns/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const batch = await service.get(actorCtx(req), { batchId: id });
      res.json(toBatchResponse(batch));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns ────────────────────────────────────────────────
  router.post("/stock-returns", requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid stock return payload.", parsed.error.issues);
      return;
    }
    const { source_location_id, remarks, lines } = parsed.data;

    try {
      const batch = await service.createDraft(actorCtx(req), {
        sourceLocationId: source_location_id,
        remarks: remarks ?? null,
        lines: lines.map((line) => ({
          itemId: line.item_id,
          lotId: line.lot_id,
          sourceWarehouseId: line.source_warehouse_id,
          enteredQuantity: line.entered_quantity,
          enteredUom: line.entered_uom,
          reasonCode: line.reason_code as (typeof REASON_CODES)[number],
          remarks: line.remarks ?? null,
          evidenceRef: line.evidence_ref ?? null,
        })),
      });
      res.status(201).json(toBatchResponse(batch));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── PATCH /stock-returns/:id ───────────────────────────────────────────
  router.patch("/stock-returns/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid stock return update payload.", parsed.error.issues);
      return;
    }
    const { version, lines } = parsed.data;
    const updateInput: {
      batchId: string;
      version: number;
      remarks?: string | null;
      lines?: Parameters<typeof service.updateDraftLines>[1]["lines"];
    } = { batchId: id, version };
    if ("remarks" in parsed.data) {
      updateInput.remarks = parsed.data.remarks ?? null;
    }
    if (lines) {
      updateInput.lines = lines.map((line) => ({
        itemId: line.item_id,
        lotId: line.lot_id,
        sourceWarehouseId: line.source_warehouse_id,
        enteredQuantity: line.entered_quantity,
        enteredUom: line.entered_uom,
        reasonCode: line.reason_code as (typeof REASON_CODES)[number],
        remarks: line.remarks ?? null,
        evidenceRef: line.evidence_ref ?? null,
      }));
    }

    try {
      const batch = await service.updateDraftLines(actorCtx(req), updateInput);
      res.json(toBatchResponse(batch));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns/:id/submit ─────────────────────────────────────
  router.post("/stock-returns/:id/submit", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid submit payload.", parsed.error.issues);
      return;
    }
    try {
      const batch = await service.submit(actorCtx(req), { batchId: id, version: parsed.data.version });
      res.json(toBatchResponse(batch));
      emitBatchUpdated(hub, batch);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns/:id/approve ────────────────────────────────────
  router.post("/stock-returns/:id/approve", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid approve payload.", parsed.error.issues);
      return;
    }
    try {
      const batch = await service.approve(actorCtx(req), { batchId: id, version: parsed.data.version });
      res.json(toBatchResponse(batch));
      emitBatchUpdated(hub, batch);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns/:id/cancel ─────────────────────────────────────
  router.post("/stock-returns/:id/cancel", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid cancel payload.", parsed.error.issues);
      return;
    }
    try {
      const batch = await service.cancel(actorCtx(req), {
        batchId: id,
        version: parsed.data.version,
        cancelReason: parsed.data.cancel_reason,
      });
      res.json(toBatchResponse(batch));
      emitBatchUpdated(hub, batch);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns/:id/dispatch ───────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-level
  // replay guard on top of the service's own document-derived idempotency —
  // see dispatchStockReturnBatch() in ./service.ts).
  router.post("/stock-returns/:id/dispatch", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid dispatch payload.", parsed.error.issues);
      return;
    }
    try {
      const batch = await service.dispatch(actorCtx(req), { batchId: id, version: parsed.data.version });
      res.json(toBatchResponse(batch));
      emitBatchUpdated(hub, batch);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /stock-returns/:id/receive-dispose ────────────────────────────
  router.post("/stock-returns/:id/receive-dispose", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = receiveDisposeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid receive-dispose payload.", parsed.error.issues);
      return;
    }
    try {
      const batch = await service.receiveAndDispose(actorCtx(req), {
        batchId: id,
        version: parsed.data.version,
        receiptLines: parsed.data.receipt_lines.map((line) => ({
          batchLineId: line.batch_line_id,
          dispositionReasonCode: line.disposition_reason_code,
          dispositionRemarks: line.disposition_remarks ?? null,
        })),
      });
      res.json(toBatchResponse(batch));
      emitBatchUpdated(hub, batch);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
