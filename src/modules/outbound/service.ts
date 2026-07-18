/**
 * Outbound aggregator command service (AGGREGATOR_API_INTEGRATION_SPEC.md
 * §4-5). Owns: enqueueing a command (validate listing + control_mode,
 * order-scope validation, the out-of-order guard, idempotency dedupe, actor
 * audit), listing commands for monitoring, updating a listing's
 * control_mode (audited), and the order-lifecycle hook orders/service.ts
 * calls on NEW->PREPARING / ->READY.
 *
 * Claiming + sending (the race-safe lease loop) lives in worker.ts — this
 * module only ever writes PENDING rows plus the control-mode/audit side
 * effects; it never talks to an adapter.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { menuItemOutlets, operationalFeatureFlags } from "../../db/enterprise-schema.js";
import {
  aggregatorCommands,
  menuOptionGroups,
  orderDisputes,
  type AggregatorCommand,
  type OrderDispute,
} from "../../db/outbound-schema.js";
import { aggregatorAccounts, auditLogs, brands, locations, menuItems, orders, type AggregatorAccount } from "../../db/schema.js";
import { OutboundError } from "./errors.js";
import {
  BLOCKED_AFTER_REJECT,
  LISTING_SCOPED_COMMAND_TYPES,
  ORDER_SCOPED_COMMAND_TYPES,
  OUTBOUND_COMMANDS_FLAG,
  SHADOW_MODE_ALLOWED_COMMAND_TYPES,
} from "./policies.js";
import {
  AVAILABILITY_SCOPES,
  DISPUTE_REASON_CODES,
  REJECT_REASON_CODES,
  type AvailabilityScope,
  type DisputeReasonCode,
  type OutboundCommandStatus,
  type OutboundCommandType,
  type RejectReasonCode,
} from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object") {
      const cause = e["cause"] as Record<string, unknown>;
      if (cause["code"] === "23505") return true;
    }
  }
  return false;
}

async function isOutboundEnabled(db: DB): Promise<boolean> {
  const [flag] = await db
    .select({ enabled: operationalFeatureFlags.enabled })
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, OUTBOUND_COMMANDS_FLAG));
  return flag?.enabled === true;
}

/**
 * §5 cutover gate: DEVICE never sends; SHADOW sends only NOTIFY_MENU_UPDATED
 * (read-only reconciliation); API sends everything.
 */
function assertControlModeAllows(listing: AggregatorAccount, commandType: OutboundCommandType): void {
  if (listing.controlMode === "API") return;
  if (listing.controlMode === "SHADOW" && SHADOW_MODE_ALLOWED_COMMAND_TYPES.has(commandType)) return;
  const shadowNote = listing.controlMode === "SHADOW" ? " (only NOTIFY_MENU_UPDATED is allowed in SHADOW)" : "";
  throw new OutboundError(
    "CONTROL_MODE",
    `Channel listing ${listing.id} is control_mode=${listing.controlMode}; ${commandType} requires API mode${shadowNote}.`,
    409,
    { control_mode: listing.controlMode, command_type: commandType },
  );
}

function buildStoredKey(input: { aggregatorAccountId: string; orderId?: string | null; commandType: OutboundCommandType; idempotencyKey: string }): string {
  return `${input.aggregatorAccountId}:${input.orderId ?? "L"}:${input.commandType}:${input.idempotencyKey}`;
}

function asPayloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

/**
 * Migration 0036 (finding H) — REJECT_ORDER's `reason` moves from free text
 * to a controlled vocabulary. `reason_code` must be one of
 * REJECT_REASON_CODES; `OTHER` additionally requires a non-empty `note`.
 */
function assertValidRejectReasonPayload(payload: unknown): void {
  const p = asPayloadObject(payload);
  const code = p["reason_code"];
  if (typeof code !== "string" || !(REJECT_REASON_CODES as readonly string[]).includes(code)) {
    throw new OutboundError(
      "VALIDATION",
      `REJECT_ORDER requires a valid "reason_code" (one of: ${REJECT_REASON_CODES.join(", ")}).`,
      400,
      { field: "reason_code" },
    );
  }
  if ((code as RejectReasonCode) === "OTHER") {
    const note = p["note"];
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new OutboundError(
        "VALIDATION",
        `REJECT_ORDER reason_code "OTHER" requires a non-empty free-text "note".`,
        400,
        { field: "note" },
      );
    }
  }
}

