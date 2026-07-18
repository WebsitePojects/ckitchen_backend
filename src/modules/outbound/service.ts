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
import { aggregatorCommands, type AggregatorCommand } from "../../db/outbound-schema.js";
import { aggregatorAccounts, auditLogs, brands, locations, menuItems, orders, type AggregatorAccount } from "../../db/schema.js";
import { OutboundError } from "./errors.js";
import {
  BLOCKED_AFTER_REJECT,
  LISTING_SCOPED_COMMAND_TYPES,
  ORDER_SCOPED_COMMAND_TYPES,
  OUTBOUND_COMMANDS_FLAG,
  SHADOW_MODE_ALLOWED_COMMAND_TYPES,
} from "./policies.js";
import type { OutboundCommandStatus, OutboundCommandType } from "./types.js";

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

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(aggregatorCommands).where(eq(aggregatorCommands.idempotencyKey, storedKey));
    if (existing) return existing; // idempotent replay — no new row, no new audit entry

    try {
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
    } catch (err) {
      // Two concurrent enqueues racing on the SAME stored key: one INSERT
      // wins, the other hits the idempotency_key unique violation. Return
      // the winner's row instead of a 500 (mirrors orders/service.ts FIX C).
      if (isUniqueViolation(err)) {
        const [raceExisting] = await tx.select().from(aggregatorCommands).where(eq(aggregatorCommands.idempotencyKey, storedKey));
        if (raceExisting) return raceExisting;
      }
      throw err;
    }
  });
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
  const totalRows = await db.select({ id: aggregatorCommands.id }).from(aggregatorCommands).where(whereClause);
  return { items, total: totalRows.length };
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
