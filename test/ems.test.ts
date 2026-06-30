/**
 * EMS Tests — CK1-EMS-005 E1 + E2-core
 *
 * Covers:
 *   - GET /employees — list with status/department filters
 *   - POST /employees — create (SUPER_ADMIN) and RBAC (KITCHEN_STAFF → 403)
 *   - POST /auth/login — creates user_session row and auth.login audit entry carrying sid
 *   - POST /auth/logout — sets logout_at on session and writes auth.logout audit entry
 *   - POST /orders/:id/advance — writes order.advance audit row with actor + sessionId
 *   - GET /audit?session_id= — returns only that session's audit rows
 *   - GET /ems/analytics/employee/:userId — counts actions for the actor
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import {
  auditLogs,
  userSessions,
  users,
  aggregatorAccounts,
  brands,
  employees,
} from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/service.js";

let app: Express;
let db: DB;

/** Token bucket — populated in beforeAll */
let adminToken: string;
let kitchenToken: string;
let warehouseToken: string;

/** Resolved IDs shared across tests */
let grillStationId: string;
let ingId: string;
let brandId: string;
let fpAccountId: string;
let grillItemId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let _refSeq = 0;
function nextRef(): string {
  return `EMS-TEST-${Date.now()}-${++_refSeq}`;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite
  db = created.db;
  await seed(db); // seeds location, stations, warehouses, users, employees
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

  // ── Resolve seeded station ──────────────────────────────────────────────
  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const stations = stRes.body as Array<{ id: string; name: string }>;
  grillStationId = stations.find((s) => s.name === "Grill")!.id;

  // ── Ingredient + stock in KITCHEN ───────────────────────────────────────
  const ingRes = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "EMS_Test_Ing", unit: "g", unit_cost: "1.00", low_stock_threshold: "5" });
  ingId = ingRes.body.id as string;

  await request(app)
    .post("/api/v1/inventory/receive")
    .set("Authorization", `Bearer ${warehouseToken}`)
    .send({ items: [{ ingredient_id: ingId, quantity: 2000 }] });

  const itoRes = await request(app)
    .post("/api/v1/itos")
    .set("Authorization", `Bearer ${kitchenToken}`)
    .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: ingId, quantity: 2000 }] });

  await request(app)
    .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
    .set("Authorization", `Bearer ${warehouseToken}`);

  // ── Brand + account ─────────────────────────────────────────────────────
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "EMS Test Brand", color: "#AABBCC" });
  brandId = brandRes.body.id as string;

  const accRes = await request(app)
    .post(`/api/v1/brands/${brandId}/accounts`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-EMS", credential_ref: "ems-ref" });
  fpAccountId = accRes.body.id as string;

  // ── Grill menu item with recipe ─────────────────────────────────────────
  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "EMS Teriyaki", price: "180", station_id: grillStationId });
  grillItemId = menuRes.body.id as string;

  await request(app)
    .put(`/api/v1/menu/${grillItemId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingId, portion_qty: 50, unit: "g" }] });
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// E1 — Employees
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/employees", () => {
  it("returns the seeded employees (at least 1 row per seeded user)", async () => {
    const res = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // seed creates one employee per user — expect at least 8 (admin + 7 roles)
    expect(res.body.length).toBeGreaterThanOrEqual(8);
  });

  it("filters by status=ACTIVE", async () => {
    const res = await request(app)
      .get("/api/v1/employees?status=ACTIVE")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const emp of res.body as Array<{ status: string }>) {
      expect(emp.status).toBe("ACTIVE");
    }
  });

  it("filters by department=KITCHEN", async () => {
    const res = await request(app)
      .get("/api/v1/employees?department=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const emp of res.body as Array<{ department: string }>) {
      expect(emp.department).toBe("KITCHEN");
    }
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/v1/employees");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/employees", () => {
  it("SUPER_ADMIN can create an employee", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: "EMP-9001",
        full_name: "New Cook",
        department: "KITCHEN",
        position: "Line Cook",
      });
    expect(res.status).toBe(201);
    expect(res.body.employeeNo).toBe("EMP-9001");
    expect(res.body.fullName).toBe("New Cook");
    expect(res.body.department).toBe("KITCHEN");
    expect(res.body.status).toBe("ACTIVE");
  });

  it("created employee appears in GET /employees list", async () => {
    await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        employee_no: "EMP-9002",
        full_name: "Listed Employee",
        department: "WAREHOUSE",
      });

    const listRes = await request(app)
      .get("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`);
    const found = (listRes.body as Array<{ fullName: string }>).some(
      (e) => e.fullName === "Listed Employee",
    );
    expect(found).toBe(true);
  });

  it("KITCHEN_STAFF creating employee → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        employee_no: "EMP-9999",
        full_name: "Unauthorized",
        department: "KITCHEN",
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ full_name: "No Number" }); // missing employee_no and department
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2 — Sessions + Audit trail
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/login — session tracking", () => {
  it("creates a user_session row on successful login", async () => {
    // Fresh login — use a unique user to avoid interference
    const email = "session_test_user@cloudkitchen.local";
    const password = "test_pass_123";
    await db.insert(users).values({
      name: "Session Test User",
      email,
      passwordHash: await hashPassword(password),
      role: "KITCHEN_STAFF",
    });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(loginRes.status).toBe(200);

    // Verify user_session row was created
    const [usr] = await db.select().from(users).where(eq(users.email, email));
    const sessions = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, usr.id));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.loginAt).toBeTruthy();
    expect(sessions[0]!.logoutAt).toBeNull();
  });

  it("login writes an auth.login audit row that carries the session id", async () => {
    const email = "audit_login_test@cloudkitchen.local";
    const password = "test_pass_456";
    await db.insert(users).values({
      name: "Audit Login Test",
      email,
      passwordHash: await hashPassword(password),
      role: "KITCHEN_STAFF",
    });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(loginRes.status).toBe(200);

    const [usr] = await db.select().from(users).where(eq(users.email, email));
    const [session] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, usr.id));
    expect(session).toBeTruthy();

    // Audit row must exist for auth.login with matching session id
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "auth.login"));
    const matchingLog = logs.find((l) => l.sessionId === session!.id);
    expect(matchingLog).toBeTruthy();
    expect(matchingLog!.actorUserId).toBe(usr.id);
    expect(matchingLog!.sessionId).toBe(session!.id);
  });
});

