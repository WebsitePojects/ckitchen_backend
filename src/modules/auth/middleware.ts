import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "../../config.js";
import { verifyToken } from "./service.js";
import type { User } from "../../db/schema.js";

export interface AuthenticatedUser {
  id: string;
  role: User["role"];
  /** Session id from the JWT `sid` claim (set after login; absent for legacy tokens). */
  sessionId?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

/** Parses `Authorization: Bearer <jwt>` and attaches `req.user = { id, role }`. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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
    req.user = { id: payload.sub, role: payload.role, sessionId: payload.sid };
    next();
  } catch {
    sendError(res, 401, "AUTH_REQUIRED", "Invalid or expired token.");
  }
}

/** 403 FORBIDDEN if `req.user.role` is not one of the allowed roles. Must run after requireAuth. */
export function requireRole(...roles: User["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 401, "AUTH_REQUIRED", "Authentication required.");
      return;
    }
    if (!roles.includes(req.user.role)) {
      sendError(res, 403, "FORBIDDEN", "Role not permitted for this action.");
      return;
    }
    next();
  };
}
