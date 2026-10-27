/**
 * Rows from a raw `db.execute(sql`...`)` result, whichever driver ran it: postgres-js
 * (Supabase / Docker) returns the row array itself, PGlite (tests, local) returns { rows }.
 */
export function toRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  return (raw as { rows?: T[] }).rows ?? [];
}
