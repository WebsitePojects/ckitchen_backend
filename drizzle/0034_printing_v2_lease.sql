-- 0034 — Printing v2 lease protocol (D35-D46 §12), additive only.
--
--   1. printer.capability — ESC_POS_KOT (Vozy G80 kitchen tickets) vs
--      WINDOWS_DOCUMENT (Epson L120 rendered documents); VIRTUAL transport
--      column marks the hardware-less verification sink ("A virtual spool
--      sink is the verification substitute until hardware is present").
--   2. print_job v2 columns — capability, content_hash, lease_token /
--      lease_until (CLAIMED is the DERIVED state: status='PENDING' AND
--      lease_until > now(); avoids an enum ALTER inside the migrator txn and
--      keeps the v1 agent pull loop semantics intact), reprint_of_id linkage
--      ("Reprint creates a linked new job; it never rewrites PRINTED
--      history"), document_type for WINDOWS_DOCUMENT payloads.
--   3. print_job_attempt — immutable per-attempt history (forbid_mutation).
--
-- Bounded retries / idempotent conditional ACK / allowlists are service-level
-- (print_job.retries already exists; ack matches lease_token + content_hash).

DO $$ BEGIN
  CREATE TYPE "printer_capability" AS ENUM ('ESC_POS_KOT', 'WINDOWS_DOCUMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "printer_transport" AS ENUM ('PHYSICAL', 'VIRTUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "print_attempt_result" AS ENUM ('PRINTED', 'FAILED', 'LEASE_EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "printer" ADD COLUMN IF NOT EXISTS "capability" "printer_capability" NOT NULL DEFAULT 'ESC_POS_KOT';--> statement-breakpoint
ALTER TABLE "printer" ADD COLUMN IF NOT EXISTS "transport" "printer_transport" NOT NULL DEFAULT 'PHYSICAL';--> statement-breakpoint

ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "capability" "printer_capability" NOT NULL DEFAULT 'ESC_POS_KOT';--> statement-breakpoint
ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "document_type" text;--> statement-breakpoint
ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "lease_token" text;--> statement-breakpoint
ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_job" ADD COLUMN IF NOT EXISTS "reprint_of_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "print_job" ADD CONSTRAINT "print_job_reprint_of_fk"
    FOREIGN KEY ("reprint_of_id") REFERENCES "print_job"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_job_lease_until_idx" ON "print_job" ("lease_until") WHERE "lease_until" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "print_job_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "print_job_id" uuid NOT NULL REFERENCES "print_job"("id"),
  "attempt_no" integer NOT NULL,
  "agent_id" uuid REFERENCES "print_agent"("id"),
  "lease_token" text NOT NULL,
  "result" "print_attempt_result" NOT NULL,
  "error" text,
  "content_hash" text,
  "claimed_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "print_job_attempt_no_positive" CHECK ("attempt_no" > 0),
  CONSTRAINT "print_job_attempt_job_no_unique" UNIQUE ("print_job_id", "attempt_no")
);--> statement-breakpoint
ALTER TABLE "print_job_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_job_attempt_job_idx" ON "print_job_attempt" ("print_job_id");--> statement-breakpoint
DROP TRIGGER IF EXISTS print_job_attempt_append_only ON "print_job_attempt";--> statement-breakpoint
CREATE TRIGGER print_job_attempt_append_only BEFORE UPDATE OR DELETE ON "print_job_attempt" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
