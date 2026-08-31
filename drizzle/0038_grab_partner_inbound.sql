-- ============================================================================
-- Migration 0038 -- GrabFood Partner API inbound (partner-API-first go-live).
--
-- Additive-only. Stores durable, redacted receipts for the five inbound
-- GrabFood Partner API routes that carry a body (submit order, push order
-- state, push integration status, menu sync state, push Grab menu) plus a
-- query-params-only receipt for GetMenu, the durable partnerMerchantID <->
-- grabMerchantID mapping, and menu sync job tracking. It does not alter the
-- existing outbound Grab adapter or the generic middleware webhook tables.
-- Never persists the OAuth partner access token or client_secret (no table
-- for GetPartnerAccessToken) per spec.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "grab_partner_receipt_route" AS ENUM('SUBMIT_ORDER','PUSH_ORDER_STATE','PUSH_INTEGRATION_STATUS','MENU_SYNC_STATE','PUSH_GRAB_MENU','GET_MENU'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "grab_partner_receipt_state" AS ENUM('PENDING','PROCESSED','WAITING_DEPENDENCY','IGNORED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "grab_integration_status" AS ENUM('INACTIVE','ACTIVE','SYNCING','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "grab_menu_sync_status" AS ENUM('QUEUEING','PROCESSING','SUCCESS','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "grab_partner_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid,
  "route" "grab_partner_receipt_route" NOT NULL,
  "grab_merchant_id" text,
  "partner_merchant_id" text,
  "provider_order_id" text,
  "short_order_number" text,
  "request_id" text,
  "job_id" text,
  "dedupe_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" "grab_partner_receipt_state" DEFAULT 'PENDING' NOT NULL,
  "redacted_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "is_mex_edit_order" boolean,
  "order_id" uuid,
  "last_error" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grab_partner_receipt_request_hash_len" CHECK (length("request_hash") = 64),
  CONSTRAINT "grab_partner_receipt_dedupe_key_nonempty" CHECK (length("dedupe_key") BETWEEN 1 AND 700)
);--> statement-breakpoint
ALTER TABLE "grab_partner_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "grab_partner_receipt" ADD CONSTRAINT "grab_partner_receipt_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "grab_partner_receipt" ADD CONSTRAINT "grab_partner_receipt_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "grab_partner_receipt_dedupe_key_unique" ON "grab_partner_receipt" USING btree ("dedupe_key");--> statement-breakpoint
-- Listing-scoped submit-order idempotency honouring Grab's isMexEditOrder
-- carve-out: "If the isMexEditOrder value changes from false to true, this
-- submit request is not considered a duplicate request."
CREATE UNIQUE INDEX IF NOT EXISTS "grab_partner_submit_order_listing_provider_order_unique" ON "grab_partner_receipt" USING btree ("aggregator_account_id","provider_order_id","is_mex_edit_order") WHERE "route" = 'SUBMIT_ORDER' AND "provider_order_id" IS NOT NULL;--> statement-breakpoint
-- Grab's explicit menu-sync-state rule: "If two requests contain the same
-- requestID, only the first request should be considered and later requests
-- must be ignored or discarded" -- enforced in the DB, not just app logic.
CREATE UNIQUE INDEX IF NOT EXISTS "grab_partner_menu_sync_state_request_id_unique" ON "grab_partner_receipt" USING btree ("request_id") WHERE "route" = 'MENU_SYNC_STATE' AND "request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grab_partner_receipt_account_route_idx" ON "grab_partner_receipt" USING btree ("aggregator_account_id","route");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grab_partner_receipt_state_idx" ON "grab_partner_receipt" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grab_partner_receipt_provider_order_idx" ON "grab_partner_receipt" USING btree ("provider_order_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "grab_listing_integration" (
  "aggregator_account_id" uuid NOT NULL,
  "partner_merchant_id" text NOT NULL,
  "grab_merchant_id" text,
  "integration_status" "grab_integration_status" DEFAULT 'INACTIVE' NOT NULL,
  "last_status_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grab_listing_integration_aggregator_account_id_pk" PRIMARY KEY("aggregator_account_id"),
  CONSTRAINT "grab_listing_integration_partner_merchant_id_len" CHECK (length("partner_merchant_id") BETWEEN 1 AND 64)
);--> statement-breakpoint
ALTER TABLE "grab_listing_integration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "grab_listing_integration" ADD CONSTRAINT "grab_listing_integration_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "grab_listing_integration_partner_merchant_id_unique" ON "grab_listing_integration" USING btree ("partner_merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grab_listing_integration_grab_merchant_id_idx" ON "grab_listing_integration" USING btree ("grab_merchant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "grab_menu_sync_job" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid NOT NULL,
  "job_id" text NOT NULL,
  "status" "grab_menu_sync_status" NOT NULL,
  "errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at_remote" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "grab_menu_sync_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "grab_menu_sync_job" ADD CONSTRAINT "grab_menu_sync_job_account_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "grab_menu_sync_job_account_job_unique" ON "grab_menu_sync_job" USING btree ("aggregator_account_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grab_menu_sync_job_status_idx" ON "grab_menu_sync_job" USING btree ("status");