/**
 * Migration 0036 (finding F/G) — SET_ITEM_AVAILABILITY additive payload
 * fields: `scope` ("ITEM" default | "OPTION_GROUP"), `option_group_id`
 * (required + validated when scope=OPTION_GROUP), `unavailable_until`
 * (ISO date | null, foodpanda's yellow/grey snooze legend). A payload with
 * none of these fields (the pre-0036 shape) validates unchanged as ITEM.
 */
async function assertValidItemAvailabilityPayload(db: DB, listing: AggregatorAccount, payload: unknown): Promise<void> {
  const p = asPayloadObject(payload);
  const scopeRaw = p["scope"];
  const scope: AvailabilityScope = scopeRaw === undefined ? "ITEM" : (scopeRaw as AvailabilityScope);
  if (!(AVAILABILITY_SCOPES as readonly string[]).includes(scope)) {
    throw new OutboundError("VALIDATION", `SET_ITEM_AVAILABILITY "scope" must be one of: ${AVAILABILITY_SCOPES.join(", ")}.`, 400, {
      field: "scope",
    });
  }

  const optionGroupId = p["option_group_id"];
  if (scope === "OPTION_GROUP") {
    if (typeof optionGroupId !== "string" || !UUID_RE.test(optionGroupId)) {
      throw new OutboundError("VALIDATION", `SET_ITEM_AVAILABILITY scope=OPTION_GROUP requires a valid "option_group_id".`, 400, {
        field: "option_group_id",
      });
    }
    const [group] = await db.select().from(menuOptionGroups).where(eq(menuOptionGroups.id, optionGroupId));
    if (!group || group.brandId !== listing.brandId) {
      throw new OutboundError("NOT_FOUND", `Option group ${optionGroupId} not found for this listing's brand.`, 404);
    }
  } else if (optionGroupId !== undefined) {
    throw new OutboundError("VALIDATION", `"option_group_id" is only valid when scope=OPTION_GROUP.`, 400, {
      field: "option_group_id",
    });
  }

  const until = p["unavailable_until"];
  if (until !== undefined && until !== null) {
    if (typeof until !== "string" || Number.isNaN(Date.parse(until))) {
      throw new OutboundError("VALIDATION", `"unavailable_until" must be a valid ISO date string or null.`, 400, {
        field: "unavailable_until",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// enqueueCommand
// ---------------------------------------------------------------------------

export interface EnqueueCommandInput {
  aggregatorAccountId: string;
  orderId?: string | null;
  commandType: OutboundCommandType;
  payload?: unknown;
  /**
   * Combined with (listing, order, command_type) to form the stored,
   * globally-unique idempotency_key. HTTP callers pass their Idempotency-Key
   * header value (mirrors customer-orders/routes.ts's fulfill() contract);
   * the order-lifecycle hook always passes "AUTO" — safe because
   * advanceOrder's own conditional-update guard fires each stage transition
   * at most once per order.
   */
  idempotencyKey: string;
  actorUserId?: string | null;
  sessionId?: string | null;
  actorName?: string | null;
}

/**
 * Validates + dedupes + inserts one outbound command, auditing the actor.
 * Always runs in its own transaction — deliberately NOT offered as a
 * tx-composable helper. See enqueueLifecycleCommand below: outbound sync to
 * Grab/foodpanda is best-effort and must never block or roll back a stock-
 * critical order transition, so the order-lifecycle hook calls this AFTER
 * its own transaction has already committed.
 */
export async function enqueueCommand(db: DB, input: EnqueueCommandInput): Promise<AggregatorCommand> {
  if (!(await isOutboundEnabled(db))) {
    throw new OutboundError("FEATURE_DISABLED", `Operational feature "${OUTBOUND_COMMANDS_FLAG}" is disabled.`, 503, {
      feature: OUTBOUND_COMMANDS_FLAG,
    });
  }

  const [listing] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, input.aggregatorAccountId));
  if (!listing) {
    throw new OutboundError("NOT_FOUND", `Channel listing ${input.aggregatorAccountId} not found.`, 404);
  }

  assertControlModeAllows(listing, input.commandType);

  // Migration 0036 — per-command-type payload validation, centralized here so
  // every caller (generic route, sugar routes, createDispute, the order-
  // lifecycle hook) gets the same guarantees regardless of entry point.
  if (input.commandType === "REJECT_ORDER") {
    assertValidRejectReasonPayload(input.payload);
  } else if (input.commandType === "SET_ITEM_AVAILABILITY") {
    await assertValidItemAvailabilityPayload(db, listing, input.payload);
  }

  if (ORDER_SCOPED_COMMAND_TYPES.has(input.commandType)) {
    if (!input.orderId) {
      throw new OutboundError("VALIDATION", `${input.commandType} requires order_id.`, 400);
    }
    const [order] = await db
      .select({ id: orders.id, aggregatorAccountId: orders.aggregatorAccountId })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!order) {
      throw new OutboundError("NOT_FOUND", `Order ${input.orderId} not found.`, 404);
    }
    if (order.aggregatorAccountId !== input.aggregatorAccountId) {
      throw new OutboundError(
        "VALIDATION",
        `Order ${input.orderId} does not belong to channel listing ${input.aggregatorAccountId}.`,
        400,
      );
    }
  } else if (LISTING_SCOPED_COMMAND_TYPES.has(input.commandType) && input.orderId) {
    throw new OutboundError("VALIDATION", `${input.commandType} is listing-scoped and must not include order_id.`, 400);
  }

  // Out-of-order guard (spec: "an ACCEPT after REJECT for same order refused
  // with typed error at enqueue"): once a REJECT_ORDER exists for this
  // order, ACCEPT_ORDER/MARK_READY are refused regardless of send status.
  if (input.orderId && BLOCKED_AFTER_REJECT.has(input.commandType)) {
    const [rejected] = await db
      .select({ id: aggregatorCommands.id })
      .from(aggregatorCommands)
      .where(
        and(
          eq(aggregatorCommands.aggregatorAccountId, input.aggregatorAccountId),
          eq(aggregatorCommands.orderId, input.orderId),
          eq(aggregatorCommands.commandType, "REJECT_ORDER"),
        ),
      );
    if (rejected) {
      throw new OutboundError(
        "OUT_OF_ORDER",
        `Order ${input.orderId} was already rejected; ${input.commandType} is refused.`,
        409,
        { blocked_by: rejected.id },
      );
    }
  }

  const storedKey = buildStoredKey(input);

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(aggregatorCommands).where(eq(aggregatorCommands.idempotencyKey, storedKey));
      if (existing) return existing; // idempotent replay — no new row, no new audit entry

      const [created] = await tx
        .insert(aggregatorCommands)
        .values({
          aggregatorAccountId: input.aggregatorAccountId,
          orderId: input.orderId ?? null,
          commandType: input.commandType,
          payload: input.payload ?? {},
          idempotencyKey: storedKey,
          createdBy: input.actorUserId ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        actorUserId: input.actorUserId ?? null,
        actorName: input.actorName ?? null,
        sessionId: input.sessionId ?? null,
        locationId: listing.locationId,
        action: "aggregator_command.enqueued",
        description: `Enqueued ${input.commandType} for channel listing ${input.aggregatorAccountId}.`,
        entityType: "aggregator_command",
        entityId: created!.id,
        metadata: {
          commandType: input.commandType,
          aggregatorAccountId: input.aggregatorAccountId,
          orderId: input.orderId ?? null,
        },
      });

      return created!;
    });
  } catch (err) {
    // Two concurrent enqueues racing on the SAME stored key: one INSERT
    // wins, the other hits the idempotency_key unique violation. A failed
    // statement aborts the WHOLE transaction (Postgres: no further commands
    // until ROLLBACK) — the recovery re-query MUST run after that
    // transaction has unwound (via the outer `db`, not `tx`), never inside
    // the same aborted transaction. (This mirrors createDispute()'s
    // corrected pattern below — this call site previously ran the recovery
    // query on `tx` inside the same try/catch as the insert, which is the
    // exact "recovery inside the aborted transaction" pitfall.)
    if (isUniqueViolation(err)) {
      const [raceExisting] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.idempotencyKey, storedKey));
      if (raceExisting) return raceExisting;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Order-lifecycle hook (called from orders/service.ts advanceOrder)
