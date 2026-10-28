/**
 * Guard for workspace isolation (SaaS step 2+3, migration 0047): every table that holds a
 * business's data carries a NOT NULL tenant_id. Row-level security keys on that column, so
 * a table added later without it would be a hole in the wall. Adding a table means either
 * giving it tenant_id or adding it to one of the short, explained lists below.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { brands, locations, WORKSPACE_ONE_ID } from "../src/db/schema.js";

/** Platform identity: one person can belong to several workspaces. */
const PLATFORM_TABLES = ["tenant", "user", "user_session"];
/** Partner calls are stored before their listing (and so their workspace) is known. */
const PRE_TENANT_INBOXES = ["foodpanda_plugin_receipt", "grab_partner_receipt", "provider_event"];

let db: DB;

beforeAll(async () => {
  db = createDb().db;
  await runMigrations(db);
});

async function tenantColumns() {
  const result = await db.execute(sql`
    select t.table_name as "table", c.is_nullable as "nullable", c.column_default as "default"
    from information_schema.tables t
    left join information_schema.columns c
      on c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'tenant_id'
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    order by 1`);
  return (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
}

describe("every workspace table carries tenant_id", () => {
  it("is NOT NULL on all tables except platform identity and pre-tenant inboxes", async () => {
    const rows = (await tenantColumns()) as { table: string; nullable: string | null }[];
    const missing = rows
      .filter((r) => !PLATFORM_TABLES.includes(r.table) && !PRE_TENANT_INBOXES.includes(r.table))
      .filter((r) => r.nullable !== "NO")
      .map((r) => r.table);
    expect(missing, `tables without a NOT NULL tenant_id: ${missing.join(", ")}`).toEqual([]);
  });

  it("platform tables have no tenant_id; inboxes have a nullable one", async () => {
    const rows = (await tenantColumns()) as { table: string; nullable: string | null }[];
    for (const table of PLATFORM_TABLES) expect(rows.find((r) => r.table === table)?.nullable, table).toBeNull();
    for (const table of PRE_TENANT_INBOXES) expect(rows.find((r) => r.table === table)?.nullable, table).toBe("YES");
  });

  it("rows written by today's code land in workspace #1 (no behaviour change)", async () => {
    const [location] = await db.insert(locations).values({ code: "TEN1", name: "Tenancy Test Outlet" }).returning();
    const [brand] = await db
      .insert(brands)
      .values({ locationId: location!.id, name: "Tenancy Brand", color: "#123456", salesPerfId: "TEN-1" })
      .returning();
    const result = await db.execute(sql`select tenant_id from brand where id = ${brand!.id}`);
    const rows = ((result as unknown as { rows?: { tenant_id: string }[] }).rows ?? (result as unknown as { tenant_id: string }[]));
    expect(rows[0]!.tenant_id).toBe(WORKSPACE_ONE_ID);
  });
});

describe("business numbers are unique per workspace (migration 0048)", () => {
  const WORKSPACE_TWO = "00000000-0000-4000-8000-0000000000b2";

  beforeAll(async () => {
    await db.execute(sql`insert into tenant (id, slug, name) values (${WORKSPACE_TWO}, 'second-business', 'Second Business') on conflict do nothing`);
  });

  async function fails(statement: ReturnType<typeof sql>): Promise<boolean> {
    try {
      await db.execute(statement);
      return false;
    } catch {
      return true;
    }
  }

  it("a second workspace may reuse an outlet code, PO-style numbers and its own HQ main warehouse", async () => {
    await db.execute(sql`insert into location (code, name) values ('SHARED1', 'Workspace one outlet')`);
    expect(await fails(sql`insert into location (tenant_id, code, name) values (${WORKSPACE_TWO}, 'SHARED1', 'Workspace two outlet')`)).toBe(false);
    expect(await fails(sql`insert into location (code, name) values ('SHARED1', 'Duplicate in workspace one')`)).toBe(true);

    await db.execute(sql`insert into operational_feature_flag (key, enabled) values ('tenancy.test.flag', true)`);
    expect(await fails(sql`insert into operational_feature_flag (tenant_id, key, enabled) values (${WORKSPACE_TWO}, 'tenancy.test.flag', false)`)).toBe(false);
  });

  it("each workspace keeps exactly one active HQ main warehouse", async () => {
    // Workspace #1 already has its HQ, so the old database-wide rule would refuse workspace two's.
    const [one] = (await db.execute(sql`insert into location (code, name) values ('HQ1', 'First HQ') returning id`) as unknown as { rows: { id: string }[] }).rows;
    await db.execute(sql`insert into warehouse (location_id, type, purpose, code, name, is_active) values (${one!.id}, 'MAIN', 'HQ_MAIN', 'HQ-MAIN-1', 'HQ', true)`);
    const [two] = (await db.execute(sql`insert into location (tenant_id, code, name) values (${WORKSPACE_TWO}, 'HQ2', 'Second HQ') returning id`) as unknown as { rows: { id: string }[] }).rows;
    const hq = (code: string) =>
      sql`insert into warehouse (tenant_id, location_id, type, purpose, code, name, is_active) values (${WORKSPACE_TWO}, ${two!.id}, 'MAIN', 'HQ_MAIN', ${code}, 'HQ', true)`;
    expect(await fails(hq("HQ-MAIN-2"))).toBe(false);
    expect(await fails(hq("HQ-MAIN-2B"))).toBe(true);
  });

  it("role page rules and module switches are per workspace", async () => {
    expect(await fails(sql`insert into role_page_access (tenant_id, role, page_key, allowed) values (${WORKSPACE_TWO}, 'OWNER', '/tenancy-test', true)`)).toBe(false);
    expect(await fails(sql`insert into role_page_access (role, page_key, allowed) values ('OWNER', '/tenancy-test', true)`)).toBe(false);
    expect(await fails(sql`insert into role_page_access (tenant_id, role, page_key, allowed) values (${WORKSPACE_TWO}, 'OWNER', '/tenancy-test', false)`)).toBe(true);
    expect(await fails(sql`insert into business_module (tenant_id, key, enabled) values (${WORKSPACE_TWO}, 'tenancy-test', false)`)).toBe(false);
    expect(await fails(sql`insert into business_module (key, enabled) values ('tenancy-test', true)`)).toBe(false);
  });
});
