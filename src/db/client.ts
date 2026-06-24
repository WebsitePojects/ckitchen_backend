import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { isPostgresUrl } from "../config.js";
import * as schema from "./schema.js";

// Common base type for both backends (PGlite and postgres-js each extend PgDatabase with
// their own query-result HKT). Using the shared base — rather than a union of the two
// concrete return types — keeps every existing `DB`-typed consumer compiling unchanged
// regardless of which driver is active at runtime.
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface CreateDbOptions {
  /** PGlite data dir/path. Ignored when `databaseUrl` is a postgres:// URL. */
  dataDir?: string;
  /** Raw DATABASE_URL. When it's a postgres://|postgresql:// URL, connects via postgres-js. */
  databaseUrl?: string;
}

/**
 * Unified DB factory.
 *
 * - `databaseUrl` set to a `postgres://`/`postgresql://` URL (e.g. Supabase) => real Postgres
 *   via `drizzle-orm/postgres-js`. Connection options are tuned for Supabase's TRANSACTION
 *   POOLER (port 6543): `prepare: false` is REQUIRED there because the pooler does not support
 *   prepared statements, and `ssl: "require"` because Supabase requires TLS.
 * - Otherwise => PGlite, exactly as before: `dataDir` undefined => in-memory (tests),
 *   a path => file-backed (dev).
 *
 * Stays a plain sync function (no async/Promise) so existing call sites — including every
 * test's `createDb()` with no args — keep working unchanged.
 */
export function createDb(opts?: string | CreateDbOptions) {
  // Back-compat: `createDb(dataDir?)` (a plain string or undefined), as called by every
  // existing test and by server.ts/seed.ts/migrate.ts today.
  const { dataDir, databaseUrl } =
    typeof opts === "string" || opts === undefined ? { dataDir: opts, databaseUrl: undefined } : opts;

  if (isPostgresUrl(databaseUrl)) {
    const client = postgres(databaseUrl, { prepare: false, ssl: "require", max: 10 });
    const db = drizzlePostgres(client, { schema });
    return { client, db };
  }

  // GOTCHA: PGlite nodefs uses NON-recursive mkdir, so the PARENT folder must
  // exist first or you get ENOENT on Windows. Pre-create it ourselves.
  if (dataDir && !dataDir.startsWith("memory://")) {
    mkdirSync(dirname(dataDir), { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  return { client, db };
}

/**
 * Closes whichever client `createDb()` handed back. PGlite exposes `.close()`; postgres-js
 * exposes `.end()`. Standalone scripts (migrate/seed/seed:pilot) MUST call this or the
 * process never exits — both a file-backed PGlite and a postgres-js pool keep the event
 * loop alive otherwise.
 */
export async function closeDb(client: { close?: () => Promise<void>; end?: () => Promise<void> }) {
  if (typeof client.close === "function") {
    await client.close();
  } else if (typeof client.end === "function") {
    await client.end();
  }
}
