/**
 * Employee system access and performance (D58).
 *
 * An employee is either a SYSTEM_USER (employee.user_id links a login) or STAFF_ONLY (no
 * login). Both clock in and out the same way; what differs is how their performance is
 * known:
 *   - a system user's work leaves an audit trail (orders advanced, approvals, sessions);
 *   - everyone, with or without a login, can have manual notes written by owners/HR/managers.
 *
 * Endpoints (all under /api/v1):
 *   POST /employees/:id/link-user                  OWNER: link an existing login
 *   POST /employees/:id/unlink-user                OWNER: remove the link (login is kept)
 *   GET  /employees/:id/performance?month=YYYY-MM  readable: system activity + notes summary
 *   GET  /employees/:id/performance-notes          readable: the manual log, newest first
 *   POST /employees/:id/performance-notes          manager: add a note (client_request_id)
 *   POST /employees/:id/performance-notes/:noteId/void   manager: void a note with a reason
 *
 * Duplicate safety: link/unlink are conditional UPDATEs on the current link (a replay of the
 * same intent answers 200 with the current state; a different intent gets 409); a note is
 * one row per client_request_id; void is a conditional UPDATE on voided_at IS NULL.
 */
import { Router, type Request } from "express";
import { and, count, desc, eq, gte, isNull, lte, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  auditLogs,
  employeePerformanceNotes,
  employees,
  PERFORMANCE_NOTE_KINDS,
  userOutletAccess,
  userSessions,
  users,
} from "../../db/schema.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { sendError } from "../http-errors.js";
import { businessDateSql, localDate, localMonthRange } from "../business-time.js";
import { audit } from "./audit.js";
import { resolveManageableEmployee, resolveReadableEmployee } from "./employee-scope.js";

const EMPLOYEE_LOGIN_LINK_UNIQUE = "employee_user_link_unique";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const linkSchema = z.object({ user_id: z.string().uuid() }).strict();

const noteSchema = z
  .object({
    client_request_id: z.string().uuid(),
    kind: z.enum(PERFORMANCE_NOTE_KINDS),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().max(4000).nullable().optional(),
    occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "occurred_on must be YYYY-MM-DD"),
  })
  .strict();

const voidSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

function actorOf(req: Request) {
  return { actorUserId: req.user!.id, actorName: req.user!.name ?? null, sessionId: req.user!.sessionId ?? null };
}

function serializeNote(row: typeof employeePerformanceNotes.$inferSelect) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    rating: row.rating,
    title: row.title,
    body: row.body,
    occurredOn: String(row.occurredOn).slice(0, 10),
    recordedBy: { userId: row.recordedByUserId, name: row.recordedByName },
    createdAt: row.createdAt,
    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
  };
}

