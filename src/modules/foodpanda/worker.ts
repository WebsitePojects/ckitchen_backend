/**
 * Foodpanda Plugin API outbound worker — the asynchronous processor bug #6
 * requires.
 *
 * pluginApi.yaml: dispatch must "quick-validate, persist, acknowledge fast
 * (a few seconds max), then process asynchronously" — this file is that
 * asynchronous step. service.ts's handleDispatchOrder only persists a
 * foodpanda_plugin_receipt (state=PENDING) plus one
 * foodpanda_plugin_outbound_task row (ORDER_ACCEPT_REJECT_DECISION,
 * status=PENDING) in the same transaction; this worker claims that task,
 * maps pluginOrder.yaml `products[]` to ORION menu items, ingests the order
 * via the existing orders/service.js, and — once ingested — notifies
 * Delivery Hero of acceptance.
 *
 * Outbox pattern (rule 8, .claude/rules/idempotency-concurrency.md): claim is
 * a conditional UPDATE keyed on status='PENDING' (plus a stale-CLAIMED lease
 * reclaim for crash-safety, mirroring src/modules/outbound/worker.ts); only
 * the winner's UPDATE returns a row, so a losing concurrent caller is a clean
 * no-op — never a double ingest. Every claimed task ends in a terminal state
 * (DONE / FAILED / DEAD) or is put back to PENDING with a backed-off
 * next_attempt_at — never unbounded retry, never silently dropped.
 *
 *   PENDING ──claim──▶ CLAIMED ──map──▶ unmapped, retries exhausted ──▶ FAILED
 *                          │
 *                          ├─▶ mapped ──▶ ingestOrder ──▶ notify DH ──▶ DONE
 *                          │                  │                 │
 *                          │                  ▼                 ▼
 *                          │        retryable error/unmapped   notify retries
 *                          │        ──▶ PENDING (backoff)       exhausted ──▶ DEAD
 *                          └─▶ terminal ServiceError ──▶ FAILED
 *
 * Network egress goes through src/modules/outbound/foodpanda-adapter.ts's
 * FoodpandaMiddlewareClient ONLY — this file never constructs its own fetch
 * call. Preference order for the accept notification: the inbound-supplied
 * `callback_urls.orderAcceptedUrl` (Direct-integration orders MUST use it —
 * pluginOrder.yaml CallbackUrls) when present, falling back to the fixed
 * `updateOrderStatus(token, ...)` endpoint when absent. A callback URL
 * rejected by the adapter's SSRF allowlist (isAllowedFoodpandaCallbackUrl,
 * enforced inside postFoodpandaCallback) is TERMINAL for that URL — never
 * retried against the same URL — and falls back to updateOrderStatus
 * immediately within the same attempt.
 *
 * `FoodpandaCallbackClient` below is a narrow, injectable interface (not the
 * concrete adapter class) so this file has no hard compile-time coupling to
 * the rest of FoodpandaMiddlewareClient's shape, and so tests can supply a
 * fake without constructing a real network client. No timers/scheduler are
 * wired here — no side effects at import time; call
 * runFoodpandaOutboundOnce(db, opts) directly (from a future cron/interval,
 * or a test), same contract as src/modules/outbound/worker.ts's
 * processCommands.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  foodpandaPluginOutboundTasks,
  foodpandaPluginReceipts,
  type FoodpandaPluginOutboundTask,
} from "../../db/foodpanda-plugin-schema.js";
import { aggregatorAccounts, menuItems } from "../../db/schema.js";
import { ingestOrder, ServiceError } from "../orders/service.js";
import { FoodpandaMiddlewareClient } from "../outbound/foodpanda-adapter.js";

// ---------------------------------------------------------------------------
// Injectable notification seam
// ---------------------------------------------------------------------------

/**
 * Minimal shape worker.ts needs from a Foodpanda outbound client — structurally
 * matches FoodpandaMiddlewareClient's postFoodpandaCallback/updateOrderStatus
 * (src/modules/outbound/foodpanda-adapter.ts), kept narrow so this file
 * doesn't depend on the rest of that class's surface.
 */
