import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url)); // ESM __dirname
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle"); // root ./drizzle

export async function runMigrations(db: DB) {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// `npm run migrate` against the default file-backed client:
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { createDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath } = loadConfig();
  const { db, client } = createDb(dbPath);
  await runMigrations(db);
  console.log("Migrations applied.");
  await client.close(); // GOTCHA: file-backed PGlite keeps the loop alive — close or it hangs.
}
