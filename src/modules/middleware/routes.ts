/**
 * Middleware webhook intake + admin router (spec §11).
 *
 * Endpoints (mounted under /api/v1/middleware):
 *   POST /middleware/webhook               — UNAUTHENTICATED (no JWT): the
 *                                             caller is a middleware
 *                                             provider, authenticated by
 *                                             HMAC signature instead. Reads
 *                                             the raw request body (app.ts
 *                                             scopes a raw-body parser to
 *                                             this exact path before the
 *                                             global express.json()).
 *   GET  /middleware/events                — admin list, state filter.
 *   POST /middleware/events/:id/reprocess  — admin manual reprocess.
 *
 * `intake -> ack` and `processing` are deliberately decoupled (spec §11:
 * "Processing is asynchronous ... and replayable."): the webhook handler
 * always acks based on the INTAKE outcome (CREATED/DUPLICATE/QUARANTINED),
 * then best-effort fires processEvent() without awaiting it — a slow or
 * failing ingestOrder call never blocks or changes the ack the provider
 * already received. Tests exercise processing deterministically via the
 * reprocess endpoint (or by importing processEvent directly) rather than
 * racing this fire-and-forget call.
 */
import { Router } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import type { ProviderEvent } from "../../db/middleware-schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import { getMiddlewareAdapter } from "./adapter.js";
import { loadDeliverectHmacSecrets } from "./deliverect-secrets.js";
import { MiddlewareError } from "./errors.js";
import { processEvent } from "./processor.js";
import { loadKnownKeyIds, loadWebhookSecrets } from "./secrets.js";
import { isTimestampFresh } from "./signature.js";
import { getEventById, intakeEvent, listEvents, sha256Hex } from "./service.js";
import type { WebhookHeaders, WebhookSecrets } from "./types.js";

/**
 * Providers whose HMAC scheme has no timestamp/key-id concept (currently
 * just Deliverect — see deliverect-adapter.ts's file header). For these,
 * skip the generic X-Middleware-Timestamp / X-Middleware-Key-Id / known-key-id
 * / timestamp-freshness checks below (they're ORION's own DUMMY-provider
 * scheme, not a Deliverect requirement) and read the provider's own signature
 * header directly.
 */
const RAW_SIGNATURE_HEADER_BY_PROVIDER: Record<string, string> = {
  // CONFIRM EXACT HEADER NAME WITH DELIVERECT STAGING (see deliverect-adapter.ts).
  DELIVERECT: "X-Deliverect-Hmac-Sha256",
};

const MAX_HEADER_LEN = 200;
const DEFAULT_TIMESTAMP_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // matches app.ts's express.raw({ limit: "2mb" }) for this route

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;

const PROVIDER_EVENT_STATES = [
  "PENDING",
  "PROCESSING",
  "PROCESSED",
  "MAPPING_REQUIRED",
  "WAITING_DEPENDENCY",
  "FAILED",
  "QUARANTINED",
] as const;

const listQuerySchema = z.object({
  state: z.enum(PROVIDER_EVENT_STATES).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().max(MAX_OFFSET).optional(),
});

function toEventResponse(event: ProviderEvent) {
  return {
    id: event.id,
    provider: event.provider,
    provider_event_id: event.providerEventId,
    kind: event.kind,
    state: event.state,
    aggregator: event.aggregator,
    merchant_ref: event.merchantRef,
    external_ref: event.externalRef,
    occurred_at: event.occurredAt,
    received_at: event.receivedAt,
    order_id: event.orderId,
    attempts: event.attempts,
    last_error: event.lastError,
    next_attempt_at: event.nextAttemptAt,
    processed_at: event.processedAt,
  };
}

