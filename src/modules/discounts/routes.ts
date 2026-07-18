/**
 * Discounts / Promos + 3-layer approval workflow — MOTM 2026-07-01 items
 * 2b ("per Product an option to place promo/discount"), 2c ("3 layers of
 * approval: Generally Approved / Supervisor / Admin-Manager"), 7 ("discount
 * per item") + senior/PWD/voucher defaults.
 *
 * NON-REGRESSIVE: this module NEVER writes to `order.total` or touches
 * orders/service.ts. An order's "effective total" is always computed here as
 * `order.total − Σ(APPROVED order_discount.amount)`. An order with zero
 * order_discount rows behaves exactly as it always has.
 *
 * `discount` = reusable catalog (promo/voucher/statutory templates, optionally
 * scoped to a brand and/or a single menu item). `order_discount` = what was
 * actually applied to a specific order, snapshotting type/value as `amount`
 * (a peso figure) at apply time, plus the 3-layer approval state.
 *
 * WALK-IN ONLY (2026-07-08): POST /orders/:id/discounts is restricted to
 * orders whose aggregator is OTHER (walk-in/manual). Real FOODPANDA/GRABFOOD
 * orders carry platform-applied promos in their own payloads — manual entry
 * on top would double-count, so those return 409 AGGREGATOR_ORDER. Existing
 * order_discount rows and the approval endpoints are unaffected.
 *
 * Approval routing (PH defaults — CLIENT TO CONFIRM exact values, see
 * APPROVAL_THRESHOLDS below):
 *   - SENIOR / PWD: statutory. Always AUTO, always auto-APPROVED, always
 *     requires `id_note` (the senior/PWD ID reference) — rejected without it.
 *   - Everything else, by magnitude of the peso amount vs. the order total:
 *       <= AUTO_MAX_PERCENT% (or <= AUTO_MAX_AMOUNT pesos)       → AUTO        ("Generally Approved")
 *       <= SUPERVISOR_MAX_PERCENT% (or <= SUPERVISOR_MAX_AMOUNT) → SUPERVISOR  (needs OUTLET_MANAGER/OWNER)
 *       otherwise                                                 → ADMIN       (needs OWNER)
 */
