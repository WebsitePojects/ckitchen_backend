/**
 * Shared outlet-scope resolution for write endpoints (D22 tenancy).
 *
 * Mirrors the tenancy rule already enforced in inventory/routes.ts: the
 * client-supplied `location_id` (and the `X-Outlet-Id` header surfaced via
 * `req.outletContext.selectedOutletId`) are NOT trusted scoping inputs on their
 * own — they are membership-checked here.
 *
 *   • An explicitly requested outlet (body `location_id`, else `X-Outlet-Id`)
 *     is allowed for an ALL-scope user (benign target), but an ASSIGNED user
 *     must be a member of it — otherwise 403.
 *   • With no explicit request we fall back to the deployment's single default
 *     outlet (first `location` row), so existing single-outlet flows — and every
 *     test that creates a brand/station without an outlet — are unchanged.
 *
 * Requires `resolveOutletContext` to have run first (so `req.outletContext` is
 * set). Returns the resolved location id, or `null` after having already sent an
 * error response (the caller should `return` immediately on null).
 */
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { locations } from "../../db/schema.js";
import { sendError } from "../http-errors.js";

const locationIdSchema = z.string().uuid();

/** undefined = not supplied, null = supplied but malformed, string = valid uuid. */
function parseLocationIdParam(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  const parsed = locationIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Fetch the single prototype location id (gracefully returns null if none). */
async function getDefaultLocationId(db: DB): Promise<string | null> {
  const [loc] = await db.select({ id: locations.id }).from(locations);
  return loc?.id ?? null;
}

export async function resolveRequestLocationId(
  db: DB,
  req: Request,
  res: Response,
  rawLocationId: unknown,
): Promise<string | null> {
  const parsedLocationId = parseLocationIdParam(rawLocationId);
  if (parsedLocationId === null) {
    sendError(res, 400, "VALIDATION_ERROR", "'location_id' must be a UUID.");
    return null;
  }

  const ctx = req.outletContext;
  // Explicit request: an explicit body `location_id` wins, else the X-Outlet-Id selection.
  const requested = parsedLocationId ?? ctx?.selectedOutletId;

  if (requested) {
    // An ASSIGNED user may only target outlets they are a member of.
    if (ctx && ctx.scope !== "ALL" && !ctx.outletIds.includes(requested)) {
      sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
      return null;
    }
    const [location] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, requested));
    if (!location) {
      sendError(res, 404, "NOT_FOUND", "Outlet not found.");
      return null;
    }
    return location.id;
  }

  // No explicit outlet requested → the deployment's default (single) outlet.
  const defaultLocationId = await getDefaultLocationId(db);
  if (!defaultLocationId) {
    sendError(res, 500, "NOT_FOUND", "No outlet is configured for this deployment.");
    return null;
  }
  return defaultLocationId;
}
