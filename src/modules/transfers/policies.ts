import type { Role } from "../../db/schema.js";
import type { StockDocumentPolicy } from "../stock/types.js";

// Already seeded (dark, disabled) by drizzle/0027_enterprise_operations_foundation.sql
// ("stock.transfers", false, 'Enterprise transfer posting') — no new migration
// needed. An admin flips it at runtime the same way stock.returns/stock.production
// are flipped in tests (`update operational_feature_flag set enabled = true ...`).
export const TRANSFER_FEATURE_KEY = "stock.transfers";
export const TRANSFER_ORDER_DISPATCH_MODULE = "TRANSFER_ORDER_DISPATCH";
export const TRANSFER_ORDER_RECEIPT_MODULE = "TRANSFER_ORDER_RECEIPT";

export const TRANSFER_MIN_LINES = 1;
// Dispatch and receive each post exactly 1 movement per line (unlike stock
// returns' 2-per-line dispatch+disposition pair), so this stays well within
// the central posting service's 500-movement-per-posting cap.
export const TRANSFER_MAX_LINES = 200;

// General access: create/update/submit/cancel/read. Mirrors STOCK_RETURN_ROLES
// (broad outlet+HQ roles); the actor's outlet-scope check (source location on
// create/submit/approve/dispatch, destination location on receive) is what
// actually restricts who can act on any given order in practice, since HQ_MAIN
// and PRODUCTION locations are typically outside an outlet-scoped actor's
// userOutletAccess rows.
export const TRANSFER_ROLES: readonly Role[] = [
  "OWNER",
  "WAREHOUSE_MAIN",
  "OUTLET_MANAGER",
  "WAREHOUSE_OUTLET",
];
// Approval is a maker-checker gate (mirrors STOCK_RETURN_APPROVE_ROLES): the
// submitter cannot also approve their own order.
export const TRANSFER_APPROVE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN", "OUTLET_MANAGER"];
// Dispatch happens physically at the source node; receive happens physically
// at the destination node. Both reuse TRANSFER_ROLES for the role check —
// the location-scope check (source vs. destination) is the real gate.
export const TRANSFER_DISPATCH_ROLES: readonly Role[] = TRANSFER_ROLES;
export const TRANSFER_RECEIVE_ROLES: readonly Role[] = TRANSFER_ROLES;

/**
 * D35-D46 §2 allowed stock routes, restricted to the pairs a Transfer Order
 * may legally carry (Supplier->HQ_MAIN is Receiving; outlet-side moves are
 * Internal Transfer Order or Stock Return Batch; QUARANTINE moves are QA
 * Release — none of those go through this module):
 *   HQ_MAIN -> OUTLET_STORAGE
 *   HQ_MAIN -> PRODUCTION
 *   PRODUCTION -> HQ_MAIN
 *   PRODUCTION -> OUTLET_STORAGE
 * Keyed on "<sourcePurpose>:<destinationPurpose>". This is the service-level
 * complement to transfer-orders-schema.ts's header comment explaining why
 * full route legality can't be a DB CHECK constraint (it would need to join
 * to `warehouse.purpose` for both referenced warehouses against a multi-row
 * table). The central posting service's HQ_TRANSFER route class (per-movement
 * OUT@{HQ_MAIN,PRODUCTION} / IN@{OUTLET_STORAGE,PRODUCTION,HQ_MAIN}) provides
 * defense-in-depth at actual posting time, but does not by itself reject
 * every disallowed pair here (e.g. it never sees a same-purpose no-op route),
 * so this table remains the authoritative gate.
 */
export const TRANSFER_ALLOWED_ROUTE_PAIRS: ReadonlySet<string> = new Set([
  "HQ_MAIN:OUTLET_STORAGE",
  "HQ_MAIN:PRODUCTION",
  "PRODUCTION:HQ_MAIN",
  "PRODUCTION:OUTLET_STORAGE",
]);

/**
 * Server-owned policy for the central stock posting service
 * (src/modules/stock/posting-service.ts). Registered under
 * TRANSFER_ORDER_DISPATCH_MODULE so the OUT movements dispatchTransferOrder()
 * issues (from the order's own source HQ_MAIN/PRODUCTION warehouse, FEFO-
 * selected per line when no lot was pinned at draft time) can only advance a
 * TRANSFER_ORDER_DISPATCH operational_document from APPROVED to DISPATCHED,
 * gated by the stock.transfers feature flag (plus the posting service's own
 * DB-wide "stock.lot_writes" flag).
 */
export const TRANSFER_ORDER_DISPATCH_POLICY: StockDocumentPolicy = {
  featureFlag: TRANSFER_FEATURE_KEY,
  routeClass: "HQ_TRANSFER",
  allowedRoles: TRANSFER_DISPATCH_ROLES,
  fromStatuses: ["APPROVED"],
  nextStatus: "DISPATCHED",
};

/**
 * Server-owned policy for the IN movements receiveTransferOrder() issues at
 * the order's own destination warehouse, advancing a TRANSFER_ORDER_RECEIPT
 * operational_document from DISPATCHED to RECEIVED.
 */
export const TRANSFER_ORDER_RECEIPT_POLICY: StockDocumentPolicy = {
  featureFlag: TRANSFER_FEATURE_KEY,
  routeClass: "HQ_TRANSFER",
  allowedRoles: TRANSFER_RECEIVE_ROLES,
  fromStatuses: ["DISPATCHED"],
  nextStatus: "RECEIVED",
};
