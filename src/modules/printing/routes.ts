/**
 * Printing Router — CK1-API-003 §8 / SF-2 (audit-backend.md CRITICAL #2)
 *
 * Agent endpoints (X-Agent-Token, NOT user JWT):
 *   POST /agent/register                 — bootstrap-secret gated (requireBootstrapToken);
 *                                           mints + returns a fresh per-agent token (once).
 *   GET  /agent/print-jobs/pending        — per-agent-token gated (requireAgentToken);
 *                                           location comes ONLY from req.agent.locationId,
 *                                           oldest-first (§8.3 shape).
 *   POST /agent/print-jobs/:id/ack        — ack PRINTED | FAILED (§8.4); 403 if the job's
 *                                           station is outside req.agent.locationId.
 *   POST /agent/printers/status           — heartbeat; 403 if any printer is outside
 *                                           req.agent.locationId.
 *
 * User endpoints (JWT + RBAC, per §1 role matrix):
 *   GET  /print-jobs?status=...          — monitoring/reprint list
 *   POST /print-jobs/:id/reprint         — clone to new PENDING (§8.5)
 *
 * RBAC for user endpoints:
 *   Read (GET /print-jobs)    — any authenticated user
 *   Write (reprint)           — SUPER_ADMIN | KITCHEN_STAFF
 *
 * Every agent endpoint uses ONE of requireBootstrapToken (register only) or
 * requireAgentToken (everything else) — never a user JWT (agent-auth.ts).
 *
 * Task 8 — realtime emissions:
 *   print.status   → after agent ack (PRINTED | FAILED) and after reprint (new PENDING)
 *   printer.status → after agent heartbeat (per printer in the update)
 */
