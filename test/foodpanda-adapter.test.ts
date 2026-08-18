import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getOutboundAdapter } from "../src/modules/outbound/adapter.js";
import {
  FoodpandaMiddlewareClient,
  FoodpandaOutboundAdapter,
  isAllowedFoodpandaCallbackUrl,
  type FoodpandaFetchLike,
} from "../src/modules/outbound/foodpanda-adapter.js";
import type { OutboundCommandRequest } from "../src/modules/outbound/types.js";

const ENV_KEYS = [
  "FOODPANDA_MIDDLEWARE_BASE_URL",
  "FOODPANDA_MIDDLEWARE_USERNAME",
  "FOODPANDA_MIDDLEWARE_PASSWORD",
  "FOODPANDA_CHAIN_CODE",
] as const;

const ORIGINAL_ENV: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

for (const key of ENV_KEYS) {
  ORIGINAL_ENV[key] = process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  process.env.FOODPANDA_MIDDLEWARE_BASE_URL = overrides.FOODPANDA_MIDDLEWARE_BASE_URL ?? "https://foodpanda.example.test/";
  process.env.FOODPANDA_MIDDLEWARE_USERNAME = overrides.FOODPANDA_MIDDLEWARE_USERNAME ?? "test-user";
  process.env.FOODPANDA_MIDDLEWARE_PASSWORD = overrides.FOODPANDA_MIDDLEWARE_PASSWORD ?? "test-password";
  process.env.FOODPANDA_CHAIN_CODE = overrides.FOODPANDA_CHAIN_CODE ?? "chain-1";
}

function clearConfig(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function response(status: number, body?: unknown) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (text ? JSON.parse(text) : undefined),
    text: async () => text,
  };
}

interface SeenCall {
  url: string;
  init: RequestInit | undefined;
}

function baseCommand(overrides: Partial<OutboundCommandRequest> = {}): OutboundCommandRequest {
  return {
    commandId: randomUUID(),
    commandType: "ACCEPT_ORDER",
    apiMerchantId: "vendor-1",
    externalRef: "order-1",
    payload: {},
    attempt: 1,
    ...overrides,
  };
}

function jsonBody(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body ?? "{}"));
}

function headers(init: RequestInit | undefined): Record<string, string> {
  return init?.headers as Record<string, string>;
}

describe("Foodpanda outbound adapter configuration and auth", () => {
  it("returns TERMINAL not configured and performs zero fetches when any required env var is missing", async () => {
    clearConfig();
    process.env.FOODPANDA_MIDDLEWARE_BASE_URL = "https://foodpanda.example.test";
    process.env.FOODPANDA_MIDDLEWARE_USERNAME = "test-user";
    process.env.FOODPANDA_MIDDLEWARE_PASSWORD = "test-password";
    delete process.env.FOODPANDA_CHAIN_CODE;

    let fetches = 0;
    const neverCalled: FoodpandaFetchLike = async () => {
      fetches += 1;
      throw new Error("fetch must not be called when Foodpanda is unconfigured");
    };

    const adapter = new FoodpandaOutboundAdapter(neverCalled);
    const result = await adapter.sendCommand(baseCommand());

    expect(fetches).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("not configured");
      expect(result.message).not.toContain("test-password");
    }
  });

  it("logs in once, caches the access token, and uses Bearer auth on protected calls", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: FoodpandaFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/v2/login")) return response(200, { access_token: "cached-token" });
      return response(200, { id: "provider-ref" });
    };

    const adapter = new FoodpandaOutboundAdapter(fetchImpl);
    expect(await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "ORDER-1" }))).toEqual({
      ok: true,
      providerRef: "provider-ref",
    });
    expect((await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "ORDER-2" }))).ok).toBe(true);

    expect(seen.filter((call) => call.url.endsWith("/v2/login")).length).toBe(1);
    const protectedCalls = seen.filter((call) => !call.url.endsWith("/v2/login"));
    expect(protectedCalls).toHaveLength(2);
    expect(headers(protectedCalls[0]!.init)["Authorization"]).toBe("Bearer cached-token");
    expect(headers(protectedCalls[1]!.init)["Authorization"]).toBe("Bearer cached-token");
  });

  it("refreshes the access token once and retries a protected request once after 401", async () => {
    configure();
    const seen: SeenCall[] = [];
    const tokens = ["old-token", "new-token"];
    let protectedAttempt = 0;
    const fetchImpl: FoodpandaFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/v2/login")) return response(200, { access_token: tokens.shift() });
      protectedAttempt += 1;
      return protectedAttempt === 1 ? response(401, { code: "UNAUTHORIZED" }) : response(200, { id: "after-refresh" });
    };

    const adapter = new FoodpandaOutboundAdapter(fetchImpl);
    const result = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "ORDER-401" }));

    expect(result).toEqual({ ok: true, providerRef: "after-refresh" });
    expect(seen.map((call) => call.url.endsWith("/v2/login") ? "login" : headers(call.init)["Authorization"])).toEqual([
      "login",
      "Bearer old-token",
      "login",
      "Bearer new-token",
    ]);
  });
});

