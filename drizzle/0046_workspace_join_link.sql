-- ============================================================================
-- Migration 0046 -- workspace join links (fast-track onboarding, 2026-10-28).
--
-- WHY: Clerk invitations are bound to an email address, so an owner had to collect every
-- person's Gmail before they could get in. A join link is a one-time, expiring link the
-- owner sends by chat; whoever opens it signs in with ANY Google account and joins this
-- workspace with the role the owner chose. This is how CloudKitchen's owner and staff get in
-- before public self sign-up opens (that needs tenant isolation, SaaS steps 2-9).
--
-- The link token is never stored: it is `<id>.<HMAC(JWT_SECRET, id)>`, so the server can
-- verify it (and show it again to the owner) without keeping a bearer secret at rest.
-- Rotating JWT_SECRET invalidates every unused link.
--
-- One use only: redeeming is a conditional UPDATE (used_at IS NULL AND revoked_at IS NULL
-- AND expires_at > now()), so two simultaneous redeems cannot both create an account.
-- client_request_id makes "create link" safe against a double click (one row per intent).
--
-- Reversible: DROP TABLE "workspace_join_link";
-- ============================================================================
CREATE TABLE IF NOT EXISTS "workspace_join_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES "tenant"("id"),
  "role" "role" NOT NULL,
  -- Display name of the person the link is for; becomes their ORION user name.
  "invitee_name" text NOT NULL,
  -- Outlets granted on join (ignored for roles that see every outlet). Checked on redeem,
  -- so an outlet removed after the link was made is simply not granted.
  "outlet_ids" uuid[] NOT NULL DEFAULT '{}',
  "client_request_id" uuid NOT NULL,
  "created_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "used_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "workspace_join_link_invitee_name_length" CHECK (char_length(btrim("invitee_name")) BETWEEN 1 AND 120),
  CONSTRAINT "workspace_join_link_expiry_after_create" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_join_link_request_unique" ON "workspace_join_link" ("tenant_id", "client_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_join_link_tenant_created_idx" ON "workspace_join_link" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
-- Same posture as every other public table (migration 0039): closes the Data API path.
ALTER TABLE "workspace_join_link" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_join_link" FORCE ROW LEVEL SECURITY;