import { Router } from "express";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  brands,
  discountScopeEnum,
  discountTypeEnum,
  discounts,
  menuItems,
  orderDiscountStatusEnum,
  orderDiscounts,
  orders,
} from "../../db/schema.js";
import { operationalFeatureFlags } from "../../db/enterprise-schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { normalizeRole } from "../auth/roles.js";
import { paramAsString, sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";
import {
  EvidenceValidationError,
  issueSignedUrl,
  readLocalEvidenceFile,
  storeEvidence,
  verifyEvidenceToken,
} from "./evidence.js";

type DiscountType = (typeof discountTypeEnum.enumValues)[number];
type ApprovalLevel = "AUTO" | "SUPERVISOR" | "ADMIN";

const CATALOG_WRITE_ROLES = ["OWNER", "BRAND_MANAGER"] as const;
const APPROVAL_QUEUE_ROLES = ["OWNER", "OUTLET_MANAGER"] as const;
/**
 * W4 (spec §10): who may pull a signed evidence-image URL. "admin/owner/
 * accounting" maps to this repo's role set as OWNER (the admin/owner role)
 * + ACCOUNTING (the finance role that reconciles statutory discounts).
 */
const EVIDENCE_ACCESS_ROLES = ["OWNER", "ACCOUNTING"] as const;

/**
 * W4 (spec §10): `order_discount.evidence_ref` is a private storage key and
 * MUST NEVER appear in an ordinary order/discount response — only the
 * dedicated evidence-url endpoint (which audits every access) may resolve it.
 * Every response builder below that returns an `order_discount` row routes
 * through this so a forgotten column-list edit can't leak it.
 */
function omitEvidenceRef<T extends { evidenceRef?: unknown }>(row: T): Omit<T, "evidenceRef"> {
  const { evidenceRef: _evidenceRef, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// APPROVAL_THRESHOLDS — PH defaults, first cut. CLIENT TO CONFIRM exact
// percentages/peso caps before this ships to production (MOTM 2026-07-01 2c).
// ---------------------------------------------------------------------------
// Double-submit guard for POST /orders/:id/discounts (see the transaction in
// that handler): a double-click or client retry with the exact same payload
// within this window is treated as a replay of the first apply, not a second
// discount. No client-supplied idempotency key exists on this route and the
// mission forbids adding a required one, so the dedupe key is derived from
// the request content itself instead.
const DUPLICATE_LOOKBACK_MS = 30_000;

const APPROVAL_THRESHOLDS = {
  /** Statutory senior-citizen / PWD discount default (RA 9994 / RA 10754 style — client to confirm). */
  SENIOR_PWD_DEFAULT_PERCENT: 20,
  /** percentOfOrder <= this OR amount <= this many pesos → AUTO ("Generally Approved"). */
  AUTO_MAX_PERCENT: 5,
  AUTO_MAX_AMOUNT: 50,
  /** percentOfOrder <= this OR amount <= this many pesos → SUPERVISOR. Above both → ADMIN. */
  SUPERVISOR_MAX_PERCENT: 15,
  SUPERVISOR_MAX_AMOUNT: 200,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W4-5 (spec §10): "discounts.strict_approval" feature flag. Same
// read-only select-by-key pattern as REPORTS_COMMISSION_SNAPSHOT_FLAG in
// src/modules/reports/service.ts and ORDERS_LEGACY_RECIPE_SNAPSHOT_FLAG in
// src/modules/orders/service.ts. Seeded false (drizzle/0032) -- flag-off
// behavior below is byte-identical to the pre-W4-5 3-tier AUTO/SUPERVISOR/
// ADMIN routing. Flag ON: every non-statutory (not SENIOR/PWD) discount is
// routed straight to ADMIN level, always PENDING -- no AUTO tier, no
// SUPERVISOR tier (spec: "no crew auto-approve, no supervisor tier").
// canDecide() below ALREADY restricts ADMIN-level decisions to role
// "OWNER" only -- this codebase's sole admin-class role (V2_ROLES has no
// separate ADMIN role; the v1 alias "SUPER_ADMIN" maps to OWNER via
// ROLE_ALIASES/normalizeRole in auth/roles.ts, same mapping EVIDENCE_ACCESS_
// ROLES' comment above uses for "the admin/owner role"). So reusing the
// existing "ADMIN" approval_level here needs no new enum value and no
// canDecide() change -- OUTLET_MANAGER is already excluded from deciding an
// ADMIN-level row. SENIOR/PWD stays AUTO + evidence-gated (W4-4), untouched.
// ---------------------------------------------------------------------------
export const DISCOUNTS_STRICT_APPROVAL_FLAG = "discounts.strict_approval";

async function isStrictApprovalEnabled(db: DB): Promise<boolean> {
  const [flag] = await db
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, DISCOUNTS_STRICT_APPROVAL_FLAG));
  return !!flag?.enabled;
}

/** Value-range sanity check shared by catalog create/update and ad-hoc apply. */
function valueRangeError(type: DiscountType, value: number): string | null {
  if (type === "PERCENT" || type === "SENIOR" || type === "PWD") {
    if (value < 0 || value > 100) return `value must be between 0 and 100 for ${type} discounts.`;
    return null;
  }
  // FIXED / VOUCHER — peso amount
  if (value <= 0) return `value must be a positive peso amount for ${type} discounts.`;
  return null;
}

/**
 * Computes the peso `amount` off the order's current total. PERCENT/SENIOR/PWD
 * are a percentage of the order total; FIXED/VOUCHER are a flat peso figure.
 * Clamped to [0, orderTotal] so a discount can never push the effective total
 * negative or exceed the order's own subtotal.
 */
function computeAmount(type: DiscountType, value: number, orderTotal: number): number {
  const raw = type === "FIXED" || type === "VOUCHER" ? value : (orderTotal * value) / 100;
  const clamped = Math.min(Math.max(raw, 0), orderTotal);
  return Math.round(clamped * 100) / 100;
}

/**
 * Routes a computed discount to its approval layer. Flag OFF: MOTM 2c legacy
 * 3-tier AUTO/SUPERVISOR/ADMIN. Flag ON (W4-5, spec §10): every non-statutory
 * discount always lands on ADMIN/PENDING -- see DISCOUNTS_STRICT_APPROVAL_FLAG
 * doc above for why reusing "ADMIN" is sufficient. `strict` is read once per
 * request by the caller via isStrictApprovalEnabled(), so this stays sync.
 */
function routeApproval(
  type: DiscountType,
  amount: number,
  percentOfOrder: number,
  strict: boolean,
): { level: ApprovalLevel; autoApprove: boolean } {
  if (type === "SENIOR" || type === "PWD") {
    return { level: "AUTO", autoApprove: true };
  }
  if (strict) {
    // Spec §10: "ALL OTHER variable discounts ... remarks required, PENDING
    // until ADMIN approval -- NO crew auto-approve, NO supervisor tier."
    return { level: "ADMIN", autoApprove: false };
  }
  if (percentOfOrder <= APPROVAL_THRESHOLDS.AUTO_MAX_PERCENT || amount <= APPROVAL_THRESHOLDS.AUTO_MAX_AMOUNT) {
    return { level: "AUTO", autoApprove: true };
  }
  if (
    percentOfOrder <= APPROVAL_THRESHOLDS.SUPERVISOR_MAX_PERCENT ||
    amount <= APPROVAL_THRESHOLDS.SUPERVISOR_MAX_AMOUNT
  ) {
    return { level: "SUPERVISOR", autoApprove: false };
  }
  return { level: "ADMIN", autoApprove: false };
}

/** Who may approve/reject a PENDING request at a given approval level. */
function canDecide(level: ApprovalLevel, role: string | null | undefined): boolean {
  const norm = normalizeRole(role);
  if (!norm) return false;
  if (level === "ADMIN") return norm === "OWNER";
  // SUPERVISOR (and defensively, AUTO rows encountered via manual re-decision).
  return norm === "OWNER" || norm === "OUTLET_MANAGER";
}

/**
 * F3 fix — the set of order ids the caller may act on, by tenancy scope:
 * `null` = ALL-scope (no restriction); otherwise the order ids whose outlet
 * (order → brand.location_id) is in the caller's `outletIds`. Used to
 * outlet-scope the approvals queue + decisions so an ASSIGNED-scope
 * OUTLET_MANAGER can't see or approve another outlet's discounts.
 */
async function ordersInScope(
  db: DB,
  user: { outletScope: string; outletIds: string[] },
): Promise<string[] | null> {
  if (user.outletScope === "ALL") return null;
  const outletIds = user.outletIds ?? [];
  if (outletIds.length === 0) return [];
  const brandRows = await db.select({ id: brands.id }).from(brands).where(inArray(brands.locationId, outletIds));
  const brandIds = brandRows.map((b) => b.id);
  if (brandIds.length === 0) return [];
  const orderRows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.brandId, brandIds));
  return orderRows.map((o) => o.id);
}

