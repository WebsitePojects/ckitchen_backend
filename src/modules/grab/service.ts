/**
 * GrabFood Partner API inbound service (src/modules/grab/routes.ts calls into
 * this file). Persists a redacted, durable receipt for every inbound route
 * before/instead of acting inline — SUBMIT_ORDER is left PENDING for
 * worker.ts, exactly like src/modules/foodpanda/service.ts's
 * handleDispatchOrder leaves ORDER_DISPATCH for its own worker.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  grabListingIntegrations,
  grabMenuSyncJobs,
  grabPartnerReceipts,
  type GrabPartnerReceipt,
} from "../../db/grab-schema.js";
import { aggregatorAccounts, availabilityEnum, menuItems, orders } from "../../db/schema.js";
import { cancelOrder, ConflictError, ValidationError } from "../orders/service.js";
import type {
  GetMerchantMenuQuery,
  GrabCurrency,
  MenuSyncStateBody,
  PushGrabMenuBody,
  PushIntegrationStatusBody,
  PushOrderStateBody,
  SubmitOrderBody,
} from "./validation.js";

export class GrabPartnerServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GrabPartnerServiceError";
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

async function findReceiptByDedupeKey(db: DB, dedupeKey: string): Promise<GrabPartnerReceipt | undefined> {
  const [row] = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.dedupeKey, dedupeKey));
  return row;
}

// ---------------------------------------------------------------------------
// Listing resolution (cross-cutting requirement)
// ---------------------------------------------------------------------------

interface ResolvedGrabListing {
  id: string;
  brandId: string;
  locationId: string | null;
  externalMerchantId: string;
  apiMerchantId: string | null;
}

/**
 * Resolves the aggregator_account for a GrabFood partnerMerchantID (ORION's
 * External Store ID), preferring the durable grab_listing_integration mapping
 * (populated by pushIntegrationStatus/GetMenu) and falling back to
 * aggregator_account.external_merchant_id / api_merchant_id — scoped to
 * aggregator='GRABFOOD' AND is_active. Mirrors
 * src/modules/foodpanda/service.ts's resolveFoodpandaListing: if resolution
 * doesn't land on EXACTLY ONE active listing, 404 — never guess.
 */
export async function resolveGrabListing(db: DB, partnerMerchantId: string): Promise<ResolvedGrabListing> {
  const [integration] = await db
    .select({ aggregatorAccountId: grabListingIntegrations.aggregatorAccountId })
    .from(grabListingIntegrations)
    .where(eq(grabListingIntegrations.partnerMerchantId, partnerMerchantId));

  if (integration) {
    const [account] = await db
      .select({
        id: aggregatorAccounts.id,
        brandId: aggregatorAccounts.brandId,
        locationId: aggregatorAccounts.locationId,
        externalMerchantId: aggregatorAccounts.externalMerchantId,
        apiMerchantId: aggregatorAccounts.apiMerchantId,
      })
      .from(aggregatorAccounts)
      .where(
        and(
          eq(aggregatorAccounts.id, integration.aggregatorAccountId),
          eq(aggregatorAccounts.aggregator, "GRABFOOD"),
          eq(aggregatorAccounts.isActive, true),
        ),
      );
    // A found integration row is keyed on a globally-unique partner_merchant_id,
    // so a matching active GRABFOOD account IS the unique resolution — return
    // immediately rather than also running the fallback query below.
    if (account) return account;
    // Integration row exists but points at an inactive/mismatched listing
    // (config drift) — fall through to the legacy lookup instead of trusting it.
  }

  const candidates = await db
    .select({
      id: aggregatorAccounts.id,
      brandId: aggregatorAccounts.brandId,
      locationId: aggregatorAccounts.locationId,
      externalMerchantId: aggregatorAccounts.externalMerchantId,
      apiMerchantId: aggregatorAccounts.apiMerchantId,
    })
    .from(aggregatorAccounts)
    .where(
      and(
        eq(aggregatorAccounts.aggregator, "GRABFOOD"),
        eq(aggregatorAccounts.isActive, true),
        or(eq(aggregatorAccounts.externalMerchantId, partnerMerchantId), eq(aggregatorAccounts.apiMerchantId, partnerMerchantId)),
      ),
    );

  if (candidates.length !== 1) {
    throw new GrabPartnerServiceError(
      "NOT_FOUND",
      "GrabFood partnerMerchantID is not mapped to exactly one active channel listing.",
      404,
    );
  }
  return candidates[0]!;
}

