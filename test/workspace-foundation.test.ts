/**
 * SaaS step 1 (migration 0045): workspace tables exist, the existing business is workspace #1,
 * and every user has a matching workspace #1 membership that stays in sync with user.role /
 * user.status until step 6 makes membership the authority.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { memberships, tenants, tenantSettings, users, WORKSPACE_ONE_ID } from "../src/db/schema.js";

let db: DB;

const membershipOf = async (userId: string) =>
  (
    await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, WORKSPACE_ONE_ID), eq(memberships.userId, userId)))
  )[0];

const newUser = (email: string, role: "OWNER" | "KITCHEN_CREW" = "KITCHEN_CREW") =>
  db.insert(users).values({ name: "Test Person", email, passwordHash: "x", role }).returning();

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
});

describe("workspace #1", () => {
  it("exists with its fixed id, slug and default settings", async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, WORKSPACE_ONE_ID));
    expect(tenant).toMatchObject({ slug: "cloudkitchen", name: "CloudKitchen", status: "ACTIVE", clerkOrgId: null });
    const [settings] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, WORKSPACE_ONE_ID));
    expect(settings).toMatchObject({ timezone: "Asia/Manila", businessDayStartHour: 5, currency: "PHP" });
  });

  it("has a membership for every user, with the same role and status", async () => {
    const mismatched = await db.execute(sql`
      select u.id from "user" u
      left join membership m on m.user_id = u.id and m.tenant_id = ${WORKSPACE_ONE_ID}
      where m.id is null or m.role <> u.role or m.status <> u.status`);
    const rows = Array.isArray(mismatched) ? mismatched : (mismatched as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(0);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    expect(count).toBeGreaterThan(0);
  });
});

describe("membership mirror (transitional, until step 6)", () => {
  it("creates the membership when a user is created by any write path", async () => {
    const [user] = await newUser("mirror-new@example.ph");
    expect(await membershipOf(user.id)).toMatchObject({ role: "KITCHEN_CREW", status: "ACTIVE", authzVersion: 1 });
  });

  it("follows a role change and a block, bumping authz_version each time", async () => {
    const [user] = await newUser("mirror-change@example.ph");
    await db.update(users).set({ role: "OUTLET_MANAGER" }).where(eq(users.id, user.id));
    expect(await membershipOf(user.id)).toMatchObject({ role: "OUTLET_MANAGER", authzVersion: 2 });
    await db.update(users).set({ status: "BLOCKED" }).where(eq(users.id, user.id));
    expect(await membershipOf(user.id)).toMatchObject({ status: "BLOCKED", authzVersion: 3 });
  });

  it("does not bump authz_version when nothing relevant changed", async () => {
    const [user] = await newUser("mirror-noop@example.ph");
    await db.update(users).set({ name: "Renamed" }).where(eq(users.id, user.id));
    await db.update(users).set({ role: "KITCHEN_CREW" }).where(eq(users.id, user.id));
    expect(await membershipOf(user.id)).toMatchObject({ authzVersion: 1 });
  });
});

describe("constraints", () => {
  it("accepts a well-formed slug and rejects bad ones", async () => {
    await db.insert(tenants).values({ slug: "bowl-co-2", name: "Bowl Co" });
    for (const slug of ["ab", "-bowl", "bowl-", "Bowl", "bowl co", "bowl_co", "b".repeat(41)]) {
      await expect(db.insert(tenants).values({ slug, name: "Bad Slug" })).rejects.toThrow();
    }
  });

  it("keeps slugs unique", async () => {
    await expect(db.insert(tenants).values({ slug: "cloudkitchen", name: "Copycat" })).rejects.toThrow();
  });

  it("allows one membership per person per workspace, but the same person in two workspaces", async () => {
    const [user] = await newUser("two-workspaces@example.ph", "OWNER");
    const [other] = await db.insert(tenants).values({ slug: "second-biz", name: "Second Biz" }).returning();
    await db.insert(memberships).values({ tenantId: other.id, userId: user.id, role: "KITCHEN_CREW" });
    await expect(
      db.insert(memberships).values({ tenantId: WORKSPACE_ONE_ID, userId: user.id, role: "OWNER" }),
    ).rejects.toThrow();
    const all = await db.select().from(memberships).where(eq(memberships.userId, user.id));
    expect(all.map((m) => m.role).sort()).toEqual(["KITCHEN_CREW", "OWNER"]);
  });
});
