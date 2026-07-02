import type { NextFunction, Request, Response } from "express";
import { sendError } from "./http-errors.js";
import { ServiceError } from "./orders/service.js";
import { PrintServiceError } from "./printing/service.js";

/**
 * Global error safety net (audit-backend.md CRITICAL #5).
 *
 * Before this existed, any error that escaped a route's own try/catch reached
 * Express's default handler, which serializes `err.stack` into the response body
 * whenever NODE_ENV !== "production" — leaking internals (file paths, SQL, etc.).
 *
 * Policy:
 *   - INTENTIONAL domain errors (ServiceError / PrintServiceError and subclasses)
 *     carry a safe, client-facing `code` + `message` → returned with a mapped
 *     status. These are authored for the client, so echoing them is fine.
 *   - ANY OTHER error is unexpected (DB failure, TypeError, etc.). Its message and
 *     stack may reveal internals, so the client only ever gets a generic 500; the
 *     full error is logged server-side for operators.
 *
 * Register AFTER all routers, and register `notFoundHandler` just before it.
 */

const CODE_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  DUPLICATE_ORDER: 409,
};

/** 404 for any request that matched no route. */
export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 404, "NOT_FOUND", "Resource not found.");
}

/** Express 5 error-handling middleware (must have the 4-arg signature). */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Headers already sent → delegate to Express to close the connection.
  if (res.headersSent) {
    _next(err);
    return;
  }

  if (err instanceof ServiceError || err instanceof PrintServiceError) {
    const status = CODE_STATUS[err.code] ?? 400;
    sendError(res, status, err.code, err.message);
    return;
  }

  // Unexpected — never leak the message/stack to the client.
  console.error("[unhandled error]", err);
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}
