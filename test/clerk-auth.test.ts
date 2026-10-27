/**
 * Clerk sign-in: Clerk proves identity, ORION decides role/outlets.
 *
 * Clerk itself is mocked at its boundary module (src/modules/auth/clerk.ts), so these tests
 * exercise ORION's real linking, refusal and caching logic end to end through HTTP.
 * Tokens look like "clerk:<clerkUserId>"; the mock maps each Clerk user to a verified email.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";

const clerkState = vi.hoisted(() => ({
  enabled: true,
  emails: new Map<string, string | null>(), // clerkUserId -> verified email (null = unverified)
  invited: [] as string[],
}));

vi.mock("../src/modules/auth/clerk.js", () => ({
  clerkSettings: () => (clerkState.enabled ? { secretKey: "sk_test", authorizedParties: ["http://localhost:5173"] } : null),
  clerkConfigProblem: () => null,
  verifyClerkSessionToken: async (token: string) => (token.startsWith("clerk:") ? token.slice(6) : null),
  verifiedPrimaryEmail: async (clerkUserId: string) => clerkState.emails.get(clerkUserId) ?? null,
  sendClerkInvitation: async (email: string) => {
    clerkState.invited.push(email);
    return { url: `https://accounts.example/invite?for=${encodeURIComponent(email)}` };
  },
}));

import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { users } from "../src/db/schema.js";
import { clearSessionCache } from "../src/modules/auth/session-cache.js";

let app: Express;
let db: DB;
let ownerToken: string;

const me = (token: string) => request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);

async function addStaff(email: string, role = "KITCHEN_CREW") {
  const res = await request(app)
    .post("/api/v1/admin/users")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: email.split("@")[0], email, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; invitation: string; inviteUrl?: string | null };
}

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  ownerToken = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;
});
beforeEach(() => {
  clearSessionCache();
  clerkState.enabled = true;
});

describe("Clerk sign-in", () => {
  it("owner adds staff by email only (no password) and a Clerk invitation is sent", async () => {
    const created = await addStaff("Cook.One@Example.com");
    expect(created.invitation).toBe("sent");
    expect(clerkState.invited).toContain("cook.one@example.com"); // normalised
    // The owner gets the link too, to send by chat when the email does not arrive.
    expect(created.inviteUrl).toContain("accounts.example/invite");
  });

  it("resend invite returns the link again for someone who has not signed in yet", async () => {
    const created = await addStaff("Waiting.Cook@Example.com");
    const res = await request(app).post(`/api/v1/admin/users/${created.id}/invite`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, invitation: "sent" });
    expect(res.body.inviteUrl).toContain("accounts.example/invite");
  });

  it("first sign-in links by verified email; later requests resolve by Clerk id with the ORION role", async () => {
    clerkState.emails.set("user_cook1", "cook.one@example.com");
    const first = await me("clerk:user_cook1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.user.role).toBe("KITCHEN_CREW");
    const [row] = await db.select().from(users).where(eq(users.email, "cook.one@example.com"));
    expect(row!.clerkUserId).toBe("user_cook1");

    clerkState.emails.delete("user_cook1"); // linked now: no email lookup needed
    clearSessionCache();
    expect((await me("clerk:user_cook1")).status).toBe(200);
  });

  it("refuses someone who was never invited, naming their email", async () => {
    clerkState.emails.set("user_stranger", "stranger@example.com");
    const res = await me("clerk:user_stranger");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_INVITED");
    expect(res.body.error.message).toContain("stranger@example.com");
  });

  it("refuses an unverified email", async () => {
    await addStaff("unverified@example.com");
    clerkState.emails.set("user_unverified", null);
    const res = await me("clerk:user_unverified");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("an email already linked to another Clerk account cannot be taken over", async () => {
    clerkState.emails.set("user_imposter", "cook.one@example.com");
    const res = await me("clerk:user_imposter");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_LINKED_ELSEWHERE");
  });

  it("two simultaneous first sign-ins link exactly once and both succeed", async () => {
    await addStaff("racer@example.com");
    clerkState.emails.set("user_racer", "racer@example.com");
    const [a, b] = await Promise.all([me("clerk:user_racer"), me("clerk:user_racer")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await db.select().from(users).where(eq(users.clerkUserId, "user_racer"));
    expect(rows).toHaveLength(1);
  });

  it("blocking and role changes apply on the very next request (cache cleared)", async () => {
    const created = await addStaff("mover@example.com");
    clerkState.emails.set("user_mover", "mover@example.com");
    expect((await me("clerk:user_mover")).body.user.role).toBe("KITCHEN_CREW"); // now cached

    await request(app).patch(`/api/v1/admin/users/${created.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ role: "OUTLET_MANAGER" });
    expect((await me("clerk:user_mover")).body.user.role).toBe("OUTLET_MANAGER");

    await request(app).post(`/api/v1/admin/users/${created.id}/block`).set("Authorization", `Bearer ${ownerToken}`).send({ reason: "left" });
    const blocked = await me("clerk:user_mover");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ACCOUNT_BLOCKED");
  });

  it("an invalid token is a 401, and Clerk tokens are ignored entirely when Clerk is off", async () => {
    expect((await me("not-a-token")).status).toBe(401);
    clerkState.enabled = false;
    expect((await me("clerk:user_cook1")).status).toBe(401);
  });

  it("without Clerk, adding staff still requires a password", async () => {
    clerkState.enabled = false;
    const res = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "No Pass", email: "nopass@example.com", role: "KITCHEN_CREW" });
    expect(res.status).toBe(400);
  });

  it("resend invite: refused once the person has signed in", async () => {
    const [row] = await db.select().from(users).where(eq(users.email, "cook.one@example.com"));
    const res = await request(app).post(`/api/v1/admin/users/${row!.id}/invite`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_LINKED");
  });

  it("the ORION password login still works alongside Clerk (IT break-glass)", async () => {
    expect((await me(ownerToken)).status).toBe(200);
  });
});
