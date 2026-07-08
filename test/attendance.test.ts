/**
 * EMS E3 — Attendance / DTR tests (CK1-EMS-005 §3)
 *
 * Cloudinary is mocked via vi.mock so no real network calls are made in CI.
 *
 * Covers:
 *   POST /ems/attendance            — time-in, time-out, actor from token (anti-spoof),
 *                                     photo_url stored, audit row written
 *   GET  /ems/attendance            — list with filters (employee_id, type, from, to, limit)
 *   GET  /ems/attendance/dtr        — pairs TIME_IN/TIME_OUT per employee per day, computes minutes
 *   Missing employee → 404
 *   No token → 401
 *   Non-admin listing all employees → 403
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { auditLogs, attendanceRecords, employees, users } from "../src/db/schema.js";

// ── Mock Cloudinary before any import touches the real SDK ───────────────────
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
let kitchenToken: string;
let employeeId: string;   // seeded employee with KITCHEN department
let adminUserId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  // Resolve seeded KITCHEN employee
  const emp = await db
    .select()
    .from(employees)
    .where(eq(employees.department, "KITCHEN"))
    .limit(1);
  expect(emp.length).toBeGreaterThan(0);
  employeeId = emp[0]!.id;

  // Resolve admin user id
  const [adminUser] = await db.select().from(users).where(eq(users.email, "admin@cloudkitchen.local"));
  adminUserId = adminUser!.id;
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/ems/attendance
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/ems/attendance — time-in", () => {
  it("401 without token", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .send({ employee_id: employeeId, type: "TIME_IN", photo: "data:image/png;base64,abc" });
    expect(res.status).toBe(401);
  });

  it("404 for unknown employee_id", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_id: "00000000-0000-0000-0000-000000000000",
        type: "TIME_IN",
        photo: "data:image/png;base64,abc",
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400 when photo exceeds 8 MB", async () => {
    // Generate a base64 string > 8MB (8*1024*1024 bytes + overhead)
    const oversized = "data:image/png;base64," + "A".repeat(8 * 1024 * 1024 + 1);
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_id: employeeId, type: "TIME_IN", photo: oversized });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("stores the row with photo_url and recorded_by from token (anti-spoof)", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_id: employeeId,
        type: "TIME_IN",
        photo: "data:image/png;base64,iVBORw0KGgo=",
        note: "First punch",
      });

    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(employeeId);
    expect(res.body.type).toBe("TIME_IN");
    expect(res.body.photoUrl).toBe(
      "https://res.cloudinary.com/test/image/upload/ck1/attendance/mock.jpg",
    );
    expect(res.body.photoPublicId).toBe("ck1/attendance/mock");
    // Must use actor from token, not body
    expect(res.body.recordedByUserId).toBe(adminUserId);
    expect(res.body.note).toBe("First punch");
    // API secret must never appear in response
    expect(JSON.stringify(res.body)).not.toContain("api_secret");
    expect(JSON.stringify(res.body)).not.toContain("CLOUDINARY_API_SECRET");
  });

  it("writes an audit row with action attendance.time_in", async () => {
    // Give the non-blocking audit write a tick
    await new Promise((r) => setTimeout(r, 50));

    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "attendance.time_in"));
    expect(logs.length).toBeGreaterThan(0);
    const log = logs[logs.length - 1]!;
    expect(log.entityType).toBe("attendance_record");
    expect(log.actorUserId).toBe(adminUserId);
  });
});

describe("POST /api/v1/ems/attendance — time-out", () => {
  it("records a TIME_OUT for the same employee", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_id: employeeId,
        type: "TIME_OUT",
        photo: "data:image/png;base64,iVBORw0KGgo=",
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("TIME_OUT");
    expect(res.body.photoUrl).toBeTruthy();
    expect(res.body.recordedByUserId).toBe(adminUserId);
  });

  it("writes an audit row with action attendance.time_out", async () => {
    await new Promise((r) => setTimeout(r, 50));

    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "attendance.time_out"));
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/ems/attendance — list
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/ems/attendance", () => {
  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/ems/attendance");
    expect(res.status).toBe(401);
  });

  it("SUPER_ADMIN can list all attendance records", async () => {
    const res = await request(app)
      .get("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("403 when non-admin tries to list all attendance (no employee_id filter)", async () => {
    const res = await request(app)
      .get("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("filters by employee_id", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${employeeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body as Array<{ employeeId: string }>) {
      expect(row.employeeId).toBe(employeeId);
    }
  });

  it("filters by type=TIME_IN", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${employeeId}&type=TIME_IN`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body as Array<{ type: string }>) {
      expect(row.type).toBe("TIME_IN");
    }
  });

  it("respects limit param", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?limit=1`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });

  it("returns records newest-first", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ capturedAt: string }>;
    if (rows.length >= 2) {
      const t0 = new Date(rows[0]!.capturedAt).getTime();
      const t1 = new Date(rows[1]!.capturedAt).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/ems/attendance/dtr — DTR pairs
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/ems/attendance/dtr", () => {
  /**
   * Seed a fresh pair of TIME_IN + TIME_OUT rows for a dedicated employee
   * so we have a deterministic scenario to test pairing + minutes calculation.
   */
  let dtrEmployeeId: string;

  beforeAll(async () => {
    // Create a fresh employee for DTR tests
    const [newEmp] = await db
      .insert(employees)
      .values({
        employeeNo: "EMP-DTR-001",
        fullName: "DTR Test Employee",
        department: "ADMIN",
        status: "ACTIVE",
      })
      .returning();
    dtrEmployeeId = newEmp!.id;

    // Insert TIME_IN at T and TIME_OUT at T+90min via the API (mocked Cloudinary)
    const timeIn = new Date("2026-06-30T08:00:00Z");
    const timeOut = new Date("2026-06-30T09:30:00Z"); // 90 minutes later

    // Insert directly so we can control captured_at timestamps
    await db.insert(attendanceRecords).values([
      {
        employeeId: dtrEmployeeId,
        type: "TIME_IN",
        photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/in.jpg",
        photoPublicId: "ck1/attendance/in",
        capturedAt: timeIn,
        recordedByUserId: adminUserId,
      },
      {
        employeeId: dtrEmployeeId,
        type: "TIME_OUT",
        photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/out.jpg",
        photoPublicId: "ck1/attendance/out",
        capturedAt: timeOut,
        recordedByUserId: adminUserId,
      },
    ]);
  });

  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/ems/attendance/dtr");
    expect(res.status).toBe(401);
  });

  it("pairs TIME_IN and TIME_OUT into a DTR entry with correct minutes", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${dtrEmployeeId}&from=2026-06-30&to=2026-06-30`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);

    const pair = res.body[0] as {
      date: string;
      employee_id: string;
      time_in: string;
      time_out: string;
      photo_in: string;
      photo_out: string;
      minutes: number;
    };

    expect(pair.employee_id).toBe(dtrEmployeeId);
    expect(pair.date).toBe("2026-06-30");
    expect(pair.time_in).toBeTruthy();
    expect(pair.time_out).toBeTruthy();
    expect(pair.photo_in).toContain("cloudinary");
    expect(pair.photo_out).toContain("cloudinary");
    // 90 minutes between T+0 and T+90
    expect(pair.minutes).toBe(90);
  });

  it("returns empty array when employee has no records in date range", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${dtrEmployeeId}&from=2020-01-01&to=2020-01-01`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns null time_out and null minutes for an unpaired TIME_IN", async () => {
    // Create another employee with only a TIME_IN (no TIME_OUT)
    const [loneEmployee] = await db
      .insert(employees)
      .values({
        employeeNo: "EMP-DTR-LONE",
        fullName: "Lone Timer Employee",
        department: "ADMIN",
        status: "ACTIVE",
      })
      .returning();

    await db.insert(attendanceRecords).values({
      employeeId: loneEmployee!.id,
      type: "TIME_IN",
      photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/lone.jpg",
      photoPublicId: "ck1/attendance/lone",
      capturedAt: new Date("2026-06-30T10:00:00Z"),
      recordedByUserId: adminUserId,
    });

    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${loneEmployee!.id}&from=2026-06-30&to=2026-06-30`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    const pair = res.body[0] as { time_out: string | null; minutes: number | null };
    expect(pair.time_out).toBeNull();
    expect(pair.minutes).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/ems/attendance/dtr — 24h forfeit rule + status field
// (client review 2026-07-08)
// ─────────────────────────────────────────────────────────────────────────────

describe("DTR status: COMPLETE / OPEN / FORFEITED (24h rule)", () => {
  const photo = {
    photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/status.jpg",
    photoPublicId: "ck1/attendance/status",
  };

  async function makeEmployee(no: string, name: string): Promise<string> {
    const [emp] = await db
      .insert(employees)
      .values({ employeeNo: no, fullName: name, department: "ADMIN", status: "ACTIVE" })
      .returning();
    return emp!.id;
  }

  async function dtrFor(employeeId: string) {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${employeeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body as Array<{ status: string; time_out: string | null; minutes: number | null }>;
  }

  it("an unpaired TIME_IN older than 24h → FORFEITED, minutes stays null (no synthesized TIME_OUT)", async () => {
    const empId = await makeEmployee("EMP-STAT-FORFEIT", "Forfeit Status Employee");
    await db.insert(attendanceRecords).values({
      employeeId: empId,
      type: "TIME_IN",
      ...photo,
      capturedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
      recordedByUserId: adminUserId,
    });

    const entries = await dtrFor(empId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.status).toBe("FORFEITED");
    expect(entries[0]!.time_out).toBeNull(); // never synthesized
    expect(entries[0]!.minutes).toBeNull(); // no credited time
  });

  it("a fresh unpaired TIME_IN (<24h) → OPEN", async () => {
    const empId = await makeEmployee("EMP-STAT-OPEN", "Open Status Employee");
    await db.insert(attendanceRecords).values({
      employeeId: empId,
      type: "TIME_IN",
      ...photo,
      capturedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
      recordedByUserId: adminUserId,
    });

    const entries = await dtrFor(empId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.status).toBe("OPEN");
    expect(entries[0]!.minutes).toBeNull();
  });

  it("a paired TIME_IN + TIME_OUT → COMPLETE (even on a long-past day)", async () => {
    const empId = await makeEmployee("EMP-STAT-DONE", "Complete Status Employee");
    await db.insert(attendanceRecords).values([
      {
        employeeId: empId,
        type: "TIME_IN",
        ...photo,
        capturedAt: new Date("2026-05-05T08:00:00Z"),
        recordedByUserId: adminUserId,
      },
      {
        employeeId: empId,
        type: "TIME_OUT",
        ...photo,
        capturedAt: new Date("2026-05-05T09:00:00Z"),
        recordedByUserId: adminUserId,
      },
    ]);

    const entries = await dtrFor(empId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.status).toBe("COMPLETE");
    expect(entries[0]!.minutes).toBe(60);
  });
});
