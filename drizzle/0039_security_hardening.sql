-- ============================================================================
-- Migration 0039 -- security hardening (Supabase advisor findings).
--
-- Additive / reversible: no data change, no table or column change. Each step is
-- guarded so the same file applies on Supabase Postgres 17 (where the `anon` /
-- `authenticated` roles and `public.rls_auto_enable()` exist) AND on PGlite in
-- tests (where none of them exist).
-- ============================================================================

-- A. Pin search_path on the trigger functions (Supabase lint 0011). A mutable
-- search_path lets a caller-controlled schema shadow objects these functions
-- reference. pg_temp is listed last so temp objects can never win resolution.
ALTER FUNCTION public.bom_version_write_guard() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.bom_component_write_guard() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.job_order_production_warehouse_check() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.job_order_component_allocation_append_only() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.job_order_output_lot_append_only() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.transfer_order_line_posting_append_only() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.qa_release_route_check() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.qa_release_line_append_only() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.forbid_mutation() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.bom_header_output_item_type_check() SET search_path = public, pg_temp;--> statement-breakpoint

-- B. Close the unused Supabase Data API surface. Neither the backend nor the
-- frontend uses supabase-js (the app connects directly as `postgres`), yet
-- `anon` / `authenticated` hold ALL privileges on every public table --
-- including TRUNCATE, which RLS does not cover. Default privileges are revoked
-- too so future tables created by the migrating role are not re-exposed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;--> statement-breakpoint

-- C. rls_auto_enable() is Supabase-managed (do not drop or alter it) but is
-- SECURITY DEFINER and executable by PUBLIC by default, so API callers could
-- invoke it. Only EXECUTE is revoked; anon/authenticated are checked separately
-- because role existence is independent of function existence.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated';
    END IF;
  END IF;
END $$;--> statement-breakpoint

-- D. FORCE ROW LEVEL SECURITY on every ordinary public table. A no-op for the
-- current app role (`postgres` has BYPASSRLS); it exists so a future non-bypass
-- table-owner role cannot silently skip policies (multi-tenancy plan D47,
-- .claude/context/multi-tenancy-migration-plan.md in the parent repo).
DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', tbl.schema_name, tbl.table_name);
  END LOOP;
END $$;
