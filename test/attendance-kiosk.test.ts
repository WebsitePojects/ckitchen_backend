/**
 * EMS E3 — Self-attendance gate + public kiosk (CK1-EMS-005 §3, 0023)
 *
 * Cloudinary is mocked (same pattern as attendance.test.ts) so uploads resolve
 * to a fixed URL and no real network call happens.
 *
 * Covers:
 *   GET  /ems/attendance/self/today   — WITH linked employee / WITHOUT (null)
 *   POST /ems/attendance              — SELF_ONLY guard (non-OWNER own vs other),
 *                                       OWNER kiosk override
 *   GET  /public/attendance/employees — minimal fields only (no PII)
 *   POST /public/attendance           — photo mandatory (400), feature-flag 404,
 *                                       success writes a "Public"-actor audit row
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
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

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

let app: Express;
let db: DB;

let adminToken: string;
let kitchenToken: string;
let hrToken: string;

let adminEmpId: string; // OWNER's linked employee
let kitchenEmpId: string; // kitchen_staff's linked employee (non-OWNER, self)

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  hrToken = await login("hr@cloudkitchen.local", "password123");

  const [adminUser] = await db.select().from(users).where(eq(users.email, "admin@cloudkitchen.local"));
  const [kitchenUser] = await db.select().from(users).where(eq(users.email, "kitchen_staff@cloudkitchen.local"));

  const [adminEmp] = await db.select().from(employees).where(eq(employees.userId, adminUser!.id));
  const [kitchenEmp] = await db.select().from(employees).where(eq(employees.userId, kitchenUser!.id));
  adminEmpId = adminEmp!.id;
  kitchenEmpId = kitchenEmp!.id;
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /ems/attendance/self/today
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/ems/attendance/self/today", () => {
  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/ems/attendance/self/today");
    expect(res.status).toBe(401);
  });

  it("returns the caller's employee + clock state when a linked employee exists", async () => {
    const res = await request(app)
      .get("/api/v1/ems/attendance/self/today")
      .set("Authorization", `Bearer ${kitchenToken}`);

    expect(res.status).toBe(200);
    expect(res.body.employee).not.toBeNull();
    expect(res.body.employee.id).toBe(kitchenEmpId);
    expect(res.body.employee).toHaveProperty("employeeNo");
    expect(res.body.employee).toHaveProperty("fullName");
    expect(res.body.employee).toHaveProperty("department");
    expect(res.body.employee).toHaveProperty("photoUrl");
    expect(typeof res.body.clocked_in).toBe("boolean");
    expect(typeof res.body.clocked_out).toBe("boolean");
    expect([null, "TIME_IN", "TIME_OUT"]).toContain(res.body.last_type);
  });

  it("clocked_in flips to true (and last_type=TIME_IN) after a self punch today", async () => {
    const punch = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ employee_id: kitchenEmpId, type: "TIME_IN", photo: PHOTO });
    expect(punch.status).toBe(201);

    const res = await request(app)
      .get("/api/v1/ems/attendance/self/today")
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(200);
    expect(res.body.clocked_in).toBe(true);
    expect(res.body.last_type).toBe("TIME_IN");
  });

  it("returns employee=null for a user with no ACTIVE linked employee", async () => {
    // Unlink the HR user's employee so the caller has no linked employee row.
    const [hrUser] = await db.select().from(users).where(eq(users.email, "hr@cloudkitchen.local"));
    await db.update(employees).set({ userId: null }).where(eq(employees.userId, hrUser!.id));

    const res = await request(app)
      .get("/api/v1/ems/attendance/self/today")
      .set("Authorization", `Bearer ${hrToken}`);

    expect(res.status).toBe(200);
    expect(res.body.employee).toBeNull();
    expect(res.body.clocked_in).toBe(false);
    expect(res.body.clocked_out).toBe(false);
    expect(res.body.last_type).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /ems/attendance — SELF_ONLY guard
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/ems/attendance — SELF_ONLY guard", () => {
  it("403 SELF_ONLY when a non-OWNER punches someone else's employee_id", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ employee_id: adminEmpId, type: "TIME_IN", photo: PHOTO });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SELF_ONLY");
  });

  it("a non-OWNER punching their OWN employee passes the guard (201)", async () => {
    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ employee_id: kitchenEmpId, type: "TIME_OUT", photo: PHOTO });

    // Got PAST the 403 guard. Mocked Cloudinary → 201 (a 502 would also prove
    // the guard passed, matching the established Cloudinary handling).
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
    expect(res.body.recordedByUserId).toBeTruthy();
  });

  it("OWNER keeps the kiosk override — may punch any employee", async () => {
    // Fresh employee: the punch gate (2026-07-08) would 409 ALREADY_TIMED_IN
    // for kitchenEmp, who already timed in earlier in this suite. The override
    // is about WHO the OWNER may punch, not about skipping the gate.
    const [emp] = await db
      .insert(employees)
      .values({ employeeNo: "EMP-OVERRIDE", fullName: "Override Target", department: "ADMIN", status: "ACTIVE" })
      .returning();

    const res = await request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_id: emp!.id, type: "TIME_IN", photo: PHOTO });

    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(emp!.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/public/attendance/employees
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/public/attendance/employees", () => {
  it("returns ACTIVE employees with MINIMAL fields only (no PII)", async () => {
    const res = await request(app).get("/api/v1/public/attendance/employees");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    for (const row of res.body as Record<string, unknown>[]) {
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("employeeNo");
      expect(row).toHaveProperty("fullName");
      expect(row).toHaveProperty("department");
      // PII discipline: never expose photo URLs or the linked user id.
      expect(row).not.toHaveProperty("photoUrl");
      expect(row).not.toHaveProperty("photo_url");
      expect(row).not.toHaveProperty("userId");
      expect(row).not.toHaveProperty("user_id");
    }
  });

  it("rows carry today's clock state — clocked_in / clocked_out / last_type", async () => {
    const res = await request(app).get("/api/v1/public/attendance/employees");
    expect(res.status).toBe(200);

    for (const row of res.body as Array<Record<string, unknown>>) {
      expect(typeof row.clocked_in).toBe("boolean");
      expect(typeof row.clocked_out).toBe("boolean");
      expect([null, "TIME_IN", "TIME_OUT"]).toContain(row.last_type);
    }

    // kitchenEmp punched TIME_IN then TIME_OUT earlier in this suite.
    const kitchenRow = (res.body as Array<{ id: string; clocked_in: boolean; clocked_out: boolean; last_type: string | null }>).find(
      (r) => r.id === kitchenEmpId,
    );
    expect(kitchenRow).toBeTruthy();
    expect(kitchenRow!.clocked_in).toBe(true);
    expect(kitchenRow!.clocked_out).toBe(true);
    expect(kitchenRow!.last_type).toBe("TIME_OUT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/public/attendance
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/public/attendance", () => {
  it("400 when the photo is missing (photo is mandatory)", async () => {
    const res = await request(app)
      .post("/api/v1/public/attendance")
      .send({ employee_id: kitchenEmpId, type: "TIME_IN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404 when the feature flag is disabled", async () => {
    process.env.PUBLIC_ATTENDANCE_ENABLED = "false";
    try {
      const res = await request(app)
        .post("/api/v1/public/attendance")
        .send({ employee_id: kitchenEmpId, type: "TIME_IN", photo: PHOTO });
      expect(res.status).toBe(404);
    } finally {
      delete process.env.PUBLIC_ATTENDANCE_ENABLED;
    }
  });

  it("201 and writes a 'Public'-actor audit row with source=public_kiosk", async () => {
    // Fresh employee — kitchenEmp already timed in+out today, so the punch
    // gate (2026-07-08) would 409 a further TIME_IN for them.
    const [kioskEmp] = await db
      .insert(employees)
      .values({ employeeNo: "EMP-KIOSK-PUB", fullName: "Kiosk Public Employee", department: "ADMIN", status: "ACTIVE" })
      .returning();

    const res = await request(app)
      .post("/api/v1/public/attendance")
      .send({ employee_id: kioskEmp!.id, type: "TIME_IN", photo: PHOTO, note: "kiosk punch" });

    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(kioskEmp!.id);
    expect(res.body.recordedByUserId).toBeNull();
    expect(res.body.sessionId).toBeNull();

    // Give the non-blocking audit write a tick.
    await new Promise((r) => setTimeout(r, 50));

    const publicLogs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorName, "Public"), eq(auditLogs.action, "attendance.time_in")));
    expect(publicLogs.length).toBeGreaterThan(0);
    const log = publicLogs[publicLogs.length - 1]!;
    expect(log.actorUserId).toBeNull();
    expect(log.entityType).toBe("attendance_record");
    expect((log.metadata as { source?: string } | null)?.source).toBe("public_kiosk");
  });

  it("404 for an unknown employee_id", async () => {
    const res = await request(app)
      .post("/api/v1/public/attendance")
      .send({ employee_id: "00000000-0000-0000-0000-000000000000", type: "TIME_IN", photo: PHOTO });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Punch gate — server-enforced double-punch protection (client review
// 2026-07-08). Lives in the shared core (attendance-shared.ts) so BOTH the
// authed route (incl. the OWNER override) and the public kiosk are gated.
// ─────────────────────────────────────────────────────────────────────────────

describe("Punch gate: 409 ALREADY_TIMED_IN / NOT_TIMED_IN / ALREADY_TIMED_OUT", () => {
  async function makeEmployee(no: string): Promise<string> {
    const [emp] = await db
      .insert(employees)
      .values({ employeeNo: no, fullName: `Gate ${no}`, department: "ADMIN", status: "ACTIVE" })
      .returning();
    return emp!.id;
  }

  function authedPunch(employeeId: string, type: string) {
    return request(app)
      .post("/api/v1/ems/attendance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_id: employeeId, type, photo: PHOTO });
  }

  it("409 NOT_TIMED_IN when timing out before timing in", async () => {
    const empId = await makeEmployee("EMP-GATE-1");
    const res = await authedPunch(empId, "TIME_OUT");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NOT_TIMED_IN");
  });

  it("409 ALREADY_TIMED_IN on a second TIME_IN the same day — even for OWNER", async () => {
    const empId = await makeEmployee("EMP-GATE-2");
    const first = await authedPunch(empId, "TIME_IN");
    expect(first.status).toBe(201);

    const second = await authedPunch(empId, "TIME_IN"); // adminToken = OWNER
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_TIMED_IN");
  });

  it("409 ALREADY_TIMED_OUT on a second TIME_OUT the same day", async () => {
    const empId = await makeEmployee("EMP-GATE-3");
    expect((await authedPunch(empId, "TIME_IN")).status).toBe(201);
    expect((await authedPunch(empId, "TIME_OUT")).status).toBe(201);

    const again = await authedPunch(empId, "TIME_OUT");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_TIMED_OUT");
  });

  it("the public kiosk is gated identically", async () => {
    const empId = await makeEmployee("EMP-GATE-4");
    const in1 = await request(app)
      .post("/api/v1/public/attendance")
      .send({ employee_id: empId, type: "TIME_IN", photo: PHOTO });
    expect(in1.status).toBe(201);

    const in2 = await request(app)
      .post("/api/v1/public/attendance")
      .send({ employee_id: empId, type: "TIME_IN", photo: PHOTO });
    expect(in2.status).toBe(409);
    expect(in2.body.error.code).toBe("ALREADY_TIMED_IN");
  });

  it("yesterday's unclosed TIME_IN does NOT block today's TIME_IN (day-scoped)", async () => {
    const empId = await makeEmployee("EMP-GATE-5");
    // Simulate an unclosed shift ~25h ago — always on a previous UTC day.
    await db.insert(attendanceRecords).values({
      employeeId: empId,
      type: "TIME_IN",
      photoUrl: "https://res.cloudinary.com/test/image/upload/ck1/attendance/old.jpg",
      photoPublicId: "ck1/attendance/old",
      capturedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const res = await authedPunch(empId, "TIME_IN");
    expect(res.status).toBe(201);
  });
});
