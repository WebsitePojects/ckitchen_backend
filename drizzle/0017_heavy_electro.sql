-- ============================================================================
-- Migration 0017 — W5 admin backend: account status + role→page access matrix
--
-- Produced by `drizzle-kit generate` (journal + 0017_snapshot.json are the tool's
-- own output — the snapshot now captures the FULL current schema, which repairs
-- the diff chain that has been stale since 0011 — see 0013/0016 headers).
--
-- The generator, diffing against the stale 0011 snapshot, ALSO re-emitted DDL
-- that migrations 0012–0016 already applied (role enum ADD VALUEs, brand_outlet,
-- user_outlet_access, print_agent token_hash + name/location index,
-- aggregator_account.commission_rate). Those statements are removed here — they
-- would fail on a fresh chain (duplicate table/enum value; and `ALTER TYPE ...
-- ADD VALUE` cannot run inside the migrator's single wrapping transaction). What
-- remains is the genuinely-new, additive delta for this migration:
--   • user_status enum (ACTIVE | BLOCKED)
--   • user.status column, default ACTIVE
--   • role_page_access table (admin-editable role→page visibility matrix)
--
-- IDEMPOTENT: every statement is guarded (DO/IF NOT EXISTS) so re-applying is a
-- safe no-op. This matters because the journal `when` for this entry had to be
-- corrected upward (it was generated BELOW 0015/0016's hand-rounded timestamps,
-- so the incremental Postgres migrator skipped it against Supabase). Bumping the
-- timestamp makes any DB that already ran the pre-fix 0017 re-run it — the
-- guards below make that harmless.
-- ============================================================================

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
		CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'BLOCKED');
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_page_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "role" NOT NULL,
	"page_key" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_page_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "status" "user_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_page_access_role_page_unique" ON "role_page_access" USING btree ("role","page_key");
