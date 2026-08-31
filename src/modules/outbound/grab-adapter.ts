/**
 * GrabFood Partner API (v1.1.3) outbound adapter — implements
 * {@link AggregatorOutboundAdapter} (see ./types.ts's file header for the
 * seam contract). Ships INERT: with any of GRAB_API_CLIENT_ID /
 * GRAB_API_CLIENT_SECRET / GRAB_API_ENV unset, every command returns a
 * TERMINAL "not configured" result — never a fabricated success, never a
 * guessed endpoint (fail closed, idempotency-concurrency.md rule 14).
 *
 * Every endpoint this adapter calls is quoted verbatim from the scraped
 * GrabFood Partner API v1.1.3 reference (developer.grab.com/docs/grabfood/
 * api/v1-1-3/). Command types with no verified Grab endpoint are left
 * unmapped and return a TERMINAL "not yet mapped" failure rather than a
 * guessed path — see CONTEST_CANCELLATION below.
 *
 * ENVIRONMENTS: one domain (https://partner-api.grab.com, overridable via
 * GRAB_API_BASE_URL) for both staging and production; the path prefix
 * differs and is selected by GRAB_API_ENV:
 *   staging     /grabfood-sandbox/partner/v1
 *   production  /grabfood/partner/v1
 * (worked example in the docs: POST .../grabfood-sandbox/partner/v1/merchant/menu/notification).
 *
 * OAUTH: client-credentials grant against a SEPARATE host,
 * https://api.grab.com/grabid/v1/oauth2/token (overridable via
 * GRAB_API_TOKEN_URL), scope "food.partner_api":
 *   POST { client_id, client_secret, grant_type: "client_credentials", scope: "food.partner_api" }
 *   200  { access_token, token_type: "Bearer", expires_in }
 * The token is cached in memory and refreshed before expiry with a safety
 * margin; a 401 on a protected call triggers exactly ONE re-login + retry,
 * never a loop. The client secret and access token are never logged or
 * returned (security.md, rule 11).
 *
 * RATE LIMITS Grab enforces per PROJECT (shared across outlets) — this
 * adapter does not itself throttle (that is the outbound worker's bounded
 * retry/backoff loop's job), but every call below is deliberately routed at
 * the single-record endpoint, not the tighter batch one, except where a
 * SET_ITEM_AVAILABILITY command carries more than one item:
 *   Batch update menu record ....... 1  request/second   <- tightest
 *   Update menu notification ....... 10 requests/second
 *   Mark orders ready .............. 10 requests/second
 *   Update menu record ............. 40 requests/second
 *   Order + store endpoints ......... 5 requests/second
 * Update menu notification additionally holds a distributed interval lock
 * (default 120s): a repeat call inside the window returns 409
 * invalid_argument "sync menu too frequently, retry after 120 seconds" —
 * that specific 409 is RETRYABLE (a throttle, not a rejection); every other
 * 4xx is TERMINAL. Grab's SLA requires <1% partner error rate and responses
 * within 10s, so every request carries an 8s timeout.
 */
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "./types.js";

export type GrabFailureKind = "RETRYABLE" | "TERMINAL";

export interface GrabSuccess<T = unknown> {
  ok: true;
  status: number;
  data: T;
  providerRef?: string;
}

export interface GrabFailure {
  ok: false;
  kind: GrabFailureKind;
  message: string;
}

export type GrabResult<T = unknown> = GrabSuccess<T> | GrabFailure;

export type GrabFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface GrabClientConfig {
  clientId?: string;
  clientSecret?: string;
  /** Single domain for both environments; see file header. */
  baseUrl?: string;
  /** Selects the path prefix; required — never guessed/defaulted (fail closed). */
  env?: "staging" | "production";
  tokenUrl?: string;
}

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT";

const DEFAULT_BASE_URL = "https://partner-api.grab.com";
/** Verified at tag/get-oauth-grab: post/grabid/v1/oauth2/token on api.grab.com — a different host than the partner API. */
const DEFAULT_TOKEN_URL = "https://api.grab.com/grabid/v1/oauth2/token";
const OAUTH_SCOPE = "food.partner_api";

/** Below Grab's 10s partner-response SLA (file header) so a stalled call fails fast enough to retry within the same worker lease. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Refresh this long before the token's stated expiry, never exactly at it. */
const TOKEN_REFRESH_SAFETY_MARGIN_MS = 60_000;
/** Only used if a 200 login response is missing/malformed expires_in — conservative, never treated as long-lived. */
const FALLBACK_TOKEN_TTL_MS = 5 * 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;
/** Grab's own batch-update-menu-items cap (docs: "maximum 200 items per request"). */
const MAX_BATCH_MENU_ITEMS = 200;

