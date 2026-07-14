/**
 * Async, bounded-retry, out-of-order-aware, replayable event processor
 * (spec §11). Runs entirely in-process: `processEvent` performs ONE
 * processing attempt per call. The webhook route (routes.ts) fires this
 * off, best-effort, right after intake acks; the admin reprocess endpoint
 * calls it directly (with `force: true`) for a deterministic, awaited
 * result.
 *
 * Listing resolution (spec §8): `(aggregator, external_merchant_id)` ->
 * exactly one active, RESOLVED, location-mapped `aggregator_account` row.
 * Zero or more-than-one matches both park the event MAPPING_REQUIRED — this
 * module never guesses. Once resolved, the ONLY thing that ever creates or
 * cancels an order is orders/service.ts `ingestOrder`/`cancelOrder` — this
 * module does not duplicate that logic (hard rule).
 */
import { and, eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { operationalFeatureFlags } from "../../db/enterprise-schema.js";
import { providerEvents, type ProviderEvent } from "../../db/middleware-schema.js";
import { aggregatorAccounts, orders } from "../../db/schema.js";
import {
  AmbiguousListingError,
  ListingMappingRequiredError,
  NotFoundError,
  ServiceError,
  cancelOrder,
  ingestOrder,
} from "../orders/service.js";
import { MiddlewareError } from "./errors.js";
import { findWaitingCancelEvent } from "./service.js";
import type { NormalizedOrderPayload } from "./types.js";

export const MIDDLEWARE_PROCESSING_FEATURE_KEY = "integration.middleware_processing";
export const MAX_PROCESSING_ATTEMPTS = 3;

/** Exponential-ish backoff in ms, deterministic and pure (easy to unit-reason about). */
export function backoffMs(attempts: number): number {
  return Math.min(attempts, MAX_PROCESSING_ATTEMPTS) ** 2 * 1000;
}

export interface ProcessEventOptions {
  /** Bypasses the nextAttemptAt backoff gate. The reprocess endpoint always sets this. */
  force?: boolean;
}

async function assertProcessingEnabled(db: DB): Promise<void> {
  const [flag] = await db
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, MIDDLEWARE_PROCESSING_FEATURE_KEY));
  if (!flag?.enabled) {
    throw new MiddlewareError(
      "FEATURE_DISABLED",
      `Operational feature "${MIDDLEWARE_PROCESSING_FEATURE_KEY}" is disabled.`,
      503,
      { feature: MIDDLEWARE_PROCESSING_FEATURE_KEY },
    );
  }
}

interface ResolvedListing {
  aggregatorAccountId: string;
  brandId: string;
}

/** §8 listing resolution: (aggregator, external_merchant_id) -> exactly one RESOLVED, location-mapped listing. */
async function resolveListing(
  db: DB,
  aggregator: ProviderEvent["aggregator"],
  merchantRef: string,
): Promise<ResolvedListing | null> {
  const candidates = await db
    .select({
      id: aggregatorAccounts.id,
      brandId: aggregatorAccounts.brandId,
      locationId: aggregatorAccounts.locationId,
      mappingStatus: aggregatorAccounts.mappingStatus,
    })
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.aggregator, aggregator),
        eq(aggregatorAccounts.externalMerchantId, merchantRef),
        eq(aggregatorAccounts.isActive, true),
      ),
    );
  const resolved = candidates.filter((c) => c.mappingStatus === "RESOLVED" && !!c.locationId);
  if (resolved.length !== 1) return null;
  return { aggregatorAccountId: resolved[0]!.id, brandId: resolved[0]!.brandId };
}

/** True for errors that mean "a human must fix a mapping" (never retried automatically). */
function isMappingError(err: unknown): boolean {
  return err instanceof NotFoundError || err instanceof AmbiguousListingError || err instanceof ListingMappingRequiredError;
}

async function markMappingRequired(db: DB, event: ProviderEvent, message: string): Promise<ProviderEvent> {
  const [updated] = await db
    .update(providerEvents)
    .set({ state: "MAPPING_REQUIRED", lastError: message, updatedAt: new Date() })
    .where(eq(providerEvents.id, event.id))
    .returning();
  return updated!;
}

async function markRetryOrFailed(db: DB, event: ProviderEvent, message: string): Promise<ProviderEvent> {
  const attempts = event.attempts + 1;
  const failed = attempts >= MAX_PROCESSING_ATTEMPTS;
  const [updated] = await db
    .update(providerEvents)
    .set({
      state: failed ? "FAILED" : "PENDING",
      attempts,
      lastError: message,
      nextAttemptAt: failed ? null : new Date(Date.now() + backoffMs(attempts)),
      updatedAt: new Date(),
    })
    .where(eq(providerEvents.id, event.id))
    .returning();
  return updated!;
}

