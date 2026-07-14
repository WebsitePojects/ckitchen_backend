/**
 * Shared types for the W5 middleware integration module (spec §11).
 *
 * The adapter boundary (MiddlewareAdapter) is the seam a future live
 * provider (Deliverect / UrbanPiper / Otter) plugs into without any change
 * to signature.ts's HMAC primitives, service.ts's intake/idempotency logic,
 * or processor.ts's listing-resolution + ingestOrder call — only a new
 * adapter.ts implementation + its registration is required.
 */

/** One channel-listing aggregator, mirrors src/db/schema.ts's aggregatorEnum. */
export type MiddlewareAggregator = "FOODPANDA" | "GRABFOOD" | "OTHER";

export type ProviderEventKind = "ORDER_CREATED" | "ORDER_CANCELLED";

export type ProviderEventState =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "MAPPING_REQUIRED"
  | "WAITING_DEPENDENCY"
  | "FAILED"
  | "QUARANTINED";

/** One item line of a normalized order payload — matches IngestOrderInput's item shape. */
export interface NormalizedOrderItem {
  menu_item_id: string;
  qty: number;
  notes?: string;
}

/**
 * The normalized, ingestOrder-compatible order payload carried by an
 * ORDER_CREATED event. Absent (undefined) on ORDER_CANCELLED events, which
 * only need `external_ref` to locate the order to cancel.
 */
export interface NormalizedOrderPayload {
  external_ref: string;
  customer_name?: string;
  placed_at?: string;
  items: NormalizedOrderItem[];
}

/**
 * The adapter's parsed output — provider-agnostic, ready for the processor
 * to resolve a channel listing and call orders/service.ts `ingestOrder` (or
 * `cancelOrder`). Never carries secrets or the provider's raw unredacted
 * payload; `orderPayload` already IS the redacted/normalized form persisted
 * to `provider_event.redacted_payload`.
 */
export interface NormalizedProviderEvent {
  /** The provider's own event/message id — the idempotency anchor. */
  providerEventId: string;
  occurredAt: string; // ISO-8601
  kind: ProviderEventKind;
  aggregator: MiddlewareAggregator;
  /** external_merchant_id — half of the §8 channel listing identity. */
  merchantRef: string;
  /** Present for both kinds; ORDER_CANCELLED payloads only populate external_ref. */
  orderPayload: NormalizedOrderPayload;
}

/** Headers the intake route extracts before any parsing happens. */
export interface WebhookHeaders {
  timestamp: string;
  keyId: string;
  signature: string;
}

/** Current + optional previous secret (rotation overlap, spec §11). */
export interface WebhookSecrets {
  current: string;
  previous?: string;
}

/**
 * Provider-agnostic adapter boundary (spec §11: "The dummy and eventual live
 * provider use the same adapter interface."). `verifySignature` MUST be
 * called on the exact raw bytes before `parse` ever runs.
 */
export interface MiddlewareAdapter {
  readonly provider: string;
  verifySignature(rawBytes: Buffer, headers: WebhookHeaders, secrets: WebhookSecrets): boolean;
  parse(rawBytes: Buffer): NormalizedProviderEvent;
}
