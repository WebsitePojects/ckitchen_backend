/**
 * Foodpanda / Delivery Hero Integration Middleware API v2 outbound adapter.
 *
 * Phase 1 deliberately implements only the outbound client seam. It is inert
 * until all FOODPANDA_* env vars are present; no default Middleware URL is
 * assumed. Tests inject fetch, so the suite never calls Foodpanda.
 *
 * The local OpenAPI file references shared schemas that are not present in
 * Documents/foodpanda-api. Direct JSON client methods therefore validate only
 * the safe boundary invariant we can prove here: body must be a non-array
 * object. Legacy XML menu endpoints require an explicit string XML body and
 * never synthesize XML/catalogs.
 */
import type { AggregatorOutboundAdapter, OutboundCommandRequest, OutboundSendResult } from "./types.js";

export type FoodpandaFailureKind = "RETRYABLE" | "TERMINAL";

export interface FoodpandaSuccess<T = unknown> {
  ok: true;
  status: number;
  data: T;
  providerRef?: string;
}

export interface FoodpandaFailure {
  ok: false;
  kind: FoodpandaFailureKind;
  message: string;
}

export type FoodpandaResult<T = unknown> = FoodpandaSuccess<T> | FoodpandaFailure;

export type FoodpandaFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

/** Backward-compatible short alias matching the existing Deliverect adapter's injectable fetch type naming. */
export type FetchLike = FoodpandaFetchLike;

export interface FoodpandaClientConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  chainCode?: string;
}

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT";

interface RequestOptions {
  jsonBody?: JsonObject;
  xmlBody?: string;
  query?: Record<string, string | number | undefined>;
}

const NOT_CONFIGURED_MESSAGE =
  "Foodpanda not configured — set FOODPANDA_MIDDLEWARE_BASE_URL, FOODPANDA_MIDDLEWARE_USERNAME, FOODPANDA_MIDDLEWARE_PASSWORD, and FOODPANDA_CHAIN_CODE.";

const MAX_ERROR_MESSAGE_LENGTH = 500;

function readConfigFromEnv(): Required<FoodpandaClientConfig> | null {
  const baseUrl = process.env.FOODPANDA_MIDDLEWARE_BASE_URL;
  const username = process.env.FOODPANDA_MIDDLEWARE_USERNAME;
  const password = process.env.FOODPANDA_MIDDLEWARE_PASSWORD;
  const chainCode = process.env.FOODPANDA_CHAIN_CODE;
  if (!baseUrl || !username || !password || !chainCode) return null;
  return { baseUrl, username, password, chainCode };
}

