/**
 * Menu Items & Recipes — CK1-API-003 §5
 *
 * Key endpoints:
 *   GET  /brands/:id/menu          – list a brand's menu items
 *   POST /brands/:id/menu          – create a menu item (SUPER_ADMIN | BRAND_MANAGER)
 *   PATCH /menu/:id                – update fields incl. availability
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
  ingredients,
  menuItems,
  recipeLines,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
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

    // Transactional REPLACE: delete existing lines, insert the new set atomically
    let newLines: (typeof recipeLines.$inferSelect)[] = [];

    await db.transaction(async (tx) => {
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

  return router;
}