const NOT_CONFIGURED_MESSAGE =
  'Grab not configured — set GRAB_API_CLIENT_ID, GRAB_API_CLIENT_SECRET, and GRAB_API_ENV ("staging" | "production").';

function readConfigFromEnv(): Required<Pick<GrabClientConfig, "clientId" | "clientSecret" | "env">> &
  Pick<GrabClientConfig, "baseUrl" | "tokenUrl"> | null {
  const clientId = process.env.GRAB_API_CLIENT_ID;
  const clientSecret = process.env.GRAB_API_CLIENT_SECRET;
  const env = process.env.GRAB_API_ENV;
  if (!clientId || !clientSecret || (env !== "staging" && env !== "production")) return null;
  return {
    clientId,
    clientSecret,
    env,
    baseUrl: process.env.GRAB_API_BASE_URL || DEFAULT_BASE_URL,
    tokenUrl: process.env.GRAB_API_TOKEN_URL || DEFAULT_TOKEN_URL,
  };
}

function normalizeConfig(
  config?: GrabClientConfig,
): (Required<Pick<GrabClientConfig, "clientId" | "clientSecret" | "env">> & Pick<GrabClientConfig, "baseUrl" | "tokenUrl">) | null {
  if (!config) return readConfigFromEnv();
  const { clientId, clientSecret, env } = config;
  if (!clientId || !clientSecret || (env !== "staging" && env !== "production")) return null;
  return {
    clientId,
    clientSecret,
    env,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    tokenUrl: config.tokenUrl || DEFAULT_TOKEN_URL,
  };
}

type NormalizedConfig = NonNullable<ReturnType<typeof normalizeConfig>>;

function pathPrefix(env: "staging" | "production"): string {
  return env === "staging" ? "/grabfood-sandbox/partner/v1" : "/grabfood/partner/v1";
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: string): string {
  return value.length <= MAX_ERROR_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}

function sanitizeMessage(value: string, secrets: Array<string | null | undefined>): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret && secret.length > 0) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return bounded(sanitized);
}

/** True for dotted-quad IPv4 literals and any hostname containing ":" (bracketed/unbracketed IPv6 literals). DNS names never contain ":". */
function isIpLiteralHostname(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * SSRF gate applied to every URL this adapter is about to fetch (both the
 * OAuth token host and the partner API host — they legitimately differ, see
 * file header, so the check is host-suffix based rather than pinned to one
 * exact host). https only, no embedded credentials, no IP literal, no
 * non-default port, and the hostname must BE "grab.com" or END WITH
 * ".grab.com" (anchored suffix — "notgrab.com" and "grab.com.evil.tld" both
 * fail this). Mirrors foodpanda-adapter.ts's isAllowedFoodpandaCallbackUrl.
 */
export function isAllowedGrabUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "") return false;

  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) return false;
  if (isIpLiteralHostname(hostname)) return false;

  return hostname === "grab.com" || hostname.endsWith(".grab.com");
}

function safeHostname(rawUrl: string): string {
  try {
    const hostname = new URL(rawUrl).hostname;
    return hostname.length > 0 ? hostname : "(no-host)";
  } catch {
    return "(unparseable)";
  }
}

function urlRejected(rawUrl: string): GrabFailure {
  return { ok: false, kind: "TERMINAL", message: `Grab request URL rejected by allowlist (host: ${safeHostname(rawUrl)}).` };
}

/** A 3xx is a security event, not a transient fault — never followed. Location header deliberately not read/reported. */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function redirectRefused(status: number): GrabFailure {
  return { ok: false, kind: "TERMINAL", message: `Grab request refused: host responded ${status} redirect, which is not followed.` };
}

async function readResponseBody(res: Awaited<ReturnType<GrabFetchLike>>): Promise<{ text: string; data: unknown | undefined }> {
  if (res.text) {
    const text = await res.text();
    if (!text) return { text: "", data: undefined };
    try {
      return { text, data: JSON.parse(text) };
    } catch {
      return { text, data: undefined };
    }
  }
  if (res.json) {
    const data = await res.json();
    return { text: "", data };
  }
  return { text: "", data: undefined };
}

