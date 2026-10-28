/**
 * Employee system access + performance (D58).
 *
 *   - a login belongs to at most one employee (unique link, clean 409);
 *   - only an OWNER grants, links or unlinks system access (an outlet manager or HR could
 *     otherwise mint an OWNER login through POST /employees `account`);
 *   - link / unlink are duplicate-safe: sequential and concurrent replays give one effect;
 *   - a new login gets its employee's outlet, so it can act there at once;
 *   - staff-only employees have a manual performance log (notes), append-only with void;
 *   - notes are one row per client_request_id (sequential + concurrent double-fire);
 *   - the summary shows system activity only for a linked login;
 *   - reading another person's record needs a people role; nobody writes notes about themselves.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { auditLogs, employeePerformanceNotes, employees, locations, userOutletAccess, users } from "../src/db/schema.js";

let app: Express;
let db: DB;
let ownerToken: string;
let managerToken: string;
let hrToken: string;
let kitchenToken: string;
let kitchenUserId: string;
let managerUserId: string;
let locationId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let seq = 0;
const empNo = () => `ACC-${Date.now()}-${++seq}`;
const email = () => `access-${Date.now()}-${++seq}@cloudkitchen.local`;

async function createStaff(token = ownerToken, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/v1/employees")
    .set("Authorization", `Bearer ${token}`)
    .send({ employee_no: empNo(), full_name: `Staff ${seq}`, department: "KITCHEN", location_id: locationId, ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string; access: string; userId: string | null };
}

/** The employee row a login is linked to, creating one when the seed did not. */
async function employeeOf(userId: string): Promise<{ id: string }> {
  const [row] = await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, userId));
  return row ?? createStaff(ownerToken, { user_id: userId });
}

/** A login with no employee row yet (made directly, as Users & Roles would). */
async function createBareLogin(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ name: "Bare Login", email: email(), passwordHash: "x", role: "KITCHEN_CREW" })
    .returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  ownerToken = await login("admin@cloudkitchen.local", "admin123");
  managerToken = await login("outlet_manager@cloudkitchen.local", "password123");
  hrToken = await login("hr@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  const [k] = await db.select({ id: users.id }).from(users).where(eq(users.email, "kitchen_staff@cloudkitchen.local"));
  kitchenUserId = k!.id;
  const [m] = await db.select({ id: users.id }).from(users).where(eq(users.email, "outlet_manager@cloudkitchen.local"));
  managerUserId = m!.id;
  const [loc] = await db.select({ id: locations.id }).from(locations).limit(1);
  locationId = loc!.id;
  // The outlet manager manages this outlet.
  await db.insert(userOutletAccess).values({ userId: managerUserId, locationId }).onConflictDoNothing();
});

describe("system access tag", () => {
  it("staff without a login is STAFF_ONLY; the list filters by access", async () => {
    const staff = await createStaff();
    expect(staff.access).toBe("STAFF_ONLY");

    const onlyStaff = await request(app).get("/api/v1/employees?access=STAFF_ONLY").set("Authorization", `Bearer ${ownerToken}`);
    expect(onlyStaff.status).toBe(200);
    expect(onlyStaff.body.every((e: { access: string }) => e.access === "STAFF_ONLY")).toBe(true);
    expect(onlyStaff.body.some((e: { id: string }) => e.id === staff.id)).toBe(true);

    const bad = await request(app).get("/api/v1/employees?access=MAYBE").set("Authorization", `Bearer ${ownerToken}`);
    expect(bad.status).toBe(400);
  });

  it("kitchen crew cannot list employees (emails and roles are people-manager data)", async () => {
    const res = await request(app).get("/api/v1/employees").set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(403);
  });
});

