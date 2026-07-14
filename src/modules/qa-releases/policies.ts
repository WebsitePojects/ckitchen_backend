import type { Role } from "../../db/schema.js";
import type { StockDocumentPolicy } from "../stock/types.js";
import type { StockReturnReasonCode } from "./types.js";

/**
 * No dedicated flag was seeded for QA Release by drizzle/0027's
 * operational_feature_flag INSERT (only stock.lot_writes, stock.transfers,
 * stock.returns, stock.production, stock.customer_order_fulfillment,
 * integration.middleware_processing, printing.spooling, and
 * stock.legacy_write_compatibility exist — see
 * drizzle/0027_enterprise_operations_foundation.sql:483-491) and this task
 * adds no new migration. Of the existing keys, "stock.returns" is the
 * correct fit: QA Release is the terminal step of the Stock Return Batch's
 * own lifecycle (D35-D46 §5 — "a reusable return may remain quarantined
 * until a separate QA Release moves it to HQ_MAIN" lives directly under
 * "Outlet return and disposition"), its only line provenance is the FK to
 * stock_return_receipt_line, and it only ever posts stock a Stock Return
 * Batch first quarantined. "stock.transfers" would be the wrong fit —
 * transfers/policies.ts's own route-pair comment explicitly excludes
 * QUARANTINE routes as "QA Release only", and transfer-order-lifecycle.test.ts
 * has a dedicated test asserting a QUARANTINE source/destination is
 * ROUTE_NOT_ALLOWED for that module.
 */
export const QA_RELEASE_FEATURE_KEY = "stock.returns";
export const QA_RELEASE_MODULE = "QA_RELEASE";

export const QA_RELEASE_MIN_LINES = 1;
// One posting movement pair (OUT@QUARANTINE + IN@HQ_MAIN) per line, so 250
// lines stays within the central stock posting service's 500-movement cap
// (mirrors STOCK_RETURN_MAX_LINES's identical reasoning).
export const QA_RELEASE_MAX_LINES = 250;

// QA Release happens entirely within HQ custody (QUARANTINE -> HQ_MAIN, both
// HQ-only warehouse purposes per the qa_release_route_check DB trigger), so
// only HQ-tier roles participate — mirrors STOCK_RETURN_RECEIVE_ROLES
// (stock-returns/policies.ts), the other module whose whole job is HQ-side
// custody of the same quarantine warehouse.
export const QA_RELEASE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN"];
// Approval is a maker-checker gate (mirrors STOCK_RETURN_APPROVE_ROLES /
// TRANSFER_APPROVE_ROLES): the submitter cannot also approve their own
// release.
export const QA_RELEASE_APPROVE_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN"];

/**
 * D35-D46 §5's return reason taxonomy (stock_return_reason: SPOILED, EXPIRED,
 * DAMAGED, RECALLED, OTHER — see src/db/returns-schema.ts) has no dedicated
 * "reusable" value. Four of the five values name a physical condition that is
 * inherently non-reusable (spoiled/expired/damaged/recalled goods cannot
 * legally or safely re-enter HQ_MAIN allocatable stock); OTHER is the only
 * value left to represent every reusable-return scenario (wrong item
 * returned, customer changed their mind, outlet overstock sent back intact,
 * etc.). A stock_return_receipt_line's dispositionReasonCode NOT in this set
 * is refused at QA Release line resolution as REASON_NOT_RELEASABLE.
 */
export const QA_RELEASE_RELEASABLE_REASONS: ReadonlySet<StockReturnReasonCode> = new Set(["OTHER"]);

/**
 * Server-owned policy for the central stock posting service
 * (src/modules/stock/posting-service.ts, QA_RELEASE route class — see that
 * file's validateRoute() and src/modules/stock/types.ts's StockRouteClass/
 * SourceEligibilityPolicy for why this route class had to be added: no
 * existing route class legally permits an OUT@QUARANTINE movement). Registered
 * under QA_RELEASE_MODULE so the OUT@QUARANTINE + IN@HQ_MAIN movement pair
 * release() issues can only advance a QA_RELEASE operational_document from
 * APPROVED to RELEASED, gated by the stock.returns feature flag (plus the
 * posting service's own DB-wide "stock.lot_writes" flag).
 */
export const QA_RELEASE_POSTING_POLICY: StockDocumentPolicy = {
  featureFlag: QA_RELEASE_FEATURE_KEY,
  routeClass: "QA_RELEASE",
  allowedRoles: QA_RELEASE_ROLES,
  fromStatuses: ["APPROVED"],
  nextStatus: "RELEASED",
};