/**
 * Classifies a non-2xx HTTP status. The menu-notification distributed
 * interval lock returns 409 invalid_argument "sync menu too frequently,
 * retry after 120 seconds" (file header) — that is a throttle, not a
 * rejection, so it is RETRYABLE; every other 409/4xx is TERMINAL. 429 and
 * 5xx are always RETRYABLE.
 */
function classifyHttpFailure(status: number, bodyText: string): GrabFailureKind {
  if (status === 409 && /too frequently/i.test(bodyText)) return "RETRYABLE";
  if (status === 429) return "RETRYABLE";
  if (status >= 500) return "RETRYABLE";
  return "TERMINAL";
}

function tokenFrom(data: unknown): { accessToken: string; expiresInSeconds: number | null } | null {
  if (!isJsonObject(data)) return null;
  const accessToken = data["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const expiresIn = data["expires_in"];
  return { accessToken, expiresInSeconds: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : null };
}

/**
 * Thin client for the pieces of the GrabFood Partner API this adapter maps
 * commands to: OAuth login (cached, single-retry-on-401) and one generic
 * protected request() used by every mapped command. Injectable fetch so
 * the test suite never calls the real network.
 */
export class GrabPartnerApiClient {
  private readonly fetchImpl: GrabFetchLike;
  private readonly explicitConfig?: GrabClientConfig;
  private accessToken: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(fetchImpl: GrabFetchLike = fetch as unknown as GrabFetchLike, config?: GrabClientConfig) {
    this.fetchImpl = fetchImpl;
    this.explicitConfig = config;
  }

  clearCachedToken(): void {
    this.accessToken = null;
    this.tokenExpiresAtMs = 0;
  }

  configOrFailure(): { ok: true; config: NormalizedConfig } | GrabFailure {
    const config = normalizeConfig(this.explicitConfig);
    if (!config) return { ok: false, kind: "TERMINAL", message: NOT_CONFIGURED_MESSAGE };
    return { ok: true, config };
  }

  async request(method: HttpMethod, path: string, jsonBody: JsonObject): Promise<GrabResult> {
    const configResult = this.configOrFailure();
    if (!configResult.ok) return configResult;
    const config = configResult.config;

    const firstToken = await this.ensureToken(config);
    if (!firstToken.ok) return firstToken;

    const first = await this.fetchOnce(config, method, path, jsonBody, firstToken.data);
    if ("networkError" in first) return first.networkError;
    if (isRedirect(first.res.status)) return redirectRefused(first.res.status);
    if (first.res.status !== 401) return this.resultFromResponse(first.res, config);

    // Exactly one refresh-and-retry on 401 — never a loop (idempotency-concurrency.md rule 8 spirit: bounded retry).
    this.clearCachedToken();
    const refreshedToken = await this.login(config);
    if (!refreshedToken.ok) return refreshedToken;

    const retry = await this.fetchOnce(config, method, path, jsonBody, refreshedToken.data);
    if ("networkError" in retry) return retry.networkError;
    if (isRedirect(retry.res.status)) return redirectRefused(retry.res.status);
    return this.resultFromResponse(retry.res, config);
  }

  private async ensureToken(config: NormalizedConfig): Promise<GrabResult<string>> {
    if (this.accessToken && Date.now() < this.tokenExpiresAtMs) {
      return { ok: true, status: 0, data: this.accessToken };
    }
    return this.login(config);
  }

  private async login(config: NormalizedConfig): Promise<GrabResult<string>> {
    if (!isAllowedGrabUrl(config.tokenUrl!)) return urlRejected(config.tokenUrl!);
    try {
      const res = await this.fetchImpl(config.tokenUrl!, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "client_credentials",
          scope: OAUTH_SCOPE,
        }),
      });

      if (isRedirect(res.status)) return redirectRefused(res.status);

      const body = await readResponseBody(res);
      if (!res.ok) {
        const kind = classifyHttpFailure(res.status, body.text);
        return {
          ok: false,
          kind,
          message: `Grab OAuth token request responded ${res.status}${body.text ? `: ${sanitizeMessage(body.text, [config.clientSecret])}` : ""}`,
        };
      }

      const token = tokenFrom(body.data);
      if (!token) return { ok: false, kind: "TERMINAL", message: "Grab OAuth token response did not include an access_token." };

      this.accessToken = token.accessToken;
      const ttlMs = token.expiresInSeconds !== null ? token.expiresInSeconds * 1000 : FALLBACK_TOKEN_TTL_MS;
      this.tokenExpiresAtMs = Date.now() + Math.max(ttlMs - TOKEN_REFRESH_SAFETY_MARGIN_MS, 0);
      return { ok: true, status: res.status, data: token.accessToken };
    } catch (err) {
      return {
        ok: false,
        kind: "RETRYABLE",
        message: sanitizeMessage(err instanceof Error ? err.message : String(err), [config.clientSecret, this.accessToken]),
      };
    }
  }

  private async fetchOnce(
    config: NormalizedConfig,
    method: HttpMethod,
    path: string,
    jsonBody: JsonObject,
    token: string,
  ): Promise<{ res: Awaited<ReturnType<GrabFetchLike>> } | { networkError: GrabFailure }> {
    const url = `${config.baseUrl!.replace(/\/+$/, "")}${pathPrefix(config.env)}${path}`;
    if (!isAllowedGrabUrl(url)) return { networkError: urlRejected(url) };

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        // Manual mode surfaces a 3xx as a response instead of following it; callers reject it via isRedirect().
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify(jsonBody),
      });
      return { res };
    } catch (err) {
      return {
        networkError: {
          ok: false,
          kind: "RETRYABLE",
          message: sanitizeMessage(err instanceof Error ? err.message : String(err), [config.clientSecret, token, this.accessToken]),
        },
      };
    }
  }

  private async resultFromResponse(res: Awaited<ReturnType<GrabFetchLike>>, config: NormalizedConfig): Promise<GrabResult> {
    const body = await readResponseBody(res);
    if (res.ok) {
      return { ok: true, status: res.status, data: body.data };
    }
    const kind = classifyHttpFailure(res.status, body.text);
    return {
      ok: false,
      kind,
      message: `Grab responded ${res.status}${body.text ? `: ${sanitizeMessage(body.text, [config.clientSecret, this.accessToken])}` : ""}`,
    };
  }
}