function normalizeConfig(config?: FoodpandaClientConfig): Required<FoodpandaClientConfig> | null {
  if (!config) return readConfigFromEnv();
  const { baseUrl, username, password, chainCode } = config;
  if (!baseUrl || !username || !password || !chainCode) return null;
  return { baseUrl, username, password, chainCode };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireJsonObject(value: unknown, label: string): FoodpandaResult<JsonObject> {
  if (!isJsonObject(value)) {
    return { ok: false, kind: "TERMINAL", message: `${label} body must be a non-array JSON object.` };
  }
  return { ok: true, status: 0, data: value };
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

function baseUrl(config: Required<FoodpandaClientConfig>): string {
  return config.baseUrl.replace(/\/+$/, "");
}

function buildUrl(config: Required<FoodpandaClientConfig>, path: string, query?: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${baseUrl(config)}${path}${qs ? `?${qs}` : ""}`;
}

async function readResponseBody(res: Awaited<ReturnType<FoodpandaFetchLike>>): Promise<{ text: string; data: unknown | undefined }> {
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

function providerRefFrom(data: unknown): string | undefined {
  if (!isJsonObject(data)) return undefined;
  for (const key of ["id", "menuImportId", "processId", "traceId", "status"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function objectToFormUrlEncoded(value: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, v] of Object.entries(value)) body.set(key, v);
  return body.toString();
}

/**
 * Delivery Hero domain suffixes that inbound `callbackUrls.*` fields
 * (pluginOrder.yaml schema CallbackUrls) are allowed to point at, when
 * FOODPANDA_CALLBACK_HOST_SUFFIXES is unset/empty. Sourced from the server
 * `url:`/doc-link hosts actually present in Documents/foodpanda-api
 * (middlewareExternalApi.yaml, pluginOrder.yaml): integration-middleware.eu.,
 * integration-middleware.stg., menu-importer.eu. — all under restaurant-partners.com.
 */
const DEFAULT_CALLBACK_HOST_SUFFIXES = ["restaurant-partners.com"];

/** Comma-separated override; see isAllowedFoodpandaCallbackUrl for how this is consumed. */
function callbackHostSuffixes(): string[] {
  const raw = process.env.FOODPANDA_CALLBACK_HOST_SUFFIXES;
  if (!raw) return DEFAULT_CALLBACK_HOST_SUFFIXES;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_CALLBACK_HOST_SUFFIXES;
}

/** True for dotted-quad IPv4 literals and any hostname containing ":" (bracketed/unbracketed IPv6 literals). DNS names never contain ":". */
function isIpLiteralHostname(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** Best-effort hostname-only extraction for error messages/logs — never echoes the full URL (which may carry a token in its query string). */
function safeCallbackHostname(rawUrl: string): string {
  try {
    const hostname = new URL(rawUrl).hostname;
    return hostname.length > 0 ? hostname : "(no-host)";
  } catch {
    return "(unparseable)";
  }
}

/**
 * SSRF gate for inbound Delivery Hero `callbackUrls.*` values (pluginOrder.yaml
 * schema CallbackUrls: orderAcceptedUrl/orderRejectedUrl/orderPickedUpUrl/
 * orderPreparedUrl/orderProductModificationUrl/orderPreparationTimeAdjustmentUrl).
 * These arrive inside an inbound HTTP request from the network, so a raw POST to
 * an attacker-supplied URL would be SSRF (cloud metadata, localhost, internal
 * hosts). Fails closed: anything unparseable or not affirmatively allowed is
 * rejected. Allowlist is read from FOODPANDA_CALLBACK_HOST_SUFFIXES (comma-
 * separated Delivery Hero domain suffixes) with DEFAULT_CALLBACK_HOST_SUFFIXES
 * as the built-in fallback when that env var is unset/empty.
 */
export function isAllowedFoodpandaCallbackUrl(rawUrl: string): boolean {
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
  if (hostname === "localhost") return false;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  if (isIpLiteralHostname(hostname)) return false;

  return callbackHostSuffixes().some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** A 3xx on a callback POST is refused, never followed — see fetchProtectedAbsolute(). */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Terminal (never retried): a redirect off an allowlisted callback host is a security event, not
 * a transient fault. The Location header is deliberately not read or reported — it is
 * attacker-influenced and may carry credentials.
 */
function redirectRefused(status: number): FoodpandaFailure {
  return {
    ok: false,
    kind: "TERMINAL",
    message: `Foodpanda callback refused: host responded ${status} redirect, which is not followed.`,
  };
}

export class FoodpandaMiddlewareClient {
  private readonly fetchImpl: FoodpandaFetchLike;
  private readonly explicitConfig?: FoodpandaClientConfig;
  private accessToken: string | null = null;

  constructor(fetchImpl: FoodpandaFetchLike = fetch as unknown as FoodpandaFetchLike, config?: FoodpandaClientConfig) {
    this.fetchImpl = fetchImpl;
    this.explicitConfig = config;
  }

  clearCachedToken(): void {
    this.accessToken = null;
  }

  async updateOrderStatus(orderToken: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda order status update");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/order/status/${segment(orderToken)}`, { jsonBody: checked.data });
  }

  async markPreparationCompleted(orderToken: string): Promise<FoodpandaResult> {
    return this.request("POST", `/v2/orders/${segment(orderToken)}/preparation-completed`);
  }

  async adjustPreparationTime(orderToken: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda preparation-time adjustment");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/orders/${segment(orderToken)}/adjust-preparation-time`, { jsonBody: checked.data });
  }

  async getVendorAvailability(posVendorId: string): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/remoteVendors/${segment(posVendorId)}/availability`);
  }

  async setVendorAvailability(posVendorId: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda vendor availability");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/chains/${segment(config.config.chainCode)}/remoteVendors/${segment(posVendorId)}/availability`, {
      jsonBody: checked.data,
    });
  }

  async submitCatalog(body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda catalog import");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/chains/${segment(config.config.chainCode)}/catalog`, { jsonBody: checked.data });
  }

  async getPlatformVendors(posVendorId: string): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/vendors/${segment(posVendorId)}/platform-vendors`);
  }

  async submitGlobalEntityCatalog(globalEntityId: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda global-entity catalog import");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/chains/${segment(config.config.chainCode)}/global-entity/${segment(globalEntityId)}/catalog`, {
      jsonBody: checked.data,
    });
  }

  async getMenuImportLogs(
    posVendorId: string,
    query: { from?: string; to?: string; limit?: string | number; sort?: "asc" | "desc" } = {},
  ): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/vendors/${segment(posVendorId)}/menu-import-logs`, { query });
  }

  async submitLegacyMenuImport(posVendorId: string, xmlBody: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    if (typeof xmlBody !== "string") return unsupportedXmlBody();
    return this.request("POST", `/v2/chains/${segment(config.config.chainCode)}/remoteVendors/${segment(posVendorId)}/menuImport`, { xmlBody });
  }

  async submitTriggeredLegacyMenu(vendorCode: string, menuImportId: string, xmlBody: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    if (typeof xmlBody !== "string") return unsupportedXmlBody();
    return this.request("POST", `/v2/menu/${segment(vendorCode)}/${segment(menuImportId)}`, { xmlBody });
  }

  async updatePosReachabilityStatus(posVendorId: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda POS reachability status");
    if (!checked.ok) return checked;
    return this.request("PUT", `/v2/chains/${segment(config.config.chainCode)}/remoteVendors/${segment(posVendorId)}/posReachabilityStatus`, {
      jsonBody: checked.data,
    });
  }

  async getOrderIds(query: { status: "accepted" | "cancelled"; pastNumberOfHours?: number; vendorId?: string }): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    if (query.status !== "accepted" && query.status !== "cancelled") {
      return { ok: false, kind: "TERMINAL", message: `Foodpanda order id status must be "accepted" or "cancelled".` };
    }
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/orders/ids`, { query });
  }

  async getOrderDetails(orderId: string): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/orders/${segment(orderId)}`);
  }

  async updateCatalogItemsAvailability(posVendorId: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda catalog item availability");
    if (!checked.ok) return checked;
    return this.request("POST", `/v2/chains/${segment(config.config.chainCode)}/vendors/${segment(posVendorId)}/catalog/items/availability`, {
      jsonBody: checked.data,
    });
  }

  async getUnavailableCatalogItems(posVendorId: string): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    return this.request("GET", `/v2/chains/${segment(config.config.chainCode)}/vendors/${segment(posVendorId)}/catalog/items/unavailable`);
  }

  async modifyOrderProducts(orderToken: string, body: unknown): Promise<FoodpandaResult> {
    const config = this.configOrFailure();
    if (!config.ok) return config;
    const checked = requireJsonObject(body, "Foodpanda order product modification");
    if (!checked.ok) return checked;
    return this.request("POST", `/v2/order/${segment(orderToken)}/modifications/product`, { jsonBody: checked.data });
  }

  /**
   * POSTs to an inbound-supplied Delivery Hero callback URL (pluginOrder.yaml
   * CallbackUrls, e.g. dispatchOrderPayload.callbackUrls.orderAcceptedUrl —
   * "To be called with POST HTTP method to accept the order"), reusing the
   * same bearer-token login + single 401 retry as request(). The URL is
   * network-supplied, so it is checked against isAllowedFoodpandaCallbackUrl
   * first; a rejected URL is a TERMINAL failure (a bad URL never becomes good
   * on retry) and the message logs only the parsed hostname, never the full
   * URL, since the query string may carry a token.
   */
  async postFoodpandaCallback(rawUrl: string, body: unknown): Promise<FoodpandaResult> {
    if (!isAllowedFoodpandaCallbackUrl(rawUrl)) {
      return {
        ok: false,
        kind: "TERMINAL",
        message: `Foodpanda callback URL rejected by allowlist (host: ${safeCallbackHostname(rawUrl)}).`,
      };
    }
    const checked = requireJsonObject(body, "Foodpanda callback");
    if (!checked.ok) return checked;
    return this.requestAbsolute("POST", rawUrl, { jsonBody: checked.data });
  }

  private configOrFailure(): { ok: true; config: Required<FoodpandaClientConfig> } | FoodpandaFailure {
    const config = normalizeConfig(this.explicitConfig);
    if (!config) return { ok: false, kind: "TERMINAL", message: NOT_CONFIGURED_MESSAGE };
    return { ok: true, config };
  }

  private async login(config: Required<FoodpandaClientConfig>): Promise<FoodpandaResult<string>> {
    try {
      const res = await this.fetchImpl(buildUrl(config, "/v2/login"), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: objectToFormUrlEncoded({
          username: config.username,
          password: config.password,
          grant_type: "client_credentials",
        }),
      });

      const body = await readResponseBody(res);
      if (!res.ok) {
        const kind: FoodpandaFailureKind = res.status >= 500 ? "RETRYABLE" : "TERMINAL";
        return {
          ok: false,
          kind,
          message: `Foodpanda login responded ${res.status}${body.text ? `: ${sanitizeMessage(body.text, [config.username, config.password])}` : ""}`,
        };
      }

      const token = loginTokenFrom(body.data);
      if (!token) {
        return { ok: false, kind: "TERMINAL", message: "Foodpanda login response did not include an access token." };
      }
      this.accessToken = token;
      return { ok: true, status: res.status, data: token };
    } catch (err) {
      return {
        ok: false,
        kind: "RETRYABLE",
        message: sanitizeMessage(err instanceof Error ? err.message : String(err), [config.username, config.password, this.accessToken]),
      };
    }
  }

  private async request(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<FoodpandaResult> {
    const configResult = this.configOrFailure();
    if (!configResult.ok) return configResult;
    const config = configResult.config;

    const firstToken = this.accessToken ? { ok: true as const, status: 0, data: this.accessToken } : await this.login(config);
    if (!firstToken.ok) return firstToken;

    const first = await this.fetchProtected(config, method, path, opts, firstToken.data);
    if ("networkError" in first) return first.networkError;
    if (first.res.status !== 401) return this.resultFromResponse(first.res, config);

    this.accessToken = null;
    const refreshedToken = await this.login(config);
    if (!refreshedToken.ok) return refreshedToken;

    const retry = await this.fetchProtected(config, method, path, opts, refreshedToken.data);
    if ("networkError" in retry) return retry.networkError;
    return this.resultFromResponse(retry.res, config);
  }

  private async fetchProtected(
    config: Required<FoodpandaClientConfig>,
    method: HttpMethod,
    path: string,
    opts: RequestOptions,
    token: string,
  ): Promise<{ res: Awaited<ReturnType<FoodpandaFetchLike>> } | { networkError: FoodpandaFailure }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;
    if (opts.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.jsonBody);
    } else if (opts.xmlBody !== undefined) {
      headers["Content-Type"] = "application/xml";
      body = opts.xmlBody;
    }

    try {
      const res = await this.fetchImpl(buildUrl(config, path, opts.query), { method, headers, ...(body !== undefined ? { body } : {}) });
      return { res };
    } catch (err) {
      return {
        networkError: {
          ok: false,
          kind: "RETRYABLE",
          message: sanitizeMessage(err instanceof Error ? err.message : String(err), [
            config.username,
            config.password,
            token,
            this.accessToken,
          ]),
        },
      };
    }
  }

  /** Same shape as request(), but for a full absolute URL (callback URLs) instead of a baseUrl-relative path. */
  private async requestAbsolute(method: HttpMethod, absoluteUrl: string, opts: RequestOptions = {}): Promise<FoodpandaResult> {
    const configResult = this.configOrFailure();
    if (!configResult.ok) return configResult;
    const config = configResult.config;

    const firstToken = this.accessToken ? { ok: true as const, status: 0, data: this.accessToken } : await this.login(config);
    if (!firstToken.ok) return firstToken;

    const first = await this.fetchProtectedAbsolute(config, method, absoluteUrl, opts, firstToken.data);
    if ("networkError" in first) return first.networkError;
    if (isRedirect(first.res.status)) return redirectRefused(first.res.status);
    if (first.res.status !== 401) return this.resultFromResponse(first.res, config);

    this.accessToken = null;
    const refreshedToken = await this.login(config);
    if (!refreshedToken.ok) return refreshedToken;

    const retry = await this.fetchProtectedAbsolute(config, method, absoluteUrl, opts, refreshedToken.data);
    if ("networkError" in retry) return retry.networkError;
    if (isRedirect(retry.res.status)) return redirectRefused(retry.res.status);
    return this.resultFromResponse(retry.res, config);
  }

  private async fetchProtectedAbsolute(
    config: Required<FoodpandaClientConfig>,
    method: HttpMethod,
    absoluteUrl: string,
    opts: RequestOptions,
    token: string,
  ): Promise<{ res: Awaited<ReturnType<FoodpandaFetchLike>> } | { networkError: FoodpandaFailure }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;
    if (opts.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.jsonBody);
    } else if (opts.xmlBody !== undefined) {
      headers["Content-Type"] = "application/xml";
      body = opts.xmlBody;
    }

    try {
      // `redirect: "manual"` matters for security, not ergonomics: isAllowedFoodpandaCallbackUrl
      // validates the URL we were handed, but a 3xx from an allowlisted host would otherwise let
      // the request hop to a host that was never checked. Manual mode surfaces the 3xx as a
      // response instead of following it; requestAbsolute() then rejects it. An injected test
      // double that ignores this option loses nothing, since the 3xx guard below is the backstop.
      const res = await this.fetchImpl(absoluteUrl, {
        method,
        headers,
        redirect: "manual",
        ...(body !== undefined ? { body } : {}),
      });
      return { res };
    } catch (err) {
      return {
        networkError: {
          ok: false,
          kind: "RETRYABLE",
          message: sanitizeMessage(err instanceof Error ? err.message : String(err), [
            config.username,
            config.password,
            token,
            this.accessToken,
          ]),
        },
      };
    }
  }

  private async resultFromResponse(res: Awaited<ReturnType<FoodpandaFetchLike>>, config: Required<FoodpandaClientConfig>): Promise<FoodpandaResult> {
    const body = await readResponseBody(res);
    if (res.ok) {
      const providerRef = providerRefFrom(body.data);
      return {
        ok: true,
        status: res.status,
        data: body.data,
        ...(providerRef !== undefined ? { providerRef } : {}),
      };
    }

    const kind: FoodpandaFailureKind = res.status >= 500 ? "RETRYABLE" : "TERMINAL";
    return {
      ok: false,
      kind,
      message: `Foodpanda responded ${res.status}${body.text ? `: ${sanitizeMessage(body.text, [
        config.username,
        config.password,
        this.accessToken,
      ])}` : ""}`,
    };
  }
}

function loginTokenFrom(data: unknown): string | null {
  if (!isJsonObject(data)) return null;
  for (const key of ["access_token", "accessToken", "token"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function unsupportedXmlBody(): FoodpandaFailure {
  return {
    ok: false,
    kind: "TERMINAL",
    message: "Legacy Foodpanda XML menu import requires an explicit XML string body; generated menu XML is unsupported.",
  };
}

function requireOrderToken(cmd: OutboundCommandRequest): FoodpandaResult<string> {
  if (!cmd.externalRef) return { ok: false, kind: "TERMINAL", message: `${cmd.commandType} requires order external_ref/orderToken.` };
  return { ok: true, status: 0, data: cmd.externalRef };
}

function requirePosVendorId(cmd: OutboundCommandRequest): FoodpandaResult<string> {
  if (!cmd.apiMerchantId) return { ok: false, kind: "TERMINAL", message: `${cmd.commandType} requires apiMerchantId/posVendorId.` };
  return { ok: true, status: 0, data: cmd.apiMerchantId };
}

function payloadObject(cmd: OutboundCommandRequest): FoodpandaResult<JsonObject> {
  const payload = cmd.payload ?? {};
  if (!isJsonObject(payload)) return { ok: false, kind: "TERMINAL", message: `${cmd.commandType} payload must be a non-array JSON object.` };
  return { ok: true, status: 0, data: payload };
}

function statusBody(status: "order_accepted" | "order_rejected", payload: JsonObject = {}): JsonObject {
  return { ...payload, status };
}

function readyTimeBody(payload: JsonObject): FoodpandaResult<JsonObject> {
  const expectedPickupAt = payload["expectedPickupAt"] ?? payload["ready_time"];
  if (typeof expectedPickupAt !== "string" || expectedPickupAt.length === 0) {
    return { ok: false, kind: "TERMINAL", message: "UPDATE_READY_TIME requires payload.ready_time or payload.expectedPickupAt." };
  }
  return { ok: true, status: 0, data: { ...payload, expectedPickupAt } };
}

function availabilityBody(isOpen: boolean, payload: JsonObject): JsonObject {
  if (isOpen) return { ...payload, availabilityState: "OPEN" };
  return {
    ...payload,
    availabilityState: payload["availabilityState"] ?? "CLOSED",
    closedReason: payload["closedReason"] ?? payload["reason"] ?? "TOO_BUSY_KITCHEN",
  };
}

function itemAvailabilityBody(payload: JsonObject): FoodpandaResult<JsonObject> {
  const itemsRaw = payload["items"];
  const itemId = payload["item_id"] ?? payload["itemId"];
  const items = Array.isArray(itemsRaw) ? itemsRaw : typeof itemId === "string" ? [itemId] : null;
  const isAvailable = typeof payload["isAvailable"] === "boolean" ? payload["isAvailable"] : payload["available"];
  const globalEntityId = payload["globalEntityId"] ?? payload["global_entity_id"];
  const type = payload["type"] ?? (payload["scope"] === "OPTION_GROUP" ? "TOPPING" : "ITEM");

  if (!Array.isArray(items) || items.length === 0 || !items.every((item) => typeof item === "string" && item.length > 0)) {
    return { ok: false, kind: "TERMINAL", message: "SET_ITEM_AVAILABILITY requires one or more item ids." };
  }
  if (typeof isAvailable !== "boolean") {
    return { ok: false, kind: "TERMINAL", message: "SET_ITEM_AVAILABILITY requires boolean available/isAvailable." };
  }
  if (typeof globalEntityId !== "string" || globalEntityId.length === 0) {
    return { ok: false, kind: "TERMINAL", message: "SET_ITEM_AVAILABILITY requires payload.globalEntityId." };
  }
  if (type !== "ITEM" && type !== "TOPPING") {
    return { ok: false, kind: "TERMINAL", message: `SET_ITEM_AVAILABILITY type must be "ITEM" or "TOPPING".` };
  }

  const body: JsonObject = { globalEntityId, items, type, isAvailable };
  const willBeAvailable = payload["willBeAvailable"];
  const unavailableUntil = payload["unavailable_until"] ?? payload["atTimeStamp"];
  if (!isAvailable && willBeAvailable !== undefined) body["willBeAvailable"] = willBeAvailable;
  if (!isAvailable && typeof unavailableUntil === "string") {
    body["willBeAvailable"] = "AT_TIMESTAMP";
    body["atTimeStamp"] = unavailableUntil;
  }
  return { ok: true, status: 0, data: body };
}

function toOutboundResult(result: FoodpandaResult): OutboundSendResult {
  if (result.ok) return { ok: true, ...(result.providerRef !== undefined ? { providerRef: result.providerRef } : {}) };
  return { ok: false, kind: result.kind, message: result.message };
}

export class FoodpandaOutboundAdapter implements AggregatorOutboundAdapter {
  readonly provider = "FOODPANDA";
  private readonly client: FoodpandaMiddlewareClient;
  private readonly explicitConfig?: FoodpandaClientConfig;

  constructor(fetchImpl: FoodpandaFetchLike = fetch as unknown as FoodpandaFetchLike, config?: FoodpandaClientConfig) {
    this.explicitConfig = config;
    this.client = new FoodpandaMiddlewareClient(fetchImpl, config);
  }

  async sendCommand(cmd: OutboundCommandRequest): Promise<OutboundSendResult> {
    if (!normalizeConfig(this.explicitConfig)) return { ok: false, kind: "TERMINAL", message: NOT_CONFIGURED_MESSAGE };

    switch (cmd.commandType) {
      case "ACCEPT_ORDER": {
        const token = requireOrderToken(cmd);
        if (!token.ok) return token;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        return toOutboundResult(await this.client.updateOrderStatus(token.data, statusBody("order_accepted", payload.data)));
      }
      case "REJECT_ORDER": {
        const token = requireOrderToken(cmd);
        if (!token.ok) return token;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        return toOutboundResult(await this.client.updateOrderStatus(token.data, statusBody("order_rejected", payload.data)));
      }
      case "MARK_READY": {
        const token = requireOrderToken(cmd);
        if (!token.ok) return token;
        return toOutboundResult(await this.client.markPreparationCompleted(token.data));
      }
      case "UPDATE_READY_TIME": {
        const token = requireOrderToken(cmd);
        if (!token.ok) return token;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        const body = readyTimeBody(payload.data);
        if (!body.ok) return body;
        return toOutboundResult(await this.client.adjustPreparationTime(token.data, body.data));
      }
      case "PAUSE_STORE": {
        const posVendorId = requirePosVendorId(cmd);
        if (!posVendorId.ok) return posVendorId;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        return toOutboundResult(await this.client.setVendorAvailability(posVendorId.data, availabilityBody(false, payload.data)));
      }
      case "RESUME_STORE": {
        const posVendorId = requirePosVendorId(cmd);
        if (!posVendorId.ok) return posVendorId;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        return toOutboundResult(await this.client.setVendorAvailability(posVendorId.data, availabilityBody(true, payload.data)));
      }
      case "SET_ITEM_AVAILABILITY": {
        const posVendorId = requirePosVendorId(cmd);
        if (!posVendorId.ok) return posVendorId;
        const payload = payloadObject(cmd);
        if (!payload.ok) return payload;
        const body = itemAvailabilityBody(payload.data);
        if (!body.ok) return body;
        return toOutboundResult(await this.client.updateCatalogItemsAvailability(posVendorId.data, body.data));
      }
      case "NOTIFY_MENU_UPDATED":
        return { ok: false, kind: "TERMINAL", message: "Foodpanda NOTIFY_MENU_UPDATED is unsupported in Phase 1; catalog bodies must be explicit." };
      default:
        return { ok: false, kind: "TERMINAL", message: `Foodpanda unsupported command_type "${String(cmd.commandType)}".` };
    }
  }
}
