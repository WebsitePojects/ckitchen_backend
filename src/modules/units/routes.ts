/**
 * Units of measure API (mounted under /api/v1), D57.
 *
 *   GET /units                    the standard catalogue (kinds, codes, labels)
 *   GET /ingredients/:id/units    every unit a quantity of that ingredient may be typed in
 *   PUT /ingredients/:id/units    OWNER: replace the ingredient's custom units
 *                                 { custom: [{ name: "sack", amount: 25, unit: "kg" }] }
 *                                 absolute state, so a repeated save is a no-op
 */
import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { itemUomConversions } from "../../db/enterprise-schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { audit } from "../ems/audit.js";
import { isUuid, paramAsString, sendError } from "../http-errors.js";
import { CUSTOM_UNIT_RE, QuantityError, STANDARD_UNITS, standardUnitCode } from "./catalog.js";
import { loadIngredientUnits, toStockQuantity, unitChoices } from "./service.js";

const putUnitsSchema = z.object({
  custom: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(24),
        amount: z.union([z.string().min(1).max(40), z.number().positive()]),
        unit: z.string().trim().min(1).max(24),
      }),
    )
    .max(20),
});

export function createUnitsRouter(db: DB): Router {
  const router = Router();

  router.get("/units", requireAuth, (_req, res) => {
    res.json(STANDARD_UNITS);
  });

  router.get("/ingredients/:id/units", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const units = isUuid(id) ? (await loadIngredientUnits(db, [id])).get(id) : undefined;
    if (!units) {
      sendError(res, 404, "NOT_FOUND", "Ingredient not found.");
      return;
    }
    res.json({ stockUnit: units.stockUnit, choices: unitChoices(units), custom: units.custom });
  });

  router.put("/ingredients/:id/units", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = putUnitsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid units.", parsed.error.issues);
      return;
    }
    const units = isUuid(id) ? (await loadIngredientUnits(db, [id])).get(id) : undefined;
    if (!units) {
      sendError(res, 404, "NOT_FOUND", "Ingredient not found.");
      return;
    }

    // Validate everything first; a custom unit's size is converted from what was typed
    // ("25 kg", "25000 g") into stock units, against the standard units only.
    const base = { ...units, custom: [] };
    const seen = new Set<string>();
    const rows: { name: string; toStock: string }[] = [];
    try {
      for (const entry of parsed.data.custom) {
        const name = entry.name.trim();
        if (!CUSTOM_UNIT_RE.test(name)) throw new QuantityError(`"${name}" is not a valid unit name.`);
        if (standardUnitCode(name)) throw new QuantityError(`"${name}" is already a standard unit; it converts automatically.`);
        if (name.toLowerCase() === units.stockUnit.toLowerCase()) throw new QuantityError(`"${name}" is the stock unit itself.`);
        if (seen.has(name.toLowerCase())) throw new QuantityError(`"${name}" is listed twice.`);
        seen.add(name.toLowerCase());
        const { stockQuantity } = toStockQuantity(base, entry.amount, entry.unit);
        if (!(Number(stockQuantity) > 0)) throw new QuantityError(`1 ${name} must be more than zero ${units.stockUnit}.`);
        rows.push({ name, toStock: stockQuantity });
      }
    } catch (err) {
      if (err instanceof QuantityError) {
        sendError(res, 400, "VALIDATION_ERROR", err.message);
        return;
      }
      throw err;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(itemUomConversions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(itemUomConversions.itemId, id), eq(itemUomConversions.isActive, true)));
      for (const row of rows) {
        await tx
          .insert(itemUomConversions)
          .values({ itemId: id, fromUom: row.name, toBaseFactor: row.toStock, isActive: true })
          .onConflictDoUpdate({
            target: [itemUomConversions.itemId, itemUomConversions.fromUom],
            set: { toBaseFactor: row.toStock, isActive: true, updatedAt: sql`now()` },
          });
      }
    });

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "ingredient.units",
      description: `Set the units of "${units.ingredientName}": ${rows.map((r) => `1 ${r.name} = ${r.toStock} ${units.stockUnit}`).join(", ") || "none"}`,
      entityType: "ingredient",
      entityId: id,
    });
    const fresh = (await loadIngredientUnits(db, [id])).get(id)!;
    res.json({ stockUnit: fresh.stockUnit, choices: unitChoices(fresh), custom: fresh.custom });
  });

  return router;
}
