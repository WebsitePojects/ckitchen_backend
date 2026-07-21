/**
 * DELIVERECT outbound adapter — implements {@link AggregatorOutboundAdapter}
 * (see ./types.ts's file header for the seam contract). Ships INERT: with no
 * `DELIVERECT_API_TOKEN` / `DELIVERECT_API_BASE_URL` set, every command
 * returns a TERMINAL "not configured" result — never a fabricated success.
 * The moment the client's Deliverect rep issues staging creds, paste them
 * into env and this adapter starts actually calling out.
 *
 * Facts below are from developers.deliverect.com as read 2026-07-21; anything
 * marked "confirm with Deliverect rep" is unverified pending real staging
 * access — Deliverect's public docs describe the POS status sequence and
 * busy-mode shape but do not pin down the exact auth flow or endpoint paths
 * ORION would call, so both are env-driven rather than hardcoded.
 *
 * STATUS SEQUENCE (POS -> Deliverect, confirm exact endpoint/verb with rep):
 *   Accepted -> Preparing -> Prepared -> Pick Up Ready -> Finalized
 * plus a reject path. Busy-mode (store pause) payload shape:
 *   { accountId, locationId, channelLinkId, status: "PAUSED" }
 *
 * AUTH: a Deliverect-issued API token / OAuth2 credential. This adapter
 * sends it as `Authorization: Bearer <DELIVERECT_API_TOKEN>` against
 * `DELIVERECT_API_BASE_URL` — CONFIRM WITH REP whether Deliverect actually
 * uses bearer-token auth or a full OAuth2 client-credentials exchange; do
 * NOT treat this as verified until staging access confirms it.
 */
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "./types.js";

/** Matches the global `fetch` signature closely enough for our one use (injectable so tests never hit the network). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface DeliverectCall {
  method: "POST" | "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

/**
 * command_type -> Deliverect call map. Every path below is a best-effort
 * guess at REST conventions Deliverect's docs imply (status update per
 * order, busy-mode per location) — CONFIRM EXACT PATHS WITH DELIVERECT REP
 * before flipping control_mode=API in production; nothing here has been
 * exercised against a real Deliverect endpoint.
 */
function buildCall(cmd: OutboundCommandRequest): DeliverectCall | { unsupported: true; message: string } {
  const orderRef = cmd.externalRef;
  switch (cmd.commandType) {
    case "ACCEPT_ORDER":
      if (!orderRef) return { unsupported: true, message: "ACCEPT_ORDER requires an order external_ref." };
      // CONFIRM WITH REP: Accepted vs Preparing — ORION fires ACCEPT_ORDER at
      // the NEW->PREPARING transition (business-rules.md #4/#6), which may
      // map to either "Accepted" or "Preparing" depending on how Deliverect
      // models the handshake. Using "Accepted" as the literal first status.
      return { method: "POST", path: `/orders/${encodeURIComponent(orderRef)}/status`, body: { status: "Accepted" } };
    case "REJECT_ORDER": {
      if (!orderRef) return { unsupported: true, message: "REJECT_ORDER requires an order external_ref." };
      const payload = (cmd.payload ?? {}) as Record<string, unknown>;
      return {
        method: "POST",
        path: `/orders/${encodeURIComponent(orderRef)}/reject`,
        body: { reason_code: payload["reason_code"], note: payload["note"] },
      };
    }
    case "MARK_READY":
      if (!orderRef) return { unsupported: true, message: "MARK_READY requires an order external_ref." };
      // CONFIRM WITH REP: "Prepared" vs "Pick Up Ready" — using the latter,
      // the status immediately preceding "Finalized" in Deliverect's sequence.
      return { method: "POST", path: `/orders/${encodeURIComponent(orderRef)}/status`, body: { status: "Pick Up Ready" } };
    case "UPDATE_READY_TIME": {
      if (!orderRef) return { unsupported: true, message: "UPDATE_READY_TIME requires an order external_ref." };
      const payload = (cmd.payload ?? {}) as Record<string, unknown>;
      return {
        method: "PATCH",
        path: `/orders/${encodeURIComponent(orderRef)}/status`,
        body: { status: "Preparing", estimatedReadyTime: payload["ready_time"] },
      };
    }
    case "PAUSE_STORE":
      // Payload shape per file header: { accountId, locationId, channelLinkId,
      // status }. accountId/locationId/channelLinkId are per-listing
      // Deliverect identifiers ORION does not currently persist beyond
      // aggregator_account.credential_ref/api_merchant_id — CONFIRM WITH REP
      // exactly which id(s) the busy-mode call expects; api_merchant_id is
      // used here as the best available stand-in.
      return { method: "POST", path: "/busy", body: { channelLinkId: cmd.apiMerchantId, status: "PAUSED" } };
    case "RESUME_STORE":
      return { method: "POST", path: "/busy", body: { channelLinkId: cmd.apiMerchantId, status: "OPEN" } };
    case "SET_ITEM_AVAILABILITY": {
      const payload = (cmd.payload ?? {}) as Record<string, unknown>;
      return { method: "POST", path: "/products/availability", body: payload };
    }
    case "NOTIFY_MENU_UPDATED":
      return { method: "POST", path: "/menu/sync", body: { channelLinkId: cmd.apiMerchantId } };
    case "CONTEST_CANCELLATION": {
      if (!orderRef) return { unsupported: true, message: "CONTEST_CANCELLATION requires an order external_ref." };
      const payload = (cmd.payload ?? {}) as Record<string, unknown>;
      return { method: "POST", path: `/orders/${encodeURIComponent(orderRef)}/dispute`, body: payload };
    }
    default: {
      // Fail closed on any command_type this adapter doesn't recognize
      // (idempotency-concurrency.md rule 14) rather than guessing an endpoint.
      const exhaustive: never = cmd.commandType;
      return { unsupported: true, message: `Unrecognized command_type "${String(exhaustive)}".` };
    }
  }
}

