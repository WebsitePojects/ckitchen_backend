-- ============================================================================
-- Migration 0033 -- Middleware integration foundation (spec section 11:
-- "The dummy and eventual live provider use the same adapter interface.
-- Webhook intake verifies exact raw bytes, timestamp, key ID, and signature
-- before parsing; it persists a unique provider event, raw hash,
-- redacted/encrypted payload reference, and processing state before
-- acknowledging. Duplicate event ID + same hash is an idempotent replay; a
-- different hash is quarantined. Unknown listing/item mappings enter
-- MAPPING_REQUIRED/DLQ with no partial order. Processing is asynchronous,
-- bounded-retry, out-of-order aware, and replayable.")
--
-- New table only: provider_event. No existing table is touched. The
-- `integration.middleware_processing` feature flag already exists (inserted
-- by migration 0027's operational_feature_flag seed) and is reused as-is --
-- no new flag row here.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "provider_event_kind" AS ENUM('ORDER_CREATED','ORDER_CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- PENDING            -- persisted, not yet processed (or eligible for retry).
-- PROCESSING         -- reserved for a future concurrent-worker guard; the
--                       in-process processor in this stream runs one event at
--                       a time inside its own transaction and does not
--                       currently leave a row parked in this state, but it is
--                       part of the contract for a future multi-worker pool.
-- PROCESSED          -- ingestOrder (or the linked cancelOrder) succeeded.
-- MAPPING_REQUIRED   -- unknown channel listing or menu item mapping (DLQ).
-- WAITING_DEPENDENCY -- an ORDER_CANCELLED arrived before its ORDER_CREATED.
-- FAILED             -- bounded retries exhausted; replayable via reprocess.
-- QUARANTINED        -- same provider_event_id replayed with a different raw
--                       hash (tamper/integrity concern) -- never processed.
DO $$ BEGIN CREATE TYPE "provider_event_state" AS ENUM('PENDING','PROCESSING','PROCESSED','MAPPING_REQUIRED','WAITING_DEPENDENCY','FAILED','QUARANTINED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "provider_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "kind" "provider_event_kind" NOT NULL,
  "state" "provider_event_state" DEFAULT 'PENDING' NOT NULL,
  "raw_hash" text NOT NULL,
  "key_id" text NOT NULL,
  "aggregator" "aggregator" NOT NULL,
  "merchant_ref" text NOT NULL,
  "external_ref" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "redacted_payload" jsonb NOT NULL,
  "order_id" uuid,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_event_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "provider_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "provider_event" ADD CONSTRAINT "provider_event_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- The idempotency anchor (spec: "persists a unique provider event"; "Duplicate
-- event ID + same hash is an idempotent replay"). Scoped per-provider so two
-- different middleware vendors could theoretically reuse the same event id
-- shape without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS "provider_event_provider_event_id_unique" ON "provider_event" USING btree ("provider","provider_event_id");--> statement-breakpoint

-- Eligible-for-processing scan (PENDING/WAITING_DEPENDENCY/MAPPING_REQUIRED/
-- FAILED rows whose backoff window has elapsed).
CREATE INDEX IF NOT EXISTS "provider_event_state_next_attempt_idx" ON "provider_event" USING btree ("state","next_attempt_at");--> statement-breakpoint

-- Out-of-order resolution: when an ORDER_CREATED event for
-- (aggregator, merchant_ref, external_ref) processes successfully, the
-- processor looks up any WAITING_DEPENDENCY ORDER_CANCELLED row for the same
-- triple so it can resolve the park automatically (spec: "resolved on later
-- create or reprocess").
CREATE INDEX IF NOT EXISTS "provider_event_listing_ref_idx" ON "provider_event" USING btree ("aggregator","merchant_ref","external_ref");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "provider_event_order_id_idx" ON "provider_event" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_event_received_at_idx" ON "provider_event" USING btree ("received_at" DESC);
