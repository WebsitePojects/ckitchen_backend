/**
 * DELIVERECT middleware provider adapter — implements {@link MiddlewareAdapter}
 * per the same seam DummyProviderAdapter proves out (see ./adapter.ts's
 * header comment). Ships INERT: with no `DELIVERECT_HMAC_SECRET` set, every
 * webhook is rejected (fail closed, never "accept unsigned"). The moment the
 * client's Deliverect rep issues staging creds, paste them into
 * `DELIVERECT_HMAC_SECRET` (+ `DELIVERECT_HMAC_SECRET_PREVIOUS` for rotation)
 * and this adapter goes live with zero code changes.
 *
 * Facts below are from developers.deliverect.com as read 2026-07-21; anything
 * marked "confirm with Deliverect rep" is a best-effort guess pending a real
 * staging payload sample, not a verified contract.
 *
 * SIGNATURE SCHEME (differs from ORION's own DUMMY provider scheme in
 * ./signature.ts on purpose — Deliverect's HMAC has no timestamp-prefix
 * folded in, no key-id concept):
 *   digest = HMAC-SHA256(rawRequestBytes, secret) as a hex string
 *   secret = staging: the `channelLinkId` Deliverect issues for this POS
 *            connection; production: a separate secret Deliverect provides.
 *   header = "X-Deliverect-Hmac-Sha256" (CONFIRM EXACT HEADER NAME WITH
 *            DELIVERECT STAGING — Deliverect's public docs did not pin this
 *            down precisely at the time this adapter was written).
 * Because Deliverect's scheme has no timestamp/key-id, routes.ts special-
 * cases the DELIVERECT provider: it skips the generic X-Middleware-Timestamp
 * / X-Middleware-Key-Id / known-key-id / timestamp-freshness checks (which
 * only apply to ORION's own DUMMY scheme) and instead reads
 * X-Deliverect-Hmac-Sha256 directly into `headers.signature`, leaving
 * `headers.timestamp`/`headers.keyId` as empty placeholders this adapter
 * never reads.
 *
 * PAYLOAD SHAPE (CONFIRM WITH DELIVERECT REP — no verified staging sample
 * yet): a Deliverect channel-order webhook body includes `accountId`,
 * `locationId`, `channelLinkId`, `channel` (which delivery platform placed
 * the order), and an `order` object carrying Deliverect's own order id,
 * the aggregator's own order id, a status/cancellation signal, and line
 * items keyed by `plu`. This adapter assumes `order.status === "CANCELLED"`
 * marks a cancellation event (vs. a new/created order) and that each line
 * item's `plu` is directly usable as ORION's `menu_item_id` — CONFIRM WITH
 * REP: real Deliverect menu sync almost certainly needs its own
 * plu<->menu_item_id mapping table before go-live; this adapter deliberately
 * does NOT invent one, since building a mapping layer without a real payload
 * sample would just be guessing twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MiddlewareError } from "./errors.js";
import { resolveDeliverectChannel } from "./deliverect-secrets.js";
import type { MiddlewareAdapter, NormalizedProviderEvent, WebhookHeaders, WebhookSecrets } from "./types.js";

const HEX_SHA256_LEN = 64;
const MAX_ITEMS = 100;
const MAX_ID_LEN = 200;
const MAX_NOTE_LEN = 500;

const deliverectItemSchema = z
  .object({
    // "plu" is Deliverect's standard line-item product code field name.
    // CONFIRM WITH REP: assumed 1:1 with ORION menu_item_id (see file header).
    plu: z.string().trim().min(1).max(MAX_ID_LEN),
    quantity: z.number().int().positive(),
    remark: z.string().max(MAX_NOTE_LEN).optional(),
  })
  .passthrough();

const deliverectOrderSchema = z
  .object({
    // Deliverect's own order id — the idempotency anchor (providerEventId).
    id: z.string().trim().min(1).max(MAX_ID_LEN),
    // The channel's (aggregator's) own order id, when present — preferred as
    // external_ref since that's what ORION's own kitchen ops recognize.
    channelOrderId: z.string().trim().min(1).max(MAX_ID_LEN).optional(),
    status: z.string().max(50).optional(),
    creationDate: z.string().optional(),
    customer: z.object({ name: z.string().max(MAX_ID_LEN).optional() }).passthrough().optional(),
    items: z.array(deliverectItemSchema).max(MAX_ITEMS).optional(),
  })
  .passthrough();

const deliverectEnvelopeSchema = z
  .object({
    accountId: z.string().trim().min(1).max(MAX_ID_LEN),
    locationId: z.string().trim().min(1).max(MAX_ID_LEN),
    channelLinkId: z.string().trim().min(1).max(MAX_ID_LEN),
    channel: z.string().trim().min(1).max(100),
    order: deliverectOrderSchema,
  })
  .passthrough();

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Plain HMAC-SHA256(rawBytes, secret) hex digest — no timestamp prefix (Deliverect's own scheme, not ORION's). */
function computeDeliverectSignature(rawBytes: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBytes).digest("hex");
}

