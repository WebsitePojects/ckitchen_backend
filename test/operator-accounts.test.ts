/**
 * Operator bootstrap: the first real owner is created from the server CLI (never seeded),
 * and the seeded demo accounts are retired only after that owner can actually sign in.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { userSessions, users } from "../src/db/schema.js";
import { grantFirstOwner, retireSeedAccounts } from "../src/modules/admin/operator-accounts.js";

let db: DB;
let app: Express;
const invites: string[] = [];
const fakeInvite = async (email: string) => {
  invites.push(email);
  return { url: `https://accounts.example/invite?for=${encodeURIComponent(email)}` };
};
const byEmail = async (email: string) => (await db.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0];

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
});

describe("grantFirstOwner", () => {
  it("creates a password-less OWNER for a real email and sends the invitation", async () => {
    const result = await grantFirstOwner(db, { email: "  Boss@Kitchen-Biz.PH ", name: "Sir Boss" }, fakeInvite);
    expect(result).toMatchObject({ outcome: "created", invitation: "sent" });
    expect(result.outcome === "created" && result.inviteUrl).toContain("accounts.example/invite");
    const row = await byEmail("boss@kitchen-biz.ph");
    expect(row).toMatchObject({ role: "OWNER", status: "ACTIVE", email: "boss@kitchen-biz.ph" });
    expect(invites).toContain("boss@kitchen-biz.ph");
  });

  it("is idempotent, sequentially and concurrently: one account, never a duplicate", async () => {
    const again = await grantFirstOwner(db, { email: "boss@kitchen-biz.ph", name: "Sir Boss" }, fakeInvite);
    expect(again.outcome).toBe("already_owner");
    const [a, b] = await Promise.all([
      grantFirstOwner(db, { email: "twin@kitchen-biz.ph", name: "Twin" }, fakeInvite),
      grantFirstOwner(db, { email: "twin@kitchen-biz.ph", name: "Twin" }, fakeInvite),
    ]);
    expect([a.outcome, b.outcome].every((o) => o === "created" || o === "already_owner")).toBe(true);
    const rows = await db.select().from(users).where(sql`lower(${users.email}) = 'twin@kitchen-biz.ph'`);
    expect(rows).toHaveLength(1);
  });

  it("refuses fake domains and never silently promotes an existing non-owner", async () => {
    expect((await grantFirstOwner(db, { email: "someone@cloudkitchen.local", name: "Fake" }, fakeInvite)).outcome).toBe("refused");
    const crew = await grantFirstOwner(db, { email: "kitchen_staff@cloudkitchen.local", name: "Crew" }, fakeInvite);
    expect(crew.outcome).toBe("refused");
    await db.insert(users).values({ name: "Cook", email: "cook@kitchen-biz.ph", passwordHash: "x", role: "KITCHEN_CREW" });
    const promote = await grantFirstOwner(db, { email: "cook@kitchen-biz.ph", name: "Cook" }, fakeInvite);
    expect(promote).toMatchObject({ outcome: "refused" });
    expect((await byEmail("cook@kitchen-biz.ph"))!.role).toBe("KITCHEN_CREW");
  });

  it("does not re-invite someone who has already signed in", async () => {
    await db.update(users).set({ clerkUserId: "user_linked_1" }).where(eq(users.email, "boss@kitchen-biz.ph"));
    const before = invites.length;
    expect(await grantFirstOwner(db, { email: "boss@kitchen-biz.ph", name: "Sir Boss" }, fakeInvite)).toMatchObject({ invitation: "already_linked" });
    expect(invites.length).toBe(before);
  });
});

describe("retireSeedAccounts", () => {
  it("refuses while no real owner has signed in (no lockout)", async () => {
    await db.update(users).set({ clerkUserId: null }).where(eq(users.email, "boss@kitchen-biz.ph"));
    expect((await retireSeedAccounts(db)).outcome).toBe("refused");
    expect((await byEmail("admin@cloudkitchen.local"))!.status).toBe("ACTIVE");
  });

  it("blocks every seed account, ends their sessions, and the seed password stops working", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" });
    expect(login.status).toBe(200);
    const seedAdmin = (await byEmail("admin@cloudkitchen.local"))!;
    expect((await db.select().from(userSessions).where(eq(userSessions.userId, seedAdmin.id))).some((s) => s.logoutAt === null)).toBe(true);

    await db.update(users).set({ clerkUserId: "user_linked_1" }).where(eq(users.email, "boss@kitchen-biz.ph"));
    const result = await retireSeedAccounts(db);
    expect(result.outcome).toBe("retired");
    if (result.outcome !== "retired") return;
    expect(result.blocked).toBeGreaterThan(0);
    expect(result.sessionsEnded).toBeGreaterThan(0);

    const seeds = await db.select().from(users).where(sql`lower(${users.email}) like '%.local'`);
    expect(seeds.every((u) => u.status === "BLOCKED")).toBe(true);
    expect((await byEmail("boss@kitchen-biz.ph"))!.status).toBe("ACTIVE");
    expect((await byEmail("cook@kitchen-biz.ph"))!.status).toBe("ACTIVE");

    const after = await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" });
    expect(after.status).not.toBe(200);
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.body.token}`);
    expect(me.status).toBe(401);

    expect(await retireSeedAccounts(db)).toMatchObject({ outcome: "retired", blocked: 0 }); // idempotent
  });
});
