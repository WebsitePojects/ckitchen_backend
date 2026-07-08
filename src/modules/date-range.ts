/**
 * Shared date-range boundary parsing for report/analytics query params.
 *
 * BUG FIX (2026-07-08, user-visible: "Reports show no data even after
 * completing orders"): the frontend sends DATE-ONLY strings ("2026-07-08")
 * for `from`/`to`. `new Date("2026-07-08")` is midnight UTC, so using it as
 * the `to` bound (`placed_at <= to`) excluded every order placed later that
 * same day — i.e. every order placed TODAY.
 *
 * Fix: a date-only param expands to the FULL day it names —
 *   from → <day>T00:00:00.000Z (inclusive start of day)
 *   to   → <day>T23:59:59.999Z (inclusive end of day)
 * Full ISO datetime strings pass through unchanged (`new Date(str)`), so
 * callers that already send precise instants keep their exact semantics.
 *
 * Used by src/modules/analytics/service.ts (brands / orders-by-hour /
 * orders-by-hour-by-brand / aggregators / margins / products) and
 * src/modules/reports/routes.ts (GET /reports/sales + /reports/sales/export).
 */

/** Matches a date-only param exactly: YYYY-MM-DD, nothing more. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a `from`/`to` query param into a Date.
 *
 * - Date-only ("2026-07-08"): expands to the boundary of that UTC day —
 *   `"from"` → T00:00:00.000Z, `"to"` → T23:59:59.999Z.
 * - Anything else (full ISO datetimes): passed to `new Date()` unchanged.
 *   Unparseable input yields an Invalid Date, exactly as before — callers
 *   that validate (reports/routes.ts resolveRange) keep their 400 behavior.
 */
export function parseRangeBoundary(value: string, boundary: "from" | "to"): Date {
  if (DATE_ONLY_RE.test(value)) {
    return new Date(
      boundary === "from" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`,
    );
  }
  return new Date(value);
}
