-- ============================================================================
-- Migration 0026 — employee.location_id (per-outlet employee assignment)
--
-- Client ask (2026-07-09): tie an employee to the physical outlet they work
-- at, so EMS screens can scope staff lists per outlet the same way orders,
-- ITOs, and print jobs already are (D22 tenancy).
--
--   employee.location_id uuid NULL REFERENCES location(id) — NULL means the
--   employee is unassigned / HQ (not yet tied to a physical outlet). Nullable
--   so every existing employee row (created before this migration) stays
--   valid without a backfill.
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: ADD
-- COLUMN IF NOT EXISTS, a guarded FK add (DO..EXCEPTION duplicate_object), and
-- CREATE INDEX IF NOT EXISTS, matching the 0018-0025 convention. Journal
-- `when` = 1784500000000 — strictly greater than 0025's 1784400000000 so the
-- incremental migrator does not skip it.
-- ============================================================================

ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "location_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "employee" ADD CONSTRAINT "employee_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_location_id_idx" ON "employee" USING btree ("location_id");