describe("only an OWNER grants system access", () => {
  it("outlet manager creating an employee WITH an OWNER login -> 403, nothing written", async () => {
    const address = email();
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        employee_no: empNo(),
        full_name: "Escalation Attempt",
        department: "KITCHEN",
        location_id: locationId,
        account: { email: address, password: "supersecret1", role: "OWNER" },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("OWNER_ONLY");
    const [u] = await db.select().from(users).where(eq(users.email, address));
    expect(u).toBeUndefined();
  });

  it("HR may add staff-only employees (the Employees page is theirs)", async () => {
    const staff = await createStaff(hrToken);
    expect(staff.access).toBe("STAFF_ONLY");
  });

  it("HR cannot link a login", async () => {
    const staff = await createStaff();
    const res = await request(app)
      .post(`/api/v1/employees/${staff.id}/link-user`)
      .set("Authorization", `Bearer ${hrToken}`)
      .send({ user_id: await createBareLogin() });
    expect(res.status).toBe(403);
  });

  it("a login created with the employee gets the employee's outlet", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        employee_no: empNo(),
        full_name: "Cook With Login",
        department: "KITCHEN",
        location_id: locationId,
        account: { email: email(), password: "supersecret1", role: "KITCHEN_CREW" },
      });
    expect(res.status).toBe(201);
    const access = await db
      .select()
      .from(userOutletAccess)
      .where(and(eq(userOutletAccess.userId, res.body.user.id), eq(userOutletAccess.locationId, locationId)));
    expect(access).toHaveLength(1);
  });

  it("duplicate employee number -> 409 EMPLOYEE_NO_TAKEN, not a 500", async () => {
    const no = empNo();
    const first = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ employee_no: no, full_name: "First", department: "KITCHEN" });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ employee_no: no, full_name: "Second", department: "KITCHEN" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("EMPLOYEE_NO_TAKEN");
  });
});

