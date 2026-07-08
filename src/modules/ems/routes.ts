/**
 * EMS Routes — CK1-EMS-005 (E1 + E2-core + E3 attendance/DTR)
 *
 * Endpoints:
 *   GET  /employees                          — list (filter status/department/location_id)
 *   POST /employees                          — create (OWNER, or OUTLET_MANAGER scoped to their outlet)
 *   PATCH /employees/:id                     — partial update (OWNER, or OUTLET_MANAGER scoped to their outlet)
 *   GET  /employees/:id/profile              — Employee 360 month calendar + stats
 *   GET  /audit                              — audit trail (SUPER_ADMIN/BRAND_MANAGER)
 *   GET  /ems/analytics/employee/:userId     — per-staff analytics (self or admin)
 *
 * E3 attendance (CK1-EMS-005 §3):
 *   POST /ems/attendance                     — record TIME_IN or TIME_OUT with Cloudinary photo
 *   GET  /ems/attendance                     — list (SUPER_ADMIN: all; others: need employee_id)
 *   GET  /ems/attendance/dtr                 — paired DTR view with worked_minutes
 */
import { Router, type Request, type Response } from "express";
import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  attendanceRecords,
  attendanceTypeEnum,
  auditLogs,
  departmentEnum,
  employeeStatusEnum,
  employees,
  locations,
  userSessions,
  users,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope, listScopeLocationIds, resolveRequestLocationId } from "../auth/outlet-scope.js";
import { normalizeRole } from "../auth/roles.js";
import { sendError } from "../http-errors.js";
import { pairDtrEntries, recordAttendancePunch, type DtrEntry } from "./attendance-shared.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// ── Work-days schedule (Employee 360) ──────────────────────────────────────
// Canonical Mon→Sun token order. `work_days` is stored as a CSV of these; the
// API always exposes it as a sanitized string[] (workDays).
const WORK_DAY_TOKENS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
type WorkDayToken = (typeof WORK_DAY_TOKENS)[number];
const DEFAULT_WORK_DAYS: readonly WorkDayToken[] = ["MON", "TUE", "WED", "THU", "FRI"];
const WORK_DAY_ORDER: Record<string, number> = Object.fromEntries(
  WORK_DAY_TOKENS.map((t, i) => [t, i]),
);
/** RFC-4122 UUID shape check (for :id route params — a malformed id is a 404). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a stored `work_days` CSV into a sanitized, canonically-ordered token
 * array. Unknown/garbage tokens are dropped; a row that ends up empty (garbage
 * or blank) falls back to the default 5-day work week.
 */
function parseWorkDays(csv: string | null | undefined): WorkDayToken[] {
  const set = new Set<WorkDayToken>();
  for (const raw of (csv ?? "").split(",")) {
    const tok = raw.trim().toUpperCase();
    if ((WORK_DAY_TOKENS as readonly string[]).includes(tok)) set.add(tok as WorkDayToken);
  }
  const tokens = [...set].sort((a, b) => WORK_DAY_ORDER[a]! - WORK_DAY_ORDER[b]!);
  return tokens.length ? tokens : [...DEFAULT_WORK_DAYS];
}

/** Dedupe + canonically order a validated token array into the CSV we store. */
function canonicalWorkDaysCsv(days: readonly WorkDayToken[]): string {
  return [...new Set(days)].sort((a, b) => WORK_DAY_ORDER[a]! - WORK_DAY_ORDER[b]!).join(",");
}

/** Normalize a date-ish value (Date | 'YYYY-MM-DD…' | null) to 'YYYY-MM-DD' | null. */
function toDateString(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Public JSON shape for an employee row: workDays as string[], hiredAt as date. */
function serializeEmployee(row: typeof employees.$inferSelect) {
  return {
    ...row,
    workDays: parseWorkDays(row.workDays),
    hiredAt: toDateString(row.hiredAt),
  };
}

const workDaysInput = z.array(z.enum(WORK_DAY_TOKENS)).min(1);
const hiredAtInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "hired_at must be YYYY-MM-DD").nullable();

// Per-outlet employee assignment (client 2026-07-09): NULL clears / stays
// unassigned; omitted leaves the current assignment untouched (PATCH only).
const locationIdInput = z.string().uuid().nullable();

