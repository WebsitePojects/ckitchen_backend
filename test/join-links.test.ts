/**
 * Workspace join links: an owner makes a one-time link, the person opens it, signs in with
 * any Google account and joins with the owner's chosen role, with no email collected first.
 *
 * Clerk is mocked at its boundary module (as in clerk-auth.test.ts): tokens look like
 * "clerk:<clerkUserId>" and the mock maps each Clerk user to a verified email.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";

const clerkState = vi.hoisted(() => ({
  enabled: true,
  emails: new Map<string, string | null>(),
  unreachable: false,
}));

vi.mock("../src/modules/auth/clerk.js", () => ({
  clerkSettings: () => (clerkState.enabled ? { secretKey: "sk_test", authorizedParties: ["http://localhost:5173"] } : null),
  clerkConfigProblem: () => null,
  verifyClerkSessionToken: async (token: string) => (token.startsWith("clerk:") ? token.slice(6) : null),
  verifiedPrimaryEmail: async (clerkUserId: string) => {
    if (clerkState.unreachable) throw new Error("clerk down");
    return clerkState.emails.get(clerkUserId) ?? null;
  },
  sendClerkInvitation: async () => ({ url: null }),
}));

import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { auditLogs, locations, memberships, userOutletAccess, users, workspaceJoinLinks, WORKSPACE_ONE_ID } from "../src/db/schema.js";
import { clearSessionCache } from "../src/modules/auth/session-cache.js";

let app: Express;
let db: DB;
let ownerToken: string;
let outletId: string;

const asOwner = (req: request.Test) => req.set("Authorization", `Bearer ${ownerToken}`);

async function makeLink(body: Record<string, unknown> = {}) {
  const res = await asOwner(request(app).post("/api/v1/admin/join-links")).send({
    invitee_name: "Sir BJ",
    role: "OWNER",
    request_id: randomUUID(),
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; token: string; status: string; role: string };
}

const join = (token: string, clerkUser: string) =>
  request(app).post("/api/v1/auth/join").set("Authorization", `Bearer clerk:${clerkUser}`).send({ token });

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  ownerToken = (await request(app).post("/api/v1/auth/login").send({ email: "admin@cloudkitchen.local", password: "admin123" })).body.token;
  const [outlet] = await db.select().from(locations).limit(1);
  outletId = outlet!.id;
});
beforeEach(() => {
  clearSessionCache();
  clerkState.enabled = true;
  clerkState.unreachable = false;
});

describe("owner manages join links", () => {
  it("only an OWNER can create or list links", async () => {
    clerkState.emails.set("user_cook_lister", "cook.lister@example.com");
    const cook = await makeLink({ invitee_name: "Cook Lister", role: "KITCHEN_CREW", outlet_ids: [outletId] });
    expect((await join(cook.token, "user_cook_lister")).status).toBe(201);
    const asCook = (r: request.Test) => r.set("Authorization", "Bearer clerk:user_cook_lister");
    expect((await asCook(request(app).get("/api/v1/admin/join-links"))).status).toBe(403);
    expect((await asCook(request(app).post("/api/v1/admin/join-links")).send({ invitee_name: "x", role: "OWNER", request_id: randomUUID() })).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/join-links")).status).toBe(401);
  });

  it("a double click with the same request id makes one link (sequential and concurrent)", async () => {
    const requestId = randomUUID();
    const body = { invitee_name: "Double Click", role: "KITCHEN_CREW", outlet_ids: [outletId], request_id: requestId };
    const first = await asOwner(request(app).post("/api/v1/admin/join-links")).send(body);
    const again = await asOwner(request(app).post("/api/v1/admin/join-links")).send(body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.token).toBe(first.body.token);

    const concurrentId = randomUUID();
    const both = await Promise.all(
      [0, 1].map(() => asOwner(request(app).post("/api/v1/admin/join-links")).send({ ...body, request_id: concurrentId })),
    );
    expect(new Set(both.map((r) => r.body.id)).size).toBe(1);
    const rows = await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.clientRequestId, concurrentId));
    expect(rows).toHaveLength(1);
  });

  it("a reused request id with a different payload is refused", async () => {
    const requestId = randomUUID();
    await asOwner(request(app).post("/api/v1/admin/join-links")).send({ invitee_name: "A", role: "HR", request_id: requestId });
    const clash = await asOwner(request(app).post("/api/v1/admin/join-links")).send({ invitee_name: "B", role: "OWNER", request_id: requestId });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects bad input: unknown role, unknown outlet, missing request id, too long expiry", async () => {
    const post = (b: Record<string, unknown>) => asOwner(request(app).post("/api/v1/admin/join-links")).send(b);
    expect((await post({ invitee_name: "x", role: "RIDER", request_id: randomUUID() })).status).toBe(400);
    expect((await post({ invitee_name: "x", role: "KITCHEN_CREW", outlet_ids: [randomUUID()], request_id: randomUUID() })).status).toBe(400);
    expect((await post({ invitee_name: "x", role: "OWNER" })).status).toBe(400);
    expect((await post({ invitee_name: "x", role: "OWNER", expires_in_days: 31, request_id: randomUUID() })).status).toBe(400);
  });

  it("the list shows the token again only while a link is active", async () => {
    const link = await makeLink({ invitee_name: "Lister" });
    await asOwner(request(app).post(`/api/v1/admin/join-links/${link.id}/revoke`));
    const list = await asOwner(request(app).get("/api/v1/admin/join-links"));
    const row = (list.body as { id: string; status: string; token: string | null }[]).find((l) => l.id === link.id);
    expect(row).toMatchObject({ status: "revoked", token: null });
  });
});

describe("joining with a link", () => {
  it("preview shows the workspace and role; a forged or tampered token does not", async () => {
    const link = await makeLink({ invitee_name: "Preview Person" });
    const ok = await request(app).post("/api/v1/auth/join/preview").send({ token: link.token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ workspaceName: "CloudKitchen", role: "OWNER", inviteeName: "Preview Person" });

    const tampered = link.token.slice(0, -2) + (link.token.endsWith("AA") ? "BB" : "AA");
    for (const token of [tampered, `${randomUUID()}.${link.token.split(".")[1]}`, "garbage", link.id]) {
      const res = await request(app).post("/api/v1/auth/join/preview").send({ token });
      expect(res.status, token).toBe(410);
    }
  });

  it("any verified Google account joins as the link's role; outlets are granted; the account is linked to Clerk", async () => {
    const link = await makeLink({ invitee_name: "New Cook", role: "KITCHEN_CREW", outlet_ids: [outletId] });
    clerkState.emails.set("user_newcook", "New.Cook@Gmail.com");

    // Before joining, ORION refuses this Google account and points to a join link.
    const before = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer clerk:user_newcook");
    expect(before.status).toBe(403);
    expect(before.body.error.message).toContain("join link");

    const res = await join(link.token, "user_newcook");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ ok: true, role: "KITCHEN_CREW" });

    const [user] = await db.select().from(users).where(eq(users.clerkUserId, "user_newcook"));
    expect(user).toMatchObject({ name: "New Cook", email: "new.cook@gmail.com", role: "KITCHEN_CREW", status: "ACTIVE" });
    const access = await db.select().from(userOutletAccess).where(eq(userOutletAccess.userId, user!.id));
    expect(access.map((a) => a.locationId)).toEqual([outletId]);
    const [membership] = await db.select().from(memberships).where(eq(memberships.userId, user!.id));
    expect(membership).toMatchObject({ tenantId: WORKSPACE_ONE_ID, role: "KITCHEN_CREW" });

    const me = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer clerk:user_newcook");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ role: "KITCHEN_CREW", outlet_ids: [outletId] });

    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.join_link.redeem"));
    expect(entry).toBeDefined();
  });

  it("an OWNER link makes the person an owner (Sir BJ's path)", async () => {
    const link = await makeLink({ invitee_name: "Sir BJ" });
    clerkState.emails.set("user_bj", "bj.owner@gmail.com");
    expect((await join(link.token, "user_bj")).status).toBe(201);
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer clerk:user_bj");
    expect(me.body.user).toMatchObject({ role: "OWNER", outlet_scope: "ALL" });
    const admin = await request(app).get("/api/v1/admin/users").set("Authorization", "Bearer clerk:user_bj");
    expect(admin.status).toBe(200);
  });

  it("a link works once: the same person replays as success, anyone else gets LINK_INVALID", async () => {
    const link = await makeLink({ invitee_name: "Once Only", role: "HR" });
    clerkState.emails.set("user_once", "once.only@gmail.com");
    clerkState.emails.set("user_second", "second.person@gmail.com");
    expect((await join(link.token, "user_once")).status).toBe(201);
    const replay = await join(link.token, "user_once");
    expect(replay.status).toBe(200);
    const other = await join(link.token, "user_second");
    expect(other.status).toBe(410);
    expect(other.body.error.code).toBe("LINK_INVALID");
    expect(await db.select().from(users).where(eq(users.clerkUserId, "user_second"))).toHaveLength(0);
  });

  it("concurrent redeems of one link by the same person create one account", async () => {
    const link = await makeLink({ invitee_name: "Racer", role: "ACCOUNTING" });
    clerkState.emails.set("user_racer", "racer@gmail.com");
    const results = await Promise.all([0, 1, 2].map(() => join(link.token, "user_racer")));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await db.select().from(users).where(eq(users.clerkUserId, "user_racer"))).toHaveLength(1);
  });

  it("concurrent redeems of one link by two different people: exactly one gets in", async () => {
    const link = await makeLink({ invitee_name: "Contested", role: "PURCHASING" });
    clerkState.emails.set("user_c1", "contest.one@gmail.com");
    clerkState.emails.set("user_c2", "contest.two@gmail.com");
    const [a, b] = await Promise.all([join(link.token, "user_c1"), join(link.token, "user_c2")]);
    expect([a.status, b.status].sort()).toEqual([201, 410]);
    const [row] = await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.id, link.id));
    expect(row!.usedByUserId).not.toBeNull();
  });

  it("someone already in ORION cannot use a link (and does not spend it)", async () => {
    const first = await makeLink({ invitee_name: "Member" , role: "HR" });
    clerkState.emails.set("user_member", "member@gmail.com");
    expect((await join(first.token, "user_member")).status).toBe(201);
    const second = await makeLink({ invitee_name: "Second Role" });
    const res = await join(second.token, "user_member");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_MEMBER");
    const [row] = await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.id, second.id));
    expect(row!.usedAt).toBeNull();
  });

  it("an email that is already an ORION user cannot be taken over through a link", async () => {
    const link = await makeLink({ invitee_name: "Hijacker" });
    // The seeded owner's email, claimed by a different Clerk account.
    clerkState.emails.set("user_hijack", "admin@cloudkitchen.local");
    const res = await join(link.token, "user_hijack");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_ADDED");
    const [owner] = await db.select().from(users).where(eq(users.email, "admin@cloudkitchen.local"));
    expect(owner!.clerkUserId).toBeNull();
    const [row] = await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.id, link.id));
    expect(row!.usedAt).toBeNull();
  });

  it("unverified email, no Clerk session, Clerk unreachable and Clerk off are all refused", async () => {
    const link = await makeLink({ invitee_name: "Edge Cases" });
    clerkState.emails.set("user_unverified", null);
    expect((await join(link.token, "user_unverified")).body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await request(app).post("/api/v1/auth/join").send({ token: link.token })).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/join").set("Authorization", "Bearer not-a-clerk-token").send({ token: link.token })).status).toBe(401);
    clerkState.emails.set("user_down", "down@gmail.com");
    clerkState.unreachable = true;
    expect((await join(link.token, "user_down")).status).toBe(503);
    clerkState.unreachable = false;
    clerkState.enabled = false;
    expect((await join(link.token, "user_down")).status).toBe(404);
    clerkState.enabled = true;
    const [row] = await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.id, link.id));
    expect(row!.usedAt).toBeNull();
  });

  it("revoked and expired links cannot be used; revoking a used link is refused", async () => {
    clerkState.emails.set("user_late", "late@gmail.com");
    const revoked = await makeLink({ invitee_name: "Revoked" });
    const rv = await asOwner(request(app).post(`/api/v1/admin/join-links/${revoked.id}/revoke`));
    expect(rv.status).toBe(200);
    expect((await asOwner(request(app).post(`/api/v1/admin/join-links/${revoked.id}/revoke`))).status).toBe(200); // repeat = no-op
    expect((await join(revoked.token, "user_late")).status).toBe(410);

    const expired = await makeLink({ invitee_name: "Expired" });
    await db
      .update(workspaceJoinLinks)
      .set({ createdAt: new Date(Date.now() - 10 * 86_400_000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceJoinLinks.id, expired.id));
    expect((await join(expired.token, "user_late")).status).toBe(410);
    expect((await request(app).post("/api/v1/auth/join/preview").send({ token: expired.token })).status).toBe(410);

    const used = await makeLink({ invitee_name: "Used", role: "HR" });
    expect((await join(used.token, "user_late")).status).toBe(201);
    const late = await asOwner(request(app).post(`/api/v1/admin/join-links/${used.id}/revoke`));
    expect(late.status).toBe(409);
  });
});
