/**
 * "Me" module — self-scoped endpoints any logged-in user may call about their
 * OWN account (as opposed to /admin/*, which is OWNER-only and acts on others).
 *
 * Endpoints (mounted under /api/v1):
 *   GET /me/permissions — the caller's own effective page access, derived from
 *                          the persisted role_page_access matrix (falls back to
 *                          the code-defined defaults for an unseeded DB).
 *
 * This closes the loop on the admin RBAC matrix (W5): editing the matrix now
 * has a runtime effect because the frontend nav/route-guard consumes this
 * endpoint. Safety: this route is intentionally requireAuth-only (NOT
 * OWNER-gated) — every user is entitled to read their own effective access.
 * The frontend treats a failed/slow/empty fetch as "fall back to the
 * code-defined defaults" (fail OPEN) so a bug here can never lock anyone out;
 * see ckitchen_frontend/src/context/PermissionsContext.tsx.
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { rolePageAccess } from "../../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { normalizeRole } from "../auth/roles.js";
import { PAGE_KEYS, defaultAllowed } from "../admin/rbac-defaults.js";

export function createMeRouter(db: DB): Router {
  const router = Router();

  // ── GET /me/permissions ───────────────────────────────────────────────────
  // Actor role is derived from the verified JWT (req.user), never a client
  // param — security.md "authorization enforced server-side, never trust the
  // client". Returns { pages: string[] } = the pageKeys this caller may see.
  router.get("/me/permissions", requireAuth, async (req, res) => {
    const role = normalizeRole(req.user!.role);

    // Unknown/retired role (e.g. RIDER) — normalizes to null, grants nothing.
    if (!role) {
      res.json({ pages: [] });
      return;
    }

    // OWNER is always full access — never restricted by the matrix.
    if (role === "OWNER") {
      res.json({ pages: [...PAGE_KEYS] });
      return;
    }

    const rows = await db
      .select({ pageKey: rolePageAccess.pageKey, allowed: rolePageAccess.allowed })
      .from(rolePageAccess)
      .where(eq(rolePageAccess.role, role));

    // Per-page merge, same convention as the admin matrix read (loadRbacEntries):
    // a persisted row always wins; a page with no row yet (shipped after the table
    // was seeded, e.g. /pos) uses the code default. Without this, every page added
    // after go-live was silently denied to every non-OWNER role.
    const persisted = new Map(rows.map((r) => [r.pageKey, r.allowed]));
    const pages = PAGE_KEYS.filter((pageKey) => persisted.get(pageKey) ?? defaultAllowed(role, pageKey));
    res.json({ pages });
  });

  return router;
}
