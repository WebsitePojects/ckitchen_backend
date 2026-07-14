// QUARANTINE_RELEASE shares DISPOSITION's quarantine-adjacent lot eligibility
// (see posting-service.ts isOutEligible's fallback branch: both permit only
// QUARANTINED/EXPIRED/SPOILED/RECALLED status lots to leave) but is kept as a
// distinct named value because the two route classes mean opposite business
// outcomes for the same eligibility set: RETURN_DISPOSITION's OUT is a
// terminal write-off, QA_RELEASE's OUT is reusable stock re-entering
// allocatable HQ_MAIN inventory (D35-D46 §5).
//
// QUARANTINE_HOLD marks a RETURN_DISPOSITION-route IN movement that
// deliberately has NO compensating disposition OUT: a reusable-reason
// (stock-returns' QA_RELEASE_RELEASABLE_REASONS) receipt line lands in HQ
// quarantine and stays there — an unpaired positive balance awaiting a
// separate QA Release — instead of being immediately zeroed out like every
// disposition-reason line (D35-D46 §5). Only consulted by posting-service.ts's
// RETURN_DISPOSITION route validation (to exempt the movement from that
// route's net-zero IN/OUT check); it carries no OUT-eligibility meaning of its
// own since it is only ever used on an IN movement.
export type SourceEligibilityPolicy =
  | "ALLOCATABLE"
  | "CUSTODY_MOVE"
  | "DISPOSITION"
  | "QUARANTINE_RELEASE"
  | "QUARANTINE_HOLD";
export type StockRouteClass =
  | "RECEIVE"
  | "ORDER_DEDUCTION"
  | "ADJUSTMENT"
  | "INTERNAL_TRANSFER"
  | "HQ_TRANSFER"
  | "OUTLET_RETURN_DISPATCH"
  | "RETURN_DISPOSITION"
  | "QA_RELEASE"
  | "PRODUCTION"
  | "OPENING_BALANCE";

export interface StockMovementInput {
  warehouseId: string;
  itemId: string;
  lotId: string;
  movementType: "IN" | "OUT";
  /** Quantity in the item's base UOM. Maximum six decimal places. */
  quantity: string | number;
  enteredQuantity?: string | number;
  enteredUom: string;
  conversionFactor?: string | number;
  unitCost?: string | number;
  reasonCode?: string;
  sourcePolicy?: SourceEligibilityPolicy;
  metadata?: Record<string, unknown>;
}

export interface StockPostingInput {
  idempotencyKey: string;
  sourceModule: string;
  sourceDocumentNo: string;
  locationId: string;
  actorUserId: string;
  sessionId?: string | null;
  correlationId: string;
  movements: StockMovementInput[];
}

export interface StockDocumentPolicy {
  featureFlag?: string;
  routeClass: StockRouteClass;
  allowedRoles: readonly string[];
  fromStatuses: readonly string[];
  nextStatus: string;
}

export interface StockPostingLineResult {
  lineNo: number;
  warehouseId: string;
  itemId: string;
  lotId: string;
  movementType: "IN" | "OUT";
  quantity: string;
  balanceBefore: string;
  balanceAfter: string;
}

export interface StockPostingResult {
  postingId: string;
  replayed: boolean;
  idempotencyKey: string;
  requestHash: string;
  sourceModule: string;
  sourceDocumentNo: string;
  lines: StockPostingLineResult[];
}

export type PostingFaultStage =
  | "after_claim"
  | "after_ledger"
  | "after_balance"
  | "after_document"
  | "after_audit"
  | "after_outbox";

export interface StockPostingDependencies {
  faultInjector?: (stage: PostingFaultStage) => void | Promise<void>;
  maxSerializationRetries?: number;
  documentPolicies: Readonly<Record<string, StockDocumentPolicy>>;
}
