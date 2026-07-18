/**
 * Shared types for the W5 outbound aggregator command module
 * (AGGREGATOR_API_INTEGRATION_SPEC.md §4-5: "Outbound: per-listing command
 * queue (accept/reject, mark-ready, ready-time, pause/resume, item
 * availability, menu notify) with idempotency keys, bounded retries, and a
 * full audit trail — the AggregatorOutboundAdapter interface; Grab/foodpanda
 * adapters implement it 1:1 from the tables above (a dummy adapter proves
 * the loop until credentials arrive).").
 *
 * The adapter boundary (AggregatorOutboundAdapter) is the seam a future Grab/
 * foodpanda partner-API adapter plugs into without any change to
 * service.ts's enqueue/dedupe/control-mode logic or worker.ts's claim-lease/
 * bounded-retry loop — only a new adapter.ts implementation is required.
 * Mirrors src/modules/middleware/types.ts's MiddlewareAdapter boundary for
 * the inbound side.
 */
import type { AggregatorCommand, aggregatorCommandStatusEnum, aggregatorCommandTypeEnum } from "../../db/outbound-schema.js";

export type OutboundCommandType = (typeof aggregatorCommandTypeEnum.enumValues)[number];
export type OutboundCommandStatus = (typeof aggregatorCommandStatusEnum.enumValues)[number];

/**
 * The command as handed to the adapter — provider-agnostic, credential-free.
 * A live adapter maps `commandType` 1:1 to the partner endpoint from spec §1
 * (e.g. ACCEPT_ORDER -> Grab `POST /partner/v1/order/prepare`).
 */
export interface OutboundCommandRequest {
  commandId: string;
  commandType: OutboundCommandType;
  /** The listing's partner-API merchant id (aggregator_account.api_merchant_id), when set. */
  apiMerchantId: string | null;
  /** The order's external_ref, for order-scoped command types; null for listing-scoped ones. */
  externalRef: string | null;
  payload: unknown;
  /** 1-based send attempt number for this call. */
  attempt: number;
}

/** RETRYABLE (network/5xx/timeout) backs off and retries; TERMINAL (4xx/rejected by the partner) DEAD-ends immediately. */
export type OutboundSendFailureKind = "RETRYABLE" | "TERMINAL";

export interface OutboundSendSuccess {
  ok: true;
  /** The aggregator's own response id for this command, if any. */
  providerRef?: string;
}

export interface OutboundSendFailure {
  ok: false;
  kind: OutboundSendFailureKind;
  message: string;
}

export type OutboundSendResult = OutboundSendSuccess | OutboundSendFailure;

/** Provider-agnostic adapter boundary — the dummy and eventual live provider implement the same interface. */
export interface AggregatorOutboundAdapter {
  readonly provider: string;
  sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult>;
}

export type { AggregatorCommand };