export class DeliverectProviderAdapter implements MiddlewareAdapter {
  readonly provider = "DELIVERECT";

  /**
   * `headers.signature` carries the raw X-Deliverect-Hmac-Sha256 header value
   * (routes.ts extracts it for this provider); `headers.timestamp`/`keyId`
   * are unused placeholders — Deliverect's scheme has neither concept.
   */
  verifySignature(rawBytes: Buffer, headers: WebhookHeaders, secrets: WebhookSecrets): boolean {
    const provided = headers.signature.trim().toLowerCase();
    if (provided.length !== HEX_SHA256_LEN) return false;
    const expectedCurrent = computeDeliverectSignature(rawBytes, secrets.current);
    if (safeEqualHex(provided, expectedCurrent)) return true;
    if (secrets.previous) {
      const expectedPrevious = computeDeliverectSignature(rawBytes, secrets.previous);
      if (safeEqualHex(provided, expectedPrevious)) return true;
    }
    return false;
  }

  parse(rawBytes: Buffer): NormalizedProviderEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBytes.toString("utf8"));
    } catch (err) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "Deliverect webhook body is not valid JSON.", 400, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const parsed = deliverectEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "Webhook body does not match the DELIVERECT envelope.", 400, parsed.error.issues);
    }
    const { channelLinkId, channel, order } = parsed.data;

    // CONFIRM WITH REP: assumed cancellation signal. Deliverect's real
    // "order rejected/cancelled" notification shape is unverified — fail
    // closed to ORDER_CREATED (never silently treat an unrecognized status
    // as a cancellation) unless status is unambiguously a cancel state.
    const CANCEL_STATUSES = new Set(["CANCELLED", "CANCELED", "REJECTED"]);
    const kind = order.status && CANCEL_STATUSES.has(order.status.toUpperCase()) ? "ORDER_CANCELLED" : "ORDER_CREATED";

    const externalRef = order.channelOrderId ?? order.id;
    const aggregator = resolveDeliverectChannel(channel);

    const items = (order.items ?? []).map((item) => ({
      menu_item_id: item.plu,
      qty: item.quantity,
      ...(item.remark !== undefined ? { notes: item.remark } : {}),
    }));

    if (kind === "ORDER_CREATED" && items.length === 0) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "Deliverect ORDER_CREATED events must include at least one item.", 400);
    }

    return {
      providerEventId: order.id,
      occurredAt: order.creationDate && !Number.isNaN(Date.parse(order.creationDate)) ? order.creationDate : new Date().toISOString(),
      kind,
      aggregator,
      // CONFIRM WITH REP: assumed the aggregator_account.external_merchant_id
      // for a Deliverect-mapped listing is populated with channelLinkId at
      // onboarding time (mirrors the DUMMY provider's merchant_id -> listing
      // resolution in processor.ts resolveListing).
      merchantRef: channelLinkId,
      orderPayload: {
        external_ref: externalRef,
        ...(order.customer?.name !== undefined ? { customer_name: order.customer.name } : {}),
        items,
      },
    };
  }
}
