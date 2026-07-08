-- ============================================================================
-- Migration 0018 — Discounts/Promos + 3-layer approval workflow
-- (MOTM 2026-07-01 items 2b "per Product an option to place promo/discount",
-- 2c "3 layers of approval: Generally Approved / Supervisor / Admin-Manager",
-- 7 "discount per item" + senior/PWD/voucher defaults)
--
-- Produced by `drizzle-kit generate` diffing against 0017's snapshot (the
-- diff chain was repaired there — see 0017's header). This generate came out
-- clean: only the genuinely-new delta below (2 enums shared across both new
-- tables collapse to 4 total new enums, 2 tables, their FKs, and indexes).
-- No re-emitted already-applied DDL to strip this time.
--
-- IDEMPOTENT: every statement is guarded (DO/IF NOT EXISTS) so re-applying is
-- a safe no-op, matching the 0017 convention. The journal `when` for this
-- entry is set to 1783700000000 — strictly greater than 0017's 1783600000000
-- — so the incremental Postgres migrator does not silently skip it (the same
-- class of bug 0017's header documents fixing).
-- ============================================================================

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_level') THEN
		CREATE TYPE "public"."approval_level" AS ENUM('AUTO', 'SUPERVISOR', 'ADMIN');
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discount_scope') THEN
		CREATE TYPE "public"."discount_scope" AS ENUM('ITEM', 'ORDER');
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discount_type') THEN
		CREATE TYPE "public"."discount_type" AS ENUM('PERCENT', 'FIXED', 'SENIOR', 'PWD', 'VOUCHER');
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_discount_status') THEN
		CREATE TYPE "public"."order_discount_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discount" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "discount_scope" NOT NULL,
	"brand_id" uuid,
	"menu_item_id" uuid,
	"name" text NOT NULL,
	"type" "discount_type" NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"code" text,
	"vat_exempt" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_discount" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"discount_id" uuid,
	"type" "discount_type" NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"approval_level" "approval_level" NOT NULL,
	"status" "order_discount_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"id_note" text,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_discount" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "discount" ADD CONSTRAINT "discount_brand_id_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "discount" ADD CONSTRAINT "discount_menu_item_id_menu_item_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_item"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "discount" ADD CONSTRAINT "discount_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "order_discount" ADD CONSTRAINT "order_discount_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "order_discount" ADD CONSTRAINT "order_discount_discount_id_discount_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discount"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "order_discount" ADD CONSTRAINT "order_discount_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "order_discount" ADD CONSTRAINT "order_discount_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_brand_id_idx" ON "discount" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_menu_item_id_idx" ON "discount" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_active_idx" ON "discount" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_discount_order_id_idx" ON "order_discount" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_discount_status_idx" ON "order_discount" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_discount_discount_id_idx" ON "order_discount" USING btree ("discount_id");
