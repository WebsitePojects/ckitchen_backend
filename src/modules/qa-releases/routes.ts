/**
 * QA Release Router (D35-D46 §5 — a reusable outlet return may remain
 * quarantined until a separate QA Release moves it to HQ_MAIN).
 *
 * Endpoints (all under /api/v1/qa-releases, all requireAuth):
 *   GET  /qa-releases                — bounded/paginated list (search, status)
 *   GET  /qa-releases/:id            — single release with lines
 *   POST /qa-releases                — create DRAFT
 *   PATCH /qa-releases/:id           — edit DRAFT (remarks/lines)
 *   POST /qa-releases/:id/submit
 *   POST /qa-releases/:id/approve
 *   POST /qa-releases/:id/release    — requires Idempotency-Key + X-Correlation-ID
 *   POST /qa-releases/:id/cancel
 *
 * The authenticated actor (id + session) is read exclusively from `req.user`
 * (set by requireAuth) — every write body schema below is `.strict()` and
 * deliberately has no actor/session field, so a client cannot smuggle
 * `actorUserId`/`sessionId` in through the JSON body; Zod rejects any unknown
 * key with 400 before the handler runs.
 *
 * RBAC: QA Release is entirely HQ-custody (QUARANTINE -> HQ_MAIN, both
 * HQ-only warehouse purposes), so the service layer restricts every
 * operation to QA_RELEASE_ROLES/QA_RELEASE_APPROVE_ROLES (policies.ts:
 * OWNER, WAREHOUSE_MAIN) — the router adds no further role gate of its own,
 * matching every other module's convention of leaving RBAC to the service's
 * own authorizeActor().
 *
 * No realtime emission: `QaRelease`/`QaReleaseWithLines` (types.ts) carry no
 * `locationId` — the release's own HQ location is resolved server-side
 * inside the service (resolveHqTopology()) and never returned to the
 * caller — so there is no location room this router can target without a
 * direct warehouse->location DB lookup of its own, which would violate the
 * "no direct DB access beyond existing route-file conventions" constraint.
 * This mirrors src/modules/production/routes.ts's identical precedent for
 * BOM routes ("BomHeader/BomVersion carry no locationId ... so BOM routes
 * never call hub.emitToLocation").
 */
import { Router, type Response } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { qaReleaseStatusEnum } from "../../db/transfer-orders-schema.js";
import { requireAuth } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";
import { QA_RELEASE_MAX_LINES, QA_RELEASE_MIN_LINES } from "./policies.js";
import { QaReleaseError } from "./errors.js";
import { StockPostingError } from "../stock/errors.js";
import { createQaReleaseService } from "./service.js";
import type { QaReleaseLineInput } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_UOM_LEN = 32;
const MAX_REMARKS_LEN = 500;
const MAX_SEARCH_LEN = 200;
const MAX_HEADER_LEN = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

// Bounded exact decimal string: up to 14 whole digits + up to 6 fraction
// digits, matching the numeric(20,6) columns these ultimately validate
// against (mirrors src/modules/transfers/routes.ts's DECIMAL_RE).
const DECIMAL_RE = /^\d{1,14}(\.\d{1,6})?$/;

const STATUSES = qaReleaseStatusEnum.enumValues;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const lineSchema = z
  .object({
    source_return_receipt_line_id: uuidSchema,
    entered_quantity: z.string().regex(DECIMAL_RE, "entered_quantity must be a bounded decimal string."),
    entered_uom: z.string().trim().min(1).max(MAX_UOM_LEN),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(QA_RELEASE_MIN_LINES).max(QA_RELEASE_MAX_LINES),
  })
  .strict();

const updateSchema = z
  .object({
    version: z.number().int().nonnegative(),
    remarks: z.string().max(MAX_REMARKS_LEN).nullable().optional(),
    lines: z.array(lineSchema).min(QA_RELEASE_MIN_LINES).max(QA_RELEASE_MAX_LINES).optional(),
  })
  .strict();

const versionSchema = z.object({ version: z.number().int().nonnegative() }).strict();

