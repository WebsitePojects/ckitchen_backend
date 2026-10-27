-- ============================================================================
-- Migration 0044 -- owner email alerts (low stock, unattended and stuck orders).
--
-- WHY: the owner is not watching the dashboard all day. When kitchen stock falls to
-- its threshold, or an order sits untouched, they must hear about it by email.
--
--   alert_event  one row per problem episode. The partial unique index allows only ONE
--                open alert per (kind, subject), so repeated scans never re-alert; when
--                the problem clears the row is resolved, and a later dip opens a new one.
--   alert_email  the delivery outbox. Recipients, subject and body are frozen when the
--                email is composed (sender too), so a retry sends the identical request with the same
--                Idempotency-Key (the email id) and the provider never sends it twice.
--
-- Additive and reversible (DROP TABLE alert_event; DROP TABLE alert_email).
-- ============================================================================
CREATE TABLE IF NOT EXISTS "alert_email" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_address" text NOT NULL,
  "recipients" jsonb NOT NULL,
  "subject" text NOT NULL,
  "text_body" text NOT NULL,
  "html_body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "last_error" text,
  "provider_message_id" text,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "alert_email_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  CONSTRAINT "alert_email_attempts_nonnegative" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_email_due_idx" ON "alert_email" ("available_at") WHERE "status" IN ('PENDING', 'SENDING');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "location_id" uuid REFERENCES "location"("id"),
  "details" jsonb NOT NULL,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  "email_id" uuid REFERENCES "alert_email"("id"),
  CONSTRAINT "alert_event_kind_check" CHECK ("kind" IN ('LOW_STOCK', 'ORDER_UNATTENDED', 'ORDER_STUCK'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_event_open_unique" ON "alert_event" ("kind", "subject_id") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_event_unsent_idx" ON "alert_event" ("opened_at") WHERE "email_id" IS NULL AND "resolved_at" IS NULL;
--> statement-breakpoint
-- Same posture as every other public table (migration 0039): RLS on and forced.
ALTER TABLE "alert_email" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "alert_email" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "alert_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "alert_event" FORCE ROW LEVEL SECURITY;
