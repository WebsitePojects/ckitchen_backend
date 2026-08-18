/**
 * Foodpanda / Delivery Hero POS Plugin API inbound schema (Phase 2).
 *
 * This is intentionally isolated from the existing outbound Foodpanda adapter
 * and from the generic middleware webhook tables. Delivery Hero calls these
 * endpoints on ORION's POS-plugin side; ORION persists the notification before
 * acknowledging and only performs downstream effects when the payload can be
 * mapped safely without inventing absent pluginOrder.yaml fields.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aggregatorAccounts, orders } from "./schema.js";

export const foodpandaPluginReceiptRouteEnum = pgEnum("foodpanda_plugin_receipt_route", [
  "ORDER_DISPATCH",
  "ORDER_STATUS",
  "AVAILABILITY",
  "MENU_IMPORT_TRIGGER",
  "CATALOG_IMPORT_CALLBACK",
]);

export const foodpandaPluginReceiptStateEnum = pgEnum("foodpanda_plugin_receipt_state", [
  "PENDING",
  "PROCESSED",
  "WAITING_DEPENDENCY",
  "IGNORED",
  "FAILED",
]);

export const foodpandaPluginOutboundTaskTypeEnum = pgEnum("foodpanda_plugin_outbound_task_type", [
  "ORDER_ACCEPT_REJECT_DECISION",
]);

export const foodpandaPluginOutboundTaskStatusEnum = pgEnum("foodpanda_plugin_outbound_task_status", [
  "PENDING",
  "CLAIMED",
  "DONE",
  "FAILED",
  "DEAD",
]);

/**
 * Durable, redacted event/receipt store for every inbound Foodpanda Plugin API
 * route. `dedupe_key` is route-specific and unique; dispatch also has a
 * listing-scoped `(aggregator_account_id, provider_order_id)` partial unique
 * index because Delivery Hero retries must return the same durable
 * remoteOrderId for the same listing/order identity.
 *
 * `provider_order_id` stores pluginOrder.yaml's **`token`** — "Unique
 * identifier of the order in POS middleware" — NOT the platform-facing
 * `code`. `token` is the dedupe key material and the identifier used for the
 * outbound `/v2/order/status/{orderToken}` accept/reject call; `code` (the
 * platform-side order id, e.g. "n0s1-w0k1") is a distinct field kept in
 * `platform_order_code` for display/support purposes only.
 */
