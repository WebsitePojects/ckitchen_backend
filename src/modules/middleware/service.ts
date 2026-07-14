/**
 * Webhook intake persistence (spec §11: "it persists a unique provider
 * event, raw hash, redacted/encrypted payload reference, and processing
 * state before acknowledging. Duplicate event ID + same hash is an
 * idempotent replay; a different hash is quarantined.").
 *
 * This module owns ONLY the persist-before-ack step. Signature/timestamp
 * verification happens in routes.ts (before this is ever called); resolving
 * a channel listing and calling orders/service.ts `ingestOrder` happens in
 * processor.ts (after ack, on its own schedule).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { providerEvents, type ProviderEvent } from "../../db/middleware-schema.js";
import type { NormalizedProviderEvent } from "./types.js";

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type IntakeOutcome = "CREATED" | "DUPLICATE" | "QUARANTINED";

export interface IntakeResult {
  event: ProviderEvent;
  outcome: IntakeOutcome;
}

export interface IntakeInput {
  provider: string;
  normalized: NormalizedProviderEvent;
  rawHash: string;
  keyId: string;
}

/**
 * Upserts the provider event row inside one transaction, so the row is
 * durably committed before the route ever sends an HTTP response (hard rule:
 * "intake persists BEFORE ack").
 *
 * - No existing row for (provider, providerEventId) -> INSERT state=PENDING,
 *   outcome "CREATED" (202 ack).
 * - Existing row, same rawHash -> no write, outcome "DUPLICATE" (200 ack,
 *   idempotent replay, no processing re-triggered by the route).
 * - Existing row, different rawHash -> UPDATE state=QUARANTINED, outcome
 *   "QUARANTINED" (200 ack, never processed).
 */
export async function intakeEvent(db: DB, input: IntakeInput): Promise<IntakeResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.provider, input.provider), eq(providerEvents.providerEventId, input.normalized.providerEventId)))
      .for("update");

    if (existing) {
      if (existing.rawHash === input.rawHash) {
        return { event: existing, outcome: "DUPLICATE" as const };
      }
      const [updated] = await tx
        .update(providerEvents)
        .set({
          state: "QUARANTINED",
          lastError: `Replay of provider_event_id "${input.normalized.providerEventId}" arrived with a different raw hash (expected ${existing.rawHash}, got ${input.rawHash}).`,
          updatedAt: new Date(),
        })
        .where(eq(providerEvents.id, existing.id))
        .returning();
      return { event: updated!, outcome: "QUARANTINED" as const };
    }

    const [created] = await tx
      .insert(providerEvents)
      .values({
        provider: input.provider,
        providerEventId: input.normalized.providerEventId,
        kind: input.normalized.kind,
        state: "PENDING",
        rawHash: input.rawHash,
        keyId: input.keyId,
        aggregator: input.normalized.aggregator,
        merchantRef: input.normalized.merchantRef,
        externalRef: input.normalized.orderPayload.external_ref,
        occurredAt: new Date(input.normalized.occurredAt),
        redactedPayload: input.normalized.orderPayload,
      })
      .returning();
    return { event: created!, outcome: "CREATED" as const };
  });
}

export async function getEventById(db: DB, id: string): Promise<ProviderEvent | undefined> {
  const [row] = await db.select().from(providerEvents).where(eq(providerEvents.id, id));
  return row;
}

export interface ListEventsInput {
  state?: ProviderEvent["state"];
  limit: number;
  offset: number;
}

export async function listEvents(db: DB, input: ListEventsInput): Promise<{ items: ProviderEvent[]; total: number }> {
  const whereClause = input.state ? eq(providerEvents.state, input.state) : undefined;
  const items = await db
    .select()
    .from(providerEvents)
    .where(whereClause)
    .orderBy(desc(providerEvents.receivedAt))
    .limit(input.limit)
    .offset(input.offset);
  const totalRows = await db.select({ id: providerEvents.id }).from(providerEvents).where(whereClause);
  return { items, total: totalRows.length };
}

/**
 * Finds a WAITING_DEPENDENCY ORDER_CANCELLED event parked for the same
 * (aggregator, merchantRef, externalRef) triple — used by the processor to
 * auto-resolve an out-of-order cancel once its matching create succeeds
 * (spec §11: "resolved on later create or reprocess").
 */
export async function findWaitingCancelEvent(
  db: DB,
  params: { aggregator: ProviderEvent["aggregator"]; merchantRef: string; externalRef: string; excludeId: string },
): Promise<ProviderEvent | undefined> {
  const [row] = await db
    .select()
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.aggregator, params.aggregator),
        eq(providerEvents.merchantRef, params.merchantRef),
        eq(providerEvents.externalRef, params.externalRef),
        eq(providerEvents.kind, "ORDER_CANCELLED"),
        eq(providerEvents.state, "WAITING_DEPENDENCY"),
      ),
    )
    .orderBy(providerEvents.receivedAt)
    .limit(1);
  return row;
}

/** Rows eligible for an automatic (non-forced) processing pass: backoff window elapsed or unset. */
export async function listAutoEligibleEvents(db: DB, now: Date, limit: number): Promise<ProviderEvent[]> {
  return db
    .select()
    .from(providerEvents)
    .where(
      and(
        or(eq(providerEvents.state, "PENDING"), eq(providerEvents.state, "WAITING_DEPENDENCY")),
        or(isNull(providerEvents.nextAttemptAt), lte(providerEvents.nextAttemptAt, now)),
      ),
    )
    .orderBy(providerEvents.receivedAt)
    .limit(limit);
}
