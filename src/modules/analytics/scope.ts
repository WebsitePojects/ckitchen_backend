/**
 * Who sees which money in analytics. One place, used by every analytics endpoint, so the
 * rules cannot drift between reports:
 *
 *   - BRAND_MANAGER: only the brands assigned to them (user_brand);
 *   - outlet-scoped readers (ASSIGNED scope, or anyone with an X-Outlet-Id picked): only orders
 *     placed at those outlets, and only brands operating there;
 *   - OWNER / ACCOUNTING with no outlet picked: the whole workspace.
 *
 * An empty list means "nothing", never "everything" (fail closed).
 */
import type { Request } from "express";
import { eq, sql, type SQL } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { userBrands } from "../../db/schema.js";
import { listScopeLocationIds } from "../auth/outlet-scope.js";
import { normalizeRole } from "../auth/roles.js";

export interface AnalyticsScope {
  /** null = every brand; [] = none. */
  brandIds: string[] | null;
  /** null = every outlet; [] = none. */
  locationIds: string[] | null;
}

export const UNSCOPED: AnalyticsScope = { brandIds: null, locationIds: null };

/** Requires resolveOutletContext to have run (outlet scope comes from it). */
export async function resolveAnalyticsScope(db: DB, req: Request): Promise<AnalyticsScope> {
  let brandIds: string[] | null = null;
  if (normalizeRole(req.user!.role) === "BRAND_MANAGER") {
    brandIds = (
      await db.select({ brandId: userBrands.brandId }).from(userBrands).where(eq(userBrands.userId, req.user!.id))
    ).map((r) => r.brandId);
  }
  return { brandIds, locationIds: listScopeLocationIds(req.outletContext) };
}

const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** `AND <column> IN (...)` for a scope list; nothing for null; `AND FALSE` for an empty list. */
export function andIn(column: SQL, ids: string[] | null): SQL {
  if (ids === null) return sql``;
  return ids.length === 0 ? sql`AND FALSE` : sql`AND ${column} IN (${idList(ids)})`;
}

/** Conditions on an order row (alias given): its brand and the outlet it was placed at. */
export function orderScopeSql(scope: AnalyticsScope, alias = "o"): SQL {
  return sql`${andIn(sql.raw(`${alias}.brand_id`), scope.brandIds)} ${andIn(sql.raw(`${alias}.location_id`), scope.locationIds)}`;
}

/**
 * Conditions on a brand row (alias given): an assigned brand, operating at one of the scoped
 * outlets (home outlet or an active deployment). Keeps other brands' names out of the lists.
 */
export function brandScopeSql(scope: AnalyticsScope, alias = "b"): SQL {
  const locations = scope.locationIds;
  const atOutlet =
    locations === null
      ? sql``
      : locations.length === 0
        ? sql`AND FALSE`
        : sql`AND (${sql.raw(`${alias}.location_id`)} IN (${idList(locations)}) OR ${sql.raw(`${alias}.id`)} IN (
            SELECT bo.brand_id FROM brand_outlet bo WHERE bo.is_active AND bo.location_id IN (${idList(locations)})))`;
  return sql`${andIn(sql.raw(`${alias}.id`), scope.brandIds)} ${atOutlet}`;
}
