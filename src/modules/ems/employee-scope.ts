/**
 * Who may read or manage which employee (D58). One place, so the employee list, the
 * attendance views, the summary and the performance log all answer the same way.
 *
 *   read:   yourself, always; anyone else only with a people role (their punches carry
 *           face photos), and an ASSIGNED-scope reader only inside their outlets.
 *   manage: (write performance notes) a people-manager role in scope, never about yourself.
 */
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { employees } from "../../db/schema.js";
import { isOutletInScope } from "../auth/outlet-scope.js";
import { normalizeRole } from "../auth/roles.js";
import { sendError } from "../http-errors.js";

/** Roles that may read other people's employee records (list, profile, punches, summary). */
export const EMPLOYEE_READ_ROLES = ["OWNER", "HR", "OUTLET_MANAGER", "ACCOUNTING"] as const;

/** Roles that may write and void manual performance notes. */
export const PERFORMANCE_NOTE_WRITE_ROLES = ["OWNER", "HR", "OUTLET_MANAGER"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleIn(role: string | null | undefined, allowed: readonly string[]): boolean {
  const normalized = normalizeRole(role);
  return normalized !== null && allowed.includes(normalized);
}

export function canReadOtherEmployees(role: string | null | undefined): boolean {
  return roleIn(role, EMPLOYEE_READ_ROLES);
}

export interface ScopedEmployee {
  id: string;
  locationId: string | null;
  userId: string | null;
  fullName: string;
}

/**
 * Loads an employee the caller may read, or answers the request (400/404/403) and returns
 * null. `invalidStatus` picks how a malformed id is reported: 400 for a query parameter,
 * 404 for a path segment.
 */
export async function resolveReadableEmployee(
  db: DB,
  req: Request,
  res: Response,
  employeeId: string,
  invalidStatus: 400 | 404,
): Promise<ScopedEmployee | null> {
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
    .select({ id: employees.id, locationId: employees.locationId, userId: employees.userId, fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.id, employeeId));
  if (!emp) {
    sendError(res, 404, "NOT_FOUND", `Employee ${employeeId} not found.`);
    return null;
  }

  // A person may always read their own record, even with no outlet set (location_id null),
  // which would otherwise put it outside everyone's scope but HQ.
  const isSelf = emp.userId !== null && emp.userId === req.user!.id;
  if (isSelf) return emp;
  if (!canReadOtherEmployees(req.user!.role)) {
    sendError(res, 403, "FORBIDDEN", "You can only view your own employee record.");
    return null;
  }
  if (req.outletContext?.scope !== "ALL" && !isOutletInScope(req.outletContext, emp.locationId)) {
    sendError(res, 403, "FORBIDDEN", "Employee is outside your access scope.");
    return null;
  }
  return emp;
}

/**
 * Like {@link resolveReadableEmployee}, for writing about the employee: requires a
 * people-manager role in scope and refuses notes about yourself (nobody grades themselves).
 */
export async function resolveManageableEmployee(
  db: DB,
  req: Request,
  res: Response,
  employeeId: string,
): Promise<ScopedEmployee | null> {
  if (!roleIn(req.user!.role, PERFORMANCE_NOTE_WRITE_ROLES)) {
    sendError(res, 403, "FORBIDDEN", "Role not permitted for this action.");
    return null;
  }
  const emp = await resolveReadableEmployee(db, req, res, employeeId, 404);
  if (!emp) return null;
  if (emp.userId !== null && emp.userId === req.user!.id) {
    sendError(res, 403, "SELF_REVIEW", "You cannot record performance notes about yourself.");
    return null;
  }
  return emp;
}
