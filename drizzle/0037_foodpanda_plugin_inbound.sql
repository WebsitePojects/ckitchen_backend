-- ============================================================================
-- Migration 0037 -- Foodpanda / Delivery Hero POS Plugin API inbound (Phase 2).
--
-- Additive-only, config-inert until FOODPANDA_PLUGIN_JWT_SECRET is set.
-- Stores durable, redacted receipts before acknowledging Delivery Hero Plugin
-- API calls and creates a local queue row for the accept/reject decision
-- callback. It does not alter the existing outbound Foodpanda adapter or the
-- generic middleware webhook tables.
--
-- Rewritten against the real pluginOrder.yaml schema (Phase 2 correction):
-- adds platform_order_code, callback_urls, expiry_date,
-- item_unavailability_handling, and the full-fidelity raw_payload (PII —
-- never returned/logged) that the original guessed schema discarded.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "foodpanda_plugin_receipt_route" AS ENUM('ORDER_DISPATCH','ORDER_STATUS','AVAILABILITY','MENU_IMPORT_TRIGGER','CATALOG_IMPORT_CALLBACK'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "foodpanda_plugin_receipt_state" AS ENUM('PENDING','PROCESSED','WAITING_DEPENDENCY','IGNORED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "foodpanda_plugin_outbound_task_type" AS ENUM('ORDER_ACCEPT_REJECT_DECISION'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "foodpanda_plugin_outbound_task_status" AS ENUM('PENDING','CLAIMED','DONE','FAILED','DEAD'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "foodpanda_plugin_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid,
  "route" "foodpanda_plugin_receipt_route" NOT NULL,
  "remote_id" text,
  "provider_order_id" text,
  "remote_order_id" text,
  "dedupe_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" "foodpanda_plugin_receipt_state" DEFAULT 'PENDING' NOT NULL,
  "redacted_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "order_id" uuid,
  "last_error" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "foodpanda_plugin_receipt_request_hash_len" CHECK (length("request_hash") = 64),
  CONSTRAINT "foodpanda_plugin_receipt_dedupe_key_nonempty" CHECK (length("dedupe_key") BETWEEN 1 AND 700)
);--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "foodpanda_plugin_receipt" ADD CONSTRAINT "foodpanda_plugin_receipt_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "foodpanda_plugin_receipt" ADD CONSTRAINT "foodpanda_plugin_receipt_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "foodpanda_plugin_receipt_dedupe_key_unique" ON "foodpanda_plugin_receipt" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "foodpanda_plugin_dispatch_listing_provider_order_unique" ON "foodpanda_plugin_receipt" USING btree ("aggregator_account_id","provider_order_id") WHERE "route" = 'ORDER_DISPATCH' AND "provider_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_plugin_receipt_remote_order_idx" ON "foodpanda_plugin_receipt" USING btree ("remote_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_plugin_receipt_account_route_idx" ON "foodpanda_plugin_receipt" USING btree ("aggregator_account_id","route");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_plugin_receipt_state_idx" ON "foodpanda_plugin_receipt" USING btree ("state");--> statement-breakpoint

-- pluginOrder.yaml fields that were previously discarded (guessed-schema bugfix):
-- platform-side order code, the full callbackUrls object (required to accept/
-- reject a Direct order), the accept/reject expiry deadline, the resolved
-- order-level itemUnavailabilityHandling (CANCEL_ORDER precedence applied),
-- and the full-fidelity raw payload (customer PII — see column comment in
-- src/db/foodpanda-plugin-schema.ts; NEVER returned by an API response or logged).
ALTER TABLE "foodpanda_plugin_receipt" ADD COLUMN IF NOT EXISTS "platform_order_code" text;--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_receipt" ADD COLUMN IF NOT EXISTS "callback_urls" jsonb;--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_receipt" ADD COLUMN IF NOT EXISTS "expiry_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_receipt" ADD COLUMN IF NOT EXISTS "item_unavailability_handling" text;--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_receipt" ADD COLUMN IF NOT EXISTS "raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_plugin_receipt_expiry_sweep_idx" ON "foodpanda_plugin_receipt" USING btree ("expiry_date") WHERE "route" = 'ORDER_DISPATCH' AND "state" <> 'PROCESSED';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "foodpanda_listing_availability" (
  "aggregator_account_id" uuid NOT NULL,
  "remote_id" text NOT NULL,
  "event_timestamp" timestamp with time zone NOT NULL,
  "request_hash" text NOT NULL,
  "closures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "foodpanda_listing_availability_aggregator_account_id_pk" PRIMARY KEY("aggregator_account_id"),
  CONSTRAINT "foodpanda_listing_availability_request_hash_len" CHECK (length("request_hash") = 64)
);--> statement-breakpoint
ALTER TABLE "foodpanda_listing_availability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "foodpanda_listing_availability" ADD CONSTRAINT "foodpanda_listing_availability_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_listing_availability_timestamp_idx" ON "foodpanda_listing_availability" USING btree ("event_timestamp");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "foodpanda_plugin_outbound_task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "receipt_id" uuid NOT NULL,
  "aggregator_account_id" uuid NOT NULL,
  "remote_order_id" text NOT NULL,
  "task_type" "foodpanda_plugin_outbound_task_type" NOT NULL,
  "status" "foodpanda_plugin_outbound_task_status" DEFAULT 'PENDING' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "foodpanda_plugin_outbound_task_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "foodpanda_plugin_outbound_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "foodpanda_plugin_outbound_task" ADD CONSTRAINT "foodpanda_plugin_outbound_task_receipt_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."foodpanda_plugin_receipt"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "foodpanda_plugin_outbound_task" ADD CONSTRAINT "foodpanda_plugin_outbound_task_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "foodpanda_plugin_outbound_task_receipt_type_unique" ON "foodpanda_plugin_outbound_task" USING btree ("receipt_id","task_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foodpanda_plugin_outbound_task_status_next_idx" ON "foodpanda_plugin_outbound_task" USING btree ("status","next_attempt_at");
