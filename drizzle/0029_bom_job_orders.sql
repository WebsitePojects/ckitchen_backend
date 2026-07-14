-- ============================================================================
-- Migration 0029 — BOM and production (D35-D46 §6)
--
-- Additive/dark: introduces the BOM header/version/component definition chain
-- and the Job Order issue/output chain. Component-lot -> output-lot
-- traceability reuses the existing inventory_lot_genealogy table (0027); a Job
-- Order's job_order_no becomes that table's production_document_no. No
-- route/service wiring happens here; stock.production stays OFF (seeded false
-- in 0027) until the posting service and routes land.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "bom_version_status" AS ENUM('DRAFT','ACTIVE','RETIRED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "job_order_status" AS ENUM('DRAFT','SUBMITTED','APPROVED','RELEASED','IN_PROGRESS','COMPLETED','CANCELLED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bom_header" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "output_item_id" uuid NOT NULL,
  "production_mode" "consumption_mode" DEFAULT 'MADE_TO_ORDER' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "bom_header" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_output_item_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_header" ADD CONSTRAINT "bom_header_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bom_header_code_unique" ON "bom_header" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bom_header_output_item_idx" ON "bom_header" USING btree ("output_item_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION bom_header_output_item_type_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_item_type "item_type";
BEGIN
  SELECT "item_type" INTO v_item_type FROM "ingredient" WHERE "id" = NEW."output_item_id";
  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'bom_header.output_item_id % does not reference a known ingredient', NEW."output_item_id";
  END IF;
  IF v_item_type NOT IN ('RAW','WIP','FINISHED_GOOD','CONSUMABLE') THEN
    RAISE EXCEPTION 'bom_header.output_item_id must reference an item_type in (RAW,WIP,FINISHED_GOOD,CONSUMABLE), got %', v_item_type;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS bom_header_output_item_type_check ON "bom_header";--> statement-breakpoint
CREATE TRIGGER bom_header_output_item_type_check BEFORE INSERT OR UPDATE ON "bom_header" FOR EACH ROW EXECUTE FUNCTION bom_header_output_item_type_check();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bom_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bom_header_id" uuid NOT NULL,
  "version_no" integer NOT NULL,
  "status" "bom_version_status" DEFAULT 'DRAFT' NOT NULL,
  "output_uom" text NOT NULL,
  "output_yield_qty" numeric(20,6) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "remarks" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bom_version_yield_positive" CHECK ("output_yield_qty" > 0),
  CONSTRAINT "bom_version_number_positive" CHECK ("version_no" > 0),
  CONSTRAINT "bom_version_effective_range_valid" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);--> statement-breakpoint
ALTER TABLE "bom_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_version" ADD CONSTRAINT "bom_version_bom_header_id_fk" FOREIGN KEY ("bom_header_id") REFERENCES "public"."bom_header"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_version" ADD CONSTRAINT "bom_version_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_version" ADD CONSTRAINT "bom_version_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bom_version_header_version_unique" ON "bom_version" USING btree ("bom_header_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bom_version_one_active_per_header_unique" ON "bom_version" USING btree ("bom_header_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bom_version_header_status_idx" ON "bom_version" USING btree ("bom_header_id","status");--> statement-breakpoint

CREATE OR REPLACE FUNCTION bom_version_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."bom_header_id" <> OLD."bom_header_id"
       OR NEW."version_no" <> OLD."version_no"
       OR NEW."output_uom" <> OLD."output_uom"
       OR NEW."output_yield_qty" <> OLD."output_yield_qty"
       OR NEW."effective_from" <> OLD."effective_from" THEN
      RAISE EXCEPTION 'bom_version identity/output fields are immutable once status leaves DRAFT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS bom_version_write_guard ON "bom_version";--> statement-breakpoint
CREATE TRIGGER bom_version_write_guard BEFORE UPDATE ON "bom_version" FOR EACH ROW EXECUTE FUNCTION bom_version_write_guard();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bom_component" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bom_version_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "component_item_id" uuid NOT NULL,
  "component_uom" text NOT NULL,
  "base_quantity" numeric(20,6) NOT NULL,
  "scrap_allowance_pct" numeric(7,4) DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bom_component_line_positive" CHECK ("line_no" > 0),
  CONSTRAINT "bom_component_qty_positive" CHECK ("base_quantity" > 0),
  CONSTRAINT "bom_component_scrap_pct_range" CHECK ("scrap_allowance_pct" >= 0 AND "scrap_allowance_pct" < 100)
);--> statement-breakpoint
ALTER TABLE "bom_component" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_component" ADD CONSTRAINT "bom_component_bom_version_id_fk" FOREIGN KEY ("bom_version_id") REFERENCES "public"."bom_version"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "bom_component" ADD CONSTRAINT "bom_component_component_item_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bom_component_version_line_unique" ON "bom_component" USING btree ("bom_version_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bom_component_version_item_unique" ON "bom_component" USING btree ("bom_version_id","component_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bom_component_item_idx" ON "bom_component" USING btree ("component_item_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION bom_component_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_version_id uuid;
  v_status "bom_version_status";
  v_output_item_id uuid;
  v_component_item_type "item_type";
