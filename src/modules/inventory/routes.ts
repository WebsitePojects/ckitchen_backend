/**
 * Ingredients, Warehouses, Inventory & ITO — CK1-API-003 §6
 *
 * Two-tier stock model: MAIN warehouse (supplier deliveries) → KITCHEN warehouse
 * (cooking pool). Transfers happen exclusively via Internal Transfer Orders (ITOs).
 *
 * Cardinal Business Rule #4 — ITO confirm is ATOMIC:
 *   MAIN -= qty AND KITCHEN += qty in ONE Drizzle transaction. Never partial.
 *
 * Cardinal Business Rule #8 — Low-stock:
 *   GET /inventory?warehouse=KITCHEN flags below_threshold=true when qty <= threshold.
 *
 * RBAC per role matrix (CK1-API-003 §1):
 *   inventory receive / ITO confirm → SUPER_ADMIN | WAREHOUSE
 *   ITO request / consumption log  → SUPER_ADMIN | KITCHEN_STAFF
 *   ingredient create              → SUPER_ADMIN only
 *
 * Task 8 — realtime emissions:
 *   stock.updated → after /inventory/receive (MAIN) and /itos/:id/confirm (KITCHEN)
 */
import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  consumptionLogs,
  ingredients,
  inventoryStock,
  itoItems,
  itoStatusEnum,
  itos,
  locations,
  stockLedgerEntries,
  warehouseTypeEnum,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { audit } from "../ems/audit.js";
import { postLedger } from "./ledger.js";

// ---------------------------------------------------------------------------
// RBAC role sets (§1 role matrix)
// ---------------------------------------------------------------------------

const ADMIN_ONLY = ["OWNER"] as const;
const INVENTORY_ROLES = ["OWNER", "WAREHOUSE_OUTLET"] as const; // receive + confirm
const ITO_REQUEST_ROLES = ["OWNER", "KITCHEN_CREW"] as const; // request + consumption

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createIngredientSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  unit_cost: z.union([z.string().min(1), z.number()]),
  low_stock_threshold: z.union([z.string().min(1), z.number()]),
});

const receiveItemSchema = z.object({
  ingredient_id: z.string().uuid(),
  quantity: z.union([z.string().min(1), z.number()]),
});

const receiveSchema = z.object({
  outlet_id: z.string().uuid().optional(),
  items: z.array(receiveItemSchema).min(1),
});

const consumptionItemSchema = z.object({
  ingredient_id: z.string().uuid(),
  quantity: z.union([z.string().min(1), z.number()]),
});

const consumptionSchema = z.object({
  log_date: z.string().datetime({ offset: true }).optional(),
  items: z.array(consumptionItemSchema).min(1),
});

const itoItemSchema = z.object({
  ingredient_id: z.string().uuid(),
  quantity: z.union([z.string().min(1), z.number()]),
});

const createItoSchema = z.object({
  outlet_id: z.string().uuid().optional(),
  from: z.literal("MAIN"),
  to: z.literal("KITCHEN"),
  items: z.array(itoItemSchema).min(1),
});

const outletIdParamSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Location resolution helper
// ---------------------------------------------------------------------------

/** Fetch the single prototype location id (gracefully returns null if not seeded). */
async function getDefaultLocationId(db: DB): Promise<string | null> {
  const [loc] = await db.select({ id: locations.id }).from(locations);
  return loc?.id ?? null;
}