// ---------------------------------------------------------------------------
// G3 — POST /orders (submit order)
// ---------------------------------------------------------------------------

/** MONEY IS IN MINOR UNITS — converted using the PAYLOAD'S OWN exponent, never a hardcoded /100. */
function toMajorUnits(minorAmount: number, exponent: number): number {
  return minorAmount / 10 ** exponent;
}

/**
 * Safe-to-expose/log summary of a submit-order payload (rule 11: PII stays in
 * rawPayload only). `totalMajorUnits` is DISPLAY/AUDIT ONLY — ORION's actual
 * order.total is independently recomputed by ingestOrder from ORION's own
 * menu_item.price (business rule: server recomputes money, never trusts a
 * client-sent total); this field is never fed back into ingestion.
 */
function submitOrderRedaction(body: SubmitOrderBody): Record<string, unknown> {
  return {
    orderID: body.orderID,
    shortOrderNumber: body.shortOrderNumber,
    merchantID: body.merchantID,
    paymentType: body.paymentType,
    cutlery: body.cutlery,
    orderTime: body.orderTime,
    itemCount: body.items.length,
    isMexEditOrder: body.featureFlags.isMexEditOrder,
    hasReceiver: body.receiver != null,
    hasDineIn: body.dineIn != null,
    currencyCode: body.currency.code,
    totalMajorUnits: toMajorUnits(body.price.total, body.currency.exponent),
  };
}

/**
 * G3 — persists a PENDING receipt and returns immediately; Grab only needs
 * "any 2XX means received". worker.ts does the mapping + ingestion
 * asynchronously, exactly like foodpanda's handleDispatchOrder/worker split.
 *
 * IDEMPOTENCY (rule 5, quoting Grab's own contract): "If the isMexEditOrder
 * value changes from false to true, this submit request is not considered a
 * duplicate request." dedupeKey is therefore built from
 * (listing, orderID, isMexEditOrder) — the SAME identity the DB's partial
 * unique index (grab-schema.ts) enforces — so an edited resubmission is a
 * legitimately DISTINCT row, never collapsed into the original.
 */
export async function handleSubmitOrder(db: DB, input: { partnerMerchantId: string; body: SubmitOrderBody }): Promise<{ orderID: string }> {
  const listing = await resolveGrabListing(db, input.partnerMerchantId);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `submit:${listing.id}:${input.body.orderID}:${input.body.featureFlags.isMexEditOrder}`;

  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: grabPartnerReceipts.id }).from(grabPartnerReceipts).where(eq(grabPartnerReceipts.dedupeKey, dedupeKey));
      if (existing) return;

      await tx.insert(grabPartnerReceipts).values({
        aggregatorAccountId: listing.id,
        route: "SUBMIT_ORDER",
        partnerMerchantId: input.partnerMerchantId,
        grabMerchantId: input.body.merchantID,
        providerOrderId: input.body.orderID,
        shortOrderNumber: input.body.shortOrderNumber,
        dedupeKey,
        requestHash,
        state: "PENDING",
        isMexEditOrder: input.body.featureFlags.isMexEditOrder,
        redactedPayload: submitOrderRedaction(input.body),
        rawPayload: input.body,
        lastError: "Persisted; awaiting async item-mapping + ingestion by the submit-order worker.",
      });
    });
  } catch (err) {
    // Unique-violation recovery MUST run outside the aborted transaction
    // (Postgres aborts the whole tx on error) — re-query on a fresh handle.
    if (!isUniqueViolation(err)) throw err;
    const existing = await findReceiptByDedupeKey(db, dedupeKey);
    if (!existing) throw err;
  }

  return { orderID: input.body.orderID };
}

// ---------------------------------------------------------------------------
// G4 — PUT /order/state (push order state)
// ---------------------------------------------------------------------------

