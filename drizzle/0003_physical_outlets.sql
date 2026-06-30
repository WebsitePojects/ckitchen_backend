CREATE TYPE "public"."location_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "status" "location_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "timezone" text DEFAULT 'Asia/Manila' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "contact_phone" text;--> statement-breakpoint
UPDATE "location" SET "code" = 'CK1' WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "location" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "location_code_unique" ON "location" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_location_type_unique" ON "warehouse" USING btree ("location_id","type");
