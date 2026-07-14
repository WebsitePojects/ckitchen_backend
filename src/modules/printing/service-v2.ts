/**
 * Printing v2 — lease protocol (D35-D46 §12).
 *
 *   PENDING ──claim──▶ CLAIMED ──ack──▶ PRINTED | FAILED
 *
 * CLAIMED is a DERIVED state: status = 'PENDING' AND lease_until > now().
 * A job whose lease expires silently re-enters the claimable pool; the
 * expired attempt is appended to print_job_attempt as LEASE_EXPIRED at the
 * next claim that observes it (immutable attempt history — reprint/retry
 * never rewrites PRINTED history).
 *
 * Invariants implemented here:
 *  - Atomic claim: a conditional UPDATE stamps lease_token/lease_until only
 *    on rows that are unleased — two agents can never hold the same job.
 *  - Lease renewal requires the exact live token.
 *  - Idempotent conditional ACK: exact same (job, lease_token, result[,hash])
 *    replay returns the stored outcome; a stale/foreign token is refused; a
 *    content_hash mismatch is refused (the agent must print exactly the
 *    payload the cloud enqueued).
 *  - Bounded retries: after MAX_PRINT_ATTEMPTS resolved attempts the job is
 *    forced FAILED and leaves the claimable pool; reprint (a NEW linked job)
 *    is the only way forward.
 *  - Allowlists: claim is scoped to the agent's location AND the requested
 *    capability; a VIRTUAL-transport printer is the §12 hardware-less
 *    verification sink (processVirtualSpool) used until real hardware lands.
 *
 * All v2 surfaces are gated by the `printing.spooling` feature flag at the
 * route layer; the legacy v1 pull/ack path stays untouched for compatibility
 * (v1 pending listing now simply excludes actively-leased rows).
 */
import { randomUUID, createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { operationalFeatureFlags } from "../../db/enterprise-schema.js";
import {
  kitchenStations,
  printJobAttempts,
  printJobs,
  printers,
  type PrintJob,
} from "../../db/schema.js";
import { PrintNotFoundError, PrintValidationError } from "./service.js";

export const PRINTING_SPOOLING_FLAG = "printing.spooling";
export const DEFAULT_LEASE_SECONDS = 60;
export const MAX_PRINT_ATTEMPTS = 3;

export async function isSpoolingEnabled(db: DB): Promise<boolean> {
  const [row] = await db
    .select({ enabled: operationalFeatureFlags.enabled })
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, PRINTING_SPOOLING_FLAG));
  return row?.enabled === true;
}

export function contentHashOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function leaseExpiry(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** Jobs at this location that are claimable: PENDING, unleased (or lease expired), attempts not exhausted. */
function claimableWhere(locationJobIds: string[]) {
  return and(
    inArray(printJobs.id, locationJobIds),
    eq(printJobs.status, "PENDING"),
    lt(printJobs.retries, MAX_PRINT_ATTEMPTS),
    or(isNull(printJobs.leaseUntil), lte(printJobs.leaseUntil, new Date())),
  );
}

async function jobIdsForLocation(db: DB, locationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .innerJoin(kitchenStations, eq(printJobs.stationId, kitchenStations.id))
    .where(eq(kitchenStations.locationId, locationId));
  return rows.map((r) => r.id);
}

/**
 * Records a LEASE_EXPIRED attempt for a job whose previous lease lapsed
 * without an ack, then bumps retries. Called lazily at claim time.
 */
async function recordExpiredLease(db: DB, job: PrintJob): Promise<void> {
  if (!job.leaseToken || !job.leaseUntil || job.leaseUntil.getTime() > Date.now()) return;
  await db.transaction(async (tx) => {
    const attemptNo = job.retries + 1;
    await tx
      .insert(printJobAttempts)
      .values({
        printJobId: job.id,
        attemptNo,
        leaseToken: job.leaseToken!,
        result: "LEASE_EXPIRED",
        error: "Lease expired without an acknowledgement.",
        contentHash: job.contentHash,
        claimedAt: job.leaseUntil!,
      })
      .onConflictDoNothing();
    await tx
      .update(printJobs)
      .set({ retries: attemptNo, leaseToken: null, leaseUntil: null })
      .where(and(eq(printJobs.id, job.id), eq(printJobs.leaseToken, job.leaseToken!)));
  });
}

export interface ClaimedJob {
  id: string;
  order_id: string;
  station_id: string;
  printer_id: string | null;
  capability: string;
  document_type: string | null;
  payload: unknown;
  content_hash: string | null;
  lease_token: string;
  lease_until: string;
  attempt_no: number;
}

/**
 * Atomically claims up to `limit` oldest claimable jobs at the agent's
 * location matching `capability`. Per-row conditional UPDATE — concurrent
 * agents each win disjoint subsets.
 */
export async function claimJobs(
  db: DB,
  agentLocationId: string,
  opts: { capability?: "ESC_POS_KOT" | "WINDOWS_DOCUMENT"; limit?: number; leaseSeconds?: number } = {},
): Promise<ClaimedJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 10), 300);
  const scopeIds = await jobIdsForLocation(db, agentLocationId);
  if (scopeIds.length === 0) return [];

  // Lazily fold any lapsed leases back into the pool (records LEASE_EXPIRED).
  const lapsed = await db
    .select()
    .from(printJobs)
    .where(
      and(
        inArray(printJobs.id, scopeIds),
        eq(printJobs.status, "PENDING"),
        sql`${printJobs.leaseToken} IS NOT NULL`,
        lte(printJobs.leaseUntil, new Date()),
      ),
    );
  for (const job of lapsed) await recordExpiredLease(db, job);

  const capabilityFilter = opts.capability ? eq(printJobs.capability, opts.capability) : undefined;
  const candidates = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(capabilityFilter ? and(claimableWhere(scopeIds), capabilityFilter) : claimableWhere(scopeIds))
    .orderBy(asc(printJobs.createdAt))
    .limit(limit);

  const claimed: ClaimedJob[] = [];
  for (const { id } of candidates) {
    const leaseToken = randomUUID();
    const until = leaseExpiry(leaseSeconds);
    const [row] = await db
      .update(printJobs)
      .set({ leaseToken, leaseUntil: until })
      .where(
        and(
          eq(printJobs.id, id),
          eq(printJobs.status, "PENDING"),
          or(isNull(printJobs.leaseUntil), lte(printJobs.leaseUntil, new Date())),
        ),
      )
      .returning();
    if (!row) continue; // lost the race to a concurrent claimer — fine.
    claimed.push({
      id: row.id,
      order_id: row.orderId,
      station_id: row.stationId,
      printer_id: row.printerId,
      capability: row.capability,
      document_type: row.documentType,
      payload: row.payload,
      content_hash: row.contentHash,
      lease_token: leaseToken,
      lease_until: until.toISOString(),
      attempt_no: row.retries + 1,
    });
  }
  return claimed;
}

