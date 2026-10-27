/**
 * Clerk provider boundary — the ONLY module that talks to Clerk.
 *
 * Clerk proves who someone is (Google / email sign-in). It never decides what they may do:
 * role and outlets always come from ORION's own `user` row (see authenticate.ts). Everything
 * here is inert unless CLERK_SECRET_KEY is set, so the platform keeps working with ORION's
 * own password login until Clerk is configured.
 *
 * Environment:
 *   CLERK_SECRET_KEY          required to enable Clerk (sk_live_... / sk_test_...)
 *   CLERK_JWT_KEY             optional PEM public key: verifies tokens with no network call
 *   CLERK_AUTHORIZED_PARTIES  comma-separated frontend origins allowed to present tokens;
 *                             defaults to CORS_ORIGINS
 *   CLERK_SIGN_IN_URL         where invitation emails send people (the frontend /login)
 */
import { createClerkClient, verifyToken, type ClerkClient } from "@clerk/backend";

export interface ClerkSettings {
  secretKey: string;
  jwtKey?: string;
  authorizedParties: string[];
  signInUrl?: string;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Clerk settings from the environment, or null when Clerk is not configured. */
export function clerkSettings(): ClerkSettings | null {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const explicit = listEnv("CLERK_AUTHORIZED_PARTIES");
  return {
    secretKey,
    jwtKey: process.env.CLERK_JWT_KEY?.trim() || undefined,
    authorizedParties: explicit.length > 0 ? explicit : listEnv("CORS_ORIGINS"),
    signInUrl: process.env.CLERK_SIGN_IN_URL?.trim() || undefined,
  };
}

/** Problems that make Clerk sign-in unsafe or broken; logged loudly at startup. */
export function clerkConfigProblem(settings: ClerkSettings | null): string | null {
  if (!settings) return null;
  if (settings.authorizedParties.length === 0) {
    return "CLERK_AUTHORIZED_PARTIES (or CORS_ORIGINS) is empty: tokens from any website would be accepted. Clerk sign-in is DISABLED until it lists the frontend origin(s).";
  }
  return null;
}

let client: ClerkClient | null = null;
function clerk(settings: ClerkSettings): ClerkClient {
  client ??= createClerkClient({ secretKey: settings.secretKey });
  return client;
}

/**
 * Verifies a Clerk session token and returns the Clerk user id, or null if the token is
 * not a valid Clerk session for one of our frontends. Never throws for a bad token.
 *
 * Note: @clerk/backend v2's verifyToken RETURNS `{ data } | { errors }` instead of throwing,
 * so the result must be checked explicitly (a try/catch alone would accept bad tokens).
 */
export async function verifyClerkSessionToken(token: string, settings: ClerkSettings): Promise<string | null> {
  if (clerkConfigProblem(settings)) return null;
  try {
    const result = await verifyToken(token, {
      secretKey: settings.secretKey,
      jwtKey: settings.jwtKey,
      authorizedParties: settings.authorizedParties,
    });
    if (result.errors || !result.data) {
      // Log why (reason code, else message) plus non-secret token facts, never the token, so a
      // sign-in that keeps failing can be diagnosed from the server log.
      const detail = ([] as unknown[])
        .concat(result.errors ?? [])
        .map((e) => {
          const err = e as { reason?: string; message?: string };
          return err.reason ?? err.message ?? String(e);
        })
        .join("; ");
      console.warn(`[auth] Clerk session token rejected: ${detail || "no error detail"} | ${describeToken(token)}`);
      return null;
    }
    // `sub` is the standard JWT subject (the Clerk user id); checked at runtime below.
    const sub = (result.data as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch (err) {
    console.warn(`[auth] Clerk session token verification failed: ${err instanceof Error ? err.message : String(err)} | ${describeToken(token)}`);
    return null;
  }
}

/** Unverified, non-secret facts about a bearer token for logs: never the token or signature. */
function describeToken(token: string): string {
  try {
    const [header, payload] = token
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>);
    const expiresIn = typeof payload.exp === "number" ? `${payload.exp - Math.floor(Date.now() / 1000)}s` : "?";
    return `alg=${String(header.alg)} kid=${String(header.kid)} iss=${String(payload.iss)} azp=${String(payload.azp)} sts=${String(payload.sts ?? "-")} expires_in=${expiresIn}`;
  } catch {
    return "not a JWT";
  }
}

/** The user's primary email if Clerk reports it VERIFIED, else null. Throws if Clerk is unreachable. */
export async function verifiedPrimaryEmail(clerkUserId: string, settings: ClerkSettings): Promise<string | null> {
  const user = await clerk(settings).users.getUser(clerkUserId);
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.emailAddress;
}

/**
 * Sends a Clerk invitation email so the person can create their sign-in. Idempotent:
 * an existing invitation or account is not an error. Returns false when Clerk is off.
 */
export async function sendClerkInvitation(email: string, settings: ClerkSettings | null): Promise<boolean> {
  if (!settings || clerkConfigProblem(settings)) return false;
  await clerk(settings).invitations.createInvitation({
    emailAddress: email,
    ignoreExisting: true,
    notify: true,
    ...(settings.signInUrl ? { redirectUrl: settings.signInUrl } : {}),
  });
  return true;
}
