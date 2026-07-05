-- ── D30: brand_outlet many-to-many (a brand may operate in 2+ outlets) ────────
--
-- Hand-written (the drizzle snapshot chain has been hand-maintained since 0012;
-- next free number is 0015). Client confirmed one brand can be activated in
-- multiple branches simultaneously (D30).
--
-- TRANSITION STATE — READ BEFORE EXTENDING:
--   `brand.location_id` is deliberately KEPT as the brand's "home" outlet. It is
--   NOT dropped here: orders, reports, menu, and the PREPARING-deduction engine
--   all still key on `brand.location_id`. Dropping it now would ripple through
--   every one of those joins. This migration ONLY adds the deployment table and
--   backfills one active row per existing brand from `brand.location_id`.
--   Consumers migrate onto `brand_outlet` in a later pass.
--
-- RLS deny-all (no policy) per the 0009 hardening pattern: the app connects as
-- the table owner / service role and bypasses RLS; this is phase-2 defense.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE "brand_outlet" (
	"brand_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_outlet_brand_id_location_id_pk" PRIMARY KEY("brand_id","location_id")
);--> statement-breakpoint
ALTER TABLE "brand_outlet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_outlet" ADD CONSTRAINT "brand_outlet_brand_id_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brand"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_outlet" ADD CONSTRAINT "brand_outlet_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_outlet_location_id_idx" ON "brand_outlet" USING btree ("location_id");--> statement-breakpoint

-- Backfill: one active deployment per existing brand, from its home outlet.
INSERT INTO "brand_outlet" ("brand_id", "location_id", "is_active")
SELECT "id", "location_id", true FROM "brand"
ON CONFLICT ("brand_id", "location_id") DO NOTHING;
