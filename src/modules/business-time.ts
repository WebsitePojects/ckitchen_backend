/**
 * Business-day boundaries in the business's own timezone.
 *
 * WHY: every "today", "this month" and per-day/per-hour grouping used to be computed in
 * UTC. The kitchen runs on Manila time (UTC+8), so:
 *   - orders placed 00:00-07:59 Manila landed on the previous day in reports;
 *   - the attendance "today" flipped at 08:00 Manila, so a cook who clocked in at 07:30
 *     was treated as not clocked in from 08:00 and locked out mid-shift.
 * All of those now go through this module.
 *
 * A business day does not start at midnight. Like restaurant POS end-of-day, it starts at
 * `BUSINESS_DAY_START_HOUR` (default 05:00) local time, so a late shift (16:00 -> 01:30)
 * and the orders after midnight belong to the day the shift started. Midnight days split
 * those shifts in two; UTC days only looked right because UTC midnight is 08:00 Manila,
 * which in turn locked out cooks who clocked in before 08:00.
 *
 * `BUSINESS_TIMEZONE` (IANA name) and `BUSINESS_DAY_START_HOUR` (0-23) override the
 * defaults. Invalid values fail at startup instead of silently misdating every report.
 */

import { sql, type SQL } from "drizzle-orm";

const DEFAULT_TIMEZONE = "Asia/Manila";

function resolveTimezone(): string {
  const tz = process.env.BUSINESS_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`BUSINESS_TIMEZONE "${tz}" is not a valid IANA timezone (e.g. Asia/Manila).`);
  }
  return tz;
}

export const BUSINESS_TIMEZONE = resolveTimezone();

function resolveDayStartHour(): number {
  const raw = process.env.BUSINESS_DAY_START_HOUR?.trim();
  if (!raw) return 5;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`BUSINESS_DAY_START_HOUR "${raw}" must be a whole hour from 0 to 23.`);
  }
  return hour;
}

/** Local hour at which a business day begins (orders/punches before it belong to the previous day). */
export const BUSINESS_DAY_START_HOUR = resolveDayStartHour();
const DAY_START_MS = BUSINESS_DAY_START_HOUR * 3_600_000;

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minutes the timezone is ahead of UTC at a given instant (Manila: +480). */
function offsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((wallClockAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant business day `ymd` (YYYY-MM-DD) begins: local midnight + BUSINESS_DAY_START_HOUR. */
export function localDayStart(ymd: string, tz: string = BUSINESS_TIMEZONE): Date {
  return new Date(localMidnight(ymd, tz).getTime() + DAY_START_MS);
}

/** The instant local midnight starts on `ymd` in the timezone (calendar boundary). */
function localMidnight(ymd: string, tz: string): Date {
  const m = YMD_RE.exec(ymd);
  if (!m) throw new Error(`Expected a YYYY-MM-DD date, got "${ymd}".`);
  const naiveUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Two passes so a DST transition near midnight still resolves to the right instant.
  let start = naiveUtc - offsetMinutes(new Date(naiveUtc), tz) * 60_000;
  start = naiveUtc - offsetMinutes(new Date(start), tz) * 60_000;
  return new Date(start);
}

/** The last millisecond of `ymd` in the business timezone (inclusive end bound). */
export function localDayEnd(ymd: string, tz: string = BUSINESS_TIMEZONE): Date {
  return new Date(localDayStart(addDays(ymd, 1), tz).getTime() - 1);
}

/** The business date (YYYY-MM-DD) an instant belongs to: 01:30 counts toward the previous day. */
export function localDate(at: Date = new Date(), tz: string = BUSINESS_TIMEZONE): string {
  const shifted = new Date(at.getTime() - DAY_START_MS);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
}

/** Start and end instants of the business-local day containing `at`. */
export function localDayRange(at: Date = new Date(), tz: string = BUSINESS_TIMEZONE): { start: Date; end: Date } {
  const ymd = localDate(at, tz);
  return { start: localDayStart(ymd, tz), end: localDayEnd(ymd, tz) };
}

/** Start and end instants of business-local month `month` (1-12) of `year`. */
export function localMonthRange(year: number, month: number, tz: string = BUSINESS_TIMEZONE): { start: Date; end: Date } {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { start: localDayStart(first, tz), end: new Date(localDayStart(next, tz).getTime() - 1) };
}

/** Calendar arithmetic on a YYYY-MM-DD string (timezone-free). */
export function addDays(ymd: string, days: number): string {
  const m = YMD_RE.exec(ymd);
  if (!m) throw new Error(`Expected a YYYY-MM-DD date, got "${ymd}".`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/**
 * The business timezone as an inline SQL string literal, for `AT TIME ZONE`.
 * Inlined rather than bound: Postgres treats `GROUP BY ... AT TIME ZONE $3` as a different
 * expression from the SELECT's `... AT TIME ZONE $1` and rejects the query. Safe because the
 * name already passed Intl's IANA validation above; quotes are escaped regardless.
 */
export const BUSINESS_TZ_SQL = sql.raw(`'${BUSINESS_TIMEZONE.replace(/'/g, "''")}'`);

/**
 * SQL for the business date (YYYY-MM-DD text) of a timestamptz column, matching `localDate`:
 * shift to local wall time, then back by the day-start hour. Literal, for the same GROUP BY
 * reason as BUSINESS_TZ_SQL.
 */
export function businessDateSql(column: SQL): SQL {
  return sql`TO_CHAR((${column} AT TIME ZONE ${BUSINESS_TZ_SQL}) - INTERVAL '${sql.raw(String(BUSINESS_DAY_START_HOUR))} hours', 'YYYY-MM-DD')`;
}
