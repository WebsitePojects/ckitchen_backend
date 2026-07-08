/**
 * Admin module (W5) — OWNER-only user management + role→page access matrix.
 *
 * Every route is `requireAuth, requireRole("OWNER")` and every mutation is
 * audited via `audit()` with the actor derived from the verified JWT (req.user),
 * never from the request body (anti-spoof — security.md).
 *
 * Endpoints (mounted under /api/v1):
 *   GET    /admin/users                     — list users (+ outlet/brand ids, last login)
 *   POST   /admin/users                     — create user (+ optional outlet access)
 *   PATCH  /admin/users/:id                 — update name/email/role
 *   POST   /admin/users/:id/reset-password  — set new password, revoke sessions
 *   POST   /admin/users/:id/block           — block + revoke sessions
 *   POST   /admin/users/:id/unblock         — unblock (fresh login required)
 *   PUT    /admin/users/:id/outlets         — replace outlet access rows
 *   GET    /admin/users/:id/activity        — that user's recent audit rows
 *   GET    /admin/users/:id/performance     — activity summary + outlet comparison (client point 8)
 *   GET    /admin/rbac                       — full role→page matrix
 *   PUT    /admin/rbac                       — upsert matrix entries
 *
 * Production lockout guards: an OWNER may not block or demote themselves, nor
 * block/demote the LAST remaining active OWNER (409 LAST_OWNER). Active-OWNER
 * count is computed defensively in JS so legacy v1 `SUPER_ADMIN` rows (which
 * normalize to OWNER) are counted too.
 */
import { Router } from "express";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  auditLogs,
  brands,
  locations,
  orders,
  rolePageAccess,
  userBrands,
  userOutletAccess,
  userSessions,
  users,
  type Role,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { normalizeRole, V2_ROLES } from "../auth/roles.js";
import { hashPassword } from "../auth/service.js";
import { audit } from "../ems/audit.js";
import { paramAsString, sendError } from "../http-errors.js";
import {
  MATRIX_ROLES,
  OWNER_PROTECTED_PAGES,
  PAGE_KEYS,
  defaultAllowed,
} from "./rbac-defaults.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(V2_ROLES),
  password: z.string().min(8),
  outlet_ids: z.array(z.string().uuid()).optional(),
});

const patchUserSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.enum(V2_ROLES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

const resetPasswordSchema = z.object({ password: z.string().min(8) });

const outletsSchema = z.object({ outlet_ids: z.array(z.string().uuid()) });

const rbacPutSchema = z
  .array(
    z.object({
      role: z.enum(V2_ROLES),
      pageKey: z.enum(PAGE_KEYS as [string, ...string[]]),
      allowed: z.boolean(),
    }),
  )
  .min(1);

const performanceQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Performance report date-range resolution (mirrors reports/routes.ts
// currentMonthRange/resolveRange — same "default to current UTC calendar
// month" convention, reimplemented locally since that module isn't exported
// for reuse and this route only touches src/modules/admin/*).
// ---------------------------------------------------------------------------

function currentMonthRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { from, to };
}

/** Resolves { from, to } from optional query strings; null means invalid/unparseable/inverted. */
function resolvePerformanceRange(from: string | undefined, to: string | undefined): { from: Date; to: Date } | null {
  const defaults = currentMonthRange();
  const fromDate = from ? new Date(from) : defaults.from;
  const toDate = to ? new Date(to) : defaults.to;
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;
  if (fromDate.getTime() > toDate.getTime()) return null;
  return { from: fromDate, to: toDate };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips password_hash before returning a user over the wire. */
function toPublicUser(user: typeof users.$inferSelect) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

/** True if the (possibly v1) role normalizes to OWNER. */
function isOwnerRole(role: string): boolean {
  return normalizeRole(role) === "OWNER";
}

/**
 * Counts users who are BOTH active AND resolve to OWNER (defensive: normalizes
 * each role so a legacy SUPER_ADMIN row still counts as an owner). Read straight
 * from the users table so it reflects committed state at call time.
 */
async function countActiveOwners(db: DB): Promise<number> {
  const rows = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.status, "ACTIVE"));
  return rows.filter((r) => isOwnerRole(r.role)).length;
}

