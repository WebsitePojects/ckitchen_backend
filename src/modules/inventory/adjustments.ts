/**
 * Stock Adjustment document (D26) — approved write-off / correction flow.
 *
 * The client's MoM "ingredient expiry + over-order negligence" ask: rather than
 * silently editing a balance, a warehouse role REQUESTS an adjustment (PENDING),
 * and OWNER / OUTLET_MANAGER APPROVES or REJECTS it. On approval, in ONE
 * transaction, the row flips to APPROVED and inventory_stock is mutated (OUT
 * decrements, IN increments) while a matching ADJUSTMENT row is posted to the
 * universal stock ledger (Cardinal rule: ledger + balance move together).
 *
 * Segregation of duties: an OUTLET_MANAGER may not approve their OWN request
 * (403 SELF_APPROVAL); OWNER is exempt.
 *
 * Concurrency: approve/reject use a CONDITIONAL update (WHERE status='PENDING',
 * mirroring orders/service.ts FIX A) so a double-decision races cleanly to a
 * single winner — the loser gets 409 CONFLICT, never a partial second stock move.
 *
 * Mounted at /api/v1 so paths are /api/v1/adjustments*.
 */
import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  ingredients,
  inventoryStock,
  stockAdjustmentReasonEnum,
  stockAdjustmentStatusEnum,
  stockAdjustments,
  users,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { normalizeRole } from "../auth/roles.js";
import { isOutletInScope, listScopeLocationIds } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { audit } from "../ems/audit.js";
import { postLedger } from "./ledger.js";

// RBAC (D24 roles v2). WAREHOUSE_MAIN is ALL-scope; the rest are outlet-scoped.
const REQUEST_ROLES = [
  "OWNER",
  "OUTLET_MANAGER",
  "WAREHOUSE_MAIN",
  "WAREHOUSE_OUTLET",
] as const;
const DECIDE_ROLES = ["OWNER", "OUTLET_MANAGER"] as const;

const REASONS = stockAdjustmentReasonEnum.enumValues;

const createSchema = z.object({
  warehouse_id: z.string().uuid(),
  ingredient_id: z.string().uuid(),
  direction: z.enum(["IN", "OUT"]),
  // Always positive; the direction carries the sign. coerce tolerates a numeric
  // string but rejects NaN / non-numeric, and .positive() rejects 0 and negatives.
  quantity: z.coerce.number().positive(),
  reason: z.enum(REASONS as unknown as [string, ...string[]]),
  note: z.string().max(500).optional(),
});

const decideSchema = z.object({
  note: z.string().max(500).optional(),
});

