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
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
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
  orders,
  receivingReportLines,
  receivingReports,
  stockLedgerEntries,
  stockReservations,
  supplierItems,
  suppliers,
  warehouseTypeEnum,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { audit } from "../ems/audit.js";
import { docNo } from "../purchasing/doc-no.js";
import { postLedger } from "./ledger.js";
import { findDuplicateReceivingReport } from "./receive-dedupe.js";

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
  // Optional supplier affiliation created atomically with the ingredient (ERP R2).
  supplier_id: z.string().uuid().optional(),
  supplier_sku: z.string().max(64).optional(),
});

// PATCH /ingredients/:id — every field optional, but at least one required.
const patchIngredientSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    unit: z.string().min(1).max(16).optional(),
    unit_cost: z.number().positive().optional(),
    low_stock_threshold: z.number().min(0).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

// PUT /ingredients/:id/suppliers — upsert a (supplier, ingredient) affiliation.
const linkSupplierSchema = z.object({
  supplier_id: z.string().uuid(),
  supplier_sku: z.string().max(64).optional(),
  last_unit_cost: z.number().min(0).optional(),
});

const receiveItemSchema = z.object({
  ingredient_id: z.string().uuid(),
  quantity: z.union([z.string().min(1), z.number()]),
  // 0024: actual unit price paid on this delivery line (gprci RR standard).
  unit_cost: z.number().min(0).optional(),
});

