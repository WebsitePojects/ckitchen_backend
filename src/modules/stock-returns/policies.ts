import type { Role } from "../../db/schema.js";
import type { StockDocumentPolicy } from "../stock/types.js";

export const STOCK_RETURN_FEATURE_KEY = "stock.returns";
export const STOCK_RETURN_DISPATCH_MODULE = "STOCK_RETURN_DISPATCH";
export const STOCK_RETURN_RECEIPT_MODULE = "STOCK_RETURN_RECEIPT";
export const STOCK_RETURN_MIN_LINES = 1;
// Dispatch and receive-and-dispose each emit 2 stock movements per line
// (custody-move OUT; quarantine IN + disposition OUT), so 250 lines is the
// largest batch whose movement count stays within the central stock posting
// service's 500-movement-per-posting cap.
export const STOCK_RETURN_MAX_LINES = 250;

// General access: create/update/submit/cancel/read.
export const STOCK_RETURN_ROLES: readonly Role[] = [
  "OWNER",
  "WAREHOUSE_MAIN",
  "OUTLET_MANAGER",
  "WAREHOUSE_OUTLET",
];
// Approval is a maker-checker gate: WAREHOUSE_OUTLET (the typical submitter) cannot approve.
export const STOCK_RETURN_APPROVE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN", "OUTLET_MANAGER"];
// Receipt/disposition happens physically at HQ: only HQ-tier roles (D31 outletScopeForRole "ALL")
// that actually own warehouse stock may receive and dispose a dispatched batch.
export const STOCK_RETURN_RECEIVE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN"];
// Source warehouse purposes eligible as a return's origin.
export const STOCK_RETURN_SOURCE_WAREHOUSE_PURPOSES = ["OUTLET_STORAGE", "KITCHEN"] as const;

/**
 * Server-owned policy for the central stock posting service (src/modules/stock/posting-service.ts).
 * Registered under STOCK_RETURN_DISPATCH_MODULE so the OUT custody-move posting that
 * dispatchStockReturnBatch() issues can only advance a STOCK_RETURN_DISPATCH operational_document
 * from APPROVED to DISPATCHED, gated by the same stock.returns feature flag as the rest of this module.
 */
export const STOCK_RETURN_DISPATCH_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_RETURN_FEATURE_KEY,
  routeClass: "OUTLET_RETURN_DISPATCH",
  allowedRoles: STOCK_RETURN_ROLES,
  fromStatuses: ["APPROVED"],
  nextStatus: "DISPATCHED",
};

/**
 * Server-owned policy for the immediate HQ quarantine IN + disposition OUT
 * pair that receiveAndDisposeStockReturnBatch() issues. Registered under
 * STOCK_RETURN_RECEIPT_MODULE so it can only advance a STOCK_RETURN_RECEIPT
 * operational_document from DISPATCHED to RECEIVED_DISPOSED, gated by the
 * same stock.returns feature flag as the rest of this module.
 */
export const STOCK_RETURN_RECEIPT_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_RETURN_FEATURE_KEY,
  routeClass: "RETURN_DISPOSITION",
  allowedRoles: STOCK_RETURN_RECEIVE_ROLES,
  fromStatuses: ["DISPATCHED"],
  nextStatus: "RECEIVED_DISPOSED",
};
