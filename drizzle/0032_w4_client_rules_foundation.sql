-- ============================================================================
-- Migration 0032 -- W4 client-rules foundation (spec section 10 discounts/commercial
-- terms, section 6/7 order-line component snapshot mirror)
--
-- Additive/dark: schema only, no service/route/feature wiring.
--   1. order_discount.evidence_ref (private storage key, never a public URL)
--      + discount_evidence_access_log (append-only audit trail of every
--      evidence read).
--   2. channel_commercial_term: effective-dated BASE/MARKETING commission
--      percent per channel listing, overlap prevented by an EXCLUDE USING
--      gist constraint (requires btree_gist -- loaded as a PGlite contrib
--      extension in src/db/client.ts for the test/dev harness; a standard
--      contrib extension already available on Supabase-managed Postgres).
--   3. order.commission_rate_snapshot / order.marketing_rate_snapshot --
--      captured at ingestion; NULL = terms missing = finance exception
--      (later streams service logic, not enforced here).
--   4. order_item.component_snapshot -- recipe lines captured at order
--      creation, mirroring customer_order_line.component_requirements_snapshot.
--   5. Three new feature-flag rows (default false), same
--      operational_feature_flag convention as 0027.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. order_discount.evidence_ref + discount_evidence_access_log
-- ---------------------------------------------------------------------------

ALTER TABLE "order_discount" ADD COLUMN IF NOT EXISTS "evidence_ref" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discount_evidence_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_discount_id" uuid NOT NULL,
  "accessed_by" uuid NOT NULL,
  "purpose" text NOT NULL,
  "accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "discount_evidence_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "discount_evidence_access_log" ADD CONSTRAINT "discount_evidence_access_log_order_discount_id_fk" FOREIGN KEY ("order_discount_id") REFERENCES "public"."order_discount"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "discount_evidence_access_log" ADD CONSTRAINT "discount_evidence_access_log_accessed_by_fk" FOREIGN KEY ("accessed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_evidence_access_log_order_discount_id_idx" ON "discount_evidence_access_log" USING btree ("order_discount_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_evidence_access_log_accessed_by_idx" ON "discount_evidence_access_log" USING btree ("accessed_by");--> statement-breakpoint

-- Append-only: every access attempt that reaches this table is a permanent
-- audit record. Reuses the shared forbid_mutation() trigger function defined
-- in migration 0009 (already backing stock_posting_line, stock_return_receipt_
-- line, customer_order_fulfillment, inventory_lot_genealogy).
DROP TRIGGER IF EXISTS discount_evidence_access_log_append_only ON "discount_evidence_access_log";--> statement-breakpoint
CREATE TRIGGER discount_evidence_access_log_append_only BEFORE UPDATE OR DELETE ON "discount_evidence_access_log" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. channel_commercial_term
-- ---------------------------------------------------------------------------

DO $$ BEGIN CREATE TYPE "channel_commercial_term_rate_type" AS ENUM('BASE','MARKETING'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "channel_commercial_term" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid NOT NULL,
  "rate_type" "channel_commercial_term_rate_type" NOT NULL,
  "percent" numeric(5,2) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_by" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_commercial_term_percent_range" CHECK ("percent" >= 0 AND "percent" <= 100),
  CONSTRAINT "channel_commercial_term_version_positive" CHECK ("version" > 0),
  CONSTRAINT "channel_commercial_term_effective_to_after_from" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);--> statement-breakpoint
ALTER TABLE "channel_commercial_term" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "channel_commercial_term" ADD CONSTRAINT "channel_commercial_term_aggregator_account_id_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "channel_commercial_term" ADD CONSTRAINT "channel_commercial_term_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_commercial_term_aggregator_account_id_idx" ON "channel_commercial_term" USING btree ("aggregator_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_commercial_term_aggregator_rate_type_idx" ON "channel_commercial_term" USING btree ("aggregator_account_id","rate_type");--> statement-breakpoint

-- Overlap prevention (spec section 10: Effective periods cannot overlap).
-- Two BASE rows (or two MARKETING rows) for the SAME listing may never have
-- date ranges that intersect; a BASE row and a MARKETING row for the same
-- listing MAY overlap freely (they are independent rate tracks) because
-- rate_type is part of the exclusion key. Open-ended terms (effective_to
-- IS NULL) are modelled as [effective_from, infinity).
DO $$ BEGIN
  ALTER TABLE "channel_commercial_term" ADD CONSTRAINT "channel_commercial_term_no_overlap"
    EXCLUDE USING gist (
      "aggregator_account_id" WITH =,
      "rate_type" WITH =,
      daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[]') WITH &&
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. order.commission_rate_snapshot / order.marketing_rate_snapshot
-- ---------------------------------------------------------------------------

ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "commission_rate_snapshot" numeric(5,2);--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "marketing_rate_snapshot" numeric(5,2);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order" ADD CONSTRAINT "order_commission_rate_snapshot_range" CHECK ("commission_rate_snapshot" IS NULL OR ("commission_rate_snapshot" >= 0 AND "commission_rate_snapshot" <= 100)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order" ADD CONSTRAINT "order_marketing_rate_snapshot_range" CHECK ("marketing_rate_snapshot" IS NULL OR ("marketing_rate_snapshot" >= 0 AND "marketing_rate_snapshot" <= 100)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. order_item.component_snapshot
-- ---------------------------------------------------------------------------

ALTER TABLE "order_item" ADD COLUMN IF NOT EXISTS "component_snapshot" jsonb;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Feature flags (default false; later streams flip them on)
-- ---------------------------------------------------------------------------

INSERT INTO "operational_feature_flag" ("key","enabled","description") VALUES
  ('discounts.strict_approval', false, 'Strict section 10 discount approval routing'),
  ('reports.commission_snapshot', false, 'Net-sales from order snapshots'),
  ('orders.legacy_recipe_snapshot', false, 'Legacy order deduction from component snapshot')
ON CONFLICT ("key") DO NOTHING;