export const foodpandaPluginReceipts = pgTable(
  "foodpanda_plugin_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id").references(() => aggregatorAccounts.id),
    route: foodpandaPluginReceiptRouteEnum("route").notNull(),
    remoteId: text("remote_id"),
    /** pluginOrder.yaml `Token` — see table-level comment. Dedupe + outbound key. */
    providerOrderId: text("provider_order_id"),
    remoteOrderId: text("remote_order_id"),
    dedupeKey: text("dedupe_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: foodpandaPluginReceiptStateEnum("state").notNull().default("PENDING"),
    redactedPayload: jsonb("redacted_payload").notNull().default(sql`'{}'::jsonb`),
    /** pluginOrder.yaml `Code` — the platform-side order id (e.g. "n0s1-w0k1"). Display-only, never used for dedupe/outbound routing. */
    platformOrderCode: text("platform_order_code"),
    /** Full pluginOrder.yaml `CallbackUrls` object — required to accept/reject a Direct-integration order. Never returned by any API response (may embed an order-scoped secret in its query string). */
    callbackUrls: jsonb("callback_urls"),
    /** pluginOrder.yaml `ExpiryDate` — hard accept/reject deadline; missing it repeatedly auto-closes the vendor. Indexed for the deadline sweep (see below). */
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    /** Order-level resolution of pluginOrder.yaml `ItemUnavailabilityHandling` across products + toppings, CANCEL_ORDER-precedence applied (validation.ts resolveItemUnavailabilityHandling). Null when no item on the order carries one. */
    itemUnavailabilityHandling: text("item_unavailability_handling"),
    /**
     * SECURITY (rule 11, .claude/rules/idempotency-concurrency.md): full-fidelity
     * original request body, kept ONLY for reprocessing (worker.ts product
     * mapping) and support diagnosis. It contains customer PII — name, phone,
     * delivery address (pluginOrder.yaml `Customer`/`DeliveryAddress`). This
     * column MUST NEVER be returned by any API response and MUST NEVER be
     * logged. `redactedPayload` is the field safe to expose/log.
     */
    rawPayload: jsonb("raw_payload").notNull().default(sql`'{}'::jsonb`),
    orderId: uuid("order_id").references(() => orders.id),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("foodpanda_plugin_receipt_dedupe_key_unique").on(table.dedupeKey),
    uniqueIndex("foodpanda_plugin_dispatch_listing_provider_order_unique")
      .on(table.aggregatorAccountId, table.providerOrderId)
      .where(sql`${table.route} = 'ORDER_DISPATCH' AND ${table.providerOrderId} IS NOT NULL`),
    index("foodpanda_plugin_receipt_remote_order_idx").on(table.remoteOrderId),
    index("foodpanda_plugin_receipt_account_route_idx").on(table.aggregatorAccountId, table.route),
    index("foodpanda_plugin_receipt_state_idx").on(table.state),
    // Deadline sweep: only undispatched-decision dispatch receipts matter — a
    // human/worker needs to accept/reject before expiry_date or Delivery Hero
    // auto-cancels the order and repeated misses close the vendor.
    index("foodpanda_plugin_receipt_expiry_sweep_idx")
      .on(table.expiryDate)
      .where(sql`${table.route} = 'ORDER_DISPATCH' AND ${table.state} <> 'PROCESSED'`),
    check("foodpanda_plugin_receipt_request_hash_len", sql`length(${table.requestHash}) = 64`),
    check("foodpanda_plugin_receipt_dedupe_key_nonempty", sql`length(${table.dedupeKey}) BETWEEN 1 AND 700`),
  ],
).enableRLS();

/** Current Foodpanda vendor availability snapshot per channel listing. */
export const foodpandaListingAvailability = pgTable(
  "foodpanda_listing_availability",
  {
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    remoteId: text("remote_id").notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
    requestHash: text("request_hash").notNull(),
    closures: jsonb("closures").notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregatorAccountId] }),
    index("foodpanda_listing_availability_timestamp_idx").on(table.eventTimestamp),
    check("foodpanda_listing_availability_request_hash_len", sql`length(${table.requestHash}) = 64`),
  ],
).enableRLS();

/**
 * Queue-backed placeholder for the future accept/reject callback to Delivery
 * Hero. Phase 2 only enqueues the durable decision task; no network worker is
 * mounted here.
 */
export const foodpandaPluginOutboundTasks = pgTable(
  "foodpanda_plugin_outbound_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => foodpandaPluginReceipts.id),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    remoteOrderId: text("remote_order_id").notNull(),
    taskType: foodpandaPluginOutboundTaskTypeEnum("task_type").notNull(),
    status: foodpandaPluginOutboundTaskStatusEnum("status").notNull().default("PENDING"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("foodpanda_plugin_outbound_task_receipt_type_unique").on(table.receiptId, table.taskType),
    index("foodpanda_plugin_outbound_task_status_next_idx").on(table.status, table.nextAttemptAt),
    check("foodpanda_plugin_outbound_task_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
).enableRLS();

export type FoodpandaPluginReceipt = typeof foodpandaPluginReceipts.$inferSelect;
export type NewFoodpandaPluginReceipt = typeof foodpandaPluginReceipts.$inferInsert;
export type FoodpandaListingAvailability = typeof foodpandaListingAvailability.$inferSelect;
export type FoodpandaPluginOutboundTask = typeof foodpandaPluginOutboundTasks.$inferSelect;