function toOutboundResult(result: GrabResult): OutboundSendResult {
  if (result.ok) return { ok: true };
  return { ok: false, kind: result.kind, message: result.message };
}

// ---------------------------------------------------------------------------
// Command -> verified Grab endpoint mapping
// ---------------------------------------------------------------------------

interface GrabCall {
  method: HttpMethod;
  path: string;
  body: JsonObject;
}

type BuildCallResult = { ok: true; call: GrabCall } | { ok: false; message: string };

function requireOrderId(cmd: OutboundCommandRequest): { ok: true; orderId: string } | { ok: false; message: string } {
  if (!cmd.externalRef) return { ok: false, message: `${cmd.commandType} requires order external_ref/orderID.` };
  return { ok: true, orderId: cmd.externalRef };
}

function requireMerchantId(cmd: OutboundCommandRequest): { ok: true; merchantId: string } | { ok: false; message: string } {
  if (!cmd.apiMerchantId) return { ok: false, message: `${cmd.commandType} requires apiMerchantId/merchantID.` };
  return { ok: true, merchantId: cmd.apiMerchantId };
}

function payloadObject(cmd: OutboundCommandRequest): JsonObject {
  const payload = cmd.payload ?? {};
  return isJsonObject(payload) ? payload : {};
}

/**
 * Verified at tag/update-order-ready-time: PUT /order/readytime
 * { orderID, newOrderReadyTime } (ISO_8601/RFC3339 string) -> 204.
 * Accepts the same payload field names the Foodpanda adapter accepts, so
 * upstream callers do not need per-provider payload shapes.
 */
function readyTimeBody(payload: JsonObject): { ok: true; body: JsonObject } | { ok: false; message: string } {
  const newOrderReadyTime = payload["newOrderReadyTime"] ?? payload["ready_time"] ?? payload["expectedPickupAt"];
  if (typeof newOrderReadyTime !== "string" || newOrderReadyTime.length === 0) {
    return { ok: false, message: "UPDATE_READY_TIME requires payload.ready_time / newOrderReadyTime / expectedPickupAt." };
  }
  return { ok: true, body: { newOrderReadyTime } };
}

const PAUSE_DURATIONS = new Set(["30m", "1h", "24h"]);

/** Verified at tag/pause-store: PUT /merchant/pause { merchantID, isPause, duration? } -> 204. duration is required by Grab when isPause=true. */
function pauseBody(merchantId: string, payload: JsonObject): { ok: true; body: JsonObject } | { ok: false; message: string } {
  const duration = payload["duration"];
  if (typeof duration !== "string" || !PAUSE_DURATIONS.has(duration)) {
    return { ok: false, message: 'PAUSE_STORE requires payload.duration to be one of "30m", "1h", "24h".' };
  }
  return { ok: true, body: { merchantID: merchantId, isPause: true, duration } };
}