export interface FoodpandaCallbackClient {
  postFoodpandaCallback(rawUrl: string, body: unknown): Promise<FoodpandaSendResult>;
  updateOrderStatus(orderToken: string, body: unknown): Promise<FoodpandaSendResult>;
}

export interface FoodpandaSendResult {
  ok: boolean;
  kind?: "RETRYABLE" | "TERMINAL";
  message?: string;
}

/** Constructed lazily at call time (never at import time). The class itself reads FOODPANDA_MIDDLEWARE_* env vars lazily per-call too, so an unconfigured environment stays inert. */
function defaultClient(): FoodpandaCallbackClient {
  return new FoodpandaMiddlewareClient();
}

// ---------------------------------------------------------------------------
// Product -> ORION menu item mapping
// ---------------------------------------------------------------------------

interface RawDispatchProduct {
  name?: unknown;
  remoteCode?: unknown;
  sku?: unknown;
  quantity?: unknown;
  comment?: unknown;
}

interface MappedItem {
  menu_item_id: string;
  qty: number;
  notes?: string;
}

interface MappingResult {
  ok: boolean;
  items: MappedItem[];
  unmapped: string[];
}

/** pluginOrder.yaml product identity used to resolve an ORION menu item: remoteCode first, then sku. */
function productLookupKey(product: RawDispatchProduct): string | null {
  if (typeof product.remoteCode === "string" && product.remoteCode.trim()) return product.remoteCode.trim();
  if (typeof product.sku === "string" && product.sku.trim()) return product.sku.trim();
  return null;
}

function productLabel(product: RawDispatchProduct, key: string | null): string {
  if (key) return key;
  return typeof product.name === "string" && product.name.trim() ? product.name.trim() : "(unnamed product, no remoteCode/sku)";
}

/**
 * Maps raw_payload.products[] to ORION menu_item ids by matching
 * menu_item.item_no against remoteCode (preferred) or sku. ORION has no
 * dedicated Foodpanda remoteCode/sku column today — item_no is the existing
 * per-brand product-code field (src/db/schema.ts, unique per brand when set)
 * and is the closest available mapping key; onboarding a Foodpanda brand
 * means setting each menu item's item_no to its Foodpanda remoteCode or sku.
 * Toppings are NOT mapped here — ingestOrder's item contract is
 * root-product-only; topping-level substitution is future work.
 *
 * Fails closed and all-or-nothing: ANY unmapped product means the whole
 * order stays unmapped — never partially ingest an order.
 */
async function mapDispatchProducts(db: DB, brandId: string, products: RawDispatchProduct[]): Promise<MappingResult> {
  const keys = new Set<string>();
  for (const product of products) {
    const key = productLookupKey(product);
    if (key) keys.add(key);
  }

  const rows =
    keys.size > 0
      ? await db
          .select({ id: menuItems.id, itemNo: menuItems.itemNo })
          .from(menuItems)
          .where(and(eq(menuItems.brandId, brandId), inArray(menuItems.itemNo, [...keys])))
      : [];
  const byItemNo = new Map(rows.filter((row) => row.itemNo).map((row) => [row.itemNo as string, row.id]));

  const items: MappedItem[] = [];
  const unmapped: string[] = [];
  for (const product of products) {
    const key = productLookupKey(product);
    const menuItemId = key ? byItemNo.get(key) : undefined;
    if (!menuItemId) {
      unmapped.push(productLabel(product, key));
      continue;
    }
    const qty = typeof product.quantity === "string" ? Number(product.quantity) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) {
      // Should never happen — validation.ts's quantity schema already
      // enforced this at dispatch time — but fail closed defensively rather
      // than ingest a bad quantity read back out of a stored raw_payload.
      unmapped.push(productLabel(product, key));
      continue;
    }
    const notes = typeof product.comment === "string" && product.comment.trim() ? product.comment.trim() : undefined;
    items.push({ menu_item_id: menuItemId, qty, ...(notes ? { notes } : {}) });
  }

  return { ok: unmapped.length === 0 && items.length > 0, items, unmapped };
}

