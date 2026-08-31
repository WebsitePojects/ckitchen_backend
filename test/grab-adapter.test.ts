import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getOutboundAdapter } from "../src/modules/outbound/adapter.js";
import { GrabOutboundAdapter, GrabPartnerApiClient, isAllowedGrabUrl, type GrabFetchLike } from "../src/modules/outbound/grab-adapter.js";
import type { OutboundCommandRequest } from "../src/modules/outbound/types.js";

const ENV_KEYS = ["GRAB_API_CLIENT_ID", "GRAB_API_CLIENT_SECRET", "GRAB_API_ENV", "GRAB_API_BASE_URL", "GRAB_API_TOKEN_URL"] as const;

const ORIGINAL_ENV: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  process.env.GRAB_API_CLIENT_ID = overrides.GRAB_API_CLIENT_ID ?? "test-client-id";
  process.env.GRAB_API_CLIENT_SECRET = overrides.GRAB_API_CLIENT_SECRET ?? "test-client-secret";
  process.env.GRAB_API_ENV = overrides.GRAB_API_ENV ?? "staging";
  process.env.GRAB_API_BASE_URL = overrides.GRAB_API_BASE_URL ?? "https://partner-api.grab.com";
  process.env.GRAB_API_TOKEN_URL = overrides.GRAB_API_TOKEN_URL ?? "https://api.grab.com/grabid/v1/oauth2/token";
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
    apiMerchantId: "1-CYNGRUNGSBCCC",
    externalRef: "123-CYNKLPCVRN5",
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

const TOKEN_URL = "https://api.grab.com/grabid/v1/oauth2/token";

describe("Grab outbound adapter configuration", () => {
  it("returns TERMINAL not configured and performs zero fetches when any required env var is missing", async () => {
    clearConfig();
    process.env.GRAB_API_CLIENT_ID = "id-only";
    process.env.GRAB_API_CLIENT_SECRET = "secret-only";
    // GRAB_API_ENV intentionally left unset.

    let fetches = 0;
    const neverCalled: GrabFetchLike = async () => {
      fetches += 1;
      throw new Error("fetch must not be called when Grab is unconfigured");
    };

    const adapter = new GrabOutboundAdapter(neverCalled);
    const result = await adapter.sendCommand(baseCommand());

    expect(fetches).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("not configured");
      expect(result.message).not.toContain("secret-only");
    }
  });

  it("registers GRABFOOD without changing existing providers", () => {
    expect(getOutboundAdapter("DUMMY")?.provider).toBe("DUMMY");
    expect(getOutboundAdapter("DELIVERECT")?.provider).toBe("DELIVERECT");
    expect(getOutboundAdapter("FOODPANDA")?.provider).toBe("FOODPANDA");
    expect(getOutboundAdapter("GRABFOOD")?.provider).toBe("GRABFOOD");
  });
});

describe("isAllowedGrabUrl — SSRF allowlist", () => {
  it("accepts legitimate https grab.com hosts (bare + subdomain)", () => {
    expect(isAllowedGrabUrl("https://grab.com/callback")).toBe(true);
    expect(isAllowedGrabUrl("https://partner-api.grab.com/grabfood/partner/v1/order/prepare")).toBe(true);
    expect(isAllowedGrabUrl("https://api.grab.com/grabid/v1/oauth2/token")).toBe(true);
  });

  it("rejects a lookalike host that merely contains grab.com as a substring", () => {
    expect(isAllowedGrabUrl("https://notgrab.com/partner/v1/order/prepare")).toBe(false);
  });

  it("rejects an anchored-suffix bypass attempt (attacker host suffixed onto a grab.com-looking label)", () => {
    expect(isAllowedGrabUrl("https://grab.com.evil.tld/partner/v1/order/prepare")).toBe(false);
  });

  it("rejects plain http", () => {
    expect(isAllowedGrabUrl("http://partner-api.grab.com/grabfood/partner/v1/order/prepare")).toBe(false);
  });

  it("rejects an IPv4 literal host", () => {
    expect(isAllowedGrabUrl("https://203.0.113.10/order/prepare")).toBe(false);
  });

  it("rejects a URL with embedded credentials", () => {
    expect(isAllowedGrabUrl("https://user:pass@partner-api.grab.com/order/prepare")).toBe(false);
  });

  it("rejects an explicit non-default port", () => {
    expect(isAllowedGrabUrl("https://partner-api.grab.com:8443/order/prepare")).toBe(false);
  });
});

