import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { isPostgresUrl } from "../config.js";
import * as enterpriseSchema from "./enterprise-schema.js";
import * as legacySchema from "./schema.js";
import * as productionSchema from "./production-schema.js";
import * as returnsSchema from "./returns-schema.js";
import * as customerOrdersSchema from "./customer-orders-schema.js";
import * as transferOrdersSchema from "./transfer-orders-schema.js";
import * as w4Schema from "./w4-schema.js";
import * as middlewareSchema from "./middleware-schema.js";

// Drizzle receives all bounded schema modules. The legacy module remains the
// compatibility surface; enterprise-schema owns D35-D46 core stock tables;
// returns-schema owns the D35-D46 §5 Stock Return Batch tables; production-schema
// owns the D35-D46 §6 BOM/Job Order tables; customer-orders-schema owns the
// D35-D46 §7 Customer Order/allocation/fulfillment tables; transfer-orders-schema
// owns the D35-D46 §2 HQ Transfer Order and QA Release tables; w4-schema owns
// the W4 client-rules foundation (discount evidence audit log + channel
// commercial terms, spec §10/§6/§7); middleware-schema owns the §11 provider
// event store (webhook intake + async processor).
const schema = {
  ...legacySchema,
  ...enterpriseSchema,
  ...returnsSchema,
  ...productionSchema,
  ...customerOrdersSchema,
  ...transferOrdersSchema,
  ...w4Schema,
  ...middlewareSchema,
};

// PGlite contrib extension required by migration 0032's `channel_commercial_term`
// EXCLUDE USING gist constraint (overlap prevention on effective-dated commercial
// terms). Registered on every PGlite instance (in-memory + file-backed) so
// `CREATE EXTENSION IF NOT EXISTS btree_gist` in the migration succeeds under
// both the test harness and `npm run migrate`'s local dev path. Real Postgres
// (Supabase, via postgres-js below) ships btree_gist as a standard contrib
// extension already available to `CREATE EXTENSION`.
const pgliteExtensions = { btree_gist };

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
  // GOTCHA: PGlite's constructor overload resolution does NOT treat an
  // explicitly-passed `undefined` dataDir the same as omitting the argument
  // entirely -- calling `new PGlite(undefined, { extensions })` silently
  // fails to register the extensions (CREATE EXTENSION later errors
  // "extension \"btree_gist\" is not available"), while `new PGlite({
  // extensions })` (single-arg form) works. So the in-memory (falsy dataDir)
  // case must call the one-argument constructor, not pass `undefined`
  // positionally.
  const client = dataDir
    ? new PGlite(dataDir, { extensions: pgliteExtensions })
    : new PGlite({ extensions: pgliteExtensions });
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
