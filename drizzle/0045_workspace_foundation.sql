-- ============================================================================
-- Migration 0045 -- workspace (tenant) foundation, SaaS step 1 of 9 (D52).
--
-- WHY: ORION is becoming a product where any business owner can sign up and get their own
-- workspace. Today every row belongs to one business. This step only ADDS the workspace
-- tables and records the existing business as workspace #1; nothing reads them yet, so
-- behaviour is unchanged (see .claude/context/saas-database-design.md section 8).
--
--   tenant           one row per workspace (business). Clerk Organization id is its
--                    identity once linked, never its authority.
--   membership       who belongs to which workspace, with which role. One person can own
--                    one business and be staff in another. Becomes the authority in step 6;
--                    until then `user.role` stays authoritative and is mirrored here.
--   tenant_settings  per-workspace values that live in env today (timezone, business day).
--
-- Workspace #1 has the FIXED id 00000000-0000-4000-8000-000000000001 so later steps can use
-- it as the backfill value for tenant_id.
--
-- Transitional: the trigger `user_membership_mirror` keeps workspace #1 memberships equal to
-- user.role/user.status for every insert or change, so no write path can drift before step 6
-- removes it.
--
-- Reversible: DROP TRIGGER user_membership_mirror ON "user"; DROP FUNCTION
-- mirror_user_membership(); DROP TABLE tenant_settings, membership, tenant;
-- ============================================================================
CREATE TABLE IF NOT EXISTS "tenant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "clerk_org_id" text,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- Used in URLs (/t/<slug>): lowercase letters, digits and inner hyphens, 3-40 characters.
  CONSTRAINT "tenant_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  CONSTRAINT "tenant_name_length" CHECK (char_length(btrim("name")) BETWEEN 2 AND 120),
  CONSTRAINT "tenant_status_check" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_slug_unique" ON "tenant" ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_clerk_org_unique" ON "tenant" ("clerk_org_id") WHERE "clerk_org_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" "role" NOT NULL,
  "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
  -- Bumped on every role/status/scope change so cached authorizations can be dropped.
  "authz_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_tenant_user_unique" ON "membership" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_user_idx" ON "membership" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenant"("id"),
  "timezone" text NOT NULL DEFAULT 'Asia/Manila',
  "business_day_start_hour" smallint NOT NULL DEFAULT 5,
  "currency" text NOT NULL DEFAULT 'PHP',
  -- NULL = use the platform default from env.
  "alert_unattended_minutes" integer,
  "alert_stuck_minutes" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_settings_day_start_check" CHECK ("business_day_start_hour" BETWEEN 0 AND 23),
  CONSTRAINT "tenant_settings_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "tenant_settings_alert_minutes_check" CHECK (
    ("alert_unattended_minutes" IS NULL OR "alert_unattended_minutes" > 0)
    AND ("alert_stuck_minutes" IS NULL OR "alert_stuck_minutes" > 0)
  )
);
--> statement-breakpoint
INSERT INTO "tenant" ("id", "slug", "name")
VALUES ('00000000-0000-4000-8000-000000000001', 'cloudkitchen', 'CloudKitchen')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "tenant_settings" ("tenant_id")
VALUES ('00000000-0000-4000-8000-000000000001')
ON CONFLICT ("tenant_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "membership" ("tenant_id", "user_id", "role", "status")
SELECT '00000000-0000-4000-8000-000000000001', "id", "role", "status" FROM "user"
ON CONFLICT ("tenant_id", "user_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mirror_user_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "membership" ("tenant_id", "user_id", "role", "status")
  VALUES ('00000000-0000-4000-8000-000000000001', NEW."id", NEW."role", NEW."status")
  ON CONFLICT ("tenant_id", "user_id") DO UPDATE
    SET "role" = EXCLUDED."role",
        "status" = EXCLUDED."status",
        "authz_version" = "membership"."authz_version" + 1,
        "updated_at" = now()
    WHERE ("membership"."role", "membership"."status") IS DISTINCT FROM (EXCLUDED."role", EXCLUDED."status");
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_membership_mirror" ON "user";
--> statement-breakpoint
CREATE TRIGGER "user_membership_mirror"
AFTER INSERT OR UPDATE OF "role", "status" ON "user"
FOR EACH ROW EXECUTE FUNCTION mirror_user_membership();
--> statement-breakpoint
-- Same posture as every other public table (migration 0039): RLS on and forced. The app
-- connects as the table owner with BYPASSRLS, so this only closes the Data API path.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
