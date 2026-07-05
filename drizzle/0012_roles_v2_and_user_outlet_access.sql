-- ── Roles v2 (D24/D29) + tenancy plumbing (D22/D31) ─────────────────────────
--
-- Goal: add the v2 role values, remap existing user rows v1→v2, and KEEP the v1
-- values in the enum as accepted aliases (D29: enum values can't be dropped
-- cheaply; legacy tokens/rows may still carry them).
--
-- Why NOT `ALTER TYPE role ADD VALUE ... ; UPDATE "user" SET role = 'OWNER' ...`:
-- PostgreSQL forbids using a newly-added enum value in the SAME transaction that
-- added it ("unsafe use of new value ... of enum type"), and the drizzle
-- migrator wraps ALL pending migrations in ONE transaction (verified in
-- drizzle-orm/pg-core dialect.migrate). So ADD VALUE + data UPDATE cannot
-- coexist here — splitting into two .sql files would not help (same txn).
-- Confirmed empirically: naive ADD VALUE + same-txn use fails on PGlite too.
--
-- Instead we create a FRESH enum (`role_v2`) that already contains every value
-- (v1 aliases + v2) — a type created within the current transaction CAN be used
-- immediately — swap the user.role column onto it with a CASE remap, then drop
-- the old type and rename. End state: enum named `role` holding v1+v2 values,
-- user rows migrated to v2. This is transaction-safe on PGlite AND Supabase/PG15.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TYPE "public"."role_v2" AS ENUM(
  -- v1 values kept as aliases
  'SUPER_ADMIN',
  'BRAND_MANAGER',
  'KITCHEN_STAFF',
  'WAREHOUSE',
  'SUPPLIER_COORDINATOR',
  'ACCOUNTANT',
  'RIDER',
  -- v2 values (D24)
  'OWNER',
  'OUTLET_MANAGER',
  'KITCHEN_CREW',
  'WAREHOUSE_MAIN',
  'WAREHOUSE_OUTLET',
  'PURCHASING',
  'HR',
  'ACCOUNTING'
);--> statement-breakpoint

-- Remap existing rows v1→v2 while swapping the column type. BRAND_MANAGER is
-- unchanged (shared v1/v2). RIDER is intentionally left as 'RIDER' (D29 removes
-- the role; there is no v2 equivalent and the `user` table has no is_active
-- column to flag — a RIDER row keeps a value that no requireRole allow-list and
-- no v1→v2 alias grants, so it is effectively locked out of every protected
-- action = "no access"). Documented here rather than adding a schema column.
ALTER TABLE "user" ALTER COLUMN "role" TYPE "public"."role_v2" USING (
  CASE "role"::text
    WHEN 'SUPER_ADMIN' THEN 'OWNER'
    WHEN 'KITCHEN_STAFF' THEN 'KITCHEN_CREW'
    WHEN 'WAREHOUSE' THEN 'WAREHOUSE_OUTLET'
    WHEN 'SUPPLIER_COORDINATOR' THEN 'PURCHASING'
    WHEN 'ACCOUNTANT' THEN 'ACCOUNTING'
    ELSE "role"::text
  END
)::"public"."role_v2";--> statement-breakpoint

DROP TYPE "public"."role";--> statement-breakpoint
ALTER TYPE "public"."role_v2" RENAME TO "role";--> statement-breakpoint

-- ── user_outlet_access (D22/D31): source of truth for WHERE a user may act ────
-- RLS-enabled with no policy = deny-all for non-owner roles, consistent with the
-- migration 0009 hardening pattern (the app connects as the table owner / service
-- role and bypasses RLS; this is phase-2 defense-in-depth).
CREATE TABLE "user_outlet_access" (
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_outlet_access_user_id_location_id_pk" PRIMARY KEY("user_id","location_id")
);--> statement-breakpoint
ALTER TABLE "user_outlet_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_outlet_access" ADD CONSTRAINT "user_outlet_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_outlet_access" ADD CONSTRAINT "user_outlet_access_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_outlet_access_location_id_idx" ON "user_outlet_access" USING btree ("location_id");
