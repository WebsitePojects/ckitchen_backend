import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";

export type DB = ReturnType<typeof createDb>["db"];

/** dataDir undefined => in-memory (tests). A path => file-backed (dev). */
export function createDb(dataDir?: string) {
  // GOTCHA: PGlite nodefs uses NON-recursive mkdir, so the PARENT folder must
  // exist first or you get ENOENT on Windows. Pre-create it ourselves.
  if (dataDir && !dataDir.startsWith("memory://")) {
    mkdirSync(dirname(dataDir), { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  return { client, db };
}
