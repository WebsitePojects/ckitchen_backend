-- ============================================================================
-- Migration 0035 -- Outbound aggregator commands (AGGREGATOR_API_INTEGRATION_
-- SPEC.md sections 4-5: "Outbound: per-listing command queue (accept/reject,
-- mark-ready, ready-time, pause/resume, item availability, menu notify) with
-- idempotency keys, bounded retries, and a full audit trail -- the
-- AggregatorOutboundAdapter interface; Grab/foodpanda adapters implement it
-- 1:1 from the tables above (a dummy adapter proves the loop until
-- credentials arrive)." / "Cutover plan (per listing, zero big-bang risk)".)
--
-- New table: aggregator_command. Additive-only ALTER on the EXISTING
-- aggregator_account table: control_mode (DEVICE|SHADOW|API, default DEVICE)
-- + api_merchant_id (Grab merchantID / Delivery Hero vendor id). No existing
-- row/behavior changes -- every listing keeps running DEVICE (its merchant
-- tablet/phone) until explicitly cut over, and the new
-- `integration.outbound_commands` feature flag seeded below defaults false.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "channel_control_mode" AS ENUM('DEVICE','SHADOW','API'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "control_mode" "channel_control_mode" DEFAULT 'DEVICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "api_merchant_id" text;--> statement-breakpoint

DO $$ BEGIN CREATE TYPE "aggregator_command_type" AS ENUM('ACCEPT_ORDER','REJECT_ORDER','MARK_READY','UPDATE_READY_TIME','PAUSE_STORE','RESUME_STORE','SET_ITEM_AVAILABILITY','NOTIFY_MENU_UPDATED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- PENDING -- enqueued, not yet claimed (or eligible for retry).
-- CLAIMED -- a worker holds a live lease while a send attempt is in flight.
-- SENT    -- the adapter accepted the command (provider_ref recorded).
-- FAILED  -- a retryable attempt failed; next_attempt_at gates backoff.
-- DEAD    -- bounded retries exhausted; terminal, never auto-retried again.
DO $$ BEGIN CREATE TYPE "aggregator_command_status" AS ENUM('PENDING','CLAIMED','SENT','FAILED','DEAD'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "aggregator_command" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid NOT NULL,
  "order_id" uuid,
  "command_type" "aggregator_command_type" NOT NULL,
  "payload" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" "aggregator_command_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "last_error" text,
  "provider_ref" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "aggregator_command_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "aggregator_command" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "aggregator_command" ADD CONSTRAINT "aggregator_command_aggregator_account_id_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "aggregator_command" ADD CONSTRAINT "aggregator_command_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "aggregator_command" ADD CONSTRAINT "aggregator_command_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Idempotency anchor: a replay of the same idempotency_key returns the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS "aggregator_command_idempotency_key_unique" ON "aggregator_command" USING btree ("idempotency_key");--> statement-breakpoint

-- Out-of-order gate (enqueueCommand): latest command for a (listing, order)
-- pair -- e.g. refusing ACCEPT_ORDER after REJECT_ORDER for the same order.
CREATE INDEX IF NOT EXISTS "aggregator_command_listing_order_idx" ON "aggregator_command" USING btree ("aggregator_account_id","order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_command_order_id_idx" ON "aggregator_command" USING btree ("order_id");--> statement-breakpoint

-- Claim-eligible scan (processCommands): PENDING/FAILED rows whose backoff window elapsed.
CREATE INDEX IF NOT EXISTS "aggregator_command_status_next_attempt_idx" ON "aggregator_command" USING btree ("status","next_attempt_at");--> statement-breakpoint

-- Lapsed-lease sweep -- partial, mirrors print_job_lease_until_idx (0034): always small.
CREATE INDEX IF NOT EXISTS "aggregator_command_lease_until_idx" ON "aggregator_command" USING btree ("lease_until") WHERE "lease_until" IS NOT NULL;--> statement-breakpoint

INSERT INTO "operational_feature_flag" ("key","enabled","description") VALUES
  ('integration.outbound_commands', false, 'Outbound aggregator command queue + order-lifecycle hooks')
ON CONFLICT ("key") DO NOTHING;
