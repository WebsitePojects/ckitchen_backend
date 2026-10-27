/**
 * verifyClerkSessionToken against the REAL @clerk/backend verifier (no module mock).
 *
 * clerk-auth.test.ts mocks clerk.ts as a whole, so it never exercised how the SDK reports
 * success and failure. That gap hid a production bug: the SDK returns the payload and throws
 * on failure, while our code expected `{ data, errors }` and rejected every valid token.
 * Tokens here are signed with a locally generated RSA key and verified through `jwtKey`
 * (networkless), exactly as production does with CLERK_JWT_KEY.
 */
import { generateKeyPairSync, createSign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyClerkSessionToken, type ClerkSettings } from "../src/modules/auth/clerk.js";

const FRONTEND = "https://app.orion.example";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const settings: ClerkSettings = {
  secretKey: "sk_test_unused_with_jwt_key",
  jwtKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  authorizedParties: [FRONTEND],
};

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// The SDK caches the key loaded from a PEM by `kid`, so a test that swaps keys needs its own kid.
function signToken(claims: Record<string, unknown>, kid = "ins_test"): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT", kid });
  const payload = b64url({ sub: "user_123", azp: FRONTEND, iss: "https://clerk.orion.example", iat: now - 5, nbf: now - 5, exp: now + 60, sts: "active", ...claims });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("verifyClerkSessionToken (real SDK)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a valid, active session token and returns the Clerk user id", async () => {
    expect(await verifyClerkSessionToken(signToken({}), settings)).toBe("user_123");
  });

  it("rejects an expired token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyClerkSessionToken(signToken({ iat: now - 600, nbf: now - 600, exp: now - 300 }), settings)).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/rejected: .*expired/i);
  });

  it("rejects a token minted for another website (authorized party)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await verifyClerkSessionToken(signToken({ azp: "https://evil.example" }), settings)).toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(await verifyClerkSessionToken(signToken({}, "ins_other"), { ...settings, jwtKey: other })).toBeNull();
  });

  it("rejects a pending session (an unfinished Clerk step such as choose-organization)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await verifyClerkSessionToken(signToken({ sts: "pending" }), settings)).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/session pending/);
  });

  it("never logs the token itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const token = signToken({ azp: "https://evil.example" });
    await verifyClerkSessionToken(token, settings);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(token.split(".")[2]);
  });
});
