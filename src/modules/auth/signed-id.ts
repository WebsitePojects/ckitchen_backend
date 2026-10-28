/**
 * Bearer tokens of the form `<row id>.<HMAC-SHA256(JWT_SECRET, purpose + id)>`.
 *
 * Used where a row stands for something handed out by link or kept on a device (join links,
 * kiosk screens): nothing secret is stored, the server re-derives the MAC to verify a token
 * (and can show it again), and revoking the row kills the token. The `purpose` string keeps
 * a token minted for one use from being accepted by another. Rotating JWT_SECRET voids all.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../../config.js";
import { isUuid } from "../http-errors.js";

function mac(purpose: string, id: string): string {
  return createHmac("sha256", loadConfig().jwtSecret).update(`${purpose}:${id}`).digest("base64url");
}

export function signId(purpose: string, id: string): string {
  return `${id}.${mac(purpose, id)}`;
}

/** The row id a token was issued for, or null for anything malformed, forged or for another purpose. */
export function verifySignedId(purpose: string, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!isUuid(id)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(purpose, id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}
