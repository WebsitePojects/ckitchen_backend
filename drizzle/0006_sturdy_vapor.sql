CREATE TYPE "public"."attendance_type" AS ENUM('TIME_IN', 'TIME_OUT');--> statement-breakpoint
CREATE TABLE "attendance_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" "attendance_type" NOT NULL,
	"photo_url" text NOT NULL,
	"photo_public_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"session_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_record" ADD CONSTRAINT "attendance_record_session_id_user_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_session"("id") ON DELETE no action ON UPDATE no action;