/**
 * Kiosk screens (mounted under /api/v1), D56.
 *
 * Owner / HR (signed in, own workspace):
 *   GET  /kiosk-devices               paired screens, newest first
 *   POST /kiosk-devices/pair          pair THIS screen (keeps a still-valid token; idempotent per request_id)
 *   POST /kiosk-devices/:id/revoke    cut a screen off (repeat = no-op)
 *
 * requireKioskDevice: gate for the unauthenticated kiosk endpoints. The X-Kiosk-Token header
 * picks the workspace; none, forged or revoked -> 401 KIOSK_NOT_PAIRED (fail closed).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import type { KioskDevice } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { audit } from "../ems/audit.js";
import { isUuid, paramAsString, sendError } from "../http-errors.js";
import { enterWorkspace } from "../tenancy/connections.js";
import { kioskToken, listKioskDevices, pairKioskDevice, resolveKioskWorkspace, revokeKioskDevice } from "./service.js";

const pairSchema = z.object({
  name: z.string().trim().min(1).max(80),
  request_id: z.string().uuid(),
  existing_token: z.string().max(200).optional(),
});

function toView(device: KioskDevice, includeToken: boolean) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt,
    ...(includeToken ? { token: kioskToken(device.id) } : {}),
  };
}

/** Runs the rest of a kiosk request as the workspace its screen is paired to. */
export async function requireKioskDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers["x-kiosk-token"];
  const token = typeof header === "string" ? header.trim() : "";
  let tenantId: string | null = null;
  try {
    tenantId = token ? await resolveKioskWorkspace(req.app.get("db") as DB, token) : null;
  } catch (err) {
    console.error(`[kiosk] token check failed: ${err instanceof Error ? err.name : typeof err}`);
    tenantId = null;
  }
  if (!tenantId) {
    sendError(res, 401, "KIOSK_NOT_PAIRED", "This screen is not set up as a kiosk. An owner opens it from Attendance > Public kiosk.");
    return;
  }
  await enterWorkspace(req, res, next, tenantId);
}

export function createKioskRouter(db: DB): Router {
  const router = Router();
  router.use("/kiosk-devices", requireAuth, requireRole("OWNER", "HR"));

  router.get("/kiosk-devices", async (_req, res) => {
    res.json((await listKioskDevices(db)).map((d) => toView(d, false)));
  });

  router.post("/kiosk-devices/pair", async (req, res) => {
    const parsed = pairSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid kiosk pairing.", parsed.error.issues);
      return;
    }
    const result = await pairKioskDevice(db, {
      name: parsed.data.name,
      clientRequestId: parsed.data.request_id,
      createdByUserId: req.user!.id,
      existingToken: parsed.data.existing_token,
    });
    if (!result.ok) {
      sendError(res, 409, "IDEMPOTENCY_CONFLICT", "This request id was already used for a different screen.");
      return;
    }
    if (!result.reused) {
      await audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name,
        sessionId: req.user!.sessionId ?? null,
        action: "kiosk.paired",
        description: `Paired kiosk screen "${result.device.name}"`,
        entityType: "kiosk_device",
        entityId: result.device.id,
      });
    }
    res.status(result.reused ? 200 : 201).json(toView(result.device, true));
  });

  router.post("/kiosk-devices/:id/revoke", async (req, res) => {
    const id = paramAsString(req.params.id);
    const device = isUuid(id) ? await revokeKioskDevice(db, id) : null;
    if (!device) {
      sendError(res, 404, "NOT_FOUND", "Kiosk screen not found.");
      return;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "kiosk.revoked",
      description: `Revoked kiosk screen "${device.name}"`,
      entityType: "kiosk_device",
      entityId: device.id,
    });
    res.json(toView(device, false));
  });

  return router;
}
