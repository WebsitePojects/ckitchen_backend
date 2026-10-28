-- ============================================================================
-- Migration 0049 -- the workspace wall: row-level security per workspace (SaaS step 7, D55).
--
-- WHO IS WHO: every workspace gets its own Postgres login role, named ws_<tenant id as 32 hex>.
-- The API opens that workspace's connections as that role (modules/tenancy), so the database
-- itself knows which business is asking. No per-request "set the workspace" round trip:
-- the database is ~229 ms from the API, and that would cost 0.5-0.7 s on every call (D55).
--
--   current_tenant_id()  the workspace of the connected role, or NULL for any other role
--   orion_tenant         group role every ws_<id> role is a member of; all policies target it
--
-- POLICIES: on every table that has tenant_id, a role in orion_tenant sees and writes only
-- rows whose tenant_id is its own workspace (USING and WITH CHECK). Platform tables:
--   tenant        read your own workspace row only; no writes
--   user          members of your workspace, plus a just-created account that has no
--                 membership yet (INSERT ... RETURNING runs before the membership trigger).
--                 "Has no membership" must look across ALL workspaces, which RLS would hide,
--                 so it asks user_has_membership() (SECURITY DEFINER, returns a boolean only);
--                 otherwise every other workspace's users would look membership-less.
--   user_session  sessions of your workspace's members
--
-- The owner connection (migrations, sign-up provisioning, workers that route partner calls)
-- is the table owner with BYPASSRLS on Supabase and a superuser in tests: unaffected, so this
-- migration changes nothing until the API starts using workspace roles (TENANT_DB_ROLES=on).
--
-- DEFAULT: tenant_id defaults to the connected workspace; the owner connection still falls
-- back to workspace #1, so existing scripts and workers keep writing CloudKitchen rows.
-- A workspace role can never write another workspace's tenant_id (WITH CHECK).
--
-- The membership mirror trigger now records the connected workspace instead of always #1.
--
-- Reversible: DROP POLICY tenant_isolation ON each table; DROP the three platform policies;
-- restore the constant defaults (0047) and the 0045 trigger; DROP FUNCTION current_tenant_id;
-- DROP ROLE orion_tenant after dropping the ws_* roles.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_tenant') THEN
    CREATE ROLE orion_tenant NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_user ~ '^ws_[0-9a-f]{32}$' THEN substr(current_user, 4)::uuid END
$$;
--> statement-breakpoint
DO $$
DECLARE
  workspace_one constant uuid := '00000000-0000-4000-8000-000000000001';
  t text;
BEGIN
  GRANT USAGE ON SCHEMA public TO orion_tenant;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orion_tenant;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orion_tenant;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orion_tenant;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO orion_tenant;
  -- A workspace may read its own row in tenant, never create or change workspaces.
  REVOKE INSERT, UPDATE, DELETE ON "tenant" FROM orion_tenant;

  -- Every table with a tenant_id: RLS on and forced, one isolation policy, workspace default.
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I AS PERMISSIVE FOR ALL TO orion_tenant
         USING (tenant_id = (SELECT current_tenant_id()))
         WITH CHECK (tenant_id = (SELECT current_tenant_id()))', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT coalesce(current_tenant_id(), %L::uuid)', t, workspace_one);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_has_membership(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM membership WHERE user_id = p_user_id)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION user_has_membership(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_has_membership(uuid) TO orion_tenant;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_self ON "tenant";
--> statement-breakpoint
CREATE POLICY tenant_self ON "tenant" FOR SELECT TO orion_tenant USING (id = (SELECT current_tenant_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS workspace_members ON "user";
--> statement-breakpoint
CREATE POLICY workspace_members ON "user" AS PERMISSIVE FOR ALL TO orion_tenant
  USING (
    EXISTS (SELECT 1 FROM membership m WHERE m.user_id = "user".id AND m.tenant_id = (SELECT current_tenant_id()))
    OR NOT user_has_membership("user".id)
  )
  WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS workspace_member_sessions ON "user_session";
--> statement-breakpoint
CREATE POLICY workspace_member_sessions ON "user_session" AS PERMISSIVE FOR ALL TO orion_tenant
  USING (EXISTS (SELECT 1 FROM membership m WHERE m.user_id = user_session.user_id AND m.tenant_id = (SELECT current_tenant_id())))
  WITH CHECK (EXISTS (SELECT 1 FROM membership m WHERE m.user_id = user_session.user_id AND m.tenant_id = (SELECT current_tenant_id())));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mirror_user_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The connected workspace (a ws_<id> role), else workspace #1 for the owner connection.
  INSERT INTO "membership" ("tenant_id", "user_id", "role", "status")
  VALUES (coalesce(current_tenant_id(), '00000000-0000-4000-8000-000000000001'::uuid), NEW."id", NEW."role", NEW."status")
  ON CONFLICT ("tenant_id", "user_id") DO UPDATE
    SET "role" = EXCLUDED."role",
        "status" = EXCLUDED."status",
        "authz_version" = "membership"."authz_version" + 1,
        "updated_at" = now()
    WHERE ("membership"."role", "membership"."status") IS DISTINCT FROM (EXCLUDED."role", EXCLUDED."status");
  RETURN NEW;
END;
$$;
