/**
 * Domain error for the QA Release LIFECYCLE service
 * (create/update/submit/approve/cancel/release/read). Styled after
 * src/modules/transfers/errors.ts TransferOrderError. `REASON_NOT_RELEASABLE`
 * and `INSUFFICIENT_QUARANTINE_BALANCE` are specific to this module: the
 * former is the D35-D46 §5 reusable-vs-disposition line eligibility gate (see
 * QA_RELEASE_RELEASABLE_REASONS in policies.ts); the latter is the document-
 * bookkeeping "remaining = quarantined receipt quantity minus prior ACTIVE/
 * RELEASED sibling releases" soft check (service.ts resolveAndValidateLines)
 * — the central stock posting service's own FOR UPDATE + on-hand balance
 * check at release() time remains the actual hard safety net, exactly as
 * src/modules/customer-orders/allocation.ts's own doc comment describes for
 * its analogous soft/hard validation split.
 */
export class QaReleaseError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "VALIDATION"
      | "INVALID_TRANSITION"
      | "REASON_NOT_RELEASABLE"
      | "UOM_MISMATCH"
      | "LOT_NOT_ELIGIBLE"
      | "INSUFFICIENT_QUARANTINE_BALANCE"
      | "DUPLICATE_LINE"
      | "SEGREGATION_OF_DUTIES"
      | "TOPOLOGY_NOT_READY"
      | "CONCURRENT_MODIFICATION",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "QaReleaseError";
  }
}
