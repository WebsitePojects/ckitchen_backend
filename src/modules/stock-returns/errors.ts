/**
 * Domain error for the Stock Return Batch LIFECYCLE service
 * (create/update/submit/approve/cancel/read only — no dispatch/receipt
 * posting lives here). Styled after src/modules/stock/errors.ts
 * StockPostingError.
 */
export class StockReturnError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "VALIDATION"
      | "INVALID_TRANSITION"
      | "UOM_MISMATCH"
      | "LOT_NOT_ELIGIBLE"
      | "FORBIDDEN_ROUTE"
      | "DUPLICATE_LINE"
      | "TOPOLOGY_NOT_READY"
      | "SEGREGATION_OF_DUTIES"
      | "CONCURRENT_MODIFICATION",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "StockReturnError";
  }
}
