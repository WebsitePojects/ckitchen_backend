-- ============================================================================
-- Migration 0042 -- link ORION users to Clerk identities.
--
-- WHY: sign-in moves to Clerk (Google / email). Clerk proves WHO someone is; ORION
-- still decides WHAT they may do (role, outlets) from its own user row. The first
-- time an invited person signs in, their Clerk user id is linked to the ORION user
-- whose email matches their VERIFIED Clerk email; afterwards lookups go by this id.
--
-- Unique when set, so one Clerk account can never map to two ORION users (or the
-- reverse). Nullable: password-only (IT break-glass) users and not-yet-signed-in
-- invitees have no Clerk id.
--
-- The lower(email) index backs the case-insensitive email match used for linking.
-- Additive and reversible (DROP INDEX / DROP COLUMN).
-- ============================================================================
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "clerk_user_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_clerk_user_id_unique" ON "user" ("clerk_user_id") WHERE "clerk_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_email_lower_idx" ON "user" (lower("email"));
