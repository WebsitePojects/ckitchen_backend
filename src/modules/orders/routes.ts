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
 *
 * Task 8 — realtime emissions:
 *   order.created  → after successful ingest (not on DUPLICATE_ORDER)
 *   order.updated  → after advance and after cancel
 *   stock.updated  → for each ingredient deducted on NEW→PREPARING
 *   lowstock.alert → for each low-stock ingredient triggered by deduction
 */
import { Router, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { aggregatorEnum, brands, locations, orderStatusEnum, orders } from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope, listScopeLocationIds } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { audit } from "../ems/audit.js";
import {
  ConflictError,
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

const ORDER_STAGE_ROLES = ["OWNER", "KITCHEN_CREW"] as const;
const SIMULATOR_ROLES = ["OWNER"] as const;

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
  } else if (err instanceof ConflictError) {
    // FIX A — concurrent double-advance returns 409 CONFLICT
    sendError(res, 409, err.code, err.message);
  } else {
    const message = err instanceof Error ? err.message : "Internal server error.";
    sendError(res, 500, "INTERNAL_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// Location resolution helper
// ---------------------------------------------------------------------------

/**
 * Returns the ID of the single prototype location.
 * Single DB round-trip; returns null if no location is seeded yet
 * (graceful — the emit is simply skipped rather than crashing).
 */
async function getDefaultLocationId(db: DB): Promise<string | null> {
  const [loc] = await db.select({ id: locations.id }).from(locations);
  return loc?.id ?? null;
}

/**
 * Resolves the location_id for a given order by joining order → brand → location.
 * Used for advance / cancel events where we have an orderId but no brand_id in scope.
 */
async function getLocationIdForOrder(db: DB, orderId: string): Promise<string | null> {
  const rows = await db
    .select({ locationId: brands.locationId })
    .from(orders)
    .innerJoin(brands, eq(orders.brandId, brands.id))
    .where(eq(orders.id, orderId));
  return rows[0]?.locationId ?? null;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOrdersRouter(db: DB, hub: RealtimeHub): Router {
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

      // Task 8: emit order.created after successful HTTP response is sent
      // Use brand_id from the validated input to resolve the location room.
      const locationId = await getDefaultLocationId(db);
      if (locationId) {
        hub.emitToLocation(locationId, "order.created", {
          order_id: result.order_id,
          status: result.status,
          brand_id: parsed.data.brand_id,
          aggregator: parsed.data.aggregator,
          external_ref: parsed.data.external_ref,
          customer_name: parsed.data.customer_name ?? null,
          print_jobs: result.print_jobs,
        });
      }
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /orders ────────────────────────────────────────────────────────
  // H2: outlet-scoped. ALL-scope sees every outlet (optionally narrowed by
  // X-Outlet-Id); an ASSIGNED user sees only orders at outlets they belong to.
  router.get("/orders", requireAuth, resolveOutletContext, async (req, res) => {
    const { brand_id, aggregator, station_id, from, to } = req.query as Record<
      string,
      string | undefined
    >;

    // status accepts a single value, a comma-separated list, or repeated params
    // (?status=NEW&status=PREPARING) — the KDS needs several active stages at once.
    const statusRaw = req.query.status;
    let statuses: string[] | undefined;
    if (statusRaw !== undefined) {
      statuses = (Array.isArray(statusRaw) ? statusRaw.map(String) : String(statusRaw).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      const valid = orderStatusEnum.enumValues as readonly string[];
      if (statuses.some((s) => !valid.includes(s))) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          `Invalid status. Valid values: ${orderStatusEnum.enumValues.join(", ")}.`,
        );
        return;
      }
    }

    if (aggregator && !(aggregatorEnum.enumValues as readonly string[]).includes(aggregator)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `Invalid aggregator. Valid values: ${aggregatorEnum.enumValues.join(", ")}.`,
      );
      return;
    }

    try {
      const rows = await listOrders(db, {
        brand_id,
        aggregator,
        station_id,
        status: statuses,
        from,
        to,
        location_ids: listScopeLocationIds(req.outletContext) ?? undefined,
      });
      res.json(rows);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /orders/:id ────────────────────────────────────────────────────
  // H2: 403 when the order's outlet is outside the caller's scope (consistent
  // with inventory's membership 403). Order-not-found still returns 404.
  router.get("/orders/:id", requireAuth, resolveOutletContext, async (req, res) => {
    const id = paramAsString(req.params.id);

    try {
      const orderLocationId = await getLocationIdForOrder(db, id);
      if (!orderLocationId) {
        sendError(res, 404, "NOT_FOUND", "Order not found.");
        return;
      }
      if (!isOutletInScope(req.outletContext, orderLocationId)) {
        sendError(res, 403, "FORBIDDEN", "Order is outside your access scope.");
        return;
      }

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
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);

      try {
        // H2: block cross-outlet advance BEFORE the service runs — advancing
        // NEW→PREPARING deducts real stock, so an outside-scope caller must be
        // stopped here, not after the deduction.
        const orderLocationId = await getLocationIdForOrder(db, id);
        if (!orderLocationId) {
          sendError(res, 404, "NOT_FOUND", "Order not found.");
          return;
        }
        if (!isOutletInScope(req.outletContext, orderLocationId)) {
          sendError(res, 403, "FORBIDDEN", "Order is outside your access scope.");
          return;
        }

        // FIX A — pass the authenticated user id so consumption_log.logged_by is set
        const result = await advanceOrder(db, id, req.user?.id);
        res.json(result);

        // EMS: audit order.advance (non-blocking — swallows errors internally)
        void audit(db, {
          actorUserId: req.user?.id ?? null,
          sessionId: req.user?.sessionId ?? null,
          action: "order.advance",
          description: `marked order ${id} as ${result.status}`,
          entityType: "order",
          entityId: id,
          metadata: { status: result.status },
        });

        // Task 8: emit order.updated, stock.updated (per ingredient), lowstock.alert
        const locationId = await getLocationIdForOrder(db, id);
        if (locationId) {
          // order.updated — stage + timestamps
          hub.emitToLocation(locationId, "order.updated", {
            order_id: result.order_id,
            status: result.status,
            prepAt: result.prepAt,
            readyAt: result.readyAt,
            completedAt: result.completedAt,
          });

          // stock.updated — one event per ingredient whose balance changed
          for (const update of result.stockUpdates) {
            hub.emitToLocation(locationId, "stock.updated", update);
          }

          // lowstock.alert — one event per ingredient that crossed its threshold
          for (const alert of result.lowStockEvents) {
            hub.emitToLocation(locationId, "lowstock.alert", alert);
          }
        }
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
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";

      try {
        // H2: block cross-outlet cancel (cancel-after-PREPARING posts compensating
        // restock — a foreign caller must not move another outlet's stock).
        const orderLocationId = await getLocationIdForOrder(db, id);
        if (!orderLocationId) {
          sendError(res, 404, "NOT_FOUND", "Order not found.");
          return;
        }
        if (!isOutletInScope(req.outletContext, orderLocationId)) {
          sendError(res, 403, "FORBIDDEN", "Order is outside your access scope.");
          return;
        }

        const result = await cancelOrder(db, id, reason);
        res.json(result);

        // EMS: audit order.cancel WITH reason (non-blocking)
        void audit(db, {
          actorUserId: req.user?.id ?? null,
          sessionId: req.user?.sessionId ?? null,
          action: "order.cancel",
          description: `cancelled order ${id}: ${reason.trim()}`,
          entityType: "order",
          entityId: id,
          metadata: { status: result.status, reason: reason.trim() },
        });

        // Task 8: emit order.updated with CANCELLED status
        const locationId = await getLocationIdForOrder(db, id);
        if (locationId) {
          hub.emitToLocation(locationId, "order.updated", {
            order_id: id,
            status: result.status,
          });
        }
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
