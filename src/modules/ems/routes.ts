/**
 * EMS Routes — CK1-EMS-005 (E1 + E2-core + E3 attendance/DTR)
 *
 * Endpoints:
 *   GET  /employees                          — list (filter status/department)
 *   POST /employees                          — create (SUPER_ADMIN)
 *   GET  /audit                              — audit trail (SUPER_ADMIN/BRAND_MANAGER)
 *   GET  /ems/analytics/employee/:userId     — per-staff analytics (self or admin)
 *
 * E3 attendance (CK1-EMS-005 §3):
 *   POST /ems/attendance                     — record TIME_IN or TIME_OUT with Cloudinary photo
 *   GET  /ems/attendance                     — list (SUPER_ADMIN: all; others: need employee_id)
 *   GET  /ems/attendance/dtr                 — paired DTR view with worked_minutes
 */
import { Router } from "express";
import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  attendanceRecords,
  attendanceTypeEnum,
  auditLogs,
  departmentEnum,
  employeeStatusEnum,
  employees,
  userSessions,
  users,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { normalizeRole } from "../auth/roles.js";
import { sendError } from "../http-errors.js";
import { uploadAttendancePhoto } from "./cloudinary.js";
import { audit } from "./audit.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const createEmployeeSchema = z.object({
  user_id: z.string().uuid().optional(),
  employee_no: z.string().min(1),
  full_name: z.string().min(1),
  department: z.enum(departmentEnum.enumValues),
  position: z.string().optional(),
  photo_url: z.string().url().optional(),
  status: z.enum(employeeStatusEnum.enumValues).optional(),
});

const createAttendanceSchema = z.object({
  employee_id: z.string().uuid(),
  type: z.enum(attendanceTypeEnum.enumValues),
  photo: z.string().min(1),
  note: z.string().optional(),
});

