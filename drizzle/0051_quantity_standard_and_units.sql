-- ============================================================================
-- Migration 0051 -- one quantity standard + units of measure (D57).
--
-- 1. Quantities: the older daily-operation tables kept 4 decimals (0.0001), so a typed
--    0.112312312312312 kg was silently stored as 0.1123. They now use the system standard
--    numeric(20,6) the enterprise stock tables already use (1 mg per kg, 1 microlitre per L).
--    Per-unit costs go to numeric(20,8): with stock counted in g or mL a unit can cost less
--    than a centavo, which 4 decimals would round to zero. Widening only: no value changes.
-- 2. recipe_line keeps what the person typed (entered_quantity + entered_unit, e.g. 250 g)
--    next to portion_qty, which is ALWAYS in the ingredient's stock unit (what deduction uses).
-- 3. Unit spellings are normalised to the catalogue codes (modules/units/catalog.ts):
--    "Kgs" -> kg, "pcs" -> pc, "Liter" -> L. Unknown spellings stay as custom units.
--    recipe_line.unit is set to its ingredient's stock unit, which is what portion_qty has
--    always meant (deduction never converted).
--
-- Statements are few and coarse on purpose: the VPS is ~229 ms from the database.
--
-- Reversible: widen-back is lossy (do not); drop the two recipe_line columns; unit
-- spellings are cosmetic.
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE "consumption_log" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "ingredient" ALTER COLUMN "low_stock_threshold" TYPE numeric(20,6);
  ALTER TABLE "inventory_stock" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "ito_item" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "purchase_order_line" ALTER COLUMN "qty_received" TYPE numeric(20,6);
  ALTER TABLE "purchase_order_line" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "purchase_request_line" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "receiving_report_line" ALTER COLUMN "qty_received" TYPE numeric(20,6);
  ALTER TABLE "recipe_line" ALTER COLUMN "portion_qty" TYPE numeric(20,6);
  ALTER TABLE "stock_adjustment" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "stock_ledger_entry" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "stock_reservation" ALTER COLUMN "quantity" TYPE numeric(20,6);
  ALTER TABLE "ingredient" ALTER COLUMN "unit_cost" TYPE numeric(20,8);
  ALTER TABLE "order_item" ALTER COLUMN "unit_cost" TYPE numeric(20,8);
  ALTER TABLE "purchase_order_line" ALTER COLUMN "unit_cost" TYPE numeric(20,8);
  ALTER TABLE "purchase_request_line" ALTER COLUMN "est_unit_cost" TYPE numeric(20,8);
  ALTER TABLE "stock_ledger_entry" ALTER COLUMN "unit_cost" TYPE numeric(20,8);
  ALTER TABLE "supplier_item" ALTER COLUMN "last_unit_cost" TYPE numeric(20,8);
  ALTER TABLE "recipe_line" ADD COLUMN IF NOT EXISTS "entered_quantity" numeric(20,6);
  ALTER TABLE "recipe_line" ADD COLUMN IF NOT EXISTS "entered_unit" text;
END $$;
--> statement-breakpoint
UPDATE "ingredient" SET "unit" = CASE lower(btrim("unit"))
    WHEN 'kg' THEN 'kg'
    WHEN 'kgs' THEN 'kg'
    WHEN 'kilo' THEN 'kg'
    WHEN 'kilos' THEN 'kg'
    WHEN 'kilogram' THEN 'kg'
    WHEN 'kilograms' THEN 'kg'
    WHEN 'g' THEN 'g'
    WHEN 'gm' THEN 'g'
    WHEN 'gms' THEN 'g'
    WHEN 'gr' THEN 'g'
    WHEN 'gram' THEN 'g'
    WHEN 'grams' THEN 'g'
    WHEN 'mg' THEN 'mg'
    WHEN 'milligram' THEN 'mg'
    WHEN 'milligrams' THEN 'mg'
    WHEN 'lb' THEN 'lb'
    WHEN 'lbs' THEN 'lb'
    WHEN 'pound' THEN 'lb'
    WHEN 'pounds' THEN 'lb'
    WHEN 'oz' THEN 'oz'
    WHEN 'ounce' THEN 'oz'
    WHEN 'ounces' THEN 'oz'
    WHEN 'l' THEN 'L'
    WHEN 'lt' THEN 'L'
    WHEN 'ltr' THEN 'L'
    WHEN 'ltrs' THEN 'L'
    WHEN 'liter' THEN 'L'
    WHEN 'liters' THEN 'L'
    WHEN 'litre' THEN 'L'
    WHEN 'litres' THEN 'L'
    WHEN 'ml' THEN 'mL'
    WHEN 'milliliter' THEN 'mL'
    WHEN 'milliliters' THEN 'mL'
    WHEN 'millilitre' THEN 'mL'
    WHEN 'millilitres' THEN 'mL'
    WHEN 'gal' THEN 'gal'
    WHEN 'gallon' THEN 'gal'
    WHEN 'gallons' THEN 'gal'
    WHEN 'cup' THEN 'cup'
    WHEN 'cups' THEN 'cup'
    WHEN 'tbsp' THEN 'tbsp'
    WHEN 'tbs' THEN 'tbsp'
    WHEN 'tablespoon' THEN 'tbsp'
    WHEN 'tablespoons' THEN 'tbsp'
    WHEN 'tsp' THEN 'tsp'
    WHEN 'teaspoon' THEN 'tsp'
    WHEN 'teaspoons' THEN 'tsp'
    WHEN 'pc' THEN 'pc'
    WHEN 'pcs' THEN 'pc'
    WHEN 'pce' THEN 'pc'
    WHEN 'piece' THEN 'pc'
    WHEN 'pieces' THEN 'pc'
    WHEN 'ea' THEN 'pc'
    WHEN 'each' THEN 'pc'
    WHEN 'dozen' THEN 'dozen'
    WHEN 'doz' THEN 'dozen'
    WHEN 'dz' THEN 'dozen'
    ELSE btrim("unit")
  END