export function createEmployeeAccessRouter(db: DB): Router {
  const router = Router();

  /** Current link of one employee, read outside any transaction (race recovery). */
  async function currentLink(employeeId: string): Promise<string | null | undefined> {
    const [row] = await db.select({ userId: employees.userId }).from(employees).where(eq(employees.id, employeeId));
    return row ? row.userId : undefined;
  }

  // ── POST /employees/:id/link-user ─────────────────────────────────────────
  router.post("/employees/:id/link-user", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
      return;
    }
    const parsed = linkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Send { user_id }.", parsed.error.issues);
      return;
    }
    const userId = parsed.data.user_id;

    const [emp] = await db
      .select({ id: employees.id, userId: employees.userId, fullName: employees.fullName, locationId: employees.locationId })
      .from(employees)
      .where(eq(employees.id, id));
    if (!emp) {
      sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
      return;
    }
    if (emp.userId === userId) {
      res.json({ employeeId: id, userId, access: "SYSTEM_USER" });
      return;
    }
    if (emp.userId !== null) {
      sendError(res, 409, "ALREADY_LINKED", "This employee already has a login. Unlink it first.");
      return;
    }
    // Row-level security only shows logins that belong to this workspace (D55), so a user id
    // from another business is simply not found here.
    const [user] = await db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, userId));
    if (!user) {
      sendError(res, 404, "USER_NOT_FOUND", "No login with that id in this workspace.");
      return;
    }

    let linked = false;
    try {
      linked = await db.transaction(async (tx) => {
        const updated = await tx
          .update(employees)
          .set({ userId, updatedAt: new Date() })
          .where(and(eq(employees.id, id), isNull(employees.userId)))
          .returning({ id: employees.id });
        if (updated.length === 0) return false;
        if (emp.locationId) {
          await tx.insert(userOutletAccess).values({ userId, locationId: emp.locationId }).onConflictDoNothing();
        }
        await audit(tx as unknown as DB, {
          ...actorOf(req),
          action: "employee.login.link",
          description: `Linked ${emp.fullName} to the login <${user.email}> (${user.role})`,
          entityType: "employee",
          entityId: id,
          metadata: { userId },
        });
        return true;
      });
    } catch (err) {
      if (isUniqueViolation(err, EMPLOYEE_LOGIN_LINK_UNIQUE)) {
        sendError(res, 409, "USER_ALREADY_LINKED", "That login already belongs to another employee.");
        return;
      }
      throw err;
    }

    if (!linked) {
      // Lost a race: a concurrent request changed the link first. Same intent = replay.
      if ((await currentLink(id)) === userId) {
        res.json({ employeeId: id, userId, access: "SYSTEM_USER" });
        return;
      }
      sendError(res, 409, "ALREADY_LINKED", "This employee already has a login. Unlink it first.");
      return;
    }
    res.json({ employeeId: id, userId, access: "SYSTEM_USER" });
  });

  // ── POST /employees/:id/unlink-user ───────────────────────────────────────
  // Body names the login being removed, so a stale screen cannot unlink a login that was
  // linked after it loaded. The login itself stays: blocking it is a separate, explicit
  // action in Users & Roles.
  router.post("/employees/:id/unlink-user", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
      return;
    }
    const parsed = linkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Send { user_id } of the login to unlink.", parsed.error.issues);
      return;
    }
    const userId = parsed.data.user_id;

    const [emp] = await db
      .select({ id: employees.id, userId: employees.userId, fullName: employees.fullName })
      .from(employees)
      .where(eq(employees.id, id));
    if (!emp) {
      sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
      return;
    }
    if (emp.userId === null) {
      res.json({ employeeId: id, userId: null, access: "STAFF_ONLY" });
      return;
    }
    if (emp.userId !== userId) {
      sendError(res, 409, "LINK_CHANGED", "This employee is linked to a different login now. Reload and try again.");
      return;
    }

    const unlinked = await db.transaction(async (tx) => {
      const updated = await tx
        .update(employees)
        .set({ userId: null, updatedAt: new Date() })
        .where(and(eq(employees.id, id), eq(employees.userId, userId)))
        .returning({ id: employees.id });
      if (updated.length === 0) return false;
      await audit(tx as unknown as DB, {
        ...actorOf(req),
        action: "employee.login.unlink",
        description: `Removed the login link from ${emp.fullName} (the login itself was kept)`,
        entityType: "employee",
        entityId: id,
        metadata: { userId },
      });
      return true;
    });

    if (!unlinked && (await currentLink(id)) !== null) {
      sendError(res, 409, "LINK_CHANGED", "This employee is linked to a different login now. Reload and try again.");
      return;
    }
    res.json({ employeeId: id, userId: null, access: "STAFF_ONLY" });
  });

  // ── GET /employees/:id/performance?month=YYYY-MM ──────────────────────────
  // Attendance for the month lives in GET /employees/:id/profile; this adds what attendance
  // cannot show. Every number is an aggregate in SQL, never a row dump.
  router.get("/employees/:id/performance", requireAuth, resolveOutletContext, async (req, res) => {
    const month = (req.query.month as string | undefined) ?? localDate().slice(0, 7);
    const m = MONTH_RE.exec(month);
    if (!m) {
      sendError(res, 400, "VALIDATION_ERROR", "month must be YYYY-MM.");
      return;
    }
    const emp = await resolveReadableEmployee(db, req, res, req.params.id as string, 404);
    if (!emp) return;
    const { start, end } = localMonthRange(Number(m[1]), Number(m[2]));

    const notesPromise = db
      .select({
        kind: employeePerformanceNotes.kind,
        total: count(),
        ratedCount: count(employeePerformanceNotes.rating),
        ratingSum: sql<string | null>`sum(${employeePerformanceNotes.rating})`,
      })
      .from(employeePerformanceNotes)
      .where(
        and(
          eq(employeePerformanceNotes.employeeId, emp.id),
          isNull(employeePerformanceNotes.voidedAt),
          gte(employeePerformanceNotes.occurredOn, `${month}-01`),
          lte(employeePerformanceNotes.occurredOn, lastDayOf(month)),
        ),
      )
      .groupBy(employeePerformanceNotes.kind);

    const systemPromise = emp.userId ? systemSummary(db, emp.userId, start, end) : Promise.resolve(null);
    const [noteRows, system] = await Promise.all([notesPromise, systemPromise]);

    const byKind = Object.fromEntries(PERFORMANCE_NOTE_KINDS.map((k) => [k, 0])) as Record<string, number>;
    let total = 0;
    let ratedCount = 0;
    let ratingSum = 0;
    for (const row of noteRows) {
      byKind[row.kind] = Number(row.total);
      total += Number(row.total);
      ratedCount += Number(row.ratedCount);
      ratingSum += Number(row.ratingSum ?? 0);
    }

    res.json({
      employee: { id: emp.id, fullName: emp.fullName, access: emp.userId ? "SYSTEM_USER" : "STAFF_ONLY" },
      period: { month, from: start.toISOString(), to: end.toISOString() },
      system,
      notes: {
        total,
        byKind,
        ratedCount,
        averageRating: ratedCount > 0 ? Math.round((ratingSum / ratedCount) * 10) / 10 : null,
      },
    });
  });

  // ── GET /employees/:id/performance-notes ──────────────────────────────────
  router.get("/employees/:id/performance-notes", requireAuth, resolveOutletContext, async (req, res) => {
    const emp = await resolveReadableEmployee(db, req, res, req.params.id as string, 404);
    if (!emp) return;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const includeVoided = req.query.include_voided === "true";

    const rows = await db
      .select()
      .from(employeePerformanceNotes)
      .where(
        includeVoided
          ? eq(employeePerformanceNotes.employeeId, emp.id)
          : and(eq(employeePerformanceNotes.employeeId, emp.id), isNull(employeePerformanceNotes.voidedAt)),
      )
      .orderBy(desc(employeePerformanceNotes.occurredOn), desc(employeePerformanceNotes.createdAt))
      .limit(limit);
    res.json(rows.map(serializeNote));
  });

  // ── POST /employees/:id/performance-notes ─────────────────────────────────
  router.post("/employees/:id/performance-notes", requireAuth, resolveOutletContext, async (req, res) => {
    const parsed = noteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid performance note.", parsed.error.issues);
      return;
    }
    const emp = await resolveManageableEmployee(db, req, res, req.params.id as string);
    if (!emp) return;
    const note = parsed.data;
    if (note.occurred_on > localDate()) {
      sendError(res, 400, "VALIDATION_ERROR", "occurred_on cannot be in the future.");
      return;
    }

    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(employeePerformanceNotes)
        .values({
          employeeId: emp.id,
          kind: note.kind,
          rating: note.rating ?? null,
          title: note.title,
          body: note.body ?? null,
          occurredOn: note.occurred_on,
          clientRequestId: note.client_request_id,
          recordedByUserId: req.user!.id,
          recordedByName: req.user!.name ?? null,
        })
        .onConflictDoNothing({
          target: [employeePerformanceNotes.tenantId, employeePerformanceNotes.clientRequestId],
        })
        .returning();
      if (!row) return null;
      await audit(tx as unknown as DB, {
        ...actorOf(req),
        action: "employee.performance_note.create",
        description: `Recorded a ${note.kind.toLowerCase()} for ${emp.fullName}: ${note.title}`,
        entityType: "employee",
        entityId: emp.id,
        metadata: { noteId: row.id, kind: note.kind, rating: note.rating ?? null },
      });
      return row;
    });

    if (inserted) {
      res.status(201).json(serializeNote(inserted));
      return;
    }
    // Replay of the same intent: answer with the note it already created.
    const [existing] = await db
      .select()
      .from(employeePerformanceNotes)
      .where(eq(employeePerformanceNotes.clientRequestId, note.client_request_id));
    if (!existing || existing.employeeId !== emp.id) {
      sendError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This client_request_id was already used for another note.");
      return;
    }
    res.status(200).json(serializeNote(existing));
  });

  // ── POST /employees/:id/performance-notes/:noteId/void ────────────────────
  router.post("/employees/:id/performance-notes/:noteId/void", requireAuth, resolveOutletContext, async (req, res) => {
    const noteId = req.params.noteId as string;
    if (!UUID_RE.test(noteId)) {
      sendError(res, 404, "NOT_FOUND", `Note ${noteId} not found.`);
      return;
    }
    const parsed = voidSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Give a reason (at least 3 characters).", parsed.error.issues);
      return;
    }
    const emp = await resolveManageableEmployee(db, req, res, req.params.id as string);
    if (!emp) return;

    const voided = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(employeePerformanceNotes)
        .set({ voidedAt: new Date(), voidedByUserId: req.user!.id, voidReason: parsed.data.reason })
        .where(
          and(
            eq(employeePerformanceNotes.id, noteId),
            eq(employeePerformanceNotes.employeeId, emp.id),
            isNull(employeePerformanceNotes.voidedAt),
          ),
        )
        .returning();
      if (!row) return null;
      await audit(tx as unknown as DB, {
        ...actorOf(req),
        action: "employee.performance_note.void",
        description: `Voided the note "${row.title}" on ${emp.fullName}: ${parsed.data.reason}`,
        entityType: "employee",
        entityId: emp.id,
        metadata: { noteId },
      });
      return row;
    });
    if (voided) {
      res.json(serializeNote(voided));
      return;
    }

    const [existing] = await db
      .select()
      .from(employeePerformanceNotes)
      .where(and(eq(employeePerformanceNotes.id, noteId), eq(employeePerformanceNotes.employeeId, emp.id)));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", `Note ${noteId} not found.`);
      return;
    }
    // Already voided (a double click, or someone else first): the note's current state.
    res.json(serializeNote(existing));
  });

  return router;
}

