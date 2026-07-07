/**
 * W5 — Role→page access matrix defaults.
 *
 * Mirrors the frontend page-role map (ckitchen_frontend/src/auth/access.ts
 * `PAGE_ROLES`) so the persisted `role_page_access` table is seeded from the
 * exact same source of truth the UI ships with. Frontend enforcement of the
 * PERSISTED table is a separate workstream; this backend layer owns the data +
 * the GET/PUT API.
 *
 * Only the 9 canonical v2 roles are seeded (V2_ROLES). The frontend normalizes
 * v1 tokens → v2 before every `canAccess` lookup, and the retired RIDER role
 * (which appears literally in a couple of the frontend arrays as a "OWNER-only
 * otherwise" sentinel) grants no access — so it is deliberately excluded here.
 *
 * OWNER is short-circuited to "allowed everywhere" in the frontend and is not
 * listed in the arrays below; we materialize OWNER = true for every page at
 * seed time, and {@link OWNER_PROTECTED_PAGES} can never be flipped off for
 * OWNER via the admin API (fail-closed — OWNER must always retain admin access).
 */
import { V2_ROLES } from "../auth/roles.js";
import type { Role } from "../../db/schema.js";

/** Every v2 role (used by the platform-wide Attendance page). */
const EVERYONE: readonly string[] = V2_ROLES;

/**
 * Canonical role→page map (v2 role names), copied verbatim from the frontend
 * `PAGE_ROLES`. OWNER is intentionally absent (granted everywhere separately).
 * The literal 'RIDER' sentinels from the frontend are dropped — RIDER is retired.
 */
export const PAGE_ROLES: Readonly<Record<string, readonly string[]>> = {
  // Overview
  "/": ["OUTLET_MANAGER", "BRAND_MANAGER"],
  "/orders": ["OUTLET_MANAGER", "BRAND_MANAGER", "KITCHEN_CREW", "ACCOUNTING"],
  "/kitchen": ["OUTLET_MANAGER", "KITCHEN_CREW"],
  "/printers": ["OUTLET_MANAGER", "KITCHEN_CREW"],
  "/tv": ["OUTLET_MANAGER", "KITCHEN_CREW"],

  // Catalog
  "/brands": ["OUTLET_MANAGER", "BRAND_MANAGER"],
  "/menu": ["OUTLET_MANAGER", "BRAND_MANAGER", "KITCHEN_CREW"],
  "/channel-listings": ["BRAND_MANAGER"],

  // Inventory
  "/inventory": ["OUTLET_MANAGER", "KITCHEN_CREW", "WAREHOUSE_MAIN", "WAREHOUSE_OUTLET", "PURCHASING"],
  "/stock-ledger": ["OUTLET_MANAGER", "KITCHEN_CREW", "WAREHOUSE_MAIN", "WAREHOUSE_OUTLET", "PURCHASING", "ACCOUNTING"],

  // Purchasing
  "/master-data": ["WAREHOUSE_MAIN", "PURCHASING"],

  // People
  "/employees": ["OUTLET_MANAGER", "HR"],
  "/attendance": [...EVERYONE],
  "/users": ["HR"],

  // Insights
  "/reports": ["OUTLET_MANAGER", "BRAND_MANAGER", "PURCHASING", "ACCOUNTING"],
  "/audit": ["BRAND_MANAGER"],

  // System
  "/outlets": ["WAREHOUSE_MAIN"],
  "/settings": [],
};

/** Ordered list of every page key in the matrix. */
export const PAGE_KEYS: readonly string[] = Object.keys(PAGE_ROLES);

/** The roles the matrix is materialized for — the 9 canonical v2 roles. */
export const MATRIX_ROLES: readonly Role[] = V2_ROLES as readonly Role[];

/**
 * Pages OWNER must ALWAYS be able to reach — the admin surface. The PUT /admin/rbac
 * endpoint refuses any upsert that would set OWNER = false on one of these
 * (fail-closed), so an admin can never lock every OWNER out of user management.
 */
export const OWNER_PROTECTED_PAGES: readonly string[] = ["/users", "/settings"];

/** Default `allowed` for a (role, page) pair at seed time. OWNER: always true. */
export function defaultAllowed(role: Role, pageKey: string): boolean {
  if (role === "OWNER") return true;
  const roles = PAGE_ROLES[pageKey];
  return roles ? roles.includes(role) : false;
}
