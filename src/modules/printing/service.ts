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
import { randomBytes } from "node:crypto";
import { and, asc, eq, getTableColumns, inArray, isNull, lte, or } from "drizzle-orm";
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
import { hashAgentToken } from "./agent-auth.js";

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

export interface RegisterAgentResult {
  ok: boolean;
  agent_id: string;
  agent_name: string;
  location_id: string;
  /** RAW token — shown ONCE, here, and never again (only its sha256 is persisted). */
  token: string;
}

// ---------------------------------------------------------------------------
// registerAgent — POST /agent/register  (SF-2: per-agent hashed token)
// ---------------------------------------------------------------------------

/**
 * Mints a fresh per-agent token bound to one location and persists only its
 * sha256 hash (never the raw value — see agent-auth.ts `hashAgentToken`).
 *
 * "Re-registration" behavior: upserts on (location_id, agent_name) — calling
 * register again with the same name+location ROTATES that agent's token (the
 * old one stops matching any `token_hash` immediately). This is the intended
 * recovery path after this security change ships: a deployed .NET agent that
 * only knows the old shared `AGENT_TOKEN` gets 401s from `pending`/`ack`/
 * `printers/status` (their token was never hashed into any row) until it
 * calls `/agent/register` again — still gated by the shared bootstrap secret
 * — captures the NEW raw `token` from this response, and uses THAT for every
 * subsequent request. A brand-new agent_name+location_id combination instead
 * inserts a new row (new agent identity).
 */
export async function registerAgent(
  db: DB,
  input: { agent_name: string; location_id: string },
): Promise<RegisterAgentResult> {
  // Check location exists
  const [location] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, input.location_id));

  if (!location) {
    throw new PrintNotFoundError(`Location ${input.location_id} not found.`);
  }

  const rawToken = randomBytes(32).toString("hex"); // 256 bits, deterministically hashable
  const tokenHash = hashAgentToken(rawToken);

  // Upsert: look for an existing agent row for this name + location (rotates its token).
  const [existing] = await db
    .select()
    .from(printAgents)
    .where(
      and(
        eq(printAgents.name, input.agent_name),
        eq(printAgents.locationId, input.location_id),
      ),
    );

  let agentId: string;
  if (existing) {
    await db
      .update(printAgents)
      .set({ tokenHash, lastSeen: new Date() })
      .where(eq(printAgents.id, existing.id));
    agentId = existing.id;
  } else {
    const [inserted] = await db
      .insert(printAgents)
      .values({
        locationId: input.location_id,
        tokenHash,
        name: input.agent_name,
        lastSeen: new Date(),
      })
      .returning({ id: printAgents.id });
    agentId = inserted.id;
  }

  return {
    ok: true,
    agent_id: agentId,
    agent_name: input.agent_name,
    location_id: input.location_id,
    token: rawToken,
  };
}

// ---------------------------------------------------------------------------
// Location-ownership resolvers — SF-2 cross-location authorization
// ---------------------------------------------------------------------------

/**
 * Resolves the location a print job belongs to via print_job -> kitchen_station
 * (station_id is NOT NULL / FK-enforced, so a found job always has a station).
 * Used by `ack` to 403 an agent acting on a job outside its own location —
 * NOT the same as routes.ts's realtime-emit helper, which falls back to a
 * "default location" for best-effort event routing; an authorization check
 * must never use that fallback (it would incorrectly grant/deny access).
 */
export async function resolvePrintJobLocationId(db: DB, jobId: string): Promise<string> {
  const [job] = await db.select({ stationId: printJobs.stationId }).from(printJobs).where(eq(printJobs.id, jobId));
  if (!job) throw new PrintNotFoundError(`Print job ${jobId} not found.`);

  const [station] = await db
    .select({ locationId: kitchenStations.locationId })
    .from(kitchenStations)
    .where(eq(kitchenStations.id, job.stationId));
  if (!station) throw new PrintNotFoundError(`Print job ${jobId} not found.`);

  return station.locationId;
}

/**
 * Resolves the location a printer belongs to, via whichever kitchen_station
 * has it as its default_printer_id. Returns null when no station references
 * it (unassigned / unknown printer) — callers should treat that as "cannot
 * verify this printer belongs to your location" and deny, not silently allow.
 * (Edge case: if a printer were ever wired as the default for stations in TWO
 * different locations, this returns the first match — not expected by the
 * current data model, where a printer belongs to one station/location.)
 */
export async function resolvePrinterLocationId(db: DB, printerId: string): Promise<string | null> {
  const [station] = await db
    .select({ locationId: kitchenStations.locationId })
    .from(kitchenStations)
    .where(eq(kitchenStations.defaultPrinterId, printerId));
  return station?.locationId ?? null;
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
    // v2 lease protocol: an actively-leased (derived CLAIMED) job is invisible to the
    // legacy pull loop so v1 agents cannot double-print a claimed job.
    .where(
      and(
        eq(printJobs.status, "PENDING"),
        eq(kitchenStations.locationId, locationId),
        or(isNull(printJobs.leaseUntil), lte(printJobs.leaseUntil, new Date())),
      ),
    )
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
 * List print jobs with an optional status filter.
 * Used by the web app for monitoring and reprint management.
 *
 * H3 tenancy: `locationIds` restricts to jobs whose owning outlet (via
 * print_job → kitchen_station → location) is in the set. `undefined` = no
 * location filter (ALL-scope); `[]` = caller has no outlets in scope → empty.
 * The join is unambiguous today because every print_job.station_id is NOT NULL.
 */
export async function listPrintJobs(
  db: DB,
  filters: { status?: string; locationIds?: string[] },
): Promise<PrintJob[]> {
  const conditions = [];

  if (filters.status) {
    const validStatuses = printJobStatusEnum.enumValues as readonly string[];
    if (!validStatuses.includes(filters.status)) {
      throw new PrintValidationError(
        `Invalid status filter. Valid values: ${validStatuses.join(", ")}.`,
      );
    }
    conditions.push(eq(printJobs.status, filters.status as PrintJob["status"]));
  }

  if (filters.locationIds !== undefined) {
    if (filters.locationIds.length === 0) return [];
    conditions.push(inArray(kitchenStations.locationId, filters.locationIds));
  }

  // getTableColumns keeps the flat PrintJob[] shape even with the station join.
  return db
    .select(getTableColumns(printJobs))
    .from(printJobs)
    .innerJoin(kitchenStations, eq(printJobs.stationId, kitchenStations.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(printJobs.createdAt));
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
