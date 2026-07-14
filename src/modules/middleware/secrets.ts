/**
 * Webhook signing secret + key-id loader (spec §11: "Credentials remain
 * environment/secret-manager only."). Deliberately NOT folded into
 * src/config.ts's shared Config — this module owns its own narrow secret
 * surface so no other builder's edits to config.ts can collide with this
 * stream's work.
 *
 * Mirrors config.ts's `requireSecret` convention: a fixed deterministic
 * fallback under `NODE_ENV=test` (so the suite runs without a `.env`), a
 * fatal error otherwise. Never logged, never returned in any API response.
 */
import type { WebhookSecrets } from "./types.js";

const TEST_CURRENT_SECRET = "test-middleware-webhook-secret";
const TEST_KEY_ID = "dummy-key-v1";

export function loadWebhookSecrets(): WebhookSecrets {
  const current = process.env.MIDDLEWARE_WEBHOOK_SECRET;
  if (current) {
    const previous = process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS;
    return previous ? { current, previous } : { current };
  }
  if (process.env.NODE_ENV === "test") {
    const previous = process.env.MIDDLEWARE_WEBHOOK_SECRET_PREVIOUS;
    return previous ? { current: TEST_CURRENT_SECRET, previous } : { current: TEST_CURRENT_SECRET };
  }
  throw new Error("MIDDLEWARE_WEBHOOK_SECRET is required (set it in .env)");
}

/**
 * The signing key id rotation is identified by (not the secret value, which
 * rotates via current/previous — see loadWebhookSecrets). Configured as a
 * comma-separated allowlist so a key id can be pre-registered ahead of a
 * secret rotation. Defaults to one fixed test id under NODE_ENV=test.
 */
export function loadKnownKeyIds(): ReadonlySet<string> {
  const raw = process.env.MIDDLEWARE_WEBHOOK_KEY_IDS;
  if (raw) {
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  if (process.env.NODE_ENV === "test") return new Set([TEST_KEY_ID]);
  throw new Error("MIDDLEWARE_WEBHOOK_KEY_IDS is required (set it in .env)");
}

/** Convenience default for tests/fixtures that need a known-valid key id. */
export const DEFAULT_TEST_KEY_ID = TEST_KEY_ID;