export function createAdjustmentsRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /adjustments — create a PENDING request.
  // -------------------------------------------------------------------------
  router.post(
    "/adjustments",
    requireAuth,
    requireRole(...REQUEST_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid adjustment payload.", parsed.error.issues);
        return;
      }
      const body = parsed.data;

      const [warehouse] = await db
        .select({ id: warehouses.id, type: warehouses.type, locationId: warehouses.locationId })
        .from(warehouses)
        .where(eq(warehouses.id, body.warehouse_id));
      if (!warehouse) {
        sendError(res, 404, "NOT_FOUND", "Warehouse not found.");
        return;
      }

      // Tenancy (D22): the warehouse's own outlet must be in the caller's scope.
      if (!isOutletInScope(req.outletContext, warehouse.locationId)) {
        sendError(res, 403, "FORBIDDEN", "Warehouse is outside your access scope.");
        return;
      }

      const [ingredient] = await db
        .select({ id: ingredients.id })
        .from(ingredients)
        .where(eq(ingredients.id, body.ingredient_id));
      if (!ingredient) {
        sendError(res, 404, "NOT_FOUND", "Ingredient not found.");
        return;
      }

      const [row] = await db
        .insert(stockAdjustments)
        .values({
          warehouseId: body.warehouse_id,
          ingredientId: body.ingredient_id,
          direction: body.direction,
          quantity: String(body.quantity),
          reason: body.reason as typeof REASONS[number],
          note: body.note ?? null,
          status: "PENDING",
          requestedBy: req.user?.id ?? null,
        })
        .returning();

      res.status(201).json(row);

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "adjustment.request",
        description: `requested ${body.direction} adjustment of ${body.quantity} (${body.reason})`,
        entityType: "stock_adjustment",
        entityId: row.id,
        metadata: {
          warehouseId: body.warehouse_id,
          ingredientId: body.ingredient_id,
          direction: body.direction,
          quantity: body.quantity,
          reason: body.reason,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /adjustments — outlet-scoped list, newest-first, enriched.
  //   ?status= &reason= &warehouse_id= &from= &to=
  // -------------------------------------------------------------------------
  router.get("/adjustments", requireAuth, resolveOutletContext, async (req, res) => {
    const { status, reason, warehouse_id, from, to } = req.query as Record<
      string,
      string | undefined
    >;

    const conditions = [];

    // Tenancy: narrow to the caller's in-scope outlets (null = ALL, no filter).
    const scopeLocs = listScopeLocationIds(req.outletContext);
    if (scopeLocs !== null) {
      if (scopeLocs.length === 0) {
        res.json([]);
        return;
      }
      conditions.push(inArray(warehouses.locationId, scopeLocs));
    }

    if (status) {
      if (!(stockAdjustmentStatusEnum.enumValues as readonly string[]).includes(status)) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          `Invalid status. Valid values: ${stockAdjustmentStatusEnum.enumValues.join(", ")}.`,
        );
        return;
      }
      conditions.push(eq(stockAdjustments.status, status as typeof stockAdjustmentStatusEnum.enumValues[number]));
    }
    if (reason) {
      if (!(REASONS as readonly string[]).includes(reason)) {
        sendError(res, 400, "VALIDATION_ERROR", `Invalid reason. Valid values: ${REASONS.join(", ")}.`);
        return;
      }
      conditions.push(eq(stockAdjustments.reason, reason as typeof REASONS[number]));
    }
    if (warehouse_id) {
      if (!z.string().uuid().safeParse(warehouse_id).success) {
        sendError(res, 400, "VALIDATION_ERROR", "'warehouse_id' must be a UUID.");
        return;
      }
      conditions.push(eq(stockAdjustments.warehouseId, warehouse_id));
    }
    if (from) conditions.push(gte(stockAdjustments.createdAt, new Date(from)));
    if (to) conditions.push(lte(stockAdjustments.createdAt, new Date(to)));

    const requester = alias(users, "requester");
    const decider = alias(users, "decider");

    const rows = await db
      .select({
        adjustment: stockAdjustments,
        ingredient: { id: ingredients.id, name: ingredients.name, unit: ingredients.unit },
        warehouse: { id: warehouses.id, type: warehouses.type, locationId: warehouses.locationId },
        requestedByName: requester.name,
        decidedByName: decider.name,
      })
      .from(stockAdjustments)
      .innerJoin(warehouses, eq(stockAdjustments.warehouseId, warehouses.id))
      .innerJoin(ingredients, eq(stockAdjustments.ingredientId, ingredients.id))
      .leftJoin(requester, eq(stockAdjustments.requestedBy, requester.id))
      .leftJoin(decider, eq(stockAdjustments.decidedBy, decider.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(stockAdjustments.createdAt));

    res.json(
      rows.map((r) => ({
        ...r.adjustment,
        ingredient: r.ingredient,
        warehouse: r.warehouse,
        requested_by_name: r.requestedByName,
        decided_by_name: r.decidedByName,
      })),
    );
  });

  // -------------------------------------------------------------------------
  // POST /adjustments/:id/approve — apply the stock change + ledger row.
  // -------------------------------------------------------------------------
  router.post(
    "/adjustments/:id/approve",
    requireAuth,
    requireRole(...DECIDE_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const parsed = decideSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid decision payload.", parsed.error.issues);
        return;
      }

      const [adj] = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, id));
      if (!adj) {
        sendError(res, 404, "NOT_FOUND", "Adjustment not found.");
        return;
      }

      const [warehouse] = await db
        .select({ type: warehouses.type, locationId: warehouses.locationId })
        .from(warehouses)
        .where(eq(warehouses.id, adj.warehouseId));
      if (!isOutletInScope(req.outletContext, warehouse?.locationId)) {
        sendError(res, 403, "FORBIDDEN", "Adjustment is outside your access scope.");
        return;
      }

      // Segregation of duties: an OUTLET_MANAGER cannot approve their OWN request.
      // OWNER is exempt.
      if (
        normalizeRole(req.user?.role) === "OUTLET_MANAGER" &&
        adj.requestedBy &&
        adj.requestedBy === req.user?.id
      ) {
        sendError(res, 403, "SELF_APPROVAL", "You cannot approve your own adjustment request.");
        return;
      }

      const [ingredient] = await db
        .select({ name: ingredients.name })
        .from(ingredients)
        .where(eq(ingredients.id, adj.ingredientId));

      let conflict = false;
      let approved: typeof stockAdjustments.$inferSelect | undefined;
      let newBalance: string | undefined;

      await db.transaction(async (tx) => {
        // FIX A — conditional flip: only proceed if still PENDING (no race window).
        const updatedRows = await tx
          .update(stockAdjustments)
          .set({
            status: "APPROVED",
            decidedBy: req.user?.id ?? null,
            decidedAt: new Date(),
            decisionNote: parsed.data.note ?? null,
          })
          .where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.status, "PENDING")))
          .returning();

        if (updatedRows.length === 0) {
          conflict = true;
          return;
        }
        approved = updatedRows[0];

        // FIX D — create the stock row at 0 if absent so an OUT can go visibly
        // negative rather than being silently skipped.
        await tx
          .insert(inventoryStock)
          .values({ warehouseId: adj.warehouseId, ingredientId: adj.ingredientId, quantity: "0" })
          .onConflictDoNothing({
            target: [inventoryStock.warehouseId, inventoryStock.ingredientId],
          });

        // OUT decrements, IN increments. quantity is positive; sign it for OUT.
        const signed = adj.direction === "OUT" ? `-${adj.quantity}` : String(adj.quantity);
        const [stockRow] = await tx
          .update(inventoryStock)
          .set({ quantity: sql`${inventoryStock.quantity} + ${signed}::numeric` })
          .where(
            and(
              eq(inventoryStock.warehouseId, adj.warehouseId),
              eq(inventoryStock.ingredientId, adj.ingredientId),
            ),
          )
          .returning({ quantity: inventoryStock.quantity });
        newBalance = stockRow?.quantity;

        // Universal ledger (same tx). Idempotent on (module, docNo, lineNo).
        await postLedger(tx, {
          sourceModule: "ADJUSTMENT",
          sourceDocumentNo: adj.id,
          sourceLineNo: adj.ingredientId,
          ingredientId: adj.ingredientId,
          warehouseId: adj.warehouseId,
          movementType: adj.direction,
          quantity: adj.quantity,
          encoderUserId: req.user?.id ?? null,
        });
      });

      if (conflict) {
        sendError(res, 409, "CONFLICT", "Adjustment is not PENDING and cannot be decided again.");
        return;
      }

      res.json(approved!);

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "adjustment.approve",
        description: `approved ${adj.direction} adjustment of ${adj.quantity} (${adj.reason})`,
        entityType: "stock_adjustment",
        entityId: adj.id,
        metadata: { warehouseId: adj.warehouseId, ingredientId: adj.ingredientId },
      });

      // Emit the new balance to the warehouse's outlet room.
      if (warehouse?.locationId && newBalance !== undefined) {
        hub.emitToLocation(warehouse.locationId, "stock.updated", {
          ingredientId: adj.ingredientId,
          ingredientName: ingredient?.name ?? adj.ingredientId,
          warehouseType: warehouse.type,
          quantity: Number(newBalance),
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /adjustments/:id/reject — flip status only, no stock change.
  // -------------------------------------------------------------------------
  router.post(
    "/adjustments/:id/reject",
    requireAuth,
    requireRole(...DECIDE_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const parsed = decideSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid decision payload.", parsed.error.issues);
        return;
      }

      const [adj] = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, id));
      if (!adj) {
        sendError(res, 404, "NOT_FOUND", "Adjustment not found.");
        return;
      }

      const [warehouse] = await db
        .select({ locationId: warehouses.locationId })
        .from(warehouses)
        .where(eq(warehouses.id, adj.warehouseId));
      if (!isOutletInScope(req.outletContext, warehouse?.locationId)) {
        sendError(res, 403, "FORBIDDEN", "Adjustment is outside your access scope.");
        return;
      }

      const updatedRows = await db
        .update(stockAdjustments)
        .set({
          status: "REJECTED",
          decidedBy: req.user?.id ?? null,
          decidedAt: new Date(),
          decisionNote: parsed.data.note ?? null,
        })
        .where(and(eq(stockAdjustments.id, id), eq(stockAdjustments.status, "PENDING")))
        .returning();

      if (updatedRows.length === 0) {
        sendError(res, 409, "CONFLICT", "Adjustment is not PENDING and cannot be decided again.");
        return;
      }

      res.json(updatedRows[0]);

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "adjustment.reject",
        description: `rejected ${adj.direction} adjustment of ${adj.quantity} (${adj.reason})`,
        entityType: "stock_adjustment",
        entityId: adj.id,
        metadata: { warehouseId: adj.warehouseId, ingredientId: adj.ingredientId },
      });
    },
  );

  return router;
}
