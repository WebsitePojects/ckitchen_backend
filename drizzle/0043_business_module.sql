-- ============================================================================
-- Migration 0043 -- business modules the owner can switch on or off.
--
-- WHY: not every business uses every part of ORION (e.g. a kitchen with no Print
-- Agent yet, or no purchasing team). The owner turns whole modules off and their
-- pages disappear for everyone; turning them back on restores them. The catalog of
-- modules and the pages each covers lives in code (business-modules/catalog.ts); this
-- table only stores the owner's choice. A module with no row is ON, so existing
-- deployments keep every page until the owner changes something.
--
-- Additive and reversible (DROP TABLE).
-- ============================================================================
CREATE TABLE IF NOT EXISTS "business_module" (
  "key" text PRIMARY KEY,
  "enabled" boolean NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "user"("id")
);
--> statement-breakpoint
-- Same posture as every other public table (migration 0039): RLS on and forced. The app
-- connects as the table owner with BYPASSRLS, so this only closes the Data API path.
ALTER TABLE "business_module" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_module" FORCE ROW LEVEL SECURITY;