/** Last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
function lastDayOf(month: string): string {
  const [y, mo] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/**
 * What a login's audit trail says about one month. "Orders handled" counts DISTINCT orders
 * this person advanced a stage (order.advance), the same proxy as the admin report: there
 * is no first-class "handled by" fact, and an order pushed through three stages counts once.
 */
async function systemSummary(db: DB, userId: string, start: Date, end: Date) {
  const inMonth = and(eq(auditLogs.actorUserId, userId), gte(auditLogs.createdAt, start), lte(auditLogs.createdAt, end));
  const [account, totals, byAction, recent, sessions, lastActive] = await Promise.all([
    db.select({ id: users.id, email: users.email, role: users.role, status: users.status }).from(users).where(eq(users.id, userId)),
    db
      .select({
        total: count(),
        ordersHandled: sql<string>`count(distinct ${auditLogs.entityId}) filter (where ${auditLogs.action} = 'order.advance' and ${auditLogs.entityType} = 'order')`,
        activeDays: sql<string>`count(distinct ${businessDateSql(sql`${auditLogs.createdAt}`)})`,
      })
      .from(auditLogs)
      .where(inMonth),
    db
      .select({ action: auditLogs.action, count: count() })
      .from(auditLogs)
      .where(inMonth)
      .groupBy(auditLogs.action)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({ id: auditLogs.id, action: auditLogs.action, description: auditLogs.description, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(inMonth)
      .orderBy(desc(auditLogs.createdAt))
      .limit(15),
    db
      .select({ total: count() })
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), gte(userSessions.loginAt, start), lte(userSessions.loginAt, end))),
    db.select({ at: max(auditLogs.createdAt) }).from(auditLogs).where(eq(auditLogs.actorUserId, userId)),
  ]);

  return {
    user: account[0] ?? null,
    totalActions: Number(totals[0]?.total ?? 0),
    ordersHandled: Number(totals[0]?.ordersHandled ?? 0),
    activeDays: Number(totals[0]?.activeDays ?? 0),
    sessions: Number(sessions[0]?.total ?? 0),
    lastActiveAt: lastActive[0]?.at ?? null,
    byAction: byAction.map((r) => ({ action: r.action, count: Number(r.count) })),
    recent,
  };
}
