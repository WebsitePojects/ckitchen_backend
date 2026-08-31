/**
 * GrabFood Partner API inbound schema (partner-API-first go-live path).
 *
 * This is intentionally isolated from the existing outbound Grab adapter and
 * from the generic middleware webhook tables. Grab calls these endpoints on
 * ORION's partner-API side; ORION persists the notification before
 * acknowledging and only performs downstream effects when the payload can be
 * mapped safely without inventing fields absent from the real GrabFood API
 * v1.1.3 contract.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
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

export const grabPartnerReceiptRouteEnum = pgEnum("grab_partner_receipt_route", [
  "SUBMIT_ORDER",
  "PUSH_ORDER_STATE",
  "PUSH_INTEGRATION_STATUS",
  "MENU_SYNC_STATE",
  "PUSH_GRAB_MENU",
  "GET_MENU",
]);

export const grabPartnerReceiptStateEnum = pgEnum("grab_partner_receipt_state", [
  "PENDING",
  "PROCESSED",
  "WAITING_DEPENDENCY",
  "IGNORED",
  "FAILED",
]);

export const grabIntegrationStatusEnum = pgEnum("grab_integration_status", [
  "INACTIVE",
  "ACTIVE",
  "SYNCING",
  "FAILED",
]);

export const grabMenuSyncStatusEnum = pgEnum("grab_menu_sync_status", [
  "QUEUEING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
]);

/**
 * Durable, redacted event/receipt store for every inbound GrabFood Partner
 * API route (submit order, push order state, push integration status, menu
 * sync state, push Grab menu, get menu). `dedupe_key` is route-specific and
 * unique.
 *
 * Submit-order dedupe is listing-scoped on
 * `(aggregator_account_id, provider_order_id, is_mex_edit_order)` — NOT
 * `provider_order_id` alone. Grab's contract: "If the isMexEditOrder value
 * changes from false to true, this submit request is not considered a
 * duplicate request." A merchant-edited resubmission of the same orderID is
 * therefore a distinct, legitimate row, not a replay.
 *
 * Menu-sync-state dedupe additionally enforces Grab's explicit rule: "If two
 * requests contain the same requestID, only the first request should be
 * considered and later requests must be ignored or discarded" — enforced via
 * the partial unique index on `request_id` below, not just app logic.
 */
export const grabPartnerReceipts = pgTable(
  "grab_partner_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id").references(() => aggregatorAccounts.id),
    route: grabPartnerReceiptRouteEnum("route").notNull(),
    /** Grab's merchantID for this listing. */
    grabMerchantId: text("grab_merchant_id"),
    /** Our External Store ID (Grab calls it partnerMerchantID). */
    partnerMerchantId: text("partner_merchant_id"),
    /** Grab's orderID — present on SUBMIT_ORDER and PUSH_ORDER_STATE. */
    providerOrderId: text("provider_order_id"),
    /** Grab's shortOrderNumber — display only, never used for dedupe/routing. */
    shortOrderNumber: text("short_order_number"),
    /** menuSyncState requestID — Grab's explicit dedupe key for that route. */
    requestId: text("request_id"),
    /** menuSyncState jobID — correlates back to the sync job we asked for. */
    jobId: text("job_id"),
    dedupeKey: text("dedupe_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: grabPartnerReceiptStateEnum("state").notNull().default("PENDING"),
    redactedPayload: jsonb("redacted_payload").notNull().default(sql`'{}'::jsonb`),
    /**
     * SECURITY (rule 11, .claude/rules/idempotency-concurrency.md): full-fidelity
     * original request body, kept ONLY for reprocessing and support diagnosis.
     * On SUBMIT_ORDER it contains customer PII in `receiver` — name, phones,
     * address, virtualContact. This column MUST NEVER be returned by any API
     * response and MUST NEVER be logged. `redactedPayload` is the field safe
     * to expose/log.
     */
    rawPayload: jsonb("raw_payload").notNull().default(sql`'{}'::jsonb`),
    /**
     * Only meaningful on SUBMIT_ORDER. Part of the dedupe identity (see
     * table-level comment) — a resubmission with this flipped false -> true
     * is a legitimate edit, not a duplicate, per Grab's contract.
     */
    isMexEditOrder: boolean("is_mex_edit_order"),
    orderId: uuid("order_id").references(() => orders.id),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("grab_partner_receipt_dedupe_key_unique").on(table.dedupeKey),
    uniqueIndex("grab_partner_submit_order_listing_provider_order_unique")
      .on(table.aggregatorAccountId, table.providerOrderId, table.isMexEditOrder)
      .where(sql`${table.route} = 'SUBMIT_ORDER' AND ${table.providerOrderId} IS NOT NULL`),
    uniqueIndex("grab_partner_menu_sync_state_request_id_unique")
      .on(table.requestId)
      .where(sql`${table.route} = 'MENU_SYNC_STATE' AND ${table.requestId} IS NOT NULL`),
    index("grab_partner_receipt_account_route_idx").on(table.aggregatorAccountId, table.route),
    index("grab_partner_receipt_state_idx").on(table.state),
    index("grab_partner_receipt_provider_order_idx").on(table.providerOrderId),
    check("grab_partner_receipt_request_hash_len", sql`length(${table.requestHash}) = 64`),
    check("grab_partner_receipt_dedupe_key_nonempty", sql`length(${table.dedupeKey}) BETWEEN 1 AND 700`),
  ],
).enableRLS();

