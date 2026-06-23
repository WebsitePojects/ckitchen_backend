import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { aggregatorAccounts, aggregatorEnum, brands, locations } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";

const WRITE_ROLES = ["SUPER_ADMIN", "BRAND_MANAGER"] as const;

const createBrandSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  logo_url: z.string().optional(),
  sales_perf_id: z.string().optional(),
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

/** Resolves the single seeded location for the prototype (many-brands-one-location). */
async function resolveLocationId(db: DB): Promise<string | null> {
  const [location] = await db.select().from(locations).limit(1);
  return location?.id ?? null;
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

  router.post("/brands", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = createBrandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid brand payload.", parsed.error.issues);
      return;
    }

    const locationId = await resolveLocationId(db);
    if (!locationId) {
      sendError(res, 500, "NOT_FOUND", "No location is configured for this deployment.");
      return;
    }

    const [brand] = await db
      .insert(brands)
      .values({
        locationId,
        name: parsed.data.name,
        color: parsed.data.color,
        logoUrl: parsed.data.logo_url,
        salesPerfId: parsed.data.sales_perf_id ?? parsed.data.name.toLowerCase().replace(/\s+/g, "-"),
      })
      .returning();

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

    const [updated] = await db
      .update(brands)
      .set(updates)
      .where(eq(brands.id, id))
      .returning();

    res.json(updated);
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

  return router;
}
