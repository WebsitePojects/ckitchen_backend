/**
 * Business modules — the owner switches whole parts of ORION on or off for this business.
 *
 *   GET /business-modules        any signed-in user (navigation depends on it)
 *   PUT /business-modules/:key   OWNER only; { enabled: boolean }
 *
 * The PUT is an upsert to an absolute state, so repeating it (double click, retry) leaves
 * the same result: duplicate-safe by construction.
 */
import { Router } from "express";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { businessModules } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { audit } from "../ems/audit.js";
import { paramAsString, sendError } from "../http-errors.js";
import { BUSINESS_MODULES, findModule } from "./catalog.js";

const putSchema = z.object({ enabled: z.boolean() }).strict();

/** Page keys hidden because their module is switched off. */
export async function disabledPages(db: DB): Promise<Set<string>> {
  const rows = await db.select({ key: businessModules.key, enabled: businessModules.enabled }).from(businessModules);
  const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.key));
  const pages = new Set<string>();
  for (const mod of BUSINESS_MODULES) if (off.has(mod.key)) mod.pages.forEach((p) => pages.add(p));
  return pages;
}

export function createBusinessModulesRouter(db: DB): Router {
  const router = Router();

  router.get("/business-modules", requireAuth, async (_req, res) => {
    const rows = await db.select().from(businessModules);
    const enabledByKey = new Map(rows.map((r) => [r.key, r.enabled]));
    res.json(
      BUSINESS_MODULES.map((m) => ({
        key: m.key,
        label: m.label,
        description: m.description,
        pages: m.pages,
        enabled: enabledByKey.get(m.key) ?? true,
      })),
    );
  });

  router.put("/business-modules/:key", requireAuth, requireRole("OWNER"), async (req, res) => {
    const key = paramAsString(req.params.key);
    const mod = findModule(key);
    if (!mod) {
      sendError(res, 404, "NOT_FOUND", `Unknown module "${key}".`);
      return;
    }
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Body must be { enabled: true | false }.", parsed.error.issues);
      return;
    }
    const { enabled } = parsed.data;
    await db
      .insert(businessModules)
      .values({ key, enabled, updatedBy: req.user!.id })
      .onConflictDoUpdate({
        target: [businessModules.tenantId, businessModules.key],
        set: { enabled, updatedBy: req.user!.id, updatedAt: new Date() },
      });
    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name,
      sessionId: req.user!.sessionId ?? null,
      action: "settings.module",
      description: `${enabled ? "Enabled" : "Disabled"} module "${mod.label}"`,
      entityType: "business_module",
      metadata: { key, enabled },
    });
    res.json({ key, enabled });
  });

  return router;
}