describe("Grab outbound adapter — redirect refusal", () => {
  it("refuses a 3xx response instead of following it, and calls fetch with redirect: manual", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: GrabFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url === TOKEN_URL) return response(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 });
      return response(302);
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const result = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "order-redirect" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("redirect");
    }
    const protectedCall = seen.find((call) => call.url !== TOKEN_URL);
    expect(protectedCall).toBeDefined();
    expect(protectedCall!.init?.redirect).toBe("manual");
  });
});

describe("Grab outbound adapter — error classification", () => {
  it("classifies 429 and 5xx as RETRYABLE, and 400/403 as TERMINAL", async () => {
    async function runWithStatus(status: number) {
      configure();
      const fetchImpl: GrabFetchLike = async (url) => {
        if (url === TOKEN_URL) return response(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 });
        return response(status, { reason: "some_reason", message: "some message" });
      };
      const adapter = new GrabOutboundAdapter(fetchImpl);
      return adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: `order-${status}` }));
    }

    const r429 = await runWithStatus(429);
    expect(r429.ok).toBe(false);
    if (!r429.ok) expect(r429.kind).toBe("RETRYABLE");

    const r500 = await runWithStatus(500);
    expect(r500.ok).toBe(false);
    if (!r500.ok) expect(r500.kind).toBe("RETRYABLE");

    const r400 = await runWithStatus(400);
    expect(r400.ok).toBe(false);
    if (!r400.ok) expect(r400.kind).toBe("TERMINAL");

    const r403 = await runWithStatus(403);
    expect(r403.ok).toBe(false);
    if (!r403.ok) expect(r403.kind).toBe("TERMINAL");
  });

  it("treats the menu-notification 409 throttle as RETRYABLE, and a different 409 as TERMINAL", async () => {
    configure();

    const throttleFetch: GrabFetchLike = async (url) => {
      if (url === TOKEN_URL) return response(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 });
      return response(409, { code: 409, reason: "invalid_argument", message: "sync menu too frequently, retry after 120 seconds" });
    };
    const throttleAdapter = new GrabOutboundAdapter(throttleFetch);
    const throttleResult = await throttleAdapter.sendCommand(
      baseCommand({ commandType: "NOTIFY_MENU_UPDATED", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC" }),
    );
    expect(throttleResult.ok).toBe(false);
    if (!throttleResult.ok) expect(throttleResult.kind).toBe("RETRYABLE");

    const otherConflictFetch: GrabFetchLike = async (url) => {
      if (url === TOKEN_URL) return response(200, { access_token: "tok2", token_type: "Bearer", expires_in: 3600 });
      return response(409, { code: 409, reason: "conflict", message: "some unrelated conflict" });
    };
    const otherAdapter = new GrabOutboundAdapter(otherConflictFetch);
    const otherResult = await otherAdapter.sendCommand(
      baseCommand({ commandType: "NOTIFY_MENU_UPDATED", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC" }),
    );
    expect(otherResult.ok).toBe(false);
    if (!otherResult.ok) expect(otherResult.kind).toBe("TERMINAL");
  });

  it("classifies a network failure as RETRYABLE without leaking the client secret or access token", async () => {
    configure({ GRAB_API_CLIENT_SECRET: "super-secret-value" });
    const fetchImpl: GrabFetchLike = async (url) => {
      if (url === TOKEN_URL) return response(200, { access_token: "leaky-token-value", token_type: "Bearer", expires_in: 3600 });
      throw new Error("ECONNRESET leaky-token-value super-secret-value");
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);
    const result = await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "order-network" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("RETRYABLE");
      expect(result.message).not.toContain("leaky-token-value");
      expect(result.message).not.toContain("super-secret-value");
    }
  });
});