// ---------------------------------------------------------------------------

export interface EnqueueLifecycleCommandInput {
  orderId: string;
  aggregatorAccountId: string | null;
  stage: "PREPARING" | "READY";
  actorUserId?: string | null;
}

/**
 * No-op unless `integration.outbound_commands` is ON AND the order's channel
 * listing is control_mode=API ("feature-flagged, no behavior change when
 * flag off or mode DEVICE"). Never throws for the common (disabled/DEVICE)
 * case; genuine failures (e.g. an unexpected DB error) propagate to the
 * caller, which wraps this in its own best-effort `.catch()`.
 */
export async function enqueueLifecycleCommand(db: DB, input: EnqueueLifecycleCommandInput): Promise<AggregatorCommand | null> {
  if (!input.aggregatorAccountId) return null;
  if (!(await isOutboundEnabled(db))) return null;

  const [listing] = await db
    .select({ controlMode: aggregatorAccounts.controlMode })
    .from(aggregatorAccounts)
    .where(eq(aggregatorAccounts.id, input.aggregatorAccountId));
  if (!listing || listing.controlMode !== "API") return null;

  const commandType: OutboundCommandType = input.stage === "PREPARING" ? "ACCEPT_ORDER" : "MARK_READY";
  return enqueueCommand(db, {
    aggregatorAccountId: input.aggregatorAccountId,
    orderId: input.orderId,
    commandType,
    payload: {},
    idempotencyKey: "AUTO",
    actorUserId: input.actorUserId ?? null,
  });
}

