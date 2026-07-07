import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { createDb, type DB } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { users } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";
import { seedRolePageAccess } from "../admin/routes.js";
import { PAGE_KEYS, PAGE_ROLES } from "../admin/rbac-defaults.js";

const OWNER_EMAIL = "owner-perms@cloudkitchen.local";
const OWNER_PASSWORD = "owner-perms-password";
const CREW_EMAIL = "crew-perms@cloudkitchen.local";
const CREW_PASSWORD = "crew-perms-password";

/** Logs in and returns the bearer token (throws if login didn't 200). */
async function login(app: Express, email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

describe("GET /me/permissions — seeded matrix", () => {
  let app: Express;
  let db: DB;
  let ownerToken: string;
  let crewToken: string;

  beforeAll(async () => {
    const created = createDb(); // in-memory, isolated per describe block
    db = created.db;
    await runMigrations(db);
    await seedRolePageAccess(db);

    await db.insert(users).values([
      { name: "Owner", email: OWNER_EMAIL, passwordHash: await hashPassword(OWNER_PASSWORD), role: "OWNER" },
      { name: "Crew", email: CREW_EMAIL, passwordHash: await hashPassword(CREW_PASSWORD), role: "KITCHEN_CREW" },
    ]);

    app = createApp(db);
    ownerToken = await login(app, OWNER_EMAIL, OWNER_PASSWORD);
    crewToken = await login(app, CREW_EMAIL, CREW_PASSWORD);
  });

  it("requires auth (401 without a token)", async () => {
    const res = await request(app).get("/api/v1/me/permissions");
    expect(res.status).toBe(401);
  });

  it("OWNER always resolves to every page", async () => {
    const res = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pages.sort()).toEqual([...PAGE_KEYS].sort());
  });

  it("a restricted role reflects the persisted matrix (default allowed)", async () => {
    const res = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${crewToken}`);
    expect(res.status).toBe(200);
    // Default seed: KITCHEN_CREW is allowed on /orders (per PAGE_ROLES).
    expect(res.body.pages).toContain("/orders");
    // Default seed: KITCHEN_CREW is NOT allowed on /users.
    expect(res.body.pages).not.toContain("/users");
  });

  it("reflects a matrix row flipped to allowed=false via the admin API", async () => {
    // KITCHEN_CREW has /orders allowed=true by default — flip it off.
    const put = await request(app)
      .put("/api/v1/admin/rbac")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send([{ role: "KITCHEN_CREW", pageKey: "/orders", allowed: false }]);
    expect(put.status).toBe(200);

    const res = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${crewToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pages).not.toContain("/orders");
  });
});

describe("GET /me/permissions — unseeded table falls back to code defaults", () => {
  let app: Express;
  let db: DB;
  let crewToken: string;

  beforeAll(async () => {
    const created = createDb(); // fresh in-memory db — deliberately NOT seeded
    db = created.db;
    await runMigrations(db);
    // NOTE: no seedRolePageAccess(db) call — role_page_access is empty.

    await db
      .insert(users)
      .values({ name: "Crew", email: CREW_EMAIL, passwordHash: await hashPassword(CREW_PASSWORD), role: "KITCHEN_CREW" });

    app = createApp(db);
    crewToken = await login(app, CREW_EMAIL, CREW_PASSWORD);
  });

  it("falls back to rbac-defaults.PAGE_ROLES when no rows exist for the role", async () => {
    const res = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${crewToken}`);
    expect(res.status).toBe(200);
    const expected = PAGE_KEYS.filter((pageKey) => PAGE_ROLES[pageKey]?.includes("KITCHEN_CREW"));
    expect(res.body.pages.sort()).toEqual([...expected].sort());
  });
});
