/**
 * Printing Service — CK1-API-003 §8
 *
 * Cardinal Business Rule #7: No KOT silently lost.
 *   - Every print job ends PRINTED or FAILED (with reason).
 *   - Every job is always reprintable from the web app.
 *   - The cloud never assumes a job printed without an ACK.
 *   - A disconnected agent keeps jobs PENDING — nothing is dropped.
 *
 * Business Rule #6: Cloud decides WHAT/WHERE; agent decides HOW.
 *   - The cloud enqueues jobs; the agent pulls + prints + acks.
 *   - The web app NEVER prints directly.
 *
 * Design note: `ackJob` and `reprintJob` return the modified/new job row
 * so the route handler (and future Task 8 realtime hub) can emit `print.status`
 * without an extra DB round-trip.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  kitchenStations,
  locations,
  printAgents,
  printJobs,
  printers,
  printJobStatusEnum,
  type PrintJob,
  type NewPrintJob,
} from "../../db/schema.js";
import { loadConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Custom error classes (mirrors orders/service.ts pattern)
// ---------------------------------------------------------------------------

export class PrintServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrintServiceError";
  }
}

export class PrintNotFoundError extends PrintServiceError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "PrintNotFoundError";
  }
}

export class PrintValidationError extends PrintServiceError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
    this.name = "PrintValidationError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingJobResponse {
  id: string;
  printer: {
    id: string;
    connection: string;
    address: string;
  } | null;
  payload: unknown;
}

export interface AckInput {
  status: "PRINTED" | "FAILED";
  error?: string;
}

export interface PrinterStatusUpdate {
  printer_id: string;
  status: "ONLINE" | "OFFLINE" | "ERROR";
  last_seen: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// registerAgent — POST /agent/register
// ---------------------------------------------------------------------------

/**
 * Upsert a print_agent row for the given location.
 * The "upsert" is simplified: insert if no row exists for this token+location,
 * otherwise update name + last_seen. For the prototype a single global agent
 * is expected (one location).
 */
export async function registerAgent(
  db: DB,
  input: { agent_name: string; location_id: string },
): Promise<{ ok: boolean; agent_name: string; location_id: string }> {
  const { agentToken } = loadConfig();

  // Check location exists
  const [location] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, input.location_id));

  if (!location) {
    throw new PrintNotFoundError(`Location ${input.location_id} not found.`);
  }

  // Upsert: look for existing agent row for this token + location
  const [existing] = await db
    .select()
    .from(printAgents)
    .where(
      and(
        eq(printAgents.apiToken, agentToken),
        eq(printAgents.locationId, input.location_id),
      ),
    );

  if (existing) {
    await db
      .update(printAgents)
      .set({ name: input.agent_name, lastSeen: new Date() })
      .where(eq(printAgents.id, existing.id));
  } else {
    await db.insert(printAgents).values({
      locationId: input.location_id,
      apiToken: agentToken,
      name: input.agent_name,
      lastSeen: new Date(),
    });
  }

  return { ok: true, agent_name: input.agent_name, location_id: input.location_id };
}

// ---------------------------------------------------------------------------
// resolveAgentLocationId — outlet-scoping helper for the print pull loop
// ---------------------------------------------------------------------------

/**
 * Resolves which location a print agent is authorized to pull for.
 *
 * Tenancy note (audit-db.md §3, "Service-layer leak found while auditing"):
 * `print_agent` already carries `location_id` (migration 0003). The pull
 * endpoint must use it so an agent registered for outlet 2 can never see
 * outlet 1's KOTs, even though all agents currently share one global
 * `X-Agent-Token` secret (per-agent tokens are a follow-up, audit §8 builder
 * task 6). The caller supplies `location_id` (required query param — the
 * agent knows its own location from its `/agent/register` call, which
 * already takes `{ agent_name, location_id }` per CK1-API-003 §8.1); this
 * helper verifies a `print_agent` row is actually registered for that
 * location before the pull is allowed to proceed, so an unregistered/guessed
 * location_id cannot be used to read another outlet's queue.
 */
export async function resolveAgentLocationId(
  db: DB,
  locationId: string,
): Promise<string> {
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!location) {
    throw new PrintNotFoundError(`Location ${locationId} not found.`);
  }

  const [agent] = await db
    .select({ id: printAgents.id })
    .from(printAgents)
    .where(eq(printAgents.locationId, locationId));
  if (!agent) {
    throw new PrintValidationError(
      `No print agent is registered for location ${locationId}. Call /agent/register first.`,
    );
  }

  return locationId;
}

// ---------------------------------------------------------------------------
// listPendingJobs — GET /agent/print-jobs/pending
// ---------------------------------------------------------------------------

/**
 * Returns PENDING print jobs for ONE location, oldest-first (by created_at).
 * Each job is shaped per §8.3: { id, printer, payload }.
 * Printer may be null if the station has no default printer assigned.
 *
 * Outlet-scoping (audit-db.md §3 + business-rules.md D20/D21): scoped via
 * print_job -> kitchen_station -> location so an agent from one outlet never
 * receives another outlet's KOTs. `print_job` has no location_id column of
 * its own yet (that denormalization is a separate, larger tenancy migration
 * — audit builder task 5/13); the station join is unambiguous and correct
 * today because every print_job.station_id is NOT NULL.
 */
