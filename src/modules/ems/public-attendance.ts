/**
 * Public attendance kiosk — CK1-EMS-005 §3 (unauthenticated by design)
 *
 * Mounted under /api/v1/public with NO auth middleware: a shared wall-mounted
 * tablet lets any staff member clock in/out by selecting their name and taking a
 * photo, without each person holding a login. This is a deliberate product
 * decision — the mandatory photo is the identity evidence, and every punch is
 * audited under the "Public" actor category (docs/audit/audit-event-types.md §1).
 *
 * Guards:
 *   - Feature flag PUBLIC_ATTENDANCE_ENABLED=false → both endpoints 404 (default ON).
 *   - ~30 req/min per IP rate limit (mirrors the login limiter; env-tunable, with a
 *     high ceiling under NODE_ENV=test so the suite never trips it).
 *   - Employees list exposes MINIMAL fields only (no photo URLs, no user ids).
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { attendanceTypeEnum, employees } from "../../db/schema.js";
import { sendError } from "../http-errors.js";
import { recordAttendancePunch } from "./attendance-shared.js";

const publicPunchSchema = z.object({
  employee_id: z.string().uuid(),
  type: z.enum(attendanceTypeEnum.enumValues),
  // Photo is MANDATORY — it is the ONLY identity evidence on an unauthenticated
  // punch. Missing/empty → the schema rejects with 400.
  photo: z.string().min(1),
  note: z.string().optional(),
});

export function createPublicAttendanceRouter(db: DB): Router {
  const router = Router();

  // Feature flag read at REQUEST time (not construction) so it can be toggled
  // per-deploy / per-test. Only the exact string "false" disables it.
  const isDisabled = () => process.env.PUBLIC_ATTENDANCE_ENABLED === "false";

  // ~30 req/min per IP. Env-tunable; NODE_ENV=test gets a high ceiling so the
  // test suite's repeated kiosk calls never trip it (mirrors the login limiter).
  const isTest = process.env.NODE_ENV === "test";
  const kioskLimiter = rateLimit({
    windowMs: Number(process.env.PUBLIC_ATTENDANCE_RATE_LIMIT_WINDOW_MS ?? 60_000),
    limit: Number(process.env.PUBLIC_ATTENDANCE_RATE_LIMIT_MAX ?? (isTest ? 100_000 : 30)),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(res, 429, "RATE_LIMITED", "Too many kiosk requests. Please slow down.");
    },
  });

  // ── GET /public/attendance/employees ──────────────────────────────────────
  // ACTIVE employees only, MINIMAL fields (PII discipline: no photo, no user id).
  router.get("/attendance/employees", kioskLimiter, async (_req, res) => {
    if (isDisabled()) {
      sendError(res, 404, "NOT_FOUND", "Public attendance is disabled.");
      return;
    }
    const rows = await db
      .select({
        id: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        department: employees.department,
      })
      .from(employees)
      .where(eq(employees.status, "ACTIVE"));
    res.json(rows);
  });

  // ── POST /public/attendance ───────────────────────────────────────────────
  // Unauthenticated punch. recorded_by_user_id + session_id are NULL; the audit
  // row is credited to the "Public" actor with metadata.source = "public_kiosk".
  router.post("/attendance", kioskLimiter, async (req, res) => {
    if (isDisabled()) {
      sendError(res, 404, "NOT_FOUND", "Public attendance is disabled.");
      return;
    }
    const parsed = publicPunchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid attendance payload. A photo is required.", parsed.error.issues);
      return;
    }
    const { employee_id, type, photo, note } = parsed.data;

    const result = await recordAttendancePunch(
      db,
      { employeeId: employee_id, type, photo, note },
      {
        recordedByUserId: null,
        sessionId: null,
        auditActorUserId: null,
        auditActorName: "Public",
        source: "public_kiosk",
      },
    );
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message);
      return;
    }
    res.status(201).json(result.record);
  });

  return router;
}
