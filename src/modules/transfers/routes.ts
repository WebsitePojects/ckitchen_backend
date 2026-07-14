/**
 * HQ Transfer Order Router (D35-D46 §1/§2 — HQ_MAIN supplies all outlets;
 * redistribution always routes through HQ via an audited document).
 *
 * Endpoints (all under /api/v1/transfer-orders, all requireAuth):
 *   GET  /transfer-orders                     — bounded/paginated list (search,
 *                                               status, source_location_id,
 *                                               destination_location_id),
 *                                               scoped to the caller's outlets by
 *                                               the service layer
 *   GET  /transfer-orders/:id                 — single order with lines
 *   POST /transfer-orders                     — create DRAFT
 *   PATCH /transfer-orders/:id                — edit DRAFT (remarks/lines)
 *   POST /transfer-orders/:id/submit
 *   POST /transfer-orders/:id/approve
 *   POST /transfer-orders/:id/dispatch        — requires Idempotency-Key + X-Correlation-ID
 *   POST /transfer-orders/:id/receive         — requires Idempotency-Key + X-Correlation-ID
 *   POST /transfer-orders/:id/cancel
 *
 * The authenticated actor (id + session) is read exclusively from `req.user`
 * (set by requireAuth) — every write body schema below is `.strict()` and
 * deliberately has no actor/session field, so a client cannot smuggle
 * `actorUserId`/`sessionId` in through the JSON body; Zod rejects any unknown
 * key with 400 before the handler runs.
 *
 * `transfer_order.updated` is emitted to BOTH the order's source AND
 * destination location rooms (mirrors stock-returns/routes.ts's
 * emitBatchUpdated — a Transfer Order touches two physical sites), but only
 * after a lifecycle TRANSITION actually commits (submit/approve/cancel/
 * dispatch/receive) — never on create/update, which don't change status.
 * Source and destination are always distinct (DB check
 * `transfer_order_source_destination_distinct`), so de-duplicating through a
 * Set is defensive, not load-bearing.
 *
 * Deviation from the customer-orders/stock-returns/production list-endpoint
 * shape: src/modules/transfers/service.ts's facade exposes `list()` but no
 * `count()` (unlike those three modules), so GET /transfer-orders below
 * returns `{ items, limit, offset }` WITHOUT a `total` field — adding a
 * count() would mean touching the already-verified service layer, which is
 * out of scope for this HTTP-layer task.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { transferOrderStatusEnum } from "../../db/transfer-orders-schema.js";
import { requireAuth } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { TRANSFER_MAX_LINES, TRANSFER_MIN_LINES } from "./policies.js";
import { TransferOrderError } from "./errors.js";
import { StockPostingError } from "../stock/errors.js";
import { createTransferOrderService } from "./service.js";
import type { TransferOrder, TransferOrderLineInput, TransferOrderReceiptLineInput } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_UOM_LEN = 32;
const MAX_REMARKS_LEN = 500;
const MAX_SEARCH_LEN = 200;
const MAX_HEADER_LEN = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

// Bounded exact decimal string: up to 14 whole digits + up to 6 fraction
// digits, matching the numeric(20,6) columns these ultimately validate
// against (mirrors src/modules/stock-returns/routes.ts's DECIMAL_RE and
// src/modules/customer-orders/routes.ts's DECIMAL_RE).
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

const STATUSES = transferOrderStatusEnum.enumValues;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const lineSchema = z
  .object({
    item_id: uuidSchema,
    lot_id: uuidSchema.nullable().optional(),
    entered_quantity: z.string().regex(DECIMAL_RE, "entered_quantity must be a bounded decimal string."),
    entered_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    source_warehouse_id: uuidSchema,
    destination_warehouse_id: uuidSchema,
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(TRANSFER_MIN_LINES).max(TRANSFER_MAX_LINES),
  })
  .strict();

const updateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(TRANSFER_MIN_LINES).max(TRANSFER_MAX_LINES).optional(),
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
    line_id: uuidSchema,
    received_quantity: z.string().regex(DECIMAL_RE, "received_quantity must be a bounded decimal string.").optional(),
  })
  .strict();

const receiveSchema = z
  .object({
    version: z.number().int().nonnegative(),
    receipt_lines: z.array(receiptLineSchema).min(1).max(TRANSFER_MAX_LINES).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  source_location_id: uuidSchema.optional(),
  destination_location_id: uuidSchema.optional(),
  status: z.enum(STATUSES as [string, ...string[]]).optional(),
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

function toServiceLine(line: z.infer<typeof lineSchema>): TransferOrderLineInput {
  return {
    itemId: line.item_id,
    lotId: line.lot_id ?? undefined,
    enteredQuantity: line.entered_quantity,
    enteredUom: line.entered_uom,
    remarks: line.remarks ?? null,
  };
}

function toServiceReceiptLine(line: z.infer<typeof receiptLineSchema>): TransferOrderReceiptLineInput {
  return {
    lineId: line.line_id,
    ...(line.received_quantity !== undefined ? { receivedQuantity: line.received_quantity } : {}),
  };
}

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no SQL/internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof TransferOrderError || err instanceof StockPostingError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[transfers] unhandled error", err);
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

/** Emits `transfer_order.updated` once per distinct location (source, destination). */
function emitOrderUpdated(hub: RealtimeHub, order: TransferOrder): void {
  const payload = {
    order_id: order.id,
    document_no: order.documentNo,
    status: order.status,
    version: order.version,
  };
  const locationIds = new Set([order.sourceLocationId, order.destinationLocationId]);
  for (const locationId of locationIds) {
    hub.emitToLocation(locationId, "transfer_order.updated", payload);
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createTransfersRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();
  const service = createTransferOrderService(db);

  function actorCtx(req: { user?: { id: string; sessionId?: string } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null };
  }

  // ── GET /transfer-orders ─────────────────────────────────────────────────
  router.get("/transfer-orders", requireAuth, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { source_location_id, destination_location_id, status, search, limit, offset } = parsed.data;
    const listInput = {
      sourceLocationId: source_location_id,
      destinationLocationId: destination_location_id,
      status: status as (typeof STATUSES)[number] | undefined,
      search,
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };

    try {
      const items = await service.list(actorCtx(req), listInput);
      res.json({ items, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /transfer-orders/:id ─────────────────────────────────────────────
  router.get("/transfer-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const order = await service.get(actorCtx(req), { orderId: id });
      res.json(order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders ────────────────────────────────────────────────
  router.post("/transfer-orders", requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid transfer order payload.", parsed.error.issues);
      return;
    }
    const { source_warehouse_id, destination_warehouse_id, remarks, lines } = parsed.data;
    try {
      const order = await service.createDraft(actorCtx(req), {
        sourceWarehouseId: source_warehouse_id,
        destinationWarehouseId: destination_warehouse_id,
        remarks: remarks ?? null,
        lines: lines.map(toServiceLine),
      });
      res.status(201).json(order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── PATCH /transfer-orders/:id ───────────────────────────────────────────
  router.patch("/transfer-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid transfer order update payload.", parsed.error.issues);
      return;
    }
    const { version, lines } = parsed.data;
    const updateInput: {
      orderId: string;
      version: number;
      remarks?: string | null;
      lines?: TransferOrderLineInput[];
    } = { orderId: id, version };
    if ("remarks" in parsed.data) {
      updateInput.remarks = parsed.data.remarks ?? null;
    }
    if (lines) {
      updateInput.lines = lines.map(toServiceLine);
    }

    try {
      const order = await service.updateDraft(actorCtx(req), updateInput);
      res.json(order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders/:id/submit ─────────────────────────────────────
  router.post("/transfer-orders/:id/submit", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid submit payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.submit(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(order);
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders/:id/approve ────────────────────────────────────
  router.post("/transfer-orders/:id/approve", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid approve payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.approve(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(order);
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders/:id/dispatch ───────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-level
  // replay guard on top of the service's own document-derived idempotency —
  // see dispatchTransferOrder() in ./service.ts).
  router.post("/transfer-orders/:id/dispatch", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid dispatch payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.dispatch(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(order);
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders/:id/receive ────────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-level
  // replay guard on top of the service's own document-derived idempotency —
  // see receiveTransferOrder() in ./service.ts).
  router.post("/transfer-orders/:id/receive", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = receiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid receive payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.receive(actorCtx(req), {
        orderId: id,
        version: parsed.data.version,
        ...(parsed.data.receipt_lines ? { receiptLines: parsed.data.receipt_lines.map(toServiceReceiptLine) } : {}),
      });
      res.json(order);
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /transfer-orders/:id/cancel ─────────────────────────────────────
  router.post("/transfer-orders/:id/cancel", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid cancel payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.cancel(actorCtx(req), {
        orderId: id,
        version: parsed.data.version,
        cancelReason: parsed.data.cancel_reason,
      });
      res.json(order);
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
