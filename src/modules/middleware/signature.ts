/**
 * HMAC-SHA256 webhook signature primitives (spec §11: "Webhook intake
 * verifies exact raw bytes, timestamp, key ID, and signature before
 * parsing.").
 *
 * The signed message is `${timestamp}.` concatenated with the EXACT raw
 * request bytes (a Buffer, not a re-serialized string) — so a byte-for-byte
 * mutation of the body (whitespace, key order, a single flipped digit)
 * always changes the digest, regardless of whether the mutated body still
 * parses as equivalent-looking JSON. Timestamp is folded into the signed
 * message (not just checked for skew) so a captured signature cannot be
 * replayed later with a swapped timestamp header.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookHeaders, WebhookSecrets } from "./types.js";

/** sha256 hex digest is 64 hex chars. */
const HEX_SHA256_LEN = 64;

export function computeSignature(rawBytes: Buffer, timestamp: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(Buffer.from(`${timestamp}.`, "utf8"));
  hmac.update(rawBytes);
  return hmac.digest("hex");
}

/** Constant-time hex-digest comparison; false (never throws) on any length mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies `headers.signature` against the current secret, falling back to
 * `secrets.previous` when set (spec §11: "Current/previous secrets may
 * overlap briefly during rotation."). Returns true the moment either secret
 * matches.
 */
export function verifyHmacSignature(rawBytes: Buffer, headers: WebhookHeaders, secrets: WebhookSecrets): boolean {
  if (headers.signature.length !== HEX_SHA256_LEN) return false;
  const expectedCurrent = computeSignature(rawBytes, headers.timestamp, secrets.current);
  if (safeEqualHex(headers.signature, expectedCurrent)) return true;
  if (secrets.previous) {
    const expectedPrevious = computeSignature(rawBytes, headers.timestamp, secrets.previous);
    if (safeEqualHex(headers.signature, expectedPrevious)) return true;
  }
  return false;
}

/** True when `timestamp` (epoch seconds, string) is within `skewSeconds` of now in either direction. */
export function isTimestampFresh(timestamp: string, skewSeconds: number, now: number = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  return Math.abs(now - tsMs) <= skewSeconds * 1000;
}