describe("POST /employees/:id/link-user", () => {
  it("links an existing login; replay is 200 with one link and one audit row", async () => {
    const staff = await createStaff();
    const userId = await createBareLogin();
    const send = () =>
      request(app).post(`/api/v1/employees/${staff.id}/link-user`).set("Authorization", `Bearer ${ownerToken}`).send({ user_id: userId });

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.access).toBe("SYSTEM_USER");
    const replay = await send();
    expect(replay.status).toBe(200);

    const [row] = await db.select().from(employees).where(eq(employees.id, staff.id));
    expect(row!.userId).toBe(userId);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "employee.login.link"), eq(auditLogs.entityId, staff.id)));
    expect(audits).toHaveLength(1);
  });

  it("CONCURRENT: two different logins at once -> one 200, one 409; one link", async () => {
    const staff = await createStaff();
    const [a, b] = [await createBareLogin(), await createBareLogin()];
    const [ra, rb] = await Promise.all(
      [a, b].map((userId) =>
        request(app).post(`/api/v1/employees/${staff.id}/link-user`).set("Authorization", `Bearer ${ownerToken}`).send({ user_id: userId }),
      ),
    );
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const [row] = await db.select().from(employees).where(eq(employees.id, staff.id));
    expect(row!.userId).toBe(winner);
  });

  it("CONCURRENT: the same link twice -> both 200, one audit row", async () => {
    const staff = await createStaff();
    const userId = await createBareLogin();
    const results = await Promise.all(
      [1, 2].map(() =>
        request(app).post(`/api/v1/employees/${staff.id}/link-user`).set("Authorization", `Bearer ${ownerToken}`).send({ user_id: userId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "employee.login.link"), eq(auditLogs.entityId, staff.id)));
    expect(audits).toHaveLength(1);
  });

  it("one login cannot belong to two employees -> 409 USER_ALREADY_LINKED", async () => {
    const userId = await createBareLogin();
    const [one, two] = [await createStaff(), await createStaff()];
    const first = await request(app)
      .post(`/api/v1/employees/${one.id}/link-user`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: userId });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/v1/employees/${two.id}/link-user`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: userId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("USER_ALREADY_LINKED");
  });

  it("unknown login -> 404; extra fields -> 400", async () => {
    const staff = await createStaff();
    const missing = await request(app)
      .post(`/api/v1/employees/${staff.id}/link-user`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: randomUUID() });
    expect(missing.status).toBe(404);
    const extra = await request(app)
      .post(`/api/v1/employees/${staff.id}/link-user`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: randomUUID(), role: "OWNER" });
    expect(extra.status).toBe(400);
  });
});

describe("POST /employees/:id/unlink-user", () => {
  it("unlinks, keeps the login, replays as 200, refuses a stale user id", async () => {
    const staff = await createStaff();
    const userId = await createBareLogin();
    await request(app).post(`/api/v1/employees/${staff.id}/link-user`).set("Authorization", `Bearer ${ownerToken}`).send({ user_id: userId });

    const stale = await request(app)
      .post(`/api/v1/employees/${staff.id}/unlink-user`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ user_id: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("LINK_CHANGED");

    const results = await Promise.all(
      [1, 2].map(() =>
        request(app).post(`/api/v1/employees/${staff.id}/unlink-user`).set("Authorization", `Bearer ${ownerToken}`).send({ user_id: userId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body.access).toBe("STAFF_ONLY");

    const [row] = await db.select().from(employees).where(eq(employees.id, staff.id));
    expect(row!.userId).toBeNull();
    const [login] = await db.select().from(users).where(eq(users.id, userId));
    expect(login).toBeTruthy();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "employee.login.unlink"), eq(auditLogs.entityId, staff.id)));
    expect(audits).toHaveLength(1);
  });
});

describe("performance notes (manual log, every employee)", () => {
  const note = (over: Record<string, unknown> = {}) => ({
    client_request_id: randomUUID(),
    kind: "COMMENDATION",
    rating: 5,
    title: "Handled the lunch rush alone",
    occurred_on: "2026-10-01",
    ...over,
  });

  it("SEQUENTIAL + CONCURRENT double-fire of one intent -> one note, one audit row", async () => {
    const staff = await createStaff();
    const body = note();
    const post = () =>
      request(app).post(`/api/v1/employees/${staff.id}/performance-notes`).set("Authorization", `Bearer ${managerToken}`).send(body);

    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const again = await post();
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);

    const rows = await db.select().from(employeePerformanceNotes).where(eq(employeePerformanceNotes.employeeId, staff.id));
    expect(rows).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "employee.performance_note.create"), eq(auditLogs.entityId, staff.id)));
    expect(audits).toHaveLength(1);
  });

  it("the same client_request_id on another employee -> 409", async () => {
    const [one, two] = [await createStaff(), await createStaff()];
    const body = note();
    const first = await request(app).post(`/api/v1/employees/${one.id}/performance-notes`).set("Authorization", `Bearer ${ownerToken}`).send(body);
    expect(first.status).toBe(201);
    const reuse = await request(app).post(`/api/v1/employees/${two.id}/performance-notes`).set("Authorization", `Bearer ${ownerToken}`).send(body);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("validates kind, rating, date; refuses notes about yourself and from crew", async () => {
    const staff = await createStaff();
    const url = `/api/v1/employees/${staff.id}/performance-notes`;
    for (const bad of [note({ kind: "PRAISE" }), note({ rating: 6 }), note({ occurred_on: "2999-01-01" }), note({ title: "" })]) {
      const res = await request(app).post(url).set("Authorization", `Bearer ${ownerToken}`).send(bad);
      expect(res.status).toBe(400);
    }
    const crew = await request(app).post(url).set("Authorization", `Bearer ${kitchenToken}`).send(note());
    expect(crew.status).toBe(403);

    // The manager's own employee row: they cannot grade themselves.
    const self = await employeeOf(managerUserId);
    const own = await request(app)
      .post(`/api/v1/employees/${self.id}/performance-notes`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send(note());
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("SELF_REVIEW");
  });

  it("void is append-only, needs a reason, replays cleanly, and leaves the summary", async () => {
    const staff = await createStaff();
    const created = await request(app)
      .post(`/api/v1/employees/${staff.id}/performance-notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(note({ kind: "CONCERN", rating: 2, title: "Late twice" }));
    const voidUrl = `/api/v1/employees/${staff.id}/performance-notes/${created.body.id}/void`;

    const noReason = await request(app).post(voidUrl).set("Authorization", `Bearer ${ownerToken}`).send({ reason: "" });
    expect(noReason.status).toBe(400);

    const results = await Promise.all(
      [1, 2].map(() => request(app).post(voidUrl).set("Authorization", `Bearer ${ownerToken}`).send({ reason: "Wrong person" })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body.voided).toBe(true);

    const [row] = await db.select().from(employeePerformanceNotes).where(eq(employeePerformanceNotes.id, created.body.id));
    expect(row!.voidReason).toBe("Wrong person"); // kept, not deleted
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "employee.performance_note.void"), eq(auditLogs.entityId, staff.id)));
    expect(audits).toHaveLength(1);

    const list = await request(app).get(`/api/v1/employees/${staff.id}/performance-notes`).set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body).toHaveLength(0);
    const all = await request(app)
      .get(`/api/v1/employees/${staff.id}/performance-notes?include_voided=true`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(all.body).toHaveLength(1);
  });
});

