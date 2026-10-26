import type { Response } from "express";

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Express 5 types `req.params[name]` as `string | string[]` (route patterns can repeat a
 * param segment). Our routes only ever declare a single `:id`-style segment, so this
 * normalizes to the first value, with array input treated as malformed (empty fallback).
 */
export function paramAsString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID. Route ids are uuid columns; anything else can never match a row. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Answers an unexpected failure with a generic 500 and logs the real error server-side.
 * Never echo `err.message` to the client: database driver errors carry the SQL text and
 * parameters (seen in production-like testing: a malformed id returned the full query).
 */
export function sendInternalError(res: Response, err: unknown, context: string): void {
  console.error(`[${context}]`, err);
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

/** Sends the standard `{ error: { code, message, details? } }` shape (CK1-API-003 §1). */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error: ErrorBody = { code, message };
  if (details !== undefined) error.details = details;
  res.status(status).json({ error });
}
