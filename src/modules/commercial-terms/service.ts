/**
 * Channel Commercial Terms — resolution logic (spec §10, W4 audit gaps
 * B2/B3/B4). `channel_commercial_term` (src/db/w4-schema.ts, migration 0032)
 * stores effective-dated BASE/MARKETING commission percents per channel
 * listing (aggregator_account), with a DB-level EXCLUDE USING gist
 * constraint (`channel_commercial_term_no_overlap`) preventing two active
 * BASE terms (or two MARKETING terms) for the same listing from overlapping.
 *
 * This file holds the ONE piece of logic reused outside this module's own
 * Router: `resolveCommercialTermSnapshots`, called from
 * `src/modules/orders/service.ts` (`ingestOrder`) to freeze the applicable
 * BASE + MARKETING rate into `order.commission_rate_snapshot` /
 * `order.marketing_rate_snapshot` at order-placement time (never
 * recomputed later — B4). CRUD for the `channel_commercial_term` catalog
 * itself lives in `routes.ts`, following this codebase's small-module
 * convention (`src/modules/discounts/routes.ts` folds catalog CRUD directly
 * into the router; this module splits out only the cross-module resolver so
 * orders/service.ts doesn't need to import an Express Router).
 */
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { channelCommercialTerms, type ChannelCommercialTerm } from "../../db/w4-schema.js";

export type CommercialTermRateType = ChannelCommercialTerm["rateType"];

export interface CommercialTermSnapshots {
  /** BASE commission percent snapshot, numeric-string (e.g. "25.00") or NULL. */
  commissionRateSnapshot: string | null;
  /** MARKETING rate percent snapshot, numeric-string or NULL. */
  marketingRateSnapshot: string | null;
}

/** `date` columns come back as plain "YYYY-MM-DD" strings (no `mode` set on the drizzle column) — lexicographic comparison is valid for that format. */
function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Picks the single term row of `rateType` whose [effective_from, effective_to]
 * range covers `dateStr`. The DB exclusion constraint guarantees at most one
 * such row can ever exist per (listing, rate_type) — the sort+take-first is
 * defensive only (never expected to matter).
 */
function pickApplicable(
  rows: ChannelCommercialTerm[],
  rateType: CommercialTermRateType,
  dateStr: string,
): string | null {
  const candidates = rows.filter(
    (r) =>
      r.rateType === rateType &&
      r.effectiveFrom <= dateStr &&
      (r.effectiveTo === null || r.effectiveTo >= dateStr),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0]!.percent;
}

/**
 * Resolves the BASE + MARKETING commercial-term snapshot for one channel
 * listing at `atDate` (the order's placed_at, NOT "today" — B4: history must
 * never be recomputed from current settings).
 *
 * Bridge (documented, spec §10 "fallback"): when the listing has ZERO
 * `channel_commercial_term` rows at all (client hasn't back-filled term
 * history for this listing yet), BASE falls back to the legacy
 * `aggregator_account.commission_rate` column (pass it in as
 * `legacyCommissionRate`); MARKETING has no legacy equivalent and stays
 * NULL. Once ANY term row exists for the listing, the bridge no longer
 * applies — a coverage gap for a specific date is then a genuine finance
 * exception (NULL), never silently defaulted to 0 or to the legacy rate
 * (hard rule: snapshots never invent a number).
 */
export async function resolveCommercialTermSnapshots(
  db: DB,
  aggregatorAccountId: string,
  atDate: Date,
  legacyCommissionRate: string | null,
): Promise<CommercialTermSnapshots> {
  const rows = await db
    .select()
    .from(channelCommercialTerms)
    .where(eq(channelCommercialTerms.aggregatorAccountId, aggregatorAccountId));

  if (rows.length === 0) {
    return { commissionRateSnapshot: legacyCommissionRate ?? null, marketingRateSnapshot: null };
  }

  const dateStr = toDateOnly(atDate);
  return {
    commissionRateSnapshot: pickApplicable(rows, "BASE", dateStr),
    marketingRateSnapshot: pickApplicable(rows, "MARKETING", dateStr),
  };
}
