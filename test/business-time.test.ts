/**
 * Business-day boundaries (Asia/Manila, UTC+8, no DST).
 *
 * The case that motivated this module: a cook clocks in at 07:30 Manila
 * (23:30 UTC the previous day). With UTC days, "today" flipped at 08:00 Manila
 * and the punch no longer counted, locking the cook out mid-shift.
 */
import { describe, expect, it } from "vitest";
import {
  BUSINESS_DAY_START_HOUR,
  BUSINESS_TIMEZONE,
  addDays,
  localDate,
  localDayEnd,
  localDayRange,
  localDayStart,
  localMonthRange,
} from "../src/modules/business-time.js";

describe("business-time (Asia/Manila)", () => {
  it("defaults to Asia/Manila", () => {
    expect(BUSINESS_TIMEZONE).toBe("Asia/Manila");
  });

  it("a business day runs 05:00 to 04:59:59.999 Manila (21:00Z the previous day to 20:59:59.999Z)", () => {
    expect(BUSINESS_DAY_START_HOUR).toBe(5);
    expect(localDayStart("2026-10-27").toISOString()).toBe("2026-10-26T21:00:00.000Z");
    expect(localDayEnd("2026-10-27").toISOString()).toBe("2026-10-27T20:59:59.999Z");
  });

  it("a late shift 16:00 -> 01:30 Manila stays on one business day", () => {
    const timeIn = new Date("2026-10-27T08:00:00.000Z"); // 16:00 Manila on the 27th
    const timeOut = new Date("2026-10-27T17:30:00.000Z"); // 01:30 Manila on the 28th
    expect(localDate(timeIn)).toBe("2026-10-27");
    expect(localDate(timeOut)).toBe("2026-10-27");
  });

  it("07:30 Manila (23:30Z) belongs to the Manila date, not the UTC date", () => {
    const punch = new Date("2026-10-26T23:30:00.000Z");
    expect(localDate(punch)).toBe("2026-10-27");
    // At 08:30 Manila (00:30Z) the same day is still "today", so the punch still counts.
    const later = new Date("2026-10-27T00:30:00.000Z");
    const { start, end } = localDayRange(later);
    expect(punch.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(punch.getTime()).toBeLessThanOrEqual(end.getTime());
  });

  it("month range covers the whole Manila month, including year rollover", () => {
    const oct = localMonthRange(2026, 10);
    expect(oct.start.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(oct.end.toISOString()).toBe("2026-10-31T20:59:59.999Z");
    const dec = localMonthRange(2026, 12);
    expect(dec.end.toISOString()).toBe("2026-12-31T20:59:59.999Z");
  });

  it("addDays handles month and leap-year boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("rejects malformed dates loudly", () => {
    expect(() => localDayStart("27-10-2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("sslOptionFor (database TLS policy)", async () => {
  const { sslOptionFor } = await import("../src/db/client.js");
  it("allows plaintext only for a loopback host that opts out", () => {
    expect(sslOptionFor("postgres://u:p@127.0.0.1:55432/db?sslmode=disable")).toBe(false);
    expect(sslOptionFor("postgres://u:p@localhost:5432/db?sslmode=disable")).toBe(false);
  });
  it("keeps TLS for remote hosts even when the URL asks to disable it", () => {
    expect(sslOptionFor("postgres://u:p@aws-1-ap-northeast-1.pooler.supabase.com:5432/db?sslmode=disable")).toBe("require");
    expect(sslOptionFor("postgres://u:p@10.0.0.5:5432/db?sslmode=disable")).toBe("require");
  });
  it("defaults to TLS", () => {
    expect(sslOptionFor("postgres://u:p@127.0.0.1:5432/db")).toBe("require");
    expect(sslOptionFor("not a url")).toBe("require");
  });
});
