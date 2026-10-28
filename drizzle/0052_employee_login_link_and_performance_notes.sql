-- ============================================================================
-- Migration 0052 -- one login per employee, and a manual performance log (D58).
--
-- WHY (1): employee.user_id had only a plain index, so the same login could be linked to
-- two employee rows. Clock-in, "my attendance" and the employee summary then picked one of
-- them at random. A login now belongs to at most one employee in its workspace. Production
-- was checked first: no workspace had a login linked twice.
--
-- WHY (2): staff who never sign in (cooks, riders, cleaners) had no performance record at
-- all, because the only "performance" was the audit trail of a login. Owners and HR now
-- write dated notes (commendation, concern, review, incident, note) with an optional 1-5
-- rating. Notes are never edited or deleted: a wrong note is voided with a reason, so the
-- history an employee is judged on cannot be rewritten quietly.
--
-- WHY (3): an employee's system summary reads one person's audit rows for one month. The
-- old index was on actor_user_id alone, so that read walked the person's whole history.
--
-- client_request_id makes "save this note" safe against a double click (one row per intent).
-- Same wall as every workspace table (0049): tenant_id defaults to the connected workspace,
-- RLS forced, policy tenant_isolation.
--
-- Reversible: DROP TABLE "employee_performance_note"; DROP INDEX "employee_user_link_unique";
--             DROP INDEX "audit_log_actor_created_idx";
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS "employee_user_link_unique" ON "employee" ("tenant_id", "user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_performance_note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL DEFAULT coalesce(current_tenant_id(), '00000000-0000-4000-8000-000000000001'::uuid) REFERENCES "tenant"("id"),
  "employee_id" uuid NOT NULL REFERENCES "employee"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "rating" smallint,
  "title" text NOT NULL,
  "body" text,
  "occurred_on" date NOT NULL,
  "client_request_id" uuid NOT NULL,
  "recorded_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "recorded_by_name" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "voided_at" timestamptz,
  "voided_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "void_reason" text,
  CONSTRAINT "employee_performance_note_kind" CHECK ("kind" IN ('COMMENDATION', 'CONCERN', 'REVIEW', 'INCIDENT', 'NOTE')),
  CONSTRAINT "employee_performance_note_rating" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  CONSTRAINT "employee_performance_note_title_length" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "employee_performance_note_void_reason" CHECK ("voided_at" IS NULL OR char_length(btrim(coalesce("void_reason", ''))) >= 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_performance_note_request_unique" ON "employee_performance_note" ("tenant_id", "client_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_performance_note_employee_idx" ON "employee_performance_note" ("employee_id", "occurred_on" DESC);
--> statement-breakpoint
ALTER TABLE "employee_performance_note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "employee_performance_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "employee_performance_note";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "employee_performance_note" AS PERMISSIVE FOR ALL TO orion_tenant
  USING (tenant_id = (SELECT current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT current_tenant_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_performance_note" TO orion_tenant;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_created_idx" ON "audit_log" ("actor_user_id", "created_at" DESC);
