/**
 * Postgres error recognition shared by route handlers.
 *
 * Errors arrive wrapped differently per driver: postgres-js puts `code` and
 * `constraint_name` on the error, PGlite (tests) uses `code` and `constraint`, and drizzle
 * may wrap either in an error whose `cause` is the driver error. These helpers look through
 * one level of `cause` so callers never depend on which driver ran the query.
 */

function driverFields(err: unknown): Array<Record<string, unknown>> {
  if (!err || typeof err !== "object") return [];
  const outer = err as Record<string, unknown>;
  const cause = outer["cause"];
  return cause && typeof cause === "object" ? [outer, cause as Record<string, unknown>] : [outer];
}

/**
 * True for a unique violation (SQLSTATE 23505). With `constraint`, true only when that
 * named constraint or unique index was the one violated, so one insert can map different
 * duplicates to different answers (an email taken vs a login already linked).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return driverFields(err).some((e) => {
    if (e["code"] !== "23505") return false;
    if (constraint === undefined) return true;
    return e["constraint_name"] === constraint || e["constraint"] === constraint;
  });
}
