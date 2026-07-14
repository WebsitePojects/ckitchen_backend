/**
 * ORION middleware integration schema (spec `.claude/context/
 * enterprise-operations-foundation.md` §11 — "The dummy and eventual live
 * provider use the same adapter interface. Webhook intake verifies exact raw
 * bytes, timestamp, key ID, and signature before parsing; it persists a
 * unique provider event, raw hash, redacted/encrypted payload reference, and
 * processing state before acknowledging.").
 *
 * Additive-only (migration 0033): one new table, `provider_event`. No
 * existing table is touched. The `integration.middleware_processing` feature
 * flag already exists from migration 0027's operational_feature_flag seed
 * and is reused as-is by src/modules/middleware/processor.ts.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aggregatorEnum, orders } from "./schema.js";

export const providerEventKindEnum = pgEnum("provider_event_kind", [
  "ORDER_CREATED",
  "ORDER_CANCELLED",
]);

/**
 * PENDING            — persisted, not yet processed (or eligible for retry).
 * PROCESSING         — reserved for a future concurrent-worker guard; this
 *                       stream's in-process processor runs one event at a
 *                       time inside its own transaction and does not
 *                       currently leave a row parked here.
 * PROCESSED          — ingestOrder (or the linked cancelOrder) succeeded.
 * MAPPING_REQUIRED   — unknown channel listing or menu item mapping (DLQ).
 * WAITING_DEPENDENCY — an ORDER_CANCELLED arrived before its ORDER_CREATED.
 * FAILED             — bounded retries exhausted; replayable via reprocess.
 * QUARANTINED        — same provider_event_id replayed with a different raw
 *                       hash (tamper/integrity concern); never processed.
 */
export const providerEventStateEnum = pgEnum("provider_event_state", [
  "PENDING",
  "PROCESSING",
  "PROCESSED",
  "MAPPING_REQUIRED",
  "WAITING_DEPENDENCY",
  "FAILED",
  "QUARANTINED",
]);

/**
 * One row per inbound middleware webhook event, keyed by
 * `(provider, provider_event_id)`. Persisted BEFORE the webhook is
 * acknowledged (src/modules/middleware/service.ts `intakeEvent`) so a crash
 * between verification and ack can never silently drop a delivery. `state`
 * tracks the async processor's progress (src/modules/middleware/
 * processor.ts); `redacted_payload` stores only the normalized fields
 * `ingestOrder` needs (never the provider's raw arbitrary payload) and
 * `raw_hash` (sha256 of the exact raw request bytes) is what distinguishes an
 * idempotent replay from a hash-mismatched quarantine case.
 */
export const providerEvents = pgTable(
  "provider_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Middleware vendor identity, e.g. "DUMMY" (later: "DELIVERECT" etc). */
    provider: text("provider").notNull(),
    /** The provider's own event/message id — the idempotency anchor. */
    providerEventId: text("provider_event_id").notNull(),
    kind: providerEventKindEnum("kind").notNull(),
    state: providerEventStateEnum("state").notNull().default("PENDING"),
    /** sha256 hex digest of the exact raw request bytes, computed pre-parse. */
    rawHash: text("raw_hash").notNull(),
    /** Non-secret signing-key identifier from the request header (never the secret itself). */
    keyId: text("key_id").notNull(),
    aggregator: aggregatorEnum("aggregator").notNull(),
    /** external_merchant_id — half of the §8 channel listing identity. */
    merchantRef: text("merchant_ref").notNull(),
    /** The order's external_ref, as ingestOrder expects it. */
    externalRef: text("external_ref").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Normalized, redacted order payload — only the fields ingestOrder needs. */
    redactedPayload: jsonb("redacted_payload").notNull(),
    orderId: uuid("order_id").references(() => orders.id),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Backoff gate for automatic (non-forced) retry attempts; NULL = eligible now. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_event_provider_event_id_unique").on(table.provider, table.providerEventId),
    index("provider_event_state_next_attempt_idx").on(table.state, table.nextAttemptAt),
    index("provider_event_listing_ref_idx").on(table.aggregator, table.merchantRef, table.externalRef),
    index("provider_event_order_id_idx").on(table.orderId),
    index("provider_event_received_at_idx").on(table.receivedAt.desc()),
    check("provider_event_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
).enableRLS();

export type ProviderEvent = typeof providerEvents.$inferSelect;
export type NewProviderEvent = typeof providerEvents.$inferInsert;
