-- ============================================================================
-- Migration 0050 -- paired kiosk screens (attendance kiosk per workspace, D56).
--
-- WHY: the public attendance kiosk has no signed-in user, so until now it always served
-- workspace #1 (CloudKitchen) to anyone who opened /kiosk/attendance, including other
-- businesses. A kiosk screen is now paired by a signed-in owner/HR: the screen keeps a
-- signed token `<id>.<HMAC>` (nothing secret stored), and every kiosk call runs as the
-- workspace of that row. Revoking the row cuts the screen off.
--
-- Same wall as every workspace table (0049): tenant_id defaults to the connected
-- workspace, RLS forced, policy tenant_isolation. client_request_id makes "pair this
-- screen" safe against a double click (one row per intent).
--
-- Reversible: DROP TABLE "kiosk_device";
-- ============================================================================
CREATE TABLE IF NOT EXISTS "kiosk_device" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL DEFAULT coalesce(current_tenant_id(), '00000000-0000-4000-8000-000000000001'::uuid) REFERENCES "tenant"("id"),
  "name" text NOT NULL,
  "client_request_id" uuid NOT NULL,
  "created_by_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "kiosk_device_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kiosk_device_request_unique" ON "kiosk_device" ("tenant_id", "client_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kiosk_device_tenant_created_idx" ON "kiosk_device" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "kiosk_device" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kiosk_device" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "kiosk_device";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "kiosk_device" AS PERMISSIVE FOR ALL TO orion_tenant
  USING (tenant_id = (SELECT current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT current_tenant_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "kiosk_device" TO orion_tenant;
