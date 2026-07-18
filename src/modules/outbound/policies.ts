/**
 * Outbound command policy constants (AGGREGATOR_API_INTEGRATION_SPEC.md
 * §4-5): the feature flag key, KITCHEN_CREW's allowed command-type subset
 * ("server-side RBAC (OWNER/OUTLET_MANAGER for store pause; KITCHEN_CREW for
 * order actions)"), the §5 SHADOW-mode allowlist, the out-of-order guard,
 * and bounded-retry/backoff constants. Mirrors src/modules/middleware/
 * processor.ts's backoffMs/MAX_PROCESSING_ATTEMPTS and src/modules/printing/
 * service-v2.ts's MAX_PRINT_ATTEMPTS/DEFAULT_LEASE_SECONDS.
 */
import type { OutboundCommandType } from "./types.js";

export const OUTBOUND_COMMANDS_FLAG = "integration.outbound_commands";

export const MAX_SEND_ATTEMPTS = 3;
export const DEFAULT_LEASE_SECONDS = 60;

/** Deterministic backoff in ms — same shape as middleware/processor.ts's backoffMs. */
export function outboundBackoffMs(attempts: number): number {
  return Math.min(attempts, MAX_SEND_ATTEMPTS) ** 2 * 1000;
}

/** Order-scoped command types — order_id is REQUIRED at enqueue. */
export const ORDER_SCOPED_COMMAND_TYPES: ReadonlySet<OutboundCommandType> = new Set([
  "ACCEPT_ORDER",
  "REJECT_ORDER",
  "MARK_READY",
  "UPDATE_READY_TIME",
  // Migration 0036 (finding N2) — a contest is always raised against one
  // cancelled order. Only enqueued via service.ts createDispute(); the
  // generic POST /commands route refuses this command_type (routes.ts).
  "CONTEST_CANCELLATION",
]);

/** Listing-scoped command types — order_id must be absent. */
export const LISTING_SCOPED_COMMAND_TYPES: ReadonlySet<OutboundCommandType> = new Set([
  "PAUSE_STORE",
  "RESUME_STORE",
  "SET_ITEM_AVAILABILITY",
  "NOTIFY_MENU_UPDATED",
]);

/** The generic POST /channel-listings/:id/commands route: KITCHEN_CREW may only send order actions. */
export const KITCHEN_CREW_ALLOWED_COMMAND_TYPES: ReadonlySet<OutboundCommandType> = new Set([
  "ACCEPT_ORDER",
  "REJECT_ORDER",
  "MARK_READY",
]);

/**
 * §5 cutover: SHADOW mode is read-only reconciliation — NOTIFY_MENU_UPDATED
 * is the one command type allowed out of a SHADOW listing (never an order-
 * or store-affecting command).
 */
export const SHADOW_MODE_ALLOWED_COMMAND_TYPES: ReadonlySet<OutboundCommandType> = new Set([
  "NOTIFY_MENU_UPDATED",
]);

/**
 * Out-of-order guard: once REJECT_ORDER has been enqueued for an order, no
 * ACCEPT_ORDER or MARK_READY may follow it — a rejected order can never be
 * accepted or marked ready after the fact.
 */
export const BLOCKED_AFTER_REJECT: ReadonlySet<OutboundCommandType> = new Set([
  "ACCEPT_ORDER",
  "MARK_READY",
]);
