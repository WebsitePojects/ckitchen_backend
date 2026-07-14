-- ============================================================================
-- Migration 0030 — Customer Orders (D35-D46 §7, Customer Orders and Job Orders)
--
-- Additive/dark: introduces the Customer Order header, its multi-line body,
-- lot allocation tracking, and fulfillment history. No route/service/feature
-- flag wiring happens here; the future posting service will use these tables
-- once it lands (stock.customer_orders stays unseeded/OFF until then, same
-- pattern as stock.returns/stock.production in 0027).
-- ============================================================================

DO $$ BEGIN CREATE TYPE "customer_order_status" AS ENUM('DRAFT','SUBMITTED','APPROVED','ALLOCATED','IN_PRODUCTION','READY','FULFILLED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "customer_order_allocation_status" AS ENUM('ACTIVE','RELEASED','CONSUMED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_no" text NOT NULL,
  "customer_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "required_date" date,
  "status" "customer_order_status" DEFAULT 'DRAFT' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "remarks" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_by" uuid,
  "submitted_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "allocated_by" uuid,
  "allocated_at" timestamp with time zone,
  "fulfilled_by" uuid,
  "fulfilled_at" timestamp with time zone,
  "cancelled_by" uuid,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_order_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "customer_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_submitted_by_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_allocated_by_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_fulfilled_by_fk" FOREIGN KEY ("fulfilled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_order_document_no_unique" ON "customer_order" USING btree ("document_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_customer_idx" ON "customer_order" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_location_status_idx" ON "customer_order" USING btree ("location_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_order_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_id" uuid NOT NULL,
  "entered_uom" text NOT NULL,
  "entered_quantity" numeric(20,6) NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "base_quantity" numeric(20,6) NOT NULL,
  "unit_price" numeric(20,6) NOT NULL,
  "tax_amount" numeric(20,6) DEFAULT 0 NOT NULL,
  "discount_amount" numeric(20,6) DEFAULT 0 NOT NULL,
  "line_total" numeric(20,6) NOT NULL,
  "consumption_mode" "consumption_mode" NOT NULL,
  "status" "customer_order_status" DEFAULT 'DRAFT' NOT NULL,
  "component_requirements_snapshot" jsonb,
  "job_order_id" uuid,
  "remarks" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_order_line_number_positive" CHECK ("line_no" > 0),
  CONSTRAINT "customer_order_line_entered_qty_positive" CHECK ("entered_quantity" > 0),
  CONSTRAINT "customer_order_line_conversion_positive" CHECK ("conversion_factor" > 0),
  CONSTRAINT "customer_order_line_base_qty_positive" CHECK ("base_quantity" > 0),
  CONSTRAINT "customer_order_line_unit_price_nonnegative" CHECK ("unit_price" >= 0),
  CONSTRAINT "customer_order_line_tax_amount_nonnegative" CHECK ("tax_amount" >= 0),
  CONSTRAINT "customer_order_line_discount_amount_nonnegative" CHECK ("discount_amount" >= 0),
  CONSTRAINT "customer_order_line_total_nonnegative" CHECK ("line_total" >= 0),
  CONSTRAINT "customer_order_line_consumption_owner_guard" CHECK (
    (
      "consumption_mode" = 'STOCKED_OUTPUT'
      AND "component_requirements_snapshot" IS NULL
      AND "job_order_id" IS NULL
    ) OR (
      "consumption_mode" = 'MADE_TO_ORDER'
      AND (
        ("component_requirements_snapshot" IS NOT NULL AND "job_order_id" IS NULL)
        OR ("component_requirements_snapshot" IS NULL AND "job_order_id" IS NOT NULL)
      )
    )
  )
);--> statement-breakpoint
ALTER TABLE "customer_order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_line" ADD CONSTRAINT "customer_order_line_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_order"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_line" ADD CONSTRAINT "customer_order_line_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_line" ADD CONSTRAINT "customer_order_line_job_order_id_fk" FOREIGN KEY ("job_order_id") REFERENCES "public"."job_order"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_order_line_order_line_unique" ON "customer_order_line" USING btree ("order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_order_line_job_order_unique" ON "customer_order_line" USING btree ("job_order_id") WHERE "job_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_line_item_idx" ON "customer_order_line" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_line_order_status_idx" ON "customer_order_line" USING btree ("order_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_order_allocation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "line_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "status" "customer_order_allocation_status" DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_order_allocation_qty_positive" CHECK ("quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "customer_order_allocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_allocation" ADD CONSTRAINT "customer_order_allocation_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."customer_order_line"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_allocation" ADD CONSTRAINT "customer_order_allocation_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_allocation" ADD CONSTRAINT "customer_order_allocation_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_order_allocation_line_lot_active_unique" ON "customer_order_allocation" USING btree ("line_id","lot_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_allocation_line_idx" ON "customer_order_allocation" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_allocation_lot_warehouse_idx" ON "customer_order_allocation" USING btree ("lot_id","warehouse_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_order_fulfillment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "line_id" uuid NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "stock_posting_id" uuid,
  "actor_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_order_fulfillment_qty_positive" CHECK ("quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "customer_order_fulfillment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_fulfillment" ADD CONSTRAINT "customer_order_fulfillment_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_order"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_fulfillment" ADD CONSTRAINT "customer_order_fulfillment_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."customer_order_line"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_fulfillment" ADD CONSTRAINT "customer_order_fulfillment_stock_posting_id_fk" FOREIGN KEY ("stock_posting_id") REFERENCES "public"."stock_posting"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "customer_order_fulfillment" ADD CONSTRAINT "customer_order_fulfillment_actor_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_fulfillment_order_idx" ON "customer_order_fulfillment" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_order_fulfillment_line_idx" ON "customer_order_fulfillment" USING btree ("line_id");--> statement-breakpoint

-- Fulfillment history is append-only once written, matching the
-- append-only convention for stock_posting_line/stock_return_receipt_line.
DROP TRIGGER IF EXISTS customer_order_fulfillment_append_only ON "customer_order_fulfillment";--> statement-breakpoint
CREATE TRIGGER customer_order_fulfillment_append_only BEFORE UPDATE OR DELETE ON "customer_order_fulfillment" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
