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
-- ============================================================================

CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'BLOCKED');--> statement-breakpoint
CREATE TABLE "role_page_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "role" NOT NULL,
	"page_key" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_page_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "status" "user_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_page_access_role_page_unique" ON "role_page_access" USING btree ("role","page_key");
