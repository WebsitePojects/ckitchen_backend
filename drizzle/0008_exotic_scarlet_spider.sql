CREATE TYPE "public"."purchase_order_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."purchase_request_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"qty_received" numeric(14, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_no" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"pr_id" uuid,
	"status" "purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_po_no_unique" UNIQUE("po_no")
);
--> statement-breakpoint
CREATE TABLE "purchase_request_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"est_unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_no" text NOT NULL,
	"department" "department" NOT NULL,
	"status" "purchase_request_status" DEFAULT 'DRAFT' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_request_pr_no_unique" UNIQUE("pr_no")
);
--> statement-breakpoint
CREATE TABLE "receiving_report_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rr_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"qty_received" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rr_no" text NOT NULL,
	"po_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"received_by_user_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receiving_report_rr_no_unique" UNIQUE("rr_no")
);
--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_po_id_purchase_order_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_pr_id_purchase_request_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."purchase_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_line" ADD CONSTRAINT "purchase_request_line_pr_id_purchase_request_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."purchase_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_line" ADD CONSTRAINT "purchase_request_line_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request" ADD CONSTRAINT "purchase_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request" ADD CONSTRAINT "purchase_request_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report_line" ADD CONSTRAINT "receiving_report_line_rr_id_receiving_report_id_fk" FOREIGN KEY ("rr_id") REFERENCES "public"."receiving_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report_line" ADD CONSTRAINT "receiving_report_line_po_line_id_purchase_order_line_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report_line" ADD CONSTRAINT "receiving_report_line_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report" ADD CONSTRAINT "receiving_report_po_id_purchase_order_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report" ADD CONSTRAINT "receiving_report_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_report" ADD CONSTRAINT "receiving_report_received_by_user_id_user_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;