describe("Foodpanda Middleware API v2 direct client routes", () => {
  it("uses the exact Phase 1 route groups with encoded path segments", async () => {
    configure({ FOODPANDA_CHAIN_CODE: "chain/PH + NCR" });
    const seen: SeenCall[] = [];
    const fetchImpl: FoodpandaFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/v2/login")) return response(200, { access_token: "route-token" });
      return response(init?.method === "POST" ? 202 : 200, { id: "ok" });
    };
    const client = new FoodpandaMiddlewareClient(fetchImpl);

    await client.updateOrderStatus("order/tok +?", { status: "order_accepted" });
    await client.markPreparationCompleted("order/tok +?");
    await client.adjustPreparationTime("order/tok +?", { expectedPickupAt: "2026-08-18T12:00:00.000Z" });
    await client.getVendorAvailability("vendor/one +?");
    await client.setVendorAvailability("vendor/one +?", { availabilityState: "OPEN" });
    await client.submitCatalog({ vendors: ["vendor/one +?"], catalog: {} });
    await client.getPlatformVendors("vendor/one +?");
    await client.submitGlobalEntityCatalog("FP/PH +?", { platformVendors: ["pv"], catalog: {} });
    await client.getMenuImportLogs("vendor/one +?", { from: "2026-08-18T00:00:00Z", to: "2026-08-18T01:00:00Z", limit: 5, sort: "asc" });
    await client.submitLegacyMenuImport("vendor/one +?", "<VendorMenu />");
    await client.submitTriggeredLegacyMenu("vendor/code +?", "menu/id +?", "<VendorMenu />");
    await client.updatePosReachabilityStatus("vendor/one +?", { reachable: true });
    await client.getOrderIds({ status: "accepted", pastNumberOfHours: 2, vendorId: "vendor/one +?" });
    await client.getOrderDetails("order/id +?");
    await client.updateCatalogItemsAvailability("vendor/one +?", {
      globalEntityId: "FP_PH",
      items: ["SKU/one"],
      type: "ITEM",
      isAvailable: true,
    });
    await client.getUnavailableCatalogItems("vendor/one +?");
    await client.modifyOrderProducts("order/tok +?", { products: [] });

    const protectedCalls = seen.filter((call) => !call.url.endsWith("/v2/login"));
    expect(protectedCalls.map((call) => `${call.init?.method} ${call.url.split("?")[0]}`)).toEqual([
      "PUT https://foodpanda.example.test/v2/order/status/order%2Ftok%20%2B%3F",
      "POST https://foodpanda.example.test/v2/orders/order%2Ftok%20%2B%3F/preparation-completed",
      "PUT https://foodpanda.example.test/v2/orders/order%2Ftok%20%2B%3F/adjust-preparation-time",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/remoteVendors/vendor%2Fone%20%2B%3F/availability",
      "PUT https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/remoteVendors/vendor%2Fone%20%2B%3F/availability",
      "PUT https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/catalog",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/vendors/vendor%2Fone%20%2B%3F/platform-vendors",
      "PUT https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/global-entity/FP%2FPH%20%2B%3F/catalog",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/vendors/vendor%2Fone%20%2B%3F/menu-import-logs",
      "POST https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/remoteVendors/vendor%2Fone%20%2B%3F/menuImport",
      "POST https://foodpanda.example.test/v2/menu/vendor%2Fcode%20%2B%3F/menu%2Fid%20%2B%3F",
      "PUT https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/remoteVendors/vendor%2Fone%20%2B%3F/posReachabilityStatus",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/orders/ids",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/orders/order%2Fid%20%2B%3F",
      "POST https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/vendors/vendor%2Fone%20%2B%3F/catalog/items/availability",
      "GET https://foodpanda.example.test/v2/chains/chain%2FPH%20%2B%20NCR/vendors/vendor%2Fone%20%2B%3F/catalog/items/unavailable",
      "POST https://foodpanda.example.test/v2/order/order%2Ftok%20%2B%3F/modifications/product",
    ]);
    expect(protectedCalls[8]!.url).toContain("from=2026-08-18T00%3A00%3A00Z");
    expect(protectedCalls[8]!.url).toContain("sort=asc");
    expect(headers(protectedCalls[9]!.init)["Content-Type"]).toBe("application/xml");
  });

  it("rejects non-object JSON bodies and non-string legacy XML bodies before fetching", async () => {
    configure();
    let fetches = 0;
    const fetchImpl: FoodpandaFetchLike = async () => {
      fetches += 1;
      return response(200, { access_token: "unused" });
    };
    const client = new FoodpandaMiddlewareClient(fetchImpl);

    const badJson = await client.submitCatalog([]);
    const badXml = await client.submitLegacyMenuImport("vendor-1", { xml: "<VendorMenu />" });

    expect(fetches).toBe(0);
    expect(badJson.ok).toBe(false);
    expect(badXml.ok).toBe(false);
    if (!badJson.ok) expect(badJson.kind).toBe("TERMINAL");
    if (!badXml.ok) expect(badXml.message).toContain("explicit XML string");
  });
});

