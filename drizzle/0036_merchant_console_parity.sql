-- ============================================================================
-- Migration 0036 -- Merchant-console parity (SITE_VISIT_VIDEO_ANALYSIS.md
-- section 6 gap analysis, closing findings B, C/N2, D/F/G, H, and the section
-- 7 scale note). Additive-only:
--
--   A (finding H)  -- REJECT_ORDER reason is now a controlled vocabulary
--                     (validated app-side at enqueueCommand; payload stays
--                     jsonb, no column needed).
--   B (finding B)  -- order.accept_deadline_at + aggregator_account.
--                     accept_sla_seconds: the Grab "accept within 5 minutes
--                     or your store pauses" SLA, informational for now.
--   C (finding N2) -- CONTEST_CANCELLATION added to aggregator_command_type
--                     (ALTER TYPE ADD VALUE -- see 0012's header for why this
--                     is safe here: nothing in this migration or any other
--                     pending one uses the new label, so the "unsafe use of
--                     new value in the same transaction" restriction never
--                     triggers) + new order_dispute table.
--   D (finding F/G)-- minimal menu_option_group / menu_option_group_item
--                     linkage so SET_ITEM_AVAILABILITY can target a whole
--                     option group, not just one item at a time.
--   E (section 7)  -- composite index for the listCommands hot path (paired
--                     with a service.ts code fix: count(*) instead of a
--                     full-row select().length).
--
-- No existing row/behavior changes: every new column is nullable/defaulted,
-- every new table is empty until the app writes to it, and the new enum
-- label is inert until service.ts's createDispute() starts using it.
-- ============================================================================

-- ── A/B: additive columns on existing tables ────────────────────────────────

ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "accept_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "accept_sla_seconds" integer;--> statement-breakpoint

-- ── C: CONTEST_CANCELLATION command type + order_dispute ───────────────────

ALTER TYPE "aggregator_command_type" ADD VALUE IF NOT EXISTS 'CONTEST_CANCELLATION';--> statement-breakpoint

DO $$ BEGIN CREATE TYPE "order_dispute_reason" AS ENUM('SUSPECTED_FRAUD','ALREADY_PREPARED','RIDER_NO_SHOW','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- OPEN -- raised, CONTEST_CANCELLATION enqueued. CONTESTED -- sent to the
-- aggregator, awaiting their decision. RESOLVED_* -- terminal outcomes.
-- EXPIRED -- the aggregator's own dispute window lapsed unresolved.
DO $$ BEGIN CREATE TYPE "order_dispute_status" AS ENUM('OPEN','CONTESTED','RESOLVED_MERCHANT_FAVOR','RESOLVED_AGGREGATOR_FAVOR','EXPIRED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_dispute" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "raised_by" uuid,
  "reason" "order_dispute_reason" NOT NULL,
  "status" "order_dispute_status" DEFAULT 'OPEN' NOT NULL,
  "aggregator_command_id" uuid,
  "evidence_note" text,
  "resolved_at" timestamp with time zone,
  "resolution_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "order_dispute" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "order_dispute" ADD CONSTRAINT "order_dispute_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "order_dispute" ADD CONSTRAINT "order_dispute_raised_by_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "order_dispute" ADD CONSTRAINT "order_dispute_aggregator_command_id_fk" FOREIGN KEY ("aggregator_command_id") REFERENCES "public"."aggregator_command"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- At most one dispute per order -- a repeat contest call is an idempotent replay (service.ts createDispute).
CREATE UNIQUE INDEX IF NOT EXISTS "order_dispute_order_id_unique" ON "order_dispute" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_dispute_status_idx" ON "order_dispute" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_dispute_aggregator_command_id_idx" ON "order_dispute" USING btree ("aggregator_command_id");--> statement-breakpoint

-- ── D: minimal option-group model ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "menu_option_group" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brand_id" uuid NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "menu_option_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_option_group" ADD CONSTRAINT "menu_option_group_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_option_group_brand_id_idx" ON "menu_option_group" USING btree ("brand_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "menu_option_group_item" (
  "option_group_id" uuid NOT NULL,
  "menu_item_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "menu_option_group_item_option_group_id_menu_item_id_pk" PRIMARY KEY("option_group_id","menu_item_id")
);--> statement-breakpoint
ALTER TABLE "menu_option_group_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_option_group_item" ADD CONSTRAINT "menu_option_group_item_option_group_id_fk" FOREIGN KEY ("option_group_id") REFERENCES "public"."menu_option_group"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_option_group_item" ADD CONSTRAINT "menu_option_group_item_menu_item_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_item"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_option_group_item_menu_item_id_idx" ON "menu_option_group_item" USING btree ("menu_item_id");--> statement-breakpoint

-- ── E: scale index for listCommands (section 7) ─────────────────────────────

CREATE INDEX IF NOT EXISTS "aggregator_command_account_status_created_idx" ON "aggregator_command" USING btree ("aggregator_account_id","status","created_at");