const createEmployeeSchema = z.object({
  user_id: z.string().uuid().optional(),
  employee_no: z.string().min(1),
  full_name: z.string().min(1),
  department: z.enum(departmentEnum.enumValues),
  position: z.string().optional(),
  photo_url: z.string().url().optional(),
  status: z.enum(employeeStatusEnum.enumValues).optional(),
  work_days: workDaysInput.optional(),
  hired_at: hiredAtInput.optional(),
  location_id: locationIdInput.optional(),
});

// PATCH: every field optional (partial update). Unknown keys from old clients are
// stripped by zod (default z.object behavior) so they can never break the update.
const updateEmployeeSchema = z.object({
  employee_no: z.string().min(1).optional(),
  full_name: z.string().min(1).optional(),
  department: z.enum(departmentEnum.enumValues).optional(),
  position: z.string().nullable().optional(),
  photo_url: z.string().url().nullable().optional(),
  status: z.enum(employeeStatusEnum.enumValues).optional(),
  work_days: workDaysInput.optional(),
  hired_at: hiredAtInput.optional(),
  location_id: locationIdInput.optional(),
});

/**
 * Roles allowed to create/edit employee rows. OWNER (HQ) is unrestricted;
 * OUTLET_MANAGER is ASSIGNED-scope and may only target outlets in their
 * `user_outlet_access` membership (enforced via {@link isOutletInScope} below).
 */
const EMPLOYEE_WRITE_ROLES = ["OWNER", "OUTLET_MANAGER"] as const;

