/**
 * GrabFood Partner API submit-order worker (src/modules/grab/worker.ts).
 *
 * service.ts's handleSubmitOrder ONLY persists a PENDING grab_partner_receipt
 * (route=SUBMIT_ORDER) — Grab's contract just wants a fast 2XX ack. This file
 * is the asynchronous step: map items[] to ORION menu items and ingest
 * through the existing orders/service.ts (same reuse rule as
 * src/modules/foodpanda/worker.ts).
 *
 * ADAPTED CLAIM PROTOCOL — READ THIS BEFORE CHANGING ANYTHING. Unlike
 * foodpanda_plugin_outbound_task, grab_partner_receipt (src/db/grab-schema.ts,
 * DONE/locked for this build) has NO lease_owner / lease_until / attempts /
 * next_attempt_at columns — there is no separate outbound-task queue table
 * for Grab, only the receipt row itself. The claim is therefore a single
 * conditional UPDATE keyed on `WHERE id = ? AND state = 'PENDING'`:
 * whichever caller's UPDATE actually changes the row wins (Postgres
 * row-level locking serializes concurrent UPDATEs to the same row; the
 * loser's WHERE clause no longer matches once the winner commits, so it
 * affects 0 rows and is a clean no-op — never a double effect). Because
 * ingestOrder ALSO enforces its own (aggregator_account_id, external_ref)
 * uniqueness (business rule 5), two callers racing all the way to
 * ingestOrder still cannot create two orders — the loser gets back the SAME
 * order via ingestOrder's own duplicate-detection path.
 *
 * Because there is no attempts/backoff column to persist across process
 * restarts, this worker makes exactly ONE pass per PENDING receipt per
 * invocation and always leaves it in a state visible to a human:
 *   - every item maps cleanly -> ingestOrder -> PROCESSED (order_id set)
 *   - an item is unmapped     -> WAITING_DEPENDENCY, lastError names the id(s)
 *   - ingestOrder throws      -> FAILED, lastError set to the real message
 * "Bounded retry" (rule 8) here means a bound of exactly ONE automatic
 * attempt — like a PrintJob (business rule 7), a WAITING_DEPENDENCY/FAILED
 * receipt is never silently lost; it stays visible and can be reprocessed by
 * re-invoking this worker once its cause (e.g. a missing menu_item.item_no
 * mapping) is fixed. A richer attempts/backoff column would require a
 * grab-schema.ts change, which is out of scope — the DB layer is locked for
 * this build.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { grabPartnerReceipts, type GrabPartnerReceipt } from "../../db/grab-schema.js";
import { aggregatorAccounts, menuItems } from "../../db/schema.js";
import { ingestOrder } from "../orders/service.js";
import type { SubmitOrderBody } from "./validation.js";

interface MappedItem {
  menu_item_id: string;
  qty: number;
}

interface MappingResult {
  ok: boolean;
  items: MappedItem[];
  unmapped: string[];
}

/**
 * Grab item identity used to resolve an ORION menu item: grabItemID first
 * (Grab's own canonical item id), falling back to the order-line `id`. Same
 * item_no mapping convention as src/modules/foodpanda/worker.ts's
 * productLookupKey — onboarding a Grab brand means setting each menu item's
 * item_no to the matching Grab grabItemID (or id, if grabItemID is absent).
 */
function itemLookupKey(item: { id: string; grabItemID?: string }): string {
  return item.grabItemID?.trim() || item.id.trim();
}

/**
 * Maps raw_payload.items[] to ORION menu_item ids via menu_item.item_no.
 * Fails closed and all-or-nothing: ANY unmapped item means the whole order
 * stays unmapped — never partially ingest an order.
 */
async function mapSubmitOrderItems(db: DB, brandId: string, items: SubmitOrderBody["items"]): Promise<MappingResult> {
  const keys = new Set(items.map(itemLookupKey));
  const rows =
    keys.size > 0
      ? await db
          .select({ id: menuItems.id, itemNo: menuItems.itemNo })
          .from(menuItems)
          .where(and(eq(menuItems.brandId, brandId), inArray(menuItems.itemNo, [...keys])))
      : [];
  const byItemNo = new Map(rows.filter((row) => row.itemNo).map((row) => [row.itemNo as string, row.id]));

  const mapped: MappedItem[] = [];
  const unmapped: string[] = [];
  for (const item of items) {
    const key = itemLookupKey(item);
    const menuItemId = byItemNo.get(key);
    // Validation.ts already enforces quantity >= 1 at the ingress boundary;
    // this re-check only guards a row read back out of a stored raw_payload.
    if (!menuItemId || item.quantity <= 0) {
      unmapped.push(key);
      continue;
    }
    mapped.push({ menu_item_id: menuItemId, qty: item.quantity });
  }
  return { ok: unmapped.length === 0 && mapped.length > 0, items: mapped, unmapped };
}