describe("Grab outbound adapter — OAuth token caching and 401 handling", () => {
  it("logs in once, caches the access token, and reuses it across calls", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: GrabFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url === TOKEN_URL) return response(200, { access_token: "cached-token", token_type: "Bearer", expires_in: 3600 });
      return response(204);
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    expect((await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "order-1" }))).ok).toBe(true);
    expect((await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "order-2" }))).ok).toBe(true);

    const loginCalls = seen.filter((call) => call.url === TOKEN_URL);
    expect(loginCalls).toHaveLength(1);
    const protectedCalls = seen.filter((call) => call.url !== TOKEN_URL);
    expect(protectedCalls).toHaveLength(2);
    expect(headers(protectedCalls[0]!.init)["Authorization"]).toBe("Bearer cached-token");
    expect(headers(protectedCalls[1]!.init)["Authorization"]).toBe("Bearer cached-token");
  });

  it("refreshes the token exactly once and retries once after a 401 — never loops", async () => {
    configure();
    const seen: SeenCall[] = [];
    const tokens = ["old-token", "new-token"];
    let protectedAttempts = 0;
    const fetchImpl: GrabFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url === TOKEN_URL) return response(200, { access_token: tokens.shift(), token_type: "Bearer", expires_in: 3600 });
      protectedAttempts += 1;
      return protectedAttempts === 1 ? response(401, { message: "unauthorized" }) : response(204);
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const result = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "order-401" }));

    expect(result.ok).toBe(true);
    expect(seen.map((call) => (call.url === TOKEN_URL ? "login" : headers(call.init)["Authorization"]))).toEqual([
      "login",
      "Bearer old-token",
      "login",
      "Bearer new-token",
    ]);
    expect(protectedAttempts).toBe(2);
  });

  it("does not loop when the retried request also 401s — returns a single TERMINAL failure", async () => {
    configure();
    let loginCalls = 0;
    let protectedCalls = 0;
    const fetchImpl: GrabFetchLike = async (url) => {
      if (url === TOKEN_URL) {
        loginCalls += 1;
        return response(200, { access_token: `token-${loginCalls}`, token_type: "Bearer", expires_in: 3600 });
      }
      protectedCalls += 1;
      return response(401, { message: "still unauthorized" });
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const result = await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "order-401-loop" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("TERMINAL");
    expect(loginCalls).toBe(2);
    expect(protectedCalls).toBe(2);
  });
});

