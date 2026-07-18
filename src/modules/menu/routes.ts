/**
 * Menu Items & Recipes — CK1-API-003 §5
 *
 * Key endpoints:
 *   GET  /brands/:id/menu          – list a brand's menu items
 *   POST /brands/:id/menu          – create a menu item (SUPER_ADMIN | BRAND_MANAGER)
 *   PATCH /menu/:id                – update fields incl. availability
 *   DELETE /menu/:id               – delete (only when never ordered; else 409 HAS_ORDERS)
 *   GET  /menu/:id/recipe          – list recipe lines
 *   PUT  /menu/:id/recipe          – REPLACE recipe lines (transactional delete+insert)
 *
 * Cardinal Business Rule #3: one ingredient_id shared across brands; each RecipeLine
 * carries its OWN brand-specific portion_qty.
 */
import { Router } from "express";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  availabilityEnum,
  brands,
  discounts,
  ingredients,
  kitchenStations,
  locations,
  menuItems,
  orderItems,
  recipeLines,
} from "../../db/schema.js";
import { menuItemOutlets } from "../../db/enterprise-schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope } from "../auth/outlet-scope.js";
import { audit } from "../ems/audit.js";
import { paramAsString, sendError } from "../http-errors.js";
import { uploadMenuPhoto, ConfigError } from "../ems/cloudinary.js";

const WRITE_ROLES = ["OWNER", "BRAND_MANAGER"] as const;

// MOTM 2026-07-01 fields shared by create + update.
const imageUrlField = z.string().url().startsWith("https://").max(2048);
const itemNoField = z.string().trim().min(1).max(32);
const remarksField = z.string().trim().max(500);

/**
 * Rejects a duplicate product number within the same brand (unique per brand,
 * only when set). `excludeId` skips the row being updated. Returns true if a
 * conflicting row exists.
 */
