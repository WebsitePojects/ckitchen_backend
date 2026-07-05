-- ============================================================================
-- Migration 0016 — unique index on print_agent (name, location_id)  [L4a]
--
-- Fable review 2026-07-05 L4: registerAgent() does select-then-insert with no
-- unique guard, so two concurrent /agent/register calls for the same
-- (name, location) can both miss the SELECT and each INSERT a row — a duplicate
-- agent identity. Add a unique index so the DB rejects the second insert.
--
-- Hand-written (not `drizzle-kit generate`): the drizzle snapshot chain has been
-- broken since 0012 (see 0013's header for the full explanation), so additive,
-- manually-verifiable DDL is hand-authored to avoid re-diffing a stale snapshot.
--
-- Dedupe-before-index: a dev/pre-prod DB may already hold duplicate
-- (name, location_id) rows from the pre-index race. A UNIQUE INDEX would fail to
-- build against them, so we first delete all but ONE row per group, keeping the
-- NEWEST by last_seen (tie-break: greatest id). print_agent has no created_at,
-- so last_seen is the best available recency signal; a NULL last_seen sorts
-- oldest. Rows with a NULL name are left alone — the unique index treats NULLs
-- as distinct, so they never conflict and never needed an identity anyway.
-- ============================================================================

DELETE FROM "print_agent" a
USING "print_agent" b
WHERE a."name" IS NOT NULL
  AND a."name" = b."name"
  AND a."location_id" = b."location_id"
  AND (
    COALESCE(a."last_seen", 'epoch'::timestamptz) < COALESCE(b."last_seen", 'epoch'::timestamptz)
    OR (
      COALESCE(a."last_seen", 'epoch'::timestamptz) = COALESCE(b."last_seen", 'epoch'::timestamptz)
      AND a."id" < b."id"
    )
  );--> statement-breakpoint
CREATE UNIQUE INDEX "print_agent_name_location_unique" ON "print_agent" USING btree ("name","location_id");
