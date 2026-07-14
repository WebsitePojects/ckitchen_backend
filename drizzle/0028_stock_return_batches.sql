-- ============================================================================
-- Migration 0028 — Stock Return Batch (D35-D46 §5, outlet return and disposition)
--
-- Additive/dark: introduces the outlet -> HQ Stock Return Batch header, its
-- multi-line body, and per-line HQ receipt/disposition evidence. No route,
-- service, or feature flag wiring happens here; stock.returns stays OFF
-- (seeded false in 0027) until the posting service and routes land.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "stock_return_batch_status" AS ENUM('DRAFT','SUBMITTED','APPROVED','DISPATCHED','RECEIVED_DISPOSED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "stock_return_reason" AS ENUM('SPOILED','EXPIRED','DAMAGED','RECALLED','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_return_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_no" text NOT NULL,
  "source_location_id" uuid NOT NULL,
  "destination_location_id" uuid NOT NULL,
  "destination_warehouse_id" uuid NOT NULL,
  "status" "stock_return_batch_status" DEFAULT 'DRAFT' NOT NULL,
  "remarks" text,
  "version" integer DEFAULT 1 NOT NULL,
  "dispatch_document_id" uuid,
  "receipt_document_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_by" uuid,
  "submitted_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "dispatched_by" uuid,
  "dispatched_at" timestamp with time zone,
  "received_by" uuid,
  "received_at" timestamp with time zone,
  "cancelled_by" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_return_batch_version_positive" CHECK ("version" > 0),
  CONSTRAINT "stock_return_batch_source_destination_distinct" CHECK ("source_location_id" <> "destination_location_id")
);--> statement-breakpoint
ALTER TABLE "stock_return_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_source_location_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_destination_location_id_fk" FOREIGN KEY ("destination_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_destination_warehouse_id_fk" FOREIGN KEY ("destination_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_dispatch_document_id_fk" FOREIGN KEY ("dispatch_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_receipt_document_id_fk" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."operational_document"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_submitted_by_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_dispatched_by_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_received_by_fk" FOREIGN KEY ("received_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch" ADD CONSTRAINT "stock_return_batch_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_batch_document_no_unique" ON "stock_return_batch" USING btree ("document_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_batch_dispatch_document_unique" ON "stock_return_batch" USING btree ("dispatch_document_id") WHERE "dispatch_document_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_batch_receipt_document_unique" ON "stock_return_batch" USING btree ("receipt_document_id") WHERE "receipt_document_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_return_batch_source_status_idx" ON "stock_return_batch" USING btree ("source_location_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_return_batch_destination_status_idx" ON "stock_return_batch" USING btree ("destination_location_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_return_batch_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL,
  "source_warehouse_id" uuid NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "entered_quantity" numeric(20,6) NOT NULL,
  "entered_uom" text NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "reason_code" "stock_return_reason" NOT NULL,
  "remarks" text,
  "evidence_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_return_batch_line_number_positive" CHECK ("line_no" > 0),
  CONSTRAINT "stock_return_batch_line_qty_positive" CHECK ("quantity" > 0),
  CONSTRAINT "stock_return_batch_line_entered_qty_positive" CHECK ("entered_quantity" > 0),
  CONSTRAINT "stock_return_batch_line_conversion_positive" CHECK ("conversion_factor" > 0)
);--> statement-breakpoint
ALTER TABLE "stock_return_batch_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch_line" ADD CONSTRAINT "stock_return_batch_line_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_return_batch"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch_line" ADD CONSTRAINT "stock_return_batch_line_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch_line" ADD CONSTRAINT "stock_return_batch_line_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_batch_line" ADD CONSTRAINT "stock_return_batch_line_source_warehouse_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_batch_line_batch_line_unique" ON "stock_return_batch_line" USING btree ("batch_id","line_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_return_batch_line_item_lot_idx" ON "stock_return_batch_line" USING btree ("item_id","lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_return_batch_line_source_warehouse_idx" ON "stock_return_batch_line" USING btree ("source_warehouse_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_return_receipt_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_line_id" uuid NOT NULL,
  "quarantine_lot_id" uuid NOT NULL,
  "received_quantity" numeric(20,6) NOT NULL,
  "disposition_reason_code" "stock_return_reason" NOT NULL,
  "disposition_remarks" text,
  "quarantine_in_posting_line_id" uuid,
  "disposition_out_posting_line_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_return_receipt_line_qty_nonnegative" CHECK ("received_quantity" >= 0),
  CONSTRAINT "stock_return_receipt_line_posting_lines_distinct" CHECK ("quarantine_in_posting_line_id" IS NULL OR "disposition_out_posting_line_id" IS NULL OR "quarantine_in_posting_line_id" <> "disposition_out_posting_line_id")
);--> statement-breakpoint
ALTER TABLE "stock_return_receipt_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_receipt_line" ADD CONSTRAINT "stock_return_receipt_line_batch_line_id_fk" FOREIGN KEY ("batch_line_id") REFERENCES "public"."stock_return_batch_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_receipt_line" ADD CONSTRAINT "stock_return_receipt_line_quarantine_lot_id_fk" FOREIGN KEY ("quarantine_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_receipt_line" ADD CONSTRAINT "stock_return_receipt_line_quarantine_in_posting_line_id_fk" FOREIGN KEY ("quarantine_in_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_return_receipt_line" ADD CONSTRAINT "stock_return_receipt_line_disposition_out_posting_line_id_fk" FOREIGN KEY ("disposition_out_posting_line_id") REFERENCES "public"."stock_posting_line"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_receipt_line_batch_line_unique" ON "stock_return_receipt_line" USING btree ("batch_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_receipt_line_quarantine_in_unique" ON "stock_return_receipt_line" USING btree ("quarantine_in_posting_line_id") WHERE "quarantine_in_posting_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_return_receipt_line_disposition_out_unique" ON "stock_return_receipt_line" USING btree ("disposition_out_posting_line_id") WHERE "disposition_out_posting_line_id" IS NOT NULL;--> statement-breakpoint

-- Receipt/disposition evidence is immutable once posted, matching the
-- append-only convention for stock_posting_line/inventory_lot_genealogy (0027).
DROP TRIGGER IF EXISTS stock_return_receipt_line_append_only ON "stock_return_receipt_line";--> statement-breakpoint
CREATE TRIGGER stock_return_receipt_line_append_only BEFORE UPDATE OR DELETE ON "stock_return_receipt_line" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
