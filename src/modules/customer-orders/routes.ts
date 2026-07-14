/**
 * Customer Order Router (D35-D46 §7 — Customer Orders and Job Orders).
 *
 * Endpoints (all under /api/v1/customer-orders, all requireAuth):
 *   GET  /customer-orders                    — bounded/paginated list (search,
 *                                               status, location_id, customer_id),
 *                                               scoped to the caller's outlets by
 *                                               the service layer
 *   GET  /customer-orders/:id                — single order with lines
 *   POST /customer-orders                    — create DRAFT
 *   PATCH /customer-orders/:id               — edit DRAFT (remarks/required_date and/or lines)
 *   POST /customer-orders/:id/submit
 *   POST /customer-orders/:id/approve
 *   POST /customer-orders/:id/allocate
 *   POST /customer-orders/:id/mark-in-production
 *   POST /customer-orders/:id/mark-ready
 *   POST /customer-orders/:id/fulfill         — requires Idempotency-Key + X-Correlation-ID
 *   POST /customer-orders/:id/cancel
 *
 * The authenticated actor (id + session) is read exclusively from `req.user`
 * (set by requireAuth) — every write body schema below is `.strict()` and
 * deliberately has no actor/session field, so a client cannot smuggle
 * `actorUserId`/`sessionId` in through the JSON body; Zod rejects any unknown
 * key with 400 before the handler runs.
 *
 * Realtime: `customer_order.updated` is emitted to the order's outlet
 * (`locationId`) room after CREATE and after every lifecycle transition that
 * commits (mirrors job-order's routes.ts, not stock-returns' — a Customer
 * Order's own creation is itself a status-relevant event the dashboard must
 * reflect within ~2s per business-rules.md #9 "Distinct audible alert on
 * order.created"). PATCH (draft edit) does not change status, so it does not
 * emit, matching every other module's convention.
 *
 * Only fulfill() requires the bounded Idempotency-Key/X-Correlation-ID
 * contract-level replay guard: it is the sole transition that posts a real
 * stock movement through the central posting service (mirrors job-order's
 * start/complete and stock-returns' dispatch/receive-dispose). allocate() and
 * mark-ready() only write/read reservation rows (customer_order_allocation),
 * not stock postings, so they follow the plain version-body convention used
 * by submit/approve/cancel.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { customerOrderStatusEnum } from "../../db/customer-orders-schema.js";
import { consumptionModeEnum } from "../../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { CUSTOMER_ORDER_MAX_LINES } from "./policies.js";
import { CustomerOrderError } from "./errors.js";
import { StockPostingError } from "../stock/errors.js";
import { createCustomerOrderService } from "./service.js";
import type { CreateCustomerOrderLineInput, CustomerOrderWithLines } from "./types.js";

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
// src/modules/production/routes.ts's DECIMAL_RE).
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

const ORDER_STATUSES = customerOrderStatusEnum.enumValues;
const CONSUMPTION_MODES = consumptionModeEnum.enumValues;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const componentRequirementLineSchema = z
  .object({
    item_id: uuidSchema,
    quantity: z.string().regex(DECIMAL_RE, "quantity must be a bounded decimal string."),
  })
  .strict();

const componentRequirementsSnapshotSchema = z
  .object({
    components: z.array(componentRequirementLineSchema).min(1),
  })
  .strict();

const lineSchema = z
  .object({
    item_id: uuidSchema,
    entered_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    entered_quantity: z.string().regex(DECIMAL_RE, "entered_quantity must be a bounded decimal string."),
    unit_price: z.string().regex(DECIMAL_RE, "unit_price must be a bounded decimal string."),
    tax_amount: z.string().regex(DECIMAL_RE, "tax_amount must be a bounded decimal string.").optional(),
    discount_amount: z.string().regex(DECIMAL_RE, "discount_amount must be a bounded decimal string.").optional(),
    consumption_mode: z.enum(CONSUMPTION_MODES as [string, ...string[]]),
    component_requirements_snapshot: componentRequirementsSnapshotSchema.nullable().optional(),
    job_order_id: uuidSchema.nullable().optional(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    document_no: z.string().trim().min(1).optional(),
    customer_id: uuidSchema,
    location_id: uuidSchema,
    required_date: dateOnlySchema.nullable().optional(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(CUSTOMER_ORDER_MAX_LINES),
  })
  .strict();

const updateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    required_date: dateOnlySchema.nullable().optional(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(1).max(CUSTOMER_ORDER_MAX_LINES).optional(),
  })
  .strict();

const versionSchema = z.object({ version: z.number().int().nonnegative() }).strict();

const cancelSchema = z
  .object({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(MAX_REMARKS_LEN),
  })
  .strict();

const listQuerySchema = z.object({
  location_id: uuidSchema.optional(),
  customer_id: uuidSchema.optional(),
  status: z.enum(ORDER_STATUSES as [string, ...string[]]).optional(),
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

function toServiceLine(line: z.infer<typeof lineSchema>): CreateCustomerOrderLineInput {
  return {
    itemId: line.item_id,
    enteredUom: line.entered_uom,
    enteredQuantity: line.entered_quantity,
    unitPrice: line.unit_price,
    ...(line.tax_amount !== undefined ? { taxAmount: line.tax_amount } : {}),
    ...(line.discount_amount !== undefined ? { discountAmount: line.discount_amount } : {}),
    consumptionMode: line.consumption_mode as CreateCustomerOrderLineInput["consumptionMode"],
    componentRequirementsSnapshot: line.component_requirements_snapshot
      ? {
          components: line.component_requirements_snapshot.components.map((c) => ({
            itemId: c.item_id,
            quantity: c.quantity,
          })),
        }
      : (line.component_requirements_snapshot ?? undefined),
    jobOrderId: line.job_order_id ?? undefined,
    remarks: line.remarks ?? null,
  };
}

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no SQL/internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof CustomerOrderError || err instanceof StockPostingError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[customer-orders] unhandled error", err);
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

function emitOrderUpdated(hub: RealtimeHub, order: CustomerOrderWithLines): void {
  hub.emitToLocation(order.locationId, "customer_order.updated", {
    order_id: order.id,
    document_no: order.documentNo,
    status: order.status,
    version: order.version,
  });
}

function toOrderResponse(order: CustomerOrderWithLines) {
  return order;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCustomerOrdersRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();
  const service = createCustomerOrderService(db);

  function actorCtx(req: { user?: { id: string; sessionId?: string } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null };
  }

  // ── GET /customer-orders ────────────────────────────────────────────────
  router.get("/customer-orders", requireAuth, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { location_id, customer_id, status, search, limit, offset } = parsed.data;
    const listInput = {
      locationId: location_id,
      customerId: customer_id,
      status: status as (typeof ORDER_STATUSES)[number] | undefined,
      search,
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };

    try {
      const { items, total } = await service.list(actorCtx(req), listInput);
      res.json({ items, total, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /customer-orders/:id ────────────────────────────────────────────
  router.get("/customer-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const order = await service.get(actorCtx(req), { orderId: id });
      res.json(toOrderResponse(order));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders ───────────────────────────────────────────────
  router.post("/customer-orders", requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid Customer Order payload.", parsed.error.issues);
      return;
    }
    const { document_no, customer_id, location_id, required_date, remarks, lines } = parsed.data;
    try {
      const order = await service.createDraft(actorCtx(req), {
        ...(document_no !== undefined ? { documentNo: document_no } : {}),
        customerId: customer_id,
        locationId: location_id,
        requiredDate: required_date ?? null,
        remarks: remarks ?? null,
        lines: lines.map(toServiceLine),
      });
      res.status(201).json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── PATCH /customer-orders/:id ──────────────────────────────────────────
  router.patch("/customer-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid Customer Order update payload.", parsed.error.issues);
      return;
    }
    const { version, lines } = parsed.data;
    const updateInput: {
      orderId: string;
      version: number;
      requiredDate?: string | null;
      remarks?: string | null;
      lines?: CreateCustomerOrderLineInput[];
    } = { orderId: id, version };
    if ("required_date" in parsed.data) {
      updateInput.requiredDate = parsed.data.required_date ?? null;
    }
    if ("remarks" in parsed.data) {
      updateInput.remarks = parsed.data.remarks ?? null;
    }
    if (lines) {
      updateInput.lines = lines.map(toServiceLine);
    }

    try {
      const order = await service.update(actorCtx(req), updateInput);
      res.json(toOrderResponse(order));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/submit ────────────────────────────────────
  router.post("/customer-orders/:id/submit", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid submit payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.submit(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/approve ───────────────────────────────────
  router.post("/customer-orders/:id/approve", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid approve payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.approve(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/allocate ──────────────────────────────────
  router.post("/customer-orders/:id/allocate", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid allocate payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.allocate(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/mark-in-production ────────────────────────
  router.post("/customer-orders/:id/mark-in-production", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid mark-in-production payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.markInProduction(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/mark-ready ────────────────────────────────
  router.post("/customer-orders/:id/mark-ready", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid mark-ready payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.markReady(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/fulfill ───────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-
  // level replay guard on top of the service's own document-derived
  // idempotency — see fulfillCustomerOrder() in ./service.ts).
  router.post("/customer-orders/:id/fulfill", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid fulfill payload.", parsed.error.issues);
      return;
    }
    try {
      const order = await service.fulfill(actorCtx(req), { orderId: id, version: parsed.data.version });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /customer-orders/:id/cancel ────────────────────────────────────
  router.post("/customer-orders/:id/cancel", requireAuth, async (req, res) => {
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
        reason: parsed.data.reason,
      });
      res.json(toOrderResponse(order));
      emitOrderUpdated(hub, order);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
