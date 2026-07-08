import { Router } from "express";
import { and, asc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  aggregatorAccounts,
  aggregatorEnum,
  brandActivityLog,
  brandOutlet,
  brands,
  locations,
  orders,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { resolveRequestLocationId } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";

const WRITE_ROLES = ["OWNER", "BRAND_MANAGER"] as const;
/** Deploying a brand to an outlet / deactivating it is an OWNER (HQ) action. */
const DEPLOY_ROLES = ["OWNER"] as const;

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
});

/** Strips `credentialRef` before an aggregator account ever reaches an API response (security.md). */
function toPublicAccount(account: typeof aggregatorAccounts.$inferSelect) {
  const { credentialRef, ...publicAccount } = account;
  return publicAccount;
}

export function createBrandsRouter(db: DB): Router {
  const router = Router();

  router.get("/brands", requireAuth, async (req, res) => {
    const isActiveParam = req.query.is_active;
    const conditions = [];
    if (isActiveParam === "true") conditions.push(eq(brands.isActive, true));
    if (isActiveParam === "false") conditions.push(eq(brands.isActive, false));

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

    const rows = await db
      .select()
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.brandId, id));

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

      const [account] = await db
        .insert(aggregatorAccounts)
        .values({
          brandId: id,
          aggregator: parsed.data.aggregator,
          externalMerchantId: parsed.data.external_merchant_id,
          credentialRef: parsed.data.credential_ref,
        })
        .returning();

      res.status(201).json(toPublicAccount(account));
    },
  );

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
