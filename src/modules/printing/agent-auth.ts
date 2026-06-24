/**
 * Print-Agent Token Middleware — CK1-API-003 §8
 *
 * The Print Agent uses a dedicated, narrowly-scoped token via header
 * `X-Agent-Token: <token>`. This middleware enforces it.
 *
 * Security rules (security.md):
 *   - The agent uses X-Agent-Token, NOT a user JWT.
 *   - A valid user JWT must NOT be accepted here — the header must match
 *     the literal AGENT_TOKEN secret, not a JWT string.
 */
import type { NextFunction, Request, Response } from "express";
import { loadConfig } from "../../config.js";

/**
 * requireAgentToken — reads the `X-Agent-Token` header and compares it to
 * the configured agent token. Missing or mismatched → 401 AGENT_TOKEN_INVALID.
 *
 * Must NOT be combined with requireAuth — these are separate auth channels.
 */
export function requireAgentToken(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.headers["x-agent-token"];
  const { agentToken } = loadConfig();

  // The header must be a plain string equal to the configured token.
  // Array values (multiple X-Agent-Token headers) are rejected.
  if (!headerValue || Array.isArray(headerValue) || headerValue !== agentToken) {
    res.status(401).json({
      error: {
        code: "AGENT_TOKEN_INVALID",
        message: "Missing or invalid agent token. Set X-Agent-Token header.",
      },
    });
    return;
  }

  next();
}
