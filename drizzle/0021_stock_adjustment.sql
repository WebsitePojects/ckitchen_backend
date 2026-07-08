-- ============================================================================
-- Migration 0021 — stock_adjustment (D26: approved write-off / correction doc)
--
-- The client's MoM "ingredient expiry + over-order negligence" ask. A two-step
-- flow: any warehouse role REQUESTS an adjustment (PENDING); OWNER / OUTLET_MANAGER
-- APPROVES or REJECTS it. On approval the app, in ONE transaction, flips the row
-- to APPROVED and mutates inventory_stock (OUT decrements, IN increments) while
-- posting a matching ADJUSTMENT row to stock_ledger_entry (sourceDocumentNo = the
-- adjustment id). quantity is always positive; `direction` carries the sign.
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: every
-- statement guarded (CREATE TYPE via DO..EXCEPTION duplicate_object / CREATE TABLE
-- IF NOT EXISTS / DO..EXCEPTION for FKs / CREATE INDEX IF NOT EXISTS), matching the
-- 0018/0019/0020 convention. Journal `when` = 1784000000000 — strictly greater than
-- 0020's 1783900000000 so the incremental migrator does not skip it.
--
-- RLS deny-all (no policy) per the 0009 hardening pattern: the app connects as the
-- table owner / service role and bypasses RLS; this is phase-2 defense.
-- ============================================================================

DO $$ BEGIN
	CREATE TYPE "stock_adjustment_direction" AS ENUM('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "stock_adjustment_reason" AS ENUM('EXPIRY', 'SPOILAGE', 'NEGLIGENCE', 'CORRECTION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "stock_adjustment_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"direction" "stock_adjustment_direction" NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"reason" "stock_adjustment_reason" NOT NULL,
	"note" text,
	"status" "stock_adjustment_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" uuid,
	"decided_by" uuid,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustment_status_idx" ON "stock_adjustment" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustment_warehouse_ingredient_idx" ON "stock_adjustment" USING btree ("warehouse_id","ingredient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustment_created_at_idx" ON "stock_adjustment" USING btree ("created_at");