interface OrderTotals {
  subtotal: string;
  discount_total: string;
  effective_total: string;
}

/** order.total − Σ(APPROVED order_discount.amount), floored at 0. */
function computeOrderTotals(orderTotal: string, rows: { status: string; amount: string }[]): OrderTotals {
  const subtotal = Number(orderTotal);
  const discountTotal = rows
    .filter((r) => r.status === "APPROVED")
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const effective = Math.max(0, Math.round((subtotal - discountTotal) * 100) / 100);
  return {
    subtotal: subtotal.toFixed(2),
    discount_total: discountTotal.toFixed(2),
    effective_total: effective.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const discountCreateSchema = z.object({
  scope: z.enum(discountScopeEnum.enumValues),
  brand_id: z.string().uuid().optional(),
  menu_item_id: z.string().uuid().optional(),
  name: z.string().min(1),
  type: z.enum(discountTypeEnum.enumValues),
  value: z.number(),
  code: z.string().min(1).optional(),
  vat_exempt: z.boolean().optional(),
});

const discountUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    value: z.number().optional(),
    code: z.string().nullable().optional(),
    vat_exempt: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field is required." });

const applyDiscountSchema = z
  .object({
    discount_id: z.string().uuid().optional(),
    type: z.enum(discountTypeEnum.enumValues).optional(),
    value: z.number().optional(),
    label: z.string().min(1).optional(),
    reason: z.string().min(1, "reason is required"),
    id_note: z.string().min(1).optional(),
    /** W4 (spec §10): base64 data URI, required for SENIOR/PWD, optional otherwise. */
    evidence_image: z.string().min(1).optional(),
  })
  .refine((body) => !!body.discount_id || (!!body.type && body.value !== undefined), {
    message: "Provide either discount_id or {type, value}.",
  });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createDiscountsRouter(db: DB): Router {
  const router = Router();

  // ── Catalog ────────────────────────────────────────────────────────────

  router.get("/discounts", requireAuth, async (req, res) => {
    const { brand_id, menu_item_id, active } = req.query as Record<string, string | undefined>;
    const conditions: ReturnType<typeof eq>[] = [];
    if (brand_id) conditions.push(eq(discounts.brandId, brand_id));
    if (menu_item_id) conditions.push(eq(discounts.menuItemId, menu_item_id));
    if (active === "true") conditions.push(eq(discounts.active, true));
    if (active === "false") conditions.push(eq(discounts.active, false));
    const rows = conditions.length
      ? await db.select().from(discounts).where(and(...conditions))
      : await db.select().from(discounts);
    res.json(rows);
  });

  router.get("/discounts/approvals", requireAuth, requireRole(...APPROVAL_QUEUE_ROLES), async (req, res) => {
    const statusParam = (req.query.status as string | undefined) ?? "PENDING";
    if (!(orderDiscountStatusEnum.enumValues as readonly string[]).includes(statusParam)) {
      sendError(res, 400, "VALIDATION_ERROR", `status must be one of ${orderDiscountStatusEnum.enumValues.join(", ")}.`);
      return;
    }
    const status = statusParam as (typeof orderDiscounts.$inferSelect)["status"];
    // F3: outlet-scope the queue — an ASSIGNED approver only sees their own
    // outlets' requests (ALL-scope owners see everything).
    const scopeIds = await ordersInScope(db, req.user!);
    let rows: (typeof orderDiscounts.$inferSelect)[];
    if (scopeIds === null) {
      rows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.status, status));
    } else if (scopeIds.length === 0) {
      rows = [];
    } else {
      rows = await db
        .select()
        .from(orderDiscounts)
        .where(and(eq(orderDiscounts.status, status), inArray(orderDiscounts.orderId, scopeIds)));
    }
    res.json(rows.map(omitEvidenceRef));
  });

  router.post("/discounts", requireAuth, requireRole(...CATALOG_WRITE_ROLES), async (req, res) => {
    const parsed = discountCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid discount payload.", parsed.error.issues);
      return;
    }
    const d = parsed.data;
    const rangeErr = valueRangeError(d.type, d.value);
    if (rangeErr) {
      sendError(res, 400, "VALIDATION_ERROR", rangeErr);
      return;
    }
    if (d.brand_id) {
      const [brand] = await db.select({ id: brands.id }).from(brands).where(eq(brands.id, d.brand_id));
      if (!brand) {
        sendError(res, 404, "NOT_FOUND", `Brand ${d.brand_id} not found.`);
        return;
      }
    }
    if (d.menu_item_id) {
      const [item] = await db
        .select({ id: menuItems.id, brandId: menuItems.brandId })
        .from(menuItems)
        .where(eq(menuItems.id, d.menu_item_id));
      if (!item) {
        sendError(res, 404, "NOT_FOUND", `Menu item ${d.menu_item_id} not found.`);
        return;
      }
      if (d.brand_id && item.brandId !== d.brand_id) {
        sendError(res, 400, "VALIDATION_ERROR", "menu_item_id does not belong to brand_id.");
        return;
      }
    }

    const [created] = await db
      .insert(discounts)
      .values({
        scope: d.scope,
        brandId: d.brand_id ?? null,
        menuItemId: d.menu_item_id ?? null,
        name: d.name,
        type: d.type,
        value: d.value.toFixed(2),
        code: d.code ?? null,
        vatExempt: d.vat_exempt ?? false,
        active: true,
        createdBy: req.user!.id,
      })
      .returning();

    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "discount.create",
      description: `Created discount "${d.name}" (${d.type} ${d.value})`,
      entityType: "discount",
      entityId: created.id,
    });
    res.status(201).json(created);
  });

  router.patch("/discounts/:id", requireAuth, requireRole(...CATALOG_WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = discountUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid discount payload.", parsed.error.issues);
      return;
    }
    const [existing] = await db.select().from(discounts).where(eq(discounts.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Discount not found.");
      return;
    }
    if (parsed.data.value !== undefined) {
      const rangeErr = valueRangeError(existing.type, parsed.data.value);
      if (rangeErr) {
        sendError(res, 400, "VALIDATION_ERROR", rangeErr);
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.value !== undefined) updates.value = parsed.data.value.toFixed(2);
    if (parsed.data.code !== undefined) updates.code = parsed.data.code;
    if (parsed.data.vat_exempt !== undefined) updates.vatExempt = parsed.data.vat_exempt;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;

    const [updated] = await db.update(discounts).set(updates).where(eq(discounts.id, id)).returning();

    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "discount.update",
      description: `Updated discount "${existing.name}"`,
      entityType: "discount",
      entityId: id,
    });
    res.json(updated);
  });

  router.delete("/discounts/:id", requireAuth, requireRole(...CATALOG_WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const [existing] = await db.select().from(discounts).where(eq(discounts.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Discount not found.");
      return;
    }
    const [updated] = await db
      .update(discounts)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(discounts.id, id))
      .returning();

    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "discount.deactivate",
      description: `Deactivated discount "${existing.name}"`,
      entityType: "discount",
      entityId: id,
    });
    res.json(updated);
  });

  // ── Applying a discount to an order ───────────────────────────────────────

  router.post("/orders/:id/discounts", requireAuth, async (req, res) => {
    const orderId = paramAsString(req.params.id);
    const parsed = applyDiscountSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid apply-discount payload.", parsed.error.issues);
      return;
    }
    const body = parsed.data;

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) {
      sendError(res, 404, "NOT_FOUND", "Order not found.");
      return;
    }
    // A cancelled order is finalized-void — it must never accrue new discounts
    // (found in falsification review 2026-07-08). COMPLETED is intentionally
    // still allowed: a senior/PWD discount is often captured at payment, which
    // can land after the order is marked COMPLETED.
    if (order.status === "CANCELLED") {
      sendError(res, 409, "CONFLICT", "Cannot apply a discount to a cancelled order.");
      return;
    }
    // Manual discounts are WALK-IN ONLY (2026-07-08): real FOODPANDA/GRABFOOD
    // orders carry platform-applied promos in their payloads — manually adding
    // one here would double-count the discount. Existing order_discount rows
    // and the approval flow are untouched; only NEW applications are blocked.
    if (order.aggregator !== "OTHER") {
      sendError(
        res,
        409,
        "AGGREGATOR_ORDER",
        "Discounts for aggregator orders come from the platform payload; manual discounts are walk-in only.",
      );
      return;
    }

    // W4-5 (spec §10): read once per request; see DISCOUNTS_STRICT_APPROVAL_FLAG.
    const strict = await isStrictApprovalEnabled(db);

    let type: DiscountType;
    let value: number;
    let label: string;
    let discountId: string | null = null;

    if (body.discount_id) {
      const [catalog] = await db.select().from(discounts).where(eq(discounts.id, body.discount_id));
      if (!catalog) {
        sendError(res, 404, "NOT_FOUND", `Discount ${body.discount_id} not found.`);
        return;
      }
      if (!catalog.active) {
        sendError(res, 409, "CONFLICT", `Discount "${catalog.name}" is not active.`);
        return;
      }
      type = catalog.type;
      value = Number(catalog.value);
      label = body.label ?? catalog.name;
      discountId = catalog.id;
    } else {
      // Schema refine() guarantees type + value are both present here.
      type = body.type!;
      value = body.value!;
      label = body.label ?? type;
      const rangeErr = valueRangeError(type, value);
      if (rangeErr) {
        sendError(res, 400, "VALIDATION_ERROR", rangeErr);
        return;
      }
    }

    // W4-5 (spec §10) strict mode: non-statutory PERCENT discounts must be
    // 10-30%. Interpretation note (no spec text covers FIXED/VOUCHER
    // explicitly -- "10-30% only" reads as a percentage-specific rule): a
    // peso FIXED/VOUCHER discount has no percent to range-check here, so it
    // is left to valueRangeError's existing positive-amount check and simply
    // falls through to routeApproval's strict branch (ADMIN/PENDING, remarks
    // already required unconditionally by applyDiscountSchema above) -- same
    // destination an in-range PERCENT reaches. SENIOR/PWD never reaches this
    // branch (type is never "PERCENT" for those).
    if (strict && type === "PERCENT" && (value < 10 || value > 30)) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "Non-statutory PERCENT discounts must be between 10 and 30 percent (spec §10, strict approval mode).",
      );
      return;
    }

    // Statutory: SENIOR/PWD always require the ID capture note.
    if ((type === "SENIOR" || type === "PWD") && !body.id_note?.trim()) {
      sendError(res, 400, "VALIDATION_ERROR", `id_note is required for ${type} discounts.`);
      return;
    }

    // W4 (spec §10): SENIOR/PWD statutory discounts also require a private
    // ID-image evidence upload — rejected without it. Non-statutory discounts
    // may optionally attach evidence too (e.g. a manager-approved variable
    // discount), so evidence_image is stored whenever it is provided.
    if ((type === "SENIOR" || type === "PWD") && !body.evidence_image) {
      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        `evidence_image is required for ${type} discounts.`,
        { reason: "EVIDENCE_REQUIRED" },
      );
      return;
    }
    let evidenceRef: string | null = null;
    if (body.evidence_image) {
      try {
        const stored = await storeEvidence({ dataUrl: body.evidence_image });
        evidenceRef = stored.evidenceRef;
      } catch (err) {
        if (err instanceof EvidenceValidationError) {
          sendError(res, 400, "VALIDATION_ERROR", err.message, { reason: err.code });
          return;
        }
        throw err;
      }
    }

    const orderTotal = Number(order.total);
    const amount = computeAmount(type, value, orderTotal);
    const percentOfOrder = orderTotal > 0 ? (amount / orderTotal) * 100 : 100;
    const { level, autoApprove } = routeApproval(type, amount, percentOfOrder, strict);
    const status = autoApprove ? "APPROVED" : "PENDING";
    const now = new Date();
    const amountStr = amount.toFixed(2);

    // Double-submit guard: lock the order row FOR UPDATE so a truly
    // concurrent duplicate serializes behind this request, then look back
    // for an order_discount this same actor already applied to this order
    // with the exact same content within DUPLICATE_LOOKBACK_MS. There is no
    // client-supplied idempotency key on this route (and the mission forbids
    // requiring one), so a plain unconditional INSERT would otherwise apply
    // the discount twice on a double-click/retry, doubling the peso amount
    // subtracted from the order's effective total.
    let replay = false;
    let row!: typeof orderDiscounts.$inferSelect;
    await db.transaction(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");

      const since = new Date(Date.now() - DUPLICATE_LOOKBACK_MS);
      const candidates = await tx
        .select()
        .from(orderDiscounts)
        .where(
          and(
            eq(orderDiscounts.orderId, orderId),
            eq(orderDiscounts.requestedBy, req.user!.id),
            eq(orderDiscounts.type, type),
            eq(orderDiscounts.label, label),
            eq(orderDiscounts.reason, body.reason),
            eq(orderDiscounts.amount, amountStr),
            gte(orderDiscounts.createdAt, since),
            discountId ? eq(orderDiscounts.discountId, discountId) : isNull(orderDiscounts.discountId),
            body.id_note ? eq(orderDiscounts.idNote, body.id_note) : isNull(orderDiscounts.idNote),
          ),
        )
        .orderBy(desc(orderDiscounts.createdAt))
        .limit(1);

      if (candidates[0]) {
        row = candidates[0];
        replay = true;
        return;
      }

      [row] = await tx
        .insert(orderDiscounts)
        .values({
          orderId,
          discountId,
          type,
          label,
          amount: amountStr,
          approvalLevel: level,
          status,
          reason: body.reason,
          idNote: body.id_note ?? null,
          evidenceRef,
          requestedBy: req.user!.id,
          approvedBy: autoApprove ? req.user!.id : null,
          approvedAt: autoApprove ? now : null,
        })
        .returning();
    });

    if (!replay) {
      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: "order_discount.apply",
        description: `Applied "${label}" (${type}) to order ${orderId} — ₱${amountStr}, level ${level}, status ${status}`,
        entityType: "order_discount",
        entityId: row.id,
      });
    }

    const allRows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
    const totals = computeOrderTotals(order.total, allRows);
    res.status(201).json({ ...omitEvidenceRef(row), ...totals });
  });

  router.get("/orders/:id/discounts", requireAuth, async (req, res) => {
    const orderId = paramAsString(req.params.id);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) {
      sendError(res, 404, "NOT_FOUND", "Order not found.");
      return;
    }
    const rows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
    const totals = computeOrderTotals(order.total, rows);
    res.json({ discounts: rows.map(omitEvidenceRef), ...totals });
  });

  // ── Approval queue + decisions ─────────────────────────────────────────

  function decide(action: "approve" | "reject") {
    router.post(`/order-discounts/:id/${action}`, requireAuth, async (req, res) => {
      const id = paramAsString(req.params.id);
      const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, id));
      if (!row) {
        sendError(res, 404, "NOT_FOUND", "Discount request not found.");
        return;
      }
      if (row.status !== "PENDING") {
        sendError(res, 409, "CONFLICT", `Discount request is ${row.status}; expected PENDING.`);
        return;
      }
      if (!canDecide(row.approvalLevel, req.user!.role)) {
        sendError(res, 403, "FORBIDDEN", `Role not permitted to ${action} a ${row.approvalLevel}-level discount.`);
        return;
      }
      // F3: even a permitted role may only decide discounts for orders in their
      // own outlet scope (ALL-scope owners pass; ASSIGNED managers are pinned).
      const scopeIds = await ordersInScope(db, req.user!);
      if (scopeIds !== null && !scopeIds.includes(row.orderId)) {
        sendError(res, 403, "FORBIDDEN", "This discount belongs to an outlet outside your access scope.");
        return;
      }

      const newStatus = action === "approve" ? "APPROVED" : "REJECTED";
      // Double-submit guard: conditional UPDATE on the PENDING status just
      // re-verified above (which was read outside any lock, so two
      // concurrent approve/reject calls could otherwise both pass it and
      // both write). `AND status = 'PENDING'` makes only the first writer
      // win; a losing concurrent/replayed request gets zero rows back.
      const [updated] = await db
        .update(orderDiscounts)
        .set({
          status: newStatus,
          approvedBy: req.user!.id,
          approvedAt: new Date(),
        })
        .where(and(eq(orderDiscounts.id, id), eq(orderDiscounts.status, "PENDING")))
        .returning();
      if (!updated) {
        sendError(res, 409, "CONFLICT", "Discount request was already decided by a concurrent request.");
        return;
      }

      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: `order_discount.${action}`,
        description: `${action === "approve" ? "Approved" : "Rejected"} order_discount ${id} (${row.approvalLevel})`,
        entityType: "order_discount",
        entityId: id,
      });

      const [order] = await db.select().from(orders).where(eq(orders.id, row.orderId));
      const allRows = await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, row.orderId));
      const totals = order ? computeOrderTotals(order.total, allRows) : undefined;
      res.json({ ...omitEvidenceRef(updated), ...totals });
    });
  }

  decide("approve");
  decide("reject");

  // ── Evidence access (W4 spec §10) ──────────────────────────────────────

  // Admin/owner/accounting only: mints a short-lived signed URL for a
  // discount's private evidence image and durably audits the access
  // (discount_evidence_access_log) in the same DB transaction as issuance.
  router.get(
    "/order-discounts/:id/evidence-url",
    requireAuth,
    requireRole(...EVIDENCE_ACCESS_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, id));
      if (!row) {
        sendError(res, 404, "NOT_FOUND", "Discount request not found.");
        return;
      }
      if (!row.evidenceRef) {
        sendError(res, 404, "NOT_FOUND", "No evidence is attached to this discount.");
        return;
      }
      const rawPurpose = req.query.purpose;
      const purpose = typeof rawPurpose === "string" && rawPurpose.trim() ? rawPurpose.trim() : "review";
      try {
        const { url, expiresAt } = await issueSignedUrl(db, {
          orderDiscountId: row.id,
          evidenceRef: row.evidenceRef,
          accessedBy: req.user!.id,
          purpose,
        });

        void audit(db, {
          actorUserId: req.user!.id,
          actorName: req.user!.name ?? null,
          sessionId: req.user!.sessionId ?? null,
          action: "order_discount.evidence_access",
          description: `Issued a signed evidence URL for order_discount ${id} (purpose: ${purpose})`,
          entityType: "order_discount",
          entityId: id,
        });

        res.json({ url, expires_at: expiresAt.toISOString() });
      } catch {
        sendError(res, 500, "EVIDENCE_ERROR", "Failed to issue an evidence URL.");
      }
    },
  );

  // Unauthenticated by design — the signed, short-lived, unguessable token
  // itself IS the authorization (LocalFsProvider dev/test path only; a real
  // Cloudinary-configured deployment never routes through here). Every
  // token was minted by issueSignedUrl(), which already wrote the audit
  // row at issuance time — this route only ever streams bytes for a token
  // that passed that gate.
  router.get("/discount-evidence/:token", async (req, res) => {
    const token = paramAsString(req.params.token);
    const result = verifyEvidenceToken(token);
    if (!result.ok) {
      if (result.reason === "expired") {
        res.status(410).end();
      } else {
        res.status(404).end();
      }
      return;
    }
    const file = await readLocalEvidenceFile(result.ref);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Cache-Control", "no-store");
    res.send(file.buffer);
  });

  return router;
}

/**
 * Idempotent PH-default catalog seed (senior citizen + PWD, order-scoped,
 * 20% VAT-exempt). Called from db/seed.ts with the seeded OWNER's user id as
 * `created_by`. Matched by name so re-running never duplicates.
 */
export async function seedDefaultDiscounts(db: DB, createdByUserId: string): Promise<void> {
  const defaults: Array<{ name: string; type: DiscountType }> = [
    { name: "Senior Citizen", type: "SENIOR" },
    { name: "PWD", type: "PWD" },
  ];
  for (const d of defaults) {
    const [existing] = await db.select({ id: discounts.id }).from(discounts).where(eq(discounts.name, d.name));
    if (existing) continue;
    await db.insert(discounts).values({
      scope: "ORDER",
      name: d.name,
      type: d.type,
      value: APPROVAL_THRESHOLDS.SENIOR_PWD_DEFAULT_PERCENT.toFixed(2),
      vatExempt: true,
      active: true,
      createdBy: createdByUserId,
    });
  }
}
