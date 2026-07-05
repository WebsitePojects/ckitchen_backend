-- ── SF-2: per-agent hashed print-agent tokens + location binding ────────────
--
-- audit-backend.md CRITICAL #2: "Print-agent token cosmetic — one process-wide
-- AGENT_TOKEN, stored plaintext per row, not bound to agent/location; any
-- token-holder can claim any location; ack/printers/status do no location
-- check." Fix: per-agent random tokens, stored as a sha256 hex digest (NOT
-- bcrypt — the pull/ack/heartbeat loop needs a deterministic, indexable
-- lookup on every request; a salted bcrypt hash cannot be looked up by value).
--
-- Hand-written (not `drizzle-kit generate`): the drizzle snapshot chain is
-- already broken as of migration 0012 (no 0012_snapshot.json was ever
-- committed — that migration was also hand-authored for the same reason:
-- PostgreSQL forbids using a same-transaction `ALTER TYPE ... ADD VALUE`).
-- Running `drizzle-kit generate` today re-diffs against the stale 0011
-- snapshot and regenerates 0012's already-applied DDL a second time — verified
-- empirically while preparing this migration and discarded. Someone should
-- reconcile the snapshot chain in a follow-up (see checkpoint notes); until
-- then, hand-write migrations that touch anything touched by 0012 (roles),
-- or, like this one, anything additive-only that a manual diff can verify.
--
-- `api_token` (the old shared-secret column) is kept but no longer NOT NULL:
-- new registrations stop populating it (they generate + hash a per-agent
-- token instead); dropping/backfilling it is a follow-up once the deployed
-- .NET agent fleet has all re-registered post-rollout.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "print_agent" ALTER COLUMN "api_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "print_agent" ADD COLUMN "token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "print_agent_token_hash_unique" ON "print_agent" USING btree ("token_hash");