/** Revokes a user's live sessions (sets logoutAt on open rows) — requireAuth then kills their tokens. */
async function revokeSessions(db: DB, userId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ logoutAt: new Date() })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.logoutAt)));
}

// ---------------------------------------------------------------------------
// RBAC seeder (idempotent) — materializes every (v2 role, page) pair.
// ---------------------------------------------------------------------------

/**
 * Seeds the role_page_access matrix from {@link defaultAllowed}. Idempotent:
 * onConflictDoNothing on (role, pageKey) so re-running never clobbers an admin's
 * later edits. Safe to call from the seed script and from test setup.
 */
export async function seedRolePageAccess(db: DB): Promise<void> {
  const rows: { role: Role; pageKey: string; allowed: boolean }[] = [];
  for (const role of MATRIX_ROLES) {
    for (const pageKey of PAGE_KEYS) {
      rows.push({ role, pageKey, allowed: defaultAllowed(role, pageKey) });
    }
  }
  if (rows.length === 0) return;
  await db
    .insert(rolePageAccess)
    .values(rows)
    .onConflictDoNothing({ target: [rolePageAccess.role, rolePageAccess.pageKey] });
}

// ---------------------------------------------------------------------------
// RBAC matrix read — merges in code defaults for any (role, pageKey) pair the
// table doesn't have a row for yet. This is the SAME "fall back to
// rbac-defaults when the DB doesn't know about it yet" convention already used
// by GET /me/permissions (see me/routes.ts) — extended from whole-role
// granularity to per-cell granularity, because a role can easily have SOME
// rows (from an earlier seed) but be missing a page added to PAGE_ROLES
// afterward (e.g. a new page shipped after go-live). Persisted rows always
// win; only genuinely-missing cells are synthesized, so this never masks an
// admin's deliberate edit.
// ---------------------------------------------------------------------------

