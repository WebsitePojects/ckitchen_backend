/**
 * Outbound aggregator command router (AGGREGATOR_API_INTEGRATION_SPEC.md
 * §4-5 — "Merchant console UI: per-listing live order queue with
 * accept/reject/ready controls, store pause, item sold-out toggles — the
 * tablet/phone replacement screen.").
 *
 * Endpoints (all under /api/v1, all requireAuth + outlet-scoped to the
 * listing's physical outlet — mirrors src/modules/stations/routes.ts's
 * requireRole + resolveOutletContext + isOutletInScope convention):
 *
 *   POST  /channel-listings/:id/commands                — generic command
 *                                                          send. RBAC OWNER|
 *                                                          OUTLET_MANAGER|
 *                                                          KITCHEN_CREW, but
 *                                                          KITCHEN_CREW may
 *                                                          only send
 *                                                          ACCEPT_ORDER|
 *                                                          REJECT_ORDER|
 *                                                          MARK_READY.
 *   POST  /channel-listings/:id/pause                    — sugar for
 *                                                          PAUSE_STORE.
 *   POST  /channel-listings/:id/resume                   — sugar for
 *                                                          RESUME_STORE.
 *   POST  /channel-listings/:id/items/:itemId/availability
 *                                                         — sugar for
 *                                                          SET_ITEM_AVAILABILITY.
 *   PATCH /channel-listings/:id/control-mode              — OWNER only,
 *                                                          audited (spec §5
 *                                                          cutover: DEVICE ->
 *                                                          SHADOW -> API,
 *                                                          rollback = flip
 *                                                          back to DEVICE).
 *   GET   /outbound-commands?listing_id=&status=          — monitoring list.
 *
 * Write routes require a bounded `Idempotency-Key` header (mirrors
 * src/modules/customer-orders/routes.ts's fulfill() contract) — combined
 * server-side with (listing, order, command_type) into the stored,
 * globally-unique idempotency key (service.ts enqueueCommand).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { aggregatorCommandStatusEnum, aggregatorCommandTypeEnum, orderDisputeStatusEnum } from "../../db/outbound-schema.js";
import { channelControlModeEnum } from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope, listScopeLocationIds } from "../auth/outlet-scope.js";
import { normalizeRole } from "../auth/roles.js";
import { paramAsString, sendError } from "../http-errors.js";
import { OutboundError } from "./errors.js";
import { KITCHEN_CREW_ALLOWED_COMMAND_TYPES } from "./policies.js";
import {
  createDispute,
  enqueueCommand,
  getListingById,
  listChannelListings,
  listCommands,
  listDisputes,
  listListingItems,
  updateControlMode,
} from "./service.js";
import { DISPUTE_REASON_CODES, type OutboundCommandType } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_HEADER_LEN = 200;
const MAX_REASON_LEN = 500;
const MAX_ITEM_ID_LEN = 200;
const MAX_PAYLOAD_JSON_BYTES = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

const COMMAND_TYPES = aggregatorCommandTypeEnum.enumValues;
const COMMAND_STATUSES = aggregatorCommandStatusEnum.enumValues;
const CONTROL_MODES = channelControlModeEnum.enumValues;
const DISPUTE_STATUSES = orderDisputeStatusEnum.enumValues;

const uuidSchema = z.string().uuid();

const boundedPayloadSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .refine((v) => v === undefined || JSON.stringify(v).length <= MAX_PAYLOAD_JSON_BYTES, {
    message: `payload must serialize to at most ${MAX_PAYLOAD_JSON_BYTES} bytes.`,
  });

const genericCommandSchema = z
  .object({
    command_type: z.enum(COMMAND_TYPES as [string, ...string[]]),
    order_id: uuidSchema.optional(),
    payload: boundedPayloadSchema,
  })
  .strict();

const pauseSchema = z
  .object({
    reason: z.string().trim().max(MAX_REASON_LEN).optional(),
  })
  .strict();

const resumeSchema = z.object({}).strict();

const availabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().trim().max(MAX_REASON_LEN).optional(),
    // Migration 0036 (finding F/G) — foodpanda's yellow/grey snooze legend:
    // null/absent = indefinite. The sugar route below is always ITEM-scoped
    // by URL shape; OPTION_GROUP scope goes through the generic /commands
    // route with the full payload (scope + option_group_id).
    unavailable_until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const controlModeSchema = z
  .object({
    control_mode: z.enum(CONTROL_MODES as [string, ...string[]]),
  })
  .strict();

const listQuerySchema = z.object({
  listing_id: uuidSchema.optional(),
  status: z.enum(COMMAND_STATUSES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

const contestCancellationSchema = z
  .object({
    dispute_reason: z.enum(DISPUTE_REASON_CODES as unknown as [string, ...string[]]),
    evidence_note: z.string().trim().max(MAX_REASON_LEN).optional(),
  })
  .strict();

const listDisputesQuerySchema = z.object({
  listing_id: uuidSchema.optional(),
  status: z.enum(DISPUTE_STATUSES as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof OutboundError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[outbound] unhandled error", err);
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

/** Bounded, required header read; 400s the request and returns null if missing/oversized. */
function requireBoundedHeader(req: { header(name: string): string | undefined }, res: Response, name: string): string | null {
  const raw = req.header(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > MAX_HEADER_LEN) {
    sendError(res, 400, "VALIDATION_ERROR", `${name} header is required and must be at most ${MAX_HEADER_LEN} characters.`);
    return null;
  }
  return value;
}

