/**
 * `npm run tenancy:check` (after `npm run build`): proves on THIS database, before
 * TENANT_DB_ROLES=on is set, that workspace isolation will work here (D55):
 *   1. workspace #1's role can be created and log in (on Supabase: through the pooler);
 *   2. connected as that role, the database reports it and shows exactly workspace #1's rows.
 * Prints PASS or FAIL per check and exits non-zero on any failure. Creates/updates the
 * ws_<workspace #1> role (idempotent); writes no business data. Never prints credentials.
 */
import { sql } from "drizzle-orm";
import { loadConfig, isPostgresUrl } from "../config.js";
import { closeDb, createDb } from "../db/client.js";
import { WORKSPACE_ONE_ID } from "../db/schema.js";
import { createWorkspaceConnections } from "../modules/tenancy/connections.js";
import { workspaceRoleName } from "../modules/tenancy/roles.js";

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!isPostgresUrl(config.databaseUrl)) throw new Error("tenancy:check needs a Postgres DATABASE_URL");
  const { db, client } = createDb({ databaseUrl: config.databaseUrl });
  const connections = createWorkspaceConnections({ platformDb: db, databaseUrl: config.databaseUrl, isolated: true });
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
    if (!ok) failed++;
  };

  try {
    const [owner] = rows<{ brands: number; tenants: number }>(
      await db.execute(sql`select (select count(*)::int from brand where tenant_id = ${WORKSPACE_ONE_ID}) as brands, (select count(*)::int from tenant) as tenants`),
    );
    const workspaceDb = await connections.dbFor(WORKSPACE_ONE_ID);
    const [seen] = rows<{ who: string; brands: number; tenants: number; foreign: number }>(
      await workspaceDb.execute(sql`select current_user as who,
        (select count(*)::int from brand) as brands,
        (select count(*)::int from tenant) as tenants,
        (select count(*)::int from brand where tenant_id <> ${WORKSPACE_ONE_ID}) as foreign`),
    );
    check("workspace role logs in", seen!.who === workspaceRoleName(WORKSPACE_ONE_ID), `connected as ${seen!.who}`);
    check("sees all of workspace #1's brands", seen!.brands === owner!.brands, `${seen!.brands} of ${owner!.brands}`);
    check("sees only its own workspace row", seen!.tenants === 1, `${seen!.tenants} visible of ${owner!.tenants}`);
    check("sees no other workspace's brands", seen!.foreign === 0, `${seen!.foreign}`);
  } catch (err) {
    check("workspace connection", false, err instanceof Error ? err.message : String(err));
  } finally {
    await connections.closeAll();
    await closeDb(client);
  }
  console.log(failed === 0 ? "tenancy:check PASSED: safe to set TENANT_DB_ROLES=on" : `tenancy:check FAILED (${failed}): keep TENANT_DB_ROLES off`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