const cancelSchema = z
  .object({
    version: z.number().int().nonnegative(),
    cancel_reason: z.string().trim().min(1).max(MAX_REMARKS_LEN),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum(STATUSES as [string, ...string[]]).optional(),
  search: z.string().trim().max(MAX_SEARCH_LEN).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

function toServiceLine(line: z.infer<typeof lineSchema>): QaReleaseLineInput {
  return {
    sourceReturnReceiptLineId: line.source_return_receipt_line_id,
    enteredQuantity: line.entered_quantity,
    enteredUom: line.entered_uom,
    remarks: line.remarks ?? null,
  };
}

// ---------------------------------------------------------------------------
// Error -> HTTP response mapping (no SQL/internal leakage)
// ---------------------------------------------------------------------------

function handleServiceError(err: unknown, res: Response): void {
  if (err instanceof QaReleaseError || err instanceof StockPostingError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[qa-releases] unhandled error", err);
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

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createQaReleasesRouter(db: DB, _hub: RealtimeHub): Router {
  const router = Router();
  const service = createQaReleaseService(db);

  function actorCtx(req: { user?: { id: string; sessionId?: string } }) {
    return { actorUserId: req.user!.id, sessionId: req.user!.sessionId ?? null };
  }

  // ── GET /qa-releases ─────────────────────────────────────────────────────
  router.get("/qa-releases", requireAuth, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { status, search, limit, offset } = parsed.data;
    const listInput = {
      status: status as (typeof STATUSES)[number] | undefined,
      search,
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    };

    try {
      const ctx = actorCtx(req);
      const [items, total] = await Promise.all([service.list(ctx, listInput), service.count(ctx, listInput)]);
      res.json({ items, total, limit: listInput.limit, offset: listInput.offset });
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── GET /qa-releases/:id ─────────────────────────────────────────────────
  router.get("/qa-releases/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    try {
      const release = await service.get(actorCtx(req), { releaseId: id });
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /qa-releases ────────────────────────────────────────────────────
  router.post("/qa-releases", requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid QA release payload.", parsed.error.issues);
      return;
    }
    const { remarks, lines } = parsed.data;
    try {
      const release = await service.createDraft(actorCtx(req), {
        remarks: remarks ?? null,
        lines: lines.map(toServiceLine),
      });
      res.status(201).json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── PATCH /qa-releases/:id ───────────────────────────────────────────────
  router.patch("/qa-releases/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid QA release update payload.", parsed.error.issues);
      return;
    }
    const { version, lines } = parsed.data;
    const updateInput: {
      releaseId: string;
      version: number;
      remarks?: string | null;
      lines?: QaReleaseLineInput[];
    } = { releaseId: id, version };
    if ("remarks" in parsed.data) {
      updateInput.remarks = parsed.data.remarks ?? null;
    }
    if (lines) {
      updateInput.lines = lines.map(toServiceLine);
    }

    try {
      const release = await service.updateDraft(actorCtx(req), updateInput);
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /qa-releases/:id/submit ─────────────────────────────────────────
  router.post("/qa-releases/:id/submit", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid submit payload.", parsed.error.issues);
      return;
    }
    try {
      const release = await service.submit(actorCtx(req), { releaseId: id, version: parsed.data.version });
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /qa-releases/:id/approve ────────────────────────────────────────
  router.post("/qa-releases/:id/approve", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid approve payload.", parsed.error.issues);
      return;
    }
    try {
      const release = await service.approve(actorCtx(req), { releaseId: id, version: parsed.data.version });
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /qa-releases/:id/release ────────────────────────────────────────
  // Requires bounded Idempotency-Key + X-Correlation-ID headers (contract-level
  // replay guard on top of the service's own document-derived idempotency —
  // see releaseQaRelease() in ./service.ts).
  router.post("/qa-releases/:id/release", requireAuth, async (req, res) => {
    if (!requireBoundedHeader(req, res, "Idempotency-Key")) return;
    if (!requireBoundedHeader(req, res, "X-Correlation-ID")) return;

    const id = paramAsString(req.params.id);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid release payload.", parsed.error.issues);
      return;
    }
    try {
      const release = await service.release(actorCtx(req), { releaseId: id, version: parsed.data.version });
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  // ── POST /qa-releases/:id/cancel ─────────────────────────────────────────
  router.post("/qa-releases/:id/cancel", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = cancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid cancel payload.", parsed.error.issues);
      return;
    }
    try {
      const release = await service.cancel(actorCtx(req), {
        releaseId: id,
        version: parsed.data.version,
        cancelReason: parsed.data.cancel_reason,
      });
      res.json(release);
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