export class DeliverectOutboundAdapter implements AggregatorOutboundAdapter {
  readonly provider = "DELIVERECT";
  private readonly fetchImpl: FetchLike;

  /** `fetchImpl` defaults to global fetch; tests inject a stub so no real network call ever happens in the suite. */
  constructor(fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  async sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult> {
    const baseUrl = process.env.DELIVERECT_API_BASE_URL;
    const token = process.env.DELIVERECT_API_TOKEN;
    if (!baseUrl || !token) {
      return {
        ok: false,
        kind: "TERMINAL",
        message: "Deliverect not configured — paste DELIVERECT_API_TOKEN and DELIVERECT_API_BASE_URL into env.",
      };
    }

    const call = buildCall(cmd);
    if ("unsupported" in call) {
      return { ok: false, kind: "TERMINAL", message: call.message };
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${call.path}`;
    try {
      const res = await this.fetchImpl(url, {
        method: call.method,
        headers: {
          "Content-Type": "application/json",
          // CONFIRM WITH REP: bearer-token vs OAuth2 client-credentials (see
          // file header) — never log this header's value.
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(call.body),
      });

      if (res.ok) {
        let providerRef: string | undefined;
        try {
          const json = (await res.json()) as Record<string, unknown> | null;
          const id = json && typeof json === "object" ? json["id"] : undefined;
          if (typeof id === "string") providerRef = id;
        } catch {
          /* non-JSON or empty success body — fine, providerRef stays undefined */
        }
        return { ok: true, ...(providerRef !== undefined ? { providerRef } : {}) };
      }

      // 4xx = the partner rejected the request outright (TERMINAL, never
      // retried); 5xx = the partner's own failure (RETRYABLE).
      const kind = res.status >= 500 ? "RETRYABLE" : "TERMINAL";
      let message = `Deliverect responded ${res.status}`;
      try {
        const text = await res.text();
        // Never echo the Authorization header or raw token; response body is
        // the partner's own error text, not a secret.
        if (text) message = `${message}: ${text.slice(0, 500)}`;
      } catch {
        /* ignore body-read failure, keep the status-only message */
      }
      return { ok: false, kind, message };
    } catch (err) {
      // Network failure (DNS, timeout, connection reset) — always retryable.
      return { ok: false, kind: "RETRYABLE", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