/** Renews a live lease; requires the exact current token. */
export async function renewLease(
  db: DB,
  jobId: string,
  leaseToken: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<{ lease_until: string }> {
  const until = leaseExpiry(Math.min(Math.max(leaseSeconds, 10), 300));
  const [row] = await db
    .update(printJobs)
    .set({ leaseUntil: until })
    .where(
      and(
        eq(printJobs.id, jobId),
        eq(printJobs.status, "PENDING"),
        eq(printJobs.leaseToken, leaseToken),
        sql`${printJobs.leaseUntil} > now()`,
      ),
    )
    .returning({ id: printJobs.id });
  if (!row) {
    throw new PrintValidationError("Lease is not live for this token (expired, re-claimed, or already resolved).");
  }
  return { lease_until: until.toISOString() };
}

export interface AckV2Input {
  jobId: string;
  leaseToken: string;
  result: "PRINTED" | "FAILED";
  error?: string | null;
  contentHash?: string | null;
  agentId?: string | null;
}

/**
 * Idempotent conditional ACK. Exact replay (same job + token + result)
 * returns the stored outcome; anything else against a resolved job or a
 * non-matching token/hash is refused.
 */
export async function ackJobV2(db: DB, input: AckV2Input): Promise<PrintJob> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(printJobs).where(eq(printJobs.id, input.jobId)).for("update");
    if (!job) throw new PrintNotFoundError(`Print job ${input.jobId} not found`);

    // Idempotent replay: already resolved by this very lease + same result.
    if (job.status !== "PENDING") {
      const [prior] = await tx
        .select()
        .from(printJobAttempts)
        .where(and(eq(printJobAttempts.printJobId, job.id), eq(printJobAttempts.leaseToken, input.leaseToken)));
      if (prior && prior.result === input.result) return job;
      throw new PrintValidationError(`Job already resolved (${job.status}); non-matching ack refused.`);
    }

    if (job.leaseToken !== input.leaseToken || !job.leaseUntil || job.leaseUntil.getTime() <= Date.now()) {
      throw new PrintValidationError("Lease token is not live for this job.");
    }
    if (job.contentHash && input.contentHash && input.contentHash !== job.contentHash) {
      throw new PrintValidationError("content_hash mismatch — agent payload differs from the enqueued job.");
    }
    if (input.result === "FAILED" && !input.error) {
      throw new PrintValidationError("A FAILED ack requires an error message.");
    }

    const attemptNo = job.retries + 1;
    await tx.insert(printJobAttempts).values({
      printJobId: job.id,
      attemptNo,
      agentId: input.agentId ?? null,
      leaseToken: input.leaseToken,
      result: input.result,
      error: input.error ?? null,
      contentHash: input.contentHash ?? job.contentHash,
      claimedAt: job.leaseUntil,
    });

    const exhausted = input.result === "FAILED" && attemptNo >= MAX_PRINT_ATTEMPTS;
    const [updated] = await tx
      .update(printJobs)
      .set({
        status: input.result === "PRINTED" ? "PRINTED" : exhausted ? "FAILED" : "PENDING",
        error: input.result === "FAILED" ? (input.error ?? null) : null,
        retries: attemptNo,
        printedAt: input.result === "PRINTED" ? new Date() : null,
        leaseToken: null,
        leaseUntil: null,
      })
      .where(eq(printJobs.id, job.id))
      .returning();
    return updated!;
  });
}

/**
 * §12 virtual spool sink: claims every claimable job routed to a
 * VIRTUAL-transport printer at `locationId` and immediately acks PRINTED.
 * The verification substitute until physical hardware acceptance.
 */
export async function processVirtualSpool(db: DB, locationId: string): Promise<{ printed: number }> {
  const virtualPrinters = await db
    .select({ id: printers.id })
    .from(printers)
    .where(eq(printers.transport, "VIRTUAL"));
  if (virtualPrinters.length === 0) return { printed: 0 };
  const virtualIds = new Set(virtualPrinters.map((p) => p.id));

  const claimed = await claimJobs(db, locationId, { limit: 20 });
  let printed = 0;
  for (const job of claimed) {
    if (!job.printer_id || !virtualIds.has(job.printer_id)) {
      // Not ours — release the lease immediately so a real agent can claim it now.
      await db
        .update(printJobs)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(printJobs.id, job.id), eq(printJobs.leaseToken, job.lease_token)));
      continue;
    }
    await ackJobV2(db, {
      jobId: job.id,
      leaseToken: job.lease_token,
      result: "PRINTED",
      contentHash: job.content_hash,
    });
    printed += 1;
  }
  return { printed };
}