describe("POST /api/v1/auth/logout — session tracking", () => {
  it("sets logout_at on the session and writes auth.logout audit row", async () => {
    const email = "logout_test@cloudkitchen.local";
    const password = "test_pass_789";
    await db.insert(users).values({
      name: "Logout Test",
      email,
      passwordHash: await hashPassword(password),
      role: "KITCHEN_STAFF",
    });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token as string;

    const [usr] = await db.select().from(users).where(eq(users.email, email));
    const [session] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, usr.id));
    expect(session).toBeTruthy();

    // Logout
    const logoutRes = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    // Wait a tick for the non-blocking audit write
    await new Promise((r) => setTimeout(r, 50));

    // logout_at must now be set
    const [updatedSession] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, session!.id));
    expect(updatedSession!.logoutAt).not.toBeNull();

    // audit.logout row must exist for this session
    const logoutLogs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "auth.logout"));
    const matchingLog = logoutLogs.find((l) => l.sessionId === session!.id);
    expect(matchingLog).toBeTruthy();
    expect(matchingLog!.actorUserId).toBe(usr.id);
  });
});

describe("POST /orders/:id/advance — audit trail", () => {
  it("writes an order.advance audit row with actor + sessionId + description", async () => {
    // Need a fresh login so we have a session token with sid
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "kitchen_staff@cloudkitchen.local", password: "password123" });
    const freshKitchenToken = loginRes.body.token as string;

    // Ingest an order
    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        customer_name: "Audit Test Customer",
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    expect(ingestRes.status).toBe(201);
    const orderId = ingestRes.body.order_id as string;

    // Advance the order using kitchen staff's session-bearing token
    const advanceRes = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${freshKitchenToken}`);
    expect(advanceRes.status).toBe(200);

    // Wait a tick for the non-blocking audit write
    await new Promise((r) => setTimeout(r, 50));

    // Find the order.advance audit row for this order
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "order.advance"));
    const matchingLog = logs.find((l) => l.entityId === orderId);
    expect(matchingLog).toBeTruthy();
    expect(matchingLog!.entityType).toBe("order");
    expect(matchingLog!.entityId).toBe(orderId);
    // description must mention the order id and the new status
    expect(matchingLog!.description).toContain(orderId);
    expect(matchingLog!.description).toContain(advanceRes.body.status);
    // actor must be the kitchen staff user
    const [kitchenUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "kitchen_staff@cloudkitchen.local"));
    expect(matchingLog!.actorUserId).toBe(kitchenUser.id);
    // session id must be set and match a real session row
    expect(matchingLog!.sessionId).toBeTruthy();
    const [sessionRow] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, matchingLog!.sessionId!));
    expect(sessionRow).toBeTruthy();
    expect(sessionRow!.userId).toBe(kitchenUser.id);
  });
});

describe("GET /api/v1/audit", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/v1/audit");
    expect(res.status).toBe(401);
  });

  it("KITCHEN_STAFF cannot access the audit trail (403)", async () => {
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN gets the audit trail", async () => {
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("?session_id= returns only that session's rows", async () => {
    // Fresh dedicated login to get a known session
    const email = "session_filter_test@cloudkitchen.local";
    const password = "filter_pass_999";
    await db.insert(users).values({
      name: "Session Filter Test",
      email,
      passwordHash: await hashPassword(password),
      role: "KITCHEN_STAFF",
    });

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(loginRes.status).toBe(200);

    const [usr] = await db.select().from(users).where(eq(users.email, email));
    const [session] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, usr.id));
    expect(session).toBeTruthy();

    // Allow the non-blocking audit write to complete
    await new Promise((r) => setTimeout(r, 50));

    // Query audit filtered by the session id
    const auditRes = await request(app)
      .get(`/api/v1/audit?session_id=${session!.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(auditRes.status).toBe(200);
    expect(Array.isArray(auditRes.body)).toBe(true);
    // Every returned row must have this session_id
    for (const row of auditRes.body as Array<{ sessionId: string }>) {
      expect(row.sessionId).toBe(session!.id);
    }
    // At least one row (the auth.login) must be there
    expect(auditRes.body.length).toBeGreaterThanOrEqual(1);
  });

  it("?actor= filters by actor user id", async () => {
    const [adminUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "admin@cloudkitchen.local"));

    const res = await request(app)
      .get(`/api/v1/audit?actor=${adminUser.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body as Array<{ actorUserId: string }>) {
      expect(row.actorUserId).toBe(adminUser.id);
    }
  });

  it("results are ordered newest-first", async () => {
    const res = await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ createdAt: string }>;
    if (rows.length >= 2) {
      const first = new Date(rows[0]!.createdAt).getTime();
      const second = new Date(rows[1]!.createdAt).getTime();
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });
});

describe("GET /api/v1/ems/analytics/employee/:userId", () => {
  it("SUPER_ADMIN can view any user's analytics", async () => {
    const [kitchenUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "kitchen_staff@cloudkitchen.local"));

    const res = await request(app)
      .get(`/api/v1/ems/analytics/employee/${kitchenUser.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalActions");
    expect(res.body).toHaveProperty("orderAdvances");
    expect(res.body).toHaveProperty("sessions");
    expect(res.body.userId).toBe(kitchenUser.id);
  });

  it("user can view their own analytics", async () => {
    // Login as kitchen staff to get their own token
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "kitchen_staff@cloudkitchen.local", password: "password123" });
    const ksToken = loginRes.body.token as string;

    const [kitchenUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "kitchen_staff@cloudkitchen.local"));

    const res = await request(app)
      .get(`/api/v1/ems/analytics/employee/${kitchenUser.id}`)
      .set("Authorization", `Bearer ${ksToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(kitchenUser.id);
  });

  it("user cannot view another user's analytics → 403", async () => {
    const [adminUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "admin@cloudkitchen.local"));

    const res = await request(app)
      .get(`/api/v1/ems/analytics/employee/${adminUser.id}`)
      .set("Authorization", `Bearer ${kitchenToken}`);
    expect(res.status).toBe(403);
  });

  it("reflects order.advance count after advancing orders", async () => {
    // Use kitchen staff to advance an order
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "kitchen_staff@cloudkitchen.local", password: "password123" });
    const ksToken = loginRes.body.token as string;

    const [kitchenUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "kitchen_staff@cloudkitchen.local"));

    // Get baseline count
    const baseRes = await request(app)
      .get(`/api/v1/ems/analytics/employee/${kitchenUser.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const baseAdvances = baseRes.body.orderAdvances as number;

    // Advance a fresh order
    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id: brandId,
        aggregator: "FOODPANDA",
        external_ref: nextRef(),
        items: [{ menu_item_id: grillItemId, qty: 1 }],
      });
    const orderId = ingestRes.body.order_id as string;

    await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${ksToken}`);

    // Wait for non-blocking audit write
    await new Promise((r) => setTimeout(r, 80));

    const afterRes = await request(app)
      .get(`/api/v1/ems/analytics/employee/${kitchenUser.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(afterRes.body.orderAdvances).toBeGreaterThan(baseAdvances);
  });
});