// ---------------------------------------------------------------------------
// updateControlMode
// ---------------------------------------------------------------------------

export interface UpdateControlModeInput {
  aggregatorAccountId: string;
  controlMode: "DEVICE" | "SHADOW" | "API";
  actorUserId: string;
  sessionId?: string | null;
  actorName?: string | null;
}

export async function updateControlMode(db: DB, input: UpdateControlModeInput): Promise<AggregatorAccount> {
  return db.transaction(async (tx) => {
    const [listing] = await tx.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, input.aggregatorAccountId));
    if (!listing) {
      throw new OutboundError("NOT_FOUND", `Channel listing ${input.aggregatorAccountId} not found.`, 404);
    }
    if (listing.controlMode === input.controlMode) {
      return listing; // no-op — nothing changed, nothing to audit
    }

    const [updated] = await tx
      .update(aggregatorAccounts)
      .set({ controlMode: input.controlMode })
      .where(eq(aggregatorAccounts.id, input.aggregatorAccountId))
      .returning();

    await tx.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      actorName: input.actorName ?? null,
      sessionId: input.sessionId ?? null,
      locationId: listing.locationId,
      action: "aggregator_account.control_mode_changed",
      description: `Channel listing ${input.aggregatorAccountId} control_mode: ${listing.controlMode} -> ${input.controlMode}.`,
      entityType: "aggregator_account",
      entityId: input.aggregatorAccountId,
      metadata: { from: listing.controlMode, to: input.controlMode },
    });

    return updated!;
  });
}

// ---------------------------------------------------------------------------
// listCommands (monitoring)
// ---------------------------------------------------------------------------

export interface ListCommandsInput {
  aggregatorAccountId?: string;
  status?: OutboundCommandStatus;
  limit: number;
  offset: number;
  /** undefined/null = ALL scope (no outlet filter); array = restrict to listings at these outlets. */
  allowedLocationIds?: string[] | null;
}

export interface ListCommandsPage {
  items: AggregatorCommand[];
  total: number;
}

export async function listCommands(db: DB, input: ListCommandsInput): Promise<ListCommandsPage> {
  const conditions = [];
  if (input.aggregatorAccountId) conditions.push(eq(aggregatorCommands.aggregatorAccountId, input.aggregatorAccountId));
  if (input.status) conditions.push(eq(aggregatorCommands.status, input.status));

  if (input.allowedLocationIds !== undefined && input.allowedLocationIds !== null) {
    const scopedListings = await db
      .select({ id: aggregatorAccounts.id })
      .from(aggregatorAccounts)
      .where(inArray(aggregatorAccounts.locationId, input.allowedLocationIds));
    const listingIds = scopedListings.map((r) => r.id);
    // Empty scope must produce an empty result, never an unfiltered query.
    conditions.push(inArray(aggregatorCommands.aggregatorAccountId, listingIds.length > 0 ? listingIds : ["00000000-0000-0000-0000-000000000000"]));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const items = await db
    .select()
    .from(aggregatorCommands)
    .where(whereClause)
    .orderBy(desc(aggregatorCommands.createdAt))
    .limit(input.limit)
    .offset(input.offset);
  // Migration 0036 (site-visit §7 scale note) — a SQL count(*) instead of a
  // full-row select().length: the old shape read every matching row just to
  // discard it for the count, which gets expensive as command/audit history
  // grows past 50+ listings (aggregator_command_account_status_created_idx
  // in outbound-schema.ts backs this same WHERE shape).
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aggregatorCommands)
    .where(whereClause);
  return { items, total: count };
}

