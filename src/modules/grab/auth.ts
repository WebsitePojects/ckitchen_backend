/**
 * GrabFood Partner API inbound auth (src/modules/grab/config.ts + this file).
 *
 * INVERTED from every other inbound integration in this codebase: Grab calls
 * US at POST /oauth/token and WE mint the access token (G1). Grab then sends
 * that token back as `Authorization: Bearer <token>` on every other partner
 * route, which G2's requireGrabPartnerBearer middleware verifies.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { sendError } from "../http-errors.js";
import {
  getGrabPartnerClientId,
  getGrabPartnerClientSecret,
  getGrabPartnerOauthRateLimit,
  getGrabPartnerTokenSecret,
  getGrabPartnerTokenTtlSeconds,
  isGrabPartnerConfigured,
} from "./config.js";
import type { GrabOauthTokenBody } from "./validation.js";

export class GrabPartnerAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GrabPartnerAuthError";
  }
}

/**
 * Single source of the fail-closed 503, shared by the route (which must answer
 * it BEFORE body validation) and issueGrabPartnerToken (defense in depth for
 * any other caller).
 */
export function assertGrabPartnerConfigured(): void {
  if (!isGrabPartnerConfigured()) {
    throw new GrabPartnerAuthError(503, "FEATURE_DISABLED", "GrabFood Partner API inbound is not configured.");
  }
}

const REQUIRED_GRANT_TYPE = "client_credentials";
const REQUIRED_SCOPE = "food.partner_api";

/**
 * Constant-time credential comparison (rule 10). `timingSafeEqual` THROWS on
 * unequal-length buffers — hashing both sides to a fixed 32-byte SHA-256
 * digest first removes that length-dependent branch entirely, so comparison
 * time never depends on how much of client_id/client_secret was guessed
 * correctly.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export interface GrabPartnerTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

/**
 * G1 — "Get partner access token webhook". Every rejection path
 * (unconfigured aside) — wrong grant_type, wrong scope, wrong client_id,
 * wrong client_secret — resolves to the SAME generic 401 invalid_client
 * (rule 12: no enumeration of which field was wrong). All four checks run
 * unconditionally before branching, so total handler latency doesn't become
 * its own side channel.
 *
 * The token is never persisted anywhere (grab-schema.ts's table comment:
 * "Never persists the OAuth partner access token or client_secret") and
 * neither client_secret nor the signed token is ever logged.
 */
export function issueGrabPartnerToken(body: GrabOauthTokenBody): GrabPartnerTokenResponse {
  assertGrabPartnerConfigured();

  const configuredClientId = getGrabPartnerClientId()!;
  const configuredClientSecret = getGrabPartnerClientSecret()!;
  const tokenSecret = getGrabPartnerTokenSecret()!;

  // grant_type/scope are fixed protocol strings, not secrets — plain equality
  // is fine for them. Only the credential pair needs constant-time compare.
  const grantTypeOk = body.grant_type === REQUIRED_GRANT_TYPE;
  const scopeOk = body.scope === undefined || body.scope === REQUIRED_SCOPE;
  const clientIdOk = constantTimeEquals(body.client_id, configuredClientId);
  const clientSecretOk = constantTimeEquals(body.client_secret, configuredClientSecret);

  if (!grantTypeOk || !scopeOk || !clientIdOk || !clientSecretOk) {
    throw new GrabPartnerAuthError(401, "invalid_client", "Invalid client credentials.");
  }

  const expiresIn = getGrabPartnerTokenTtlSeconds();
  const accessToken = jwt.sign({ scope: REQUIRED_SCOPE }, tokenSecret, {
    algorithm: "HS256",
    expiresIn,
  });

  return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn };
}

/** rule 12: throttle the one endpoint an attacker could use to brute-force client_secret. */
export function createGrabPartnerOauthRateLimiter() {
  const { windowMs, max } = getGrabPartnerOauthRateLimit();
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(res, 429, "RATE_LIMITED", "Too many token requests. Please try again later.");
    },
  });
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * G2 — bearer verification for every OTHER GrabFood Partner API route.
 * Verifies the HS256 JWT ORION itself minted in issueGrabPartnerToken above,
 * with the algorithm PINNED to ["HS256"] (never trust the token's own `alg`
 * header). Unconfigured → 503; invalid/absent/expired/wrong-signature/
 * wrong-algorithm → the same generic 401.
 */
export function requireGrabPartnerBearer(req: Request, res: Response, next: NextFunction): void {
  const secret = getGrabPartnerTokenSecret();
  if (!isGrabPartnerConfigured() || !secret) {
    sendError(res, 503, "FEATURE_DISABLED", "GrabFood Partner API inbound is not configured.");
    return;
  }

  const token = bearerToken(req.header("Authorization"));
  if (!token) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid GrabFood Partner API token.");
    return;
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") {
      sendError(res, 401, "UNAUTHORIZED", "Invalid GrabFood Partner API token.");
      return;
    }
    next();
  } catch {
    sendError(res, 401, "UNAUTHORIZED", "Invalid GrabFood Partner API token.");
  }
}
