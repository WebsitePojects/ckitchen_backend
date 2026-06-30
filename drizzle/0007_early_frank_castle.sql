CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_phone" text,
	"email" text,
	"address" text,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "department_inventory_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department" "department" NOT NULL,
	"warehouse_type" "warehouse_type" NOT NULL,
	"can_view" boolean DEFAULT true NOT NULL,
	"can_view_cost" boolean DEFAULT false NOT NULL,
	"can_receive" boolean DEFAULT false NOT NULL,
	"can_issue" boolean DEFAULT false NOT NULL,
	"can_adjust" boolean DEFAULT false NOT NULL,
	"can_approve" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"supplier_sku" text,
	"last_unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_phone" text,
	"email" text,
	"address" text,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "supplier_item" ADD CONSTRAINT "supplier_item_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_item" ADD CONSTRAINT "supplier_item_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "department_inventory_access_unique" ON "department_inventory_access" USING btree ("department","warehouse_type");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_item_unique" ON "supplier_item" USING btree ("supplier_id","ingredient_id");