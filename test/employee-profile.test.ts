/**
 * Employee 360 — work schedule + profile endpoint tests (migration 0025)
 *
 * Covers:
 *   - work_days round-trip: POST with SAT/SUN → list returns ["SAT","SUN"];
 *     a row with garbage CSV in the DB falls back to the default 5-day week
 *   - PATCH /employees/:id — updates work_days + hired_at (OWNER-gated),
 *     strips unknown keys from old clients, 404 unknown id
 *   - GET /employees/:id/profile?month=YYYY-MM —
 *       PRESENT day (paired punches) with worked_minutes + photos
 *       ABSENT (scheduled, no punch, past, post-hire)
 *       REST (unscheduled day; pre-hire scheduled day)
 *       FUTURE (day after today)
 *       FORFEITED (unpaired TIME_IN >24h old)
 *       OPEN (unpaired TIME_IN ≤24h old)
 *       stats math over the month
 *       invalid month → 400; unknown employee → 404
 *
 * Deterministic fixture month: 2026-05 (fully in the past — May 2026 has
 * 21 MON-FRI weekdays + 10 weekend days; 2026-05-05 is a TUE, 2026-05-06 a WED).
 * Punches are inserted directly (controlled captured_at) so no Cloudinary mock
 * is needed — the profile endpoint never uploads.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { attendanceRecords, employees } from "../src/db/schema.js";

let app: Express;
let db: DB;

let adminToken: string;
let kitchenToken: string;

const PHOTO = (name: string) => ({
  photoUrl: `https://res.cloudinary.com/test/image/upload/ck1/attendance/${name}.jpg`,
  photoPublicId: `ck1/attendance/${name}`,
});

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

async function createEmployee(body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/v1/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; workDays: string[]; hiredAt: string | null };
}

async function getProfile(id: string, month?: string) {
  const url = month
    ? `/api/v1/employees/${id}/profile?month=${month}`
    : `/api/v1/employees/${id}/profile`;
  return request(app).get(url).set("Authorization", `Bearer ${adminToken}`);
}

interface ProfileDay {
  date: string;
  scheduled: boolean;
  status: "PRESENT" | "ABSENT" | "REST" | "FUTURE" | "FORFEITED" | "OPEN";
  time_in: { at: string; photo_url: string } | null;
  time_out: { at: string; photo_url: string } | null;
  worked_minutes: number | null;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// work_days round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("employee work_days round-trip", () => {
  it("POST with SAT/SUN set → list returns them (canonical order, deduped)", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-WKND",
      full_name: "Weekend Worker",
      department: "KITCHEN",
      work_days: ["SUN", "SAT", "SUN"], // unordered + dupe on purpose
    });
    expect(created.workDays).toEqual(["SAT", "SUN"]);

    const listRes = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body as Array<{ id: string; workDays: string[] }>).find(
      (e) => e.id === created.id,
    );
    expect(row).toBeTruthy();
    expect(row!.workDays).toEqual(["SAT", "SUN"]);
  });

  it("POST without work_days → DB default 5-day week comes back", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-DFLT",
      full_name: "Default Week Worker",
      department: "ADMIN",
    });
    expect(created.workDays).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
    expect(created.hiredAt).toBeNull();
  });

  it("a row with garbage CSV in the DB falls back to the default 5", async () => {
    const [row] = await db
      .insert(employees)
      .values({
        employeeNo: "EMP-360-GARBAGE",
        fullName: "Garbage CSV Employee",
        department: "ADMIN",
        status: "ACTIVE",
        workDays: "garbage,,XYZ, mon day", // nothing valid in here
      })
      .returning();

    const listRes = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    const found = (listRes.body as Array<{ id: string; workDays: string[] }>).find(
      (e) => e.id === row!.id,
    );
    expect(found).toBeTruthy();
    expect(found!.workDays).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
  });

  it("POST rejects an invalid work_days token or an empty array (400)", async () => {
    const bad = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: "EMP-360-BADWD",
        full_name: "Bad WorkDays",
        department: "ADMIN",
        work_days: ["FUNDAY"],
      });
    expect(bad.status).toBe(400);

    const empty = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: "EMP-360-EMPTYWD",
        full_name: "Empty WorkDays",
        department: "ADMIN",
        work_days: [],
      });
    expect(empty.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /employees/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/v1/employees/:id", () => {
  it("updates work_days + hired_at (and strips unknown keys from old clients)", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-PATCH",
      full_name: "Patch Target",
      department: "WAREHOUSE",
    });

    const res = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        work_days: ["FRI", "MON", "WED"], // unordered on purpose
        hired_at: "2026-01-15",
        some_legacy_field: "ignored", // unknown key must not break (zod strip)
      });
    expect(res.status).toBe(200);
    expect(res.body.workDays).toEqual(["MON", "WED", "FRI"]);
    expect(res.body.hiredAt).toBe("2026-01-15");

    // Round-trips through the list too
    const listRes = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    const row = (listRes.body as Array<{ id: string; workDays: string[]; hiredAt: string | null }>).find(
      (e) => e.id === created.id,
    );
    expect(row!.workDays).toEqual(["MON", "WED", "FRI"]);
    expect(row!.hiredAt).toBe("2026-01-15");
  });

  it("hired_at can be cleared with null", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-CLRHIRE",
      full_name: "Clear Hire Date",
      department: "ADMIN",
      hired_at: "2026-02-02",
    });
    expect(created.hiredAt).toBe("2026-02-02");

    const res = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ hired_at: null });
    expect(res.status).toBe(200);
    expect(res.body.hiredAt).toBeNull();
  });

  it("404 for an unknown employee id", async () => {
    const res = await request(app)
      .patch("/api/v1/employees/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ full_name: "Nobody" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("403 for a non-OWNER (same gating as create)", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-RBAC",
      full_name: "Rbac Target",
      department: "ADMIN",
    });
    const res = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ full_name: "Hacked" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("400 for an invalid hired_at format", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-BADDATE",
      full_name: "Bad Date Target",
      department: "ADMIN",
    });
    const res = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ hired_at: "15-01-2026" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /employees/:id/profile — deterministic May 2026 fixture
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/employees/:id/profile — month calendar + stats", () => {
  /**
   * PROF-1: default MON-FRI schedule, hired 2026-04-01 (before the fixture
   * month so every scheduled May day counts).
   *   2026-05-05 (TUE): paired 08:00→17:30 UTC  → PRESENT, 570 min
   *   2026-05-06 (WED): unpaired TIME_IN (>24h old now) → FORFEITED
   *   all other 19 weekdays → ABSENT; 10 weekend days → REST
   */
  let profEmpId: string;

  beforeAll(async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-PROF1",
      full_name: "Profile Fixture One",
      department: "KITCHEN",
      hired_at: "2026-04-01",
    });
    profEmpId = created.id;

    await db.insert(attendanceRecords).values([
      {
        employeeId: profEmpId,
        type: "TIME_IN",
        ...PHOTO("prof1-in"),
        capturedAt: new Date("2026-05-05T08:00:00Z"),
      },
      {
        employeeId: profEmpId,
        type: "TIME_OUT",
        ...PHOTO("prof1-out"),
        capturedAt: new Date("2026-05-05T17:30:00Z"), // 570 minutes later
      },
      {
        employeeId: profEmpId,
        type: "TIME_IN",
        ...PHOTO("prof1-lone"),
        capturedAt: new Date("2026-05-06T08:00:00Z"), // never paired → forfeited
      },
    ]);
  });

  it("401 without token", async () => {
    const res = await request(app).get(`/api/v1/employees/${profEmpId}/profile`);
    expect(res.status).toBe(401);
  });

  it("404 for an unknown employee id", async () => {
    const res = await getProfile("00000000-0000-0000-0000-000000000000", "2026-05");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400 for an invalid month format", async () => {
    for (const bad of ["garbage", "2026-13", "2026-5", "05-2026"]) {
      const res = await getProfile(profEmpId, bad);
      expect(res.status, `month=${bad}`).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns a dense days array for the whole month with the employee header", async () => {
    const res = await getProfile(profEmpId, "2026-05");
    expect(res.status).toBe(200);
    expect(res.body.month).toBe("2026-05");
    expect(res.body.employee.id).toBe(profEmpId);
    expect(res.body.employee.employeeNo).toBe("EMP-360-PROF1");
    expect(res.body.employee.workDays).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
    expect(res.body.employee.hiredAt).toBe("2026-04-01");

    const days = res.body.days as ProfileDay[];
    expect(days.length).toBe(31); // dense: every day of May
    expect(days[0]!.date).toBe("2026-05-01");
    expect(days[30]!.date).toBe("2026-05-31");
  });

  it("paired punches → PRESENT day with worked_minutes + both photos", async () => {
    const res = await getProfile(profEmpId, "2026-05");
    const days = res.body.days as ProfileDay[];
    const day = days.find((d) => d.date === "2026-05-05")!;

    expect(day.scheduled).toBe(true);
    expect(day.status).toBe("PRESENT");
    expect(day.worked_minutes).toBe(570);
    expect(day.time_in!.at).toBe("2026-05-05T08:00:00.000Z");
    expect(day.time_in!.photo_url).toContain("prof1-in");
    expect(day.time_out!.at).toBe("2026-05-05T17:30:00.000Z");
    expect(day.time_out!.photo_url).toContain("prof1-out");
  });

  it("unpaired TIME_IN >24h old → FORFEITED with null worked_minutes", async () => {
    const res = await getProfile(profEmpId, "2026-05");
    const days = res.body.days as ProfileDay[];
    const day = days.find((d) => d.date === "2026-05-06")!;

    expect(day.status).toBe("FORFEITED");
    expect(day.worked_minutes).toBeNull();
    expect(day.time_in!.photo_url).toContain("prof1-lone");
    expect(day.time_out).toBeNull();
  });

  it("scheduled past day without punches → ABSENT; unscheduled → REST", async () => {
    const res = await getProfile(profEmpId, "2026-05");
    const days = res.body.days as ProfileDay[];

    const monday = days.find((d) => d.date === "2026-05-04")!; // MON, no punches
    expect(monday.scheduled).toBe(true);
    expect(monday.status).toBe("ABSENT");
    expect(monday.time_in).toBeNull();

    const saturday = days.find((d) => d.date === "2026-05-02")!; // SAT
    expect(saturday.scheduled).toBe(false);
    expect(saturday.status).toBe("REST");
  });

  it("stats aggregate the month correctly", async () => {
    const res = await getProfile(profEmpId, "2026-05");
    // May 2026: 21 weekdays (all scheduled + post-hire), 10 weekend days.
    // 1 PRESENT + 1 FORFEITED on weekdays → 19 ABSENT.
    expect(res.body.stats).toEqual({
      scheduled_days: 21,
      present_days: 1,
      absent_days: 19,
      rest_days: 10,
      forfeited: 1,
      open: 0,
      total_worked_minutes: 570,
    });
  });

  it("pre-hire scheduled days are REST, not ABSENT", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-PREHIRE",
      full_name: "Hired Mid-May",
      department: "ADMIN",
      hired_at: "2026-05-15", // FRI
    });

    const res = await getProfile(created.id, "2026-05");
    expect(res.status).toBe(200);
    const days = res.body.days as ProfileDay[];

    const preHireMonday = days.find((d) => d.date === "2026-05-04")!; // MON before hire
    expect(preHireMonday.scheduled).toBe(true);
    expect(preHireMonday.status).toBe("REST"); // NOT absent

    const hireDay = days.find((d) => d.date === "2026-05-15")!; // FRI, hire day itself
    expect(hireDay.status).toBe("ABSENT"); // scheduled, no punch, past

    const postHireMonday = days.find((d) => d.date === "2026-05-18")!;
    expect(postHireMonday.status).toBe("ABSENT");

    // Weekdays from 2026-05-15 on: 15,18,19,20,21,22,25,26,27,28,29 = 11
    expect(res.body.stats.scheduled_days).toBe(11);
    expect(res.body.stats.absent_days).toBe(11);
    expect(res.body.stats.rest_days).toBe(20); // 10 weekends + 10 pre-hire weekdays
    expect(res.body.stats.present_days).toBe(0);
  });

  it("days after today → FUTURE (fully future month is all FUTURE, zero stats)", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-FUTURE",
      full_name: "Future Month Employee",
      department: "ADMIN",
      hired_at: "2026-01-01",
    });

    // Two months ahead of "now" is always a fully-future month.
    const now = new Date();
    const future = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const futureMonth = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, "0")}`;

    const res = await getProfile(created.id, futureMonth);
    expect(res.status).toBe(200);
    const days = res.body.days as ProfileDay[];
    expect(days.length).toBeGreaterThanOrEqual(28);
    for (const d of days) {
      expect(d.status).toBe("FUTURE");
      expect(d.worked_minutes).toBeNull();
    }
    expect(res.body.stats).toEqual({
      scheduled_days: 0,
      present_days: 0,
      absent_days: 0,
      rest_days: 0,
      forfeited: 0,
      open: 0,
      total_worked_minutes: 0,
    });
  });

  it("a fresh unpaired TIME_IN (≤24h) → OPEN; month defaults to the current month", async () => {
    const created = await createEmployee({
      employee_no: "EMP-360-OPEN",
      full_name: "Open Shift Employee",
      department: "ADMIN",
      hired_at: "2026-01-01",
    });

    const capturedAt = new Date(); // just now → same UTC day, same month
    await db.insert(attendanceRecords).values({
      employeeId: created.id,
      type: "TIME_IN",
      ...PHOTO("open-in"),
      capturedAt,
    });

    const expectedMonth = capturedAt.toISOString().slice(0, 7);
    const expectedDate = capturedAt.toISOString().slice(0, 10);

    // No month param → defaults to the current month
    const res = await getProfile(created.id);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(expectedMonth);

    const days = res.body.days as ProfileDay[];
    const day = days.find((d) => d.date === expectedDate)!;
    expect(day.status).toBe("OPEN");
    expect(day.time_in!.photo_url).toContain("open-in");
    expect(day.time_out).toBeNull();
    expect(day.worked_minutes).toBeNull();
    expect(res.body.stats.open).toBe(1);
  });
});
