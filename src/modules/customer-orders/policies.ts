import type { Role } from "../../db/schema.js";
import type { StockDocumentPolicy } from "../stock/types.js";

export const STOCK_CUSTOMER_ORDER_FEATURE_KEY = "stock.customer_order_fulfillment";

// General access: create draft/update/submit/cancel/read. Deliberately does
// NOT require STOCK_CUSTOMER_ORDER_FEATURE_KEY -- D46 §13 "dark modules may
// validate or save drafts but cannot post stock" means draft/submit/approve
// stay reachable while the flag is off; only allocate()/fulfill() (the two
// transitions with a stock effect) gate on it (see service.ts).
export const CUSTOMER_ORDER_ROLES: readonly Role[] = [
  "OWNER",
  "OUTLET_MANAGER",
  "WAREHOUSE_MAIN",
  "WAREHOUSE_OUTLET",
];
// Approval is a maker-checker gate (mirrors STOCK_RETURN_APPROVE_ROLES /
// job-order approve's submitter != approver rule): the submitter cannot also
// approve their own order.
export const CUSTOMER_ORDER_APPROVE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN", "OUTLET_MANAGER"];
// Allocation/production-readiness/fulfillment touch stock (or a stock
// reservation) -> warehouse-tier roles only.
export const CUSTOMER_ORDER_FULFILL_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN", "WAREHOUSE_OUTLET"];

export const CUSTOMER_ORDER_MIN_LINES = 1;
export const CUSTOMER_ORDER_MAX_LINES = 100;

/**
 * Eligible outlet-local stock nodes a Customer Order may allocate/fulfill its
 * STOCKED_OUTPUT and MADE_TO_ORDER-component-snapshot lines from (D35-D46
 * §7/§4: "the order's outlet nodes"; never PRODUCTION and never another
 * outlet -- matches the central posting service's own ORDER_DEDUCTION route
 * class, which restricts OUT movements to exactly these two warehouse
 * purposes at a single outlet).
 */
export const CUSTOMER_ORDER_SOURCE_WAREHOUSE_PURPOSES = ["OUTLET_STORAGE", "KITCHEN"] as const;

/** operational_document module for STOCKED_OUTPUT / component-snapshot fulfillment postings. */
export const CUSTOMER_ORDER_FULFILLMENT_MODULE = "CUSTOMER_ORDER_FULFILLMENT";

/**
 * operational_document module for job-order-linked MADE_TO_ORDER line
 * fulfillment. A linked Job Order's finished output lot lands in that job's
 * own PRODUCTION-purpose warehouse (job-order-service.ts requires
 * `warehouses.purpose = 'PRODUCTION'` for a Job Order's production
 * warehouse) -- it has not necessarily been transferred out to
 * OUTLET_STORAGE/KITCHEN by the time a linked Customer Order line is ready to
 * fulfill. The central posting service's "ORDER_DEDUCTION" route class only
 * allows OUT movements from OUTLET_STORAGE/KITCHEN, so a job-order-linked
 * line's consumption cannot use that route. Rather than inventing a new route
 * class in src/modules/stock/posting-service.ts (out of scope for this
 * service, and the posting service already defines everything this module
 * needs), this line's consumption instead reuses the existing "PRODUCTION"
 * route class -- which already permits IN/OUT movements against HQ_MAIN or
 * PRODUCTION warehouses with no direction/eligibility restriction beyond that
 * -- registered under this module's OWN document namespace so it can never be
 * confused with (or accidentally advance) a Job Order's own
 * PRODUCTION_CONSUME/PRODUCTION_OUTPUT documents.
 */
export const CUSTOMER_ORDER_JOB_OUTPUT_MODULE = "CUSTOMER_ORDER_JOB_OUTPUT_FULFILLMENT";

/**
 * Server-owned policy for the central stock posting service
 * (src/modules/stock/posting-service.ts). Registered under
 * CUSTOMER_ORDER_FULFILLMENT_MODULE so the OUT movements fulfillCustomerOrder()
 * issues for STOCKED_OUTPUT / MADE_TO_ORDER-component-snapshot lines (drawn
 * from the order's own outlet KITCHEN/OUTLET_STORAGE warehouses, FEFO-
 * selected and reservation-tracked at allocate() time) can only advance a
 * CUSTOMER_ORDER_FULFILLMENT operational_document from PENDING to FULFILLED,
 * gated by the stock.customer_order_fulfillment feature flag (plus the
 * posting service's own DB-wide "stock.lot_writes" flag).
 */
export const CUSTOMER_ORDER_FULFILLMENT_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_CUSTOMER_ORDER_FEATURE_KEY,
  routeClass: "ORDER_DEDUCTION",
  allowedRoles: CUSTOMER_ORDER_FULFILL_ROLES,
  fromStatuses: ["PENDING"],
  nextStatus: "FULFILLED",
};

/**
 * Server-owned policy for the job-order-linked MADE_TO_ORDER fulfillment path
 * (see CUSTOMER_ORDER_JOB_OUTPUT_MODULE doc comment above for why this needs
 * its own module + the "PRODUCTION" route class rather than ORDER_DEDUCTION).
 */
export const CUSTOMER_ORDER_JOB_OUTPUT_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_CUSTOMER_ORDER_FEATURE_KEY,
  routeClass: "PRODUCTION",
  allowedRoles: CUSTOMER_ORDER_FULFILL_ROLES,
  fromStatuses: ["PENDING"],
  nextStatus: "FULFILLED",
};