// ---------------------------------------------------------------------------
// Bounded retry / backoff / claim-lease (mirrors src/modules/outbound/
// worker.ts's claim protocol and policies.ts's exponential-backoff shape;
// kept local because this task's attempt budget is independent of the
// generic outbound aggregator-command queue's).
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 60;

function backoffMs(attempts: number): number {
  return Math.min(Math.max(attempts, 1), MAX_ATTEMPTS) ** 2 * 1000;
}

function leaseExpiry(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** Fresh PENDING (backoff elapsed) or a lapsed CLAIMED lease (crash recovery). */
function claimableWhere() {
  const now = new Date();
  return or(
    and(
      eq(foodpandaPluginOutboundTasks.status, "PENDING"),
      or(isNull(foodpandaPluginOutboundTasks.nextAttemptAt), lte(foodpandaPluginOutboundTasks.nextAttemptAt, now)),
    ),
    and(eq(foodpandaPluginOutboundTasks.status, "CLAIMED"), lte(foodpandaPluginOutboundTasks.leaseUntil, now)),
  );
}

/**
 * Conditional UPDATE claim (rule 8): `WHERE id=? AND status='PENDING' AND
 * (next_attempt_at IS NULL OR next_attempt_at <= now())`, extended to also
 * reclaim a lapsed CLAIMED lease (crash-safety). attempts is incremented as
 * part of the same UPDATE. Only one concurrent caller's WHERE clause still
 * matches once the other's UPDATE has committed — `.returning()` yields a
 * row for exactly one caller; the loser gets `null` and must no-op.
 */
async function claimOne(db: DB, id: string, leaseOwner: string, leaseSeconds: number): Promise<FoodpandaPluginOutboundTask | null> {
  const now = new Date();
  const until = leaseExpiry(leaseSeconds);
  const [row] = await db
    .update(foodpandaPluginOutboundTasks)
    .set({
      status: "CLAIMED",
      leaseOwner,
      leaseUntil: until,
      attempts: sql`${foodpandaPluginOutboundTasks.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(foodpandaPluginOutboundTasks.id, id),
        or(
          and(
            eq(foodpandaPluginOutboundTasks.status, "PENDING"),
            or(isNull(foodpandaPluginOutboundTasks.nextAttemptAt), lte(foodpandaPluginOutboundTasks.nextAttemptAt, now)),
          ),
          and(eq(foodpandaPluginOutboundTasks.status, "CLAIMED"), lte(foodpandaPluginOutboundTasks.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

type Outcome = "DONE" | "RETRY" | "FAILED" | "DEAD";

/**
 * Conditional resolve: only the caller still holding the exact live lease may
 * resolve the row (mirrors src/modules/outbound/worker.ts's leaseOwner
 * check), so a reclaim race can never double-resolve the same task.
 */
async function resolveTask(db: DB, task: FoodpandaPluginOutboundTask, leaseOwner: string, outcome: Outcome, lastError: string | null): Promise<void> {
  const now = new Date();
  if (outcome === "DONE") {
    await db
      .update(foodpandaPluginOutboundTasks)
      .set({ status: "DONE", lastError: null, nextAttemptAt: null, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(foodpandaPluginOutboundTasks.id, task.id), eq(foodpandaPluginOutboundTasks.leaseOwner, leaseOwner)));
    return;
  }
  if (outcome === "RETRY") {
    await db
      .update(foodpandaPluginOutboundTasks)
      .set({
        status: "PENDING",
        lastError,
        nextAttemptAt: new Date(now.getTime() + backoffMs(task.attempts)),
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(and(eq(foodpandaPluginOutboundTasks.id, task.id), eq(foodpandaPluginOutboundTasks.leaseOwner, leaseOwner)));
    return;
  }
  // FAILED or DEAD — terminal, never retried again.
  await db
    .update(foodpandaPluginOutboundTasks)
    .set({ status: outcome, lastError, nextAttemptAt: null, leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(and(eq(foodpandaPluginOutboundTasks.id, task.id), eq(foodpandaPluginOutboundTasks.leaseOwner, leaseOwner)));
}

// ---------------------------------------------------------------------------
// Per-task processing
// ---------------------------------------------------------------------------

function acceptedUrlFrom(callbackUrls: unknown): string | null {
  if (!callbackUrls || typeof callbackUrls !== "object" || Array.isArray(callbackUrls)) return null;
  const value = (callbackUrls as Record<string, unknown>)["orderAcceptedUrl"];
  return typeof value === "string" && value.trim() ? value : null;
}

async function notifyAccepted(client: FoodpandaCallbackClient, token: string, callbackUrls: unknown): Promise<FoodpandaSendResult> {
  const body = { status: "order_accepted" as const };
  const acceptedUrl = acceptedUrlFrom(callbackUrls);
  if (acceptedUrl) {
    const result = await client.postFoodpandaCallback(acceptedUrl, body);
    if (result.ok || result.kind !== "TERMINAL") return result;
    // Rejected/disallowed callback URL — TERMINAL for that URL, never
    // retried against it; fall back to the fixed endpoint instead.
    return client.updateOrderStatus(token, body);
  }
  return client.updateOrderStatus(token, body);
}

/** Claims and fully processes one outbound task: map -> ingest -> notify. Returns the terminal-or-retry outcome so the caller can tally it. */
async function processTask(db: DB, task: FoodpandaPluginOutboundTask, leaseOwner: string, client: FoodpandaCallbackClient): Promise<Outcome> {
  const [receipt] = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.id, task.receiptId));
  if (!receipt) {
    const outcome: Outcome = "FAILED";
    await resolveTask(db, task, leaseOwner, outcome, "Foodpanda plugin receipt no longer exists.");
    return outcome;
  }

  let orderId = receipt.orderId;

  if (!orderId) {
    if (!receipt.aggregatorAccountId || !receipt.providerOrderId) {
      const message = "Receipt is missing aggregator_account_id or provider_order_id (token); cannot map/ingest.";
      await db
        .update(foodpandaPluginReceipts)
        .set({ state: "WAITING_DEPENDENCY", lastError: message, updatedAt: new Date() })
        .where(eq(foodpandaPluginReceipts.id, receipt.id));
      const outcome: Outcome = "FAILED";
      await resolveTask(db, task, leaseOwner, outcome, message);
      return outcome;
    }

    const [listing] = await db
      .select({ brandId: aggregatorAccounts.brandId })
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.id, receipt.aggregatorAccountId));
    if (!listing) {
      const message = "Channel listing no longer exists.";
      await db
        .update(foodpandaPluginReceipts)
        .set({ state: "WAITING_DEPENDENCY", lastError: message, updatedAt: new Date() })
        .where(eq(foodpandaPluginReceipts.id, receipt.id));
      const outcome: Outcome = "FAILED";
      await resolveTask(db, task, leaseOwner, outcome, message);
      return outcome;
    }

    const productsRaw = (receipt.rawPayload as { products?: unknown } | null)?.products;
    const products = Array.isArray(productsRaw) ? (productsRaw as RawDispatchProduct[]) : [];
    const mapping = await mapDispatchProducts(db, listing.brandId, products);

    if (!mapping.ok) {
      const deadline = receipt.expiryDate ? receipt.expiryDate.toISOString() : "unknown";
      const message = `Unmapped Foodpanda product code(s): ${mapping.unmapped.join(", ") || "(no products)"}. A human must map menu_item.item_no to these before expiryDate (${deadline}); the order was NOT auto-accepted.`;
      await db
        .update(foodpandaPluginReceipts)
        .set({ state: "WAITING_DEPENDENCY", lastError: message, updatedAt: new Date() })
        .where(eq(foodpandaPluginReceipts.id, receipt.id));
      const outcome: Outcome = task.attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
      await resolveTask(db, task, leaseOwner, outcome, message);
      return outcome;
    }

    try {
      const result = await ingestOrder(db, {
        brand_id: listing.brandId,
        aggregator_account_id: receipt.aggregatorAccountId,
        aggregator: "FOODPANDA",
        external_ref: receipt.providerOrderId,
        items: mapping.items,
      });
      orderId = result.order_id;
      await db
        .update(foodpandaPluginReceipts)
        .set({ state: "PROCESSED", orderId, lastError: null, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(foodpandaPluginReceipts.id, receipt.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Order ingestion failed.";
      await db
        .update(foodpandaPluginReceipts)
        .set({ state: "WAITING_DEPENDENCY", lastError: message, updatedAt: new Date() })
        .where(eq(foodpandaPluginReceipts.id, receipt.id));
      // ServiceError subtypes (NotFoundError/ValidationError/AmbiguousListingError/
      // ListingMappingRequiredError/InsufficientStockError) signal a data/config
      // problem a retry cannot fix on its own — terminal (FAILED). A
      // ConflictError (concurrent race) and anything unexpected (DB hiccup,
      // etc.) is assumed transient and retried with backoff, up to DEAD once
      // exhausted — the order is not lost, just needs ops attention.
      const dataProblem = err instanceof ServiceError && err.code !== "CONFLICT";
      const outcome: Outcome = dataProblem ? "FAILED" : task.attempts >= MAX_ATTEMPTS ? "DEAD" : "RETRY";
      await resolveTask(db, task, leaseOwner, outcome, message);
      return outcome;
    }
  }

  // Ingested (this attempt or a prior one) — notify Delivery Hero of
  // acceptance. Best-effort: a notification failure never rolls back the
  // already-created order; the order stands regardless of notification outcome.
  const sendResult = await notifyAccepted(client, receipt.providerOrderId!, receipt.callbackUrls);
  if (sendResult.ok) {
    await resolveTask(db, task, leaseOwner, "DONE", null);
    return "DONE";
  }

  const message = sendResult.message ?? "Foodpanda accept notification failed.";
  if (sendResult.kind === "TERMINAL") {
    await resolveTask(db, task, leaseOwner, "DEAD", message);
    return "DEAD";
  }
  const outcome: Outcome = task.attempts >= MAX_ATTEMPTS ? "DEAD" : "RETRY";
  await resolveTask(db, task, leaseOwner, outcome, message);
  return outcome;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface RunFoodpandaOutboundOnceOptions {
  /** Identifies which worker instance holds a lease; defaults to a fresh random id per call. */
  leaseOwner?: string;
  limit?: number;
  leaseSeconds?: number;
  /** Injected notification client (testable without a real FoodpandaMiddlewareClient); defaults to a lazily-constructed one. */
  client?: FoodpandaCallbackClient;
}

export interface RunFoodpandaOutboundOnceResult {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

/**
 * Claims up to `limit` eligible foodpanda_plugin_outbound_task rows (oldest
 * first) and drives each through mapping/ingestion/notification exactly once.
 * Pure and directly callable — no setInterval/timer is wired here; a future
 * scheduler (or a test) calls this directly, same shape as
 * src/modules/outbound/worker.ts's processCommands.
 */
export async function runFoodpandaOutboundOnce(db: DB, opts: RunFoodpandaOutboundOnceOptions = {}): Promise<RunFoodpandaOutboundOnceResult> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 5), 300);
  const leaseOwner = opts.leaseOwner ?? `foodpanda-worker-${randomUUID()}`;
  const client = opts.client ?? defaultClient();

  const candidates = await db
    .select({ id: foodpandaPluginOutboundTasks.id })
    .from(foodpandaPluginOutboundTasks)
    .where(claimableWhere())
    .orderBy(asc(foodpandaPluginOutboundTasks.createdAt))
    .limit(limit);

  const result: RunFoodpandaOutboundOnceResult = { claimed: 0, done: 0, retried: 0, failed: 0, dead: 0 };

  for (const { id } of candidates) {
    const claimed = await claimOne(db, id, leaseOwner, leaseSeconds);
    if (!claimed) continue; // lost the race to a concurrent worker — clean no-op.
    result.claimed += 1;

    const outcome = await processTask(db, claimed, leaseOwner, client);
    if (outcome === "DONE") result.done += 1;
    else if (outcome === "RETRY") result.retried += 1;
    else if (outcome === "FAILED") result.failed += 1;
    else result.dead += 1;
  }

  return result;
}