describe("Foodpanda error classification", () => {
  it("classifies protected 4xx as TERMINAL, 5xx as RETRYABLE, and network failures as RETRYABLE without leaking secrets", async () => {
    configure();

    const terminalClient = new FoodpandaMiddlewareClient(async (url) => {
      if (url.endsWith("/v2/login")) return response(200, { access_token: "secret-token" });
      return response(400, "bad request with test-password and secret-token");
    });
    const terminal = await terminalClient.getOrderDetails("order-400");
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) {
      expect(terminal.kind).toBe("TERMINAL");
      expect(terminal.message).not.toContain("test-password");
      expect(terminal.message).not.toContain("secret-token");
    }

    const retryableClient = new FoodpandaMiddlewareClient(async (url) => {
      if (url.endsWith("/v2/login")) return response(200, { access_token: "token-5xx" });
      return response(503, "temporarily unavailable");
    });
    const retryable = await retryableClient.getOrderDetails("order-503");
    expect(retryable.ok).toBe(false);
    if (!retryable.ok) expect(retryable.kind).toBe("RETRYABLE");

    const networkClient = new FoodpandaMiddlewareClient(async (url) => {
      if (url.endsWith("/v2/login")) return response(200, { access_token: "network-token" });
      throw new Error("ECONNRESET network-token");
    });
    const network = await networkClient.getOrderDetails("order-network");
    expect(network.ok).toBe(false);
    if (!network.ok) {
      expect(network.kind).toBe("RETRYABLE");
      expect(network.message).not.toContain("network-token");
    }
  });
});

