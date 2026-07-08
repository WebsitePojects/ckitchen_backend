-- ============================================================================
-- Migration 0025 — employee.work_days + employee.hired_at (Employee 360)
--
-- The Employee 360 profile needs two facts the employee row never carried:
--   1. WHEN they normally work — so a no-show on a scheduled day is an ABSENCE
--      while an unscheduled day is a REST day (not a miss).
--   2. WHEN they were hired — so scheduled days BEFORE the hire date are not
--      counted as absences (they are REST).
--
--   1. employee.work_days text NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI' — a CSV of
--      day tokens from MON,TUE,WED,THU,FRI,SAT,SUN (canonical Mon→Sun order).
--      Adding a NOT NULL column WITH a default backfills every existing row with
--      the standard 5-day work week.
--   2. employee.hired_at date NULL — the calendar hire day (no time); NULL when
--      unknown, in which case the profile falls back to created_at's date.
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: ADD
-- COLUMN IF NOT EXISTS on both, matching the 0018-0024 convention, so re-applying
-- (or applying to a DB already patched) never errors. Journal `when` =
-- 1784400000000 — strictly greater than 0024's 1784300000000 so the incremental
-- migrator does not skip it.
-- ============================================================================

ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "work_days" text NOT NULL DEFAULT 'MON,TUE,WED,THU,FRI';--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "hired_at" date;