function toCommandResponse(cmd: Awaited<ReturnType<typeof enqueueCommand>>) {
  return {
    id: cmd.id,
    aggregator_account_id: cmd.aggregatorAccountId,
    order_id: cmd.orderId,
    command_type: cmd.commandType,
    payload: cmd.payload,
    status: cmd.status,
    attempts: cmd.attempts,
    next_attempt_at: cmd.nextAttemptAt,
    last_error: cmd.lastError,
    provider_ref: cmd.providerRef,
    created_at: cmd.createdAt,
    updated_at: cmd.updatedAt,
  };
}

function toDisputeResponse(d: Awaited<ReturnType<typeof createDispute>>) {
  return {
    id: d.id,
    order_id: d.orderId,
    raised_by: d.raisedBy,
    reason: d.reason,
    status: d.status,
    aggregator_command_id: d.aggregatorCommandId,
    evidence_note: d.evidenceNote,
    resolved_at: d.resolvedAt,
    resolution_note: d.resolutionNote,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOutboundRouter(db: DB): Router {
  const router = Router();

  function actorCtx(req: { user?: { id: string; sessionId?: string; name: string | null } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null, actorName: req.user!.name };
  }

  /** Loads the listing and 403s if it's outside the caller's outlet scope; 404s if missing. Returns null after already responding. */
  async function loadListingInScope(req: Request, res: Response, listingId: string) {
    const listing = await getListingById(db, listingId);
    if (!listing) {
      sendError(res, 404, "NOT_FOUND", "Channel listing not found.");
      return null;
    }
    if (!isOutletInScope(req.outletContext, listing.locationId)) {
      sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
      return null;
    }
    return listing;
  }

  // ── POST /channel-listings/:id/commands ─────────────────────────────────
  router.post(
    "/channel-listings/:id/commands",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER", "KITCHEN_CREW"),
    resolveOutletContext,
    async (req, res) => {
      const idempotencyKey = requireBoundedHeader(req, res, "Idempotency-Key");
      if (idempotencyKey === null) return;

      const id = paramAsString(req.params.id);
      const parsed = genericCommandSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid command payload.", parsed.error.issues);
        return;
      }

      const commandType = parsed.data.command_type as OutboundCommandType;

      // Migration 0036 (finding N2) — CONTEST_CANCELLATION must always create
      // its paired order_dispute row; the generic route has no way to do
      // that, so it refuses the type outright and points callers at the
      // dedicated endpoint (createDispute is the only writer of that type).
      if (commandType === "CONTEST_CANCELLATION") {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "CONTEST_CANCELLATION must be raised via POST /channel-listings/:id/orders/:orderId/contest-cancellation.",
        );
        return;
      }

      const role = normalizeRole(req.user!.role);
      if (role === "KITCHEN_CREW" && !KITCHEN_CREW_ALLOWED_COMMAND_TYPES.has(commandType)) {
        sendError(res, 403, "FORBIDDEN", `KITCHEN_CREW may not send ${commandType}.`);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const command = await enqueueCommand(db, {
          aggregatorAccountId: id,
          orderId: parsed.data.order_id ?? null,
          commandType,
          payload: parsed.data.payload ?? {},
          idempotencyKey,
          ...actorCtx(req),
        });
        res.status(201).json(toCommandResponse(command));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /channel-listings/:id/pause ────────────────────────────────────
  router.post(
    "/channel-listings/:id/pause",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const idempotencyKey = requireBoundedHeader(req, res, "Idempotency-Key");
      if (idempotencyKey === null) return;

      const id = paramAsString(req.params.id);
      const parsed = pauseSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid pause payload.", parsed.error.issues);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const command = await enqueueCommand(db, {
          aggregatorAccountId: id,
          commandType: "PAUSE_STORE",
          payload: parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {},
          idempotencyKey,
          ...actorCtx(req),
        });
        res.status(201).json(toCommandResponse(command));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /channel-listings/:id/resume ───────────────────────────────────
  router.post(
    "/channel-listings/:id/resume",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const idempotencyKey = requireBoundedHeader(req, res, "Idempotency-Key");
      if (idempotencyKey === null) return;

      const id = paramAsString(req.params.id);
      const parsed = resumeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid resume payload.", parsed.error.issues);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const command = await enqueueCommand(db, {
          aggregatorAccountId: id,
          commandType: "RESUME_STORE",
          payload: {},
          idempotencyKey,
          ...actorCtx(req),
        });
        res.status(201).json(toCommandResponse(command));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /channel-listings/:id/items/:itemId/availability ──────────────
  // BRAND_MANAGER added (2026-07-18 RBAC alignment): the merchant-console
  // frontend already offers this control to brand managers; the server is
  // the authority, so it must actually allow the role it's advertised to.
  router.post(
    "/channel-listings/:id/items/:itemId/availability",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER", "BRAND_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const idempotencyKey = requireBoundedHeader(req, res, "Idempotency-Key");
      if (idempotencyKey === null) return;

      const id = paramAsString(req.params.id);
      const itemId = paramAsString(req.params.itemId).trim();
      if (!itemId || itemId.length > MAX_ITEM_ID_LEN) {
        sendError(res, 400, "VALIDATION_ERROR", `itemId is required and must be at most ${MAX_ITEM_ID_LEN} characters.`);
        return;
      }
      const parsed = availabilitySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid availability payload.", parsed.error.issues);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const command = await enqueueCommand(db, {
          aggregatorAccountId: id,
          commandType: "SET_ITEM_AVAILABILITY",
          payload: {
            item_id: itemId,
            available: parsed.data.available,
            ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
            // Migration 0036 (finding F/G) — always ITEM-scoped via this
            // URL shape; OPTION_GROUP scope is generic-route-only.
            ...(parsed.data.unavailable_until !== undefined ? { unavailable_until: parsed.data.unavailable_until } : {}),
          },
          idempotencyKey,
          ...actorCtx(req),
        });
        res.status(201).json(toCommandResponse(command));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── POST /channel-listings/:id/orders/:orderId/contest-cancellation ────
  router.post(
    "/channel-listings/:id/orders/:orderId/contest-cancellation",
    requireAuth,
    requireRole("OWNER", "OUTLET_MANAGER"),
    resolveOutletContext,
    async (req, res) => {
      const idempotencyKey = requireBoundedHeader(req, res, "Idempotency-Key");
      if (idempotencyKey === null) return;

      const id = paramAsString(req.params.id);
      const orderId = paramAsString(req.params.orderId);
      if (!uuidSchema.safeParse(orderId).success) {
        sendError(res, 400, "VALIDATION_ERROR", "orderId must be a valid UUID.");
        return;
      }
      const parsed = contestCancellationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid contest-cancellation payload.", parsed.error.issues);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const dispute = await createDispute(db, {
          aggregatorAccountId: id,
          orderId,
          disputeReason: parsed.data.dispute_reason as (typeof DISPUTE_REASON_CODES)[number],
          evidenceNote: parsed.data.evidence_note ?? null,
          idempotencyKey,
          ...actorCtx(req),
        });
        res.status(201).json(toDisputeResponse(dispute));
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── GET /order-disputes ─────────────────────────────────────────────────
  // Mirrors GET /outbound-commands: the durable, queryable record of every
  // contested cancel-after-accept order (site-visit finding N2 — foodpanda's
  // own app purges order history in ~2 days; ORION does not).
  router.get("/order-disputes", requireAuth, requireRole("OWNER", "OUTLET_MANAGER"), resolveOutletContext, async (req, res) => {
    const parsed = listDisputesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { listing_id, status, limit, offset } = parsed.data;

    if (listing_id) {
      const listing = await loadListingInScope(req, res, listing_id);
      if (!listing) return;
    } else if (req.outletContext && req.outletContext.scope !== "ALL" && req.outletContext.outletIds.length === 0) {
      sendError(res, 403, "FORBIDDEN", "No outlet in your access scope.");
      return;
    }

    const ctx = req.outletContext;
    const allowedLocationIds = listing_id ? undefined : ctx && ctx.scope !== "ALL" ? ctx.outletIds : null;

    const { items, total } = await listDisputes(db, {
      ...(listing_id ? { aggregatorAccountId: listing_id } : {}),
      ...(status ? { status: status as (typeof DISPUTE_STATUSES)[number] } : {}),
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
      allowedLocationIds,
    });
    res.json({ items: items.map(toDisputeResponse), total, limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 });
  });

  // ── PATCH /channel-listings/:id/control-mode ────────────────────────────
  router.patch(
    "/channel-listings/:id/control-mode",
    requireAuth,
    requireRole("OWNER"),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const parsed = controlModeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid control-mode payload.", parsed.error.issues);
        return;
      }

      const listing = await loadListingInScope(req, res, id);
      if (!listing) return;

      try {
        const updated = await updateControlMode(db, {
          aggregatorAccountId: id,
          controlMode: parsed.data.control_mode as "DEVICE" | "SHADOW" | "API",
          ...actorCtx(req),
        });
        res.json({
          id: updated.id,
          control_mode: updated.controlMode,
          api_merchant_id: updated.apiMerchantId,
        });
      } catch (err) {
        handleServiceError(err, res);
      }
    },
  );

  // ── GET /outbound-commands ───────────────────────────────────────────────
  router.get("/outbound-commands", requireAuth, requireRole("OWNER", "OUTLET_MANAGER"), resolveOutletContext, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { listing_id, status, limit, offset } = parsed.data;

    if (listing_id) {
      const listing = await loadListingInScope(req, res, listing_id);
      if (!listing) return;
    } else if (req.outletContext && req.outletContext.scope !== "ALL" && req.outletContext.outletIds.length === 0) {
      sendError(res, 403, "FORBIDDEN", "No outlet in your access scope.");
      return;
    }

    const ctx = req.outletContext;
    const allowedLocationIds = listing_id ? undefined : ctx && ctx.scope !== "ALL" ? ctx.outletIds : null;

    const { items, total } = await listCommands(db, {
      ...(listing_id ? { aggregatorAccountId: listing_id } : {}),
      ...(status ? { status: status as (typeof COMMAND_STATUSES)[number] } : {}),
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
      allowedLocationIds,
    });
    res.json({ items: items.map(toCommandResponse), total, limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 });
  });

  // ── Merchant-console read side ──
  // GET /channel-listings — every listing the caller may act on. Read roles are
  // the merchant-console page set (frontend PAGE_ROLES): OWNER + OUTLET_MANAGER +
  // BRAND_MANAGER + KITCHEN_CREW; ALL-outlet roles see everything, outlet-scoped
  // roles only their outlets' listings (server-side scoping, never the client's).
  router.get("/channel-listings", requireAuth, requireRole("OWNER", "OUTLET_MANAGER", "BRAND_MANAGER", "KITCHEN_CREW"), resolveOutletContext, async (req: Request, res: Response) => {
    try {
      const scope = listScopeLocationIds(req.outletContext);
      res.json(await listChannelListings(db, scope));
    } catch (err) { handleServiceError(err, res); }
  });

  router.get("/channel-listings/:id/items", requireAuth, requireRole("OWNER", "OUTLET_MANAGER", "BRAND_MANAGER", "KITCHEN_CREW"), resolveOutletContext, async (req: Request, res: Response) => {
    try {
      const listing = await getListingById(db, paramAsString(req.params.id));
      if (!listing) return sendError(res, 404, "NOT_FOUND", "Channel listing not found.");
      const scope = listScopeLocationIds(req.outletContext);
      if (scope !== null && (!listing.locationId || !scope.includes(listing.locationId))) {
        return sendError(res, 403, "UNAUTHORIZED", "Listing outside your outlet scope.");
      }
      res.json(await listListingItems(db, listing));
    } catch (err) { handleServiceError(err, res); }
  });

  return router;
}