/**
 * Grab order-states with a genuine, safe ORION order-status equivalent.
 * ONLY CANCELLED qualifies: orders/service.ts exposes exactly two status-
 * changing entry points usable here — advanceOrder (single forward stage,
 * NEW→PREPARING→READY→COMPLETED, driven by kitchen action) and cancelOrder.
 * Every other Grab state (ACCEPTED, DRIVER_ALLOCATED, DRIVER_ARRIVED,
 * COLLECTED, DELIVERED, BILL_PAID, COMPLETED, REFUNDED, FAILED) describes
 * delivery/payment lifecycle that has no corresponding ORION kitchen-status
 * transition to drive without guessing — fail closed (rule 14) into IGNORED
 * with a reason rather than invent one.
 */
const RECOGNIZED_ORDER_STATE_ACTIONS = new Set(["CANCELLED"]);

export async function handlePushOrderState(db: DB, input: { partnerMerchantId: string; body: PushOrderStateBody }): Promise<void> {
  const listing = await resolveGrabListing(db, input.partnerMerchantId);
  const requestHash = sha256Json(input.body);
  // No natural request id on this route — dedupe key is a hash of the meaningful fields (mirrors
  // src/modules/foodpanda/service.ts handleOrderStatus's status:listing:remoteOrderId:status:hash shape).
  const dedupeKey = `state:${listing.id}:${input.body.orderID}:${input.body.state}:${requestHash}`;
  const recognized = RECOGNIZED_ORDER_STATE_ACTIONS.has(input.body.state);

  let receiptId: string;
  try {
    const [inserted] = await db
      .insert(grabPartnerReceipts)
      .values({
        aggregatorAccountId: listing.id,
        route: "PUSH_ORDER_STATE",
        partnerMerchantId: input.partnerMerchantId,
        grabMerchantId: input.body.merchantID,
        providerOrderId: input.body.orderID,
        dedupeKey,
        requestHash,
        state: recognized ? "WAITING_DEPENDENCY" : "IGNORED",
        redactedPayload: {
          state: input.body.state,
          driverETA: input.body.driverETA ?? null,
          hasCode: input.body.code != null,
          hasMessage: input.body.message != null,
        },
        lastError: recognized ? null : `No ORION order-status equivalent for Grab state ${input.body.state}; recorded for audit only.`,
      })
      .returning();
    receiptId = inserted!.id;
  } catch (err) {
    if (isUniqueViolation(err)) return; // exact repeat already processed — no second effect.
    throw err;
  }

  if (input.body.state !== "CANCELLED") return;

  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(and(eq(orders.aggregatorAccountId, listing.id), eq(orders.externalRef, input.body.orderID)));

  if (!order) {
    await db
      .update(grabPartnerReceipts)
      .set({ lastError: "Order has not been ingested by ORION yet; cannot apply CANCELLED.", updatedAt: new Date() })
      .where(eq(grabPartnerReceipts.id, receiptId));
    return;
  }

  if (order.status !== "CANCELLED") {
    // The status read above is advisory only: two CANCELLED pushes that differ
    // in `message` hash to different dedupeKeys, so both clear the unique
    // guard and can reach here concurrently. cancelOrder's conditional
    // state-transition UPDATE guarantees only ONE of them posts the
    // compensating stock movement; the loser throws. That loser is a duplicate
    // delivery, not a failure — answering it 500 would violate rule 6
    // (.claude/rules/idempotency-concurrency.md) and, worse, Grab RETRIES 5xx.
    // The end state Grab asked for is already true, so treat it as applied.
    try {
      await cancelOrder(db, order.id, "Cancelled via GrabFood Partner API push-order-state webhook.");
    } catch (err) {
      if (!(err instanceof ConflictError || err instanceof ValidationError)) throw err;
      // Do NOT swallow on the error type alone — cancelOrder also raises
      // ValidationError for "a COMPLETED order cannot be cancelled", which is a
      // genuine conflict a human must see. Re-read the row and swallow ONLY if
      // the order really did reach CANCELLED (i.e. the racing writer won).
      const [current] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
      if (current?.status !== "CANCELLED") throw err;
    }
  }
  await db
    .update(grabPartnerReceipts)
    .set({ state: "PROCESSED", orderId: order.id, lastError: null, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(grabPartnerReceipts.id, receiptId));
}

// ---------------------------------------------------------------------------
// G5 — POST /pushIntegrationStatus
// ---------------------------------------------------------------------------

/**
 * This is how ORION learns Grab's merchantID (grab-schema.ts's table
 * comment). Upserts grab_listing_integration (naturally idempotent — an
 * upsert executed N times with the same body converges to the same end
 * state) and conditionally mirrors grabMerchantID onto
 * aggregator_account.api_merchant_id the FIRST time it's null, never
 * overwriting a disagreeing non-null value (recorded as a lastError conflict
 * note instead). Always returns 204 — routes.ts owns the status code.
 */
export async function handlePushIntegrationStatus(db: DB, body: PushIntegrationStatusBody): Promise<void> {
  const listing = await resolveGrabListing(db, body.partnerMerchantID);
  const now = new Date();

  await db
    .insert(grabListingIntegrations)
    .values({
      aggregatorAccountId: listing.id,
      partnerMerchantId: body.partnerMerchantID,
      grabMerchantId: body.grabMerchantID,
      integrationStatus: body.integrationStatus,
      lastStatusAt: now,
    })
    .onConflictDoUpdate({
      target: grabListingIntegrations.aggregatorAccountId,
      set: {
        partnerMerchantId: body.partnerMerchantID,
        grabMerchantId: body.grabMerchantID,
        integrationStatus: body.integrationStatus,
        lastStatusAt: now,
        updatedAt: now,
      },
    });

  // Conditional UPDATE: only claims api_merchant_id while it is still NULL.
  const [mirrored] = await db
    .update(aggregatorAccounts)
    .set({ apiMerchantId: body.grabMerchantID })
    .where(and(eq(aggregatorAccounts.id, listing.id), isNull(aggregatorAccounts.apiMerchantId)))
    .returning({ id: aggregatorAccounts.id });

  let mirrorConflict: string | null = null;
  if (!mirrored) {
    const [current] = await db.select({ apiMerchantId: aggregatorAccounts.apiMerchantId }).from(aggregatorAccounts).where(eq(aggregatorAccounts.id, listing.id));
    if (current?.apiMerchantId != null && current.apiMerchantId !== body.grabMerchantID) {
      mirrorConflict = `aggregator_account.api_merchant_id is already "${current.apiMerchantId}", which disagrees with grabMerchantID "${body.grabMerchantID}" reported here.`;
    }
  }

  const requestHash = sha256Json(body);
  const dedupeKey = `integration-status:${listing.id}:${requestHash}`;
  try {
    await db.insert(grabPartnerReceipts).values({
      aggregatorAccountId: listing.id,
      route: "PUSH_INTEGRATION_STATUS",
      partnerMerchantId: body.partnerMerchantID,
      grabMerchantId: body.grabMerchantID,
      dedupeKey,
      requestHash,
      state: "PROCESSED",
      redactedPayload: { integrationStatus: body.integrationStatus },
      lastError: mirrorConflict,
      processedAt: now,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Identical repeat — the upsert above already re-applied the same state.
  }
}

// ---------------------------------------------------------------------------
// G6 — POST /menuSyncState
// ---------------------------------------------------------------------------

/**
 * Grab's explicit rule, quoted: "If two requests contain the same requestID,
 * only the first request should be considered and later requests must be
 * ignored or discarded." Checked INSIDE a transaction (so a concurrent
 * duplicate can't slip between the check and the insert) and additionally
 * backstopped by the partial unique index on request_id (grab-schema.ts).
 */
export async function handleMenuSyncState(db: DB, body: MenuSyncStateBody): Promise<void> {
  if (!body.partnerMerchantID) {
    // partnerMerchantID is the only field this module can resolve a listing
    // from (LISTING RESOLUTION requirement) — fail closed rather than guess.
    throw new GrabPartnerServiceError("VALIDATION_ERROR", "partnerMerchantID is required to resolve the channel listing.", 400);
  }
  const listing = await resolveGrabListing(db, body.partnerMerchantID);
  const requestHash = sha256Json(body);
  const dedupeKey = `menu-sync-state:${body.requestID}`;

  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: grabPartnerReceipts.id }).from(grabPartnerReceipts).where(eq(grabPartnerReceipts.requestId, body.requestID));
      if (existing) return; // first request already considered — this one is discarded.

      await tx.insert(grabPartnerReceipts).values({
        aggregatorAccountId: listing.id,
        route: "MENU_SYNC_STATE",
        partnerMerchantId: body.partnerMerchantID,
        grabMerchantId: body.merchantID,
        requestId: body.requestID,
        jobId: body.jobID,
        dedupeKey,
        requestHash,
        state: "PROCESSED",
        redactedPayload: { status: body.status, errorCount: body.errors?.length ?? 0 },
        processedAt: new Date(),
      });

      await tx
        .insert(grabMenuSyncJobs)
        .values({
          aggregatorAccountId: listing.id,
          jobId: body.jobID,
          status: body.status,
          errors: body.errors ?? [],
          updatedAtRemote: new Date(body.updatedAt),
        })
        .onConflictDoUpdate({
          target: [grabMenuSyncJobs.aggregatorAccountId, grabMenuSyncJobs.jobId],
          set: { status: body.status, errors: body.errors ?? [], updatedAtRemote: new Date(body.updatedAt), updatedAt: new Date() },
        });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // duplicate requestID — discarded per Grab's own rule.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// G7 — POST /pushGrabMenu
// ---------------------------------------------------------------------------

export async function handlePushGrabMenu(db: DB, input: { body: PushGrabMenuBody }): Promise<void> {
  const listing = await resolveGrabListing(db, input.body.partnerMerchantID);
  const requestHash = sha256Json(input.body);
  const dedupeKey = `push-grab-menu:${listing.id}:${requestHash}`;
  try {
    await db.insert(grabPartnerReceipts).values({
      aggregatorAccountId: listing.id,
      route: "PUSH_GRAB_MENU",
      partnerMerchantId: input.body.partnerMerchantID,
      grabMerchantId: input.body.merchantID ?? null,
      dedupeKey,
      requestHash,
      // Deliberately WAITING_DEPENDENCY, never PROCESSED: this build stores the
      // raw document only (spec's explicit "do not attempt to model or import
      // its interior" constraint) — there is no importer to run yet.
      state: "WAITING_DEPENDENCY",
      redactedPayload: { partnerMerchantID: input.body.partnerMerchantID, merchantID: input.body.merchantID ?? null },
      rawPayload: input.body,
      lastError: "Raw Grab menu document persisted only; no importer exists yet (out of scope for this build).",
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// G8 — GET /merchant/menu
// ---------------------------------------------------------------------------

// No currency is stored anywhere in ORION's schema — this is the pilot's
// operating currency (Philippine peso), a documented assumption, not a
// discovered fact. See the module's honest-constraint note below.
const ORION_DEFAULT_CURRENCY: GrabCurrency = { code: "PHP", symbol: "₱", exponent: 2 };
const SYNTHETIC_SELLING_TIME_ID = "orion-default-selling-time";
const SYNTHETIC_CATEGORY_ID = "orion-default-category";
const ALL_WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function toMinorUnits(amount: string | number, exponent: number): number {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return Math.round(value * 10 ** exponent);
}

/** Fail-closed (rule 14): an ORION availability value with no known Grab mapping resolves UNAVAILABLE, never guessed AVAILABLE. */
function mapAvailabilityToGrab(value: (typeof availabilityEnum.enumValues)[number]): "AVAILABLE" | "UNAVAILABLE" {
  switch (value) {
    case "AVAILABLE":
      return "AVAILABLE";
    case "PAUSED":
    case "SOLD_OUT":
      return "UNAVAILABLE";
    default: {
      const exhaustive: never = value;
      throw new Error(`Unmapped ORION availability value: ${String(exhaustive)}`);
    }
  }
}

/**
 * *** HONEST CONSTRAINT (spec Step 2, G8) — READ BEFORE "FIXING" THIS. ***
 * ORION's menu_item table (src/db/schema.ts) is FLAT: brandId, name, price,
 * availability, imageUrl, itemNo, remarks. There are NO categories, NO
 * modifier groups/modifiers, and NO selling-time/service-hours records
 * anywhere in the schema today, but Grab's GetMenu contract expects all
 * three. This projection is therefore deliberately MINIMAL, not a faithful
 * mapping:
 *   - ONE synthetic selling time, 00:00-23:59 every day of the week.
 *   - ONE synthetic category holding every item the brand has.
 *   - modifierGroups: [] on every item (ORION has no modifier data to send).
 * Nothing here is fabricated — this is the flattest legally-shaped Grab
 * response ORION's real data supports. Representing Grab's actual
 * category/modifier-group/selling-time structure requires a schema change
 * (new category, modifier-group/option, and selling-time tables) that is
 * OUT OF SCOPE for this build.
 */
async function projectGrabMenu(db: DB, input: { brandId: string; merchantId: string; partnerMerchantId: string }) {
  // Bounded, indexed (menu_item_brand_id_idx), single query for the whole
  // brand menu — exactly what this endpoint needs, no N+1, no unbounded scan.
  const items = await db
    .select({
      id: menuItems.id,
      name: menuItems.name,
      price: menuItems.price,
      availability: menuItems.availability,
      imageUrl: menuItems.imageUrl,
      itemNo: menuItems.itemNo,
      remarks: menuItems.remarks,
    })
    .from(menuItems)
    .where(eq(menuItems.brandId, input.brandId))
    .orderBy(asc(menuItems.name));

  const currency = ORION_DEFAULT_CURRENCY;
  const fullDayPeriod = { startTime: "00:00", endTime: "23:59" };
  const serviceHours = Object.fromEntries(ALL_WEEK_DAYS.map((day) => [day, { openPeriodType: "OpenPeriod" as const, periods: [fullDayPeriod] }]));

  return {
    merchantID: input.merchantId,
    partnerMerchantID: input.partnerMerchantId,
    currency,
    sellingTimes: [
      {
        id: SYNTHETIC_SELLING_TIME_ID,
        name: "All day",
        startTime: fullDayPeriod.startTime,
        endTime: fullDayPeriod.endTime,
        serviceHours,
      },
    ],
    categories: [
      {
        id: SYNTHETIC_CATEGORY_ID,
        name: "Menu",
        availableStatus: "AVAILABLE" as const,
        sellingTimeID: SYNTHETIC_SELLING_TIME_ID,
        sequence: 0,
        items: items.map((item, index) => ({
          id: item.itemNo ?? item.id,
          name: item.name,
          availableStatus: mapAvailabilityToGrab(item.availability),
          description: item.remarks ?? "",
          price: toMinorUnits(item.price, currency.exponent),
          photos: item.imageUrl ? [item.imageUrl] : [],
          sellingTimeID: SYNTHETIC_SELLING_TIME_ID,
          sequence: index,
          modifierGroups: [] as unknown[],
        })),
      },
    ],
  };
}

export type GrabMerchantMenuResponse = Awaited<ReturnType<typeof projectGrabMenu>>;

export async function getMerchantMenu(db: DB, query: GetMerchantMenuQuery): Promise<GrabMerchantMenuResponse> {
  const listing = await resolveGrabListing(db, query.partnerMerchantID);
  const menu = await projectGrabMenu(db, { brandId: listing.brandId, merchantId: query.merchantID, partnerMerchantId: query.partnerMerchantID });

  // Query-params-only audit receipt for GetMenu (grab-schema.ts migration
  // comment). A GET is non-mutating, so this is audit-only — no idempotency
  // gate needed; every real call is worth logging under its own random key.
  await db.insert(grabPartnerReceipts).values({
    aggregatorAccountId: listing.id,
    route: "GET_MENU",
    partnerMerchantId: query.partnerMerchantID,
    grabMerchantId: query.merchantID,
    dedupeKey: `get-menu:${randomUUID()}`,
    requestHash: sha256Json(query),
    state: "PROCESSED",
    redactedPayload: { merchantID: query.merchantID, partnerMerchantID: query.partnerMerchantID, businessType: query.BusinessType, itemCount: menu.categories[0]!.items.length },
    processedAt: new Date(),
  });

  return menu;
}
