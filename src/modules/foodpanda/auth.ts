import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { sendError } from "../http-errors.js";
import { getFoodpandaPluginJwtSecret } from "./config.js";

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Delivery Hero Plugin API auth. A valid, non-self-signed TLS certificate is
 * an infrastructure requirement for exposing these endpoints; app-side auth is
 * the HS512 middleware JWT with `service: "middleware"` from pluginApi.yaml.
 */
export function requireFoodpandaPluginJwt(req: Request, res: Response, next: NextFunction): void {
  const secret = getFoodpandaPluginJwtSecret();
  if (!secret) {
    sendError(res, 503, "FEATURE_DISABLED", "Foodpanda Plugin API inbound is not configured.");
    return;
  }

  const token = bearerToken(req.header("Authorization"));
  if (!token) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid Foodpanda Plugin API token.");
    return;
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS512"] });
    if (!decoded || typeof decoded !== "object" || (decoded as JwtPayload).service !== "middleware") {
      sendError(res, 401, "UNAUTHORIZED", "Invalid Foodpanda Plugin API token.");
      return;
    }
    next();
  } catch {
    sendError(res, 401, "UNAUTHORIZED", "Invalid Foodpanda Plugin API token.");
  }
}
