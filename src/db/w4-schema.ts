/**
 * ORION W4 client-rules foundation schema (spec `.claude/context/
 * enterprise-operations-foundation.md` §10 discounts/commercial-terms, mirrored
 * against §6/§7 order-line component snapshotting).
 *
 * Additive/dark: schema + migration only. No service/route wiring happens
 * here — later streams own the approval routing, evidence signed-URL access
 * flow, and commission/marketing-rate lookup-at-ingestion logic. This module
 * only introduces the two NEW tables that back that later work:
 *
 * - `discount_evidence_access_log`: append-only audit trail of every read of
 *   an `order_discount.evidence_ref` (spec §10: "every access is audited").
 * - `channel_commercial_term`: effective-dated BASE/MARKETING commission
 *   percent per channel listing (aggregator_account), with overlap
 *   prevention so two BASE terms (or two MARKETING terms) for the same
 *   listing can never have active date ranges that intersect (spec §10:
 *   "Effective periods cannot overlap").
 *
 * `order_discount.evidence_ref`, `order.commission_rate_snapshot`,
 * `order.marketing_rate_snapshot`, and `order_item.component_snapshot` are
 * plain additive columns on existing tables and stay in `schema.ts` next to
 * their tables, following the pattern `aggregator_account.commission_rate`
 * (0014) already set: a new nullable column lives with its table, a new
 * table family gets its own bounded schema module (transfer-orders-schema.ts,
 * customer-orders-schema.ts, ... this file).
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { orderDiscounts } from "./schema.js";
import { aggregatorAccounts, users } from "./schema.js";

// ---------------------------------------------------------------------------
// discount_evidence_access_log
// ---------------------------------------------------------------------------

/**
 * One row per read of an `order_discount.evidence_ref` (private storage key —
 * NEVER a public URL, spec §10). Append-only: `discount_evidence_access_log_
 * append_only` (migration 0032) forbids UPDATE/DELETE with the shared
 * `forbid_mutation()` trigger function (0009), same convention as
 * `stock_return_receipt_line` (0028) and `customer_order_fulfillment` (0030).
 * The actual short-lived signed-URL issuance flow is later streams' service
 * logic; this table only guarantees every access attempt that reaches it is
 * durably and immutably recorded.
 */
export const discountEvidenceAccessLogs = pgTable(
  "discount_evidence_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderDiscountId: uuid("order_discount_id")
      .notNull()
      .references(() => orderDiscounts.id),
    accessedBy: uuid("accessed_by")
      .notNull()
      .references(() => users.id),
    purpose: text("purpose").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("discount_evidence_access_log_order_discount_id_idx").on(table.orderDiscountId),
    index("discount_evidence_access_log_accessed_by_idx").on(table.accessedBy),
  ],
).enableRLS();

export type DiscountEvidenceAccessLog = typeof discountEvidenceAccessLogs.$inferSelect;
export type NewDiscountEvidenceAccessLog = typeof discountEvidenceAccessLogs.$inferInsert;

// ---------------------------------------------------------------------------
// channel_commercial_term
// ---------------------------------------------------------------------------

export const channelCommercialTermRateTypeEnum = pgEnum("channel_commercial_term_rate_type", [
  "BASE",
  "MARKETING",
]);

/**
 * Effective-dated commercial rate for one channel listing (spec §10: "Foodpanda
 * initial configurable base commission: 25%. GrabFood initial configurable base
 * commission: 30%. Marketing rate is a separate adjustable effective-dated
 * percentage. Effective periods cannot overlap.").
 *
 * Overlap prevention is a DB-level `EXCLUDE USING gist` constraint (migration
 * 0032, `channel_commercial_term_no_overlap`) on
 * `(aggregator_account_id, rate_type, daterange(effective_from,
 * coalesce(effective_to, 'infinity'), '[]'))` — requires the `btree_gist`
 * extension (loaded via PGlite `extensions: { btree_gist }` in client.ts for
 * the test harness / local PGlite dev path; a standard contrib extension
 * already available on Supabase-managed Postgres for production). This keeps
 * the invariant enforced even against a caller that bypasses the service
 * layer, matching how `warehouse_single_hq_main_unique` (0027) pins a
 * business rule at the DB layer rather than trusting service code alone.
 *
 * `effective_to` NULL = open-ended (still in effect). Orders snapshot the
 * applicable term into `order.commission_rate_snapshot` /
 * `order.marketing_rate_snapshot` at ingestion — reports never recompute
 * history from this table's current rows (spec §10: "Orders snapshot the
 * applicable terms and reports never recompute history from current
 * settings"). That snapshot-at-ingestion logic is later streams' service
 * work; this table only stores the effective-dated rate history.
 */
export const channelCommercialTerms = pgTable(
  "channel_commercial_term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    rateType: channelCommercialTermRateTypeEnum("rate_type").notNull(),
    percent: numeric("percent", { precision: 5, scale: 2 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** NULL = open-ended (no end date yet). */
    effectiveTo: date("effective_to"),
    createdBy: uuid("created_by").references(() => users.id),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("channel_commercial_term_aggregator_account_id_idx").on(table.aggregatorAccountId),
    index("channel_commercial_term_aggregator_rate_type_idx").on(
      table.aggregatorAccountId,
      table.rateType,
    ),
    check("channel_commercial_term_percent_range", sql`${table.percent} >= 0 AND ${table.percent} <= 100`),
    check("channel_commercial_term_version_positive", sql`${table.version} > 0`),
    check(
      "channel_commercial_term_effective_to_after_from",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    // NOTE: the overlap-prevention `EXCLUDE USING gist` constraint
    // (`channel_commercial_term_no_overlap`) is added in raw SQL in migration
    // 0032, not here — drizzle-orm's pg-core table builder has no `exclude()`
    // helper as of this repo's drizzle-orm version, the same reason
    // `qa_release_route_check` / `transfer_order_line_posting_append_only`
    // (0031) exist only as raw-SQL triggers with no drizzle-side counterpart.
    // The migration SQL is the source of truth for that constraint.
  ],
).enableRLS();

export type ChannelCommercialTerm = typeof channelCommercialTerms.$inferSelect;
export type NewChannelCommercialTerm = typeof channelCommercialTerms.$inferInsert;