describe("Grab outbound adapter — verified command mappings", () => {
  it("maps ACCEPT_ORDER/REJECT_ORDER to POST /order/prepare with the correct toState", async () => {
    configure();
    const seen: SeenCall[] = [];
    const fetchImpl: GrabFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url === TOKEN_URL) return response(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 });
      return response(204);
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    await adapter.sendCommand(baseCommand({ commandType: "ACCEPT_ORDER", externalRef: "123-CYNKLPCVRN5" }));
    await adapter.sendCommand(baseCommand({ commandType: "REJECT_ORDER", externalRef: "123-CYNKLPCVRN5" }));

    const protectedCalls = seen.filter((call) => call.url !== TOKEN_URL);
    expect(protectedCalls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      "POST https://partner-api.grab.com/grabfood-sandbox/partner/v1/order/prepare",
      "POST https://partner-api.grab.com/grabfood-sandbox/partner/v1/order/prepare",
    ]);
    expect(jsonBody(protectedCalls[0]!.init)).toEqual({ orderID: "123-CYNKLPCVRN5", toState: "Accepted" });
    expect(jsonBody(protectedCalls[1]!.init)).toEqual({ orderID: "123-CYNKLPCVRN5", toState: "Rejected" });
  });

  it("maps MARK_READY, UPDATE_READY_TIME, PAUSE_STORE, RESUME_STORE, NOTIFY_MENU_UPDATED, and SET_ITEM_AVAILABILITY", async () => {
    configure({ GRAB_API_ENV: "production" });
    const seen: SeenCall[] = [];
    const fetchImpl: GrabFetchLike = async (url, init) => {
      seen.push({ url, init });
      if (url === TOKEN_URL) return response(200, { access_token: "tok", token_type: "Bearer", expires_in: 3600 });
      return response(204);
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    await adapter.sendCommand(baseCommand({ commandType: "MARK_READY", externalRef: "123-CYNKLPCVRN5" }));
    await adapter.sendCommand(
      baseCommand({ commandType: "UPDATE_READY_TIME", externalRef: "123-CYNKLPCVRN5", payload: { ready_time: "2019-05-24T05:16:00Z" } }),
    );
    await adapter.sendCommand(
      baseCommand({ commandType: "PAUSE_STORE", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC", payload: { duration: "30m" } }),
    );
    await adapter.sendCommand(baseCommand({ commandType: "RESUME_STORE", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC", payload: {} }));
    await adapter.sendCommand(baseCommand({ commandType: "NOTIFY_MENU_UPDATED", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC" }));
    await adapter.sendCommand(
      baseCommand({
        commandType: "SET_ITEM_AVAILABILITY",
        externalRef: null,
        apiMerchantId: "1-CYNGRUNGSBCCC",
        payload: { item_id: "ITEM-1", available: false },
      }),
    );
    await adapter.sendCommand(
      baseCommand({
        commandType: "SET_ITEM_AVAILABILITY",
        externalRef: null,
        apiMerchantId: "1-CYNGRUNGSBCCC",
        payload: { items: ["ITEM-1", "ITEM-2"], available: true },
      }),
    );

    const protectedCalls = seen.filter((call) => call.url !== TOKEN_URL);
    expect(protectedCalls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      "POST https://partner-api.grab.com/grabfood/partner/v1/orders/mark",
      "PUT https://partner-api.grab.com/grabfood/partner/v1/order/readytime",
      "PUT https://partner-api.grab.com/grabfood/partner/v1/merchant/pause",
      "PUT https://partner-api.grab.com/grabfood/partner/v1/merchant/pause",
      "POST https://partner-api.grab.com/grabfood/partner/v1/merchant/menu/notification",
      "PUT https://partner-api.grab.com/grabfood/partner/v1/menu",
      "PUT https://partner-api.grab.com/grabfood/partner/v1/batch/menu",
    ]);
    expect(jsonBody(protectedCalls[0]!.init)).toEqual({ orderID: "123-CYNKLPCVRN5", markStatus: 1 });
    expect(jsonBody(protectedCalls[1]!.init)).toEqual({ orderID: "123-CYNKLPCVRN5", newOrderReadyTime: "2019-05-24T05:16:00Z" });
    expect(jsonBody(protectedCalls[2]!.init)).toEqual({ merchantID: "1-CYNGRUNGSBCCC", isPause: true, duration: "30m" });
    expect(jsonBody(protectedCalls[3]!.init)).toEqual({ merchantID: "1-CYNGRUNGSBCCC", isPause: false });
    expect(jsonBody(protectedCalls[4]!.init)).toEqual({ merchantID: "1-CYNGRUNGSBCCC" });
    expect(jsonBody(protectedCalls[5]!.init)).toEqual({
      merchantID: "1-CYNGRUNGSBCCC",
      field: "ITEM",
      id: "ITEM-1",
      availableStatus: "UNAVAILABLE",
      maxStock: 0,
    });
    expect(jsonBody(protectedCalls[6]!.init)).toEqual({
      merchantID: "1-CYNGRUNGSBCCC",
      field: "ITEM",
      menuEntities: [
        { id: "ITEM-1", availableStatus: "AVAILABLE" },
        { id: "ITEM-2", availableStatus: "AVAILABLE" },
      ],
    });
  });

  it("fails closed on PAUSE_STORE with a missing/invalid duration, performing zero fetches", async () => {
    configure();
    let fetches = 0;
    const fetchImpl: GrabFetchLike = async () => {
      fetches += 1;
      return response(200, { access_token: "unused" });
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const missing = await adapter.sendCommand(
      baseCommand({ commandType: "PAUSE_STORE", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC", payload: {} }),
    );
    const invalid = await adapter.sendCommand(
      baseCommand({ commandType: "PAUSE_STORE", externalRef: null, apiMerchantId: "1-CYNGRUNGSBCCC", payload: { duration: "2h" } }),
    );

    expect(fetches).toBe(0);
    expect(missing.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe("TERMINAL");
    if (!invalid.ok) expect(invalid.kind).toBe("TERMINAL");
  });
});

describe("Grab outbound adapter — unmapped and unknown command types fail closed", () => {
  it("returns TERMINAL for CONTEST_CANCELLATION (no verified Grab endpoint) without issuing any fetch", async () => {
    configure();
    let fetches = 0;
    const fetchImpl: GrabFetchLike = async () => {
      fetches += 1;
      return response(200, { access_token: "unused" });
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const result = await adapter.sendCommand(baseCommand({ commandType: "CONTEST_CANCELLATION", externalRef: "order-1" }));

    expect(fetches).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("no verified Grab Partner API endpoint");
    }
  });

  it("returns TERMINAL for a wholly unknown command type without issuing any fetch", async () => {
    configure();
    let fetches = 0;
    const fetchImpl: GrabFetchLike = async () => {
      fetches += 1;
      return response(200, { access_token: "unused" });
    };
    const adapter = new GrabOutboundAdapter(fetchImpl);

    const result = await adapter.sendCommand(baseCommand({ commandType: "BOGUS" as OutboundCommandRequest["commandType"], externalRef: null }));

    expect(fetches).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("TERMINAL");
      expect(result.message).toContain("unsupported command_type");
    }
  });
});

describe("GrabPartnerApiClient.configOrFailure", () => {
  it("is TERMINAL when GRAB_API_ENV is neither staging nor production", () => {
    configure({ GRAB_API_ENV: "sandbox" as never });
    const client = new GrabPartnerApiClient(async () => response(200));
    const result = client.configOrFailure();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("TERMINAL");
  });
});
