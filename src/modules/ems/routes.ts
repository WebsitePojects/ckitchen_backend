/**
 * EMS Routes — CK1-EMS-005 (E1 + E2-core)
 *
 * Endpoints:
 *   GET  /employees                          — list (filter status/department)
 *   POST /employees                          — create (SUPER_ADMIN)
 *   GET  /audit                              — audit trail (SUPER_ADMIN/BRAND_MANAGER)
 *   GET  /ems/analytics/employee/:userId     — per-staff analytics (self or admin)
 */
import { Router } from "express";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  auditLogs,
  departmentEnum,
  employeeStatusEnum,
  employees,
  userSessions,
  users,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { sendError } from "../http-errors.js";

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
  router.post("/employees", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
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
    requireRole("SUPER_ADMIN", "BRAND_MANAGER"),
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

    // Only self or SUPER_ADMIN/BRAND_MANAGER can view
    const isSelf = req.user!.id === targetUserId;
    const isAdmin = req.user!.role === "SUPER_ADMIN" || req.user!.role === "BRAND_MANAGER";
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

  return router;
}
