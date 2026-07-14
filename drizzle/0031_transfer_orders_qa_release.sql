-- ============================================================================
-- Migration 0031 — HQ Transfer Order + QA Release (D35-D46 §2, allowed stock routes)
--
-- Additive/dark: introduces the HQ Transfer Order header/line (HQ_MAIN or
-- PRODUCTION -> OUTLET_STORAGE/PRODUCTION/HQ_MAIN) and QA Release header/line
-- (HQ QUARANTINE -> HQ_MAIN, reusable returned stock only) document families.
-- No route/service/feature flag wiring happens here; the future posting
-- service's HQ_TRANSFER route class will use these tables once it lands.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "transfer_order_status" AS ENUM('DRAFT','SUBMITTED','APPROVED','DISPATCHED','RECEIVED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "qa_release_status" AS ENUM('DRAFT','SUBMITTED','APPROVED','RELEASED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "transfer_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_no" text NOT NULL,
  "status" "transfer_order_status" DEFAULT 'DRAFT' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "source_warehouse_id" uuid NOT NULL,
  "destination_warehouse_id" uuid NOT NULL,
  "source_location_id" uuid NOT NULL,
  "destination_location_id" uuid NOT NULL,
  "dispatch_document_id" uuid,
  "receipt_document_id" uuid,
  "remarks" text,
  "requested_by" uuid,
  "requested_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "dispatched_by" uuid,
  "dispatched_at" timestamp with time zone,
  "received_by" uuid,
  "received_at" timestamp with time zone,
  "cancelled_by" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "transfer_order_version_positive" CHECK ("version" > 0),
  CONSTRAINT "transfer_order_source_destination_distinct" CHECK ("source_warehouse_id" <> "destination_warehouse_id")
);--> statement-breakpoint
ALTER TABLE "transfer_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_source_warehouse_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_destination_warehouse_id_fk" FOREIGN KEY ("destination_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_source_location_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_destination_location_id_fk" FOREIGN KEY ("destination_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_dispatch_document_id_fk" FOREIGN KEY ("dispatch_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_receipt_document_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_dispatched_by_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_received_by_fk" FOREIGN KEY ("received_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order" ADD CONSTRAINT "transfer_order_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_document_no_unique" ON "transfer_order" USING btree ("document_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_dispatch_document_unique" ON "transfer_order" USING btree ("dispatch_document_id") WHERE "dispatch_document_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_receipt_document_unique" ON "transfer_order" USING btree ("receipt_document_id") WHERE "receipt_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_order_source_status_idx" ON "transfer_order" USING btree ("source_warehouse_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_order_destination_status_idx" ON "transfer_order" USING btree ("destination_warehouse_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "transfer_order_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_id" uuid NOT NULL,
  "lot_id" uuid,
  "entered_uom" text NOT NULL,
  "entered_quantity" numeric(20,6) NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "base_quantity" numeric(20,6) NOT NULL,
  "dispatched_quantity" numeric(20,6),
  "received_quantity" numeric(20,6),
  "status" "transfer_order_status" DEFAULT 'DRAFT' NOT NULL,
  "dispatch_posting_line_id" uuid,
  "receipt_posting_line_id" uuid,
  "remarks" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "transfer_order_line_number_positive" CHECK ("line_no" > 0),
  CONSTRAINT "transfer_order_line_entered_qty_positive" CHECK ("entered_quantity" > 0),
  CONSTRAINT "transfer_order_line_conversion_positive" CHECK ("conversion_factor" > 0),
  CONSTRAINT "transfer_order_line_base_qty_positive" CHECK ("base_quantity" > 0),
  CONSTRAINT "transfer_order_line_dispatched_qty_nonnegative" CHECK ("dispatched_quantity" IS NULL OR "dispatched_quantity" >= 0),
  CONSTRAINT "transfer_order_line_received_qty_nonnegative" CHECK ("received_quantity" IS NULL OR "received_quantity" >= 0),
  CONSTRAINT "transfer_order_line_received_lte_dispatched" CHECK ("received_quantity" IS NULL OR ("dispatched_quantity" IS NOT NULL AND "received_quantity" <= "dispatched_quantity"))
);--> statement-breakpoint
ALTER TABLE "transfer_order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order_line" ADD CONSTRAINT "transfer_order_line_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."transfer_order"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order_line" ADD CONSTRAINT "transfer_order_line_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order_line" ADD CONSTRAINT "transfer_order_line_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order_line" ADD CONSTRAINT "transfer_order_line_dispatch_posting_line_id_fk" FOREIGN KEY ("dispatch_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "transfer_order_line" ADD CONSTRAINT "transfer_order_line_receipt_posting_line_id_fk" FOREIGN KEY ("receipt_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_line_order_line_unique" ON "transfer_order_line" USING btree ("order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_line_dispatch_posting_unique" ON "transfer_order_line" USING btree ("dispatch_posting_line_id") WHERE "dispatch_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_order_line_receipt_posting_unique" ON "transfer_order_line" USING btree ("receipt_posting_line_id") WHERE "receipt_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_order_line_item_lot_idx" ON "transfer_order_line" USING btree ("item_id","lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_order_line_order_status_idx" ON "transfer_order_line" USING btree ("order_id","status");--> statement-breakpoint

-- Phase-aware append-only guard. `dispatch_posting_line_id`, once set, cannot
-- be repointed (protects the dispatch-phase posting linkage even while the
-- row is still open for the receipt phase). The whole row becomes immutable
-- (including DELETE) once `receipt_posting_line_id` is set, i.e. once both
-- phases of the transfer have posted — mirrors the job_order_component_
-- allocation/job_order_output_lot append-only pattern (0029) but is
-- necessarily two-phase because dispatch and receipt share one line row here
-- instead of two separate tables (contrast stock_return_batch_line vs.
-- stock_return_receipt_line, 0028).
CREATE OR REPLACE FUNCTION transfer_order_line_posting_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."dispatch_posting_line_id" IS NOT NULL OR OLD."receipt_posting_line_id" IS NOT NULL THEN
      RAISE EXCEPTION 'transfer_order_line cannot be deleted once dispatch/receipt has posted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."dispatch_posting_line_id" IS NOT NULL AND NEW."dispatch_posting_line_id" IS DISTINCT FROM OLD."dispatch_posting_line_id" THEN
    RAISE EXCEPTION 'transfer_order_line.dispatch_posting_line_id is append-only once posted';
  END IF;
  IF OLD."receipt_posting_line_id" IS NOT NULL THEN
    RAISE EXCEPTION 'transfer_order_line is fully posted and immutable once receipt_posting_line_id is set';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_order_line_posting_append_only ON "transfer_order_line";--> statement-breakpoint
CREATE TRIGGER transfer_order_line_posting_append_only BEFORE UPDATE OR DELETE ON "transfer_order_line" FOR EACH ROW EXECUTE FUNCTION transfer_order_line_posting_append_only();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "qa_release" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_no" text NOT NULL,
  "status" "qa_release_status" DEFAULT 'DRAFT' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "source_warehouse_id" uuid NOT NULL,
  "destination_warehouse_id" uuid NOT NULL,
  "release_document_id" uuid,
  "remarks" text,
  "requested_by" uuid,
  "requested_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "released_by" uuid,
  "released_at" timestamp with time zone,
  "cancelled_by" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "qa_release_version_positive" CHECK ("version" > 0),
  CONSTRAINT "qa_release_source_destination_distinct" CHECK ("source_warehouse_id" <> "destination_warehouse_id")
);--> statement-breakpoint
ALTER TABLE "qa_release" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_source_warehouse_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_destination_warehouse_id_fk" FOREIGN KEY ("destination_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_release_document_id_fk" FOREIGN KEY ("release_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_released_by_fk" FOREIGN KEY ("released_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release" ADD CONSTRAINT "qa_release_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qa_release_document_no_unique" ON "qa_release" USING btree ("document_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qa_release_release_document_unique" ON "qa_release" USING btree ("release_document_id") WHERE "release_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_release_source_status_idx" ON "qa_release" USING btree ("source_warehouse_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_release_destination_status_idx" ON "qa_release" USING btree ("destination_warehouse_id","status");--> statement-breakpoint

-- Fixed-route guard (D35-D46 §2: "HQ QUARANTINE -> HQ_MAIN | QA Release | Yes,
-- only for reusable stock"). Unlike transfer_order (whose route table has
-- several legal (source, destination) purpose pairs and stays service-level),
-- qa_release has exactly one legal route, so it can be pinned here with a
-- single-row purpose lookup per referenced warehouse — same shape as
-- job_order_production_warehouse_check (0029).
CREATE OR REPLACE FUNCTION qa_release_route_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_source_purpose "warehouse_purpose";
  v_destination_purpose "warehouse_purpose";
BEGIN
  SELECT "purpose" INTO v_source_purpose FROM "warehouse" WHERE "id" = NEW."source_warehouse_id";
  SELECT "purpose" INTO v_destination_purpose FROM "warehouse" WHERE "id" = NEW."destination_warehouse_id";
  IF v_source_purpose IS DISTINCT FROM 'QUARANTINE' THEN
    RAISE EXCEPTION 'qa_release.source_warehouse_id must reference a warehouse with purpose = QUARANTINE, got %', v_source_purpose;
  END IF;
  IF v_destination_purpose IS DISTINCT FROM 'HQ_MAIN' THEN
    RAISE EXCEPTION 'qa_release.destination_warehouse_id must reference a warehouse with purpose = HQ_MAIN, got %', v_destination_purpose;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS qa_release_route_check ON "qa_release";--> statement-breakpoint
CREATE TRIGGER qa_release_route_check BEFORE INSERT OR UPDATE ON "qa_release" FOR EACH ROW EXECUTE FUNCTION qa_release_route_check();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "qa_release_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "release_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_id" uuid NOT NULL,
  "quarantine_lot_id" uuid NOT NULL,
  "source_return_receipt_line_id" uuid NOT NULL,
  "release_quantity" numeric(20,6) NOT NULL,
  "entered_uom" text NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "release_posting_line_id" uuid,
  "remarks" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "qa_release_line_number_positive" CHECK ("line_no" > 0),
  CONSTRAINT "qa_release_line_release_qty_positive" CHECK ("release_quantity" > 0),
  CONSTRAINT "qa_release_line_conversion_positive" CHECK ("conversion_factor" > 0)
);--> statement-breakpoint
ALTER TABLE "qa_release_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release_line" ADD CONSTRAINT "qa_release_line_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."qa_release"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release_line" ADD CONSTRAINT "qa_release_line_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release_line" ADD CONSTRAINT "qa_release_line_quarantine_lot_id_fk" FOREIGN KEY ("quarantine_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release_line" ADD CONSTRAINT "qa_release_line_source_return_receipt_line_id_fk" FOREIGN KEY ("source_return_receipt_line_id") REFERENCES "public"."stock_return_receipt_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "qa_release_line" ADD CONSTRAINT "qa_release_line_release_posting_line_id_fk" FOREIGN KEY ("release_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qa_release_line_release_line_unique" ON "qa_release_line" USING btree ("release_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qa_release_line_release_posting_unique" ON "qa_release_line" USING btree ("release_posting_line_id") WHERE "release_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_release_line_item_lot_idx" ON "qa_release_line" USING btree ("item_id","quarantine_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qa_release_line_source_receipt_line_idx" ON "qa_release_line" USING btree ("source_return_receipt_line_id");--> statement-breakpoint

-- Append-only once posted, mirroring job_order_output_lot_append_only (0029):
-- a single-phase posting event per line (unlike transfer_order_line, QA
-- Release has no separate dispatch/receive phases), so a blanket guard keyed
-- on release_posting_line_id is sufficient.
CREATE OR REPLACE FUNCTION qa_release_line_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."release_posting_line_id" IS NOT NULL THEN
    RAISE EXCEPTION 'qa_release_line is append-only once posted: % not allowed', TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS qa_release_line_append_only ON "qa_release_line";--> statement-breakpoint
CREATE TRIGGER qa_release_line_append_only BEFORE UPDATE OR DELETE ON "qa_release_line" FOR EACH ROW EXECUTE FUNCTION qa_release_line_append_only();
