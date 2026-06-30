CREATE TYPE "public"."department" AS ENUM('KITCHEN', 'WAREHOUSE', 'PURCHASING', 'SALES', 'PRODUCTION', 'QA', 'ACCOUNTING', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text,
	"session_id" uuid,
	"action" text NOT NULL,
	"description" text,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"employee_no" text NOT NULL,
	"full_name" text NOT NULL,
	"department" "department" NOT NULL,
	"position" text,
	"photo_url" text,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_employee_no_unique" UNIQUE("employee_no")
);
--> statement-breakpoint
CREATE TABLE "user_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logout_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_session_id_user_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;