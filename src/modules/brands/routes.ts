import { Router } from "express";
import { and, asc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  aggregatorAccounts,
  aggregatorEnum,
  availabilityEnum,
  brandActivityLog,
  brandOutlet,
  brands,
  discounts,
  listingMappingStatusEnum,
  locations,
  menuItems,
  orderItems,
  orders,
  recipeLines,
  userBrands,
} from "../../db/schema.js";
import { menuOptionGroups } from "../../db/outbound-schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { resolveRequestLocationId } from "../auth/outlet-scope.js";
import { audit } from "../ems/audit.js";
import { paramAsString, sendError } from "../http-errors.js";

const WRITE_ROLES = ["OWNER", "BRAND_MANAGER"] as const;
/** Deploying a brand to an outlet / deactivating it is an OWNER (HQ) action. */
const DEPLOY_ROLES = ["OWNER"] as const;

// Outlet-scoping leak fix (M6): additive-only filter for GET /brands. Omitted =
// unchanged platform-wide behavior (Merchant Management needs the full list);
// supplied = only brands whose HOME outlet is location_id OR that have an
// active brand_outlet deployment there (D30 many-to-many).
const brandListQuerySchema = z.object({
  location_id: z.string().uuid().optional(),
});

const createBrandSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  logo_url: z.string().optional(),
  sales_perf_id: z.string().optional(),
  // Outlet targeting (D22): ALL-scope users may name any outlet; ASSIGNED users
  // are membership-checked. Omitted → the deployment's default (first) outlet.
  location_id: z.string().uuid().optional(),
});

const deployOutletSchema = z.object({
  location_id: z.string().uuid(),
});

const updateBrandSchema = z
  .object({
    name: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
    logo_url: z.string().optional(),
    sales_perf_id: z.string().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

const createAccountSchema = z.object({
  aggregator: z.enum(aggregatorEnum.enumValues),
  external_merchant_id: z.string().min(1),
  credential_ref: z.string().min(1),
  // Physical outlet this channel listing belongs to (D39/business-rules #7).
  // Optional + backward compatible: omitted = null, unchanged from before.
  location_id: z.string().uuid().optional(),
});

const updateAccountSchema = z
  .object({
    // Closest "display" field the table has (there is no separate merchant_name
    // column — external_merchant_id IS the merchant-facing listing identifier).
    external_merchant_id: z.string().min(1).optional(),
    commission_rate: z.union([z.string().min(1), z.number()]).nullable().optional(),
    // Maps to aggregator_account.mapping_status (RESOLVED | MAPPING_REQUIRED |
    // DISABLED) — the field that actually reads as a listing's "status".
    status: z.enum(listingMappingStatusEnum.enumValues).optional(),
    location_id: z.string().uuid().nullable().optional(),
    // credential_ref/credentialRef are deliberately NOT accepted here (security.md).
  })
  .refine((body) => Object.keys(body).some((k) => body[k as keyof typeof body] !== undefined), {
    message: "At least one field is required.",
  });

const bulkAvailabilitySchema = z.object({
  availability: z.enum(availabilityEnum.enumValues),
});

/** Strips `credentialRef` before an aggregator account ever reaches an API response (security.md). */
function toPublicAccount(account: typeof aggregatorAccounts.$inferSelect) {
  const { credentialRef, ...publicAccount } = account;
  return publicAccount;
}

/**
 * Shared location_id validation for creating/patching a channel listing
 * (D39): the outlet must exist, AND the brand must actually be deployed
 * there (an active brand_outlet row) — otherwise a listing could be pinned
 * to an outlet the brand never operates in, silently breaking order
 * routing/stock/RBAC (business-rules #7).
 */
async function assertBrandDeployedAtLocation(
  db: DB,
  brandId: string,
  locationId: string,
): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  const [location] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId));
  if (!location) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Outlet not found." };
  }

  const [deployment] = await db
    .select({ brandId: brandOutlet.brandId })
    .from(brandOutlet)
    .where(and(eq(brandOutlet.brandId, brandId), eq(brandOutlet.locationId, locationId), eq(brandOutlet.isActive, true)));
  if (!deployment) {
    return {
      ok: false,
      status: 422,
      code: "NOT_DEPLOYED",
      message: "Brand is not deployed to that outlet. Deploy it first via POST /brands/:id/outlets.",
    };
  }

  return { ok: true };
}

