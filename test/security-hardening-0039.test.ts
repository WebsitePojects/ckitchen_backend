/**
 * Migration 0039 (security hardening). Runs every migration on a fresh PGlite DB.
 * PGlite has no `anon` / `authenticated` roles and no `public.rls_auto_enable()`, so a
 * successful run also proves the Supabase-only REVOKE blocks are correctly guarded:
 * if they were not, `runMigrations` in beforeAll would throw and every test here would fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const PINNED_TRIGGER_FUNCTIONS = [
  "bom_version_write_guard",
  "bom_component_write_guard",
  "job_order_production_warehouse_check",
  "job_order_component_allocation_append_only",
  "job_order_output_lot_append_only",
  "transfer_order_line_posting_append_only",
  "qa_release_route_check",
  "qa_release_line_append_only",
  "forbid_mutation",
  "bom_header_output_item_type_check",
];

let db: DB;
let client: ReturnType<typeof createDb>["client"];

/** Runs raw SQL on the PGlite-backed test DB and returns the row array. */
async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

describe("migration 0039 security hardening", () => {
  it("forces and enables row level security on every ordinary public table", async () => {
    const tables = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `);

    expect(tables.length).toBeGreaterThan(0); // guard against a vacuous pass

    // FORCE is asserted on its own: removing the FORCE block must fail this test even
    // though earlier migrations already enabled plain RLS.
    const notForced = tables.filter((t) => !t.relforcerowsecurity).map((t) => t.relname);
    expect(notForced).toEqual([]);
    const notEnabled = tables.filter((t) => !t.relrowsecurity).map((t) => t.relname);
    expect(notEnabled).toEqual([]);
  });

  it("pins search_path on all 10 trigger functions", async () => {
    const functions = await rows<{ proname: string; proconfig: string[] | null }>(sql`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.pronargs = 0
        AND p.proname = ANY(${sql.raw(`ARRAY['${PINNED_TRIGGER_FUNCTIONS.join("','")}']`)})
    `);

    expect(functions.map((f) => f.proname).sort()).toEqual([...PINNED_TRIGGER_FUNCTIONS].sort());
    const unpinned = functions
      .filter((f) => !(f.proconfig ?? []).some((entry) => entry.startsWith("search_path=")))
      .map((f) => f.proname);
    expect(unpinned).toEqual([]);
  });
});
