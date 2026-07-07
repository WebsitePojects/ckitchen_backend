import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../config.js";
import { verifyToken } from "./service.js";
import { normalizeRole, outletScopeForRole, type OutletScope } from "./roles.js";
import { userSessions, type User } from "../../db/schema.js";
import type { DB } from "../../db/client.js";

export interface AuthenticatedUser {
  id: string;
  role: User["role"];
  /** Session id from the JWT `sid` claim (set after login; absent for legacy tokens). */
  sessionId?: string;
  /** Tenancy scope (D22): 'ALL' for HQ roles, else 'ASSIGNED'. */
  outletScope: OutletScope;
  /** Outlet ids this user may act in (JWT `outlet_ids` claim; [] if unscoped/legacy). */
  outletIds: string[];
  /**
   * Display name from the JWT `name` claim, for audit actor attribution
   * (never from client body fields — anti-spoof). Null on tokens minted
   * before this claim existed; callers should fall back to null rather
   * than guessing a name.
   */
  name: string | null;
}

/** Resolved outlet context for a request (set by {@link resolveOutletContext}). */
export interface OutletContext {
  scope: OutletScope;
  outletIds: string[];
  /** The outlet selected via the `X-Outlet-Id` header, if present + permitted. */
  selectedOutletId?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
    outletContext?: OutletContext;
  }
}

/** RFC-4122 UUID shape check for the X-Outlet-Id header (L2). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * Parses `Authorization: Bearer <jwt>` and attaches `req.user = { id, role, ... }`,
 * including the tenancy claims `outletScope`/`outletIds` (D22). Legacy tokens
 * minted before the claim existed fall back to the role's default scope + [].
 *
 * Also enforces session revocation (audit-backend.md SF-4): a token whose `sid`
 * points at a session row that is missing or has `logoutAt` set is rejected, so
 * logging out (or an admin closing a session) invalidates the token immediately
 * instead of leaving it valid until its 12h expiry. The session lookup is
 * skipped only when no DB is wired onto the app (never the case in prod/tests);
 * any DB error fails closed (401), never 500.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    sendError(res, 401, "AUTH_REQUIRED", "Missing or malformed Authorization header.");
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    sendError(res, 401, "AUTH_REQUIRED", "Missing bearer token.");
    return;
  }

  try {
    const { jwtSecret } = loadConfig();
    const payload = verifyToken(token, jwtSecret);

    // Session revocation check (only for tokens minted with a session id).
    if (payload.sid) {
      const db = req.app.get("db") as DB | undefined;
      if (db) {
        const [session] = await db
          .select({ logoutAt: userSessions.logoutAt })
          .from(userSessions)
          .where(eq(userSessions.id, payload.sid));
        if (!session || session.logoutAt !== null) {
          sendError(res, 401, "AUTH_REQUIRED", "Session ended. Please log in again.");
          return;
        }
      }
    }

    req.user = {
      id: payload.sub,
      role: payload.role,
      sessionId: payload.sid,
      outletScope: payload.outlet_scope ?? outletScopeForRole(payload.role),
      outletIds: Array.isArray(payload.outlet_ids) ? payload.outlet_ids : [],
      name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null,
    };
    next();
  } catch {
    sendError(res, 401, "AUTH_REQUIRED", "Invalid or expired token.");
  }
}

/**
 * 403 FORBIDDEN if `req.user.role` is not one of the allowed roles. Must run
 * after requireAuth. Roles v2 (D24): both the allow-list and the user's role are
 * normalized to canonical v2 form (via ROLE_ALIASES), so a route may be written
 * in v2 names while a still-valid v1 token (e.g. SUPER_ADMIN) keeps working, and
 * vice-versa. RIDER (and any unknown role) normalizes to null → always denied.
 */
export function requireRole(...roles: User["role"][]) {
  const allowed = new Set(
    roles.map((r) => normalizeRole(r)).filter((r): r is User["role"] => r !== null),
  );
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 401, "AUTH_REQUIRED", "Authentication required.");
      return;
    }
    const userRole = normalizeRole(req.user.role);
    if (!userRole || !allowed.has(userRole)) {
      sendError(res, 403, "FORBIDDEN", "Role not permitted for this action.");
      return;
    }
    next();
  };
}

/**
 * Resolves the request's outlet context from the authenticated user + the
 * `X-Outlet-Id` header (D22). Must run after requireAuth.
 *
 * - No header → `req.outletContext = { scope, outletIds }` (no specific selection).
 * - Header present → ALL-scope passes for any outlet; an ASSIGNED user must have
 *   the id in their `outletIds` or the request is 403'd. The header is NEVER a
 *   trusted scoping input on its own — it is membership-checked here.
 */
export function resolveOutletContext(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    sendError(res, 401, "AUTH_REQUIRED", "Authentication required.");
    return;
  }

  const scope = user.outletScope;
  const outletIds = user.outletIds ?? [];
  const raw = req.header("X-Outlet-Id");
  const selectedOutletId = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;

  // L2: validate the header shape here so a malformed value returns 400 instead of
  // reaching a downstream `::uuid` cast (which surfaced as a raw 500 for ALL-scope
  // users, whose value skips the membership check below).
  if (selectedOutletId && !UUID_RE.test(selectedOutletId)) {
    sendError(res, 400, "VALIDATION_ERROR", "X-Outlet-Id must be a valid UUID.");
    return;
  }

  if (selectedOutletId && scope !== "ALL" && !outletIds.includes(selectedOutletId)) {
    sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
    return;
  }

  req.outletContext = selectedOutletId
    ? { scope, outletIds, selectedOutletId }
    : { scope, outletIds };
  next();
}