export function createBrandsRouter(db: DB): Router {
  const router = Router();

  router.get("/brands", requireAuth, async (req, res) => {
    const queryParsed = brandListQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "'location_id' must be a UUID.", queryParsed.error.issues);
      return;
    }

    const isActiveParam = req.query.is_active;
    const conditions = [];
    if (isActiveParam === "true") conditions.push(eq(brands.isActive, true));
    if (isActiveParam === "false") conditions.push(eq(brands.isActive, false));

    if (queryParsed.data.location_id) {
      const locationId = queryParsed.data.location_id;
      // Brands actively deployed to this outlet (D30) — a brand's HOME outlet
      // (brand.location_id) covers the common case, so this only needs to add
      // brands deployed there from elsewhere.
      const deployed = await db
        .select({ brandId: brandOutlet.brandId })
        .from(brandOutlet)
        .where(and(eq(brandOutlet.locationId, locationId), eq(brandOutlet.isActive, true)));
      const deployedIds = deployed.map((d) => d.brandId);
      conditions.push(
        deployedIds.length > 0
          ? or(eq(brands.locationId, locationId), inArray(brands.id, deployedIds))!
          : eq(brands.locationId, locationId),
      );
    }

    const rows =
      conditions.length > 0
        ? await db.select().from(brands).where(and(...conditions))
        : await db.select().from(brands);

    res.json(rows);
  });

  router.post("/brands", requireAuth, requireRole(...WRITE_ROLES), resolveOutletContext, async (req, res) => {
    const parsed = createBrandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid brand payload.", parsed.error.issues);
      return;
    }

    const locationId = await resolveRequestLocationId(db, req, res, parsed.data.location_id);
    if (!locationId) return;

    // Create the brand + its home deployment (brand_outlet) atomically so the
    // D30 many-to-many stays consistent for new brands from the moment of birth.
    let brand!: typeof brands.$inferSelect;
    await db.transaction(async (tx) => {
      [brand] = await tx
        .insert(brands)
        .values({
          locationId,
          name: parsed.data.name,
          color: parsed.data.color,
          logoUrl: parsed.data.logo_url,
          salesPerfId:
            parsed.data.sales_perf_id ?? parsed.data.name.toLowerCase().replace(/\s+/g, "-"),
        })
        .returning();

      await tx
        .insert(brandOutlet)
        .values({ brandId: brand.id, locationId, isActive: true })
        .onConflictDoNothing();
    });

    res.status(201).json(brand);
  });

  router.patch("/brands/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = updateBrandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid brand payload.", parsed.error.issues);
      return;
    }

    const id = paramAsString(req.params.id);
    const [existing] = await db.select().from(brands).where(eq(brands.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const updates: Partial<typeof brands.$inferInsert> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.color !== undefined) updates.color = parsed.data.color;
    if (parsed.data.logo_url !== undefined) updates.logoUrl = parsed.data.logo_url;
    if (parsed.data.sales_perf_id !== undefined) updates.salesPerfId = parsed.data.sales_perf_id;
    if (parsed.data.is_active !== undefined) updates.isActive = parsed.data.is_active;

    // MOTM 2026-07-01: record an activity-log row when active/inactive actually flips.
    const activeChanged =
      parsed.data.is_active !== undefined && parsed.data.is_active !== existing.isActive;

    const [updated] = await db
      .update(brands)
      .set(updates)
      .where(eq(brands.id, id))
      .returning();

    if (activeChanged) {
      await db.insert(brandActivityLog).values({
        brandId: id,
        status: parsed.data.is_active ? "ACTIVE" : "INACTIVE",
        changedBy: req.user?.id ?? null,
        note: typeof req.body?.activity_note === "string" ? req.body.activity_note : null,
      });
    }

    res.json(updated);
  });

  // -------------------------------------------------------------------------
  // DELETE /brands/:id — hard delete. OWNER only.
  //
  // Allowed only when the brand has NEVER been advertised (zero aggregator_
  // account rows -> 409 HAS_LISTINGS) and none of its menu items have ever
  // been ordered (409 HAS_ORDERS — same check as menu/routes.ts's DELETE
  // /menu/:id). Both errors point the caller at PATCH is_active:false instead
  // of deletion, mirroring that route's own guidance.
  //
  // On success, deletes (one transaction): recipe lines + item-scoped
  // discounts for the brand's menu items, brand-scoped discounts, menu option
  // groups (cascades their item links), menu items (cascades menu_item_
  // outlet), user_brand grants, brand_activity_log rows, brand_outlet
  // deployments, then the brand row itself. A residual FK race (a listing/
  // order slipping in between the precheck and the delete) surfaces as the
  // same 409 via the caught 23503 — same pattern as menu/routes.ts.
  // -------------------------------------------------------------------------
  router.delete("/brands/:id", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = paramAsString(req.params.id);

    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const [listing] = await db
      .select({ id: aggregatorAccounts.id })
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.brandId, id))
      .limit(1);
    if (listing) {
      sendError(
        res,
        409,
        "HAS_LISTINGS",
        "This brand has channel listings (Foodpanda/GrabFood accounts) and cannot be deleted. Set is_active:false to deactivate it instead.",
      );
      return;
    }

    const [ordered] = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .innerJoin(menuItems, eq(orderItems.menuItemId, menuItems.id))
      .where(eq(menuItems.brandId, id))
      .limit(1);
    if (ordered) {
      sendError(
        res,
        409,
        "HAS_ORDERS",
        "This brand's menu has been ordered and cannot be deleted. Set is_active:false to deactivate it instead.",
      );
      return;
    }

    let deletedBrand: typeof brands.$inferSelect | null;

    try {
      deletedBrand = await db.transaction(async (tx) => {
        // Lock the brand row first so two concurrent deletes serialize
        // instead of both observing "brand exists" and racing the cascade.
        const locked = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, id)).for("update");
        if (locked.length === 0) {
          return null;
        }

        const brandMenuItems = await tx
          .select({ id: menuItems.id })
          .from(menuItems)
          .where(eq(menuItems.brandId, id));
        const menuItemIds = brandMenuItems.map((m) => m.id);

        if (menuItemIds.length > 0) {
          await tx.delete(recipeLines).where(inArray(recipeLines.menuItemId, menuItemIds));
          await tx.delete(discounts).where(inArray(discounts.menuItemId, menuItemIds));
        }
        await tx.delete(discounts).where(eq(discounts.brandId, id));
        await tx.delete(menuOptionGroups).where(eq(menuOptionGroups.brandId, id));
        await tx.delete(menuItems).where(eq(menuItems.brandId, id));
        await tx.delete(userBrands).where(eq(userBrands.brandId, id));
        await tx.delete(brandActivityLog).where(eq(brandActivityLog.brandId, id));
        await tx.delete(brandOutlet).where(eq(brandOutlet.brandId, id));

        const [deleted] = await tx.delete(brands).where(eq(brands.id, id)).returning();
        return deleted ?? null;
      });
    } catch (err) {
      // Residual FK race (23503): a listing/order was created between the
      // precheck and the delete — same answer as the prechecks above.
      const code =
        err && typeof err === "object"
          ? ((err as Record<string, unknown>)["code"] ??
            ((err as { cause?: Record<string, unknown> }).cause?.["code"]))
          : undefined;
      if (code === "23503") {
        sendError(
          res,
          409,
          "HAS_LISTINGS",
          "This brand is still referenced by a channel listing or order and cannot be deleted. Set is_active:false to deactivate it instead.",
        );
        return;
      }
      throw err;
    }

    if (!deletedBrand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const deletedName = deletedBrand.name;
    res.json({ ok: true });

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "brand.delete",
      description: `deleted brand "${deletedName}"`,
      entityType: "brand",
      entityId: id,
      metadata: { name: deletedName },
    });
  });

  // -------------------------------------------------------------------------
  // POST /brands/:id/availability — bulk-set availability across every menu
  // item owned by the brand (one UPDATE; idempotent by nature — re-running
  // with the same value converges to the same state, never duplicates rows).
  // -------------------------------------------------------------------------
  router.post("/brands/:id/availability", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const parsed = bulkAvailabilitySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid availability payload.", parsed.error.issues);
      return;
    }

    const updated = await db
      .update(menuItems)
      .set({ availability: parsed.data.availability })
      .where(eq(menuItems.brandId, id))
      .returning({ id: menuItems.id });

    res.json({ updated: updated.length });

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "brand.bulk_availability",
      description: `set availability=${parsed.data.availability} on ${updated.length} menu item(s) for brand ${id}`,
      entityType: "brand",
      entityId: id,
      metadata: { availability: parsed.data.availability, updated: updated.length },
    });
  });

  // -------------------------------------------------------------------------
  // GET /brands/:id/activity?from=&to= — active/inactive history (MOTM)
  // Defaults to the current calendar month; returns events chronologically.
  //
  // Opt-in detail mode (client review 2026-07-08 — "activity per month is not
  // showing the simulated runs"): ?detail=daily&month=YYYY-MM changes the
  // response to
  //   { changes: [...activity-log rows for that month...],
  //     daily:   [{ date: "YYYY-MM-DD", orders: number, revenue: number }] }
  // where `daily` densely covers EVERY day of the month (zeros included),
  // orders = COUNT of the brand's orders placed that day with status !=
  // CANCELLED and revenue = SUM(total) over the same set — ONE GROUP BY query.
  // Day buckets are UTC; Manila-day (UTC+8) buckets are a documented follow-up
  // (same caveat as /ems/attendance/self/today).
  // The default (no detail param) shape { events } is unchanged.
  // -------------------------------------------------------------------------
  router.get("/brands/:id/activity", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const detail = typeof req.query.detail === "string" ? req.query.detail : undefined;
    if (detail !== undefined && detail !== "daily") {
      sendError(res, 400, "VALIDATION_ERROR", "detail must be 'daily' when provided.");
      return;
    }

    if (detail === "daily") {
      const monthParam = typeof req.query.month === "string" ? req.query.month : undefined;
      const match = monthParam?.match(/^(\d{4})-(\d{2})$/);
      const year = match ? Number(match[1]) : NaN;
      const month = match ? Number(match[2]) : NaN;
      if (!match || month < 1 || month > 12) {
        sendError(res, 400, "VALIDATION_ERROR", "detail=daily requires month=YYYY-MM.");
        return;
      }

      const monthStart = new Date(Date.UTC(year, month - 1, 1));
      const nextMonthStart = new Date(Date.UTC(year, month, 1));
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

      // The month's activity-log rows (same row shape as the default `events`).
      const changes = await db
        .select()
        .from(brandActivityLog)
        .where(
          and(
            eq(brandActivityLog.brandId, id),
            gte(brandActivityLog.changedAt, monthStart),
            lt(brandActivityLog.changedAt, nextMonthStart),
          ),
        )
        .orderBy(asc(brandActivityLog.changedAt));

      // ONE grouped query: per-UTC-day order count + revenue, CANCELLED excluded.
      const dayExpr = sql<string>`to_char(${orders.placedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      const orderRows = await db
        .select({
          date: dayExpr,
          orders: sql<string>`COUNT(*)`,
          revenue: sql<string>`COALESCE(SUM(${orders.total}), 0)`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.brandId, id),
            gte(orders.placedAt, monthStart),
            lt(orders.placedAt, nextMonthStart),
            ne(orders.status, "CANCELLED"),
          ),
        )
        .groupBy(dayExpr);
      const byDate = new Map(orderRows.map((r) => [r.date, r]));

      // Dense: every day of the month present, zeros where nothing happened.
      const daily = Array.from({ length: daysInMonth }, (_, i) => {
        const date = `${match[1]}-${match[2]}-${String(i + 1).padStart(2, "0")}`;
        const row = byDate.get(date);
        return {
          date,
          orders: row ? Number(row.orders) : 0,
          revenue: row ? Math.round(Number(row.revenue) * 100) / 100 : 0,
        };
      });

      res.json({ changes, daily });
      return;
    }

    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);

    const parseDate = (v: unknown, fallback: Date): Date | null => {
      if (v === undefined) return fallback;
      if (typeof v !== "string") return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const from = parseDate(req.query.from, defaultFrom);
    const to = parseDate(req.query.to, now);
    if (from === null || to === null) {
      sendError(res, 400, "VALIDATION_ERROR", "from/to must be valid ISO dates.");
      return;
    }
    if (from > to) {
      sendError(res, 400, "VALIDATION_ERROR", "'from' must be on or before 'to'.");
      return;
    }

    const events = await db
      .select()
      .from(brandActivityLog)
      .where(
        and(
          eq(brandActivityLog.brandId, id),
          gte(brandActivityLog.changedAt, from),
          lte(brandActivityLog.changedAt, to),
        ),
      )
      .orderBy(asc(brandActivityLog.changedAt));

    res.json({ events });
  });

  router.get("/brands/:id/accounts", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    // Outlet-scoping leak fix (M6): additive-only filter. Omitted = unchanged
    // (every channel listing for the brand, across every outlet it operates
    // in); supplied = only listings pinned to that outlet (D39).
    const queryParsed = brandListQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "'location_id' must be a UUID.", queryParsed.error.issues);
      return;
    }

    const conditions = [eq(aggregatorAccounts.brandId, id)];
    if (queryParsed.data.location_id) {
      conditions.push(eq(aggregatorAccounts.locationId, queryParsed.data.location_id));
    }

    const rows = await db
      .select()
      .from(aggregatorAccounts)
      .where(and(...conditions));

    res.json(rows.map(toPublicAccount));
  });

  router.post(
    "/brands/:id/accounts",
    requireAuth,
    requireRole(...WRITE_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const [brand] = await db.select().from(brands).where(eq(brands.id, id));
      if (!brand) {
        sendError(res, 404, "NOT_FOUND", "Brand not found.");
        return;
      }

      const parsed = createAccountSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "Invalid aggregator account payload.", parsed.error.issues);
        return;
      }

      let locationId: string | undefined;
      if (parsed.data.location_id) {
        const check = await assertBrandDeployedAtLocation(db, id, parsed.data.location_id);
        if (!check.ok) {
          sendError(res, check.status, check.code, check.message);
          return;
        }
        locationId = parsed.data.location_id;
      }

      const [account] = await db
        .insert(aggregatorAccounts)
        .values({
          brandId: id,
          locationId,
          aggregator: parsed.data.aggregator,
          externalMerchantId: parsed.data.external_merchant_id,
          credentialRef: parsed.data.credential_ref,
        })
        .returning();

      res.status(201).json(toPublicAccount(account));
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /accounts/:id — update a channel listing's non-credential fields.
  // Never accepts credential_ref (security.md); audit records only the
  // CHANGED KEYS, never values (commission_rate/location_id may be sensitive
  // business terms).
  // -------------------------------------------------------------------------
  router.patch("/accounts/:id", requireAuth, requireRole("OWNER", "BRAND_MANAGER"), async (req, res) => {
    const id = paramAsString(req.params.id);
    const [existing] = await db.select().from(aggregatorAccounts).where(eq(aggregatorAccounts.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Aggregator account not found.");
      return;
    }

    const parsed = updateAccountSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid aggregator account payload.", parsed.error.issues);
      return;
    }

    const updates: Partial<typeof aggregatorAccounts.$inferInsert> = {};
    const changedKeys: string[] = [];

    if (parsed.data.external_merchant_id !== undefined) {
      updates.externalMerchantId = parsed.data.external_merchant_id;
      changedKeys.push("external_merchant_id");
    }
    if (parsed.data.commission_rate !== undefined) {
      updates.commissionRate = parsed.data.commission_rate === null ? null : String(parsed.data.commission_rate);
      changedKeys.push("commission_rate");
    }
    if (parsed.data.status !== undefined) {
      updates.mappingStatus = parsed.data.status;
      changedKeys.push("status");
    }
    if (parsed.data.location_id !== undefined) {
      if (parsed.data.location_id === null) {
        updates.locationId = null;
      } else {
        const check = await assertBrandDeployedAtLocation(db, existing.brandId, parsed.data.location_id);
        if (!check.ok) {
          sendError(res, check.status, check.code, check.message);
          return;
        }
        updates.locationId = parsed.data.location_id;
      }
      changedKeys.push("location_id");
    }

    const [updated] = await db
      .update(aggregatorAccounts)
      .set(updates)
      .where(eq(aggregatorAccounts.id, id))
      .returning();

    res.json(toPublicAccount(updated));

    void audit(db, {
      actorUserId: req.user?.id ?? null,
      actorName: req.user?.name ?? null,
      sessionId: req.user?.sessionId ?? null,
      action: "aggregator_account.update",
      description: `updated aggregator account ${id}: ${changedKeys.join(", ") || "(no-op)"}`,
      entityType: "aggregator_account",
      entityId: id,
      metadata: { changed_keys: changedKeys },
    });
  });

  router.delete("/accounts/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const [deleted] = await db
      .delete(aggregatorAccounts)
      .where(eq(aggregatorAccounts.id, id))
      .returning();

    if (!deleted) {
      sendError(res, 404, "NOT_FOUND", "Aggregator account not found.");
      return;
    }

    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // brand_outlet deployments (D30 many-to-many)
  // -------------------------------------------------------------------------

  // GET /brands/:id/outlets — outlets this brand is deployed to (active + inactive).
  // Readable by any authenticated user who can read brands.
  router.get("/brands/:id/outlets", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [brand] = await db.select().from(brands).where(eq(brands.id, id));
    if (!brand) {
      sendError(res, 404, "NOT_FOUND", "Brand not found.");
      return;
    }

    const rows = await db
      .select({
        brandId: brandOutlet.brandId,
        locationId: brandOutlet.locationId,
        isActive: brandOutlet.isActive,
        createdAt: brandOutlet.createdAt,
        code: locations.code,
        name: locations.name,
      })
      .from(brandOutlet)
      .innerJoin(locations, eq(brandOutlet.locationId, locations.id))
      .where(eq(brandOutlet.brandId, id))
      .orderBy(asc(brandOutlet.createdAt));

    res.json(rows);
  });

  // POST /brands/:id/outlets — deploy a brand to an outlet (OWNER + legacy alias).
  // Idempotent: re-deploying an active outlet is a no-op; a previously deactivated
  // deployment is reactivated (is_active=true) rather than duplicated.
  router.post(
    "/brands/:id/outlets",
    requireAuth,
    requireRole(...DEPLOY_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const [brand] = await db.select().from(brands).where(eq(brands.id, id));
      if (!brand) {
        sendError(res, 404, "NOT_FOUND", "Brand not found.");
        return;
      }

      const parsed = deployOutletSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", "A 'location_id' (UUID) is required.", parsed.error.issues);
        return;
      }
      const locationId = parsed.data.location_id;

      const [location] = await db.select().from(locations).where(eq(locations.id, locationId));
      if (!location) {
        sendError(res, 404, "NOT_FOUND", "Outlet not found.");
        return;
      }

      // Membership: ASSIGNED users may only deploy to outlets they belong to.
      const ctx = req.outletContext;
      if (ctx && ctx.scope !== "ALL" && !ctx.outletIds.includes(locationId)) {
        sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
        return;
      }

      const [existing] = await db
        .select()
        .from(brandOutlet)
        .where(and(eq(brandOutlet.brandId, id), eq(brandOutlet.locationId, locationId)));

      if (existing) {
        if (existing.isActive) {
          res.status(200).json(existing); // already deployed — idempotent
          return;
        }
        const [reactivated] = await db
          .update(brandOutlet)
          .set({ isActive: true })
          .where(and(eq(brandOutlet.brandId, id), eq(brandOutlet.locationId, locationId)))
          .returning();
        res.status(200).json(reactivated);
        return;
      }

      const [created] = await db
        .insert(brandOutlet)
        .values({ brandId: id, locationId, isActive: true })
        .returning();
      res.status(201).json(created);
    },
  );

  // DELETE /brands/:id/outlets/:locationId — deactivate a deployment (soft; keeps
  // the row + history). OWNER + legacy alias; ASSIGNED membership-checked.
  router.delete(
    "/brands/:id/outlets/:locationId",
    requireAuth,
    requireRole(...DEPLOY_ROLES),
    resolveOutletContext,
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const locationId = paramAsString(req.params.locationId);

      const [brand] = await db.select().from(brands).where(eq(brands.id, id));
      if (!brand) {
        sendError(res, 404, "NOT_FOUND", "Brand not found.");
        return;
      }

      const ctx = req.outletContext;
      if (ctx && ctx.scope !== "ALL" && !ctx.outletIds.includes(locationId)) {
        sendError(res, 403, "FORBIDDEN", "Outlet not in your access scope.");
        return;
      }

      const [existing] = await db
        .select()
        .from(brandOutlet)
        .where(and(eq(brandOutlet.brandId, id), eq(brandOutlet.locationId, locationId)));
      if (!existing) {
        sendError(res, 404, "NOT_FOUND", "Brand is not deployed to that outlet.");
        return;
      }

      const [deactivated] = await db
        .update(brandOutlet)
        .set({ isActive: false })
        .where(and(eq(brandOutlet.brandId, id), eq(brandOutlet.locationId, locationId)))
        .returning();

      res.json({ ok: true, deployment: deactivated });
    },
  );

  return router;
}
