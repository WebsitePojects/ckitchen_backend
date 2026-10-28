/**
 * Self-serve sign-up (mounted under /api/v1).
 *
 *   GET  /auth/signup/status   { enabled }  public: the sign-in page shows "Create your workspace"
 *   POST /auth/signup          Clerk bearer + business details -> the caller's own workspace
 *
 * Enabled only when BOTH hold: workspaces are isolated (TENANT_DB_ROLES=on: each workspace's
 * connections log in as its own database role) and SELF_SIGNUP=on. Without isolation a new
 * business would see CloudKitchen's rows, so sign-up stays off rather than degrade (fail closed).
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { clerkSettings, verifiedPrimaryEmail, verifyClerkSessionToken } from "../auth/clerk.js";
import { sendError } from "../http-errors.js";
import type { WorkspaceConnections } from "../tenancy/connections.js";
import { provisionWorkspace } from "./service.js";

const signupSchema = z.object({
  business_name: z.string().trim().min(2).max(120),
  owner_name: z.string().trim().min(1).max(120),
  outlet_name: z.string().trim().min(1).max(120),
  brand_name: z.string().trim().min(1).max(120),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0A5C41"),
});

export function selfSignupEnabled(connections: WorkspaceConnections, env: NodeJS.ProcessEnv = process.env): boolean {
  return connections.isolated && env.SELF_SIGNUP === "on" && clerkSettings() !== null;
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1]!.trim() : null;
}

export function createSignupRouter(platformDb: DB, connections: WorkspaceConnections): Router {
  const router = Router();
  const { loginRateLimit } = loadConfig();
  const signupLimiter = rateLimit({
    windowMs: loginRateLimit.windowMs,
    limit: loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "RATE_LIMITED", "Too many attempts. Please try again later."),
  });

  router.get("/auth/signup/status", (_req, res) => {
    res.json({ enabled: selfSignupEnabled(connections) });
  });

  router.post("/auth/signup", signupLimiter, async (req, res) => {
    const settings = clerkSettings();
    if (!settings || !selfSignupEnabled(connections)) {
      sendError(res, 404, "SIGNUP_UNAVAILABLE", "Creating a new workspace is not open yet.");
      return;
    }
    const sessionToken = bearer(req.headers.authorization);
    const clerkUserId = sessionToken ? await verifyClerkSessionToken(sessionToken, settings) : null;
    if (!clerkUserId) {
      sendError(res, 401, "AUTH_REQUIRED", "Sign in with Google first.");
      return;
    }
    const parsed = signupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Check the business details.", parsed.error.issues);
      return;
    }
    const body = parsed.data;

    let result;
    try {
      result = await provisionWorkspace(platformDb, clerkUserId, () => verifiedPrimaryEmail(clerkUserId, settings), {
        businessName: body.business_name,
        ownerName: body.owner_name,
        outletName: body.outlet_name,
        brandName: body.brand_name,
        brandColor: body.brand_color,
      });
    } catch (err) {
      console.error(`[signup] workspace provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 503, "SIGNUP_FAILED", "Could not create the workspace. Nothing was saved; try again.");
      return;
    }

    if (!result.ok) {
      switch (result.code) {
        case "EMAIL_NOT_VERIFIED":
          sendError(res, 403, "EMAIL_NOT_VERIFIED", "Verify your email address, then try again.");
          return;
        case "EMAIL_ALREADY_ADDED":
          sendError(res, 409, "EMAIL_ALREADY_ADDED", `${result.email} is already in ORION. Sign in with it instead.`);
          return;
        case "ALREADY_MEMBER":
          sendError(res, 409, "ALREADY_MEMBER", "This Google account already belongs to a workspace. Open ORION and sign in.");
          return;
        default: {
          const unhandled: never = result.code;
          sendError(res, 500, "INTERNAL_ERROR", `Unhandled sign-up result ${String(unhandled)}.`);
          return;
        }
      }
    }
    res.status(result.replay ? 200 : 201).json({ workspace: result.workspace });
  });

  return router;
}