WHERE "unit" IS DISTINCT FROM (CASE lower(btrim("unit"))
    WHEN 'kg' THEN 'kg'
    WHEN 'kgs' THEN 'kg'
    WHEN 'kilo' THEN 'kg'
    WHEN 'kilos' THEN 'kg'
    WHEN 'kilogram' THEN 'kg'
    WHEN 'kilograms' THEN 'kg'
    WHEN 'g' THEN 'g'
    WHEN 'gm' THEN 'g'
    WHEN 'gms' THEN 'g'
    WHEN 'gr' THEN 'g'
    WHEN 'gram' THEN 'g'
    WHEN 'grams' THEN 'g'
    WHEN 'mg' THEN 'mg'
    WHEN 'milligram' THEN 'mg'
    WHEN 'milligrams' THEN 'mg'
    WHEN 'lb' THEN 'lb'
    WHEN 'lbs' THEN 'lb'
    WHEN 'pound' THEN 'lb'
    WHEN 'pounds' THEN 'lb'
    WHEN 'oz' THEN 'oz'
    WHEN 'ounce' THEN 'oz'
    WHEN 'ounces' THEN 'oz'
    WHEN 'l' THEN 'L'
    WHEN 'lt' THEN 'L'
    WHEN 'ltr' THEN 'L'
    WHEN 'ltrs' THEN 'L'
    WHEN 'liter' THEN 'L'
    WHEN 'liters' THEN 'L'
    WHEN 'litre' THEN 'L'
    WHEN 'litres' THEN 'L'
    WHEN 'ml' THEN 'mL'
    WHEN 'milliliter' THEN 'mL'
    WHEN 'milliliters' THEN 'mL'
    WHEN 'millilitre' THEN 'mL'
    WHEN 'millilitres' THEN 'mL'
    WHEN 'gal' THEN 'gal'
    WHEN 'gallon' THEN 'gal'
    WHEN 'gallons' THEN 'gal'
    WHEN 'cup' THEN 'cup'
    WHEN 'cups' THEN 'cup'
    WHEN 'tbsp' THEN 'tbsp'
    WHEN 'tbs' THEN 'tbsp'
    WHEN 'tablespoon' THEN 'tbsp'
    WHEN 'tablespoons' THEN 'tbsp'
    WHEN 'tsp' THEN 'tsp'
    WHEN 'teaspoon' THEN 'tsp'
    WHEN 'teaspoons' THEN 'tsp'
    WHEN 'pc' THEN 'pc'
    WHEN 'pcs' THEN 'pc'
    WHEN 'pce' THEN 'pc'
    WHEN 'piece' THEN 'pc'
    WHEN 'pieces' THEN 'pc'
    WHEN 'ea' THEN 'pc'
    WHEN 'each' THEN 'pc'
    WHEN 'dozen' THEN 'dozen'
    WHEN 'doz' THEN 'dozen'
    WHEN 'dz' THEN 'dozen'
    ELSE btrim("unit")
  END);
--> statement-breakpoint
UPDATE "item_uom_conversion" SET "from_uom" = btrim("from_uom") WHERE "from_uom" <> btrim("from_uom");
--> statement-breakpoint
UPDATE "recipe_line" r SET
  "unit" = i."unit",
  "entered_quantity" = coalesce(r."entered_quantity", r."portion_qty"),
  "entered_unit" = coalesce(r."entered_unit", i."unit")
FROM "ingredient" i
WHERE i."id" = r."ingredient_id";