/**
 * Durable partnerMerchantID <-> grabMerchantID mapping, one row per channel
 * listing. Grab's merchantID is only ever delivered to us via the GetMenu
 * query params and the PushIntegrationStatus body — there is no "create
 * listing" call where we choose it — so this table is the sole durable
 * record of that mapping and of the self-serve activation status Grab
 * reports through PushIntegrationStatus.
 */
export const grabListingIntegrations = pgTable(
  "grab_listing_integration",
  {
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    /** Our External Store ID — the routing key Grab echoes back to us on every call. */
    partnerMerchantId: text("partner_merchant_id").notNull(),
    /** Grab's merchantID. Nullable until Grab tells us via GetMenu or PushIntegrationStatus. */
    grabMerchantId: text("grab_merchant_id"),
    integrationStatus: grabIntegrationStatusEnum("integration_status").notNull().default("INACTIVE"),
    lastStatusAt: timestamp("last_status_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregatorAccountId] }),
    uniqueIndex("grab_listing_integration_partner_merchant_id_unique").on(table.partnerMerchantId),
    index("grab_listing_integration_grab_merchant_id_idx").on(table.grabMerchantId),
    check(
      "grab_listing_integration_partner_merchant_id_len",
      sql`length(${table.partnerMerchantId}) BETWEEN 1 AND 64`,
    ),
  ],
).enableRLS();

/**
 * Tracks a menu sync we asked Grab for and Grab reports progress/result on
 * via the Menu Sync State webhook (dedup'd on requestID in
 * `grab_partner_receipt`, correlated back here by jobID).
 */
export const grabMenuSyncJobs = pgTable(
  "grab_menu_sync_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    jobId: text("job_id").notNull(),
    status: grabMenuSyncStatusEnum("status").notNull(),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    /** Grab's own `updatedAt` on the sync status, distinct from our row's updatedAt. */
    updatedAtRemote: timestamp("updated_at_remote", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("grab_menu_sync_job_account_job_unique").on(table.aggregatorAccountId, table.jobId),
    index("grab_menu_sync_job_status_idx").on(table.status),
  ],
).enableRLS();

export type GrabPartnerReceipt = typeof grabPartnerReceipts.$inferSelect;
export type NewGrabPartnerReceipt = typeof grabPartnerReceipts.$inferInsert;
export type GrabListingIntegration = typeof grabListingIntegrations.$inferSelect;
export type NewGrabListingIntegration = typeof grabListingIntegrations.$inferInsert;
export type GrabMenuSyncJob = typeof grabMenuSyncJobs.$inferSelect;
export type NewGrabMenuSyncJob = typeof grabMenuSyncJobs.$inferInsert;