interface ReceiptResolution {
  state: "PROCESSED" | "WAITING_DEPENDENCY" | "FAILED";
  lastError: string | null;
  orderId?: string;
  processedAt?: Date;
}

/**
 * Conditional UPDATE claim/resolve (see module doc comment): only the caller
 * whose UPDATE actually flips PENDING -> a terminal state gets to act on the
 * receipt. Returns false when a concurrent worker already resolved it first.
 */
async function resolveIfStillPending(db: DB, receiptId: string, resolution: ReceiptResolution): Promise<boolean> {
  const [row] = await db
    .update(grabPartnerReceipts)
    .set({ ...resolution, updatedAt: new Date() })
    .where(and(eq(grabPartnerReceipts.id, receiptId), eq(grabPartnerReceipts.state, "PENDING")))
    .returning({ id: grabPartnerReceipts.id });
  return !!row;
}

type Outcome = "PROCESSED" | "WAITING_DEPENDENCY" | "FAILED" | "SKIPPED";

/** Fully processes one receipt: map -> ingest -> resolve. Returns SKIPPED when a concurrent worker won the claim race first. */
async function processReceipt(db: DB, receipt: GrabPartnerReceipt): Promise<Outcome> {
  if (!receipt.aggregatorAccountId || !receipt.providerOrderId) {
    const claimed = await resolveIfStillPending(db, receipt.id, {
      state: "FAILED",
      lastError: "Receipt is missing aggregator_account_id or provider_order_id (orderID); cannot map/ingest.",
    });
    return claimed ? "FAILED" : "SKIPPED";
  }

  const [listing] = await db.select({ brandId: aggregatorAccounts.brandId }).from(aggregatorAccounts).where(eq(aggregatorAccounts.id, receipt.aggregatorAccountId));
  if (!listing) {
    const claimed = await resolveIfStillPending(db, receipt.id, { state: "FAILED", lastError: "Channel listing no longer exists." });
    return claimed ? "FAILED" : "SKIPPED";
  }

  const body = receipt.rawPayload as SubmitOrderBody;
  const items = Array.isArray(body?.items) ? body.items : [];
  const mapping = await mapSubmitOrderItems(db, listing.brandId, items);

  if (!mapping.ok) {
    const message = `Unmapped GrabFood item id(s): ${mapping.unmapped.join(", ") || "(no items)"}. A human must set menu_item.item_no to the matching Grab grabItemID/id before this order can be ingested.`;
    const claimed = await resolveIfStillPending(db, receipt.id, { state: "WAITING_DEPENDENCY", lastError: message });
    return claimed ? "WAITING_DEPENDENCY" : "SKIPPED";
  }

  try {
    const result = await ingestOrder(db, {
      brand_id: listing.brandId,
      aggregator_account_id: receipt.aggregatorAccountId,
      aggregator: "GRABFOOD",
      external_ref: receipt.providerOrderId,
      items: mapping.items,
    });
    const claimed = await resolveIfStillPending(db, receipt.id, {
      state: "PROCESSED",
      orderId: result.order_id,
      lastError: null,
      processedAt: new Date(),
    });
    return claimed ? "PROCESSED" : "SKIPPED";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order ingestion failed.";
    const claimed = await resolveIfStillPending(db, receipt.id, { state: "FAILED", lastError: message });
    return claimed ? "FAILED" : "SKIPPED";
  }
}

export interface RunGrabSubmitOrderWorkerOnceOptions {
  limit?: number;
}

export interface RunGrabSubmitOrderWorkerOnceResult {
  claimed: number;
  processed: number;
  waitingDependency: number;
  failed: number;
}

/**
 * Processes up to `limit` PENDING SUBMIT_ORDER receipts (oldest first,
 * bounded — engineering-standards.md "no unbounded query"). Pure and
 * directly callable, no timer/scheduler wired here — same shape as
 * src/modules/foodpanda/worker.ts's runFoodpandaOutboundOnce.
 */
export async function runGrabSubmitOrderWorkerOnce(db: DB, opts: RunGrabSubmitOrderWorkerOnceOptions = {}): Promise<RunGrabSubmitOrderWorkerOnceResult> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  const candidates = await db
    .select()
    .from(grabPartnerReceipts)
    .where(and(eq(grabPartnerReceipts.route, "SUBMIT_ORDER"), eq(grabPartnerReceipts.state, "PENDING")))
    .orderBy(asc(grabPartnerReceipts.receivedAt))
    .limit(limit);

  const result: RunGrabSubmitOrderWorkerOnceResult = { claimed: 0, processed: 0, waitingDependency: 0, failed: 0 };
  for (const receipt of candidates) {
    const outcome = await processReceipt(db, receipt);
    if (outcome === "SKIPPED") continue; // lost the claim race to a concurrent worker — clean no-op.
    result.claimed += 1;
    if (outcome === "PROCESSED") result.processed += 1;
    else if (outcome === "WAITING_DEPENDENCY") result.waitingDependency += 1;
    else result.failed += 1;
  }
  return result;
}
