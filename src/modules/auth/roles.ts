/**
 * Roles v2 — shared aliasing + outlet-scope helpers (D24 / D29 / D31).
 *
 * The DB enum keeps BOTH v1 and v2 role values (migration 0012). Code speaks v2,
 * but must keep accepting v1 role strings carried by already-issued JWTs and by
 * any rows/tests that still use them. Everything funnels through `normalizeRole`
 * so a single alias map governs the whole system.
 */
import type { Role } from "../../db/schema.js";

export type OutletScope = "ALL" | "ASSIGNED";

/** Canonical v2 role names (D24). */
export const V2_ROLES = [
  "OWNER",
  "OUTLET_MANAGER",
  "BRAND_MANAGER",
  "KITCHEN_CREW",
  "WAREHOUSE_MAIN",
  "WAREHOUSE_OUTLET",
  "PURCHASING",
  "HR",
  "ACCOUNTING",
] as const;

/**
 * v1 → v2 alias map (D24/D29). Only the roles that were RENAMED appear here;
 * BRAND_MANAGER is unchanged, and every v2 role maps to itself (identity). RIDER
 * is deliberately absent — it was removed (D29) and grants no access.
 */
export const ROLE_ALIASES: Readonly<Record<string, Role>> = {
  SUPER_ADMIN: "OWNER",
  KITCHEN_STAFF: "KITCHEN_CREW",
  WAREHOUSE: "WAREHOUSE_OUTLET",
  SUPPLIER_COORDINATOR: "PURCHASING",
  ACCOUNTANT: "ACCOUNTING",
};

/**
 * Normalizes any role string (v1 or v2) to its canonical v2 name. Returns `null`
 * for RIDER (removed → no access) and for any unrecognized value, so callers can
 * fail closed.
 */
export function normalizeRole(role: string | null | undefined): Role | null {
  if (!role || role === "RIDER") return null;
  if (role in ROLE_ALIASES) return ROLE_ALIASES[role];
  if ((V2_ROLES as readonly string[]).includes(role)) return role as Role;
  return null;
}

/**
 * HQ roles that see every outlet (D31). WAREHOUSE_MAIN has warehouse-ops-wide
 * visibility (NO finance pages, enforced elsewhere). Compared in canonical v2
 * form, so legacy SUPER_ADMIN/ACCOUNTANT resolve here via `normalizeRole`.
 */
export const HQ_ALL_SCOPE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "OWNER",
  "HR",
  "ACCOUNTING",
  "WAREHOUSE_MAIN",
]);

/** Outlet scope for a role: 'ALL' for HQ roles, 'ASSIGNED' for everyone else. */
export function outletScopeForRole(role: string | null | undefined): OutletScope {
  const norm = normalizeRole(role);
  return norm && HQ_ALL_SCOPE_ROLES.has(norm) ? "ALL" : "ASSIGNED";
}