export async function listPendingJobs(db: DB, locationId: string): Promise<PendingJobResponse[]> {
  const pendingJobs = await db
    .select({
      id: printJobs.id,
      printerId: printJobs.printerId,
      payload: printJobs.payload,
    })
    .from(printJobs)
    .innerJoin(kitchenStations, eq(printJobs.stationId, kitchenStations.id))
    .where(and(eq(printJobs.status, "PENDING"), eq(kitchenStations.locationId, locationId)))
    .orderBy(asc(printJobs.createdAt));

  if (pendingJobs.length === 0) return [];

  // Batch-load the printers that are referenced
  const printerIds = [
    ...new Set(pendingJobs.map((j) => j.printerId).filter((id): id is string => id !== null)),
  ];

  const printerRows =
    printerIds.length > 0
      ? await db.select().from(printers).where(inArray(printers.id, printerIds))
      : [];

  const printerById = new Map(printerRows.map((p) => [p.id, p]));

  return pendingJobs.map((job) => {
    const printer = job.printerId ? (printerById.get(job.printerId) ?? null) : null;
    return {
      id: job.id,
      printer: printer
        ? { id: printer.id, connection: printer.connection, address: printer.address }
        : null,
      payload: job.payload,
    };
  });
}

// ---------------------------------------------------------------------------
// ackJob — POST /agent/print-jobs/:id/ack
// ---------------------------------------------------------------------------

/**
 * Acknowledges a print job as PRINTED or FAILED.
 *
 * On PRINTED: sets status=PRINTED + printed_at=now.
 * On FAILED:  sets status=FAILED + error message.
 *
 * Returns the updated job row so the caller can emit `print.status` (Task 8).
 *
 * Business Rule #7 guarantee: every job ends in PRINTED or FAILED.
 * The ACK is the only path out of PENDING — no silent drops.
 */
export async function ackJob(db: DB, jobId: string, input: AckInput): Promise<PrintJob> {
  const [job] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
  if (!job) throw new PrintNotFoundError(`Print job ${jobId} not found.`);

  const now = new Date();
  const updates: Partial<NewPrintJob> = { status: input.status };

  if (input.status === "PRINTED") {
    updates.printedAt = now;
  } else if (input.status === "FAILED") {
    updates.error = input.error ?? null;
  }

  const [updated] = await db
    .update(printJobs)
    .set(updates)
    .where(eq(printJobs.id, jobId))
    .returning();

  return updated;
}

// ---------------------------------------------------------------------------
// updatePrinterStatuses — POST /agent/printers/status
// ---------------------------------------------------------------------------

/**
 * Heartbeat: updates each printer's status and last_seen timestamp.
 * Unknown printer IDs are silently skipped (agent may have stale config).
 * Emits `printer.status` in Task 8 — caller handles the emit.
 */
export async function updatePrinterStatuses(
  db: DB,
  updates: PrinterStatusUpdate[],
): Promise<{ ok: boolean; updated: number }> {
  if (updates.length === 0) return { ok: true, updated: 0 };

  let updated = 0;
  for (const update of updates) {
    const result = await db
      .update(printers)
      .set({
        status: update.status,
        lastSeen: new Date(update.last_seen),
      })
      .where(eq(printers.id, update.printer_id))
      .returning();
    if (result.length > 0) updated++;
  }

  return { ok: true, updated };
}

// ---------------------------------------------------------------------------
// listPrintJobs — GET /print-jobs
// ---------------------------------------------------------------------------

/**
 * List print jobs with optional status filter.
 * Used by the web app for monitoring and reprint management.
 */
export async function listPrintJobs(
  db: DB,
  filters: { status?: string },
): Promise<PrintJob[]> {
  if (filters.status) {
    const validStatuses = printJobStatusEnum.enumValues as readonly string[];
    if (!validStatuses.includes(filters.status)) {
      throw new PrintValidationError(
        `Invalid status filter. Valid values: ${validStatuses.join(", ")}.`,
      );
    }
    return db
      .select()
      .from(printJobs)
      .where(eq(printJobs.status, filters.status as PrintJob["status"]))
      .orderBy(asc(printJobs.createdAt));
  }

  return db.select().from(printJobs).orderBy(asc(printJobs.createdAt));
}

// ---------------------------------------------------------------------------
// reprintJob — POST /print-jobs/:id/reprint
// ---------------------------------------------------------------------------

/**
 * User-triggered reprint: clones the original job into a NEW job with status PENDING.
 *
 * Per §8.5 lifecycle:
 *   FAILED  --(user reprint)-->  PENDING (new job)
 *
 * The original job is NOT mutated — it stays FAILED for the audit trail.
 * The new job has the same order_id / station_id / printer_id / payload as the original.
 * Returns the new job row so the caller can emit `print.status` (Task 8).
 *
 * Business Rule #7: reprintable always — so we allow reprinting from any status,
 * not just FAILED (e.g., admin may want to reprint a PRINTED ticket).
 */
export async function reprintJob(db: DB, originalJobId: string): Promise<PrintJob> {
  const [original] = await db
    .select()
    .from(printJobs)
    .where(eq(printJobs.id, originalJobId));

  if (!original) throw new PrintNotFoundError(`Print job ${originalJobId} not found.`);

  // Clone into a NEW PENDING job
  const [newJob] = await db
    .insert(printJobs)
    .values({
      orderId: original.orderId,
      stationId: original.stationId,
      printerId: original.printerId,
      payload: original.payload,
      status: "PENDING",
    })
    .returning();

  return newJob;
}
