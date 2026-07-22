/**
 * Unified employee + login-account creation (client-critical).
 *
 * Covers:
 *   - POST /employees with `account` atomically creates the user + employee,
 *     linked, in one transaction; response carries `user: { id, email, role }`.
 *   - Duplicate email on POST /employees `account` -> 409 EMAIL_TAKEN, and the
 *     employee row is NOT created (whole transaction rolled back).
 *   - Invalid role in `account` -> 400 VALIDATION_ERROR (fail closed against
 *     the real DB role enum).
 *   - `account` + `user_id` together -> 400 (mutually exclusive).
 *   - POST /employees/:id/account links an EXISTING employee to a NEW login;
 *     409 ALREADY_LINKED when the employee already has one.
 *   - GET /employees rows carry hasLogin/userEmail.
 *   - Double-fire tests (idempotency-concurrency.md rule #7): sequential AND
 *     concurrent duplicate POST /employees/:id/account calls produce exactly
 *     ONE user row / ONE link — never two, never a 500.
 *   - OWNER-only gating on POST /employees/:id/account.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { employees, users } from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string; // OWNER
let outletManagerToken: string; // OUTLET_MANAGER — also EMPLOYEE_WRITE_ROLES, but NOT OWNER

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let _seq = 0;
const nextEmpNo = () => `ACCT-${Date.now()}-${++_seq}`;
const nextEmail = () => `acct-test-${Date.now()}-${++_seq}@cloudkitchen.local`;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  outletManagerToken = await login("outlet_manager@cloudkitchen.local", "password123");
});

describe("POST /api/v1/employees with `account`", () => {
  it("atomically creates the user + employee, linked; response carries user{id,email,role}", async () => {
    const email = nextEmail();
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "New Hire With Login",
        department: "KITCHEN",
        account: { email, password: "supersecret1", role: "KITCHEN_CREW" },
      });

    expect(res.status).toBe(201);
    expect(res.body.fullName).toBe("New Hire With Login");
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("KITCHEN_CREW");
    expect(res.body.user.id).toBeTruthy();
    // Never leaks the password/hash.
    expect(JSON.stringify(res.body)).not.toContain("supersecret1");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("passwordhash");

    const [empRow] = await db.select().from(employees).where(eq(employees.id, res.body.id));
    expect(empRow!.userId).toBe(res.body.user.id);

    // The new login actually works.
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password: "supersecret1" });
    expect(loginRes.status).toBe(200);
  });

  it("POST /employees without `account` keeps the current response shape (no `user` key)", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "No Login Hire", department: "KITCHEN" });
    expect(res.status).toBe(201);
    expect(res.body.user).toBeUndefined();
  });

  it("rejects an invalid role -> 400 VALIDATION_ERROR, fails closed, nothing created", async () => {
    const email = nextEmail();
    const employeeNo = nextEmpNo();
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: employeeNo,
        full_name: "Bad Role Hire",
        department: "KITCHEN",
        // Not a member of the DB role enum at all (RIDER, though retired from
        // normalizeRole's access grants, is still a literal enum value kept
        // for legacy tokens — so it is NOT a good "invalid enum" fixture).
        account: { email, password: "supersecret1", role: "NOT_A_REAL_ROLE" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    const [empRow] = await db.select().from(employees).where(eq(employees.employeeNo, employeeNo));
    expect(empRow).toBeUndefined();
    const [userRow] = await db.select().from(users).where(eq(users.email, email));
    expect(userRow).toBeUndefined();
  });

  it("rejects a password shorter than 8 chars -> 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "Short Password Hire",
        department: "KITCHEN",
        account: { email: nextEmail(), password: "short1", role: "KITCHEN_CREW" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects `account` + `user_id` together -> 400 (mutually exclusive)", async () => {
    const [existingUser] = await db.select({ id: users.id }).from(users).limit(1);
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "Both Fields Hire",
        department: "KITCHEN",
        user_id: existingUser!.id,
        account: { email: nextEmail(), password: "supersecret1", role: "KITCHEN_CREW" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("duplicate email -> 409 EMAIL_TAKEN, and no employee row is created (whole tx rolled back)", async () => {
    const email = nextEmail();
    const first = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "Original Owner Of Email",
        department: "KITCHEN",
        account: { email, password: "supersecret1", role: "KITCHEN_CREW" },
      });
    expect(first.status).toBe(201);

    const dupeEmployeeNo = nextEmpNo();
    const second = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: dupeEmployeeNo,
        full_name: "Duplicate Email Hire",
        department: "KITCHEN",
        account: { email, password: "anotherpassword1", role: "KITCHEN_CREW" },
      });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("EMAIL_TAKEN");

    const [orphanEmployee] = await db.select().from(employees).where(eq(employees.employeeNo, dupeEmployeeNo));
    expect(orphanEmployee).toBeUndefined();
  });

  it("email is trimmed + lowercased", async () => {
    const raw = `  MixedCase-${Date.now()}@CloudKitchen.LOCAL  `;
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "Casing Hire",
        department: "KITCHEN",
        account: { email: raw, password: "supersecret1", role: "KITCHEN_CREW" },
      });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(raw.trim().toLowerCase());
  });
});

describe("GET /api/v1/employees — hasLogin / userEmail", () => {
  it("rows carry hasLogin:boolean and userEmail:string|null", async () => {
    const email = nextEmail();
    const withLogin = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: nextEmpNo(),
        full_name: "Has Login List Check",
        department: "KITCHEN",
        account: { email, password: "supersecret1", role: "KITCHEN_CREW" },
      });
    expect(withLogin.status).toBe(201);

    const withoutLogin = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "No Login List Check", department: "KITCHEN" });
    expect(withoutLogin.status).toBe(201);

    const listRes = await request(app).get("/api/v1/employees").set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const rows = listRes.body as Array<{ id: string; hasLogin: boolean; userEmail: string | null }>;

    const withLoginRow = rows.find((r) => r.id === withLogin.body.id);
    expect(withLoginRow).toBeTruthy();
    expect(withLoginRow!.hasLogin).toBe(true);
    expect(withLoginRow!.userEmail).toBe(email);

    const withoutLoginRow = rows.find((r) => r.id === withoutLogin.body.id);
    expect(withoutLoginRow).toBeTruthy();
    expect(withoutLoginRow!.hasLogin).toBe(false);
    expect(withoutLoginRow!.userEmail).toBeNull();
  });
});

describe("POST /api/v1/employees/:id/account", () => {
  it("OWNER-only: OUTLET_MANAGER (not OWNER) -> 403 FORBIDDEN", async () => {
    const emp = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "RBAC Target", department: "KITCHEN" });
    expect(emp.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/employees/${emp.body.id}/account`)
      .set("Authorization", `Bearer ${outletManagerToken}`)
      .send({ email: nextEmail(), password: "supersecret1", role: "KITCHEN_CREW" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("links a login to an existing, unlinked employee -> 201 with user{id,email,role}", async () => {
    const emp = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Link Me Later", department: "KITCHEN" });
    expect(emp.status).toBe(201);
    expect(emp.body.locationId ?? null).not.toBeUndefined();

    const email = nextEmail();
    const res = await request(app)
      .post(`/api/v1/employees/${emp.body.id}/account`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, password: "supersecret1", role: "HR" });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("HR");
    expect(res.body.id).toBe(emp.body.id);

    const [empRow] = await db.select().from(employees).where(eq(employees.id, emp.body.id));
    expect(empRow!.userId).toBe(res.body.user.id);

    const loginRes = await request(app).post("/api/v1/auth/login").send({ email, password: "supersecret1" });
    expect(loginRes.status).toBe(200);
  });

  it("404 for an unknown employee id", async () => {
    const res = await request(app)
      .post(`/api/v1/employees/${randomUUID()}/account`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: nextEmail(), password: "supersecret1", role: "KITCHEN_CREW" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("400 VALIDATION_ERROR for a malformed employee id", async () => {
    const res = await request(app)
      .post("/api/v1/employees/not-a-uuid/account")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: nextEmail(), password: "supersecret1", role: "KITCHEN_CREW" });
    expect(res.status).toBe(404);
  });

  it("invalid role -> 400 VALIDATION_ERROR", async () => {
    const emp = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Bad Role Link Target", department: "KITCHEN" });
    expect(emp.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/employees/${emp.body.id}/account`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: nextEmail(), password: "supersecret1", role: "NOT_A_REAL_ROLE" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("409 ALREADY_LINKED when the employee already has a login (sequential double-fire)", async () => {
    const emp = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Sequential Double Fire", department: "KITCHEN" });
    expect(emp.status).toBe(201);

    const email1 = nextEmail();
    const first = await request(app)
      .post(`/api/v1/employees/${emp.body.id}/account`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: email1, password: "supersecret1", role: "KITCHEN_CREW" });
    expect(first.status).toBe(201);

    const email2 = nextEmail();
    const second = await request(app)
      .post(`/api/v1/employees/${emp.body.id}/account`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: email2, password: "supersecret1", role: "KITCHEN_CREW" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_LINKED");

    // Exactly one user ended up linked; the second email was never created.
    const [empRow] = await db.select().from(employees).where(eq(employees.id, emp.body.id));
    expect(empRow!.userId).toBe(first.body.user.id);
    const [secondUser] = await db.select().from(users).where(eq(users.email, email2));
    expect(secondUser).toBeUndefined();
  });

  it("CONCURRENT double-fire: two Promise.all requests -> exactly one 201, one 409, exactly one user linked", async () => {
    const emp = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Concurrent Double Fire", department: "KITCHEN" });
    expect(emp.status).toBe(201);

    const emailA = nextEmail();
    const emailB = nextEmail();

    const [resA, resB] = await Promise.all([
      request(app)
        .post(`/api/v1/employees/${emp.body.id}/account`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ email: emailA, password: "supersecret1", role: "KITCHEN_CREW" }),
      request(app)
        .post(`/api/v1/employees/${emp.body.id}/account`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ email: emailB, password: "supersecret1", role: "KITCHEN_CREW" }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;
    expect(loser.body.error.code).toBe("ALREADY_LINKED");

    // Exactly one employee row, linked to exactly the winner's user.
    const [empRow] = await db.select().from(employees).where(eq(employees.id, emp.body.id));
    expect(empRow!.userId).toBe(winner.body.user.id);

    // The loser's email never persisted as an orphan user row (its whole
    // transaction — including the user insert — rolled back).
    const loserEmail = winner.body.user.email === emailA ? emailB : emailA;
    const [loserUser] = await db.select().from(users).where(eq(users.email, loserEmail));
    expect(loserUser).toBeUndefined();

    // Exactly one user row total ended up referencing this employee.
    const allUsersWithEmailAorB = await db
      .select()
      .from(users)
      .where(eq(users.email, winner.body.user.email));
    expect(allUsersWithEmailAorB).toHaveLength(1);
  });
});
