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