function parseOutletIdParam(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const parsed = outletIdParamSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolves which outlet (location) a scoped inventory request targets, enforcing
 * the tenancy rule (D22 / SF-5): the client-supplied `outlet_id` (and the
 * `X-Outlet-Id` header) are NOT trusted scoping inputs on their own.
 *
 *   • An explicitly requested outlet (body/query `outlet_id`, else `X-Outlet-Id`)
 *     is allowed for an ALL-scope user (benign filter), but an ASSIGNED user must
 *     be a member of it — otherwise 403.
 *   • With no explicit request, we fall back to the single prototype outlet
 *     (`getDefaultLocationId`) exactly as before, so single-outlet flows are
 *     unchanged.
 *
 * Requires `resolveOutletContext` to have run (so `req.outletContext` is set).
 */
async function resolveLocationId(
  db: DB,
  req: Request,
  res: Response,
  rawOutletId: unknown,
): Promise<string | null> {
  const parsedOutletId = parseOutletIdParam(rawOutletId);
  if (parsedOutletId === null) {
    sendError(res, 400, "VALIDATION_ERROR", "Query param 'outlet_id' must be a UUID.");
    return null;
  }

  const ctx = req.outletContext;
  // Explicit request: the body/query param wins, else the X-Outlet-Id selection.
  let requested = parsedOutletId ?? ctx?.selectedOutletId;

  // M1: an ASSIGNED user who names NO outlet must resolve to their OWN outlet —
  // never the deployment's "first location row" (a membership bypass). One
  // assigned outlet → use it; several → force an explicit choice; none → deny.
  if (!requested && ctx && ctx.scope !== "ALL") {
    if (ctx.outletIds.length === 1) {
      requested = ctx.outletIds[0];
    } else if (ctx.outletIds.length === 0) {
      sendError(res, 403, "FORBIDDEN", "No outlet in your access scope.");
      return null;
    } else {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "Multiple outlets in your access scope; specify one via 'outlet_id' or the X-Outlet-Id header.",
      );
      return null;
    }
  }

  if (requested) {
    // SF-5: an ASSIGNED user may only target outlets they are a member of.
    if (ctx && ctx.scope !== "ALL" && !ctx.outletIds.includes(requested)) {
      sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
      return null;
    }
    const [location] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, requested));
    if (!location) {
      sendError(res, 404, "NOT_FOUND", "Outlet not found.");
      return null;
    }
    return location.id;
  }

  // ALL-scope (or no ctx) with no explicit selection → deployment default outlet.
  const defaultLocationId = await getDefaultLocationId(db);
  if (!defaultLocationId) {
    sendError(res, 500, "NOT_FOUND", "No outlet is configured for this deployment.");
    return null;
  }

  return defaultLocationId;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createInventoryRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();

  // Helper: look up a warehouse by its type (MAIN | KITCHEN) for this prototype's
  // single-location deployment.
  async function getWarehouseByType(
    type: typeof warehouseTypeEnum.enumValues[number],
    locationId: string,
  ) {
    const [warehouse] = await db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.type, type), eq(warehouses.locationId, locationId)));
    return warehouse ?? null;
  }

  // -------------------------------------------------------------------------
  // GET /ingredients — list all ingredients
  // -------------------------------------------------------------------------
  router.get("/ingredients", requireAuth, async (req, res) => {
    const rows = await db.select().from(ingredients);
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // POST /ingredients — create ingredient (SUPER_ADMIN only)
  // -------------------------------------------------------------------------
  router.post("/ingredients", requireAuth, requireRole(...ADMIN_ONLY), async (req, res) => {
    const parsed = createIngredientSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ingredient payload.", parsed.error.issues);
      return;
    }

    const [ingredient] = await db
      .insert(ingredients)
      .values({
        name: parsed.data.name,
        unit: parsed.data.unit,
        unitCost: String(parsed.data.unit_cost),
        lowStockThreshold: String(parsed.data.low_stock_threshold),
      })
      .returning();

    res.status(201).json(ingredient);
  });

  // -------------------------------------------------------------------------
  // GET /warehouses — list the two tiers
  // -------------------------------------------------------------------------
  router.get("/warehouses", requireAuth, resolveOutletContext, async (req, res) => {
    const locationId = await resolveLocationId(db, req, res, req.query.outlet_id);
    if (!locationId) return;

    const rows = await db
      .select()
      .from(warehouses)
      .where(eq(warehouses.locationId, locationId));
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // GET /inventory?warehouse=MAIN|KITCHEN — stock per tier; flags below_threshold
  //
  // Cardinal Rule #8: when qty <= low_stock_threshold the item is flagged.
  // -------------------------------------------------------------------------
  router.get("/inventory", requireAuth, resolveOutletContext, async (req, res) => {
    const warehouseParam = req.query.warehouse as string | undefined;

    if (!warehouseParam || !["MAIN", "KITCHEN"].includes(warehouseParam)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "Query param 'warehouse' is required and must be MAIN or KITCHEN.",
      );
      return;
    }

    const locationId = await resolveLocationId(db, req, res, req.query.outlet_id);
    if (!locationId) return;

    const warehouse = await getWarehouseByType(warehouseParam as "MAIN" | "KITCHEN", locationId);
    if (!warehouse) {
      sendError(res, 404, "NOT_FOUND", `Warehouse of type ${warehouseParam} not found.`);
      return;
    }

    // Join inventory_stock with ingredients; compute below_threshold in SQL so
    // the numeric comparison is exact (avoids JS string-to-number edge cases).
    const rows = await db
      .select({
        id: inventoryStock.id,
        warehouseId: inventoryStock.warehouseId,
        ingredientId: inventoryStock.ingredientId,
        quantity: inventoryStock.quantity,
        ingredient: {
          id: ingredients.id,
          name: ingredients.name,
          unit: ingredients.unit,
          unitCost: ingredients.unitCost,
          lowStockThreshold: ingredients.lowStockThreshold,
        },
        // Rule #8: flag when KITCHEN ingredient quantity <= its threshold
        below_threshold: sql<boolean>`
          ${inventoryStock.quantity}::numeric <= ${ingredients.lowStockThreshold}::numeric
        `,
      })
      .from(inventoryStock)
      .innerJoin(ingredients, eq(inventoryStock.ingredientId, ingredients.id))
      .where(eq(inventoryStock.warehouseId, warehouse.id));

    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // POST /inventory/receive — supplier delivery into MAIN
  // Upserts inventory_stock(warehouse_id, ingredient_id) by adding the quantity.
  // -------------------------------------------------------------------------
  router.post(
    "/inventory/receive",
    requireAuth,
    requireRole(...INVENTORY_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = receiveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid receive payload.", parsed.error.issues);
        return;
      }

      const locationId = await resolveLocationId(db, req, res, parsed.data.outlet_id);
      if (!locationId) return;

      const mainWarehouse = await getWarehouseByType("MAIN", locationId);
      if (!mainWarehouse) {
        sendError(res, 500, "NOT_FOUND", "MAIN warehouse not configured.");
        return;
      }

      // Validate all ingredient IDs exist before touching stock
      for (const item of parsed.data.items) {
        const [ingredient] = await db
          .select()
          .from(ingredients)
          .where(eq(ingredients.id, item.ingredient_id));
        if (!ingredient) {
          sendError(res, 404, "NOT_FOUND", `Ingredient ${item.ingredient_id} not found.`);
          return;
        }
      }

      // Upsert each item into MAIN inventory_stock (add to existing qty if row present).
      // Also post a RECEIVE ledger row inside the same transaction (ERP R1).
      // Generate a receive document ref: RECV-<timestamp>-<mainWarehouseId-prefix>
      const receiveDocNo = `RECV-${Date.now()}-${mainWarehouse.id.slice(0, 8)}`;

      await db.transaction(async (tx) => {
        for (const item of parsed.data.items) {
          await tx
            .insert(inventoryStock)
            .values({
              warehouseId: mainWarehouse.id,
              ingredientId: item.ingredient_id,
              quantity: String(item.quantity),
            })
            .onConflictDoUpdate({
              target: [inventoryStock.warehouseId, inventoryStock.ingredientId],
              set: {
                // accumulate: existing + new delivery
                quantity: sql`${inventoryStock.quantity} + EXCLUDED.quantity`,
              },
            });

          // ERP R1: post RECEIVE IN ledger row (idempotent on unique key)
          await postLedger(tx, {
            sourceModule: "RECEIVE",
            sourceDocumentNo: receiveDocNo,
            sourceLineNo: item.ingredient_id,
            ingredientId: item.ingredient_id,
            warehouseId: mainWarehouse.id,
            movementType: "IN",
            quantity: item.quantity,
            encoderUserId: req.user?.id ?? null,
          });
        }
      });

      res.status(201).json({ ok: true });

      // EMS: audit inventory.receive (non-blocking)
      void audit(db, {
        actorUserId: req.user?.id ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "inventory.receive",
        description: `received ${parsed.data.items.length} ingredient(s) into MAIN warehouse`,
        entityType: "warehouse",
        metadata: { items: parsed.data.items },
      });

      // Task 8: emit stock.updated for each received ingredient (MAIN warehouse)
      const emitLocationId = mainWarehouse.locationId;
      if (emitLocationId) {
        for (const item of parsed.data.items) {
          // Read back the new MAIN balance
          const [stockRow] = await db
            .select({ quantity: inventoryStock.quantity })
            .from(inventoryStock)
            .where(
              and(
                eq(inventoryStock.warehouseId, mainWarehouse.id),
                eq(inventoryStock.ingredientId, item.ingredient_id),
              ),
            );
          const [ing] = await db
            .select({ name: ingredients.name })
            .from(ingredients)
            .where(eq(ingredients.id, item.ingredient_id));

          if (stockRow) {
            hub.emitToLocation(emitLocationId, "stock.updated", {
              ingredientId: item.ingredient_id,
              ingredientName: ing?.name ?? item.ingredient_id,
              warehouseType: "MAIN",
              quantity: Number(stockRow.quantity),
            });
          }
        }
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /inventory/consumption — log end-of-day usage
  // Records consumption_log rows. Does NOT automatically deduct from KITCHEN
  // (deduction happens via order PREPARING stage in Task 6; this is a manual log).
  // -------------------------------------------------------------------------
  router.post(
    "/inventory/consumption",
    requireAuth,
    requireRole(...ITO_REQUEST_ROLES),
    async (req, res) => {
      const parsed = consumptionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Invalid consumption payload.",
          parsed.error.issues,
        );
        return;
      }

      const logDate = parsed.data.log_date ? new Date(parsed.data.log_date) : new Date();

      // Validate ingredient IDs
      for (const item of parsed.data.items) {
        const [ingredient] = await db
          .select()
          .from(ingredients)
          .where(eq(ingredients.id, item.ingredient_id));
        if (!ingredient) {
          sendError(res, 404, "NOT_FOUND", `Ingredient ${item.ingredient_id} not found.`);
          return;
        }
      }

      // Write log rows (one per line item)
      const logRows = await db
        .insert(consumptionLogs)
        .values(
          parsed.data.items.map((item) => ({
            ingredientId: item.ingredient_id,
            quantity: String(item.quantity),
            logDate,
            loggedBy: req.user!.id,
          })),
        )
        .returning();

      res.status(201).json(logRows);
    },
  );

  // -------------------------------------------------------------------------
  // GET /itos — list Internal Transfer Orders, optionally filter by status
  // -------------------------------------------------------------------------
  router.get("/itos", requireAuth, resolveOutletContext, async (req, res) => {
    const statusParam = req.query.status as string | undefined;
    const locationId = await resolveLocationId(db, req, res, req.query.outlet_id);
    if (!locationId) return;

    if (
      statusParam &&
      !(itoStatusEnum.enumValues as readonly string[]).includes(statusParam)
    ) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `Invalid status. Valid values: ${itoStatusEnum.enumValues.join(", ")}.`,
      );
      return;
    }

    const scopedWarehouses = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.locationId, locationId));
    const scopedWarehouseIds = scopedWarehouses.map((warehouse) => warehouse.id);

    if (scopedWarehouseIds.length === 0) {
      res.json([]);
      return;
    }

    const conditions = [inArray(itos.fromWarehouseId, scopedWarehouseIds)];
    if (statusParam) {
      conditions.push(eq(itos.status, statusParam as typeof itoStatusEnum.enumValues[number]));
    }

    const rows = await db
      .select()
      .from(itos)
      .where(and(...conditions));

    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // POST /itos — request a transfer MAIN → KITCHEN (status REQUESTED)
  // -------------------------------------------------------------------------
  router.post("/itos", requireAuth, requireRole(...ITO_REQUEST_ROLES), resolveOutletContext, async (req, res) => {
    const parsed = createItoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ITO payload.", parsed.error.issues);
      return;
    }

    const locationId = await resolveLocationId(db, req, res, parsed.data.outlet_id);
    if (!locationId) return;

    const fromWarehouse = await getWarehouseByType(parsed.data.from, locationId);
    const toWarehouse = await getWarehouseByType(parsed.data.to, locationId);

    if (!fromWarehouse) {
      sendError(res, 404, "NOT_FOUND", "Source warehouse (MAIN) not found.");
      return;
    }
    if (!toWarehouse) {
      sendError(res, 404, "NOT_FOUND", "Destination warehouse (KITCHEN) not found.");
      return;
    }

    // Validate all ingredient IDs exist
    for (const item of parsed.data.items) {
      const [ingredient] = await db
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, item.ingredient_id));
      if (!ingredient) {
        sendError(res, 404, "NOT_FOUND", `Ingredient ${item.ingredient_id} not found.`);
        return;
      }
    }

    // Create ITO header + line items in a transaction
    let createdIto: typeof itos.$inferSelect | undefined;
    let createdItems: (typeof itoItems.$inferSelect)[] = [];

    await db.transaction(async (tx) => {
      [createdIto] = await tx
        .insert(itos)
        .values({
          fromWarehouseId: fromWarehouse.id,
          toWarehouseId: toWarehouse.id,
          status: "REQUESTED",
          requestedBy: req.user!.id,
        })
        .returning();

      createdItems = await tx
        .insert(itoItems)
        .values(
          parsed.data.items.map((item) => ({
            itoId: createdIto!.id,
            ingredientId: item.ingredient_id,
            quantity: String(item.quantity),
          })),
        )
        .returning();
    });

    res.status(201).json({ ...createdIto!, items: createdItems });
  });

  // -------------------------------------------------------------------------
  // POST /itos/:id/confirm — ATOMIC stock move (Cardinal Rule #4)
  //
  // In ONE Drizzle transaction:
  //   1. For each ITO item: MAIN inventory_stock.quantity -= qty
  //   2. For each ITO item: KITCHEN inventory_stock.quantity += qty (upsert)
  //   3. ITO status → CONFIRMED, confirmedBy, confirmedAt
  //
  // If ANY step throws, the entire transaction rolls back — no partial moves.
  // -------------------------------------------------------------------------
  router.post(
    "/itos/:id/confirm",
    requireAuth,
    requireRole(...INVENTORY_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);

      const [ito] = await db.select().from(itos).where(eq(itos.id, id));
      if (!ito) {
        sendError(res, 404, "NOT_FOUND", "ITO not found.");
        return;
      }

      // H4: membership-check the ITO's own outlet. Both warehouses share one
      // location in this model (POST /itos resolves from/to at the same outlet),
      // so the source warehouse's location is the ITO's outlet. ALL-scope passes;
      // an ASSIGNED caller outside that outlet is 403'd — no cross-outlet stock move.
      const [itoWarehouse] = await db
        .select({ locationId: warehouses.locationId })
        .from(warehouses)
        .where(eq(warehouses.id, ito.fromWarehouseId));
      if (!isOutletInScope(req.outletContext, itoWarehouse?.locationId)) {
        sendError(res, 403, "FORBIDDEN", "ITO is outside your access scope.");
        return;
      }

      if (ito.status !== "REQUESTED") {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          `ITO is already ${ito.status} and cannot be confirmed again.`,
        );
        return;
      }

      // Load ITO line items
      const items = await db.select().from(itoItems).where(eq(itoItems.itoId, id));

      let confirmedIto: typeof itos.$inferSelect | undefined;

      // ATOMIC transaction (Cardinal Rule #4) — all steps succeed or all roll back
      await db.transaction(async (tx) => {
        for (const item of items) {
          // Step 1: decrement MAIN
          await tx
            .update(inventoryStock)
            .set({
              quantity: sql`${inventoryStock.quantity} - ${item.quantity}::numeric`,
            })
            .where(
              and(
                eq(inventoryStock.warehouseId, ito.fromWarehouseId),
                eq(inventoryStock.ingredientId, item.ingredientId),
              ),
            );

          // Step 2: upsert KITCHEN (create row if absent, add if present)
          await tx
            .insert(inventoryStock)
            .values({
              warehouseId: ito.toWarehouseId,
              ingredientId: item.ingredientId,
              quantity: item.quantity, // initial value when row is new
            })
            .onConflictDoUpdate({
              target: [inventoryStock.warehouseId, inventoryStock.ingredientId],
              set: {
                quantity: sql`${inventoryStock.quantity} + EXCLUDED.quantity`,
              },
            });

          // ERP R1: post ITO OUT(MAIN) + IN(KITCHEN) ledger rows
          await postLedger(tx, {
            sourceModule: "ITO",
            sourceDocumentNo: id,
            sourceLineNo: `OUT-${item.ingredientId}`,
            ingredientId: item.ingredientId,
            warehouseId: ito.fromWarehouseId,
            movementType: "OUT",
            quantity: item.quantity,
            encoderUserId: req.user?.id ?? null,
          });

          await postLedger(tx, {
            sourceModule: "ITO",
            sourceDocumentNo: id,
            sourceLineNo: `IN-${item.ingredientId}`,
            ingredientId: item.ingredientId,
            warehouseId: ito.toWarehouseId,
            movementType: "IN",
            quantity: item.quantity,
            encoderUserId: req.user?.id ?? null,
          });
        }

        // Step 3: mark ITO CONFIRMED with audit fields
        [confirmedIto] = await tx
          .update(itos)
          .set({
            status: "CONFIRMED",
            confirmedBy: req.user!.id,
            confirmedAt: new Date(),
          })
          .where(eq(itos.id, id))
          .returning();
      });

      res.json(confirmedIto!);

      // EMS: audit ito.confirm (non-blocking)
      void audit(db, {
        actorUserId: req.user?.id ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "ito.confirm",
        description: `confirmed ITO ${id}`,
        entityType: "ito",
        entityId: id,
        metadata: { itemCount: items.length },
      });

      // Task 8: emit stock.updated for each ingredient moved to KITCHEN
      const [destinationWarehouse] = await db
        .select({ locationId: warehouses.locationId })
        .from(warehouses)
        .where(eq(warehouses.id, ito.toWarehouseId));
      const locationId = destinationWarehouse?.locationId;
      if (locationId) {
        for (const item of items) {
          // Read back the new KITCHEN balance after the transaction
          const [stockRow] = await db
            .select({ quantity: inventoryStock.quantity })
            .from(inventoryStock)
            .where(
              and(
                eq(inventoryStock.warehouseId, ito.toWarehouseId),
                eq(inventoryStock.ingredientId, item.ingredientId),
              ),
            );
          const [ing] = await db
            .select({ name: ingredients.name })
            .from(ingredients)
            .where(eq(ingredients.id, item.ingredientId));

          if (stockRow) {
            hub.emitToLocation(locationId, "stock.updated", {
              ingredientId: item.ingredientId,
              ingredientName: ing?.name ?? item.ingredientId,
              warehouseType: "KITCHEN",
              quantity: Number(stockRow.quantity),
            });
          }
        }
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /stock-ledger — ERP R1 universal ledger query (requireAuth)
  //
  // Query params (all optional):
  //   ingredient_id  — filter by ingredient UUID
  //   warehouse_id   — filter by warehouse UUID
  //   source_module  — filter by source module (RECEIVE|ITO|ORDER_DEDUCTION|…)
  //   from           — ISO timestamp lower bound on posted_at (inclusive)
  //   to             — ISO timestamp upper bound on posted_at (inclusive)
  //   limit          — max rows (default 100)
  //
  // Returns rows newest-first.
  // -------------------------------------------------------------------------
  router.get("/stock-ledger", requireAuth, async (req, res) => {
    const {
      ingredient_id,
      warehouse_id,
      source_module,
      from: fromParam,
      to: toParam,
      limit: limitParam,
    } = req.query as Record<string, string | undefined>;

    const conditions: ReturnType<typeof eq>[] = [];

    if (ingredient_id) {
      conditions.push(eq(stockLedgerEntries.ingredientId, ingredient_id));
    }
    if (warehouse_id) {
      conditions.push(eq(stockLedgerEntries.warehouseId, warehouse_id));
    }
    if (source_module) {
      conditions.push(
        eq(
          stockLedgerEntries.sourceModule,
          source_module as typeof stockLedgerEntries.$inferSelect["sourceModule"],
        ),
      );
    }
    if (fromParam) {
      conditions.push(gte(stockLedgerEntries.postedAt, new Date(fromParam)));
    }
    if (toParam) {
      conditions.push(lte(stockLedgerEntries.postedAt, new Date(toParam)));
    }

    const limit = Math.min(Number(limitParam ?? 100), 500);

    const rows =
      conditions.length > 0
        ? await db
            .select()
            .from(stockLedgerEntries)
            .where(and(...(conditions as Parameters<typeof and>)))
            .orderBy(desc(stockLedgerEntries.postedAt))
            .limit(limit)
        : await db
            .select()
            .from(stockLedgerEntries)
            .orderBy(desc(stockLedgerEntries.postedAt))
            .limit(limit);

    res.json(rows);
  });

  return router;
}
