CREATE TYPE "public"."stock_ledger_movement_type" AS ENUM('IN', 'OUT');--> statement-breakpoint
CREATE TYPE "public"."stock_ledger_source_module" AS ENUM('RECEIVE', 'ITO', 'ORDER_DEDUCTION', 'ADJUSTMENT', 'RESTOCK');--> statement-breakpoint
CREATE TABLE "stock_ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_module" "stock_ledger_source_module" NOT NULL,
	"source_document_no" text NOT NULL,
	"source_line_no" text,
	"ingredient_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"movement_type" "stock_ledger_movement_type" NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"encoder_user_id" uuid,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_entry_encoder_user_id_user_id_fk" FOREIGN KEY ("encoder_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ledger_source_unique" ON "stock_ledger_entry" USING btree ("source_module","source_document_no","source_line_no");