BEGIN
  v_version_id := COALESCE(NEW."bom_version_id", OLD."bom_version_id");
  SELECT bv."status", bh."output_item_id" INTO v_status, v_output_item_id
  FROM "bom_version" bv JOIN "bom_header" bh ON bh."id" = bv."bom_header_id"
  WHERE bv."id" = v_version_id;

  -- v_status is NULL when the parent bom_version row is gone already (mid cascade-delete
  -- of a still-DRAFT version) — that case must be allowed, not treated as "left DRAFT".
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'bom_component is immutable once its bom_version leaves DRAFT';
  END IF;

  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW."component_item_id" = v_output_item_id THEN
      RAISE EXCEPTION 'bom_component cannot reference its own bom output item (self-component)';
    END IF;
    SELECT "item_type" INTO v_component_item_type FROM "ingredient" WHERE "id" = NEW."component_item_id";
    IF v_component_item_type IS NULL THEN
      RAISE EXCEPTION 'bom_component.component_item_id % does not reference a known ingredient', NEW."component_item_id";
    END IF;
    IF v_component_item_type NOT IN ('RAW','WIP','FINISHED_GOOD','CONSUMABLE') THEN
      RAISE EXCEPTION 'bom_component.component_item_id must reference an item_type in (RAW,WIP,FINISHED_GOOD,CONSUMABLE), got %', v_component_item_type;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS bom_component_write_guard ON "bom_component";--> statement-breakpoint
