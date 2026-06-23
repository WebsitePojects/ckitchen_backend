/**
 * Printing Router — CK1-API-003 §8
 *
 * Agent endpoints (X-Agent-Token, NOT user JWT):
 *   POST /agent/register                 — agent self-registration
 *   GET  /agent/print-jobs/pending       — pull pending jobs (oldest-first, §8.3 shape)
 *   POST /agent/print-jobs/:id/ack       — ack PRINTED | FAILED (§8.4)
 *   POST /agent/printers/status          — heartbeat, updates printer status
 *
 * User endpoints (JWT + RBAC, per §1 role matrix):
 *   GET  /print-jobs?status=...          — monitoring/reprint list
 *   POST /print-jobs/:id/reprint         — clone to new PENDING (§8.5)
 *
 * RBAC for user endpoints:
 *   Read (GET /print-jobs)    — any authenticated user
 *   Write (reprint)           — SUPER_ADMIN | KITCHEN_STAFF
 *
 * The agent endpoints use requireAgentToken exclusively — no user JWT accepted.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import { requireAgentToken } from "./agent-auth.js";
import {
  PrintNotFoundError,
  PrintValidationError,
  ackJob,
  listPendingJobs,
  listPrintJobs,
  registerAgent,
  reprintJob,
  updatePrinterStatuses,
} from "./service.js";

// ---------------------------------------------------------------------------
// RBAC role sets
// ---------------------------------------------------------------------------

const REPRINT_ROLES = ["SUPER_ADMIN", "KITCHEN_STAFF"] as const;

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
// Router factory
// ---------------------------------------------------------------------------

export function createPrintingRouter(db: DB): Router {
  const router = Router();

  // ── POST /agent/register ───────────────────────────────────────────────
  router.post("/agent/register", requireAgentToken, async (req, res) => {
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
  router.get("/agent/print-jobs/pending", requireAgentToken, async (_req, res) => {
    try {
      const jobs = await listPendingJobs(db);
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
      const updated = await ackJob(db, id, parsed.data);
      // Return the updated job so Task 8 can emit print.status without re-fetching
      res.json(updated);
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
      const result = await updatePrinterStatuses(db, parsed.data.printers);
      // TODO (Task 8): emit `printer.status` for each updated printer
      res.json(result);
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
        // TODO (Task 8): emit `print.status` for the new PENDING job
        res.status(201).json(newJob);
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  return router;
}