import { Router, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { locations, kitchenStations, printJobs } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { requireAgentToken, requireBootstrapToken } from "./agent-auth.js";
import {
  PrintNotFoundError,
  PrintValidationError,
  ackJob,
  listPendingJobs,
  listPrintJobs,
  registerAgent,
  reprintJob,
  resolvePrintJobLocationId,
  resolvePrinterLocationId,
  updatePrinterStatuses,
} from "./service.js";

// ---------------------------------------------------------------------------
// RBAC role sets
// ---------------------------------------------------------------------------

const REPRINT_ROLES = ["OWNER", "KITCHEN_CREW"] as const;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const registerAgentSchema = z.object({
  agent_name: z.string().min(1),
  location_id: z.string().uuid(),
});

const ackSchema = z.object({
  status: z.enum(["PRINTED", "FAILED"]),
  error: z.string().optional(),
});

const printerStatusItemSchema = z.object({
  printer_id: z.string().uuid(),
  status: z.enum(["ONLINE", "OFFLINE", "ERROR"]),
  last_seen: z.string().datetime({ offset: true }),
});

const printerStatusSchema = z.object({
  printers: z.array(printerStatusItemSchema),
});

// ---------------------------------------------------------------------------
// Error → HTTP response mapping
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof PrintNotFoundError) {
    sendError(res, 404, err.code, err.message);
  } else if (err instanceof PrintValidationError) {
    sendError(res, 400, err.code, err.message);
  } else {
    const message = err instanceof Error ? err.message : "Internal server error.";
    sendError(res, 500, "INTERNAL_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// Location resolution helper
// ---------------------------------------------------------------------------

/** Fetch the single prototype location id (gracefully returns null if not seeded). */
async function getDefaultLocationId(db: DB): Promise<string | null> {
  const [loc] = await db.select({ id: locations.id }).from(locations);
  return loc?.id ?? null;
}

/**
 * Resolve the location for a print job via: print_job → station → location.
 * Falls back to the default location if the chain is broken (e.g. no station).
 */
async function getLocationIdForPrintJob(db: DB, jobId: string): Promise<string | null> {
  const [job] = await db
    .select({ stationId: printJobs.stationId })
    .from(printJobs)
    .where(eq(printJobs.id, jobId));

  if (!job) return getDefaultLocationId(db);

  const [station] = await db
    .select({ locationId: kitchenStations.locationId })
    .from(kitchenStations)
    .where(eq(kitchenStations.id, job.stationId));

  return station?.locationId ?? getDefaultLocationId(db);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createPrintingRouter(db: DB, hub: RealtimeHub): Router {
  const router = Router();

  // ── POST /agent/register ───────────────────────────────────────────────
  // The ONE pre-identity agent endpoint (SF-2): gated by the shared bootstrap
  // AGENT_TOKEN secret, NOT a per-agent token (the agent has none yet). Mints
  // a fresh per-agent token and returns it RAW, once — the agent persists it
  // and uses it (not AGENT_TOKEN) for every other agent endpoint below.
  router.post("/agent/register", requireBootstrapToken, async (req, res) => {
    const parsed = registerAgentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid agent registration payload.", parsed.error.issues);
      return;
    }

    try {
      const result = await registerAgent(db, parsed.data);
      res.json(result);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /agent/print-jobs/pending ──────────────────────────────────────
  // SF-2: location is derived ONLY from the authenticated agent's own
  // req.agent.locationId (set by requireAgentToken from the token_hash
  // lookup) — never from a client-supplied query/body field. This closes the
  // audit-db.md §3 hole where an agent could pull another outlet's queue by
  // simply passing a different ?location_id=.
  router.get("/agent/print-jobs/pending", requireAgentToken, async (req, res) => {
    try {
      const jobs = await listPendingJobs(db, req.agent!.locationId);
      res.json(jobs);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /agent/print-jobs/:id/ack ────────────────────────────────────
  router.post("/agent/print-jobs/:id/ack", requireAgentToken, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = ackSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid ack payload.", parsed.error.issues);
      return;
    }

    try {
      // SF-2: 403 if this job's station belongs to a DIFFERENT location than
      // the acking agent's own — an agent may only ack its own outlet's jobs.
      const jobLocationId = await resolvePrintJobLocationId(db, id);
      if (jobLocationId !== req.agent!.locationId) {
        sendError(res, 403, "FORBIDDEN", "Print job belongs to a different location.");
        return;
      }

      const updated = await ackJob(db, id, parsed.data);
      res.json(updated);

      // Task 8: emit print.status after agent ack
      const locationId = await getLocationIdForPrintJob(db, id);
      if (locationId) {
        hub.emitToLocation(locationId, "print.status", {
          print_job_id: updated.id,
          order_id: updated.orderId,
          station_id: updated.stationId,
          status: updated.status,
          error: updated.error ?? null,
          printed_at: updated.printedAt?.toISOString() ?? null,
        });
      }
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /agent/printers/status ────────────────────────────────────────
  router.post("/agent/printers/status", requireAgentToken, async (req, res) => {
    const parsed = printerStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid printer status payload.", parsed.error.issues);
      return;
    }

    try {
      // SF-2: verify EVERY printer in the batch belongs to the reporting
      // agent's own location before applying ANY update — a printer with no
      // resolvable station (unassigned/unknown) is treated as unverifiable
      // and denied, not silently allowed.
      for (const p of parsed.data.printers) {
        const ownerLocationId = await resolvePrinterLocationId(db, p.printer_id);
        if (ownerLocationId !== req.agent!.locationId) {
          sendError(res, 403, "FORBIDDEN", `Printer ${p.printer_id} is not in your agent's location.`);
          return;
        }
      }

      const result = await updatePrinterStatuses(db, parsed.data.printers);
      res.json(result);

      // Task 8: emit printer.status for each updated printer
      const locationId = req.agent!.locationId;
      for (const p of parsed.data.printers) {
        hub.emitToLocation(locationId, "printer.status", {
          printer_id: p.printer_id,
          status: p.status,
          last_seen: p.last_seen,
        });
      }
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /print-jobs ────────────────────────────────────────────────────
  router.get("/print-jobs", requireAuth, async (req, res) => {
    const { status } = req.query as Record<string, string | undefined>;

    try {
      const jobs = await listPrintJobs(db, { status });
      res.json(jobs);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /print-jobs/:id/reprint ───────────────────────────────────────
  router.post(
    "/print-jobs/:id/reprint",
    requireAuth,
    requireRole(...REPRINT_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);

      try {
        const newJob = await reprintJob(db, id);
        res.status(201).json(newJob);

        // Task 8: emit print.status for the new PENDING job
        const locationId = await getLocationIdForPrintJob(db, newJob.id);
        if (locationId) {
          hub.emitToLocation(locationId, "print.status", {
            print_job_id: newJob.id,
            order_id: newJob.orderId,
            station_id: newJob.stationId,
            status: newJob.status,
            error: null,
            printed_at: null,
          });
        }
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