export async function getCommandById(db: DB, id: string): Promise<AggregatorCommand | undefined> {
  const [row] = await db.select().from(aggregatorCommands).where(eq(aggregatorCommands.id, id));
  return row;
}

export async function getListingById(db: DB, id: string): Promise<AggregatorAccount | undefined> {
  const [row] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, id));
  return row;
}

// ---------------------------------------------------------------------------
// Merchant-console read side (shapes mirror ckitchen_frontend
// src/lib/merchant-console-api.ts — ChannelListing / ChannelListingItem).
// ---------------------------------------------------------------------------

export interface ChannelListingView {
  id: string;
  brand: { id: string; name: string; color: string };
  outlet: { id: string; name: string };
  aggregator: string;
  status: "ACTIVE" | "PAUSED" | "INACTIVE";
  controlMode: string;
  merchantId: string | null;
  pausedReason: string | null;
  pausedUntil: string | null;
  /** Migration 0036 (finding B) — per-listing accept-SLA override in seconds; null = 300s fallback. */
  acceptSlaSeconds: number | null;
}

/**
 * Lists channel listings joined to brand + physical outlet. `scopeLocationIds`
 * null = unscoped (ALL-outlet roles); otherwise only listings at those outlets.
 * Listing pause state is not yet persisted locally (a PAUSE_STORE command is
 * queued to the aggregator; store-status read-back arrives with the real
 * adapter), so status derives from is_active and paused fields stay null.
 */
export async function listChannelListings(
  db: DB,
  scopeLocationIds: string[] | null,
): Promise<ChannelListingView[]> {
  const where = scopeLocationIds === null
    ? undefined
    : scopeLocationIds.length === 0
      ? sql`false`
      : inArray(aggregatorAccounts.locationId, scopeLocationIds);
  const rows = await db
    .select({
      id: aggregatorAccounts.id,
      aggregator: aggregatorAccounts.aggregator,
      isActive: aggregatorAccounts.isActive,
      controlMode: aggregatorAccounts.controlMode,
      apiMerchantId: aggregatorAccounts.apiMerchantId,
      externalMerchantId: aggregatorAccounts.externalMerchantId,
      acceptSlaSeconds: aggregatorAccounts.acceptSlaSeconds,
      brandId: brands.id,
      brandName: brands.name,
      brandColor: brands.color,
      outletId: locations.id,
      outletName: locations.name,
    })
    .from(aggregatorAccounts)
    .innerJoin(brands, eq(aggregatorAccounts.brandId, brands.id))
    .innerJoin(locations, eq(aggregatorAccounts.locationId, locations.id))
    .where(where)
    .orderBy(brands.name, aggregatorAccounts.aggregator);
  return rows.map((r) => ({
    id: r.id,
    brand: { id: r.brandId, name: r.brandName, color: r.brandColor },
    outlet: { id: r.outletId, name: r.outletName },
    aggregator: r.aggregator,
    status: r.isActive ? ("ACTIVE" as const) : ("INACTIVE" as const),
    controlMode: r.controlMode,
    merchantId: r.apiMerchantId ?? r.externalMerchantId ?? null,
    pausedReason: null,
    pausedUntil: null,
    acceptSlaSeconds: r.acceptSlaSeconds ?? null,
  }));
}

export interface ChannelListingItemView {
  id: string;
  name: string;
  category: string | null;
  price: number | null;
  available: boolean;
}

/**
 * Menu items for the listing's brand with availability resolved the same way
 * order ingestion resolves it (orders/service.ts ~530): the per-outlet
 * deployment row overrides the item-level value when present.
 */
export async function listListingItems(
  db: DB,
  listing: AggregatorAccount,
): Promise<ChannelListingItemView[]> {
  const items = await db
    .select({
      id: menuItems.id,
      name: menuItems.name,
      price: menuItems.price,
      itemAvailability: menuItems.availability,
      deploymentAvailability: menuItemOutlets.availability,
    })
    .from(menuItems)
    .leftJoin(
      menuItemOutlets,
      and(
        eq(menuItemOutlets.menuItemId, menuItems.id),
        listing.locationId ? eq(menuItemOutlets.locationId, listing.locationId) : sql`false`,
      ),
    )
    .where(eq(menuItems.brandId, listing.brandId))
    .orderBy(menuItems.name);
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    category: null,
    price: i.price === null ? null : Number(i.price),
    available: (i.deploymentAvailability ?? i.itemAvailability) === "AVAILABLE",
  }));
}

