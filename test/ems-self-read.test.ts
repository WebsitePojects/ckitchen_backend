/**
 * Regression: an employee can always read their OWN attendance, DTR and profile.
 *
 * Found 2026-10-24: seeded employees (and possibly real ones) have no outlet
 * (location_id null), so the outlet-scope check put every employee outside
 * everyone's scope except OWNER. A kitchen cook's Attendance page therefore got
 * 403 for their own punches and showed "No punches yet" after clocking in.
 * Reading someone else's record must still be refused.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

let app: Express;
let db: DB;
let crewToken: string;
let crewEmployeeId: string;
let otherEmployeeId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login failed for ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  const adminToken = await login("admin@cloudkitchen.local", "admin123");
  crewToken = await login("kitchen_staff@cloudkitchen.local", "password123");

  const emps = await request(app).get("/api/v1/employees").set("Authorization", `Bearer ${adminToken}`);
  expect(emps.status).toBe(200);
  const byName = new Map<string, { id: string; locationId: string | null }>(
    (emps.body as Array<{ id: string; fullName: string; locationId: string | null }>).map((e) => [e.fullName, e]),
  );
  crewEmployeeId = byName.get("Kitchen Crew")!.id;
  otherEmployeeId = byName.get("Accounting")!.id;
  // The bug only reproduces for an outlet-less employee; assert the fixture still has that shape.
  expect(byName.get("Kitchen Crew")!.locationId).toBeNull();
});

describe("employee self-read", () => {
  const paths = (id: string) => [
    `/api/v1/ems/attendance?employee_id=${id}&limit=8`,
    `/api/v1/ems/attendance/dtr?employee_id=${id}`,
    `/api/v1/employees/${id}/profile`,
  ];

  it("lets a cook read their own attendance, DTR and profile", async () => {
    for (const path of paths(crewEmployeeId)) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${crewToken}`);
      expect(res.status, path).toBe(200);
    }
  });

  it("self/today reports attendance_required so the clock-in gate can honour it", async () => {
    const res = await request(app).get("/api/v1/ems/attendance/self/today").set("Authorization", `Bearer ${crewToken}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.id).toBe(crewEmployeeId);
    expect(res.body.attendance_required).toBe(true); // seeded default for kitchen crew
  });

  it("still refuses a cook reading another employee", async () => {
    for (const path of paths(otherEmployeeId)) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${crewToken}`);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
  });
});