async function loadRbacEntries(
  db: DB,
): Promise<{ role: Role; pageKey: string; allowed: boolean }[]> {
  const rows = await db
    .select({
      role: rolePageAccess.role,
      pageKey: rolePageAccess.pageKey,
      allowed: rolePageAccess.allowed,
    })
    .from(rolePageAccess);

  const present = new Set(rows.map((r) => `${r.role} ${r.pageKey}`));
  const merged = [...rows];
  for (const role of MATRIX_ROLES) {
    for (const pageKey of PAGE_KEYS) {
      if (!present.has(`${role} ${pageKey}`)) {
        merged.push({ role, pageKey, allowed: defaultAllowed(role, pageKey) });
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(db: DB): Router {
  const router = Router();

  // Every admin route is OWNER-only.
  router.use("/admin", requireAuth, requireRole("OWNER"));

  // ── GET /admin/users ──────────────────────────────────────────────────────
  router.get("/admin/users", async (_req, res) => {
    const userRows = await db.select().from(users);

    // Batch the per-user relations, stitch in JS (small cardinality).
    const [sessions, access, brands] = await Promise.all([
      db.select({ userId: userSessions.userId, loginAt: userSessions.loginAt }).from(userSessions),
      db
        .select({ userId: userOutletAccess.userId, locationId: userOutletAccess.locationId })
        .from(userOutletAccess),
      db.select({ userId: userBrands.userId, brandId: userBrands.brandId }).from(userBrands),
    ]);

    const lastLogin = new Map<string, Date>();
    for (const s of sessions) {
      if (!s.loginAt) continue;
      const prev = lastLogin.get(s.userId);
      if (!prev || s.loginAt > prev) lastLogin.set(s.userId, s.loginAt);
    }
    const outletsByUser = new Map<string, string[]>();
    for (const a of access) {
      const arr = outletsByUser.get(a.userId) ?? [];
      arr.push(a.locationId);
      outletsByUser.set(a.userId, arr);
    }
    const brandsByUser = new Map<string, string[]>();
    for (const b of brands) {
      const arr = brandsByUser.get(b.userId) ?? [];
      arr.push(b.brandId);
      brandsByUser.set(b.userId, arr);
    }

    const result = userRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      lastLoginAt: lastLogin.get(u.id) ?? null,
      outletIds: outletsByUser.get(u.id) ?? [],
      brandIds: brandsByUser.get(u.id) ?? [],
    }));

    res.json(result);
  });

  // ── POST /admin/users ─────────────────────────────────────────────────────
  router.post("/admin/users", async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid user payload.", parsed.error.issues);
      return;
    }
    const { name, email, role, password, outlet_ids } = parsed.data;

    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (dup) {
      sendError(res, 409, "CONFLICT", `A user with email ${email} already exists.`);
      return;
    }

    // Validate outlet ids up front (before creating the user) so a bad id fails clean.
    if (outlet_ids && outlet_ids.length > 0) {
      const found = await db
        .select({ id: locations.id })
        .from(locations)
        .where(inArray(locations.id, outlet_ids));
      if (found.length !== new Set(outlet_ids).size) {
        sendError(res, 400, "VALIDATION_ERROR", "One or more outlet_ids do not exist.");
        return;
      }
    }

    const passwordHash = await hashPassword(password);
    let created: typeof users.$inferSelect | undefined;
    await db.transaction(async (tx) => {
      [created] = await tx
        .insert(users)
        .values({ name, email, passwordHash, role })
        .returning();
      if (outlet_ids && outlet_ids.length > 0) {
        await tx
          .insert(userOutletAccess)
          .values([...new Set(outlet_ids)].map((locationId) => ({ userId: created!.id, locationId })));
      }
    });

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.create",
      description: `Created user ${name} <${email}> as ${role}`,
      entityType: "user",
      entityId: created!.id,
      metadata: { role, outletIds: outlet_ids ?? [] },
    });

    res.status(201).json(toPublicUser(created!));
  });

  // ── PATCH /admin/users/:id ────────────────────────────────────────────────
  router.patch("/admin/users/:id", async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = patchUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid user payload.", parsed.error.issues);
      return;
    }

    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    // Lockout guard on role demotion away from OWNER.
    if (parsed.data.role !== undefined) {
      const demotingFromOwner = isOwnerRole(target.role) && parsed.data.role !== "OWNER";
      if (demotingFromOwner) {
        if (target.status === "ACTIVE" && (await countActiveOwners(db)) <= 1) {
          sendError(res, 409, "LAST_OWNER", "Cannot demote the last active OWNER.");
          return;
        }
        if (target.id === req.user!.id) {
          sendError(res, 409, "SELF_ACTION", "You cannot change your own OWNER role.");
          return;
        }
      }
    }

    if (parsed.data.email !== undefined && parsed.data.email !== target.email) {
      const [dup] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, parsed.data.email));
      if (dup && dup.id !== id) {
        sendError(res, 409, "CONFLICT", `A user with email ${parsed.data.email} already exists.`);
        return;
      }
    }

    const updates: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.email !== undefined) updates.email = parsed.data.email;
    if (parsed.data.role !== undefined) updates.role = parsed.data.role;

    const [updated] = await db.update(users).set(updates).where(eq(users.id, id)).returning();

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.update",
      description: `Updated user ${updated.email}`,
      entityType: "user",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
    });

    res.json(toPublicUser(updated));
  });

  // ── POST /admin/users/:id/reset-password ──────────────────────────────────
  router.post("/admin/users/:id/reset-password", async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = resetPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 8 characters.", parsed.error.issues);
      return;
    }

    const [target] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
    await revokeSessions(db, id); // old logins die immediately

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.reset_password",
      description: `Reset password for ${target.email}`,
      entityType: "user",
      entityId: id,
    });

    res.json({ ok: true });
  });

  // ── POST /admin/users/:id/block ───────────────────────────────────────────
  router.post("/admin/users/:id/block", async (req, res) => {
    const id = paramAsString(req.params.id);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    // Lockout guards. LAST_OWNER checked first so blocking the sole owner (which
    // is necessarily yourself) surfaces the more specific reason.
    if (isOwnerRole(target.role) && target.status === "ACTIVE" && (await countActiveOwners(db)) <= 1) {
      sendError(res, 409, "LAST_OWNER", "Cannot block the last active OWNER.");
      return;
    }
    if (target.id === req.user!.id) {
      sendError(res, 409, "SELF_ACTION", "You cannot block your own account.");
      return;
    }

    const [updated] = await db
      .update(users)
      .set({ status: "BLOCKED", updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    await revokeSessions(db, id); // kill live tokens now

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.block",
      description: `Blocked user ${updated.email}`,
      entityType: "user",
      entityId: id,
    });

    res.json(toPublicUser(updated));
  });

  // ── POST /admin/users/:id/unblock ─────────────────────────────────────────
  router.post("/admin/users/:id/unblock", async (req, res) => {
    const id = paramAsString(req.params.id);
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    const [updated] = await db
      .update(users)
      .set({ status: "ACTIVE", updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.unblock",
      description: `Unblocked user ${updated.email}`,
      entityType: "user",
      entityId: id,
    });

    res.json(toPublicUser(updated));
  });

  // ── PUT /admin/users/:id/outlets ──────────────────────────────────────────
  router.put("/admin/users/:id/outlets", async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = outletsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "outlet_ids must be an array of UUIDs.", parsed.error.issues);
      return;
    }

    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    const outletIds = [...new Set(parsed.data.outlet_ids)];
    if (outletIds.length > 0) {
      const found = await db
        .select({ id: locations.id })
        .from(locations)
        .where(inArray(locations.id, outletIds));
      if (found.length !== outletIds.length) {
        sendError(res, 400, "VALIDATION_ERROR", "One or more outlet_ids do not exist.");
        return;
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(userOutletAccess).where(eq(userOutletAccess.userId, id));
      if (outletIds.length > 0) {
        await tx
          .insert(userOutletAccess)
          .values(outletIds.map((locationId) => ({ userId: id, locationId })));
      }
    });

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.set_outlets",
      description: `Set outlet access for user ${id}`,
      entityType: "user",
      entityId: id,
      metadata: { outletIds },
    });

    res.json({ userId: id, outletIds });
  });

  // ── GET /admin/users/:id/activity ─────────────────────────────────────────
  router.get("/admin/users/:id/activity", async (req, res) => {
    const id = paramAsString(req.params.id);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    res.json(rows);
  });

  // ── GET /admin/users/:id/performance ──────────────────────────────────────
  //
  // Client point 8: "reports about [a user's] accomplishment and done compared
  // to that outlet's performance." Summarizes one user's audited activity over
  // a date range (default current month) alongside the order volume/revenue of
  // the outlet(s) they're scoped to (userOutletAccess), so an OWNER can see a
  // user's output next to the outlet total it happened inside.
  router.get("/admin/users/:id/performance", async (req, res) => {
    const id = paramAsString(req.params.id);

    const parsedQuery = performanceQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsedQuery.error.issues);
      return;
    }

    const [target] = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, id));
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "User not found.");
      return;
    }

    const range = resolvePerformanceRange(parsedQuery.data.from, parsedQuery.data.to);
    if (!range) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid 'from'/'to' date, or 'from' after 'to'.");
      return;
    }
    const { from, to } = range;

    // Single query drives both `activity` (raw audit rows) and the
    // `ordersHandled` proxy below — no need to hit auditLogs twice.
    const activityRows = await db
      .select({ action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId })
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, id), gte(auditLogs.createdAt, from), lte(auditLogs.createdAt, to)));

    const byActionMap = new Map<string, number>();
    const advancedOrderIds = new Set<string>();
    for (const row of activityRows) {
      byActionMap.set(row.action, (byActionMap.get(row.action) ?? 0) + 1);

      // PROXY METRIC (documented, not fabricated): there is no first-class
      // "orders handled by user" fact anywhere in the schema. The closest
      // honest signal is the audit trail of `order.advance` actions (see
      // orders/routes.ts POST /orders/:id/advance), written once per stage
      // transition (NEW→PREPARING→READY→COMPLETED) with the acting user as
      // `actorUserId`. We count DISTINCT order ids, not raw action rows, so
      // an order this user pushed through two stages counts once — matching
      // "orders ... handled" rather than "handling actions taken". This does
      // NOT include `order.cancel` (a materially different outcome) and will
      // undercount any handling that never called /advance (e.g. an order
      // fully driven by the simulator).
      if (row.action === "order.advance" && row.entityType === "order" && row.entityId) {
        advancedOrderIds.add(row.entityId);
      }
    }
    const byAction = [...byActionMap.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);

    // Outlet scope: userOutletAccess is the source of truth for WHERE a user
    // may act (D22/D31). HQ/ALL-scope roles (OWNER, HR, ACCOUNTING,
    // WAREHOUSE_MAIN) may legitimately have zero rows here — reported as 0
    // orders/revenue rather than guessing "every outlet".
    const accessRows = await db
      .select({ locationId: userOutletAccess.locationId })
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, id));
    const locationIds = accessRows.map((r) => r.locationId);

    let outletOrders = 0;
    let outletRevenue = 0;
    if (locationIds.length > 0) {
      // Mirrors reports/service.ts's money convention (order.total, exact
      // numeric revenue field) but intentionally does NOT restrict to
      // COMPLETED-only like the sales report does — "outlet performance" here
      // means all real order volume/revenue in range, CANCELLED excluded per
      // the spec (never-realized orders shouldn't count toward performance).
      const [agg] = await db
        .select({
          ordersCount: sql<number>`count(${orders.id})`.mapWith(Number),
          revenue: sql<number>`coalesce(sum(${orders.total}::numeric), 0)`.mapWith(Number),
        })
        .from(orders)
        .innerJoin(brands, eq(brands.id, orders.brandId))
        .where(
          and(
            inArray(brands.locationId, locationIds),
            ne(orders.status, "CANCELLED"),
            gte(orders.placedAt, from),
            lte(orders.placedAt, to),
          ),
        );
      outletOrders = agg?.ordersCount ?? 0;
      outletRevenue = Math.round((agg?.revenue ?? 0) * 100) / 100;
    }

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.user.view_performance",
      description: `Viewed performance report for user ${id}`,
      entityType: "user",
      entityId: id,
      metadata: { from: from.toISOString(), to: to.toISOString() },
    });

    res.json({
      user: { id: target.id, name: target.name, role: target.role },
      period: { from: from.toISOString(), to: to.toISOString() },
      activity: { total: activityRows.length, byAction },
      ordersHandled: advancedOrderIds.size,
      outlet: { locationIds, orders: outletOrders, revenue: outletRevenue },
    });
  });

  // ── GET /admin/rbac ───────────────────────────────────────────────────────
  router.get("/admin/rbac", async (_req, res) => {
    const entries = await loadRbacEntries(db);
    res.json({ roles: MATRIX_ROLES, pages: PAGE_KEYS, entries });
  });

  // ── PUT /admin/rbac ───────────────────────────────────────────────────────
  router.put("/admin/rbac", async (req, res) => {
    const parsed = rbacPutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Body must be a non-empty array of {role, pageKey, allowed}.", parsed.error.issues);
      return;
    }

    // Fail-closed: never let the matrix strip OWNER's access to the admin pages.
    for (const e of parsed.data) {
      if (e.role === "OWNER" && e.allowed === false && OWNER_PROTECTED_PAGES.includes(e.pageKey)) {
        sendError(
          res,
          409,
          "OWNER_LOCKED",
          `OWNER must always retain access to ${OWNER_PROTECTED_PAGES.join(", ")}.`,
        );
        return;
      }
    }

    const now = new Date();
    for (const e of parsed.data) {
      await db
        .insert(rolePageAccess)
        .values({ role: e.role as Role, pageKey: e.pageKey, allowed: e.allowed, updatedAt: now })
        .onConflictDoUpdate({
          target: [rolePageAccess.role, rolePageAccess.pageKey],
          set: { allowed: e.allowed, updatedAt: now },
        });
    }

    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.rbac.update",
      description: `Updated ${parsed.data.length} role→page access entr${parsed.data.length === 1 ? "y" : "ies"}`,
      entityType: "role_page_access",
      metadata: { count: parsed.data.length },
    });

    const entries = await loadRbacEntries(db);
    res.json({ roles: MATRIX_ROLES, pages: PAGE_KEYS, entries });
  });

  return router;
}