interface ItemAvailabilityInput {
  items: string[];
  available: boolean;
  field: "ITEM" | "MODIFIER";
}

/**
 * Verified at tag/update-menu-record: PUT /menu (single record) and
 * PUT /batch/menu (up to 200 records). Setting an item UNAVAILABLE also
 * requires maxStock=0 per the docs' explicit note; setting it AVAILABLE
 * omits maxStock so Grab's own inventory value is left untouched.
 */
function itemAvailabilityInput(payload: JsonObject): { ok: true; input: ItemAvailabilityInput } | { ok: false; message: string } {
  const itemsRaw = payload["items"];
  const singleId = payload["item_id"] ?? payload["itemId"];
  const items = Array.isArray(itemsRaw) ? itemsRaw : typeof singleId === "string" ? [singleId] : null;
  const available = typeof payload["isAvailable"] === "boolean" ? payload["isAvailable"] : payload["available"];
  const scope = payload["scope"];

  if (!Array.isArray(items) || items.length === 0 || !items.every((item) => typeof item === "string" && item.length > 0)) {
    return { ok: false, message: "SET_ITEM_AVAILABILITY requires one or more item ids." };
  }
  if (items.length > MAX_BATCH_MENU_ITEMS) {
    return { ok: false, message: `SET_ITEM_AVAILABILITY exceeds Grab's ${MAX_BATCH_MENU_ITEMS}-item batch limit.` };
  }
  if (typeof available !== "boolean") {
    return { ok: false, message: "SET_ITEM_AVAILABILITY requires boolean available/isAvailable." };
  }
  if (scope !== undefined && scope !== "ITEM" && scope !== "OPTION_GROUP") {
    return { ok: false, message: 'SET_ITEM_AVAILABILITY scope must be "ITEM" or "OPTION_GROUP".' };
  }

  return { ok: true, input: { items, available, field: scope === "OPTION_GROUP" ? "MODIFIER" : "ITEM" } };
}

function menuEntity(id: string, available: boolean): JsonObject {
  const availableStatus = available ? "AVAILABLE" : "UNAVAILABLE";
  return available ? { id, availableStatus } : { id, availableStatus, maxStock: 0 };
}

function itemAvailabilityCall(merchantId: string, input: ItemAvailabilityInput): GrabCall {
  if (input.items.length === 1) {
    return { method: "PUT", path: "/menu", body: { merchantID: merchantId, field: input.field, ...menuEntity(input.items[0]!, input.available) } };
  }
  return {
    method: "PUT",
    path: "/batch/menu",
    body: { merchantID: merchantId, field: input.field, menuEntities: input.items.map((id) => menuEntity(id, input.available)) },
  };
}

/**
 * Maps a provider-agnostic command to a verified GrabFood Partner API call.
 * Every path/body pair here is quoted from the scraped v1.1.3 reference —
 * see this file's header for the section names. Fails closed on any
 * unrecognized command_type (idempotency-concurrency.md rule 14): the
 * `default` branch below is reached only for a value TypeScript's
 * exhaustiveness check cannot rule out (e.g. a future enum addition Grab
 * has not been wired for), and it rejects rather than falling through to
 * any endpoint.
 */
