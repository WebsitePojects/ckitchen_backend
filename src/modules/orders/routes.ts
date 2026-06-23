/**
 * Orders Router — CK1-API-003 §7
 *
 * Endpoints:
 *   POST /ingest/order               — create / idempotent replay
 *   GET  /orders                     — unified feed (filters: brand_id, aggregator,
 *                                      station_id, status, from, to)
 *   GET  /orders/:id                 — detail with items + print-job status
 *   POST /orders/:id/advance         — advance stage; triggers deduction on NEW→PREPARING
 *   POST /orders/:id/cancel          — cancel; compensating restock if at/after PREPARING
 *   POST /simulator/start            — start order simulator (SUPER_ADMIN)
 *   POST /simulator/stop             — stop simulator   (SUPER_ADMIN)
 *
 * RBAC:
 *   ingest / read       — any authenticated user
 *   advance / cancel    — SUPER_ADMIN | KITCHEN_STAFF
 *   simulator start/stop— SUPER_ADMIN only
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { aggregatorEnum, orderStatusEnum } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import {
  NotFoundError,
  ValidationError,
  advanceOrder,
  cancelOrder,
  getOrderDetail,
  ingestOrder,
  listOrders,
  type IngestOrderInput,
} from "./service.js";
import { startSimulator, stopSimulator } from "./simulator.js";

// ---------------------------------------------------------------------------
// RBAC role sets
// ---------------------------------------------------------------------------

const ORDER_STAGE_ROLES = ["SUPER_ADMIN", "KITCHEN_STAFF"] as const;
const SIMULATOR_ROLES = ["SUPER_ADMIN"] as const;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ingestItemSchema = z.object({
  menu_item_id: z.string().uuid(),
  qty: z.number().int().positive(),
  notes: z.string().optional(),
});

const ingestOrderSchema = z.object({
  brand_id: z.string().uuid(),
  aggregator: z.enum(aggregatorEnum.enumValues),
  external_ref: z.string().min(1),
  customer_name: z.string().optional(),
  placed_at: z.string().datetime({ offset: true }).optional(),
  items: z.array(ingestItemSchema).min(1),
});

const simulatorStartSchema = z.object({
  brand_ids: z.array(z.string().uuid()).min(1),
  rate_per_min: z.number().positive(),
});

// ---------------------------------------------------------------------------
// Error → HTTP response mapping
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof NotFoundError) {
    sendError(res, 404, err.code, err.message);
  } else if (err instanceof ValidationError) {
    sendError(res, 400, err.code, err.message);
  } else {
    const message = err instanceof Error ? err.message : "Internal server error.";
    sendError(res, 500, "INTERNAL_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOrdersRouter(db: DB): Router {
  const router = Router();

  // ── POST /ingest/order ─────────────────────────────────────────────────
  router.post("/ingest/order", requireAuth, async (req, res) => {
    const parsed = ingestOrderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid order payload.", parsed.error.issues);
      return;
    }

    try {
      const result = await ingestOrder(db, parsed.data as IngestOrderInput);

      // DUPLICATE_ORDER → 200 (idempotent replay, not an error)
      if (result.code === "DUPLICATE_ORDER") {
        res.status(200).json(result);
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /orders ────────────────────────────────────────────────────────
  router.get("/orders", requireAuth, async (req, res) => {
    const { brand_id, aggregator, station_id, status, from, to } = req.query as Record<
      string,
      string | undefined
    >;

    if (aggregator && !(aggregatorEnum.enumValues as readonly string[]).includes(aggregator)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `Invalid aggregator. Valid values: ${aggregatorEnum.enumValues.join(", ")}.`,
      );
      return;
    }

    if (status && !(orderStatusEnum.enumValues as readonly string[]).includes(status)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `Invalid status. Valid values: ${orderStatusEnum.enumValues.join(", ")}.`,
      );
      return;
    }

    try {
      const rows = await listOrders(db, { brand_id, aggregator, station_id, status, from, to });
      res.json(rows);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /orders/:id ────────────────────────────────────────────────────
  router.get("/orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);

    try {
      const detail = await getOrderDetail(db, id);
      if (!detail) {
        sendError(res, 404, "NOT_FOUND", "Order not found.");
        return;
      }
      res.json({
        ...detail.order,
        items: detail.items,
        print_jobs: detail.print_jobs,
      });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /orders/:id/advance ───────────────────────────────────────────
  router.post(
    "/orders/:id/advance",
    requireAuth,
    requireRole(...ORDER_STAGE_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);

      try {
        const result = await advanceOrder(db, id);
        // TODO (Task 8): emit order.updated + stock.updated + lowstock.alert
        // via the realtime hub using result.lowStockEvents
        res.json(result);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /orders/:id/cancel ────────────────────────────────────────────
  router.post(
    "/orders/:id/cancel",
    requireAuth,
    requireRole(...ORDER_STAGE_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);

      try {
        const result = await cancelOrder(db, id);
        res.json(result);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /simulator/start ──────────────────────────────────────────────
  router.post(
    "/simulator/start",
    requireAuth,
    requireRole(...SIMULATOR_ROLES),
    async (req, res) => {
      const parsed = simulatorStartSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid simulator payload.", parsed.error.issues);
        return;
      }

      startSimulator(db, parsed.data.brand_ids, parsed.data.rate_per_min);
      res.json({ ok: true, rate_per_min: parsed.data.rate_per_min });
    },
  );

  // ── POST /simulator/stop ───────────────────────────────────────────────
  router.post("/simulator/stop", requireAuth, requireRole(...SIMULATOR_ROLES), (_req, res) => {
    stopSimulator();
    res.json({ ok: true });
  });

  return router;
}
