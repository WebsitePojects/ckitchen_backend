/**
 * Deliverect inbound webhook signing secret loader — deliberately separate
 * from ./secrets.ts (ORION's own DUMMY/internal webhook secret scheme) so a
 * Deliverect secret rotation never collides with, or gets confused for, the
 * DUMMY provider's `MIDDLEWARE_WEBHOOK_SECRET*`.
 *
 * Per Deliverect (developers.deliverect.com, 2026-07-21, confirm with rep):
 * staging HMAC secret = the `channelLinkId` Deliverect issues for the POS
 * connection; production = a separate secret Deliverect provides. Both are
 * pasted into `DELIVERECT_HMAC_SECRET` — ORION does not care which one it is,
 * it is just "the current secret". `_PREVIOUS` supports a brief rotation
 * overlap, mirroring loadWebhookSecrets' current/previous pattern.
 *
 * Fails closed: if unset in a non-test environment, callers MUST reject the
 * webhook (never fall back to "accept unsigned").
 */
import type { WebhookSecrets } from "./types.js";

const TEST_SECRET = "test-deliverect-hmac-secret";

/** Returns null (never a fallback secret) when unconfigured outside tests — callers must fail closed. */
export function loadDeliverectHmacSecrets(): WebhookSecrets | null {
  const current = process.env.DELIVERECT_HMAC_SECRET;
  if (current) {
    const previous = process.env.DELIVERECT_HMAC_SECRET_PREVIOUS;
    return previous ? { current, previous } : { current };
  }
  if (process.env.NODE_ENV === "test") {
    const previous = process.env.DELIVERECT_HMAC_SECRET_PREVIOUS;
    return previous ? { current: TEST_SECRET, previous } : { current: TEST_SECRET };
  }
  return null;
}

export const DEFAULT_TEST_DELIVERECT_SECRET = TEST_SECRET;

/**
 * Deliverect `channel` -> ORION aggregator enum map. Deliverect's exact
 * channel string values are per-account (confirm with Deliverect rep during
 * staging onboarding) — this is a best-guess default covering the two
 * aggregators ORION cares about today; anything unrecognized falls back to
 * "OTHER" (fail-closed on classification, never silently misroute an order
 * to the wrong aggregator enum).
 */
const DEFAULT_CHANNEL_MAP: Record<string, "FOODPANDA" | "GRABFOOD"> = {
  foodpanda: "FOODPANDA",
  FOODPANDA: "FOODPANDA",
  deliveroo_foodpanda: "FOODPANDA",
  grabfood: "GRABFOOD",
  GRABFOOD: "GRABFOOD",
  grab: "GRABFOOD",
};

/**
 * Optional env override `DELIVERECT_CHANNEL_MAP` (JSON object, e.g.
 * `{"panda":"FOODPANDA","grab":"GRABFOOD"}`) for when the rep confirms the
 * account's actual channel string values differ from the defaults above.
 * Malformed JSON is ignored (falls back to defaults) rather than crashing
 * webhook intake.
 */
export function resolveDeliverectChannel(channel: string): "FOODPANDA" | "GRABFOOD" | "OTHER" {
  const raw = process.env.DELIVERECT_CHANNEL_MAP;
  if (raw) {
    try {
      const override = JSON.parse(raw) as Record<string, unknown>;
      const mapped = override[channel];
      if (mapped === "FOODPANDA" || mapped === "GRABFOOD") return mapped;
    } catch {
      /* ignore malformed override, fall through to defaults */
    }
  }
  return DEFAULT_CHANNEL_MAP[channel] ?? "OTHER";
}
