import { MAX_CREDENTIAL_LEN } from "./validation.js";

const DEFAULT_BASE_PATH = "/api/v1/grab";
// Grab's own GetPartnerAccessToken sample response uses expires_in = 604799 (~7 days).
const DEFAULT_TOKEN_TTL_SECONDS = 604_799;

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BASE_PATH;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.length > 1 && withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

/** Grab is told the full URL at onboarding time, so any path is legal — configurable, defaults to /api/v1/grab. */
export function getGrabPartnerBasePath(): string {
  return normalizeBasePath(process.env.GRAB_PARTNER_BASE_PATH);
}

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** The client_id Grab must present at POST /oauth/token (G1). */
export function getGrabPartnerClientId(): string | null {
  return trimmedEnv("GRAB_PARTNER_CLIENT_ID");
}

/** The client_secret Grab must present at POST /oauth/token (G1). */
export function getGrabPartnerClientSecret(): string | null {
  return trimmedEnv("GRAB_PARTNER_CLIENT_SECRET");
}

/**
 * Secret ORION signs minted access tokens with. Deliberately SEPARATE from
 * the partner client_secret above (rule 10, idempotency-concurrency.md) —
 * a leaked partner credential alone can't forge a bearer token, and a
 * compromised signing secret alone can't authenticate as the partner.
 */
export function getGrabPartnerTokenSecret(): string | null {
  return trimmedEnv("GRAB_PARTNER_TOKEN_SECRET");
}

export function getGrabPartnerTokenTtlSeconds(): number {
  const raw = process.env.GRAB_PARTNER_TOKEN_TTL_SECONDS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TOKEN_TTL_SECONDS;
}

const CREDENTIAL_ENV_VARS = ["GRAB_PARTNER_CLIENT_ID", "GRAB_PARTNER_CLIENT_SECRET"] as const;

/**
 * Detects a Grab credential that can never authenticate: the token request
 * body schema (validation.ts) caps client_id/client_secret at
 * MAX_CREDENTIAL_LEN, so a longer env value could never be echoed back by
 * Grab and every login would fail with a misleading 400 VALIDATION_ERROR
 * (production incident 2026-10-01: a 64-char secret). Returns a message that
 * names the variable and the limit — never the value, which is a secret.
 */
export function getGrabPartnerConfigProblem(): string | null {
  const tooLong = CREDENTIAL_ENV_VARS.filter((name) => (trimmedEnv(name)?.length ?? 0) > MAX_CREDENTIAL_LEN);
  if (tooLong.length === 0) return null;
  return `${tooLong.join(" and ")} exceed${tooLong.length === 1 ? "s" : ""} the ${MAX_CREDENTIAL_LEN}-character limit of Grab's GetPartnerAccessToken; Grab integration is DISABLED until fixed.`;
}

/**
 * Fail-closed module gate (rule 3/14): every inbound GrabFood Partner API
 * route, INCLUDING token issuance itself, is inert (503 FEATURE_DISABLED)
 * unless all three secrets are configured. There is no partial-configuration
 * state — an operator sets up the whole module or none of it. A credential
 * that can never pass token validation counts as NOT configured, so the
 * operator sees an honest 503 instead of a misleading 400.
 */
export function isGrabPartnerConfigured(): boolean {
  return (
    getGrabPartnerClientId() !== null &&
    getGrabPartnerClientSecret() !== null &&
    getGrabPartnerTokenSecret() !== null &&
    getGrabPartnerConfigProblem() === null
  );
}

export interface GrabPartnerRateLimitConfig {
  windowMs: number;
  max: number;
}

/**
 * POST /oauth/token throttle (rule 12: auth endpoints are rate-limited).
 * Mirrors src/config.ts's loginRateLimit shape/defaults: a high test-only
 * ceiling so this module's own test suite's repeated token calls never trip
 * it, a conservative real default otherwise. Grab's contract only re-requests
 * a token when one is missing/expiring/401'd, so legitimate traffic here is
 * inherently low-frequency — a generous real-world ceiling is still safe.
 */
export function getGrabPartnerOauthRateLimit(): GrabPartnerRateLimitConfig {
  const isTest = process.env.NODE_ENV === "test";
  return {
    windowMs: Number(process.env.GRAB_PARTNER_OAUTH_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
    max: Number(process.env.GRAB_PARTNER_OAUTH_RATE_LIMIT_MAX ?? (isTest ? 100_000 : 20)),
  };
}
