-- ============================================================================
-- Migration 0054 -- sales channels the owner manages (D60).
--
-- WHY: the channel an order came from was a fixed enum (FOODPANDA, GRABFOOD, OTHER). An owner
-- selling on Lalamove, ShopeeFood, Facebook or by phone could only call it "OTHER", so reports
-- lumped them together and the New Order screen could not offer them. Channels are now rows
-- per workspace: name, colour, default commission / marketing %, active.
--
-- What stays fixed is the INTEGRATION a channel uses, because API adapters are code:
-- GRABFOOD and FOODPANDA (partner APIs) or MANUAL (orders keyed in by staff). The old
-- aggregator column keeps meaning exactly that ("integration family": a MANUAL channel's
-- listings are aggregator OTHER), so partner routing, idempotency and every existing query keep
-- working unchanged.
--
-- System channels (code GRABFOOD / FOODPANDA / WALK_IN) exist in every workspace; a trigger
-- links each new listing to the channel of its aggregator when the inserting code does not
-- name one, so older insert paths (partner scripts, walk-in, seeds) stay consistent.
--
-- Reversible: DROP TRIGGER aggregator_account_default_channel ON aggregator_account;
--   DROP FUNCTION aggregator_account_default_channel(); ALTER TABLE aggregator_account
--   DROP COLUMN channel_id; DROP FUNCTION ensure_system_sales_channels(uuid); DROP TABLE sales_channel;
-- ============================================================================
CREATE TABLE IF NOT EXISTS "sales_channel" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL DEFAULT coalesce(current_tenant_id(), '00000000-0000-4000-8000-000000000001'::uuid) REFERENCES "tenant"("id"),
  "code" text,
  "name" text NOT NULL,
  "integration" text NOT NULL,
  "color" text NOT NULL DEFAULT '#64748B',
  "default_commission_rate" numeric(5, 2),
  "default_marketing_rate" numeric(5, 2),
  "is_active" boolean NOT NULL DEFAULT true,
  "client_request_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sales_channel_integration" CHECK ("integration" IN ('GRABFOOD', 'FOODPANDA', 'MANUAL')),
  CONSTRAINT "sales_channel_code" CHECK ("code" IS NULL OR "code" IN ('GRABFOOD', 'FOODPANDA', 'WALK_IN')),
  CONSTRAINT "sales_channel_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  CONSTRAINT "sales_channel_color" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT "sales_channel_commission_range" CHECK ("default_commission_rate" IS NULL OR ("default_commission_rate" >= 0 AND "default_commission_rate" <= 100)),
  CONSTRAINT "sales_channel_marketing_range" CHECK ("default_marketing_rate" IS NULL OR ("default_marketing_rate" >= 0 AND "default_marketing_rate" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_channel_name_unique" ON "sales_channel" ("tenant_id", lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_channel_code_unique" ON "sales_channel" ("tenant_id", "code") WHERE "code" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_channel_request_unique" ON "sales_channel" ("tenant_id", "client_request_id") WHERE "client_request_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_channel" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales_channel" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "sales_channel";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sales_channel" AS PERMISSIVE FOR ALL TO orion_tenant
  USING (tenant_id = (SELECT current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT current_tenant_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_channel" TO orion_tenant;
--> statement-breakpoint
-- Idempotent: inserts whichever of the three system channels a workspace is missing.
CREATE OR REPLACE FUNCTION ensure_system_sales_channels(ws uuid) RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO sales_channel (tenant_id, code, name, integration, color)
  SELECT ws, v.code, v.name, v.integration, v.color
  FROM (VALUES
    ('GRABFOOD', 'GrabFood', 'GRABFOOD', '#00B14F'),
    ('FOODPANDA', 'foodpanda', 'FOODPANDA', '#D70F64'),
    ('WALK_IN', 'Walk-in / Direct', 'MANUAL', '#64748B')
  ) AS v(code, name, integration, color)
  WHERE NOT EXISTS (SELECT 1 FROM sales_channel s WHERE s.tenant_id = ws AND (s.code = v.code OR lower(btrim(s.name)) = lower(v.name)))
$fn$;
--> statement-breakpoint
SELECT ensure_system_sales_channels(t.id) FROM tenant t;
--> statement-breakpoint
ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "sales_channel"("id");
--> statement-breakpoint
UPDATE aggregator_account a SET channel_id = c.id
FROM sales_channel c
WHERE a.channel_id IS NULL AND c.tenant_id = a.tenant_id
  AND c.code = CASE a.aggregator WHEN 'GRABFOOD' THEN 'GRABFOOD' WHEN 'FOODPANDA' THEN 'FOODPANDA' ELSE 'WALK_IN' END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_account_channel_idx" ON "aggregator_account" ("channel_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION aggregator_account_default_channel() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.channel_id IS NULL THEN
    PERFORM ensure_system_sales_channels(NEW.tenant_id);
    SELECT id INTO NEW.channel_id FROM sales_channel
    WHERE tenant_id = NEW.tenant_id
      AND code = CASE NEW.aggregator WHEN 'GRABFOOD' THEN 'GRABFOOD' WHEN 'FOODPANDA' THEN 'FOODPANDA' ELSE 'WALK_IN' END;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS aggregator_account_default_channel ON "aggregator_account";
--> statement-breakpoint
CREATE TRIGGER aggregator_account_default_channel BEFORE INSERT ON "aggregator_account"
  FOR EACH ROW EXECUTE FUNCTION aggregator_account_default_channel();
