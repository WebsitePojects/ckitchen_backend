/**
 * Workspace join links (mounted under /api/v1).
 *
 * Owner (requireAuth + OWNER):
 *   GET  /admin/join-links             recent links; an active one carries its token again
 *   POST /admin/join-links             create (idempotent per request_id)
 *   POST /admin/join-links/:id/revoke  revoke an unused link (repeat = no-op)
 *
 * Joining (rate-limited; the token travels in the body, never in a URL):
 *   POST /auth/join/preview  { token }                   workspace + role shown before sign-in
 *   POST /auth/join          { token } + Clerk bearer     create the account and join
 *
 * /auth/join verifies the Clerk session itself: the person has no ORION account yet, so
 * requireAuth would refuse them (NOT_INVITED). That is exactly the gap this closes.
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import type { WorkspaceJoinLink } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { V2_ROLES } from "../auth/roles.js";
import { clerkSettings, verifiedPrimaryEmail, verifyClerkSessionToken } from "../auth/clerk.js";
import { audit } from "../ems/audit.js";
import { isUuid, paramAsString, sendError } from "../http-errors.js";
import {
  createJoinLink,
  joinLinkStatus,
  joinLinkToken,
  linkIdFromToken,
  listJoinLinks,
  previewJoinLink,
  redeemJoinLink,
  revokeJoinLink,
} from "./service.js";

const createSchema = z.object({
  invitee_name: z.string().trim().min(1).max(120),
  role: z.enum(V2_ROLES),
  outlet_ids: z.array(z.string().uuid()).max(100).default([]),
  expires_in_days: z.number().int().min(1).max(30).default(7),
  request_id: z.string().uuid(),
});

const tokenSchema = z.object({ token: z.string().min(1).max(200) });

const LINK_INVALID_MESSAGE = "This join link has expired, was already used, or was cancelled. Ask the owner for a new one.";

function toOwnerView(link: WorkspaceJoinLink, usedByName: string | null = null) {
  const status = joinLinkStatus(link);
  return {
    id: link.id,
    inviteeName: link.inviteeName,
    role: link.role,
    outletIds: link.outletIds,
    status,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    usedAt: link.usedAt,
    usedByName,
    // Only an active link is worth copying again; a spent one never shows its token.
    token: status === "active" ? joinLinkToken(link.id) : null,
  };
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1]!.trim() : null;
}

export function createJoinLinkRouter(db: DB): Router {
  const router = Router();

  const { loginRateLimit } = loadConfig();
  const joinLimiter = rateLimit({
    windowMs: loginRateLimit.windowMs,
    limit: loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "RATE_LIMITED", "Too many attempts. Please try again later."),
  });

  // ── Owner ────────────────────────────────────────────────────────────────
  router.use("/admin/join-links", requireAuth, requireRole("OWNER"));

  router.get("/admin/join-links", async (_req, res) => {
    const rows = await listJoinLinks(db);
    res.json(rows.map((r) => toOwnerView(r.link, r.usedByName)));
  });

  router.post("/admin/join-links", async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid join link.", parsed.error.issues);
      return;
    }
    const body = parsed.data;
    const result = await createJoinLink(db, {
      role: body.role,
      inviteeName: body.invitee_name,
      outletIds: body.outlet_ids,
      expiresInDays: body.expires_in_days,
      clientRequestId: body.request_id,
      createdByUserId: req.user!.id,
    });
    if (!result.ok) {
      if (result.code === "UNKNOWN_OUTLET") sendError(res, 400, "VALIDATION_ERROR", "One or more outlets do not exist.");
      else sendError(res, 409, "IDEMPOTENCY_CONFLICT", "This request id was already used for a different link.");
      return;
    }
    if (!result.replay) {
      await audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name,
        sessionId: req.user!.sessionId ?? null,
        action: "admin.join_link.create",
        description: `Created a join link for ${result.link.inviteeName} as ${result.link.role}`,
        entityType: "workspace_join_link",
        entityId: result.link.id,
        metadata: { role: result.link.role, outletIds: result.link.outletIds, expiresAt: result.link.expiresAt },
      });
    }
    res.status(result.replay ? 200 : 201).json(toOwnerView(result.link));
  });

  router.post("/admin/join-links/:id/revoke", async (req, res) => {
    const id = paramAsString(req.params.id);
    if (!isUuid(id)) {
      sendError(res, 404, "NOT_FOUND", "Join link not found.");
      return;
    }
    const result = await revokeJoinLink(db, id);
    if (!result.ok) {
      if (result.code === "NOT_FOUND") sendError(res, 404, "NOT_FOUND", "Join link not found.");
      else sendError(res, 409, "ALREADY_USED", "This link was already used; block the person on Users & Roles instead.");
      return;
    }
    await audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "admin.join_link.revoke",
      description: `Cancelled the join link for ${result.link.inviteeName}`,
      entityType: "workspace_join_link",
      entityId: result.link.id,
    });
    res.json(toOwnerView(result.link));
  });

  // ── Joining ──────────────────────────────────────────────────────────────
  router.post("/auth/join/preview", joinLimiter, async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body ?? {});
    const linkId = parsed.success ? linkIdFromToken(parsed.data.token) : null;
    const preview = linkId ? await previewJoinLink(db, linkId) : null;
    if (!preview) {
      sendError(res, 410, "LINK_INVALID", LINK_INVALID_MESSAGE);
      return;
    }
    res.json(preview);
  });

  router.post("/auth/join", joinLimiter, async (req, res) => {
    const settings = clerkSettings();
    if (!settings) {
      sendError(res, 404, "JOIN_UNAVAILABLE", "Join links need Google sign-in, which is not set up here.");
      return;
    }
    const sessionToken = bearer(req.headers.authorization);
    const clerkUserId = sessionToken ? await verifyClerkSessionToken(sessionToken, settings) : null;
    if (!clerkUserId) {
      sendError(res, 401, "AUTH_REQUIRED", "Sign in with Google first, then open the link again.");
      return;
    }
    const parsed = tokenSchema.safeParse(req.body ?? {});
    const linkId = parsed.success ? linkIdFromToken(parsed.data.token) : null;
    if (!linkId) {
      sendError(res, 410, "LINK_INVALID", LINK_INVALID_MESSAGE);
      return;
    }

    let result;
    try {
      result = await redeemJoinLink(db, linkId, clerkUserId, () => verifiedPrimaryEmail(clerkUserId, settings));
    } catch {
      sendError(res, 503, "IDENTITY_UNAVAILABLE", "Could not reach the sign-in service. Try again.");
      return;
    }

    if (!result.ok) {
      switch (result.code) {
        case "LINK_INVALID":
          sendError(res, 410, "LINK_INVALID", LINK_INVALID_MESSAGE);
          return;
        case "ALREADY_MEMBER":
          sendError(res, 409, "ALREADY_MEMBER", "This Google account already has ORION access. Open ORION and sign in.");
          return;
        case "EMAIL_NOT_VERIFIED":
          sendError(res, 403, "EMAIL_NOT_VERIFIED", "Verify your email address, then open the link again.");
          return;
        case "EMAIL_ALREADY_ADDED":
          // The signed-in person's own email; telling them is not an enumeration leak.
          sendError(res, 409, "EMAIL_ALREADY_ADDED", `${result.email} is already in ORION. Sign in with it instead of using this link.`);
          return;
        default: {
          // Fail closed if a new code is added without a response.
          const unhandled: never = result.code;
          sendError(res, 500, "INTERNAL_ERROR", `Unhandled join result ${String(unhandled)}.`);
          return;
        }
      }
    }

    if (!result.replay) {
      await audit(db, {
        actorUserId: result.user.id,
        actorName: result.user.name,
        action: "auth.join_link.redeem",
        description: `${result.user.name} joined with a join link as ${result.user.role}`,
        entityType: "workspace_join_link",
        entityId: linkId,
      });
    }
    res.status(result.replay ? 200 : 201).json({ ok: true, role: result.user.role });
  });

  return router;
}
