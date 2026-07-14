/**
 * attendance_required (D2/D3, enterprise-operations-foundation.md §10) tests.
 *
 * `employee.attendance_required` (schema.ts, boolean NOT NULL default true) was
 * previously write-only from the DB layer: the create/update API could never
 * set it, and the Employee 360 absence computation ignored it entirely (an
 * exempt owner was flagged ABSENT exactly like required staff). Covers:
 *
 *   POST /employees   attendance_required:false persists (defaults to true
 *                      when omitted)
 *   PATCH /employees/:id  toggles attendance_required both ways
 *   GET /employees/:id/profile — absence computation excludes an exempt
 *                      employee (no-punch scheduled day -> REST, not ABSENT)
 *                      while a required employee on the same fixture month
 *                      still gets ABSENT
 *   Punching stays ALLOWED for an exempt employee (attendance_required only
 *   gates the absence FLAG, never the punch gate in attendance-shared.ts)
 *
 * Cloudinary is mocked (same pattern as test/attendance.test.ts) so the punch
 * test makes no real network call.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { attendanceRecords, employees } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("../src/modules/ems/cloudinary.js", () => ({
  uploadAttendancePhoto: vi.fn().mockResolvedValue({
    url: "https://res.cloudinary.com/test/image/upload/ck1/attendance/mock.jpg",
    publicId: "ck1/attendance/mock",
  }),
  ConfigError: class ConfigError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ConfigError";
    }
  },
}));

let app: Express;
let db: DB;
let adminToken: string;

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
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; attendanceRequired: boolean };
}

interface ProfileDay {
  date: string;
  scheduled: boolean;
  status: "PRESENT" | "ABSENT" | "REST" | "FUTURE" | "FORFEITED" | "OPEN";
}

async function getProfile(id: string, month: string) {
  return request(app)
    .get(`/api/v1/employees/${id}/profile?month=${month}`)
    .set("Authorization", `Bearer ${adminToken}`);
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// D2 — create/update API exposes attendance_required
// ─────────────────────────────────────────────────────────────────────────────

describe("attendance_required — create/update API (D2)", () => {
  it("POST omitting attendance_required defaults to true (DB default)", async () => {
    const created = await createEmployee({
      employee_no: "EMP-AR-DEFAULT",
      full_name: "Default Attendance Employee",
      department: "KITCHEN",
    });
    expect(created.attendanceRequired).toBe(true);
  });

  it("POST attendance_required:false persists", async () => {
    const created = await createEmployee({
      employee_no: "EMP-AR-EXEMPT",
      full_name: "Exempt Owner",
      department: "ADMIN",
      attendance_required: false,
    });
    expect(created.attendanceRequired).toBe(false);

    // Round-trips through GET /employees too (serializeEmployee spreads the row).
    const listRes = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body as Array<{ id: string; attendanceRequired: boolean }>).find(
      (e) => e.id === created.id,
    );
    expect(row).toBeTruthy();
    expect(row!.attendanceRequired).toBe(false);
  });

  it("PATCH toggles attendance_required both ways", async () => {
    const created = await createEmployee({
      employee_no: "EMP-AR-TOGGLE",
      full_name: "Toggle Employee",
      department: "ADMIN",
      attendance_required: true,
    });
    expect(created.attendanceRequired).toBe(true);

    const toFalse = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attendance_required: false });
    expect(toFalse.status).toBe(200);
    expect(toFalse.body.attendanceRequired).toBe(false);

    const toTrue = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attendance_required: true });
    expect(toTrue.status).toBe(200);
    expect(toTrue.body.attendanceRequired).toBe(true);
  });

  it("PATCH omitting attendance_required leaves it unchanged", async () => {
    const created = await createEmployee({
      employee_no: "EMP-AR-UNTOUCHED",
      full_name: "Untouched Employee",
      department: "ADMIN",
      attendance_required: false,
    });

    const patched = await request(app)
      .patch(`/api/v1/employees/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ full_name: "Untouched Employee (renamed)" });
    expect(patched.status).toBe(200);
    expect(patched.body.attendanceRequired).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — absence computation excludes exempt employees
// ─────────────────────────────────────────────────────────────────────────────

describe("attendance_required — absence computation (D3)", () => {
  /**
   * Fixture month 2026-05 (fully in the past, mirrors test/employee-profile.test.ts):
   * MON-FRI default schedule, hired before the month, ZERO punches all month.
   * A required employee must show ABSENT on scheduled weekdays; an exempt
   * employee (attendance_required:false) must show REST on the same weekdays
   * instead — never ABSENT.
   */
  let requiredEmpId: string;
  let exemptEmpId: string;

  beforeAll(async () => {
    const required = await createEmployee({
      employee_no: "EMP-AR-REQUIRED-ABSENT",
      full_name: "Required Staff",
      department: "ACCOUNTING",
      hired_at: "2026-04-01",
      attendance_required: true,
    });
    requiredEmpId = required.id;

    const exempt = await createEmployee({
      employee_no: "EMP-AR-EXEMPT-ABSENT",
      full_name: "Exempt Owner Two",
      department: "ADMIN",
      hired_at: "2026-04-01",
      attendance_required: false,
    });
    exemptEmpId = exempt.id;
    // No attendance_records inserted for either — every scheduled May weekday
    // has zero punches.
  });

  it("required employee: scheduled past day without punches -> ABSENT", async () => {
    const res = await getProfile(requiredEmpId, "2026-05");
    expect(res.status).toBe(200);
    const days = res.body.days as ProfileDay[];
    const monday = days.find((d) => d.date === "2026-05-04")!; // MON, no punches
    expect(monday.scheduled).toBe(true);
    expect(monday.status).toBe("ABSENT");
    expect(res.body.stats.absent_days).toBeGreaterThan(0);
  });

  it("exempt employee: scheduled past day without punches -> REST, not ABSENT", async () => {
    const res = await getProfile(exemptEmpId, "2026-05");
    expect(res.status).toBe(200);
    const days = res.body.days as ProfileDay[];
    const monday = days.find((d) => d.date === "2026-05-04")!; // MON, no punches
    expect(monday.scheduled).toBe(true);
    expect(monday.status).toBe("REST"); // exempt: never flagged ABSENT

    // No day in the month is ABSENT and stats reflect zero absences.
    expect(days.every((d) => d.status !== "ABSENT")).toBe(true);
    expect(res.body.stats.absent_days).toBe(0);
  });

  it("exempt employee who DOES punch still shows PRESENT (exemption only removes the flag, punching still counts)", async () => {
    await db.insert(attendanceRecords).values([
      {
        employeeId: exemptEmpId,
        type: "TIME_IN",
        photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/exempt-in.jpg",
        photoPublicId: "ck1/attendance/exempt-in",
        capturedAt: new Date("2026-05-05T08:00:00Z"),
      },
      {
        employeeId: exemptEmpId,
        type: "TIME_OUT",
        photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/exempt-out.jpg",
        photoPublicId: "ck1/attendance/exempt-out",
        capturedAt: new Date("2026-05-05T17:00:00Z"),
      },
    ]);

    const res = await getProfile(exemptEmpId, "2026-05");
    expect(res.status).toBe(200);
    const days = res.body.days as ProfileDay[];
    const tuesday = days.find((d) => d.date === "2026-05-05")!;
    expect(tuesday.status).toBe("PRESENT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Punching itself stays ALLOWED for an exempt employee
// ─────────────────────────────────────────────────────────────────────────────

describe("attendance_required — punching stays allowed when exempt", () => {
  it("an exempt (attendance_required:false) employee can still punch TIME_IN via the API", async () => {
    const exempt = await createEmployee({
      employee_no: "EMP-AR-CAN-PUNCH",
      full_name: "Voluntary Puncher",
      department: "ADMIN",
      attendance_required: false,
    });

    const punchRes = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_id: exempt.id,
        type: "TIME_IN",
        photo: "data:image/png;base64,abc",
      });
    expect(punchRes.status, JSON.stringify(punchRes.body)).toBe(201);

    const [record] = await db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.employeeId, exempt.id));
    expect(record).toBeTruthy();
    expect(record!.type).toBe("TIME_IN");
  });
});