describe("Foodpanda generic command mappings", () => {
  it("registers FOODPANDA without changing existing providers", () => {
    expect(getOutboundAdapter("DUMMY")?.provider).toBe("DUMMY");
    expect(getOutboundAdapter("DELIVERECT")?.provider).toBe("DELIVERECT");
    expect(getOutboundAdapter("FOODPANDA")?.provider).toBe("FOODPANDA");
  });

  it("maps supported command types to Foodpanda endpoints and fails closed on menu/unknown commands", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: FoodpandaFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/v2/login")) return response(200, { access_token: "map-token" });
      return response(200, { id: `ref-${seen.length}` });
    };
    const adapter = new FoodpandaOutboundAdapter(fetchImpl);

    await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "accept/order" }));
    await adapter.sendCommand(
      baseCommand({ commandType: "REJECT_ORDER", externalRef: "reject/order", payload: { reason_code: "OUT_OF_STOCK", note: "sold out" } }),
    );
    await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "ready/order" }));
    await adapter.sendCommand(baseCommand({ commandType: "UPDATE_READY_TIME", externalRef: "time/order", payload: { ready_time: "2026-08-18T12:00:00.000Z" } }));
    await adapter.sendCommand(baseCommand({ commandType: "PAUSE_STORE", apiMerchantId: "vendor/map", externalRef: null, payload: { closingMinutes: 30 } }));
    await adapter.sendCommand(baseCommand({ commandType: "RESUME_STORE", apiMerchantId: "vendor/map", externalRef: null, payload: {} }));
    await adapter.sendCommand(
      baseCommand({
        commandType: "SET_ITEM_AVAILABILITY",
        apiMerchantId: "vendor/map",
        externalRef: null,
        payload: {
          globalEntityId: "FP_PH",
          item_id: "SKU/1",
          available: false,
          unavailable_until: "2026-08-18T12:30:00.000Z",
        },
      }),
    );

    const protectedCalls = seen.filter((call) => !call.url.endsWith("/v2/login"));
    expect(protectedCalls.map((call) => `${call.init?.method} ${call.url.split("?")[0]}`)).toEqual([
      "PUT https://foodpanda.example.test/v2/order/status/accept%2Forder",
      "PUT https://foodpanda.example.test/v2/order/status/reject%2Forder",
      "POST https://foodpanda.example.test/v2/orders/ready%2Forder/preparation-completed",
      "PUT https://foodpanda.example.test/v2/orders/time%2Forder/adjust-preparation-time",
      "PUT https://foodpanda.example.test/v2/chains/chain-1/remoteVendors/vendor%2Fmap/availability",
      "PUT https://foodpanda.example.test/v2/chains/chain-1/remoteVendors/vendor%2Fmap/availability",
      "POST https://foodpanda.example.test/v2/chains/chain-1/vendors/vendor%2Fmap/catalog/items/availability",
    ]);
    expect(jsonBody(protectedCalls[0]!.init)).toEqual({ status: "order_accepted" });
    expect(jsonBody(protectedCalls[1]!.init)).toEqual({ status: "order_rejected", reason_code: "OUT_OF_STOCK", note: "sold out" });
    expect(jsonBody(protectedCalls[3]!.init)).toEqual({ ready_time: "2026-08-18T12:00:00.000Z", expectedPickupAt: "2026-08-18T12:00:00.000Z" });
    expect(jsonBody(protectedCalls[4]!.init)).toEqual({ closingMinutes: 30, availabilityState: "CLOSED", closedReason: "TOO_BUSY_KITCHEN" });
    expect(jsonBody(protectedCalls[5]!.init)).toEqual({ availabilityState: "OPEN" });
    expect(jsonBody(protectedCalls[6]!.init)).toEqual({
      globalEntityId: "FP_PH",
      items: ["SKU/1"],
      type: "ITEM",
      isAvailable: false,
      willBeAvailable: "AT_TIMESTAMP",
      atTimeStamp: "2026-08-18T12:30:00.000Z",
    });

    const fetchesBeforeUnsupported = seen.length;
    const menu = await adapter.sendCommand(baseCommand({ commandType: "NOTIFY_MENU_UPDATED", externalRef: null }));
    const unknown = await adapter.sendCommand(baseCommand({ commandType: "BOGUS" as OutboundCommandRequest["commandType"], externalRef: null }));

    expect(seen.length).toBe(fetchesBeforeUnsupported);
    expect(menu.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!menu.ok) expect(menu.kind).toBe("TERMINAL");
    if (!unknown.ok) expect(unknown.message).toContain("unsupported command_type");
  });
});

