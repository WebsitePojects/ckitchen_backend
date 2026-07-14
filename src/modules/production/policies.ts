import type { Role } from "../../db/schema.js";
import type { StockDocumentPolicy } from "../stock/types.js";

export const STOCK_PRODUCTION_FEATURE_KEY = "stock.production";

// General access: create/version/author-components/activate/retire/read. No
// separate approve-tier role exists for BOM authoring (unlike stock-returns'
// maker-checker submit/approve split) — activation IS the approval act here,
// and the same role set performs it.
export const STOCK_PRODUCTION_ROLES: readonly Role[] = ["OWNER", "WAREHOUSE_MAIN"];

/** operational_document module namespaces for the two documents a Job Order release links. */
export const PRODUCTION_CONSUME_MODULE = "PRODUCTION_CONSUME";
export const PRODUCTION_OUTPUT_MODULE = "PRODUCTION_OUTPUT";

export const BOM_COMPONENT_MIN_LINES = 1;
export const BOM_COMPONENT_MAX_LINES = 250;

export const ALLOWED_BOM_ITEM_TYPES = ["RAW", "WIP", "FINISHED_GOOD", "CONSUMABLE"] as const;

/**
 * Policy: activating a DRAFT bom_version automatically retires the header's
 * current ACTIVE version (if any) in the SAME transaction, atomically. This
 * is chosen because bom_version_one_active_per_header_unique (a partial
 * unique index on bom_header_id WHERE status = 'ACTIVE') means a second
 * ACTIVE row for the same header can never coexist at the DB level — the
 * service must either auto-retire the prior ACTIVE version or reject the
 * activation outright.
 *
 * Alternative considered: reject activateVersion() with INVALID_TRANSITION
 * whenever an ACTIVE version already exists, forcing the caller to retire it
 * explicitly first. Auto-retire is what this service implements instead,
 * because it keeps "publish a new revision" a single atomic call for the
 * caller rather than a two-step retire-then-activate dance, while still
 * producing two distinct audit log entries (bom.version.retired +
 * bom.version.activated) so the transition remains fully traceable.
 */
export const BOM_AUTO_RETIRE_ON_ACTIVATE = true;

/**
 * Server-owned policy for the central stock posting service
 * (src/modules/stock/posting-service.ts). Registered under
 * PRODUCTION_CONSUME_MODULE so the OUT movements that startJobOrder() issues
 * (drawn from the job's own PRODUCTION-purpose warehouse, FEFO-selected) can
 * only advance a PRODUCTION_CONSUME operational_document from PENDING to
 * CONSUMED, gated by the same stock.production feature flag (plus the
 * posting service's own DB-wide "stock.lot_writes" flag) as the rest of this
 * module.
 */
export const PRODUCTION_CONSUME_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_PRODUCTION_FEATURE_KEY,
  routeClass: "PRODUCTION",
  allowedRoles: STOCK_PRODUCTION_ROLES,
  fromStatuses: ["PENDING"],
  nextStatus: "CONSUMED",
};

/**
 * Server-owned policy for the central stock posting service
 * (src/modules/stock/posting-service.ts). Registered under
 * PRODUCTION_OUTPUT_MODULE so the single output IN movement that
 * completeJobOrder() issues (the job's actual-yield lot, produced into the
 * job's own PRODUCTION-purpose warehouse) can only advance a
 * PRODUCTION_OUTPUT operational_document from PENDING to COMPLETED, gated by
 * the same stock.production feature flag (plus the posting service's own
 * DB-wide "stock.lot_writes" flag) as PRODUCTION_CONSUME_POLICY above. That
 * PENDING document row is created once, at releaseJobOrder() time, and this
 * policy is the only thing ever allowed to advance it.
 */
export const PRODUCTION_OUTPUT_POLICY: StockDocumentPolicy = {
  featureFlag: STOCK_PRODUCTION_FEATURE_KEY,
  routeClass: "PRODUCTION",
  allowedRoles: STOCK_PRODUCTION_ROLES,
  fromStatuses: ["PENDING"],
  nextStatus: "COMPLETED",
};