describe("GET /employees/:id/performance", () => {
  it("staff-only: no system block, notes summarised for the month", async () => {
    const staff = await createStaff();
    for (const [kind, rating] of [["COMMENDATION", 5], ["REVIEW", 3], ["NOTE", null]] as const) {
      await request(app)
        .post(`/api/v1/employees/${staff.id}/performance-notes`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ client_request_id: randomUUID(), kind, rating, title: kind, occurred_on: "2026-09-15" });
    }
    const res = await request(app).get(`/api/v1/employees/${staff.id}/performance?month=2026-09`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.access).toBe("STAFF_ONLY");
    expect(res.body.system).toBeNull();
    expect(res.body.notes.total).toBe(3);
    expect(res.body.notes.ratedCount).toBe(2);
    expect(res.body.notes.averageRating).toBe(4);
    expect(res.body.notes.byKind.COMMENDATION).toBe(1);

    const otherMonth = await request(app).get(`/api/v1/employees/${staff.id}/performance?month=2026-08`).set("Authorization", `Bearer ${ownerToken}`);
    expect(otherMonth.body.notes.total).toBe(0);
  });

  it("system user: activity from the audit trail; the employee may read their own", async () => {
    const own = await employeeOf(kitchenUserId);
    await db.insert(auditLogs).values([
      { actorUserId: kitchenUserId, action: "order.advance", entityType: "order", entityId: randomUUID() },
      { actorUserId: kitchenUserId, action: "order.advance", entityType: "order", entityId: randomUUID() },
      { actorUserId: kitchenUserId, action: "stock.adjust", entityType: "ingredient", entityId: randomUUID() },
    ]);
    const res = await request(app).get(`/api/v1/employees/${own.id}/performance`).set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.access).toBe("SYSTEM_USER");
    expect(res.body.system.ordersHandled).toBeGreaterThanOrEqual(2);
    expect(res.body.system.totalActions).toBeGreaterThanOrEqual(3);
    expect(res.body.system.user.email).toBe("kitchen_staff@cloudkitchen.local");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("passwordhash");
  });

  it("crew cannot read a colleague's summary; bad month -> 400", async () => {
    const staff = await createStaff();
    const crew = await request(app).get(`/api/v1/employees/${staff.id}/performance`).set("Authorization", `Bearer ${kitchenToken}`);
    expect(crew.status).toBe(403);
    const bad = await request(app).get(`/api/v1/employees/${staff.id}/performance?month=2026-13`).set("Authorization", `Bearer ${ownerToken}`);
    expect(bad.status).toBe(400);
  });
});
