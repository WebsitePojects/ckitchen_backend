-- ============================================================================
-- Migration 0020 — stock_reservation (soft holds against KITCHEN stock)
--
-- S4 (stock reservation system): when an order is ingested, one row per
-- recipe ingredient is inserted here as a SOFT HOLD against the order's
-- outlet KITCHEN warehouse. `available = inventory_stock.quantity − SUM(active
-- reservations)` — used by ingest shortfall checks and surfaced per-row on
-- GET /inventory. Rows are deleted when the hold resolves:
--   • NEW→PREPARING advance (real deduction replaces the hold — Rule #2 is
--     unchanged: stock still deducts at PREPARING, never earlier), or
--   • cancel (releases the hold; no-op after PREPARING since rows are gone).
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: every
-- statement guarded (IF NOT EXISTS / DO..EXCEPTION) per the 0018/0019
-- convention. Journal `when` = 1783900000000 — strictly greater than 0019's
-- 1783800000000 so the incremental migrator does not skip it.
--
-- RLS deny-all (no policy) per the 0009 hardening pattern: the app connects as
-- the table owner / service role and bypasses RLS; this is phase-2 defense.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "stock_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_reservation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_reservation_order_id_idx" ON "stock_reservation" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_reservation_warehouse_ingredient_idx" ON "stock_reservation" USING btree ("warehouse_id","ingredient_id");