async function markProcessed(db: DB, event: ProviderEvent, orderId: string): Promise<ProviderEvent> {
  const [updated] = await db
    .update(providerEvents)
    .set({ state: "PROCESSED", orderId, lastError: null, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(providerEvents.id, event.id))
    .returning();
  return updated!;
}

async function markWaitingDependency(db: DB, event: ProviderEvent, message: string): Promise<ProviderEvent> {
  const [updated] = await db
    .update(providerEvents)
    .set({ state: "WAITING_DEPENDENCY", lastError: message, updatedAt: new Date() })
    .where(eq(providerEvents.id, event.id))
    .returning();
  return updated!;
}

async function processOrderCreated(db: DB, event: ProviderEvent, listing: ResolvedListing): Promise<ProviderEvent> {
  const payload = event.redactedPayload as NormalizedOrderPayload;
  try {
    const result = await ingestOrder(
      db,
      {
        brand_id: listing.brandId,
        aggregator_account_id: listing.aggregatorAccountId,
        aggregator: event.aggregator,
        external_ref: payload.external_ref,
        ...(payload.customer_name !== undefined ? { customer_name: payload.customer_name } : {}),
        ...(payload.placed_at !== undefined ? { placed_at: payload.placed_at } : {}),
        items: payload.items,
      },
      {},
    );
    const processed = await markProcessed(db, event, result.order_id);

    // Out-of-order (spec §11): resolve any cancel that arrived before this create.
    const waitingCancel = await findWaitingCancelEvent(db, {
      aggregator: event.aggregator,
      merchantRef: event.merchantRef,
      externalRef: event.externalRef,
      excludeId: event.id,
    });
    if (waitingCancel) {
      await processEvent(db, waitingCancel.id, { force: true });
    }

    return processed;
  } catch (err) {
    if (isMappingError(err)) {
      return markMappingRequired(db, event, err instanceof Error ? err.message : String(err));
    }
    if (err instanceof ServiceError) {
      return markRetryOrFailed(db, event, err.message);
    }
    return markRetryOrFailed(db, event, err instanceof Error ? err.message : String(err));
  }
}

async function processOrderCancelled(db: DB, event: ProviderEvent, listing: ResolvedListing): Promise<ProviderEvent> {
  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.aggregatorAccountId, listing.aggregatorAccountId), eq(orders.externalRef, event.externalRef)));

  if (!order) {
    // Out-of-order: the matching ORDER_CREATED has not processed yet. Park —
    // resolved automatically when that create succeeds, or via reprocess.
    return markWaitingDependency(db, event, `No order found yet for external_ref "${event.externalRef}"; parked pending its ORDER_CREATED event.`);
  }

  if (order.status === "CANCELLED") {
    // Idempotent: the desired end-state is already true.
    return markProcessed(db, event, order.id);
  }

  try {
    await cancelOrder(db, order.id, `Cancelled via middleware webhook (provider_event ${event.id}).`);
    return markProcessed(db, event, order.id);
  } catch (err) {
    return markRetryOrFailed(db, event, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Performs one processing attempt for `eventId`. Never throws for ordinary
 * domain outcomes (mapping-required, waiting-dependency, retry, failed) —
 * those are all persisted state transitions on the returned row. Throws
 * {@link MiddlewareError} only for FEATURE_DISABLED / NOT_FOUND /
 * QUARANTINED_EVENT (caller-facing contract violations, not event outcomes).
 */
export async function processEvent(db: DB, eventId: string, options: ProcessEventOptions = {}): Promise<ProviderEvent> {
  const [event] = await db.select().from(providerEvents).where(eq(providerEvents.id, eventId));
  if (!event) {
    throw new MiddlewareError("NOT_FOUND", `Provider event ${eventId} not found.`, 404);
  }
  if (event.state === "QUARANTINED") {
    throw new MiddlewareError("QUARANTINED_EVENT", "A quarantined event cannot be processed.", 409);
  }
  if (event.state === "PROCESSED") {
    return event; // idempotent no-op — reprocessing an already-processed event is harmless.
  }
  if (event.state === "FAILED" && !options.force) {
    // Bounded retries (spec §11): a retry-exhausted event never re-enters normal
    // processing; only the explicit admin reprocess path (force: true) may replay it.
    return event;
  }

  await assertProcessingEnabled(db);

  if (!options.force && event.nextAttemptAt && event.nextAttemptAt.getTime() > Date.now()) {
    return event; // still inside its backoff window; not an error, just not eligible yet.
  }

  const listing = await resolveListing(db, event.aggregator, event.merchantRef);
  if (!listing) {
    return markMappingRequired(
      db,
      event,
      `No single active, resolved, location-mapped channel listing for aggregator ${event.aggregator} + external_merchant_id "${event.merchantRef}".`,
    );
  }

  if (event.kind === "ORDER_CREATED") {
    return processOrderCreated(db, event, listing);
  }
  return processOrderCancelled(db, event, listing);
}
