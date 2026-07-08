import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { brandOutlet, brands, locationStatusEnum, locations, warehouses } from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { isOutletInScope } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";

const WRITE_ROLES = ["OWNER"] as const;

const outletStatusValues = locationStatusEnum.enumValues;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createOutletSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1),
  address: z.string().optional(),
  timezone: z.string().min(1).optional(),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
});

const updateOutletSchema = z
  .object({
    code: z.string().min(1).max(32).optional(),
    name: z.string().min(1).optional(),
    address: z.string().nullable().optional(),
    status: z.enum(outletStatusValues).optional(),
    timezone: z.string().min(1).optional(),
    contact_name: z.string().nullable().optional(),
    contact_phone: z.string().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

async function withWarehouses(db: DB, outlet: typeof locations.$inferSelect) {
  const rows = await db
    .select()
    .from(warehouses)
    .where(eq(warehouses.locationId, outlet.id));

  return {
    ...outlet,
    warehouses: rows,
  };
}

export function createOutletsRouter(db: DB): Router {
  const router = Router();

  router.get("/outlets", requireAuth, async (_req, res) => {
    const outletRows = await db.select().from(locations);
    const response = await Promise.all(outletRows.map((outlet) => withWarehouses(db, outlet)));
    res.json(response);
  });

  router.get("/outlets/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [outlet] = await db.select().from(locations).where(eq(locations.id, id));

    if (!outlet) {
      sendError(res, 404, "NOT_FOUND", "Outlet not found.");
      return;
    }

    res.json(await withWarehouses(db, outlet));
  });

  // ── GET /outlets/:id/brands ────────────────────────────────────────────────
  // Outlet-side deployment read (D30): the brands operating at this outlet.
  // Union of:
  //   (a) "home" brands — brand.location_id = this outlet. home:true,
  //       isActive:null, deployedAt:null (a home brand's own deployment is
  //       not a removable brand_outlet entry from this endpoint's view).
  //   (b) brand_outlet rows for this outlet (active + inactive) whose brand is
  //       NOT already covered by (a) — home:false, with the real isActive/
  //       createdAt of the deployment.
  // Batched: outlet lookup + 2 parallel queries — no N+1.
  router.get("/outlets/:id/brands", requireAuth, resolveOutletContext, async (req, res) => {
    const id = paramAsString(req.params.id);
    if (!UUID_RE.test(id)) {
      sendError(res, 400, "VALIDATION_ERROR", "Outlet id must be a valid UUID.");
      return;
    }

    const [outlet] = await db.select({ id: locations.id }).from(locations).where(eq(locations.id, id));
    if (!outlet) {
      sendError(res, 404, "NOT_FOUND", "Outlet not found.");
      return;
    }

    if (!isOutletInScope(req.outletContext, id)) {
      sendError(res, 403, "FORBIDDEN", "Outlet is outside your access scope.");
      return;
    }

    const [homeBrands, deployments] = await Promise.all([
      db
        .select({ id: brands.id, name: brands.name, color: brands.color })
        .from(brands)
        .where(eq(brands.locationId, id)),
      db
        .select({
          brandId: brandOutlet.brandId,
          isActive: brandOutlet.isActive,
          createdAt: brandOutlet.createdAt,
          name: brands.name,
          color: brands.color,
        })
        .from(brandOutlet)
        .innerJoin(brands, eq(brandOutlet.brandId, brands.id))
        .where(eq(brandOutlet.locationId, id)),
    ]);

    const seen = new Set<string>();
    const result: Array<{
      brandId: string;
      name: string;
      color: string;
      home: boolean;
      isActive: boolean | null;
      deployedAt: string | null;
    }> = [];

    for (const b of homeBrands) {
      result.push({ brandId: b.id, name: b.name, color: b.color, home: true, isActive: null, deployedAt: null });
      seen.add(b.id);
    }
    for (const d of deployments) {
      if (seen.has(d.brandId)) continue; // already represented as a home brand
      result.push({
        brandId: d.brandId,
        name: d.name,
        color: d.color,
        home: false,
        isActive: d.isActive,
        deployedAt: d.createdAt.toISOString(),
      });
      seen.add(d.brandId);
    }

    res.json(result);
  });

  router.post("/outlets", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = createOutletSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid outlet payload.", parsed.error.issues);
      return;
    }

    const code = normalizeCode(parsed.data.code);
    const [duplicate] = await db.select().from(locations).where(eq(locations.code, code));
    if (duplicate) {
      sendError(res, 409, "CONFLICT", `Outlet code ${code} already exists.`);
      return;
    }

    let createdOutlet: typeof locations.$inferSelect | undefined;

    await db.transaction(async (tx) => {
      [createdOutlet] = await tx
        .insert(locations)
        .values({
          code,
          name: parsed.data.name,
          address: parsed.data.address,
          timezone: parsed.data.timezone ?? "Asia/Manila",
          contactName: parsed.data.contact_name,
          contactPhone: parsed.data.contact_phone,
        })
        .returning();

      await tx.insert(warehouses).values([
        { locationId: createdOutlet!.id, type: "MAIN" },
        { locationId: createdOutlet!.id, type: "KITCHEN" },
      ]);
    });

    res.status(201).json(await withWarehouses(db, createdOutlet!));
  });

  router.patch("/outlets/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = updateOutletSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid outlet payload.", parsed.error.issues);
      return;
    }

    const id = paramAsString(req.params.id);
    const [existing] = await db.select().from(locations).where(eq(locations.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Outlet not found.");
      return;
    }

    const updates: Partial<typeof locations.$inferInsert> = {};
    if (parsed.data.code !== undefined) {
      const code = normalizeCode(parsed.data.code);
      const [duplicate] = await db.select().from(locations).where(eq(locations.code, code));
      if (duplicate && duplicate.id !== id) {
        sendError(res, 409, "CONFLICT", `Outlet code ${code} already exists.`);
        return;
      }
      updates.code = code;
    }
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.address !== undefined) updates.address = parsed.data.address ?? undefined;
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
    if (parsed.data.timezone !== undefined) updates.timezone = parsed.data.timezone;
    if (parsed.data.contact_name !== undefined) updates.contactName = parsed.data.contact_name ?? undefined;
    if (parsed.data.contact_phone !== undefined) updates.contactPhone = parsed.data.contact_phone ?? undefined;

    const [updated] = await db
      .update(locations)
      .set(updates)
      .where(eq(locations.id, id))
      .returning();

    res.json(await withWarehouses(db, updated));
  });

  return router;
}