describe("isAllowedFoodpandaCallbackUrl — SSRF allowlist for inbound callbackUrls.*", () => {
  it("accepts a legitimate https Delivery Hero host under the allowlisted suffix (bare + subdomain)", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://restaurant-partners.com/callback")).toBe(true);
    expect(isAllowedFoodpandaCallbackUrl("https://integration-middleware.eu.restaurant-partners.com/orders/callback?token=abc123")).toBe(true);
  });

  it("rejects plain http (not https)", () => {
    expect(isAllowedFoodpandaCallbackUrl("http://integration-middleware.eu.restaurant-partners.com/callback")).toBe(false);
  });

  it("rejects a URL with embedded credentials", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://user:pass@integration-middleware.eu.restaurant-partners.com/callback")).toBe(false);
  });

  it("rejects an explicit non-443 port", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://integration-middleware.eu.restaurant-partners.com:8443/callback")).toBe(false);
  });

  it("rejects an IPv4 literal host", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://203.0.113.10/callback")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://localhost/callback")).toBe(false);
  });

  it("rejects a .internal host", () => {
    expect(isAllowedFoodpandaCallbackUrl("https://vendor-api.internal/callback")).toBe(false);
  });

  it("rejects an anchored-suffix bypass attempt (attacker host merely CONTAINING the allowlisted suffix as a prefix)", () => {
    // hostname.endsWith(".restaurant-partners.com") must be false here — the attacker owns
    // "attacker.net" and only prefixed it with a lookalike label; a naive `.includes()` check
    // would wrongly allow this.
    expect(isAllowedFoodpandaCallbackUrl("https://evil-restaurant-partners.com.attacker.net/")).toBe(false);
  });
});

describe("postFoodpandaCallback — SSRF-guarded outbound POST to inbound-supplied callback URLs", () => {
  it("returns a TERMINAL failure for a disallowed URL, performs zero fetches, and never leaks the full URL", async () => {
    configure();
    let fetches = 0;
    const fetchImpl: FoodpandaFetchLike = async () => {
      fetches += 1;
      return response(200, { access_token: "unused-token" });
    };
    const client = new FoodpandaMiddlewareClient(fetchImpl);

    const disallowed = "https://evil-restaurant-partners.com.attacker.net/callback?token=super-secret-order-token";
    const result = await client.postFoodpandaCallback(disallowed, { status: "order_accepted" });

    expect(fetches).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).not.toContain(disallowed);
      expect(result.message).not.toContain("super-secret-order-token");
      expect(result.message).toContain("attacker.net");
    }
  });

  it("refuses a 3xx redirect response from an ALLOWLISTED host instead of following it", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: FoodpandaFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/v2/login")) return response(200, { access_token: "cb-token" });
      return response(302);
    };
    const client = new FoodpandaMiddlewareClient(fetchImpl);

    const result = await client.postFoodpandaCallback("https://integration-middleware.eu.restaurant-partners.com/callback", {
      status: "order_accepted",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("redirect");
    }

    const callbackCall = seen.find((call) => !call.url.endsWith("/v2/login"));
    expect(callbackCall).toBeDefined();
    // The client must request with redirect: "manual" so a 3xx surfaces as a response to reject,
    // rather than the fetch implementation silently hopping to an unvetted host.
    expect(callbackCall!.init?.redirect).toBe("manual");
  });
});
