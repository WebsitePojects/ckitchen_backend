/**
 * End-to-end workspace isolation (SaaS step 8 proof, D55): two businesses sign up through
 * the real HTTP API, each connection logs in as its own workspace role, and neither can see
 * or change the other's data, nor CloudKitchen's (workspace #1).
 *
 * Needs a real Postgres where the test user may CREATE ROLE and log in as new roles (the
 * Docker playground): PG_ISOLATION_URL=postgres://orion:...@127.0.0.1:55432/<fresh db>.
 * Skipped without it: PGlite has one connection and cannot log in as a second role.
 * The database-level rules are also covered in the normal suite (workspace-rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { sql } from "drizzle-orm";

const clerkState = vi.hoisted(() => ({ emails: new Map<string, string>() }));

vi.mock("../src/modules/auth/clerk.js", () => ({
  clerkSettings: () => ({ secretKey: "sk_test", authorizedParties: ["http://localhost:5173"] }),
  clerkConfigProblem: () => null,
  verifyClerkSessionToken: async (token: string) => (token.startsWith("clerk:") ? token.slice(6) : null),
  verifiedPrimaryEmail: async (clerkUserId: string) => clerkState.emails.get(clerkUserId) ?? null,
  sendClerkInvitation: async () => ({ url: null }),
}));

import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { createWorkspaceConnections, type WorkspaceConnections } from "../src/modules/tenancy/connections.js";
import { clearSessionCache } from "../src/modules/auth/session-cache.js";

const url = process.env.PG_ISOLATION_URL;
const suite = url ? describe : describe.skip;

let app: Express;
let db: DB;
let workspaces: WorkspaceConnections;
let cloudKitchenToken: string;

const as = (clerkUser: string) => ({ Authorization: `Bearer clerk:${clerkUser}` });

async function signUp(clerkUser: string, email: string, businessName: string) {
  clerkState.emails.set(clerkUser, email);
  return request(app)
    .post("/api/v1/auth/signup")
    .set(as(clerkUser))
    .send({ business_name: businessName, owner_name: `${businessName} Owner`, outlet_name: `${businessName} Kitchen`, brand_name: `${businessName} Brand` });
}

suite("two businesses on one database", () => {
  beforeAll(async () => {
    process.env.SELF_SIGNUP = "on";
    db = createDb({ databaseUrl: url! }).db;
    await seed(db);
    workspaces = createWorkspaceConnections({ platformDb: db, databaseUrl: url!, isolated: true });
    app = createApp(db, undefined, { workspaces });
    cloudKitchenToken = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;
  });

  afterAll(async () => {
    delete process.env.SELF_SIGNUP;
    await workspaces?.closeAll();
  });

  it("sign-up is open and creates a workspace per owner, with its outlet and brand", async () => {
    expect((await request(app).get("/api/v1/auth/signup/status")).body).toEqual({ enabled: true });
    const a = await signUp("user_alpha", "alpha.owner@gmail.com", "Alpha Foods");
    const b = await signUp("user_bravo", "bravo.owner@gmail.com", "Bravo Eats");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(a.body.workspace.slug).toMatch(/^alpha-foods-[0-9a-f]{6}$/);

    clearSessionCache();
    const me = await request(app).get("/api/v1/auth/me").set(as("user_alpha"));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ role: "OWNER", email: "alpha.owner@gmail.com" });
    const brands = await request(app).get("/api/v1/brands").set(as("user_alpha"));
    expect(brands.body.map((x: { name: string }) => x.name)).toEqual(["Alpha Foods Brand"]);
  });

  it("each business sees only its own outlets, brands and people", async () => {
    for (const [user, own] of [["user_alpha", "Alpha Foods"], ["user_bravo", "Bravo Eats"]] as const) {
      const outlets = await request(app).get("/api/v1/outlets").set(as(user));
      expect(outlets.status).toBe(200);
      expect(outlets.body.map((o: { name: string }) => o.name)).toEqual([`${own} Kitchen`]);
      const people = await request(app).get("/api/v1/admin/users").set(as(user));
      expect(people.status).toBe(200);
      expect(people.body.map((u: { email: string }) => u.email)).toEqual([`${own === "Alpha Foods" ? "alpha" : "bravo"}.owner@gmail.com`]);
    }
  });

  it("CloudKitchen sees none of the new businesses' data, and they see none of CloudKitchen's", async () => {
    const ckBrands = await request(app).get("/api/v1/brands").set("Authorization", `Bearer ${cloudKitchenToken}`);
    const names = ckBrands.body.map((x: { name: string }) => x.name);
    expect(names).not.toContain("Alpha Foods Brand");
    expect(names).not.toContain("Bravo Eats Brand");
    const ckUsers = await request(app).get("/api/v1/admin/users").set("Authorization", `Bearer ${cloudKitchenToken}`);
    expect(ckUsers.body.map((u: { email: string }) => u.email)).not.toContain("alpha.owner@gmail.com");

    const alphaUsers = await request(app).get("/api/v1/admin/users").set(as("user_alpha"));
    expect(alphaUsers.body.map((u: { email: string }) => u.email)).not.toContain("admin@cloudkitchen.local");
  });

  it("a business cannot read or change another business's records by id", async () => {
    const bravoBrand = (await request(app).get("/api/v1/brands").set(as("user_bravo"))).body[0] as { id: string };
    const read = await request(app).get(`/api/v1/brands/${bravoBrand.id}/menu`).set(as("user_alpha"));
    expect([403, 404]).toContain(read.status);
    const change = await request(app).patch(`/api/v1/brands/${bravoBrand.id}`).set(as("user_alpha")).send({ name: "Hijacked" });
    expect([403, 404]).toContain(change.status);
    const [still] = (await db.execute(sql`select name from brand where id = ${bravoBrand.id}`)) as unknown as { name: string }[];
    expect(still!.name).toBe("Bravo Eats Brand");
  });

  it("new records land in the creator's workspace", async () => {
    const created = await request(app).post("/api/v1/brands").set(as("user_alpha")).send({ name: "Alpha Second", color: "#123456" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [row] = (await db.execute(sql`select b.tenant_id, t.name from brand b join tenant t on t.id = b.tenant_id where b.id = ${created.body.id}`)) as unknown as { name: string }[];
    expect(row!.name).toBe("Alpha Foods");
    const bravo = await request(app).get("/api/v1/brands").set(as("user_bravo"));
    expect(bravo.body.map((x: { name: string }) => x.name)).not.toContain("Alpha Second");
  });

  it("a join link adds the person to that business only", async () => {
    const link = await request(app)
      .post("/api/v1/admin/join-links")
      .set(as("user_bravo"))
      .send({ invitee_name: "Bravo Cook", role: "HR", request_id: crypto.randomUUID() });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    clerkState.emails.set("user_bravo_cook", "bravo.cook@gmail.com");
    const joined = await request(app).post("/api/v1/auth/join").set(as("user_bravo_cook")).send({ token: link.body.token });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    clearSessionCache();
    const bravoPeople = await request(app).get("/api/v1/admin/users").set(as("user_bravo"));
    expect(bravoPeople.body.map((u: { email: string }) => u.email)).toContain("bravo.cook@gmail.com");
    const alphaPeople = await request(app).get("/api/v1/admin/users").set(as("user_alpha"));
    expect(alphaPeople.body.map((u: { email: string }) => u.email)).not.toContain("bravo.cook@gmail.com");
  });

  it("adding staff with an email another business uses is refused without saying which business", async () => {
    const res = await request(app).post("/api/v1/admin/users").set(as("user_alpha")).send({ name: "Copy", email: "bravo.owner@gmail.com", role: "HR" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain("Bravo");
  });

  it("one account, one workspace: a repeat or a double click returns the same workspace", async () => {
    const first = await signUp("user_charlie", "charlie.owner@gmail.com", "Charlie Grill");
    const again = await signUp("user_charlie", "charlie.owner@gmail.com", "Charlie Grill");
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.workspace.id).toBe(first.body.workspace.id);

    const both = await Promise.all([0, 1].map(() => signUp("user_delta", "delta.owner@gmail.com", "Delta Diner")));
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    const rows = (await db.execute(sql`select count(*)::int as n from tenant where name = 'Delta Diner'`)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(1);
  });

  it("someone already in a workspace, or with an email already in ORION, cannot sign up again", async () => {
    clerkState.emails.set("user_ck_copy", "admin@cloudkitchen.local");
    const taken = await signUp("user_ck_copy", "admin@cloudkitchen.local", "Copycat");
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("EMAIL_ALREADY_ADDED");
  });
});
