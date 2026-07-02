CREATE TYPE "public"."brand_activity_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "brand_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"aggregator_account_id" uuid,
	"status" "brand_activity_status" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "brand_activity_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN "item_no" text;--> statement-breakpoint
ALTER TABLE "menu_item" ADD COLUMN "remarks" text;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "brand_activity_log" ADD CONSTRAINT "brand_activity_log_brand_id_brand_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_activity_log" ADD CONSTRAINT "brand_activity_log_aggregator_account_id_aggregator_account_id_fk" FOREIGN KEY ("aggregator_account_id") REFERENCES "public"."aggregator_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_activity_log" ADD CONSTRAINT "brand_activity_log_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_activity_log_brand_changed_at_idx" ON "brand_activity_log" USING btree ("brand_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_brand_item_no_unique" ON "menu_item" USING btree ("brand_id","item_no") WHERE "menu_item"."item_no" IS NOT NULL;