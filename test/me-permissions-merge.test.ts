/**
 * Regression: GET /me/permissions merges per page.
 *
 * Found 2026-10-27 shipping /pos: role_page_access is seeded once, so a page added
 * afterwards had no row. /me/permissions only fell back to code defaults when a role had
 * NO rows at all, so every page shipped after go-live was denied to every non-OWNER role
 * (the cook was bounced from /pos to /kitchen). Persisted rows must still win.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { rolePageAccess } from "../src/db/schema.js";

let app: Express;
let db: DB;
let crewToken: string;

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  // Simulate a database seeded before /pos existed: drop that cell for kitchen crew.
  await db.delete(rolePageAccess).where(and(eq(rolePageAccess.role, "KITCHEN_CREW"), eq(rolePageAccess.pageKey, "/pos")));
  const res = await request(app).post("/api/v1/auth/login").send({ email: "kitchen_staff@cloudkitchen.local", password: "password123" });
  crewToken = res.body.token as string;
});

const pages = async () =>
  (await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${crewToken}`)).body.pages as string[];

describe("/me/permissions per-page merge", () => {
  it("grants a page that has no persisted row yet from the code default", async () => {
    const rows = await db.select().from(rolePageAccess).where(eq(rolePageAccess.role, "KITCHEN_CREW"));
    expect(rows.length).toBeGreaterThan(0); // the role HAS rows, just not /pos
    expect(await pages()).toContain("/pos");
  });

  it("still honours an admin's explicit deny", async () => {
    await db.insert(rolePageAccess).values({ role: "KITCHEN_CREW", pageKey: "/pos", allowed: false });
    expect(await pages()).not.toContain("/pos");
    expect(await pages()).toContain("/kitchen");
  });
});
