/**
 * The session-validity cache (auth/session-cache.ts) must never let a revoked session
 * through when the revocation happens in this process: logout and admin revoke clear it.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import {
  clearSessionCache,
  forgetUserSessions,
  isSessionKnownValid,
  rememberValidSession,
} from "../src/modules/auth/session-cache.js";

let app: Express;

beforeAll(async () => {
  const { db } = createDb();
  await seed(db);
  app = createApp(db);
});
beforeEach(() => clearSessionCache());

const login = async (email: string, password: string) =>
  (await request(app).post("/api/v1/auth/login").send({ email, password })).body.token as string;

describe("session cache", () => {
  it("expires entries after the TTL", () => {
    rememberValidSession("s1", "u1", 1_000);
    expect(isSessionKnownValid("s1", 1_000 + 14_000)).toBe(true);
    expect(isSessionKnownValid("s1", 1_000 + 15_001)).toBe(false);
  });

  it("forgetUserSessions drops every session of that user only", () => {
    rememberValidSession("a", "u1");
    rememberValidSession("b", "u1");
    rememberValidSession("c", "u2");
    forgetUserSessions("u1");
    expect(isSessionKnownValid("a")).toBe(false);
    expect(isSessionKnownValid("b")).toBe(false);
    expect(isSessionKnownValid("c")).toBe(true);
  });

  it("a token is refused immediately after logout, even though it was just cached", async () => {
    const token = await login("accountant@cloudkitchen.local", "password123");
    const ok = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200); // now cached as valid
    const out = await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(out.status).toBeLessThan(300);
    const after = await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("a blocked user's cached session is refused immediately", async () => {
    const adminToken = await login("admin@cloudkitchen.local", "admin123");
    const hrToken = await login("hr@cloudkitchen.local", "password123");
    expect((await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${hrToken}`)).status).toBe(200);

    const users = (await request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${adminToken}`)).body as Array<{ id: string; email: string }>;
    const hr = (Array.isArray(users) ? users : (users as { users: typeof users }).users).find((u) => u.email === "hr@cloudkitchen.local")!;
    const block = await request(app).post(`/api/v1/admin/users/${hr.id}/block`).set("Authorization", `Bearer ${adminToken}`).send({ reason: "test" });
    expect(block.status, JSON.stringify(block.body)).toBeLessThan(300);

    expect((await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${hrToken}`)).status).toBe(401);
  });
});
