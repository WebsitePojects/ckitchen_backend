/**
 * Channel Commercial Terms -- CRUD router (spec section 10, W4 audit gaps B2/B3).
 *
 * channel_commercial_term (src/db/w4-schema.ts, migration 0032) stores
 * effective-dated BASE/MARKETING commission percents per channel listing
 * (aggregator_account). NO hard deletes -- a term is only ever created or
 * "ended" (its effective_to set), so history is always reconstructable
 * (audit trail requirement, same convention as discounts.deactivate
 * soft-delete in src/modules/discounts/routes.ts).
 *
 * RBAC: finance-sensitive data -- same role set as GET /reports/sales
 * (src/modules/reports/routes.ts REPORTS_ROLES = OWNER + ACCOUNTING).
 *
 * Overlap prevention is enforced at the DB layer by the
 * channel_commercial_term_no_overlap EXCLUDE USING gist constraint (two
 * BASE terms, or two MARKETING terms, for the same listing can never have
 * intersecting effective date ranges). POST /commercial-terms catches that
 * constraint violation (Postgres SQLSTATE 23P01, surfaced by PGlite/
 * postgres-js as err.cause.code) and maps it to a typed 409 TERM_OVERLAP --
 * never a raw 500.
 */
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { aggregatorAccounts } from "../../db/schema.js";
import { channelCommercialTermRateTypeEnum, channelCommercialTerms } from "../../db/w4-schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";

const TERM_ROLES = ["OWNER", "ACCOUNTING"] as const;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(DATE_ONLY_RE, "must be a YYYY-MM-DD date.");

/**
 * Percent is a numeric-string (numeric(5,2) column) -- accepted and stored as
 * a string, never a JS float, to avoid binary-float rounding on a money-
 * adjacent field. Values like "25", "25.5", "25.00" are all accepted;
 * normalized to two decimal places on write (Number(v).toFixed(2)).
 */
const percentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "percent must be a numeric string like 25 or 25.50.")
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, {
    message: "percent must be between 0 and 100.",
  });

const createTermSchema = z
  .object({
    aggregator_account_id: z.string().uuid(),
    rate_type: z.enum(channelCommercialTermRateTypeEnum.enumValues),
    percent: percentSchema,
    effective_from: dateOnlySchema,
    effective_to: dateOnlySchema.nullable().optional(),
  })
  .refine(
    (body) => !body.effective_to || body.effective_to >= body.effective_from,
    { message: "effective_to must not be before effective_from.", path: ["effective_to"] },
  );

const endTermSchema = z.object({
  effective_to: dateOnlySchema,
});

/** True for a Postgres exclusion-constraint violation (SQLSTATE 23P01) on our overlap constraint. */
function isOverlapViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const direct = e["code"] === "23P01" && e["constraint"] === "channel_commercial_term_no_overlap";
  if (direct) return true;
  const cause = e["cause"];
  if (cause && typeof cause === "object") {
    const c = cause as Record<string, unknown>;
    return c["code"] === "23P01" && c["constraint"] === "channel_commercial_term_no_overlap";
  }
  return false;
}

export function createCommercialTermsRouter(db: DB): Router {
  const router = Router();

  // GET /commercial-terms?aggregator_account_id=&rate_type=
  router.get("/commercial-terms", requireAuth, requireRole(...TERM_ROLES), async (req, res) => {
    const { aggregator_account_id, rate_type } = req.query as Record<string, string | undefined>;

    if (rate_type && !(channelCommercialTermRateTypeEnum.enumValues as readonly string[]).includes(rate_type)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `rate_type must be one of ${channelCommercialTermRateTypeEnum.enumValues.join(", ")}.`,
      );
      return;
    }

    const conditions = [];
    if (aggregator_account_id) conditions.push(eq(channelCommercialTerms.aggregatorAccountId, aggregator_account_id));
    if (rate_type) {
      conditions.push(
        eq(channelCommercialTerms.rateType, rate_type as (typeof channelCommercialTermRateTypeEnum.enumValues)[number]),
      );
    }

    const rows = conditions.length
      ? await db
          .select()
          .from(channelCommercialTerms)
          .where(and(...conditions))
          .orderBy(desc(channelCommercialTerms.effectiveFrom))
      : await db.select().from(channelCommercialTerms).orderBy(desc(channelCommercialTerms.effectiveFrom));

    res.json(rows);
  });

  // POST /commercial-terms
  router.post("/commercial-terms", requireAuth, requireRole(...TERM_ROLES), async (req, res) => {
    const parsed = createTermSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid commercial term payload.", parsed.error.issues);
      return;
    }
    const body = parsed.data;

    const [account] = await db
      .select({ id: aggregatorAccounts.id })
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.id, body.aggregator_account_id));
    if (!account) {
      sendError(res, 404, "NOT_FOUND", `Aggregator account ${body.aggregator_account_id} not found.`);
      return;
    }

    try {
      const [created] = await db
        .insert(channelCommercialTerms)
        .values({
          aggregatorAccountId: body.aggregator_account_id,
          rateType: body.rate_type,
          percent: Number(body.percent).toFixed(2),
          effectiveFrom: body.effective_from,
          effectiveTo: body.effective_to ?? null,
          createdBy: req.user!.id,
        })
        .returning();

      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: "commercial_term.create",
        description: `Created ${body.rate_type} commercial term ${body.percent} percent for listing ${body.aggregator_account_id} from ${body.effective_from}`,
        entityType: "channel_commercial_term",
        entityId: created.id,
      });
      res.status(201).json(created);
    } catch (err) {
      if (isOverlapViolation(err)) {
        sendError(
          res,
          409,
          "TERM_OVERLAP",
          `An active ${body.rate_type} term already covers part of that effective period for this listing.`,
        );
        return;
      }
      throw err;
    }
  });

  // PATCH /commercial-terms/:id/end
  // Ends (supersedes) a term by setting its effective_to. NEVER a hard
  // delete -- the row and its history stay queryable forever (audit trail).
  // A new term for the period AFTER effective_to is a separate POST.
  router.patch("/commercial-terms/:id/end", requireAuth, requireRole(...TERM_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = endTermSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid end-term payload.", parsed.error.issues);
      return;
    }

    const [existing] = await db.select().from(channelCommercialTerms).where(eq(channelCommercialTerms.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Commercial term not found.");
      return;
    }
    if (parsed.data.effective_to < existing.effectiveFrom) {
      sendError(res, 400, "VALIDATION_ERROR", "effective_to must not be before effective_from.");
      return;
    }

    // Narrowing an existing term range can never create a NEW overlap (it
    // was already non-overlapping at its original, wider range), so this
    // update is never expected to trip the exclusion constraint -- no
    // try/catch needed here (unlike POST).
    const [updated] = await db
      .update(channelCommercialTerms)
      .set({
        effectiveTo: parsed.data.effective_to,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(channelCommercialTerms.id, id))
      .returning();

    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "commercial_term.end",
      description: `Ended ${existing.rateType} commercial term ${existing.id} at ${parsed.data.effective_to}`,
      entityType: "channel_commercial_term",
      entityId: id,
    });
    res.json(updated);
  });

  return router;
}
