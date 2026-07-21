/**
 * DUMMY middleware provider adapter (spec §11: "The dummy and eventual live
 * provider use the same adapter interface."). Implements
 * {@link MiddlewareAdapter}: HMAC-SHA256 signature verification over the
 * exact raw request bytes (see ./signature.ts), plus parsing the DUMMY
 * provider's fixed JSON envelope into a {@link NormalizedProviderEvent}.
 *
 * A future live provider (Deliverect / UrbanPiper / Otter) adds its own
 * adapter module implementing the same interface and is registered in
 * PROVIDER_ADAPTERS below — nothing in signature.ts, service.ts, or
 * processor.ts changes.
 */
import { z } from "zod";
import { MiddlewareError } from "./errors.js";
import { DeliverectProviderAdapter } from "./deliverect-adapter.js";
import { verifyHmacSignature } from "./signature.js";
import type {
  MiddlewareAdapter,
  NormalizedProviderEvent,
  WebhookHeaders,
  WebhookSecrets,
} from "./types.js";

const AGGREGATORS = ["FOODPANDA", "GRABFOOD", "OTHER"] as const;
const KINDS = ["ORDER_CREATED", "ORDER_CANCELLED"] as const;

const MAX_ITEMS = 100;
const MAX_ID_LEN = 200;
const MAX_NOTE_LEN = 500;

const itemSchema = z
  .object({
    menu_item_id: z.string().uuid(),
    qty: z.number().int().positive(),
    notes: z.string().max(MAX_NOTE_LEN).optional(),
  })
  .strict();

const orderSchema = z
  .object({
    external_ref: z.string().trim().min(1).max(MAX_ID_LEN),
    customer_name: z.string().max(MAX_ID_LEN).optional(),
    placed_at: z.string().datetime({ offset: true }).optional(),
    items: z.array(itemSchema).max(MAX_ITEMS).optional(),
  })
  .strict();

/** The DUMMY provider's fixed webhook envelope. */
const dummyEnvelopeSchema = z
  .object({
    event_id: z.string().trim().min(1).max(MAX_ID_LEN),
    event_type: z.enum(KINDS),
    occurred_at: z.string().datetime({ offset: true }),
    aggregator: z.enum(AGGREGATORS),
    merchant_id: z.string().trim().min(1).max(MAX_ID_LEN),
    order: orderSchema,
  })
  .strict();

export class DummyProviderAdapter implements MiddlewareAdapter {
  readonly provider = "DUMMY";

  verifySignature(rawBytes: Buffer, headers: WebhookHeaders, secrets: WebhookSecrets): boolean {
    return verifyHmacSignature(rawBytes, headers, secrets);
  }

  parse(rawBytes: Buffer): NormalizedProviderEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBytes.toString("utf8"));
    } catch (err) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "Webhook body is not valid JSON.", 400, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const parsed = dummyEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "Webhook body does not match the DUMMY provider envelope.", 400, parsed.error.issues);
    }
    const { event_id, event_type, occurred_at, aggregator, merchant_id, order } = parsed.data;

    if (event_type === "ORDER_CREATED" && (!order.items || order.items.length === 0)) {
      throw new MiddlewareError("MALFORMED_PAYLOAD", "ORDER_CREATED events must include at least one item.", 400);
    }

    return {
      providerEventId: event_id,
      occurredAt: occurred_at,
      kind: event_type,
      aggregator,
      merchantRef: merchant_id,
      orderPayload: {
        external_ref: order.external_ref,
        ...(order.customer_name !== undefined ? { customer_name: order.customer_name } : {}),
        ...(order.placed_at !== undefined ? { placed_at: order.placed_at } : {}),
        items: order.items ?? [],
      },
    };
  }
}

const PROVIDER_ADAPTERS: Record<string, MiddlewareAdapter> = {
  DUMMY: new DummyProviderAdapter(),
  // Deliverect (chosen middleware, D9/D28) — ships inert until
  // DELIVERECT_HMAC_SECRET is set (see deliverect-secrets.ts); routes.ts
  // special-cases this provider's header extraction (its HMAC scheme has no
  // timestamp/key-id, unlike the DUMMY scheme above).
  DELIVERECT: new DeliverectProviderAdapter(),
};

/** Resolves the adapter for a provider name; null when unregistered. */
export function getMiddlewareAdapter(provider: string): MiddlewareAdapter | null {
  return PROVIDER_ADAPTERS[provider] ?? null;
}
