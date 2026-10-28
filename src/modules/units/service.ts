/**
 * Converting what people type into what the system stores (D57).
 *
 * An ingredient is stocked in ingredient.unit. A typed quantity may be in:
 *   - the stock unit itself;
 *   - any standard unit of the same kind (250 g for an ingredient stocked in kg);
 *   - a custom unit of THAT ingredient (item_uom_conversion: "1 sack = 25 kg"), whose factor
 *     is stored in stock units.
 * Anything else is refused with a message naming both units: guessing would put the wrong
 * amount into stock.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Response } from "express";
import type { DB } from "../../db/client.js";
import { ingredients } from "../../db/schema.js";
import { itemUomConversions } from "../../db/enterprise-schema.js";
import {
  CUSTOM_UNIT_RE,
  QuantityError,
  STANDARD_UNITS,
  normalizeQuantity,
  scaleQuantity,
  standardUnit,
  standardUnitCode,
} from "./catalog.js";

export interface CustomUnit {
  name: string;
  /** Stock units in ONE of this unit (e.g. 25 for "sack" on an ingredient stocked in kg). */
  toStock: string;
}

export interface IngredientUnits {
  ingredientId: string;
  ingredientName: string;
  stockUnit: string;
  custom: CustomUnit[];
}

/** Every unit a quantity of this ingredient may be typed in, stock unit first. */
export function unitChoices(units: IngredientUnits): { code: string; label: string; kind: "stock" | "standard" | "custom"; toStock: string }[] {
  const choices: { code: string; label: string; kind: "stock" | "standard" | "custom"; toStock: string }[] = [];
  const stock = standardUnit(units.stockUnit);
  choices.push({ code: units.stockUnit, label: stock?.label ?? units.stockUnit, kind: "stock", toStock: "1" });
  if (stock) {
    for (const unit of STANDARD_UNITS) {
      if (unit.dimension !== stock.dimension || unit.code === stock.code) continue;
      choices.push({ code: unit.code, label: unit.label, kind: "standard", toStock: scaleQuantity("1", unit.base, stock.base, 12) });
    }
  }
  for (const custom of units.custom) choices.push({ code: custom.name, label: custom.name, kind: "custom", toStock: custom.toStock });
  return choices;
}

/** Loads stock unit + active custom units for many ingredients in two queries (no N+1). */
export async function loadIngredientUnits(db: DB, ingredientIds: string[]): Promise<Map<string, IngredientUnits>> {
  const ids = [...new Set(ingredientIds)];
  const result = new Map<string, IngredientUnits>();
  if (ids.length === 0) return result;
  const [rows, conversions] = await Promise.all([
    db.select({ id: ingredients.id, name: ingredients.name, unit: ingredients.unit }).from(ingredients).where(inArray(ingredients.id, ids)),
    db
      .select({ itemId: itemUomConversions.itemId, fromUom: itemUomConversions.fromUom, toBaseFactor: itemUomConversions.toBaseFactor })
      .from(itemUomConversions)
      .where(and(inArray(itemUomConversions.itemId, ids), eq(itemUomConversions.isActive, true))),
  ]);
  for (const row of rows) result.set(row.id, { ingredientId: row.id, ingredientName: row.name, stockUnit: row.unit, custom: [] });
  for (const c of conversions) result.get(c.itemId)?.custom.push({ name: c.fromUom, toStock: c.toBaseFactor });
  return result;
}