// 0024: a direct receive is a PROPER Receiving Report (po_id NULL). All new
// fields are optional so legacy minimal bodies keep working unchanged.
const receiveSchema = z.object({
  outlet_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  /** Supplier's DR / invoice number. */
  reference: z.string().max(64).optional(),
  notes: z.string().max(500).optional(),
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
  //
  // Each row is enriched with `suppliers: [{ supplierId, name, code }]` (empty
  // array when none) so lists can show affiliations without N+1 calls. The
  // affiliations come from ONE grouped join query (not a per-row lookup).
  // -------------------------------------------------------------------------
  router.get("/ingredients", requireAuth, async (req, res) => {
    const rows = await db.select().from(ingredients);

    const affiliations = await db
      .select({
        ingredientId: supplierItems.ingredientId,
        supplierId: suppliers.id,
        name: suppliers.name,
        code: suppliers.code,
      })
      .from(supplierItems)
      .innerJoin(suppliers, eq(supplierItems.supplierId, suppliers.id));

    const byIngredient = new Map<
      string,
      { supplierId: string; name: string; code: string }[]
    >();
    for (const a of affiliations) {
      const list = byIngredient.get(a.ingredientId) ?? [];
      list.push({ supplierId: a.supplierId, name: a.name, code: a.code });
      byIngredient.set(a.ingredientId, list);
    }

    res.json(rows.map((row) => ({ ...row, suppliers: byIngredient.get(row.id) ?? [] })));
  });

  // -------------------------------------------------------------------------
  // POST /ingredients — create ingredient (SUPER_ADMIN only)
  //
  // Non-breaking extension: an optional `supplier_id` (+ `supplier_sku`) creates
  // the supplier_item affiliation in the SAME transaction as the ingredient, with
  // last_unit_cost defaulting to the ingredient's unit_cost. Callers without
  // supplier_id are unchanged.
  // -------------------------------------------------------------------------
  router.post("/ingredients", requireAuth, requireRole(...ADMIN_ONLY), async (req, res) => {
    const parsed = createIngredientSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ingredient payload.", parsed.error.issues);
      return;
    }

    // Validate the supplier BEFORE opening the transaction so an unknown supplier
    // never creates an ingredient (atomicity of the whole request).
    if (parsed.data.supplier_id) {
      const [supplier] = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, parsed.data.supplier_id));
      if (!supplier) {
        sendError(res, 404, "NOT_FOUND", "Supplier not found.");
        return;
      }
    }

    const ingredient = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(ingredients)
        .values({
          name: parsed.data.name,
          unit: parsed.data.unit,
          unitCost: String(parsed.data.unit_cost),
          lowStockThreshold: String(parsed.data.low_stock_threshold),
        })
        .returning();

      if (parsed.data.supplier_id) {
        await tx.insert(supplierItems).values({
          supplierId: parsed.data.supplier_id,
          ingredientId: created!.id,
          supplierSku: parsed.data.supplier_sku ?? null,
          lastUnitCost: String(parsed.data.unit_cost),
        });
      }

      return created!;
    });

    res.status(201).json(ingredient);
  });

  // -------------------------------------------------------------------------
  // PATCH /ingredients/:id — edit ingredient master fields (SUPER_ADMIN only)
  //
  // All fields optional, at least one required. Threshold edits flow straight
  // into the below_threshold / lowstock logic because those read the column.
  // Audit `ingredient.update` records the changed fields as old→new pairs.
  // -------------------------------------------------------------------------
  router.patch("/ingredients/:id", requireAuth, requireRole(...ADMIN_ONLY), async (req, res) => {
    const parsed = patchIngredientSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ingredient payload.", parsed.error.issues);
      return;
    }

    const id = paramAsString(req.params.id);
    const [existing] = await db.select().from(ingredients).where(eq(ingredients.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Ingredient not found.");
      return;
    }

    const updates: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (parsed.data.name !== undefined) {
      updates.name = parsed.data.name;
      changes.name = { from: existing.name, to: parsed.data.name };
    }
    if (parsed.data.unit !== undefined) {
      updates.unit = parsed.data.unit;
      changes.unit = { from: existing.unit, to: parsed.data.unit };
    }
    if (parsed.data.unit_cost !== undefined) {
      const next = String(parsed.data.unit_cost);
      updates.unitCost = next;
      changes.unit_cost = { from: existing.unitCost, to: next };
    }
    if (parsed.data.low_stock_threshold !== undefined) {
      const next = String(parsed.data.low_stock_threshold);
      updates.lowStockThreshold = next;
      changes.low_stock_threshold = { from: existing.lowStockThreshold, to: next };
    }

    const [updated] = await db
      .update(ingredients)
      .set(updates)
      .where(eq(ingredients.id, id))
      .returning();

    res.json(updated);

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "ingredient.update",
      description: `updated ingredient "${existing.name}"`,
      entityType: "ingredient",
      entityId: id,
      metadata: { changes },
    });
  });

  // -------------------------------------------------------------------------
  // GET /ingredients/:id/suppliers — affiliations for one ingredient
  // (any authenticated). ONE join query; supplier summary inline.
  // -------------------------------------------------------------------------
  router.get("/ingredients/:id/suppliers", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const rows = await db
      .select({
        id: supplierItems.id,
        supplierId: supplierItems.supplierId,
        ingredientId: supplierItems.ingredientId,
        supplierSku: supplierItems.supplierSku,
        lastUnitCost: supplierItems.lastUnitCost,
        supplier: {
          id: suppliers.id,
          code: suppliers.code,
          name: suppliers.name,
          isActive: suppliers.isActive,
        },
      })
      .from(supplierItems)
      .innerJoin(suppliers, eq(supplierItems.supplierId, suppliers.id))
      .where(eq(supplierItems.ingredientId, id));
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // PUT /ingredients/:id/suppliers — upsert a supplier affiliation (ADMIN only)
  //
  // Idempotent on the (supplier, ingredient) unique index: a re-PUT updates the
  // supplied sku/cost in place instead of creating a duplicate row. Fields not
  // present in the body keep their existing value on conflict.
  // -------------------------------------------------------------------------
  router.put("/ingredients/:id/suppliers", requireAuth, requireRole(...ADMIN_ONLY), async (req, res) => {
    const parsed = linkSupplierSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid supplier link payload.", parsed.error.issues);
      return;
    }

    const id = paramAsString(req.params.id);
    const [ingredient] = await db.select().from(ingredients).where(eq(ingredients.id, id));
    if (!ingredient) {
      sendError(res, 404, "NOT_FOUND", "Ingredient not found.");
      return;
    }
    const [supplier] = await db
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, parsed.data.supplier_id));
    if (!supplier) {
      sendError(res, 404, "NOT_FOUND", "Supplier not found.");
      return;
    }

    const [row] = await db
      .insert(supplierItems)
      .values({
        supplierId: parsed.data.supplier_id,
        ingredientId: id,
        supplierSku: parsed.data.supplier_sku ?? null,
        lastUnitCost:
          parsed.data.last_unit_cost !== undefined ? String(parsed.data.last_unit_cost) : "0",
      })
      .onConflictDoUpdate({
        target: [supplierItems.supplierId, supplierItems.ingredientId],
        set: {
          // Keep the existing value when the caller omits the field.
          supplierSku:
            parsed.data.supplier_sku !== undefined
              ? parsed.data.supplier_sku
              : sql`${supplierItems.supplierSku}`,
          lastUnitCost:
            parsed.data.last_unit_cost !== undefined
              ? String(parsed.data.last_unit_cost)
              : sql`${supplierItems.lastUnitCost}`,
        },
      })
      .returning();

    res.json(row);

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "ingredient.supplier_link",
      description: `linked supplier ${supplier.code} to ingredient "${ingredient.name}"`,
      entityType: "ingredient",
      entityId: id,
      metadata: {
        supplierId: supplier.id,
        supplierSku: row!.supplierSku,
        lastUnitCost: row!.lastUnitCost,
      },
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /ingredients/:id/suppliers/:supplierId — unlink (ADMIN only)
  // 204 on success; 404 when no affiliation exists.
  // -------------------------------------------------------------------------
  router.delete(
    "/ingredients/:id/suppliers/:supplierId",
    requireAuth,
    requireRole(...ADMIN_ONLY),
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const supplierId = paramAsString(req.params.supplierId);

      const [existing] = await db
        .select()
        .from(supplierItems)
        .where(
          and(
            eq(supplierItems.ingredientId, id),
            eq(supplierItems.supplierId, supplierId),
          ),
        );
      if (!existing) {
        sendError(res, 404, "NOT_FOUND", "Supplier affiliation not found.");
        return;
      }

      await db.delete(supplierItems).where(eq(supplierItems.id, existing.id));

      res.status(204).end();

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "ingredient.supplier_unlink",
        description: `unlinked supplier ${supplierId} from ingredient ${id}`,
        entityType: "ingredient",
        entityId: id,
        metadata: { supplierId },
      });
    },
  );

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
  //
  // Per row the response also carries (all additive — earlier fields unchanged):
  //   reserved / available          — S4 soft-hold math (see below)
  //   daily_consumption_7d (number) — avg qty/day consumed by order deductions
  //                                   over the trailing 7 days (2dp)
  //   days_remaining (number|null)  — available ÷ daily_consumption_7d (1dp),
  //                                   0 when available <= 0, null when there
  //                                   was no consumption in the window
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

    // S4 — per-row `reserved` (SUM of active stock_reservation holds for this
    // warehouse+ingredient) and `available` (quantity − reserved). ONE grouped
    // aggregate query for the whole warehouse — not per-row lookups. Existing
    // fields are untouched; rows without holds get reserved=0.
    const reservedRows = await db
      .select({
        ingredientId: stockReservations.ingredientId,
        reserved: sql<string>`COALESCE(SUM(${stockReservations.quantity}), 0)`,
      })
      .from(stockReservations)
      .where(eq(stockReservations.warehouseId, warehouse.id))
      .groupBy(stockReservations.ingredientId);
    const reservedByIngredient = new Map(
      reservedRows.map((r) => [r.ingredientId, Number(r.reserved)]),
    );

    // Depletion projection ("how long will stock survive?") — per-row
    // `daily_consumption_7d` + `days_remaining`, derived from the universal
    // stock ledger. ONE grouped aggregate query for the whole warehouse
    // (GROUP BY ingredient_id), same pattern as the reservations query above:
    //   consumed_7d = SUM(quantity) of OUT / ORDER_DEDUCTION ledger rows for
    //                 this warehouse posted in the last 7 days
    //   daily_consumption_7d = round(consumed_7d / 7, 2dp)
    //   days_remaining = round(available / daily_consumption_7d, 1dp)
    //                    (0 when available <= 0 — never negative;
    //                     null when the rate is 0 — "no recent consumption")
    // Only real order deductions count as consumption: RECEIVE/ITO/ADJUSTMENT/
    // RESTOCK movements are stock LOGISTICS, not kitchen usage.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const consumptionRows = await db
      .select({
        ingredientId: stockLedgerEntries.ingredientId,
        consumed: sql<string>`COALESCE(SUM(${stockLedgerEntries.quantity}), 0)`,
      })
      .from(stockLedgerEntries)
      .where(
        and(
          eq(stockLedgerEntries.warehouseId, warehouse.id),
          eq(stockLedgerEntries.movementType, "OUT"),
          eq(stockLedgerEntries.sourceModule, "ORDER_DEDUCTION"),
          gte(stockLedgerEntries.postedAt, sevenDaysAgo),
        ),
      )
      .groupBy(stockLedgerEntries.ingredientId);
    const consumedByIngredient = new Map(
      consumptionRows.map((r) => [r.ingredientId, Number(r.consumed)]),
    );

    res.json(
      rows.map((row) => {
        const reserved = reservedByIngredient.get(row.ingredientId) ?? 0;
        const available = Number(row.quantity) - reserved;
        const consumed7d = consumedByIngredient.get(row.ingredientId) ?? 0;
        const dailyConsumption = Math.round((consumed7d / 7) * 100) / 100;
        let daysRemaining: number | null = null;
        if (dailyConsumption > 0) {
          // Clamp at 0: already-empty (or oversold/over-reserved) stock has
          // zero days left, never a negative projection.
          daysRemaining =
            available <= 0 ? 0 : Math.round((available / dailyConsumption) * 10) / 10;
        }
        return {
          ...row,
          reserved,
          available,
          daily_consumption_7d: dailyConsumption,
          days_remaining: daysRemaining,
        };
      }),
    );
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

      // 0024: validate the supplier (when given) before touching stock.
      if (parsed.data.supplier_id) {
        const [supplier] = await db
          .select({ id: suppliers.id })
          .from(suppliers)
          .where(eq(suppliers.id, parsed.data.supplier_id));
        if (!supplier) {
          sendError(res, 404, "NOT_FOUND", `Supplier ${parsed.data.supplier_id} not found.`);
          return;
        }
      }

      // 0024 (gprci RR standard): a direct receive produces a PROPER Receiving
      // Report — same `RR-…` series as the PO-receive path, po_id NULL. Stock
      // upserts, the RR + its lines, RECEIVE ledger rows, and the supplier_item
      // cost upsert all commit in ONE transaction. sourceDocumentNo = rrNo,
      // matching exactly what POST /purchase-orders/:id/receive stamps, so the
      // ledger's RR enrichment (GET /stock-ledger source_ref) covers both paths.
      const rrNo = docNo("RR");
      let rr!: typeof receivingReports.$inferSelect;
      let replay = false;

      await db.transaction(async (tx) => {
        // Double-submit guard: lock the destination warehouse row FOR UPDATE
        // FIRST so a truly concurrent duplicate request serializes behind
        // this one instead of racing it, then check whether the same actor
        // already created an identical RR (same warehouse/supplier/
        // reference + exact same ingredient/quantity lines) in the last
        // DUPLICATE_LOOKBACK_MS — rrNo is fresh-random per call so it cannot
        // dedupe this on its own. See receive-dedupe.ts for the full
        // rationale.
        await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.id, mainWarehouse.id)).for("update");

        const duplicateId = await findDuplicateReceivingReport(
          tx,
          { poId: null, warehouseId: mainWarehouse.id, supplierId: parsed.data.supplier_id ?? null, reference: parsed.data.reference ?? null },
          req.user!.id,
          parsed.data.items.map((item) => ({ key: item.ingredient_id, quantity: item.quantity })),
        );
        if (duplicateId) {
          const [existing] = await tx.select().from(receivingReports).where(eq(receivingReports.id, duplicateId));
          rr = existing!;
          replay = true;
          return;
        }

        [rr] = await tx
          .insert(receivingReports)
          .values({
            rrNo,
            poId: null, // direct receipt — no purchase order behind it
            supplierId: parsed.data.supplier_id ?? null,
            reference: parsed.data.reference ?? null,
            warehouseId: mainWarehouse.id,
            receivedByUserId: req.user!.id,
            notes: parsed.data.notes ?? null,
          })
          .returning();

        for (const item of parsed.data.items) {
          await tx.insert(receivingReportLines).values({
            rrId: rr.id,
            poLineId: null, // direct-receipt line — no purchase_order_line
            ingredientId: item.ingredient_id,
            qtyReceived: String(item.quantity),
          });

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
            sourceDocumentNo: rrNo,
            sourceLineNo: item.ingredient_id,
            ingredientId: item.ingredient_id,
            warehouseId: mainWarehouse.id,
            movementType: "IN",
            quantity: item.quantity,
            unitCost: item.unit_cost,
            encoderUserId: req.user?.id ?? null,
          });

          // Costs track reality (same rule as the PO-receive path): receiving
          // from a supplier is evidence of affiliation, and the price actually
          // paid is the freshest cost signal — upsert supplier_item.last_unit_cost.
          // Only when a cost was actually given: upserting without one would
          // clobber a real last_unit_cost with 0. supplier_sku is left alone
          // (null on first insert, untouched on update).
          if (parsed.data.supplier_id && item.unit_cost != null) {
            await tx
              .insert(supplierItems)
              .values({
                supplierId: parsed.data.supplier_id,
                ingredientId: item.ingredient_id,
                lastUnitCost: String(item.unit_cost),
              })
              .onConflictDoUpdate({
                target: [supplierItems.supplierId, supplierItems.ingredientId],
                set: { lastUnitCost: String(item.unit_cost) },
              });
          }
        }
      });

      // Every existing field kept; `rr` is additive (0024). A replay (duplicate
      // submission) still returns 201 with the ORIGINAL rr — same response
      // shape the client already expects, no contract change, but stock/ledger
      // were not touched a second time.
      res.status(201).json({ ok: true, rr: { id: rr.id, rrNo: rr.rrNo } });

      if (replay) return;

      // EMS: audit inventory.receive (non-blocking)
      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "inventory.receive",
        description: `received ${parsed.data.items.length} ingredient(s) into MAIN warehouse → ${rr.rrNo}`,
        entityType: "receiving_report",
        entityId: rr.id,
        metadata: { items: parsed.data.items, rr_no: rr.rrNo },
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
      let conflict = false;

      // ATOMIC transaction (Cardinal Rule #4) — all steps succeed or all roll back
      //
      // Double-submit guard: the REQUESTED status check above is only a fast-path
      // 400 (read outside any transaction, so two concurrent confirms can both
      // pass it). The mutation that actually matters is this conditional UPDATE,
      // done FIRST inside the transaction with `AND status = 'REQUESTED'` — only
      // the request that wins this compare-and-swap proceeds to move stock.
      // A losing concurrent/replayed request gets `updatedRows.length === 0` and
      // the transaction returns without touching inventory_stock at all (mirrors
      // the FIX A pattern in adjustments.ts's approve/reject handlers).
      await db.transaction(async (tx) => {
        const updatedRows = await tx
          .update(itos)
          .set({
            status: "CONFIRMED",
            confirmedBy: req.user!.id,
            confirmedAt: new Date(),
          })
          .where(and(eq(itos.id, id), eq(itos.status, "REQUESTED")))
          .returning();

        if (updatedRows.length === 0) {
          conflict = true;
          return;
        }
        confirmedIto = updatedRows[0];

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
        // Status was already flipped to CONFIRMED by the compare-and-swap
        // UPDATE above (before this loop) — that row IS confirmedIto.
      });

      if (conflict) {
        sendError(res, 409, "CONFLICT", "ITO was already confirmed by a concurrent request and cannot be confirmed again.");
        return;
      }

      res.json(confirmedIto!);

      // EMS: audit ito.confirm (non-blocking)
      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
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
  //   q              — case-insensitive search across ingredient name,
  //                    source_ref, and source_document_no (client review
  //                    2026-07-08: "search the ledger by order code")
  //
  // Returns rows newest-first. Each row is the raw ledger row PLUS
  // `source_ref: string | null` — the human-readable document reference:
  //   ORDER_DEDUCTION / RESTOCK → the order's copyable order_code
  //                               (fallback: its external_ref)
  //   RECEIVE                   → the receiving report's rr_no (both the
  //                               PO-receive and direct-receive paths stamp
  //                               sourceDocumentNo = rr_no; legacy RECV-…
  //                               rows resolve to null)
  //   ADJUSTMENT / ITO          → null (the raw doc id column remains)
  // Lookups are BATCHED: ids are collected per module and resolved with one
  // query each — never per-row (no N+1).
  // -------------------------------------------------------------------------
  router.get("/stock-ledger", requireAuth, async (req, res) => {
    const {
      ingredient_id,
      warehouse_id,
      source_module,
      from: fromParam,
      to: toParam,
      limit: limitParam,
      q: qParam,
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
    const q = qParam?.trim().toLowerCase() || undefined;

    // q filters AFTER enrichment (source_ref lives app-side, not in SQL), so
    // when searching we widen the scan window to the endpoint's 500-row cap and
    // slice back down to `limit` after filtering. Existing filters/pagination
    // behavior without q is byte-for-byte unchanged.
    const scanLimit = q ? 500 : limit;

    const rows =
      conditions.length > 0
        ? await db
            .select()
            .from(stockLedgerEntries)
            .where(and(...(conditions as Parameters<typeof and>)))
            .orderBy(desc(stockLedgerEntries.postedAt))
            .limit(scanLimit)
        : await db
            .select()
            .from(stockLedgerEntries)
            .orderBy(desc(stockLedgerEntries.postedAt))
            .limit(scanLimit);

    // ── source_ref enrichment (batched, one lookup query per module) ────────
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // ORDER_DEDUCTION / RESTOCK stamp sourceDocumentNo = the order's uuid.
    const orderDocIds = [
      ...new Set(
        rows
          .filter(
            (r) =>
              (r.sourceModule === "ORDER_DEDUCTION" || r.sourceModule === "RESTOCK") &&
              UUID_RE.test(r.sourceDocumentNo),
          )
          .map((r) => r.sourceDocumentNo),
      ),
    ];
    const orderRefByDoc = new Map<string, string | null>();
    if (orderDocIds.length > 0) {
      const orderRows = await db
        .select({ id: orders.id, order_code: orders.order_code, externalRef: orders.externalRef })
        .from(orders)
        .where(inArray(orders.id, orderDocIds));
      for (const o of orderRows) {
        orderRefByDoc.set(o.id, o.order_code ?? o.externalRef ?? null);
      }
    }

    // RECEIVE stamps sourceDocumentNo = rr_no (PO + direct paths). Older data
    // may carry the RR's uuid instead — match both in ONE query. Legacy
    // RECV-… doc refs match neither and stay null.
    const receiveDocNos = [
      ...new Set(rows.filter((r) => r.sourceModule === "RECEIVE").map((r) => r.sourceDocumentNo)),
    ];
    const rrRefByDoc = new Map<string, string>();
    if (receiveDocNos.length > 0) {
      const receiveDocUuids = receiveDocNos.filter((d) => UUID_RE.test(d));
      const rrRows = await db
        .select({ id: receivingReports.id, rrNo: receivingReports.rrNo })
        .from(receivingReports)
        .where(
          receiveDocUuids.length > 0
            ? or(
                inArray(receivingReports.rrNo, receiveDocNos),
                inArray(receivingReports.id, receiveDocUuids),
              )
            : inArray(receivingReports.rrNo, receiveDocNos),
        );
      for (const r of rrRows) {
        rrRefByDoc.set(r.rrNo, r.rrNo);
        rrRefByDoc.set(r.id, r.rrNo);
      }
    }

    // Ingredient names — needed only to serve q searches; ONE batched query.
    const nameByIngredient = new Map<string, string>();
    if (q && rows.length > 0) {
      const ingredientIds = [...new Set(rows.map((r) => r.ingredientId))];
      const ingRows = await db
        .select({ id: ingredients.id, name: ingredients.name })
        .from(ingredients)
        .where(inArray(ingredients.id, ingredientIds));
      for (const i of ingRows) nameByIngredient.set(i.id, i.name);
    }

    let enriched = rows.map((row) => {
      let sourceRef: string | null = null;
      if (row.sourceModule === "ORDER_DEDUCTION" || row.sourceModule === "RESTOCK") {
        sourceRef = orderRefByDoc.get(row.sourceDocumentNo) ?? null;
      } else if (row.sourceModule === "RECEIVE") {
        sourceRef = rrRefByDoc.get(row.sourceDocumentNo) ?? null;
      }
      // ADJUSTMENT / ITO: null on purpose — the raw doc id column remains.
      return { ...row, source_ref: sourceRef };
    });

    if (q) {
      enriched = enriched
        .filter((row) =>
          [nameByIngredient.get(row.ingredientId), row.source_ref, row.sourceDocumentNo].some(
            (v) => v != null && v.toLowerCase().includes(q),
          ),
        )
        .slice(0, limit);
    }

    res.json(enriched);
  });

  return router;
}
