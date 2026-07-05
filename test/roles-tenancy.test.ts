/**
 * Wave W1 — Roles v2 + tenancy plumbing (D22 / D24 / D29 / D31).
 *
 * Covers:
 *   - requireRole accepts v1 role aliases against v2 allow-lists (and denies others)
 *   - login JWT carries the outlet_scope / outlet_ids tenancy claims
 *   - X-Outlet-Id membership: member passes, non-member 403, ALL-scope passes any
 *   - user_outlet_access CRUD basics (insert / read / composite-PK uniqueness / cascade)
 *   - migration 0012 applies cleanly on a fresh PGlite (enum v2 values + new table)
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express, { Router, type Express } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { requireAuth, requireRole } from "../src/modules/auth/middleware.js";
import { locations, userOutletAccess, users } from "../src/db/schema.js";

let app: Express;
let db: DB;
let seededLocationId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

/** Decodes a JWT payload without verifying the signature (test-only introspection). */
function decode(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per file
  db = created.db;
  await seed(db); // migrations + 1 location, stations, warehouses, v2 role users + memberships

  const [loc] = await db.select().from(locations);
  seededLocationId = loc.id;

  // Two users carrying legacy v1 roles (no membership) to exercise alias acceptance.
  await db.insert(users).values([
    {
      name: "Legacy Super Admin",
      email: "legacy_superadmin@cloudkitchen.local",
      passwordHash: await hashPassword("password123"),
      role: "SUPER_ADMIN", // v1 → normalizes to OWNER
    },
    {
      name: "Legacy Kitchen",
      email: "legacy_kitchen@cloudkitchen.local",
      passwordHash: await hashPassword("password123"),
      role: "KITCHEN_STAFF", // v1 → normalizes to KITCHEN_CREW
    },
  ]);

  // Custom app with an OWNER-only test route (mirrors auth.test's pattern).
  const testRouter = Router();
  testRouter.get("/api/v1/test/owner-only", requireAuth, requireRole("OWNER"), (_req, res) => {
    res.json({ ok: true });
  });
  app = express();
  app.set("db", db);
  app.use(testRouter);
  app.use(createApp(db));
});

describe("requireRole — v1 alias acceptance against a v2 allow-list", () => {
  it("allows a legacy SUPER_ADMIN (v1) token on an OWNER-only route", async () => {
    const token = await login("legacy_superadmin@cloudkitchen.local", "password123");
    const res = await request(app)
      .get("/api/v1/test/owner-only")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows a native OWNER (v2) token on an OWNER-only route", async () => {
    const token = await login("admin@cloudkitchen.local", "admin123");
    const res = await request(app)
      .get("/api/v1/test/owner-only")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("rejects a legacy KITCHEN_STAFF (v1) token with 403 FORBIDDEN", async () => {
    const token = await login("legacy_kitchen@cloudkitchen.local", "password123");
    const res = await request(app)
      .get("/api/v1/test/owner-only")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("JWT tenancy claims", () => {
  it("HQ role (OWNER) gets outlet_scope 'ALL'", async () => {
    const token = await login("admin@cloudkitchen.local", "admin123");
    const payload = decode(token);
    expect(payload.outlet_scope).toBe("ALL");
    expect(Array.isArray(payload.outlet_ids)).toBe(true);
  });

  it("outlet-scoped role (WAREHOUSE_OUTLET) gets 'ASSIGNED' + its outlet ids", async () => {
    const token = await login("warehouse@cloudkitchen.local", "password123");
    const payload = decode(token);
    expect(payload.outlet_scope).toBe("ASSIGNED");
    expect(payload.outlet_ids).toContain(seededLocationId);
  });
});

describe("X-Outlet-Id membership enforcement (GET /warehouses)", () => {
  it("member (ASSIGNED) passes with a header for their own outlet", async () => {
    const token = await login("warehouse@cloudkitchen.local", "password123");
    const res = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Outlet-Id", seededLocationId);
    expect(res.status).toBe(200);
  });

  it("non-member (ASSIGNED) is 403'd for an outlet outside their scope", async () => {
    const token = await login("warehouse@cloudkitchen.local", "password123");
    const res = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Outlet-Id", randomUUID()); // not in outlet_ids
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ALL-scope (OWNER) passes any real outlet, even without a membership row", async () => {
    const adminToken = await login("admin@cloudkitchen.local", "admin123");
    // A second real outlet the admin has no explicit user_outlet_access row for.
    const outletRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "TEN2", name: "Tenancy Outlet 2" });
    const outlet2Id = outletRes.body.id as string;

    const res = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("X-Outlet-Id", outlet2Id);
    expect(res.status).toBe(200);
    // Should return outlet2's warehouses (created with the outlet), not the seeded one.
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("user_outlet_access CRUD basics", () => {
  it("inserts, reads back, and enforces the composite PK", async () => {
    const [u] = await db
      .insert(users)
      .values({
        name: "Access CRUD",
        email: "access_crud@cloudkitchen.local",
        passwordHash: await hashPassword("password123"),
        role: "OUTLET_MANAGER",
      })
      .returning();

    await db.insert(userOutletAccess).values({ userId: u.id, locationId: seededLocationId });

    const rows = await db
      .select()
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].locationId).toBe(seededLocationId);
    expect(rows[0].createdAt).toBeTruthy();

    // Duplicate (user_id, location_id) violates the composite primary key.
    await expect(
      db.insert(userOutletAccess).values({ userId: u.id, locationId: seededLocationId }),
    ).rejects.toThrow();
  });

  it("cascades on user delete (FK ON DELETE CASCADE)", async () => {
    const [u] = await db
      .insert(users)
      .values({
        name: "Cascade User",
        email: "cascade_user@cloudkitchen.local",
        passwordHash: await hashPassword("password123"),
        role: "KITCHEN_CREW",
      })
      .returning();
    await db.insert(userOutletAccess).values({ userId: u.id, locationId: seededLocationId });

    await db.delete(users).where(eq(users.id, u.id));

    const rows = await db
      .select()
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, u.id));
    expect(rows).toHaveLength(0);
  });
});

describe("migration 0012 applies cleanly on a fresh PGlite", () => {
  it("creates the v2 enum values and the user_outlet_access table", async () => {
    const fresh = createDb();
    await runMigrations(fresh.db);

    const [loc] = await fresh.db
      .insert(locations)
      .values({ code: "FRESH1", name: "Fresh Outlet" })
      .returning();
    // Inserting a v2 role proves ALTER of the enum landed.
    const [u] = await fresh.db
      .insert(users)
      .values({
        name: "Fresh Owner",
        email: "fresh_owner@cloudkitchen.local",
        passwordHash: "x",
        role: "OWNER",
      })
      .returning();
    // Inserting into user_outlet_access proves the new table + FKs landed.
    await fresh.db.insert(userOutletAccess).values({ userId: u.id, locationId: loc.id });

    const rows = await fresh.db.select().from(userOutletAccess);
    expect(rows).toHaveLength(1);
    expect(u.role).toBe("OWNER");
  });
});