async function itemNoTaken(
  db: DB,
  brandId: string,
  itemNo: string,
  excludeId?: string,
): Promise<boolean> {
  const conditions = [eq(menuItems.brandId, brandId), eq(menuItems.itemNo, itemNo)];
  if (excludeId) conditions.push(ne(menuItems.id, excludeId));
  const [row] = await db.select({ id: menuItems.id }).from(menuItems).where(and(...conditions));
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createMenuItemSchema = z.object({
  name: z.string().min(1),
  price: z.union([z.string().min(1), z.number()]),
  prep_time_min: z.number().int().positive().optional(),
  station_id: z.string().uuid().optional(),
  availability: z.enum(availabilityEnum.enumValues).optional(),
  image_url: imageUrlField.optional(),
  item_no: itemNoField.optional(),
  remarks: remarksField.optional(),
});

const updateMenuItemSchema = z
  .object({
    name: z.string().min(1).optional(),
    price: z.union([z.string().min(1), z.number()]).optional(),
    prep_time_min: z.number().int().positive().optional(),
    station_id: z.string().uuid().optional(),
    availability: z.enum(availabilityEnum.enumValues).optional(),
    // Nullable so a client can explicitly clear image/item_no/remarks.
    image_url: imageUrlField.nullable().optional(),
    item_no: itemNoField.nullable().optional(),
    remarks: remarksField.nullable().optional(),
  })
  .refine((body) => Object.keys(body).some((k) => body[k as keyof typeof body] !== undefined), {
    message: "At least one field is required.",
  });

const uploadPhotoSchema = z.object({
  data_url: z.string().min(1).startsWith("data:image/"),
});

const recipeLineSchema = z.object({
  ingredient_id: z.string().uuid(),
  portion_qty: z.union([z.string().min(1), z.number()]),
  unit: z.string().min(1),
});

const putRecipeSchema = z.object({
  lines: z.array(recipeLineSchema),
});

const putMenuItemOutletSchema = z.object({
  station_id: z.string().uuid(),
  availability: z.enum(availabilityEnum.enumValues).optional(),
  is_active: z.boolean().optional(),
});

const bulkAvailabilitySchema = z.object({
  availability: z.enum(availabilityEnum.enumValues),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createMenuRouter(db: DB): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /brands/:id/menu — list a brand's menu items
  // -------------------------------------------------------------------------
  router.get("/brands/:id/menu", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);

    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const rows = await db.select().from(menuItems).where(eq(menuItems.brandId, id));
    res.json(rows);
  });

  // -------------------------------------------------------------------------
  // POST /brands/:id/menu — create a menu item
  // -------------------------------------------------------------------------
  router.post("/brands/:id/menu", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);

    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const parsed = createMenuItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid menu item payload.", parsed.error.issues);
      return;
    }

    if (parsed.data.item_no && (await itemNoTaken(db, id, parsed.data.item_no))) {
      sendError(res, 409, "CONFLICT", `Product number "${parsed.data.item_no}" already exists for this brand.`);
      return;
    }

    const [item] = await db
      .insert(menuItems)
      .values({
        brandId: id,
        name: parsed.data.name,
        price: String(parsed.data.price),
        prepTimeMin: parsed.data.prep_time_min,
        stationId: parsed.data.station_id,
        availability: parsed.data.availability ?? "AVAILABLE",
        imageUrl: parsed.data.image_url,
        itemNo: parsed.data.item_no,
        remarks: parsed.data.remarks,
      })
      .returning();

    res.status(201).json(item);
  });

  // -------------------------------------------------------------------------
  // POST /menu/upload-photo — upload a menu item image, returns { url }
  // (MOTM 2026-07-01; mirrors the attendance-photo server-side upload, D17.)
  // -------------------------------------------------------------------------
  router.post("/menu/upload-photo", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = uploadPhotoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "A base64 image data URL is required.", parsed.error.issues);
      return;
    }
    try {
      const { url } = await uploadMenuPhoto(parsed.data.data_url);
      res.status(201).json({ url });
    } catch (err) {
      if (err instanceof ConfigError) {
        sendError(res, 503, "UPLOAD_UNAVAILABLE", "Image upload is not configured.");
        return;
      }
      throw err; // unexpected → global error middleware (generic 500, no leak)
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /menu/:id — update menu item fields (incl. availability toggle)
  // -------------------------------------------------------------------------
  router.patch("/menu/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);

    const [existing] = await db.select().from(menuItems).where(eq(menuItems.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Menu item not found.");
      return;
    }

    const parsed = updateMenuItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid menu item payload.", parsed.error.issues);
      return;
    }

    if (
      parsed.data.item_no != null &&
      (await itemNoTaken(db, existing.brandId, parsed.data.item_no, id))
    ) {
      sendError(res, 409, "CONFLICT", `Product number "${parsed.data.item_no}" already exists for this brand.`);
      return;
    }

    const updates: Partial<typeof menuItems.$inferInsert> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.price !== undefined) updates.price = String(parsed.data.price);
    if (parsed.data.prep_time_min !== undefined) updates.prepTimeMin = parsed.data.prep_time_min;
    if (parsed.data.station_id !== undefined) updates.stationId = parsed.data.station_id;
    if (parsed.data.availability !== undefined) updates.availability = parsed.data.availability;
    if (parsed.data.image_url !== undefined) updates.imageUrl = parsed.data.image_url;
    if (parsed.data.item_no !== undefined) updates.itemNo = parsed.data.item_no;
    if (parsed.data.remarks !== undefined) updates.remarks = parsed.data.remarks;

    const [updated] = await db
      .update(menuItems)
      .set(updates)
      .where(eq(menuItems.id, id))
      .returning();

    res.json(updated);
  });

  // -------------------------------------------------------------------------
  // DELETE /menu/:id — remove a menu item from its brand
  //
  // Hard-deletes ONLY items with no order history: order_item rows must keep
  // referencing what was actually sold (reports/restock/audit depend on it), so
  // an item that appears in any order returns 409 HAS_ORDERS — retire those by
  // setting availability to PAUSED instead. Recipe lines and this item's own
  // promo definitions are removed in the same transaction. A residual FK race
  // (order ingested between the check and the delete) surfaces as the same 409.
  // -------------------------------------------------------------------------
  router.delete("/menu/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);

    const [existing] = await db.select().from(menuItems).where(eq(menuItems.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Menu item not found.");
      return;
    }

    const [referenced] = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.menuItemId, id))
      .limit(1);
    if (referenced) {
      sendError(
        res,
        409,
        "HAS_ORDERS",
        "This item appears in existing orders and cannot be deleted. Set its availability to PAUSED to retire it.",
      );
      return;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.delete(recipeLines).where(eq(recipeLines.menuItemId, id));
        await tx.delete(discounts).where(eq(discounts.menuItemId, id));
        await tx.delete(menuItems).where(eq(menuItems.id, id));
      });
    } catch (err) {
      // FK violation (23503): an order/applied discount grabbed a reference
      // between the pre-check and the delete — same answer as the pre-check.
      const code =
        err && typeof err === "object"
          ? ((err as Record<string, unknown>)["code"] ??
            ((err as { cause?: Record<string, unknown> }).cause?.["code"]))
          : undefined;
      if (code === "23503") {
        sendError(
          res,
          409,
          "HAS_ORDERS",
          "This item is referenced by existing orders/discounts and cannot be deleted. Set its availability to PAUSED instead.",
        );
        return;
      }
      throw err;
    }

    res.status(204).end();

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "menu.delete",
      description: `deleted menu item "${existing.name}" from brand ${existing.brandId}`,
      entityType: "menu_item",
      entityId: id,
      metadata: { brand_id: existing.brandId, name: existing.name },
    });
  });

  // -------------------------------------------------------------------------
  // GET /menu/:id/recipe — list recipe lines for a menu item
  // -------------------------------------------------------------------------
  router.get("/menu/:id/recipe", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);

    const [item] = await db.select().from(menuItems).where(eq(menuItems.id, id));
    if (!item) {
      sendError(res, 404, "NOT_FOUND", "Menu item not found.");
      return;
    }

    const lines = await db
      .select()
      .from(recipeLines)
      .where(eq(recipeLines.menuItemId, id));

    res.json(lines);
  });

  // -------------------------------------------------------------------------
  // PUT /menu/:id/recipe — REPLACE all recipe lines (transactional)
  //
  // Cardinal Rule #3: a single ingredient_id is shared across brands; the
  // portion_qty on each RecipeLine is brand-specific. Teriyaki Chicken may
  // deduct 200 g while Korean Fried Chicken deducts 150 g from ONE pool.
  // -------------------------------------------------------------------------
  router.put("/menu/:id/recipe", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);

    const [item] = await db.select().from(menuItems).where(eq(menuItems.id, id));
    if (!item) {
      sendError(res, 404, "NOT_FOUND", "Menu item not found.");
      return;
    }

    const parsed = putRecipeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid recipe payload.", parsed.error.issues);
      return;
    }

    // Validate every ingredient_id exists before touching the DB
    for (const line of parsed.data.lines) {
      const [ing] = await db
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, line.ingredient_id));
      if (!ing) {
        sendError(
          res,
          404,
          "NOT_FOUND",
          `Ingredient ${line.ingredient_id} not found.`,
        );
        return;
      }
    }

    // Transactional REPLACE: delete existing lines, insert the new set atomically.
    //
    // Double-submit guard: lock the menu item row FOR UPDATE FIRST, before the
    // delete+insert. Without this, two concurrent identical PUTs can each
    // read/plan against a pre-delete snapshot, and under READ COMMITTED the
    // second transaction's DELETE can miss rows the first transaction just
    // inserted after it started — leaving duplicate recipe_line rows for the
    // same ingredient, which silently doubles that ingredient's deduction at
    // order time. The lock serializes the two transactions so the second one
    // always deletes/replaces the first one's committed result.
    let newLines: (typeof recipeLines.$inferSelect)[] = [];

    await db.transaction(async (tx) => {
      await tx.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, id)).for("update");

      await tx.delete(recipeLines).where(eq(recipeLines.menuItemId, id));

      if (parsed.data.lines.length > 0) {
        newLines = await tx
          .insert(recipeLines)
          .values(
            parsed.data.lines.map((line) => ({
              menuItemId: id,
              ingredientId: line.ingredient_id,
              portionQty: String(line.portion_qty),
              unit: line.unit,
            })),
          )
          .returning();
      }
    });

    res.json(newLines);
  });

  // -------------------------------------------------------------------------
  // menu_item_outlet — per-outlet deployment of a global menu item (D30/D39:
  // one brand may operate in several outlets; a menu item needs its own
  // station + availability at EACH outlet, not one global station).
  // -------------------------------------------------------------------------

  // GET /menu/:id/outlets — every outlet this item is deployed to (active + inactive).
  router.get("/menu/:id/outlets", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [item] = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, id));
    if (!item) {
      sendError(res, 404, "NOT_FOUND", "Menu item not found.");
      return;
    }

    const rows = await db
      .select({
        locationId: menuItemOutlets.locationId,
        stationId: menuItemOutlets.stationId,
        availability: menuItemOutlets.availability,
        isActive: menuItemOutlets.isActive,
      })
      .from(menuItemOutlets)
      .where(eq(menuItemOutlets.menuItemId, id));

    res.json(rows);
  });

  // PUT /menu/:id/outlets/:locationId — UPSERT the item's deployment at one
  // outlet. Idempotent by construction: ON CONFLICT on the (menu_item_id,
  // location_id) unique key means re-sending the same PUT never creates a
  // second row, sequential or concurrent (idempotency-concurrency.md 5c).
  router.put(
    "/menu/:id/outlets/:locationId",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER", "BRAND_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const locationId = paramAsString(req.params.locationId);

      const [item] = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, id));
      if (!item) {
        sendError(res, 404, "NOT_FOUND", "Menu item not found.");
        return;
      }

      const [location] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId));
      if (!location) {
        sendError(res, 404, "NOT_FOUND", "Outlet not found.");
        return;
      }

      if (!isOutletInScope(req.outletContext, locationId)) {
        sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
        return;
      }

      const parsed = putMenuItemOutletSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid menu_item_outlet payload.", parsed.error.issues);
        return;
      }

      // The station must belong to THIS outlet — a station from a different
      // outlet would silently mis-route KOTs (business-rules #2/#7).
      const [station] = await db
        .select({ id: kitchenStations.id })
        .from(kitchenStations)
        .where(and(eq(kitchenStations.id, parsed.data.station_id), eq(kitchenStations.locationId, locationId)));
      if (!station) {
        sendError(res, 422, "STATION_NOT_IN_OUTLET", "station_id does not belong to that outlet.");
        return;
      }

      const [row] = await db
        .insert(menuItemOutlets)
        .values({
          menuItemId: id,
          locationId,
          stationId: parsed.data.station_id,
          availability: parsed.data.availability ?? "AVAILABLE",
          isActive: parsed.data.is_active ?? true,
        })
        .onConflictDoUpdate({
          target: [menuItemOutlets.menuItemId, menuItemOutlets.locationId],
          set: {
            stationId: parsed.data.station_id,
            ...(parsed.data.availability !== undefined ? { availability: parsed.data.availability } : {}),
            ...(parsed.data.is_active !== undefined ? { isActive: parsed.data.is_active } : {}),
            updatedAt: new Date(),
          },
        })
        .returning();

      res.status(200).json(row);

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "menu_item_outlet.upsert",
        description: `deployed menu item ${id} to outlet ${locationId} (station ${parsed.data.station_id})`,
        entityType: "menu_item_outlet",
        entityId: row.id,
        metadata: { menu_item_id: id, location_id: locationId, station_id: parsed.data.station_id },
      });
    },
  );

  // DELETE /menu/:id/outlets/:locationId — soft-undeploy (is_active=false).
  // Idempotent: already-inactive or re-deleting returns 200, never re-fires
  // a second business effect.
  router.delete(
    "/menu/:id/outlets/:locationId",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER", "BRAND_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const locationId = paramAsString(req.params.locationId);

      const [item] = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.id, id));
      if (!item) {
        sendError(res, 404, "NOT_FOUND", "Menu item not found.");
        return;
      }

      if (!isOutletInScope(req.outletContext, locationId)) {
        sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
        return;
      }

      const [existing] = await db
        .select()
        .from(menuItemOutlets)
        .where(and(eq(menuItemOutlets.menuItemId, id), eq(menuItemOutlets.locationId, locationId)));
      if (!existing) {
        sendError(res, 404, "NOT_FOUND", "Menu item is not deployed to that outlet.");
        return;
      }

      const [updated] = await db
        .update(menuItemOutlets)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(menuItemOutlets.menuItemId, id), eq(menuItemOutlets.locationId, locationId)))
        .returning();

      res.status(200).json({ ok: true, deployment: updated });

      if (existing.isActive) {
        // Only log a real state flip — mirrors brands/routes.ts's brand_activity_log convention.
        void audit(db, {
          actorUserId: req.user?.id ?? null,
          actorName: req.user?.name ?? null,
          sessionId: req.user?.sessionId ?? null,
          action: "menu_item_outlet.undeploy",
          description: `undeployed menu item ${id} from outlet ${locationId}`,
          entityType: "menu_item_outlet",
          entityId: updated!.id,
          metadata: { menu_item_id: id, location_id: locationId },
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /outlets/:locationId/menu-availability — bulk-set availability for
  // every ACTIVE menu_item_outlet row at one outlet (one UPDATE; idempotent
  // by nature, same convention as POST /brands/:id/availability).
  // -------------------------------------------------------------------------
  router.post(
    "/outlets/:locationId/menu-availability",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const locationId = paramAsString(req.params.locationId);

      const [location] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId));
      if (!location) {
        sendError(res, 404, "NOT_FOUND", "Outlet not found.");
        return;
      }

      if (!isOutletInScope(req.outletContext, locationId)) {
        sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
        return;
      }

      const parsed = bulkAvailabilitySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid availability payload.", parsed.error.issues);
        return;
      }

      const updated = await db
        .update(menuItemOutlets)
        .set({ availability: parsed.data.availability, updatedAt: new Date() })
        .where(and(eq(menuItemOutlets.locationId, locationId), eq(menuItemOutlets.isActive, true)))
        .returning({ id: menuItemOutlets.id });

      res.json({ updated: updated.length });

      void audit(db, {
        actorUserId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        sessionId: req.user?.sessionId ?? null,
        action: "menu_item_outlet.bulk_availability",
        description: `set availability=${parsed.data.availability} on ${updated.length} menu item(s) at outlet ${locationId}`,
        entityType: "location",
        entityId: locationId,
        metadata: { availability: parsed.data.availability, updated: updated.length },
      });
    },
  );

  return router;
}