/** Reject attendance photos larger than 8 MB (base64 string length ≈ byte budget). */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createEmsRouter(db: DB): Router {
  const router = Router();

  // ── GET /employees ────────────────────────────────────────────────────────
  router.get("/employees", requireAuth, async (req, res) => {
    const statusParam = req.query.status as string | undefined;
    const departmentParam = req.query.department as string | undefined;

    if (statusParam && !(employeeStatusEnum.enumValues as readonly string[]).includes(statusParam)) {
      sendError(res, 400, "VALIDATION_ERROR", `Invalid status. Valid: ${employeeStatusEnum.enumValues.join(", ")}.`);
      return;
    }
    if (departmentParam && !(departmentEnum.enumValues as readonly string[]).includes(departmentParam)) {
      sendError(res, 400, "VALIDATION_ERROR", `Invalid department. Valid: ${departmentEnum.enumValues.join(", ")}.`);
      return;
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (statusParam) conditions.push(eq(employees.status, statusParam as typeof employeeStatusEnum.enumValues[number]));
    if (departmentParam) conditions.push(eq(employees.department, departmentParam as typeof departmentEnum.enumValues[number]));

    const rows = conditions.length
      ? await db.select().from(employees).where(and(...conditions))
      : await db.select().from(employees);

    res.json(rows);
  });

  // ── POST /employees ───────────────────────────────────────────────────────
  router.post("/employees", requireAuth, requireRole("OWNER"), async (req, res) => {
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
      })
      .returning();

    res.status(201).json(employee);
  });

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
  router.post("/ems/attendance", requireAuth, async (req, res) => {
    const parsed = createAttendanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid attendance payload.", parsed.error.issues);
      return;
    }
    const { employee_id, type, photo, note } = parsed.data;

    if (photo.length > MAX_PHOTO_BYTES) {
      sendError(res, 400, "PAYLOAD_TOO_LARGE", "Attendance photo exceeds the 8 MB limit.");
      return;
    }

    const [emp] = await db.select().from(employees).where(eq(employees.id, employee_id));
    if (!emp) {
      sendError(res, 404, "NOT_FOUND", `Employee ${employee_id} not found.`);
      return;
    }
    if (emp.status !== "ACTIVE") {
      sendError(res, 400, "VALIDATION_ERROR", `Employee ${emp.fullName} is not ACTIVE.`);
      return;
    }

    let uploaded: { url: string; publicId: string };
    try {
      uploaded = await uploadAttendancePhoto(photo);
    } catch {
      // Never leak Cloudinary config/secret detail to the caller.
      sendError(res, 502, "UPLOAD_FAILED", "Failed to upload attendance photo.");
      return;
    }

    const [record] = await db
      .insert(attendanceRecords)
      .values({
        employeeId: employee_id,
        type,
        photoUrl: uploaded.url,
        photoPublicId: uploaded.publicId,
        recordedByUserId: req.user!.id, // anti-spoof: from token, not body
        sessionId: req.user!.sessionId ?? null,
        note: note ?? null,
      })
      .returning();

    void audit(db, {
      actorUserId: req.user!.id,
      sessionId: req.user!.sessionId ?? null,
      action: type === "TIME_IN" ? "attendance.time_in" : "attendance.time_out",
      description: `${type} for ${emp.fullName} (${emp.employeeNo})`,
      entityType: "attendance_record",
      entityId: record!.id,
    });

    res.status(201).json(record);
  });

  // ── GET /ems/attendance ───────────────────────────────────────────────────
  // List punches newest-first. Listing ALL employees is SUPER_ADMIN-only;
  // anyone authed may filter to a specific employee_id.
  router.get("/ems/attendance", requireAuth, async (req, res) => {
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
  router.get("/ems/attendance/dtr", requireAuth, async (req, res) => {
    const { employee_id, from, to } = req.query as Record<string, string | undefined>;

    // M4: same gate as the sibling GET /ems/attendance — the unfiltered DTR
    // exposes every employee's punches (incl. photo URLs), so listing ALL is
    // OWNER-only; anyone authed may still pull a specific employee_id.
    if (!employee_id && normalizeRole(req.user!.role) !== "OWNER") {
      sendError(res, 403, "FORBIDDEN", "Only an OWNER may list all DTR entries. Filter by employee_id.");
      return;
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (employee_id) conditions.push(eq(attendanceRecords.employeeId, employee_id));
    if (from) conditions.push(gte(attendanceRecords.capturedAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conditions.push(lte(attendanceRecords.capturedAt, new Date(`${to}T23:59:59.999Z`)));

    const rows = conditions.length
      ? await db.select().from(attendanceRecords).where(and(...conditions)).orderBy(asc(attendanceRecords.capturedAt))
      : await db.select().from(attendanceRecords).orderBy(asc(attendanceRecords.capturedAt));

    interface DtrEntry {
      date: string;
      employee_id: string;
      time_in: string | null;
      time_out: string | null;
      photo_in: string | null;
      photo_out: string | null;
      minutes: number | null;
    }
    const byKey = new Map<string, DtrEntry>();
    for (const r of rows) {
      const iso = new Date(r.capturedAt).toISOString();
      const date = iso.slice(0, 10);
      const key = `${r.employeeId}|${date}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { date, employee_id: r.employeeId, time_in: null, time_out: null, photo_in: null, photo_out: null, minutes: null };
        byKey.set(key, entry);
      }
      if (r.type === "TIME_IN") {
        if (!entry.time_in) {
          entry.time_in = iso;
          entry.photo_in = r.photoUrl;
        }
      } else {
        entry.time_out = iso; // latest TIME_OUT wins (rows asc by time)
        entry.photo_out = r.photoUrl;
      }
    }
    for (const entry of byKey.values()) {
      if (entry.time_in && entry.time_out) {
        entry.minutes = Math.round(
          (new Date(entry.time_out).getTime() - new Date(entry.time_in).getTime()) / 60000,
        );
      }
    }

    res.json(Array.from(byKey.values()));
  });

  return router;
}
