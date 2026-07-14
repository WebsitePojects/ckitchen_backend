-- ============================================================================
-- Migration 0027 — ORION enterprise operations foundation (D35-D46)
--
-- Additive/dark migration: introduces explicit stock-node purposes, generic item
-- metadata, lot-level balances, exactly-once posting headers/lines, transactional
-- outbox, reconciliation/kill-switch controls, and ambiguity-safe listing outlet
-- identity. No new stock posting feature is enabled by this migration.
-- ============================================================================

DO $$ BEGIN CREATE TYPE "warehouse_purpose" AS ENUM('HQ_MAIN','OUTLET_STORAGE','KITCHEN','PRODUCTION','QUARANTINE'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "item_type" AS ENUM('RAW','PACKAGING','CONSUMABLE','WIP','FINISHED_GOOD','SERVICE'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "listing_mapping_status" AS ENUM('RESOLVED','MAPPING_REQUIRED','DISABLED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "consumption_mode" AS ENUM('STOCKED_OUTPUT','MADE_TO_ORDER'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "inventory_lot_status" AS ENUM('AVAILABLE','QUARANTINED','EXPIRED','RECALLED','SPOILED','DISPOSED','EXHAUSTED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "stock_posting_status" AS ENUM('PROCESSING','COMPLETED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "outbox_status" AS ENUM('PENDING','PROCESSING','PUBLISHED','DEAD_LETTER'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "reconciliation_status" AS ENUM('RUNNING','PASSED','DRIFT_DETECTED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "migration_exception_status" AS ENUM('OPEN','RESOLVED','IGNORED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "import_job_status" AS ENUM('UPLOADED','VALIDATED','EXCEPTIONS','APPROVED','COMMITTED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "location_id" uuid;--> statement-breakpoint
ALTER TABLE "aggregator_account" ADD COLUMN IF NOT EXISTS "mapping_status" "listing_mapping_status" DEFAULT 'MAPPING_REQUIRED' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredient" ADD COLUMN IF NOT EXISTS "code" text;--> statement-breakpoint
ALTER TABLE "ingredient" ADD COLUMN IF NOT EXISTS "item_type" "item_type" DEFAULT 'RAW' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredient" ADD COLUMN IF NOT EXISTS "lot_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ingredient" ADD COLUMN IF NOT EXISTS "shelf_life_days" integer;--> statement-breakpoint
ALTER TABLE "ingredient" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN IF NOT EXISTS "consumption_mode" "consumption_mode" DEFAULT 'MADE_TO_ORDER' NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN IF NOT EXISTS "stock_item_id" uuid;--> statement-breakpoint
ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "purpose" "warehouse_purpose";--> statement-breakpoint
ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "code" text;--> statement-breakpoint
ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "location_id" uuid;--> statement-breakpoint
ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "attendance_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "location_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "correlation_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "posting_id" uuid;--> statement-breakpoint

DO $$ BEGIN ALTER TABLE "aggregator_account" ADD CONSTRAINT "aggregator_account_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_stock_item_id_ingredient_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "order" ADD CONSTRAINT "order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_location_purpose_unique" ON "warehouse" USING btree ("location_id","purpose") WHERE "purpose" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_single_hq_main_unique" ON "warehouse" USING btree ("purpose") WHERE "purpose" = 'HQ_MAIN' AND "is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_code_unique" ON "warehouse" USING btree ("code") WHERE "code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_location_purpose_idx" ON "warehouse" USING btree ("location_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingredient_code_unique" ON "ingredient" USING btree ("code") WHERE "code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingredient_type_active_idx" ON "ingredient" USING btree ("item_type","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_account_location_id_idx" ON "aggregator_account" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_account_mapping_status_idx" ON "aggregator_account" USING btree ("mapping_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_stock_item_id_idx" ON "menu_item" USING btree ("stock_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_location_placed_at_idx" ON "order" USING btree ("location_id","placed_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_location_created_idx" ON "audit_log" USING btree ("location_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_correlation_idx" ON "audit_log" USING btree ("correlation_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "item_uom_conversion" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "from_uom" text NOT NULL,
  "to_base_factor" numeric(20,8) NOT NULL,
  "rounding_scale" integer DEFAULT 4 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "item_uom_conversion_factor_positive" CHECK ("to_base_factor" > 0),
  CONSTRAINT "item_uom_conversion_rounding_scale_range" CHECK ("rounding_scale" >= 0 AND "rounding_scale" <= 8)
);--> statement-breakpoint
ALTER TABLE "item_uom_conversion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "item_uom_conversion" ADD CONSTRAINT "item_uom_conversion_item_id_ingredient_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_uom_conversion_item_from_unique" ON "item_uom_conversion" USING btree ("item_id","from_uom");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_lot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "lot_code" text NOT NULL,
  "supplier_lot" text,
  "manufactured_at" date,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" date,
  "status" "inventory_lot_status" DEFAULT 'AVAILABLE' NOT NULL,
  "unit_cost" numeric(20,6) DEFAULT 0 NOT NULL,
  "source_document_type" text,
  "source_document_id" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_lot_unit_cost_nonnegative" CHECK ("unit_cost" >= 0)
);--> statement-breakpoint
ALTER TABLE "inventory_lot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_lot" ADD CONSTRAINT "inventory_lot_item_id_ingredient_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_lot_item_code_unique" ON "inventory_lot" USING btree ("item_id","lot_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_lot_item_status_expiry_idx" ON "inventory_lot" USING btree ("item_id","status","expires_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_lot_balance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL,
  "on_hand" numeric(20,6) DEFAULT 0 NOT NULL,
  "reserved" numeric(20,6) DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_lot_balance_on_hand_nonnegative" CHECK ("on_hand" >= 0),
  CONSTRAINT "inventory_lot_balance_reserved_nonnegative" CHECK ("reserved" >= 0),
  CONSTRAINT "inventory_lot_balance_reserved_lte_on_hand" CHECK ("reserved" <= "on_hand"),
  CONSTRAINT "inventory_lot_balance_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "inventory_lot_balance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_lot_balance" ADD CONSTRAINT "inventory_lot_balance_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_lot_balance" ADD CONSTRAINT "inventory_lot_balance_lot_id_inventory_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_lot_balance_warehouse_lot_unique" ON "inventory_lot_balance" USING btree ("warehouse_id","lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_lot_balance_lot_idx" ON "inventory_lot_balance" USING btree ("lot_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_lot_genealogy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_lot_id" uuid NOT NULL,
  "child_lot_id" uuid NOT NULL,
  "quantity_consumed" numeric(20,6) NOT NULL,
  "production_document_no" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventory_lot_genealogy_qty_positive" CHECK ("quantity_consumed" > 0),
  CONSTRAINT "inventory_lot_genealogy_distinct_lots" CHECK ("parent_lot_id" <> "child_lot_id")
);--> statement-breakpoint
ALTER TABLE "inventory_lot_genealogy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_lot_genealogy" ADD CONSTRAINT "inventory_lot_genealogy_parent_lot_id_fk" FOREIGN KEY ("parent_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_lot_genealogy" ADD CONSTRAINT "inventory_lot_genealogy_child_lot_id_fk" FOREIGN KEY ("child_lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_lot_genealogy_unique" ON "inventory_lot_genealogy" USING btree ("parent_lot_id","child_lot_id","production_document_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_lot_genealogy_child_idx" ON "inventory_lot_genealogy" USING btree ("child_lot_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_posting" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "hash_version" integer DEFAULT 1 NOT NULL,
  "status" "stock_posting_status" DEFAULT 'PROCESSING' NOT NULL,
  "source_module" text NOT NULL,
  "source_document_no" text NOT NULL,
  "location_id" uuid,
  "actor_user_id" uuid,
  "correlation_id" text NOT NULL,
  "result" jsonb,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_posting_hash_version_positive" CHECK ("hash_version" > 0)
);--> statement-breakpoint
ALTER TABLE "stock_posting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting" ADD CONSTRAINT "stock_posting_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting" ADD CONSTRAINT "stock_posting_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_posting_idempotency_key_unique" ON "stock_posting" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_posting_document_idx" ON "stock_posting" USING btree ("source_module","source_document_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_posting_location_created_idx" ON "stock_posting" USING btree ("location_id","created_at" DESC);--> statement-breakpoint

DO $$ BEGIN ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_posting_id_stock_posting_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."stock_posting"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_posting_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "posting_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "lot_id" uuid NOT NULL,
  "movement_type" "stock_ledger_movement_type" NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "entered_quantity" numeric(20,6) NOT NULL,
  "entered_uom" text NOT NULL,
  "conversion_factor" numeric(20,8) NOT NULL,
  "unit_cost" numeric(20,6) DEFAULT 0 NOT NULL,
  "reason_code" text,
  "balance_before" numeric(20,6) NOT NULL,
  "balance_after" numeric(20,6) NOT NULL,
  "line_hash" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_posting_line_number_positive" CHECK ("line_no" > 0),
  CONSTRAINT "stock_posting_line_qty_positive" CHECK ("quantity" > 0),
  CONSTRAINT "stock_posting_line_entered_qty_positive" CHECK ("entered_quantity" > 0),
  CONSTRAINT "stock_posting_line_conversion_positive" CHECK ("conversion_factor" > 0),
  CONSTRAINT "stock_posting_line_cost_nonnegative" CHECK ("unit_cost" >= 0),
  CONSTRAINT "stock_posting_line_balances_nonnegative" CHECK ("balance_before" >= 0 AND "balance_after" >= 0)
);--> statement-breakpoint
ALTER TABLE "stock_posting_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting_line" ADD CONSTRAINT "stock_posting_line_posting_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."stock_posting"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting_line" ADD CONSTRAINT "stock_posting_line_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting_line" ADD CONSTRAINT "stock_posting_line_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_posting_line" ADD CONSTRAINT "stock_posting_line_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lot"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_posting_line_posting_line_unique" ON "stock_posting_line" USING btree ("posting_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_posting_line_hash_unique" ON "stock_posting_line" USING btree ("posting_id","line_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_posting_line_lot_warehouse_idx" ON "stock_posting_line" USING btree ("lot_id","warehouse_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_posting_line_item_warehouse_idx" ON "stock_posting_line" USING btree ("item_id","warehouse_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "operational_document" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "module" text NOT NULL,
  "document_no" text NOT NULL,
  "location_id" uuid NOT NULL,
  "status" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "stock_posting_id" uuid,
  "created_by" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operational_document_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "operational_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "operational_document" ADD CONSTRAINT "operational_document_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "operational_document" ADD CONSTRAINT "operational_document_stock_posting_id_fk" FOREIGN KEY ("stock_posting_id") REFERENCES "public"."stock_posting"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "operational_document" ADD CONSTRAINT "operational_document_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operational_document_module_no_unique" ON "operational_document" USING btree ("module","document_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operational_document_posting_unique" ON "operational_document" USING btree ("stock_posting_id") WHERE "stock_posting_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operational_document_location_status_idx" ON "operational_document" USING btree ("location_id","module","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "menu_item_outlet" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "menu_item_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "station_id" uuid NOT NULL,
  "availability" "availability" DEFAULT 'AVAILABLE' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "menu_item_outlet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_item_outlet" ADD CONSTRAINT "menu_item_outlet_menu_item_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_item"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_item_outlet" ADD CONSTRAINT "menu_item_outlet_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "menu_item_outlet" ADD CONSTRAINT "menu_item_outlet_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."kitchen_station"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_outlet_item_location_unique" ON "menu_item_outlet" USING btree ("menu_item_id","location_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_outlet_location_station_idx" ON "menu_item_outlet" USING btree ("location_id","station_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "outbox_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_type" text NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "location_id" uuid,
  "correlation_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "last_error" text,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_event_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_event_correlation_type_aggregate_unique" ON "outbox_event" USING btree ("correlation_id","event_type","aggregate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_event_pending_idx" ON "outbox_event" USING btree ("available_at","created_at") WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_event_location_created_idx" ON "outbox_event" USING btree ("location_id","created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "operational_feature_flag" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "description" text,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operational_feature_flag_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
ALTER TABLE "operational_feature_flag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "operational_feature_flag" ADD CONSTRAINT "operational_feature_flag_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operational_feature_flag_key_unique" ON "operational_feature_flag" USING btree ("key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_reconciliation_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" "reconciliation_status" DEFAULT 'RUNNING' NOT NULL,
  "scope_warehouse_id" uuid,
  "legacy_total" numeric(24,6),
  "lot_total" numeric(24,6),
  "drift_quantity" numeric(24,6),
  "details" jsonb,
  "started_by" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "inventory_reconciliation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_reconciliation_run" ADD CONSTRAINT "inventory_reconciliation_scope_warehouse_id_fk" FOREIGN KEY ("scope_warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_reconciliation_run" ADD CONSTRAINT "inventory_reconciliation_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reconciliation_status_started_idx" ON "inventory_reconciliation_run" USING btree ("status","started_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "outlet_manager_assignment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL,
  "employee_id" uuid NOT NULL,
  "is_primary" boolean DEFAULT true NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "assigned_by" uuid,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "outlet_manager_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "outlet_manager_assignment" ADD CONSTRAINT "outlet_manager_assignment_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "outlet_manager_assignment" ADD CONSTRAINT "outlet_manager_assignment_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "outlet_manager_assignment" ADD CONSTRAINT "outlet_manager_assignment_assigned_by_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outlet_manager_active_primary_unique" ON "outlet_manager_assignment" USING btree ("location_id") WHERE "active" = true AND "is_primary" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outlet_manager_employee_idx" ON "outlet_manager_assignment" USING btree ("employee_id","active");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "listing_migration_exception" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregator_account_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "candidate_location_ids" jsonb NOT NULL,
  "affected_order_count" integer DEFAULT 0 NOT NULL,
  "status" "migration_exception_status" DEFAULT 'OPEN' NOT NULL,
  "resolved_location_id" uuid,
  "resolved_by" uuid,
  "resolution_note" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "listing_migration_exception_order_count_nonnegative" CHECK ("affected_order_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "listing_migration_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "listing_migration_exception" ADD CONSTRAINT "listing_migration_exception_account_id_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "listing_migration_exception" ADD CONSTRAINT "listing_migration_exception_location_id_fk" FOREIGN KEY ("resolved_location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "listing_migration_exception" ADD CONSTRAINT "listing_migration_exception_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listing_migration_exception_account_unique" ON "listing_migration_exception" USING btree ("aggregator_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_migration_exception_status_idx" ON "listing_migration_exception" USING btree ("status","created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventory_migration_exception" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "legacy_stock_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "reason" text NOT NULL,
  "status" "migration_exception_status" DEFAULT 'OPEN' NOT NULL,
  "resolution_note" text,
  "resolved_by" uuid,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "inventory_migration_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_migration_exception" ADD CONSTRAINT "inventory_migration_exception_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_migration_exception" ADD CONSTRAINT "inventory_migration_exception_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inventory_migration_exception" ADD CONSTRAINT "inventory_migration_exception_resolved_by_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_migration_exception_stock_unique" ON "inventory_migration_exception" USING btree ("legacy_stock_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_migration_exception_status_idx" ON "inventory_migration_exception" USING btree ("status","created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "topology_migration_exception" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "reason" text NOT NULL,
  "details" jsonb NOT NULL,
  "status" "migration_exception_status" DEFAULT 'OPEN' NOT NULL,
  "resolution_note" text,
  "resolved_by" uuid,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "topology_migration_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "topology_migration_exception" ADD CONSTRAINT "topology_migration_exception_resolved_by_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topology_migration_exception_code_unique" ON "topology_migration_exception" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topology_migration_exception_status_idx" ON "topology_migration_exception" USING btree ("status","created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "data_import_job" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_type" text NOT NULL,
  "source_file_hash" text NOT NULL,
  "original_file_name" text NOT NULL,
  "status" "import_job_status" DEFAULT 'UPLOADED' NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "valid_row_count" integer DEFAULT 0 NOT NULL,
  "exception_count" integer DEFAULT 0 NOT NULL,
  "dry_run_summary" jsonb,
  "approved_by_owner" uuid,
  "approved_by_operations" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "committed_at" timestamp with time zone,
  CONSTRAINT "data_import_job_counts_nonnegative" CHECK ("row_count" >= 0 AND "valid_row_count" >= 0 AND "exception_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "data_import_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "data_import_job" ADD CONSTRAINT "data_import_job_approved_by_owner_fk" FOREIGN KEY ("approved_by_owner") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "data_import_job" ADD CONSTRAINT "data_import_job_approved_by_operations_fk" FOREIGN KEY ("approved_by_operations") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "data_import_job" ADD CONSTRAINT "data_import_job_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_import_job_type_hash_unique" ON "data_import_job" USING btree ("import_type","source_file_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_import_job_status_created_idx" ON "data_import_job" USING btree ("status","created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "data_import_row" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "import_job_id" uuid NOT NULL,
  "row_number" integer NOT NULL,
  "row_hash" text NOT NULL,
  "raw_data" jsonb NOT NULL,
  "normalized_data" jsonb,
  "errors" jsonb,
  "is_valid" boolean DEFAULT false NOT NULL,
  "committed_entity_type" text,
  "committed_entity_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "data_import_row_number_positive" CHECK ("row_number" > 0)
);--> statement-breakpoint
ALTER TABLE "data_import_row" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "data_import_row" ADD CONSTRAINT "data_import_row_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."data_import_job"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_import_row_job_number_unique" ON "data_import_row" USING btree ("import_job_id","row_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_import_row_job_hash_unique" ON "data_import_row" USING btree ("import_job_id","row_hash");--> statement-breakpoint

-- Deterministic, safe compatibility backfill. It never guesses ambiguous listing outlets.
UPDATE "ingredient" SET "code" = 'ITM-' || upper(substr(replace("id"::text, '-', ''), 1, 12)) WHERE "code" IS NULL;--> statement-breakpoint
UPDATE "warehouse" SET "purpose" = 'KITCHEN' WHERE "purpose" IS NULL AND "type" = 'KITCHEN';--> statement-breakpoint
DO $$
DECLARE main_count integer;
BEGIN
  SELECT count(*) INTO main_count FROM "warehouse" WHERE "type" = 'MAIN';
  IF main_count = 1 THEN
    UPDATE "warehouse" SET "purpose" = 'HQ_MAIN' WHERE "type" = 'MAIN' AND "purpose" IS NULL;
  ELSE
    UPDATE "warehouse" SET "purpose" = 'OUTLET_STORAGE' WHERE "type" = 'MAIN' AND "purpose" IS NULL;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "topology_migration_exception" ("code","reason","details")
SELECT 'HQ_MAIN_MAPPING_REQUIRED', 'NO_UNAMBIGUOUS_HQ_MAIN',
       jsonb_build_object('legacy_main_count', count(*), 'action', 'Designate exactly one active HQ_MAIN before enabling stock.lot_writes')
FROM "warehouse"
WHERE "type" = 'MAIN'
HAVING count(*) <> 1
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
UPDATE "warehouse" w SET
  "code" = 'WH-' || l."code" || '-' || w."purpose"::text,
  "name" = CASE w."purpose"
    WHEN 'HQ_MAIN' THEN 'HQ Main Warehouse'
    WHEN 'OUTLET_STORAGE' THEN l."name" || ' Outlet Storage'
    WHEN 'KITCHEN' THEN l."name" || ' Kitchen Inventory'
    ELSE l."name" || ' ' || initcap(replace(w."purpose"::text, '_', ' '))
  END
FROM "location" l
WHERE w."location_id" = l."id" AND w."purpose" IS NOT NULL AND w."code" IS NULL;--> statement-breakpoint

INSERT INTO "menu_item_outlet" ("menu_item_id","location_id","station_id","availability","is_active")
SELECT mi."id", ks."location_id", ks."id", mi."availability", true
FROM "menu_item" mi
JOIN "kitchen_station" ks ON ks."id" = mi."station_id"
ON CONFLICT ("menu_item_id","location_id") DO NOTHING;--> statement-breakpoint

WITH active_deployments AS (
  SELECT "brand_id", min("location_id"::text)::uuid AS only_location, count(*) AS deployment_count
  FROM "brand_outlet"
  WHERE "is_active" = true
  GROUP BY "brand_id"
)
UPDATE "aggregator_account" a
SET "location_id" = d.only_location,
    "mapping_status" = 'RESOLVED'
FROM active_deployments d
WHERE a."brand_id" = d."brand_id" AND d.deployment_count = 1 AND a."location_id" IS NULL;--> statement-breakpoint
UPDATE "aggregator_account" SET "mapping_status" = 'MAPPING_REQUIRED' WHERE "location_id" IS NULL;--> statement-breakpoint
UPDATE "order" o SET "location_id" = a."location_id" FROM "aggregator_account" a WHERE o."aggregator_account_id" = a."id" AND a."mapping_status" = 'RESOLVED' AND o."location_id" IS NULL;--> statement-breakpoint

INSERT INTO "listing_migration_exception" ("aggregator_account_id","reason","candidate_location_ids","affected_order_count")
SELECT a."id", 'AMBIGUOUS_OR_MISSING_OUTLET_MAPPING',
       COALESCE((SELECT jsonb_agg(bo."location_id" ORDER BY bo."location_id") FROM "brand_outlet" bo WHERE bo."brand_id" = a."brand_id" AND bo."is_active" = true), '[]'::jsonb),
       (SELECT count(*)::integer FROM "order" o WHERE o."aggregator_account_id" = a."id")
FROM "aggregator_account" a
WHERE a."location_id" IS NULL
ON CONFLICT ("aggregator_account_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "inventory_migration_exception" ("legacy_stock_id","warehouse_id","item_id","quantity","reason")
SELECT s."id", s."warehouse_id", s."ingredient_id", s."quantity", 'NEGATIVE_LEGACY_BALANCE'
FROM "inventory_stock" s WHERE s."quantity" < 0
ON CONFLICT ("legacy_stock_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "inventory_lot" ("item_id","lot_code","status","unit_cost","source_document_type","source_document_id","metadata")
SELECT s."ingredient_id",
       'OPEN-' || upper(substr(md5(s."warehouse_id"::text || ':' || s."ingredient_id"::text), 1, 16)),
       CASE WHEN s."quantity" = 0 THEN 'EXHAUSTED'::"inventory_lot_status" ELSE 'AVAILABLE'::"inventory_lot_status" END,
       i."unit_cost", 'OPENING_BALANCE', s."id"::text,
       jsonb_build_object('legacy_inventory_stock_id', s."id", 'migrated_by', '0027')
FROM "inventory_stock" s JOIN "ingredient" i ON i."id" = s."ingredient_id"
WHERE s."quantity" >= 0
ON CONFLICT ("item_id","lot_code") DO NOTHING;--> statement-breakpoint

INSERT INTO "inventory_lot_balance" ("warehouse_id","lot_id","on_hand","reserved")
SELECT s."warehouse_id", l."id", s."quantity", 0
FROM "inventory_stock" s
JOIN "inventory_lot" l ON l."source_document_type" = 'OPENING_BALANCE' AND l."source_document_id" = s."id"::text
WHERE s."quantity" >= 0
ON CONFLICT ("warehouse_id","lot_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "operational_feature_flag" ("key","enabled","description") VALUES
  ('stock.lot_writes', false, 'Authoritative lot-level stock posting'),
  ('stock.transfers', false, 'Enterprise transfer posting'),
  ('stock.returns', false, 'HQ return and disposition posting'),
  ('stock.production', false, 'Job Order issue and output posting'),
  ('stock.customer_order_fulfillment', false, 'Customer Order allocation and fulfillment'),
  ('integration.middleware_processing', false, 'Middleware webhook processing'),
  ('printing.spooling', false, 'Physical/virtual Print Agent spooling'),
  ('stock.legacy_write_compatibility', false, 'Legacy aggregate write bridge')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- New movement/genealogy evidence is immutable. Posting headers and outbox rows
-- remain mutable only through their controlled state machines.
DROP TRIGGER IF EXISTS stock_posting_line_append_only ON "stock_posting_line";--> statement-breakpoint
CREATE TRIGGER stock_posting_line_append_only BEFORE UPDATE OR DELETE ON "stock_posting_line" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS inventory_lot_genealogy_append_only ON "inventory_lot_genealogy";--> statement-breakpoint
CREATE TRIGGER inventory_lot_genealogy_append_only BEFORE UPDATE OR DELETE ON "inventory_lot_genealogy" FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