function buildCall(cmd: OutboundCommandRequest): BuildCallResult {
  switch (cmd.commandType) {
    case "ACCEPT_ORDER": {
      // Verified at tag/accept-reject-order: POST /order/prepare { orderID, toState: "Accepted" | "Rejected" } -> 204.
      const orderId = requireOrderId(cmd);
      if (!orderId.ok) return orderId;
      return { ok: true, call: { method: "POST", path: "/order/prepare", body: { orderID: orderId.orderId, toState: "Accepted" } } };
    }
    case "REJECT_ORDER": {
      // CONTRACT GAP, deliberate and lossy: Grab's accept/reject body is only
      // { orderID, toState } — there is no reason/code field anywhere in the
      // operation. ORION's REJECT_REASON_CODES (OUT_OF_STOCK, KITCHEN_CLOSED,
      // TOO_BUSY, ...) therefore CANNOT reach Grab and are dropped here on
      // purpose; they survive only in ORION's own aggregator_command payload
      // and audit trail. foodpanda accepts a richer rejection, so the two
      // channels will never report rejection reasons at the same fidelity.
      // Do NOT invent a reason field to "fix" this — Grab would reject it.
      const orderId = requireOrderId(cmd);
      if (!orderId.ok) return orderId;
      return { ok: true, call: { method: "POST", path: "/order/prepare", body: { orderID: orderId.orderId, toState: "Rejected" } } };
    }
    case "MARK_READY": {
      // Verified at tag/mark-order-ready: POST /orders/mark { orderID, markStatus: 1 } -> 204. markStatus 2 (dine-in
      // completed) is a distinct partner action ORION does not currently raise this command_type for.
      const orderId = requireOrderId(cmd);
      if (!orderId.ok) return orderId;
      return { ok: true, call: { method: "POST", path: "/orders/mark", body: { orderID: orderId.orderId, markStatus: 1 } } };
    }
    case "UPDATE_READY_TIME": {
      const orderId = requireOrderId(cmd);
      if (!orderId.ok) return orderId;
      const body = readyTimeBody(payloadObject(cmd));
      if (!body.ok) return body;
      return { ok: true, call: { method: "PUT", path: "/order/readytime", body: { orderID: orderId.orderId, ...body.body } } };
    }
    case "PAUSE_STORE": {
      const merchantId = requireMerchantId(cmd);
      if (!merchantId.ok) return merchantId;
      const body = pauseBody(merchantId.merchantId, payloadObject(cmd));
      if (!body.ok) return body;
      return { ok: true, call: { method: "PUT", path: "/merchant/pause", body: body.body } };
    }
    case "RESUME_STORE": {
      // Verified at tag/pause-store: duration is only documented as required when isPause=true; omitted here.
      const merchantId = requireMerchantId(cmd);
      if (!merchantId.ok) return merchantId;
      return { ok: true, call: { method: "PUT", path: "/merchant/pause", body: { merchantID: merchantId.merchantId, isPause: false } } };
    }
    case "SET_ITEM_AVAILABILITY": {
      const merchantId = requireMerchantId(cmd);
      if (!merchantId.ok) return merchantId;
      const input = itemAvailabilityInput(payloadObject(cmd));
      if (!input.ok) return input;
      return { ok: true, call: itemAvailabilityCall(merchantId.merchantId, input.input) };
    }
    case "NOTIFY_MENU_UPDATED": {
      // Verified at tag/update-menu-notification: POST /merchant/menu/notification { merchantID } -> 204.
      const merchantId = requireMerchantId(cmd);
      if (!merchantId.ok) return merchantId;
      return { ok: true, call: { method: "POST", path: "/merchant/menu/notification", body: { merchantID: merchantId.merchantId } } };
    }
    case "CONTEST_CANCELLATION":
      // UNMAPPED — deliberately. The scraped v1.1.3 reference has no dispute/contest-cancellation operation:
      // "Cancel order" (PUT /order/cancel) and "Check order cancelable" (GET /order/cancelable) both cancel an
      // order FROM the merchant's side, which is the opposite of CONTEST_CANCELLATION's purpose (the merchant
      // disputing a cancellation that already happened, per outbound-schema.ts's migration-0036 comment). "Refund
      // Order" (POST /orders/refund) is about refunding a completed order, not disputing a cancellation, either.
      // Guessing one of these would repeat the exact failure mode this task was written to prevent.
      return { ok: false, message: "Grab CONTEST_CANCELLATION has no verified Grab Partner API endpoint in the scraped v1.1.3 reference; unmapped." };
    default: {
      const exhaustive: never = cmd.commandType;
      return { ok: false, message: `Grab unsupported command_type "${String(exhaustive)}".` };
    }
  }
}

export class GrabOutboundAdapter implements AggregatorOutboundAdapter {
  readonly provider = "GRABFOOD";
  private readonly client: GrabPartnerApiClient;

  constructor(fetchImpl: GrabFetchLike = fetch as unknown as GrabFetchLike, config?: GrabClientConfig) {
    this.client = new GrabPartnerApiClient(fetchImpl, config);
  }

  async sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult> {
    const configResult = this.client.configOrFailure();
    if (!configResult.ok) return { ok: false, kind: configResult.kind, message: configResult.message };

    const call = buildCall(cmd);
    if (!call.ok) return { ok: false, kind: "TERMINAL", message: call.message };

    return toOutboundResult(await this.client.request(call.call.method, call.call.path, call.call.body));
  }
}
