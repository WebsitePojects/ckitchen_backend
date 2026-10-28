/**
 * The workspace wall at the database level (migration 0049): a connection logged in as a
 * workspace role (ws_<id>) sees and writes only its own workspace's rows. Simulated with
 * SET ROLE on the test database, which applies RLS exactly as a real login would; the
 * owner connection (tests, migrations, workers) keeps seeing everything.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { WORKSPACE_ONE_ID } from "../src/db/schema.js";

const WORKSPACE_TWO = "00000000-0000-4000-8000-0000000000c2";
const roleOf = (tenantId: string) => `ws_${tenantId.replace(/-/g, "")}`;

let db: DB;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

async function as<T>(tenantId: string, query: ReturnType<typeof sql>): Promise<T[]> {
  await db.execute(sql.raw(`SET ROLE ${roleOf(tenantId)}`));
  try {
    return rows<T>(await db.execute(query));
  } finally {
    await db.execute(sql.raw("RESET ROLE"));
  }
}

async function fails(tenantId: string, query: ReturnType<typeof sql>): Promise<boolean> {
  try {
    await as(tenantId, query);
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  db = createDb().db;
  await runMigrations(db);
  await db.execute(sql`insert into tenant (id, slug, name) values (${WORKSPACE_TWO}, 'rls-two', 'RLS Two') on conflict do nothing`);
  for (const id of [WORKSPACE_ONE_ID, WORKSPACE_TWO]) {
    await db.execute(sql.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleOf(id)}') THEN CREATE ROLE ${roleOf(id)} NOLOGIN IN ROLE orion_tenant; END IF; END $$`));
  }
  // Workspace #1 data written the way today's code writes it (owner connection, default).
  await db.execute(sql`insert into location (code, name) values ('RLS1', 'Workspace one outlet')`);
  await db.execute(sql`insert into "user" (name, email, password_hash, role) values ('One Owner', 'one.owner@example.com', 'x', 'OWNER')`);
});

afterEach(async () => {
  await db.execute(sql.raw("RESET ROLE"));
});

describe("a workspace role sees only its own workspace", () => {
  it("reads: workspace two sees none of workspace one's rows", async () => {
    expect(await as(WORKSPACE_TWO, sql`select id from location where code = 'RLS1'`)).toHaveLength(0);
    expect(await as(WORKSPACE_ONE_ID, sql`select id from location where code = 'RLS1'`)).toHaveLength(1);
  });

  it("writes: rows land in the connected workspace by default", async () => {
    const [created] = await as<{ tenant_id: string }>(WORKSPACE_TWO, sql`insert into location (code, name) values ('RLS2', 'Workspace two outlet') returning tenant_id`);
    expect(created!.tenant_id).toBe(WORKSPACE_TWO);
    expect(await as(WORKSPACE_ONE_ID, sql`select id from location where code = 'RLS2'`)).toHaveLength(0);
  });

  it("a workspace cannot write a row into another workspace, nor change or delete its rows", async () => {
    expect(await fails(WORKSPACE_TWO, sql`insert into location (tenant_id, code, name) values (${WORKSPACE_ONE_ID}, 'SNEAK', 'Sneaky')`)).toBe(true);
    const updated = await as(WORKSPACE_TWO, sql`update location set name = 'hijacked' where code = 'RLS1' returning id`);
    expect(updated).toHaveLength(0);
    const deleted = await as(WORKSPACE_TWO, sql`delete from location where code = 'RLS1' returning id`);
    expect(deleted).toHaveLength(0);
    const [one] = rows<{ name: string }>(await db.execute(sql`select name from location where code = 'RLS1'`));
    expect(one!.name).toBe("Workspace one outlet");
  });

  it("platform tables: own workspace row only, members only, no workspace creation", async () => {
    const tenants = await as<{ id: string }>(WORKSPACE_TWO, sql`select id from tenant`);
    expect(tenants.map((t) => t.id)).toEqual([WORKSPACE_TWO]);
    expect(await as(WORKSPACE_TWO, sql`select id from "user" where email = 'one.owner@example.com'`)).toHaveLength(0);
    expect(await as(WORKSPACE_ONE_ID, sql`select id from "user" where email = 'one.owner@example.com'`)).toHaveLength(1);
    expect(await fails(WORKSPACE_TWO, sql`insert into tenant (slug, name) values ('sneaky-new', 'Sneaky')`)).toBe(true);
  });

  it("a user created inside a workspace becomes a member of that workspace only", async () => {
    const [user] = await as<{ id: string }>(
      WORKSPACE_TWO,
      sql`insert into "user" (name, email, password_hash, role) values ('Two Cook', 'two.cook@example.com', 'x', 'KITCHEN_CREW') returning id`,
    );
    const memberships = rows<{ tenant_id: string }>(await db.execute(sql`select tenant_id from membership where user_id = ${user!.id}`));
    expect(memberships.map((m) => m.tenant_id)).toEqual([WORKSPACE_TWO]);
    expect(await as(WORKSPACE_ONE_ID, sql`select id from "user" where id = ${user!.id}`)).toHaveLength(0);
  });

  it("the owner connection still sees every workspace (migrations, provisioning, workers)", async () => {
    const all = rows<{ code: string }>(await db.execute(sql`select code from location where code in ('RLS1', 'RLS2') order by code`));
    expect(all.map((r) => r.code)).toEqual(["RLS1", "RLS2"]);
  });
});

describe("every workspace table is behind the wall", () => {
  it("each table with tenant_id has RLS forced and the isolation policy", async () => {
    const missing = rows<{ table_name: string }>(
      await db.execute(sql`
        select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'r'
          and exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'tenant_id')
          and (not c.relrowsecurity or not c.relforcerowsecurity
               or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'tenant_isolation'))`),
    );
    expect(missing.map((r) => r.table_name)).toEqual([]);
  });
});
