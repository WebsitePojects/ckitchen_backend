import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Router } from "express";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { requireAuth, requireRole } from "../src/modules/auth/middleware.js";

let app: Express;
let db: DB;

const ADMIN_EMAIL = "admin@cloudkitchen.local";
const ADMIN_PASSWORD = "admin123";
const STAFF_EMAIL = "kitchen_staff@cloudkitchen.local";
const STAFF_PASSWORD = "password123";

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await runMigrations(db);

  await db.insert(users).values([
    {
      name: "Admin",
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "SUPER_ADMIN",
    },
    {
      name: "Kitchen Staff",
      email: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      role: "KITCHEN_STAFF",
    },
  ]);

  app = createApp(db);

  // Test-only route guarded by requireRole("SUPER_ADMIN") to exercise RBAC middleware.
  const testRouter = Router();
  testRouter.get("/api/v1/test/admin-only", requireAuth, requireRole("SUPER_ADMIN"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(testRouter);
});

describe("POST /api/v1/auth/login", () => {
  it("returns 200 + token + user (without password_hash) for correct credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.user.role).toBe("SUPER_ADMIN");
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 401 for unknown email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@cloudkitchen.local", password: "whatever" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns the current user + role for a valid token", async () => {
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const token = loginRes.body.token;

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.user.role).toBe("SUPER_ADMIN");
  });

  it("returns 401 AUTH_REQUIRED with no token", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 AUTH_REQUIRED with an invalid token", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("returns 200 (stateless)", async () => {
    const res = await request(app).post("/api/v1/auth/logout");
    expect(res.status).toBe(200);
  });
});

describe("RBAC: requireRole", () => {
  it("allows SUPER_ADMIN on an admin-only route", async () => {
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const token = loginRes.body.token;

    const res = await request(app)
      .get("/api/v1/test/admin-only")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects KITCHEN_STAFF on an admin-only route with 403 FORBIDDEN", async () => {
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
    const token = loginRes.body.token;

    const res = await request(app)
      .get("/api/v1/test/admin-only")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects unauthenticated requests to an admin-only route with 401 AUTH_REQUIRED", async () => {
    const res = await request(app).get("/api/v1/test/admin-only");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});
