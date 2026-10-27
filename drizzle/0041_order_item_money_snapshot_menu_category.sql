-- ============================================================================
-- Migration 0041 -- freeze each order line's price and food cost; menu category/description.
--
-- WHY: order_item stored only qty, so every report recomputed revenue from the
-- CURRENT menu price and food cost from the CURRENT ingredient cost. Changing a
-- price or a supplier cost silently rewrote past revenue and margins. Each line
-- now keeps what it actually sold for and what its recipe cost at order time.
--
-- Backfill: existing rows take today's price and recipe cost -- the best value
-- available for history, and exactly what the reports showed until now. Columns
-- stay nullable so any older insert path keeps working; readers COALESCE to the
-- live value only for rows this backfill could not fill.
--
-- menu_item.category / description: the client's menu sheet is organised by
-- category (Fun Chow, Iced Coffee, Milktea...) with a description per item; the
-- POS order screen groups tiles by category.
--
-- Additive and reversible (DROP COLUMN).
-- ============================================================================
ALTER TABLE "menu_item" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "order_item" ADD COLUMN IF NOT EXISTS "unit_price" numeric(14, 2);
--> statement-breakpoint
ALTER TABLE "order_item" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(14, 4);
--> statement-breakpoint
UPDATE "order_item" oi
   SET "unit_price" = mi."price"
  FROM "menu_item" mi
 WHERE mi."id" = oi."menu_item_id"
   AND oi."unit_price" IS NULL;
--> statement-breakpoint
UPDATE "order_item" oi
   SET "unit_cost" = rc.cost
  FROM (
        SELECT rl."menu_item_id", SUM(rl."portion_qty"::numeric * i."unit_cost"::numeric) AS cost
          FROM "recipe_line" rl
          JOIN "ingredient" i ON i."id" = rl."ingredient_id"
         GROUP BY rl."menu_item_id"
       ) rc
 WHERE rc."menu_item_id" = oi."menu_item_id"
   AND oi."unit_cost" IS NULL;
--> statement-breakpoint
-- A menu item with no recipe genuinely cost nothing to track; record 0, not unknown.
UPDATE "order_item" SET "unit_cost" = 0 WHERE "unit_cost" IS NULL;
