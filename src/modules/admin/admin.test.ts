import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { createDb, type DB } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { locations, users } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";
import { seedRolePageAccess } from "./routes.js";

let app: Express;
let db: DB;
let outletId: string;
let adminId: string;

const ADMIN_EMAIL = "owner@cloudkitchen.local";
const ADMIN_PASSWORD = "owner-password";

/** Logs in and returns the bearer token (throws if login didn't 200). */
async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await runMigrations(db);
  await seedRolePageAccess(db);

  const [outlet] = await db
    .insert(locations)
    .values({ code: "CK1", name: "CloudKitchen ONE", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();
  outletId = outlet.id;

  const [admin] = await db
    .insert(users)
    .values({
      name: "Owner Admin",
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "OWNER",
    })
    .returning();
  adminId = admin.id;

  app = createApp(db);
});

describe("Admin user management (W5)", () => {
  let ownerToken: string;
  let crewId: string;
  const CREW_EMAIL = "crew@cloudkitchen.local";
  const CREW_PASSWORD = "crew-password";
  const CREW_PASSWORD_2 = "crew-password-2";

  it("requires an OWNER token (403 for a non-owner)", async () => {
    ownerToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    // Create a non-owner and confirm they cannot reach the admin surface.
    const create = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Crew", email: CREW_EMAIL, role: "KITCHEN_CREW", password: CREW_PASSWORD, outlet_ids: [outletId] });
    expect(create.status).toBe(201);
    crewId = create.body.id;
    expect(create.body.passwordHash).toBeUndefined();
    expect(create.body.status).toBe("ACTIVE");

    const crewToken = await login(CREW_EMAIL, CREW_PASSWORD);
    const forbidden = await request(app)
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${crewToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a duplicate email on create (409)", async () => {
    const dup = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Crew Dup", email: CREW_EMAIL, role: "KITCHEN_CREW", password: "another-pass" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CONFLICT");
  });

  it("lists users with status, outlet ids, and no password hash", async () => {
    const res = await request(app)
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const crew = res.body.find((u: { id: string }) => u.id === crewId);
    expect(crew).toBeTruthy();
    expect(crew.status).toBe("ACTIVE");
    expect(crew.role).toBe("KITCHEN_CREW");
    expect(crew.outletIds).toContain(outletId);
    expect(crew.passwordHash).toBeUndefined();
    expect("password_hash" in crew).toBe(false);
  });

  it("blocks a user → login now 403 ACCOUNT_BLOCKED", async () => {
    const block = await request(app)
      .post(`/api/v1/admin/users/${crewId}/block`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(block.status).toBe(200);
    expect(block.body.status).toBe("BLOCKED");

    const denied = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: CREW_EMAIL, password: CREW_PASSWORD });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCOUNT_BLOCKED");
  });

  it("revokes live sessions on block (existing token dies immediately)", async () => {
    // Fresh user, log them in, block, then their token must be rejected.
    const create = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Temp", email: "temp@cloudkitchen.local", role: "KITCHEN_CREW", password: "temp-password" });
    const tempId = create.body.id;
    const tempToken = await login("temp@cloudkitchen.local", "temp-password");

    const before = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tempToken}`);
    expect(before.status).toBe(200);

    await request(app).post(`/api/v1/admin/users/${tempId}/block`).set("Authorization", `Bearer ${ownerToken}`);

    const after = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tempToken}`);
    expect(after.status).toBe(401);
  });

  it("unblocks a user → login works again", async () => {
    const unblock = await request(app)
      .post(`/api/v1/admin/users/${crewId}/unblock`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(unblock.status).toBe(200);
    expect(unblock.body.status).toBe("ACTIVE");

    const ok = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: CREW_EMAIL, password: CREW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  it("resets a password → old fails, new works", async () => {
    const reset = await request(app)
      .post(`/api/v1/admin/users/${crewId}/reset-password`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ password: CREW_PASSWORD_2 });
    expect(reset.status).toBe(200);

    const oldFail = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: CREW_EMAIL, password: CREW_PASSWORD });
    expect(oldFail.status).toBe(401);

    const newOk = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: CREW_EMAIL, password: CREW_PASSWORD_2 });
    expect(newOk.status).toBe(200);
  });

  it("rejects a too-short password on reset (400)", async () => {
    const res = await request(app)
      .post(`/api/v1/admin/users/${crewId}/reset-password`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ password: "short" });
    expect(res.status).toBe(400);
  });

  it("replaces outlet access (transactional delete + insert)", async () => {
    // Clear
    const cleared = await request(app)
      .put(`/api/v1/admin/users/${crewId}/outlets`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ outlet_ids: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.outletIds).toEqual([]);

    // Re-add
    const readded = await request(app)
      .put(`/api/v1/admin/users/${crewId}/outlets`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ outlet_ids: [outletId] });
    expect(readded.status).toBe(200);
    expect(readded.body.outletIds).toEqual([outletId]);

    // Reflected in list
    const list = await request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${ownerToken}`);
    const crew = list.body.find((u: { id: string }) => u.id === crewId);
    expect(crew.outletIds).toEqual([outletId]);
  });

  it("rejects unknown outlet ids on replace (400)", async () => {
    const res = await request(app)
      .put(`/api/v1/admin/users/${crewId}/outlets`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ outlet_ids: ["00000000-0000-0000-0000-000000000000"] });
    expect(res.status).toBe(400);
  });

  it("records audit rows for a user's activity", async () => {
    // The owner has been the actor for every mutation above.
    const res = await request(app)
      .get(`/api/v1/admin/users/${adminId}/activity`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.some((r: { action: string }) => r.action.startsWith("admin.user"))).toBe(true);
  });
});

describe("Last-OWNER lockout guards", () => {
  let ownerToken: string;

  it("blocks self-block of the sole active OWNER with 409 LAST_OWNER", async () => {
    ownerToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app)
      .post(`/api/v1/admin/users/${adminId}/block`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LAST_OWNER");
  });

  it("blocks self-demotion of the sole active OWNER with 409", async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${adminId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ role: "KITCHEN_CREW" });
    expect(res.status).toBe(409);
    // Sole active owner → LAST_OWNER takes precedence over SELF_ACTION.
    expect(res.body.error.code).toBe("LAST_OWNER");
  });

  it("SELF_ACTION when a second OWNER exists (not the last)", async () => {
    // Add a second owner so the acting owner is no longer the last one.
    const create = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Owner Two", email: "owner2@cloudkitchen.local", role: "OWNER", password: "owner2-password" });
    expect(create.status).toBe(201);

    const selfBlock = await request(app)
      .post(`/api/v1/admin/users/${adminId}/block`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(selfBlock.status).toBe(409);
    expect(selfBlock.body.error.code).toBe("SELF_ACTION");
  });
});

describe("RBAC role→page matrix", () => {
  let ownerToken: string;

  it("returns the seeded matrix", async () => {
    ownerToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await request(app).get("/api/v1/admin/rbac").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pages).toContain("/users");
    expect(res.body.entries.length).toBeGreaterThan(0);
    // OWNER seeded allowed everywhere, incl. protected admin pages.
    const ownerUsers = res.body.entries.find(
      (e: { role: string; pageKey: string }) => e.role === "OWNER" && e.pageKey === "/users",
    );
    expect(ownerUsers.allowed).toBe(true);
    // KITCHEN_CREW is NOT allowed on /users by default.
    const crewUsers = res.body.entries.find(
      (e: { role: string; pageKey: string }) => e.role === "KITCHEN_CREW" && e.pageKey === "/users",
    );
    expect(crewUsers.allowed).toBe(false);
  });

  it("upserts an entry", async () => {
    const res = await request(app)
      .put("/api/v1/admin/rbac")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send([{ role: "KITCHEN_CREW", pageKey: "/reports", allowed: true }]);
    expect(res.status).toBe(200);
    const entry = res.body.entries.find(
      (e: { role: string; pageKey: string }) => e.role === "KITCHEN_CREW" && e.pageKey === "/reports",
    );
    expect(entry.allowed).toBe(true);
  });

  it("refuses to strip OWNER access to a protected page (409 OWNER_LOCKED)", async () => {
    const res = await request(app)
      .put("/api/v1/admin/rbac")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send([{ role: "OWNER", pageKey: "/users", allowed: false }]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("OWNER_LOCKED");
  });
});
