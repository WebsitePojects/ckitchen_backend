/**
 * Print-Agent Auth — CK1-API-003 §8 / SF-2 (audit-backend.md CRITICAL #2)
 *
 * Two DISTINCT auth channels, both via header `X-Agent-Token: <token>`, never
 * a user JWT:
 *
 *   1. `requireBootstrapToken` — gates ONLY `POST /agent/register`. Compares
 *      the header against the single shared `AGENT_TOKEN` secret (env). This
 *      is the pre-identity step: an agent has no per-agent token yet, so it
 *      must prove it holds the shared install-time secret before the server
 *      will mint one for it. Timing-safe compare (constant-time regardless of
 *      where the strings first differ) so response latency can't be used to
 *      brute-force the shared secret byte-by-byte.
 *
 *   2. `requireAgentToken` — gates every OTHER agent endpoint (pending pull,
 *      ack, printer heartbeat). sha256-hashes the presented token and looks up
 *      the owning `print_agent` row by `token_hash`. On a match, attaches
 *      `req.agent = { id, locationId }` — every downstream handler derives its
 *      outlet scope from THIS, never from a client-supplied query/body field
 *      (business rules D20/D21: never mix one outlet's print queue with
 *      another's).
 *
 * Before SF-2, both of the above collapsed into one check: does the header
 * equal the process-wide AGENT_TOKEN? That token was never bound to a
 * specific agent or location, so any holder of the one shared secret could
 * claim to be any agent, at any outlet, for `ack`/`printers/status`/`pending`
 * (see docs/audits/audit-backend.md CRITICAL #2).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../config.js";
import type { DB } from "../../db/client.js";
import { printAgents } from "../../db/schema.js";

export interface AuthenticatedAgent {
  id: string;
  locationId: string;
}

// Mirrors the `req.user` augmentation in auth/middleware.ts.
declare module "express-serve-static-core" {
  interface Request {
    agent?: AuthenticatedAgent;
  }
}

/** sha256(token) as lowercase hex — the deterministic, indexable digest stored in `token_hash`. */
export function hashAgentToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` throws if the two
 * buffers differ in length, so a length mismatch is handled as an immediate,
 * safe `false` — leaking token LENGTH via timing is an accepted, minor
 * tradeoff (same one Node's own docs describe); leaking WHICH BYTE differs is
 * what this guards against, and matters far more for a fixed-format secret.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendAgentTokenInvalid(res: Response): void {
  res.status(401).json({
    error: {
      code: "AGENT_TOKEN_INVALID",
      message: "Missing or invalid agent token. Set X-Agent-Token header.",
    },
  });
}

/** Single non-array string header value, or null (missing / repeated header). */
function singleHeaderValue(value: string | string[] | undefined): string | null {
  if (!value || Array.isArray(value)) return null;
  return value;
}

/**
 * Bootstrap gate for `POST /agent/register` ONLY. Compares `X-Agent-Token`
 * against the shared `AGENT_TOKEN` env secret, timing-safe. This is the ONE
 * pre-identity agent endpoint — every other agent route requires a token
 * already minted by a prior successful register call (see `requireAgentToken`).
 */
export function requireBootstrapToken(req: Request, res: Response, next: NextFunction): void {
  const headerValue = singleHeaderValue(req.headers["x-agent-token"]);
  const { agentToken } = loadConfig();

  if (!headerValue || !timingSafeEqualStr(headerValue, agentToken)) {
    sendAgentTokenInvalid(res);
    return;
  }

  next();
}

/**
 * Identity gate for pending-pull / ack / printer-heartbeat. Looks up the
 * `print_agent` row whose `token_hash` matches sha256(header) and attaches
 * `req.agent = { id, locationId }`. 401 if missing/unrecognized/repeated
 * header, or no row matches (covers both "wrong token" and "a valid user JWT
 * was passed here instead" — a JWT will simply never match any token_hash).
 */
export async function requireAgentToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerValue = singleHeaderValue(req.headers["x-agent-token"]);
  if (!headerValue) {
    sendAgentTokenInvalid(res);
    return;
  }

  try {
    const db = req.app.get("db") as DB;
    const tokenHash = hashAgentToken(headerValue);
    const [agent] = await db
      .select({ id: printAgents.id, locationId: printAgents.locationId })
      .from(printAgents)
      .where(eq(printAgents.tokenHash, tokenHash));

    if (!agent) {
      sendAgentTokenInvalid(res);
      return;
    }

    req.agent = { id: agent.id, locationId: agent.locationId };
    next();
  } catch {
    // Fail closed — never let a DB hiccup fall through as an authenticated agent.
    sendAgentTokenInvalid(res);
  }
}
