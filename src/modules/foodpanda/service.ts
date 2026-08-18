import { createHash, randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  foodpandaListingAvailability,
  foodpandaPluginOutboundTasks,
  foodpandaPluginReceipts,
  type FoodpandaPluginReceipt,
} from "../../db/foodpanda-plugin-schema.js";
import { aggregatorAccounts, orders } from "../../db/schema.js";
import { cancelOrder } from "../orders/service.js";
import type { AvailabilityBody, CatalogCallbackBody, OrderDispatchBody, OrderStatusBody } from "./validation.js";
import { classifyOrderType, orderToken, resolveItemUnavailabilityHandling } from "./validation.js";

export class FoodpandaPluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "FoodpandaPluginError";
  }
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object" && (e["cause"] as Record<string, unknown>)["code"] === "23505") return true;
  }
  return false;
}

interface ResolvedListing {
  id: string;
  brandId: string;
  locationId: string | null;
}

export async function resolveFoodpandaListing(db: DB, remoteId: string): Promise<ResolvedListing> {
  const candidates = await db
    .select({
      id: aggregatorAccounts.id,
      brandId: aggregatorAccounts.brandId,
      locationId: aggregatorAccounts.locationId,
    })
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.aggregator, "FOODPANDA"),
        eq(aggregatorAccounts.isActive, true),
        or(eq(aggregatorAccounts.apiMerchantId, remoteId), eq(aggregatorAccounts.externalMerchantId, remoteId)),
      ),
    );

  if (candidates.length !== 1) {
    throw new FoodpandaPluginError("NOT_FOUND", "Foodpanda remoteId is not mapped to exactly one active channel listing.", 404);
  }
  return candidates[0]!;
}

function remoteOrderId(): string {
  return `orion-fp-${randomUUID()}`;
}

/**
 * Safe-to-expose/log summary of a dispatch payload. Deliberately excludes the
 * `token` (dedupe/outbound key — not a secret, but not needed for a redacted
 * summary either), `callbackUrls` (may embed an order-scoped secret in its
 * query string), and anything customer-identifying. See the `rawPayload`
 * column comment in src/db/foodpanda-plugin-schema.ts for the full-fidelity,
 * PII-bearing counterpart that MUST NEVER be returned/logged.
 */
function dispatchRedaction(body: OrderDispatchBody, orderType: string, resolvedHandling: string | null): Record<string, unknown> {
  return {
    expeditionType: body.expeditionType,
    orderType,
    itemCount: body.products.length,
    hasExpiryDate: body.expiryDate != null,
    hasCallbackUrls: body.callbackUrls != null,
    itemUnavailabilityHandling: resolvedHandling,
  };
}

async function findReceiptByDedupeKey(db: DB, dedupeKey: string): Promise<FoodpandaPluginReceipt | undefined> {
  const [row] = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.dedupeKey, dedupeKey));
  return row;
}

/**
 * Dispatch order (pluginApi.yaml "Dispatch Order"): quick-validate (routes.ts,
 * before this is called), persist, acknowledge fast — NOT process synchronously.
 * pluginApi.yaml is explicit that the middleware "is not supporting the
 * synchronous dispatch flow with the new features" and expects an
 * acknowledge-in-a-few-seconds response; product mapping + ORION ingestion +
 * the accept/reject callback happen later, off the request path, in
 * worker.ts's runFoodpandaOutboundOnce (driven by the
 * foodpanda_plugin_outbound_task row inserted below).
 *
 * Idempotency: `dedupeKey` is listing-scoped on the `token` (pluginOrder.yaml's
 * real order identifier — see providerOrderId's column comment). A replay of
 * the same dedupeKey — sequential or racing the unique-constraint recovery
 * path — always returns the SAME stored remoteOrderId, never mints a new one.
 */
export async function handleDispatchOrder(db: DB, input: { remoteId: string; body: OrderDispatchBody }) {
  const listing = await resolveFoodpandaListing(db, input.remoteId);
  const token = orderToken(input.body);
  const orderType = classifyOrderType(input.body);
  const resolvedHandling = resolveItemUnavailabilityHandling(input.body);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `dispatch:${listing.id}:${token}`;

  let receipt: FoodpandaPluginReceipt;
  try {
    receipt = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.dedupeKey, dedupeKey));
      if (existing) return existing;

      const [inserted] = await tx
        .insert(foodpandaPluginReceipts)
        .values({
          aggregatorAccountId: listing.id,
          route: "ORDER_DISPATCH",
          remoteId: input.remoteId,
          providerOrderId: token,
          remoteOrderId: remoteOrderId(),
          dedupeKey,
          requestHash,
          state: "PENDING",
          redactedPayload: dispatchRedaction(input.body, orderType, resolvedHandling),
          platformOrderCode: input.body.code ?? null,
          callbackUrls: input.body.callbackUrls ?? null,
          expiryDate: input.body.expiryDate ? new Date(input.body.expiryDate) : null,
          itemUnavailabilityHandling: resolvedHandling,
          rawPayload: input.body,
          lastError: "Persisted; awaiting async product-mapping + ingestion by the outbound worker.",
        })
        .returning();

      // Same transaction as the receipt insert (rule 5b/8): the outbox row
      // that drives worker.ts's claim-lease loop is created atomically with
      // the receipt it belongs to — never a fire-and-forget side effect.
      await tx.insert(foodpandaPluginOutboundTasks).values({
        receiptId: inserted!.id,
        aggregatorAccountId: listing.id,
        remoteOrderId: inserted!.remoteOrderId!,
        taskType: "ORDER_ACCEPT_REJECT_DECISION",
        status: "PENDING",
        payload: { orderType },
      });
      return inserted!;
    });
  } catch (err) {
    // Unique-violation recovery MUST run outside the aborted transaction
    // (Postgres aborts the whole tx on error) — re-query on a fresh db handle.
    if (isUniqueViolation(err)) {
      const existing = await findReceiptByDedupeKey(db, dedupeKey);
      if (existing) receipt = existing;
      else throw err;
    } else {
      throw err;
    }
  }

  return { remoteOrderId: receipt!.remoteOrderId! };
}

