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
 *   GET    /admin/rbac                       — full role→page matrix
 *   PUT    /admin/rbac                       — upsert matrix entries
 *
 * Production lockout guards: an OWNER may not block or demote themselves, nor
 * block/demote the LAST remaining active OWNER (409 LAST_OWNER). Active-OWNER
 * count is computed defensively in JS so legacy v1 `SUPER_ADMIN` rows (which
 * normalize to OWNER) are counted too.
 */
import { Router } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  auditLogs,
  locations,
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

  // ── GET /admin/rbac ───────────────────────────────────────────────────────
  router.get("/admin/rbac", async (_req, res) => {
    const entries = await db
      .select({
        role: rolePageAccess.role,
        pageKey: rolePageAccess.pageKey,
        allowed: rolePageAccess.allowed,
      })
      .from(rolePageAccess);
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

    const entries = await db
      .select({
        role: rolePageAccess.role,
        pageKey: rolePageAccess.pageKey,
        allowed: rolePageAccess.allowed,
      })
      .from(rolePageAccess);
    res.json({ roles: MATRIX_ROLES, pages: PAGE_KEYS, entries });
  });

  return router;
}
