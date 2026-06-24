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
import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
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
  warehouseTypeEnum,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";

// ---------------------------------------------------------------------------
// RBAC role sets (§1 role matrix)
// ---------------------------------------------------------------------------

const ADMIN_ONLY = ["SUPER_ADMIN"] as const;
const INVENTORY_ROLES = ["SUPER_ADMIN", "WAREHOUSE"] as const; // receive + confirm
const ITO_REQUEST_ROLES = ["SUPER_ADMIN", "KITCHEN_STAFF"] as const; // request + consumption

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
  from: z.literal("MAIN"),
  to: z.literal("KITCHEN"),
  items: z.array(itoItemSchema).min(1),
});

// ---------------------------------------------------------------------------
// Location resolution helper
// ---------------------------------------------------------------------------

/** Fetch the single prototype location id (gracefully returns null if not seeded). */
async function getDefaultLocationId(db: DB): Promise<string | null> {
  const [loc] = await db.select({ id: locations.id }).from(locations);
  return loc?.id ?? null;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createInventoryRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();

  // Helper: look up a warehouse by its type (MAIN | KITCHEN) for this prototype's
  // single-location deployment.
  async function getWarehouseByType(type: typeof warehouseTypeEnum.enumValues[number]) {
    const [warehouse] = await db
      .select()
      .from(warehouses)
      .where(eq(warehouses.type, type));
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
  router.get("/warehouses", requireAuth, async (req, res) => {
    const rows = await db.select().from(warehouses);
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // GET /inventory?warehouse=MAIN|KITCHEN — stock per tier; flags below_threshold
  //
  // Cardinal Rule #8: when qty <= low_stock_threshold the item is flagged.
  // -------------------------------------------------------------------------
  router.get("/inventory", requireAuth, async (req, res) => {
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

    const warehouse = await getWarehouseByType(warehouseParam as "MAIN" | "KITCHEN");
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
    async (req, res) => {
      const parsed = receiveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid receive payload.", parsed.error.issues);
        return;
      }

      const mainWarehouse = await getWarehouseByType("MAIN");
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

      // Upsert each item into MAIN inventory_stock (add to existing qty if row present)
      for (const item of parsed.data.items) {
        await db
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
      }

      res.status(201).json({ ok: true });

      // Task 8: emit stock.updated for each received ingredient (MAIN warehouse)
      const locationId = await getDefaultLocationId(db);
      if (locationId) {
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
            hub.emitToLocation(locationId, "stock.updated", {
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
  router.get("/itos", requireAuth, async (req, res) => {
    const statusParam = req.query.status as string | undefined;

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

    const rows = statusParam
      ? await db
          .select()
          .from(itos)
          .where(eq(itos.status, statusParam as typeof itoStatusEnum.enumValues[number]))
      : await db.select().from(itos);

    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // POST /itos — request a transfer MAIN → KITCHEN (status REQUESTED)
  // -------------------------------------------------------------------------
  router.post("/itos", requireAuth, requireRole(...ITO_REQUEST_ROLES), async (req, res) => {
    const parsed = createItoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ITO payload.", parsed.error.issues);
      return;
    }

    const fromWarehouse = await getWarehouseByType(parsed.data.from);
    const toWarehouse = await getWarehouseByType(parsed.data.to);

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
    async (req, res) => {
      const id = paramAsString(req.params.id);

      const [ito] = await db.select().from(itos).where(eq(itos.id, id));
      if (!ito) {
        sendError(res, 404, "NOT_FOUND", "ITO not found.");
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

      // Task 8: emit stock.updated for each ingredient moved to KITCHEN
      const locationId = await getDefaultLocationId(db);
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

  return router;
}