export async function handleOrderStatus(db: DB, input: { remoteId: string; remoteOrderId: string; body: OrderStatusBody }): Promise<void> {
  const listing = await resolveFoodpandaListing(db, input.remoteId);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `status:${listing.id}:${input.remoteOrderId}:${input.body.status}:${requestHash}`;

  let receipt: FoodpandaPluginReceipt;
  let created = false;
  try {
    const [inserted] = await db
      .insert(foodpandaPluginReceipts)
      .values({
        aggregatorAccountId: listing.id,
        route: "ORDER_STATUS",
        remoteId: input.remoteId,
        remoteOrderId: input.remoteOrderId,
        dedupeKey,
        requestHash,
        state: input.body.status === "ORDER_CANCELLED" ? "WAITING_DEPENDENCY" : "PROCESSED",
        redactedPayload: { status: input.body.status, hasMessage: !!input.body.message, occurredAt: input.body.occurredAt ?? null },
      })
      .returning();
    receipt = inserted!;
    created = true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findReceiptByDedupeKey(db, dedupeKey);
      if (existing) return;
    }
    throw err;
  }

  if (!created || input.body.status !== "ORDER_CANCELLED") return;

  const [dispatch] = await db
    .select()
    .from(foodpandaPluginReceipts)
    .where(
      and(
        eq(foodpandaPluginReceipts.aggregatorAccountId, listing.id),
        eq(foodpandaPluginReceipts.route, "ORDER_DISPATCH"),
        eq(foodpandaPluginReceipts.remoteOrderId, input.remoteOrderId),
      ),
    );
  if (!dispatch?.orderId) return;

  const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, dispatch.orderId));
  if (!order) return;
  if (order.status !== "CANCELLED") {
    await cancelOrder(db, order.id, "Cancelled via Foodpanda Plugin API status notification.");
  }
  await db
    .update(foodpandaPluginReceipts)
    .set({ state: "PROCESSED", orderId: order.id, lastError: null, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(foodpandaPluginReceipts.id, receipt!.id));
}

export async function handleAvailability(db: DB, input: { remoteId: string; body: AvailabilityBody }): Promise<void> {
  const listing = await resolveFoodpandaListing(db, input.remoteId);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `availability:${listing.id}:${input.body.timestamp}:${requestHash}`;
  const eventTimestamp = new Date(input.body.timestamp);

  let created = false;
  try {
    await db
      .insert(foodpandaPluginReceipts)
      .values({
        aggregatorAccountId: listing.id,
        route: "AVAILABILITY",
        remoteId: input.remoteId,
        dedupeKey,
        requestHash,
        state: "PROCESSED",
        redactedPayload: { timestamp: input.body.timestamp, closureCount: input.body.closures.length },
      })
      .returning();
    created = true;
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
  if (!created) return;

  await db
    .insert(foodpandaListingAvailability)
    .values({
      aggregatorAccountId: listing.id,
      remoteId: input.remoteId,
      eventTimestamp,
      requestHash,
      closures: input.body.closures,
    })
    .onConflictDoUpdate({
      target: foodpandaListingAvailability.aggregatorAccountId,
      set: {
        remoteId: input.remoteId,
        eventTimestamp,
        requestHash,
        closures: input.body.closures,
        updatedAt: new Date(),
      },
      where: sql`${foodpandaListingAvailability.eventTimestamp} <= ${eventTimestamp}`,
    });
}

export async function handleMenuImportTrigger(db: DB, input: { remoteId: string; vendorCode: string; menuImportId: string }): Promise<void> {
  const listing = await resolveFoodpandaListing(db, input.remoteId);
  const payload = { vendorCode: input.vendorCode, menuImportId: input.menuImportId };
  const requestHash = sha256Json(payload);
  const dedupeKey = `menuimport:${listing.id}:${input.vendorCode}:${input.menuImportId}`;
  try {
    await db.insert(foodpandaPluginReceipts).values({
      aggregatorAccountId: listing.id,
      route: "MENU_IMPORT_TRIGGER",
      remoteId: input.remoteId,
      dedupeKey,
      requestHash,
      state: "WAITING_DEPENDENCY",
      redactedPayload: payload,
      lastError: "Menu import trigger persisted; catalog generation/submission is a future queued worker.",
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

export async function handleCatalogCallback(db: DB, input: { callbackRoute: string; body: CatalogCallbackBody }): Promise<void> {
  const detailsHash = sha256Json(input.body.details ?? []);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `catalog-callback:${input.callbackRoute}:${input.body.catalogImportId}:${input.body.status}:${detailsHash}`;
  try {
    await db.insert(foodpandaPluginReceipts).values({
      route: "CATALOG_IMPORT_CALLBACK",
      remoteId: input.callbackRoute,
      dedupeKey,
      requestHash,
      state: "PROCESSED",
      redactedPayload: {
        callbackRoute: input.callbackRoute,
        catalogImportId: input.body.catalogImportId,
        status: input.body.status,
        detailCount: input.body.details?.length ?? 0,
        hasMessage: !!input.body.message,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}
