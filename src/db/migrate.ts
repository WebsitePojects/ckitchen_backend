import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import type { DB } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url)); // ESM __dirname
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle"); // root ./drizzle

/**
 * Applies the drizzle migrations in ./drizzle. Branches on which driver actually produced
 * `db` (checked via `instanceof`, not a passed-in flag) — the PGlite and postgres-js
 * migrators are separate functions upstream, but both accept `{ migrationsFolder }` and the
 * same migration files (schema is plain Postgres dialect). Detecting from `db` itself means
 * every existing call site — `runMigrations(db)` in tests, seed.ts, seed-pilot.ts — keeps
 * working unchanged whether `db` came from PGlite or a real Postgres (Supabase) connection.
 */
export async function runMigrations(db: DB) {
  if (db instanceof PgliteDatabase) {
    await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- distinct driver-specific DB type
    await migratePostgres(db as any, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

// `npm run migrate` — targets Supabase when DATABASE_URL is a postgres:// URL, otherwise
// the default file-backed PGlite:
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb, closeDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });
  await runMigrations(db);
  console.log("Migrations applied.");
  await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
}
