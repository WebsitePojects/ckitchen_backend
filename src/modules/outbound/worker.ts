/**
 * Outbound command worker — race-safe claim-lease loop (mirrors src/modules/
 * printing/service-v2.ts's claimJobs/ackJobV2 conditional-UPDATE lease
 * protocol) combined with bounded-retry backoff (mirrors src/modules/
 * middleware/processor.ts's backoffMs/MAX_PROCESSING_ATTEMPTS).
 *
 *   PENDING ──claim──▶ CLAIMED ──send──▶ SENT | PENDING (retry) | DEAD
 *
 * `processCommands` does claim + send + resolve in one call so it can be
 * driven either by a future interval scheduler or directly from a test —
 * this stream wires no scheduler (out of scope; AGGREGATOR_API_INTEGRATION_
 * SPEC.md's route list has no "run the worker now" endpoint), so tests
 * invoke it directly, same as middleware's processEvent().
 *
 * Race safety: claim is a conditional UPDATE (`WHERE id=... AND (status=
 * 'PENDING' OR (status='CLAIMED' AND lease_until<=now()))`) — two concurrent
 * callers racing the same row each attempt the UPDATE, but only one's WHERE
 * clause still matches once the other's UPDATE has committed, so `.returning()`
 * yields a row for exactly one caller (Postgres row-level locking during the
 * UPDATE serializes the race; no SELECT...FOR UPDATE needed, identical to
 * claimJobs's proven pattern).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { aggregatorCommands, type AggregatorCommand } from "../../db/outbound-schema.js";
import { aggregatorAccounts, orders } from "../../db/schema.js";
import { DEFAULT_LEASE_SECONDS, MAX_SEND_ATTEMPTS, outboundBackoffMs } from "./policies.js";
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "./types.js";

function leaseExpiry(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** Rows eligible for a claim attempt right now: fresh PENDING (backoff elapsed) or a lapsed CLAIMED lease. */
function claimableWhere() {
  const now = new Date();
  return or(
    and(eq(aggregatorCommands.status, "PENDING"), or(isNull(aggregatorCommands.nextAttemptAt), lte(aggregatorCommands.nextAttemptAt, now))),
    and(eq(aggregatorCommands.status, "CLAIMED"), lte(aggregatorCommands.leaseUntil, now)),
  );
}

export interface ProcessCommandsOptions {
  /** Identifies which worker instance holds a lease; defaults to a fresh random id per call. */
  leaseOwner?: string;
  limit?: number;
  leaseSeconds?: number;
}

export interface ProcessCommandsResult {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Claims up to `limit` eligible commands (oldest first) and attempts to send
 * each through `adapter`. A command exhausted at MAX_SEND_ATTEMPTS, or
 * failed with a TERMINAL result, is forced DEAD; otherwise it re-enters the
 * claimable pool after an exponential backoff.
 */
export async function processCommands(
  db: DB,
  adapter: AggregatorOutboundAdapter,
  opts: ProcessCommandsOptions = {},
): Promise<ProcessCommandsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 5), 300);
  const leaseOwner = opts.leaseOwner ?? `worker-${randomUUID()}`;

  const candidates = await db
    .select({ id: aggregatorCommands.id })
    .from(aggregatorCommands)
    .where(claimableWhere())
    .orderBy(asc(aggregatorCommands.createdAt))
    .limit(limit);

  const result: ProcessCommandsResult = { claimed: 0, sent: 0, retried: 0, dead: 0 };

  for (const { id } of candidates) {
    const claimed = await claimOne(db, id, leaseOwner, leaseSeconds);
    if (!claimed) continue; // lost the race to a concurrent worker — fine.
    result.claimed += 1;

    const outcome = await sendOne(db, adapter, claimed, leaseOwner);
    if (outcome === "SENT") result.sent += 1;
    else if (outcome === "DEAD") result.dead += 1;
    else result.retried += 1;
  }

  return result;
}

async function claimOne(db: DB, id: string, leaseOwner: string, leaseSeconds: number): Promise<AggregatorCommand | null> {
  const now = new Date();
  const until = leaseExpiry(leaseSeconds);
  const [row] = await db
    .update(aggregatorCommands)
    .set({ status: "CLAIMED", leaseOwner, leaseUntil: until, updatedAt: now })
    .where(
      and(
        eq(aggregatorCommands.id, id),
        or(
          and(eq(aggregatorCommands.status, "PENDING"), or(isNull(aggregatorCommands.nextAttemptAt), lte(aggregatorCommands.nextAttemptAt, now))),
          and(eq(aggregatorCommands.status, "CLAIMED"), lte(aggregatorCommands.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

async function sendOne(
  db: DB,
  adapter: AggregatorOutboundAdapter,
  command: AggregatorCommand,
  leaseOwner: string,
): Promise<"SENT" | "RETRIED" | "DEAD"> {
  const [account] = await db
    .select({ apiMerchantId: aggregatorAccounts.apiMerchantId })
    .from(aggregatorAccounts)
    .where(eq(aggregatorAccounts.id, command.aggregatorAccountId));

  let externalRef: string | null = null;
  if (command.orderId) {
    const [order] = await db.select({ externalRef: orders.externalRef }).from(orders).where(eq(orders.id, command.orderId));
    externalRef = order?.externalRef ?? null;
  }

  const attemptNo = command.attempts + 1;
  const request: OutboundCommandRequest = {
    commandId: command.id,
    commandType: command.commandType,
    apiMerchantId: account?.apiMerchantId ?? null,
    externalRef,
    payload: command.payload,
    attempt: attemptNo,
  };

  let sendResult: OutboundSendResult;
  try {
    sendResult = await adapter.sendCommand(request);
  } catch (err) {
    sendResult = { ok: false, kind: "RETRYABLE", message: err instanceof Error ? err.message : String(err) };
  }

  // Conditional resolve: only the caller still holding the exact live lease
  // may resolve the row (mirrors printing v2's ackJobV2 lease-token check).
  if (sendResult.ok) {
    await db
      .update(aggregatorCommands)
      .set({
        status: "SENT",
        attempts: attemptNo,
        providerRef: sendResult.providerRef ?? null,
        lastError: null,
        nextAttemptAt: null,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(and(eq(aggregatorCommands.id, command.id), eq(aggregatorCommands.leaseOwner, leaseOwner)));
    return "SENT";
  }

  const exhausted = sendResult.kind === "TERMINAL" || attemptNo >= MAX_SEND_ATTEMPTS;
  await db
    .update(aggregatorCommands)
    .set({
      status: exhausted ? "DEAD" : "PENDING",
      attempts: attemptNo,
      lastError: sendResult.message,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + outboundBackoffMs(attemptNo)),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(aggregatorCommands.id, command.id), eq(aggregatorCommands.leaseOwner, leaseOwner)));
  return exhausted ? "DEAD" : "RETRIED";
}