function handleServiceError(err: unknown, res: import("express").Response): void {
  if (err instanceof MiddlewareError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  console.error("[middleware] unhandled error", err);
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

function requireBoundedHeader(req: { header(name: string): string | undefined }, res: import("express").Response, name: string): string | null {
  const raw = req.header(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > MAX_HEADER_LEN) {
    sendError(res, 400, "MISSING_HEADER", `${name} header is required and must be at most ${MAX_HEADER_LEN} characters.`);
    return null;
  }
  return value;
}

export function createMiddlewareRouter(db: DB): Router {
  const router = Router();

  // ── POST /middleware/webhook ────────────────────────────────────────────
  router.post("/middleware/webhook", async (req, res) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      sendError(res, 400, "EMPTY_BODY", "Webhook body must be non-empty raw bytes.");
      return;
    }
    if (rawBody.length > MAX_BODY_BYTES) {
      sendError(res, 400, "VALIDATION", `Webhook body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
      return;
    }

    const providerHeader = req.header("X-Middleware-Provider");
    const provider = typeof providerHeader === "string" && providerHeader.trim() ? providerHeader.trim() : "DUMMY";

    const adapter = getMiddlewareAdapter(provider);
    if (!adapter) {
      sendError(res, 400, "VALIDATION", `Unknown middleware provider "${provider}".`);
      return;
    }

    const rawSignatureHeader = RAW_SIGNATURE_HEADER_BY_PROVIDER[provider];
    let headers: WebhookHeaders;
    let secrets: WebhookSecrets;

    if (rawSignatureHeader) {
      // Deliverect-style scheme: no X-Middleware-Timestamp/Key-Id, no known-
      // key-id allowlist, no timestamp-freshness window — the provider's own
      // HMAC header is the entire signature contract (see adapter.ts's file
      // header). `timestamp`/`keyId` are unused placeholders for this branch.
      const signature = requireBoundedHeader(req, res, rawSignatureHeader);
      if (signature === null) return;

      const deliverectSecrets = loadDeliverectHmacSecrets();
      if (!deliverectSecrets) {
        // Fail closed: unconfigured secret is a rejection, never an "accept
        // unsigned" fallback (idempotency-concurrency.md rule 14).
        console.error(`[middleware] ${provider} webhook received but its HMAC secret is not configured`);
        sendError(res, 503, "FEATURE_DISABLED", `${provider} is not configured — paste its HMAC secret into env.`);
        return;
      }
      headers = { timestamp: "", keyId: "", signature };
      secrets = deliverectSecrets;
    } else {
      const timestamp = requireBoundedHeader(req, res, "X-Middleware-Timestamp");
      if (timestamp === null) return;
      const keyId = requireBoundedHeader(req, res, "X-Middleware-Key-Id");
      if (keyId === null) return;
      const signature = requireBoundedHeader(req, res, "X-Middleware-Signature");
      if (signature === null) return;

      let knownKeyIds: ReadonlySet<string>;
      let genericSecrets: ReturnType<typeof loadWebhookSecrets>;
      try {
        knownKeyIds = loadKnownKeyIds();
        genericSecrets = loadWebhookSecrets();
      } catch (err) {
        console.error("[middleware] secret configuration error", err);
        sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
        return;
      }

      // Order matters (spec §11): key id, then timestamp freshness, then
      // signature — ALL evaluated against the exact raw bytes, before any
      // JSON parsing is attempted.
      if (!knownKeyIds.has(keyId)) {
        sendError(res, 401, "UNKNOWN_KEY_ID", "Unrecognized signing key id.");
        return;
      }
      if (!isTimestampFresh(timestamp, DEFAULT_TIMESTAMP_SKEW_SECONDS)) {
        sendError(res, 401, "INVALID_TIMESTAMP", "Webhook timestamp is outside the accepted skew window.");
        return;
      }
      headers = { timestamp, keyId, signature };
      secrets = genericSecrets;
    }

    if (!adapter.verifySignature(rawBody, headers, secrets)) {
      sendError(res, 401, "INVALID_SIGNATURE", "Webhook signature verification failed.");
      return;
    }

    let normalized;
    try {
      normalized = adapter.parse(rawBody);
    } catch (err) {
      handleServiceError(err, res);
      return;
    }

    const rawHash = sha256Hex(rawBody);
    const { event, outcome } = await intakeEvent(db, { provider, normalized, rawHash, keyId: headers.keyId });

    const statusByOutcome = { CREATED: 202, DUPLICATE: 200, QUARANTINED: 200 } as const;
    res.status(statusByOutcome[outcome]).json({ status: outcome, event: toEventResponse(event) });

    if (outcome === "CREATED") {
      // Fire-and-forget: the ack above already reflects the INTAKE result,
      // independent of whether processing succeeds, fails, or is disabled.
      void processEvent(db, event.id).catch((err) => {
        console.error("[middleware] post-commit processing failed", err);
      });
    }
  });

  // ── GET /middleware/events ──────────────────────────────────────────────
  router.get("/middleware/events", requireAuth, requireRole("OWNER", "WAREHOUSE_MAIN"), async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid query parameters.", parsed.error.issues);
      return;
    }
    const { state, limit, offset } = parsed.data;
    const { items, total } = await listEvents(db, { state, limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 });
    res.json({ items: items.map(toEventResponse), total, limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 });
  });

  // ── POST /middleware/events/:id/reprocess ───────────────────────────────
  router.post("/middleware/events/:id/reprocess", requireAuth, requireRole("OWNER", "WAREHOUSE_MAIN"), async (req, res) => {
    const id = paramAsString(req.params.id);
    const existing = await getEventById(db, id);
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Provider event not found.");
      return;
    }
    try {
      const event = await processEvent(db, id, { force: true });
      res.json(toEventResponse(event));
    } catch (err) {
      handleServiceError(err, res);
    }
  });

  return router;
}