// ---------------------------------------------------------------------------
// Dispute/contest workflow (migration 0036, site-visit finding N2)
// ---------------------------------------------------------------------------

export interface CreateDisputeInput {
  aggregatorAccountId: string;
  orderId: string;
  disputeReason: DisputeReasonCode;
  evidenceNote?: string | null;
  idempotencyKey: string;
  actorUserId?: string | null;
  sessionId?: string | null;
  actorName?: string | null;
}

/**
 * Raises a contest against a cancel-after-accept order: validates the order
 * is CANCELLED, enqueues a CONTEST_CANCELLATION aggregator_command (through
 * the normal enqueueCommand gates — feature flag, control_mode, listing
 * ownership), and records the durable order_dispute row linking to it.
 *
 * Idempotent two ways: (1) a repeat call for an order that ALREADY has a
 * dispute returns the existing row without enqueueing a second command; (2)
 * a race between two concurrent first-time calls is resolved by the
 * order_dispute_order_id_unique constraint — the loser re-reads and returns
 * the winner's row (FIX C style, mirrors enqueueCommand's own race handling).
 */
export async function createDispute(db: DB, input: CreateDisputeInput): Promise<OrderDispute> {
  if (!(DISPUTE_REASON_CODES as readonly string[]).includes(input.disputeReason)) {
    throw new OutboundError(
      "VALIDATION",
      `dispute_reason must be one of: ${DISPUTE_REASON_CODES.join(", ")}.`,
      400,
      { field: "dispute_reason" },
    );
  }

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      aggregatorAccountId: orders.aggregatorAccountId,
      locationId: orders.locationId,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order) {
    throw new OutboundError("NOT_FOUND", `Order ${input.orderId} not found.`, 404);
  }
  if (order.aggregatorAccountId !== input.aggregatorAccountId) {
    throw new OutboundError(
      "VALIDATION",
      `Order ${input.orderId} does not belong to channel listing ${input.aggregatorAccountId}.`,
      400,
    );
  }
  // Site-visit N2: only a cancel-after-accept order is contestable — this is
  // specifically the fraud pattern the client described ("biglang cancel...
  // natanggap na niya... parang modus"), not a general refund action.
  if (order.status !== "CANCELLED") {
    throw new OutboundError(
      "VALIDATION",
      `Order ${input.orderId} is ${order.status}; only a CANCELLED order can be contested.`,
      400,
      { status: order.status },
    );
  }

  const [existing] = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, input.orderId));
  if (existing) return existing; // idempotent replay — no new command, no new row

  const command = await enqueueCommand(db, {
    aggregatorAccountId: input.aggregatorAccountId,
    orderId: input.orderId,
    commandType: "CONTEST_CANCELLATION",
    payload: {
      dispute_reason: input.disputeReason,
      ...(input.evidenceNote ? { evidence_note: input.evidenceNote } : {}),
    },
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actorUserId ?? null,
    sessionId: input.sessionId ?? null,
    actorName: input.actorName ?? null,
  });

  try {
    return await db.transaction(async (tx) => {
      // enqueueCommand is itself idempotent on the exact key — a replay of
      // the SAME command may already have a dispute row linked to it.
      const [already] = await tx.select().from(orderDisputes).where(eq(orderDisputes.aggregatorCommandId, command.id));
      if (already) return already;

      const [created] = await tx
        .insert(orderDisputes)
        .values({
          orderId: input.orderId,
          raisedBy: input.actorUserId ?? null,
          reason: input.disputeReason,
          status: "OPEN",
          aggregatorCommandId: command.id,
          evidenceNote: input.evidenceNote ?? null,
        })
        .returning();

      await tx.insert(auditLogs).values({
        actorUserId: input.actorUserId ?? null,
        actorName: input.actorName ?? null,
        sessionId: input.sessionId ?? null,
        locationId: order.locationId,
        action: "order_dispute.raised",
        description: `Contested cancel-after-accept order ${input.orderId} (${input.disputeReason}).`,
        entityType: "order_dispute",
        entityId: created!.id,
        metadata: { orderId: input.orderId, aggregatorCommandId: command.id, reason: input.disputeReason },
      });

      return created!;
    });
  } catch (err) {
    // Race: two concurrent first-time contests for the same order — one
    // INSERT wins, the other hits order_dispute_order_id_unique. A failed
    // statement aborts the WHOLE transaction (Postgres: no further commands
    // until ROLLBACK) — the recovery re-query MUST run after that
    // transaction has unwound (via the outer `db`, not `tx`), never inside
    // the same aborted transaction.
    if (isUniqueViolation(err)) {
      const [raceExisting] = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, input.orderId));
      if (raceExisting) return raceExisting;
    }
    throw err;
  }
}

