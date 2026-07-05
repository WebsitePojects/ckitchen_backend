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
import type { OutletContext } from "./middleware.js";

const locationIdSchema = z.string().uuid();

/**
 * Row-level tenancy gate (D22) reused by every module that resolves a resource's
 * own outlet (order→brand.location_id, print_job→station.location_id,
 * ito→warehouse.location_id, …) and must decide whether the caller may see/act on
 * it. ALL-scope sees every outlet; an ASSIGNED caller only outlets in `outletIds`.
 * A missing context (should not happen after `resolveOutletContext`) fails CLOSED.
 */
export function isOutletInScope(
  ctx: OutletContext | undefined,
  locationId: string | null | undefined,
): boolean {
  if (!ctx || !locationId) return false;
  if (ctx.scope === "ALL") return true;
  return ctx.outletIds.includes(locationId);
}

/**
 * The set of location ids a LIST endpoint should be narrowed to for this caller,
 * or `null` meaning "no location filter" (ALL-scope with no X-Outlet-Id selection).
 *   • ALL scope: `null` normally; `[selectedOutletId]` if an X-Outlet-Id filter is set.
 *   • ASSIGNED : the caller's `outletIds`, intersected with X-Outlet-Id when present
 *     (membership already enforced by resolveOutletContext, so the selection is safe).
 */
export function listScopeLocationIds(ctx: OutletContext | undefined): string[] | null {
  if (!ctx) return []; // fail closed → empty result set
  if (ctx.scope === "ALL") {
    return ctx.selectedOutletId ? [ctx.selectedOutletId] : null;
  }
  if (ctx.selectedOutletId) return [ctx.selectedOutletId];
  return ctx.outletIds;
}

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
  let requested = parsedLocationId ?? ctx?.selectedOutletId;

  // M1: an ASSIGNED user who names NO outlet must resolve to their OWN outlet —
  // never the deployment's "first location row" (a membership bypass when that
  // default is an outlet they don't belong to). One assigned outlet → use it;
  // several → force an explicit choice; none → deny.
  if (!requested && ctx && ctx.scope !== "ALL") {
    if (ctx.outletIds.length === 1) {
      requested = ctx.outletIds[0];
    } else if (ctx.outletIds.length === 0) {
      sendError(res, 403, "FORBIDDEN", "No outlet in your access scope.");
      return null;
    } else {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "Multiple outlets in your access scope; specify one via the X-Outlet-Id header.",
      );
      return null;
    }
  }

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

  // ALL-scope (or no ctx) with no explicit selection → deployment default outlet.
  const defaultLocationId = await getDefaultLocationId(db);
  if (!defaultLocationId) {
    sendError(res, 500, "NOT_FOUND", "No outlet is configured for this deployment.");
    return null;
  }
  return defaultLocationId;
}