CREATE TRIGGER bom_component_write_guard BEFORE INSERT OR UPDATE OR DELETE ON "bom_component" FOR EACH ROW EXECUTE FUNCTION bom_component_write_guard();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "job_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_order_no" text NOT NULL,
  "bom_header_id" uuid NOT NULL,
  "bom_version_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "production_warehouse_id" uuid NOT NULL,
  "status" "job_order_status" DEFAULT 'DRAFT' NOT NULL,
  "planned_output_qty" numeric(20,6) NOT NULL,
  "actual_output_qty" numeric(20,6),
  "output_uom" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "consume_document_id" uuid,
  "output_document_id" uuid,
  "remarks" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_by" uuid,
  "submitted_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "released_by" uuid,
  "released_at" timestamp with time zone,
  "operator_id" uuid,
  "operator_assigned_at" timestamp with time zone,
  "completed_by" uuid,
  "completed_at" timestamp with time zone,
  "cancelled_by" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "failed_at" timestamp with time zone,
  "failure_reason" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_order_planned_qty_positive" CHECK ("planned_output_qty" > 0),
  CONSTRAINT "job_order_actual_qty_nonnegative" CHECK ("actual_output_qty" IS NULL OR "actual_output_qty" >= 0),
  CONSTRAINT "job_order_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "job_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_bom_header_id_fk" FOREIGN KEY ("bom_header_id") REFERENCES "public"."bom_header"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_bom_version_id_fk" FOREIGN KEY ("bom_version_id") REFERENCES "public"."bom_version"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_production_warehouse_id_fk" FOREIGN KEY ("production_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_consume_document_id_fk" FOREIGN KEY ("consume_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_output_document_id_fk" FOREIGN KEY ("output_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_submitted_by_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_released_by_fk" FOREIGN KEY ("released_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_completed_by_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order" ADD CONSTRAINT "job_order_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_no_unique" ON "job_order" USING btree ("job_order_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_consume_document_unique" ON "job_order" USING btree ("consume_document_id") WHERE "consume_document_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_output_document_unique" ON "job_order" USING btree ("output_document_id") WHERE "output_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_order_location_status_idx" ON "job_order" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_order_bom_version_idx" ON "job_order" USING btree ("bom_version_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_order_production_warehouse_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_purpose "warehouse_purpose";
BEGIN
  SELECT "purpose" INTO v_purpose FROM "warehouse" WHERE "id" = NEW."production_warehouse_id";
  IF v_purpose IS DISTINCT FROM 'PRODUCTION' THEN
    RAISE EXCEPTION 'job_order.production_warehouse_id must reference a warehouse with purpose = PRODUCTION, got %', v_purpose;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS job_order_production_warehouse_check ON "job_order";--> statement-breakpoint
CREATE TRIGGER job_order_production_warehouse_check BEFORE INSERT OR UPDATE ON "job_order" FOR EACH ROW EXECUTE FUNCTION job_order_production_warehouse_check();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "job_order_component_allocation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_order_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "bom_component_id" uuid,
  "component_item_id" uuid NOT NULL,
  "source_lot_id" uuid,
  "source_warehouse_id" uuid NOT NULL,
  "planned_quantity" numeric(20,6) NOT NULL,
  "allocated_quantity" numeric(20,6),
  "entered_uom" text NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "consume_posting_line_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_order_component_allocation_line_positive" CHECK ("line_no" > 0),
  CONSTRAINT "job_order_component_allocation_planned_qty_positive" CHECK ("planned_quantity" > 0),
  CONSTRAINT "job_order_component_allocation_allocated_qty_nonnegative" CHECK ("allocated_quantity" IS NULL OR "allocated_quantity" >= 0),
  CONSTRAINT "job_order_component_allocation_conversion_positive" CHECK ("conversion_factor" > 0)
);--> statement-breakpoint
ALTER TABLE "job_order_component_allocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_job_order_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_order"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_bom_component_id_fk" FOREIGN KEY ("bom_component_id") REFERENCES "public"."bom_component"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_component_item_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_source_lot_id_fk" FOREIGN KEY ("source_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_source_warehouse_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_component_allocation" ADD CONSTRAINT "job_order_component_allocation_consume_posting_line_id_fk" FOREIGN KEY ("consume_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_component_allocation_job_line_unique" ON "job_order_component_allocation" USING btree ("job_order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_component_allocation_consume_posting_unique" ON "job_order_component_allocation" USING btree ("consume_posting_line_id") WHERE "consume_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_order_component_allocation_job_idx" ON "job_order_component_allocation" USING btree ("job_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_order_component_allocation_lot_warehouse_idx" ON "job_order_component_allocation" USING btree ("source_lot_id","source_warehouse_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_order_component_allocation_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."consume_posting_line_id" IS NOT NULL THEN
    RAISE EXCEPTION 'job_order_component_allocation is append-only once posted: % not allowed', TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS job_order_component_allocation_append_only ON "job_order_component_allocation";--> statement-breakpoint
CREATE TRIGGER job_order_component_allocation_append_only BEFORE UPDATE OR DELETE ON "job_order_component_allocation" FOR EACH ROW EXECUTE FUNCTION job_order_component_allocation_append_only();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "job_order_output_lot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_order_id" uuid NOT NULL,
  "output_lot_id" uuid NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "output_posting_line_id" uuid,
  "evidence_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_order_output_lot_qty_positive" CHECK ("quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "job_order_output_lot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_output_lot" ADD CONSTRAINT "job_order_output_lot_job_order_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_order"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_output_lot" ADD CONSTRAINT "job_order_output_lot_output_lot_id_fk" FOREIGN KEY ("output_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_order_output_lot" ADD CONSTRAINT "job_order_output_lot_output_posting_line_id_fk" FOREIGN KEY ("output_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_output_lot_job_lot_unique" ON "job_order_output_lot" USING btree ("job_order_id","output_lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_order_output_lot_posting_unique" ON "job_order_output_lot" USING btree ("output_posting_line_id") WHERE "output_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_order_output_lot_job_idx" ON "job_order_output_lot" USING btree ("job_order_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION job_order_output_lot_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."output_posting_line_id" IS NOT NULL THEN
    RAISE EXCEPTION 'job_order_output_lot is append-only once posted: % not allowed', TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS job_order_output_lot_append_only ON "job_order_output_lot";--> statement-breakpoint
CREATE TRIGGER job_order_output_lot_append_only BEFORE UPDATE OR DELETE ON "job_order_output_lot" FOR EACH ROW EXECUTE FUNCTION job_order_output_lot_append_only();
