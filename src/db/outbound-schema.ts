/**
 * ORION outbound aggregator command schema (migration 0035,
 * AGGREGATOR_API_INTEGRATION_SPEC.md §4-5 — "Outbound: per-listing command
 * queue (accept/reject, mark-ready, ready-time, pause/resume, item
 * availability, menu notify) with idempotency keys, bounded retries, and a
 * full audit trail — the `AggregatorOutboundAdapter` interface; Grab/
 * foodpanda adapters implement it 1:1 from the tables above (a dummy adapter
 * proves the loop until credentials arrive).").
 *
 * Additive-only (migration 0035): one new table, `aggregator_command`, plus
 * two additive columns on the EXISTING `aggregator_account` table
 * (control_mode/api_merchant_id — defined directly on schema.ts's
 * `aggregatorAccounts`, mirroring how migration 0034 added print_job's v2
 * lease columns to schema.ts's existing `printJobs` table rather than a
 * parallel definition here). No existing row/behavior changes: control_mode
 * defaults 'DEVICE' (every listing keeps running on its merchant tablet/
 * phone until explicitly cut over) and the `integration.outbound_commands`
 * feature flag (seeded by this migration) defaults false.
 *
 * `aggregator_command` mirrors provider_event's role for the inbound side: a
 * single evolving row per command (not a separate immutable attempt-log
 * table like print_job_attempt) — `attempts`/`status`/`last_error` track the
 * append-only history of this command's send attempts, and `created_by` +
 * the `audit_log` insert in src/modules/outbound/service.ts give the actor
 * trail. Lease fields (`lease_owner`/`lease_until`) mirror the printing v2
 * conditional-UPDATE claim protocol (src/modules/printing/service-v2.ts) so
 * `processCommands` workers can never double-send the same command.
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
import { aggregatorAccounts, orders, users } from "./schema.js";

export const aggregatorCommandTypeEnum = pgEnum("aggregator_command_type", [
  "ACCEPT_ORDER",
  "REJECT_ORDER",
  "MARK_READY",
  "UPDATE_READY_TIME",
  "PAUSE_STORE",
  "RESUME_STORE",
  "SET_ITEM_AVAILABILITY",
  "NOTIFY_MENU_UPDATED",
]);

/**
 * PENDING — enqueued, not yet claimed by a worker (or eligible for retry).
 * CLAIMED — a DERIVED state at the query level (status='PENDING' AND
 *           lease_until > now()); stored here as a real enum value (unlike
 *           print_job's CLAIMED, which is purely derived) because the task
 *           spec calls for a real enum with no ALTER — processCommands sets
 *           it explicitly while a send attempt is in flight and always
 *           resolves it back to SENT/PENDING/FAILED/DEAD before returning.
 * SENT    — the adapter accepted the command (provider_ref recorded).
 * FAILED  — a retryable attempt failed; next_attempt_at gates the backoff
 *           window; re-enters PENDING's claimable pool once elapsed.
 * DEAD    — bounded retries exhausted; terminal, replayable only by a fresh
 *           enqueue (never auto-retried again).
 */
export const aggregatorCommandStatusEnum = pgEnum("aggregator_command_status", [
  "PENDING",
  "CLAIMED",
  "SENT",
  "FAILED",
  "DEAD",
]);

/**
 * One row per outbound command to an aggregator's Partner/POS API for a
 * channel listing (`aggregator_account`), optionally scoped to one order
 * (ACCEPT_ORDER/REJECT_ORDER/MARK_READY/UPDATE_READY_TIME are order-scoped;
 * PAUSE_STORE/RESUME_STORE/SET_ITEM_AVAILABILITY/NOTIFY_MENU_UPDATED are
 * listing-scoped, `order_id` NULL).
 */
export const aggregatorCommands = pgTable(
  "aggregator_command",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    orderId: uuid("order_id").references(() => orders.id),
    commandType: aggregatorCommandTypeEnum("command_type").notNull(),
    /** Command-type-specific body (e.g. { reason }, { ready_time }, { item_id, available }). */
    payload: jsonb("payload").notNull(),
    /** Caller-or-service-derived replay key (service.ts enqueueCommand); unique — a replay returns the existing row. */
    idempotencyKey: text("idempotency_key").notNull(),
    status: aggregatorCommandStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    /** Backoff gate for the next automatic claim attempt; NULL = eligible now. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Worker/process identity holding the current lease (printing v2 lease pattern). */
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    /** The aggregator's own response id for this command, once SENT. Never a credential. */
    providerRef: text("provider_ref"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("aggregator_command_idempotency_key_unique").on(table.idempotencyKey),
    // Out-of-order gate (enqueueCommand): "what is the latest command for this
    // (listing, order)?" — e.g. refusing ACCEPT_ORDER after REJECT_ORDER.
    index("aggregator_command_listing_order_idx").on(table.aggregatorAccountId, table.orderId),
    index("aggregator_command_order_id_idx").on(table.orderId),
    // Claim-eligible scan (processCommands): PENDING/FAILED rows whose backoff elapsed.
    index("aggregator_command_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    // Lapsed-lease sweep (mirrors print_job_lease_until_idx — partial, always small).
    index("aggregator_command_lease_until_idx").on(table.leaseUntil).where(sql`${table.leaseUntil} IS NOT NULL`),
    check("aggregator_command_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
).enableRLS();

export type AggregatorCommand = typeof aggregatorCommands.$inferSelect;
export type NewAggregatorCommand = typeof aggregatorCommands.$inferInsert;