const createAttendanceSchema = z.object({
  employee_id: z.string().uuid(),
  type: z.enum(attendanceTypeEnum.enumValues),
  photo: z.string().min(1),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createEmsRouter(db: DB): Router {
  const router = Router();

  async function resolveReadableEmployee(req: Request, res: Response, employeeId: string, invalidStatus: 400 | 404) {
    if (!UUID_RE.test(employeeId)) {
      sendError(
        res,
        invalidStatus,
        invalidStatus === 400 ? "VALIDATION_ERROR" : "NOT_FOUND",
        invalidStatus === 400 ? "employee_id must be a valid UUID." : `Employee ${employeeId} not found.`,
      );
      return null;
    }

    const [emp] = await db
      .select({ id: employees.id, locationId: employees.locationId })
      .from(employees)
      .where(eq(employees.id, employeeId));
    if (!emp) {
      sendError(res, 404, "NOT_FOUND", `Employee ${employeeId} not found.`);
      return null;
    }

    if (req.outletContext?.scope !== "ALL" && !isOutletInScope(req.outletContext, emp.locationId)) {
      sendError(res, 403, "FORBIDDEN", "Employee is outside your access scope.");
      return null;
    }

    return emp;
  }

  // ── GET /employees ────────────────────────────────────────────────────────
  router.get("/employees", requireAuth, resolveOutletContext, async (req, res) => {
    const statusParam = req.query.status as string | undefined;
    const departmentParam = req.query.department as string | undefined;
    const locationIdParam = req.query.location_id as string | undefined;

    if (statusParam && !(employeeStatusEnum.enumValues as readonly string[]).includes(statusParam)) {
      sendError(res, 400, "VALIDATION_ERROR", `Invalid status. Valid: ${employeeStatusEnum.enumValues.join(", ")}.`);
      return;
    }
    if (departmentParam && !(departmentEnum.enumValues as readonly string[]).includes(departmentParam)) {
      sendError(res, 400, "VALIDATION_ERROR", `Invalid department. Valid: ${departmentEnum.enumValues.join(", ")}.`);
      return;
    }
    if (locationIdParam !== undefined && !UUID_RE.test(locationIdParam)) {
      sendError(res, 400, "VALIDATION_ERROR", "location_id must be a valid UUID.");
      return;
    }

    const conditions: SQL[] = [];
    if (locationIdParam !== undefined) {
      if (!isOutletInScope(req.outletContext, locationIdParam)) {
        sendError(res, 403, "FORBIDDEN", "Outlet is outside your access scope.");
        return;
      }
      conditions.push(eq(employees.locationId, locationIdParam));
    } else {
      const scopeLocs = listScopeLocationIds(req.outletContext);
      if (scopeLocs !== null) {
        if (scopeLocs.length === 0) {
          res.json([]);
          return;
        }
        conditions.push(inArray(employees.locationId, scopeLocs));
      }
    }
    if (statusParam) conditions.push(eq(employees.status, statusParam as typeof employeeStatusEnum.enumValues[number]));
    if (departmentParam) conditions.push(eq(employees.department, departmentParam as typeof departmentEnum.enumValues[number]));

    const rows = conditions.length
      ? await db.select().from(employees).where(and(...conditions))
      : await db.select().from(employees);

    res.json(rows.map(serializeEmployee));
  });

  // ── POST /employees ───────────────────────────────────────────────────────
  // OWNER (HQ, unrestricted) or OUTLET_MANAGER (ASSIGNED — may only target an
  // outlet in their own user_outlet_access membership; see resolveOutletContext
  // + isOutletInScope). Omitting location_id is unaffected by the scope check.
  router.post(
    "/employees",
    requireAuth,
    requireRole(...EMPLOYEE_WRITE_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const parsed = createEmployeeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid employee payload.", parsed.error.issues);
        return;
      }

      // Validate referenced user exists when user_id is provided
      if (parsed.data.user_id) {
        const [usr] = await db.select({ id: users.id }).from(users).where(eq(users.id, parsed.data.user_id));
        if (!usr) {
          sendError(res, 404, "NOT_FOUND", `User ${parsed.data.user_id} not found.`);
          return;
        }
      }

      const hasLocationId = Object.prototype.hasOwnProperty.call(parsed.data, "location_id");
      let locationId = parsed.data.location_id ?? null;
      if (parsed.data.location_id === null && req.outletContext?.scope !== "ALL") {
        sendError(res, 403, "FORBIDDEN", "Cannot create an unassigned employee outside HQ scope.");
        return;
      }
      if (parsed.data.location_id !== null && (hasLocationId || req.outletContext?.scope !== "ALL")) {
        locationId = await resolveRequestLocationId(db, req, res, parsed.data.location_id);
        if (!locationId) return;
      }

      const [employee] = await db
        .insert(employees)
        .values({
          userId: parsed.data.user_id ?? null,
          employeeNo: parsed.data.employee_no,
          fullName: parsed.data.full_name,
          department: parsed.data.department,
          position: parsed.data.position ?? null,
          photoUrl: parsed.data.photo_url ?? null,
          status: parsed.data.status ?? "ACTIVE",
          // Omit work_days when not supplied so the DB column default (the 5-day
          // week) applies; store the canonical CSV when supplied.
          ...(parsed.data.work_days ? { workDays: canonicalWorkDaysCsv(parsed.data.work_days) } : {}),
          hiredAt: parsed.data.hired_at ?? null,
          locationId,
        })
        .returning();

      res.status(201).json(serializeEmployee(employee!));
    },
  );

  // ── PATCH /employees/:id ──────────────────────────────────────────────────
  // Partial update; same OWNER/OUTLET_MANAGER gating as create (see
  // EMPLOYEE_WRITE_ROLES). Only supplied fields change. (The EMS module does
  // not audit employee writes — create doesn't either — so this stays
  // consistent and writes no audit row.)
  router.patch(
    "/employees/:id",
    requireAuth,
    requireRole(...EMPLOYEE_WRITE_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = req.params.id as string;
      if (!UUID_RE.test(id)) {
        sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
        return;
      }

      const parsed = updateEmployeeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid employee payload.", parsed.error.issues);
        return;
      }

      const [existing] = await db
        .select({ id: employees.id, locationId: employees.locationId })
        .from(employees)
        .where(eq(employees.id, id));
      if (!existing) {
        sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
        return;
      }

      if (req.outletContext?.scope !== "ALL" && !isOutletInScope(req.outletContext, existing.locationId)) {
        sendError(res, 403, "FORBIDDEN", "Employee is outside your access scope.");
        return;
      }

      if (parsed.data.location_id === null && req.outletContext?.scope !== "ALL") {
        sendError(res, 403, "FORBIDDEN", "Cannot clear an employee outlet assignment outside HQ scope.");
        return;
      }

      // Validate + scope-check the target outlet when a non-null location_id is
      // supplied. Omitting the field leaves it untouched.
      if (parsed.data.location_id !== undefined && parsed.data.location_id !== null) {
        const [loc] = await db
          .select({ id: locations.id })
          .from(locations)
          .where(eq(locations.id, parsed.data.location_id));
        if (!loc) {
          sendError(res, 404, "NOT_FOUND", `Outlet ${parsed.data.location_id} not found.`);
          return;
        }
        if (!isOutletInScope(req.outletContext, parsed.data.location_id)) {
          sendError(res, 403, "FORBIDDEN", "Outlet is outside your access scope.");
          return;
        }
      }

      const updates: Partial<typeof employees.$inferInsert> = { updatedAt: new Date() };
      if (parsed.data.employee_no !== undefined) updates.employeeNo = parsed.data.employee_no;
      if (parsed.data.full_name !== undefined) updates.fullName = parsed.data.full_name;
      if (parsed.data.department !== undefined) updates.department = parsed.data.department;
      if (parsed.data.position !== undefined) updates.position = parsed.data.position;
      if (parsed.data.photo_url !== undefined) updates.photoUrl = parsed.data.photo_url;
      if (parsed.data.status !== undefined) updates.status = parsed.data.status;
      if (parsed.data.work_days !== undefined) updates.workDays = canonicalWorkDaysCsv(parsed.data.work_days);
      if (parsed.data.hired_at !== undefined) updates.hiredAt = parsed.data.hired_at;
      if (parsed.data.location_id !== undefined) updates.locationId = parsed.data.location_id;

      const [updated] = await db.update(employees).set(updates).where(eq(employees.id, id)).returning();
      res.json(serializeEmployee(updated!));
    },
  );

  // ── GET /audit ────────────────────────────────────────────────────────────
  router.get(
    "/audit",
    requireAuth,
    requireRole("OWNER", "BRAND_MANAGER"),
    async (req, res) => {
      const {
        actor,
        session_id,
        entity_type,
        entity_id,
        from,
        to,
        limit: limitParam,
      } = req.query as Record<string, string | undefined>;

      const limit = Math.min(parseInt(limitParam ?? "100", 10) || 100, 500);

      const conditions = [];
      if (actor) conditions.push(eq(auditLogs.actorUserId, actor));
      if (session_id) conditions.push(eq(auditLogs.sessionId, session_id));
      if (entity_type) conditions.push(eq(auditLogs.entityType, entity_type));
      if (entity_id) conditions.push(eq(auditLogs.entityId, entity_id));
      if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
      if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

      const rows = await db
        .select()
        .from(auditLogs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit);

      res.json(rows);
    },
  );

  // ── GET /ems/analytics/employee/:userId ───────────────────────────────────
  router.get("/ems/analytics/employee/:userId", requireAuth, async (req, res) => {
    const targetUserId = req.params.userId as string;
    const { from, to } = req.query as Record<string, string | undefined>;

    // Only self or an OWNER/BRAND_MANAGER can view (roles v2, alias-normalized).
    const isSelf = req.user!.id === targetUserId;
    const viewerRole = normalizeRole(req.user!.role);
    const isAdmin = viewerRole === "OWNER" || viewerRole === "BRAND_MANAGER";
    if (!isSelf && !isAdmin) {
      sendError(res, 403, "FORBIDDEN", "Can only view your own analytics.");
      return;
    }

    const conditions = [eq(auditLogs.actorUserId, targetUserId)];
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

    // Total action count
    const [totalRow] = await db
      .select({ total: count() })
      .from(auditLogs)
      .where(and(...conditions));

    // Count of order.advance actions
    const orderAdvanceConditions = [
      eq(auditLogs.actorUserId, targetUserId),
      eq(auditLogs.action, "order.advance"),
    ];
    if (from) orderAdvanceConditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) orderAdvanceConditions.push(lte(auditLogs.createdAt, new Date(to)));

    const [advanceRow] = await db
      .select({ total: count() })
      .from(auditLogs)
      .where(and(...orderAdvanceConditions));

    // Action breakdown by type
    const actionBreakdown = await db
      .select({
        action: auditLogs.action,
        total: count(),
      })
      .from(auditLogs)
      .where(and(...conditions))
      .groupBy(auditLogs.action);

    // Session count
    const sessionConditions: ReturnType<typeof eq>[] = [eq(userSessions.userId, targetUserId)];
    const sessionCount = await db
      .select({ total: count() })
      .from(userSessions)
      .where(and(...sessionConditions));

    res.json({
      userId: targetUserId,
      totalActions: Number(totalRow?.total ?? 0),
      orderAdvances: Number(advanceRow?.total ?? 0),
      actionBreakdown,
      sessions: Number(sessionCount[0]?.total ?? 0),
    });
  });

  // ── POST /ems/attendance ──────────────────────────────────────────────────
  // Record a TIME_IN / TIME_OUT punch with a Cloudinary photo proof.
  // Actor + session come from the verified token (req.user), NEVER the body
  // (anti-spoof, CK1-EMS-005 §3 + security rules).
  //
  // SELF-ONLY (default): a non-OWNER may only punch their OWN linked employee
  // (employee.user_id = the caller). OWNER keeps a kiosk-style override to punch
  // anyone. The public unauthenticated kiosk lives at POST /public/attendance.
  router.post("/ems/attendance", requireAuth, async (req, res) => {
    const parsed = createAttendanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid attendance payload.", parsed.error.issues);
      return;
    }
    const { employee_id, type, photo, note } = parsed.data;

    if (normalizeRole(req.user!.role) !== "OWNER") {
      const [self] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.userId, req.user!.id), eq(employees.status, "ACTIVE")));
      if (!self || self.id !== employee_id) {
        sendError(res, 403, "SELF_ONLY", "You can only record your own attendance.");
        return;
      }
    }

    const result = await recordAttendancePunch(
      db,
      { employeeId: employee_id, type, photo, note },
      {
        recordedByUserId: req.user!.id, // anti-spoof: from token, not body
        sessionId: req.user!.sessionId ?? null,
        auditActorUserId: req.user!.id,
        auditActorName: req.user!.name ?? null,
      },
    );
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message);
      return;
    }
    res.status(201).json(result.record);
  });

  // ── GET /ems/attendance/self/today ────────────────────────────────────────
  // The caller's OWN attendance state for the current server day. Powers the
  // frontend "clock in/out" gate. Returns employee=null when the caller has no
  // ACTIVE linked employee row (those users are exempt from the gate).
  //
  // NOTE: "today" uses UTC day boundaries — fine for the prototype. Manila-day
  // (UTC+8) boundaries are a documented follow-up (a punch just after local
  // midnight can land on the previous UTC day near the 16:00-24:00 UTC window).
  router.get("/ems/attendance/self/today", requireAuth, async (req, res) => {
    const [emp] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.userId, req.user!.id), eq(employees.status, "ACTIVE")));

    if (!emp) {
      res.json({ employee: null, clocked_in: false, clocked_out: false, last_type: null });
      return;
    }

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    const todays = await db
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.employeeId, emp.id),
          gte(attendanceRecords.capturedAt, startOfDay),
          lte(attendanceRecords.capturedAt, endOfDay),
        ),
      )
      .orderBy(desc(attendanceRecords.capturedAt));

    res.json({
      employee: {
        id: emp.id,
        employeeNo: emp.employeeNo,
        fullName: emp.fullName,
        department: emp.department,
        photoUrl: emp.photoUrl,
      },
      clocked_in: todays.some((r) => r.type === "TIME_IN"),
      clocked_out: todays.some((r) => r.type === "TIME_OUT"),
      last_type: todays.length ? todays[0]!.type : null,
    });
  });

  // ── GET /ems/attendance ───────────────────────────────────────────────────
  // List punches newest-first. Listing ALL employees is SUPER_ADMIN-only;
  // anyone authed may filter to a specific employee_id.
  router.get("/ems/attendance", requireAuth, resolveOutletContext, async (req, res) => {
    const { employee_id, type, from, to } = req.query as Record<string, string | undefined>;
    const limitParam = req.query.limit as string | undefined;

    if (!employee_id && normalizeRole(req.user!.role) !== "OWNER") {
      sendError(res, 403, "FORBIDDEN", "Only an OWNER may list all attendance. Filter by employee_id.");
      return;
    }
    if (type && !(attendanceTypeEnum.enumValues as readonly string[]).includes(type)) {
      sendError(res, 400, "VALIDATION_ERROR", `Invalid type. Valid: ${attendanceTypeEnum.enumValues.join(", ")}.`);
      return;
    }
    if (employee_id) {
      const emp = await resolveReadableEmployee(req, res, employee_id, 400);
      if (!emp) return;
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (employee_id) conditions.push(eq(attendanceRecords.employeeId, employee_id));
    if (type) conditions.push(eq(attendanceRecords.type, type as typeof attendanceTypeEnum.enumValues[number]));
    if (from) conditions.push(gte(attendanceRecords.capturedAt, new Date(from)));
    if (to) conditions.push(lte(attendanceRecords.capturedAt, new Date(to)));

    const limit = Math.min(Math.max(Number(limitParam) || 100, 1), 500);

    const rows = conditions.length
      ? await db.select().from(attendanceRecords).where(and(...conditions)).orderBy(desc(attendanceRecords.capturedAt)).limit(limit)
      : await db.select().from(attendanceRecords).orderBy(desc(attendanceRecords.capturedAt)).limit(limit);

    res.json(rows);
  });

  // ── GET /ems/attendance/dtr ───────────────────────────────────────────────
  // Daily Time Record: one entry per (employee, UTC date) — earliest TIME_IN
  // paired with the latest TIME_OUT that day; worked minutes between them.
  // An unpaired TIME_IN yields time_out=null and minutes=null.
  //
  // 24-hour FORFEIT rule (client review 2026-07-08): every entry carries an
  // additive `status` field —
  //   COMPLETE  — paired TIME_IN + TIME_OUT
  //   OPEN      — unpaired TIME_IN less than 24h old (shift may still close)
  //   FORFEITED — unpaired TIME_IN older than 24h from "now": no time-out is
  //               ever credited (worked minutes stays null) and the system
  //               NEVER synthesizes a TIME_OUT — HR corrects the record
  //               manually. The employee's NEXT-day TIME_IN is already
  //               permitted because the punch gate and self/today are
  //               day-scoped, so a forfeited yesterday never blocks today.
  router.get("/ems/attendance/dtr", requireAuth, resolveOutletContext, async (req, res) => {
    const { employee_id, from, to } = req.query as Record<string, string | undefined>;

    // M4: same gate as the sibling GET /ems/attendance — the unfiltered DTR
    // exposes every employee's punches (incl. photo URLs), so listing ALL is
    // OWNER-only; anyone authed may still pull a specific employee_id.
    if (!employee_id && normalizeRole(req.user!.role) !== "OWNER") {
      sendError(res, 403, "FORBIDDEN", "Only an OWNER may list all DTR entries. Filter by employee_id.");
      return;
    }
    if (employee_id) {
      const emp = await resolveReadableEmployee(req, res, employee_id, 400);
      if (!emp) return;
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (employee_id) conditions.push(eq(attendanceRecords.employeeId, employee_id));
    if (from) conditions.push(gte(attendanceRecords.capturedAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conditions.push(lte(attendanceRecords.capturedAt, new Date(`${to}T23:59:59.999Z`)));

    const rows = conditions.length
      ? await db.select().from(attendanceRecords).where(and(...conditions)).orderBy(asc(attendanceRecords.capturedAt))
      : await db.select().from(attendanceRecords).orderBy(asc(attendanceRecords.capturedAt));

    // Pairing lives in attendance-shared.ts so the profile endpoint pairs
    // identically (see pairDtrEntries). Rows are asc by capturedAt as required.
    res.json(pairDtrEntries(rows));
  });

  // ── GET /employees/:id/profile ────────────────────────────────────────────
  // Employee 360: a dense per-day attendance calendar for one month plus month
  // stats. Same auth gating as GET /employees (requireAuth only). UTC days —
  // consistent with the punch gate / self-today (Manila-day is a documented
  // follow-up). Pairing is shared with the DTR route (pairDtrEntries), so a
  // PRESENT day here is exactly a COMPLETE DTR entry.
  router.get("/employees/:id/profile", requireAuth, resolveOutletContext, async (req, res) => {
    const id = req.params.id as string;

    const now = new Date();
    const monthParam = req.query.month as string | undefined;
    const month =
      monthParam ??
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    const monthNum = m ? Number(m[2]) : 0;
    if (!m || monthNum < 1 || monthNum > 12) {
      sendError(res, 400, "VALIDATION_ERROR", "month must be in YYYY-MM format (month 01-12).");
      return;
    }
    const year = Number(m[1]);
    const monthIndex = monthNum - 1;

    const scopedEmp = await resolveReadableEmployee(req, res, id, 404);
    if (!scopedEmp) return;

    const [emp] = await db.select().from(employees).where(eq(employees.id, id));
    if (!emp) {
      sendError(res, 404, "NOT_FOUND", `Employee ${id} not found.`);
      return;
    }

    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const monthStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(year, monthIndex, daysInMonth, 23, 59, 59, 999));

    // ONE query for the month's punches, asc so pairDtrEntries can pair in memory.
    const punches = await db
      .select()
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.employeeId, id),
          gte(attendanceRecords.capturedAt, monthStart),
          lte(attendanceRecords.capturedAt, monthEnd),
        ),
      )
      .orderBy(asc(attendanceRecords.capturedAt));

    const nowMs = now.getTime();
    const entryByDate = new Map<string, DtrEntry>();
    for (const e of pairDtrEntries(punches, nowMs)) entryByDate.set(e.date, e);

    const workDays = parseWorkDays(emp.workDays);
    const workDaySet = new Set(workDays);
    const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
    const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    // Pre-hire scheduled days are NOT absences. Fall back to created_at's date
    // when hired_at is unknown.
    const hireStr = toDateString(emp.hiredAt) ?? toDateString(emp.createdAt) ?? "0000-01-01";

    type DayStatus = "PRESENT" | "ABSENT" | "REST" | "FUTURE" | "FORFEITED" | "OPEN";
    interface ProfileDay {
      date: string;
      scheduled: boolean;
      status: DayStatus;
      time_in: { at: string; photo_url: string } | null;
      time_out: { at: string; photo_url: string } | null;
      worked_minutes: number | null;
    }

    const days: ProfileDay[] = [];
    let scheduled_days = 0;
    let present_days = 0;
    let absent_days = 0;
    let rest_days = 0;
    let forfeited = 0;
    let open = 0;
    let total_worked_minutes = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(monthNum).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dow = new Date(Date.UTC(year, monthIndex, d)).getUTCDay();
      const scheduled = workDaySet.has(DOW[dow] as WorkDayToken);
      const entry = entryByDate.get(dateStr) ?? null;

      let status: DayStatus;
      let worked_minutes: number | null = null;
      let time_in: ProfileDay["time_in"] = null;
      let time_out: ProfileDay["time_out"] = null;

      if (dateStr > todayStr) {
        status = "FUTURE";
      } else if (entry) {
        // A punch exists this day.
        time_in = entry.time_in ? { at: entry.time_in, photo_url: entry.photo_in ?? "" } : null;
        time_out = entry.time_out ? { at: entry.time_out, photo_url: entry.photo_out ?? "" } : null;
        if (entry.status === "COMPLETE") {
          status = "PRESENT";
          worked_minutes = entry.minutes;
        } else if (entry.status === "FORFEITED") {
          status = "FORFEITED";
        } else {
          status = "OPEN";
        }
      } else if (!scheduled) {
        status = "REST";
      } else if (dateStr >= hireStr && dateStr < todayStr) {
        status = "ABSENT";
      } else {
        // Pre-hire scheduled day (or today, not yet over) — not an absence.
        status = "REST";
      }

      // scheduled_days: scheduled, non-FUTURE, from the hire date on.
      if (scheduled && dateStr >= hireStr && dateStr <= todayStr) scheduled_days++;
      if (status === "PRESENT") present_days++;
      else if (status === "ABSENT") absent_days++;
      else if (status === "REST") rest_days++;
      else if (status === "FORFEITED") forfeited++;
      else if (status === "OPEN") open++;
      if (worked_minutes != null) total_worked_minutes += worked_minutes;

      days.push({ date: dateStr, scheduled, status, time_in, time_out, worked_minutes });
    }

    res.json({
      employee: {
        id: emp.id,
        employeeNo: emp.employeeNo,
        fullName: emp.fullName,
        department: emp.department,
        position: emp.position,
        photoUrl: emp.photoUrl,
        status: emp.status,
        workDays,
        hiredAt: toDateString(emp.hiredAt),
        userId: emp.userId,
        createdAt: emp.createdAt,
      },
      month,
      stats: {
        scheduled_days,
        present_days,
        absent_days,
        rest_days,
        forfeited,
        open,
        total_worked_minutes,
      },
      days,
    });
  });

  return router;
}