function sameUnit(a: string, b: string): boolean {
  const ca = standardUnitCode(a);
  const cb = standardUnitCode(b);
  return ca !== null && cb !== null ? ca === cb : a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface StockQuantity {
  /** In the ingredient's stock unit, rounded to the 6-decimal standard. */
  stockQuantity: string;
  /** The typed amount, rounded to the standard (for display: "250 g"). */
  enteredQuantity: string;
  /** The typed unit in its catalogue spelling ("Grams" -> "g"; custom units as defined). */
  enteredUnit: string;
}

/** Converts a typed quantity + unit into the ingredient's stock unit. Throws QuantityError. */
export function toStockQuantity(units: IngredientUnits, quantity: string | number, unit?: string | null): StockQuantity {
  const typedUnit = unit?.trim() || units.stockUnit;
  const enteredQuantity = normalizeQuantity(quantity);

  if (sameUnit(typedUnit, units.stockUnit)) {
    return { stockQuantity: enteredQuantity, enteredQuantity, enteredUnit: units.stockUnit };
  }
  const from = standardUnit(standardUnitCode(typedUnit) ?? "");
  const to = standardUnit(standardUnitCode(units.stockUnit) ?? "");
  if (from && to && from.dimension === to.dimension) {
    return { stockQuantity: scaleQuantity(quantity, from.base, to.base), enteredQuantity, enteredUnit: from.code };
  }
  const custom = units.custom.find((c) => c.name.toLowerCase() === typedUnit.toLowerCase());
  if (custom) {
    return { stockQuantity: scaleQuantity(quantity, custom.toStock, "1"), enteredQuantity, enteredUnit: custom.name };
  }
  throw new QuantityError(
    `${units.ingredientName} is stocked in ${units.stockUnit}; "${typedUnit}" cannot be converted to it. ` +
      `Use a ${to ? to.dimension : units.stockUnit} unit, or add "${typedUnit}" as a unit of this ingredient.`,
  );
}

/** The stock unit to save for a typed ingredient unit: catalogue spelling, or a valid custom name. */
export function canonicalStockUnit(unit: string): string {
  const code = standardUnitCode(unit);
  if (code) return code;
  const trimmed = unit.trim();
  if (!CUSTOM_UNIT_RE.test(trimmed)) throw new QuantityError(`"${unit}" is not a valid unit name.`);
  return trimmed;
}

/** A request line that names an ingredient, an amount and, optionally, the unit it was typed in. */
export interface TypedStockLine {
  ingredient_id: string;
  quantity?: unknown;
  unit?: string;
  [field: string]: unknown;
}

/**
 * For stock and purchasing requests (receive, transfer, consumption, adjustment, PR, PO):
 * every line that names a `unit` is rewritten IN PLACE into the ingredient's stock unit before
 * the route's own logic runs, so that logic keeps working in stock units only. A per-unit price
 * on the same line (`costField`) is rescaled too: 2 sacks at 1000 each = 50 kg at 40/kg.
 * Lines without `unit` are left exactly as sent (stock unit, as before D57).
 * Returns false after answering 400 when a line cannot be converted.
 */
export async function applyStockUnits(
  db: DB,
  res: Response,
  lines: TypedStockLine[],
  options: { quantityField?: string; costField?: string; asNumber?: boolean } = {},
): Promise<boolean> {
  const quantityField = options.quantityField ?? "quantity";
  const withUnit = lines.filter((line) => typeof line.unit === "string" && line.unit.trim() !== "");
  if (withUnit.length === 0) return true;
  const unitsById = await loadIngredientUnits(db, withUnit.map((l) => l.ingredient_id));
  try {
    for (const line of withUnit) {
      const units = unitsById.get(line.ingredient_id);
      if (!units) continue; // the route's own "ingredient not found" answers this
      const typed = line[quantityField] as string | number;
      const converted = toStockQuantity(units, typed, line.unit);
      if (options.costField && line[options.costField] !== undefined && line[options.costField] !== null) {
        // price per typed unit x typed amount = line total; / stock amount = price per stock unit
        line[options.costField] = Number(scaleQuantity(line[options.costField] as number, converted.enteredQuantity, converted.stockQuantity, 8));
      }
      line[quantityField] = options.asNumber ? Number(converted.stockQuantity) : converted.stockQuantity;
      delete line.unit;
    }
  } catch (err) {
    if (err instanceof QuantityError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      return false;
    }
    throw err;
  }
  return true;
}
