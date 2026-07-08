-- ============================================================================
-- Migration 0019 — Department budget threshold for purchasing
-- (MOTM 2026-06-24 budget-threshold item: each department has a monthly peso
-- budget; Purchase Requests WARN — not block, first cut — when submitting would
-- push the department's committed spend over the cap.)
--
-- Produced by `drizzle-kit generate` diffing against 0018's snapshot. The
-- generate came out clean: a pure addition (1 table, 1 FK to "user", 1 unique
-- index) with no re-emitted already-applied DDL to strip. Reuses the existing
-- "department" enum — no new type.
--
-- IDEMPOTENT: every statement is guarded (IF NOT EXISTS / DO..EXCEPTION) so
-- re-applying is a safe no-op, matching the 0018 convention. The journal `when`
-- for this entry is set to 1783800000000 — strictly greater than 0018's
-- 1783700000000 — so the incremental Postgres migrator does not silently skip
-- it (the class of bug 0017/0018's headers document fixing).
-- ============================================================================

CREATE TABLE IF NOT EXISTS "department_budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department" "department" NOT NULL,
	"period_month" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "department_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "department_budget" ADD CONSTRAINT "department_budget_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "department_budget_dept_period_unique" ON "department_budget" USING btree ("department","period_month");