export interface ResolveDisputeInput {
  disputeId: string;
  status: "CONTESTED" | "RESOLVED_MERCHANT_FAVOR" | "RESOLVED_AGGREGATOR_FAVOR" | "EXPIRED";
  resolutionNote?: string | null;
  actorUserId?: string | null;
  sessionId?: string | null;
  actorName?: string | null;
}

/**
 * Internal reconciliation helper (no HTTP route in this stream — out of
 * scope per the mission's minimal-additive brief). Moves a dispute forward
 * in its lifecycle once the aggregator's own decision is known; a terminal
 * status stamps resolved_at. Not itself idempotent-guarded beyond ordinary
 * conditional semantics — callers are the future reconciliation job, not
 * end users racing each other.
 */
export async function resolveDispute(db: DB, input: ResolveDisputeInput): Promise<OrderDispute> {
  return db.transaction(async (tx) => {
    const [dispute] = await tx.select().from(orderDisputes).where(eq(orderDisputes.id, input.disputeId));
    if (!dispute) {
      throw new OutboundError("NOT_FOUND", `Dispute ${input.disputeId} not found.`, 404);
    }

    const isTerminal = input.status !== "CONTESTED";
    const [updated] = await tx
      .update(orderDisputes)
      .set({
        status: input.status,
        resolutionNote: input.resolutionNote ?? dispute.resolutionNote,
        resolvedAt: isTerminal ? new Date() : dispute.resolvedAt,
        updatedAt: new Date(),
      })
      .where(eq(orderDisputes.id, input.disputeId))
      .returning();

    await tx.insert(auditLogs).values({
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
      sessionId: input.sessionId ?? null,
      locationId: null,
      action: "order_dispute.resolved",
      description: `Dispute ${input.disputeId}: ${dispute.status} -> ${input.status}.`,
      entityType: "order_dispute",
      entityId: input.disputeId,
      metadata: { from: dispute.status, to: input.status },
    });

    return updated!;
  });
}

export interface ListDisputesInput {
  aggregatorAccountId?: string;
  status?: OrderDispute["status"];
  limit: number;
  offset: number;
  /** undefined/null = ALL scope; array = restrict to disputes whose order is at these outlets. */
  allowedLocationIds?: string[] | null;
}

export interface ListDisputesPage {
  items: OrderDispute[];
  total: number;
}

/**
 * Monitoring list mirroring listCommands' shape (GET /order-disputes) — "the
 * durable record of contested orders" the site-visit found ORION lacked.
 * Scoped through orders (order_dispute has no aggregator_account_id/
 * location_id of its own; the order's immutable outlet/listing snapshot is
 * the source of truth, same as everywhere else in this module).
 */
export async function listDisputes(db: DB, input: ListDisputesInput): Promise<ListDisputesPage> {
  const conditions = [];
  if (input.aggregatorAccountId) conditions.push(eq(orders.aggregatorAccountId, input.aggregatorAccountId));
  if (input.status) conditions.push(eq(orderDisputes.status, input.status));
  if (input.allowedLocationIds !== undefined && input.allowedLocationIds !== null) {
    conditions.push(
      inArray(orders.locationId, input.allowedLocationIds.length > 0 ? input.allowedLocationIds : ["00000000-0000-0000-0000-000000000000"]),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({ dispute: orderDisputes })
    .from(orderDisputes)
    .innerJoin(orders, eq(orderDisputes.orderId, orders.id))
    .where(whereClause)
    .orderBy(desc(orderDisputes.createdAt))
    .limit(input.limit)
    .offset(input.offset);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orderDisputes)
    .innerJoin(orders, eq(orderDisputes.orderId, orders.id))
    .where(whereClause);

  return { items: rows.map((r) => r.dispute), total: count };
}

export async function getDisputeById(db: DB, id: string): Promise<OrderDispute | undefined> {
  const [row] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, id));
  return row;
}
