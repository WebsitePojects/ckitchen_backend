/**
 * Domain error for the BOM authoring/version-lifecycle service
 * (header/version/component authoring, activation, retirement, read only —
 * no Job Order code, no posting, no inventory mutation lives here). Styled
 * after src/modules/stock-returns/errors.ts StockReturnError.
 */
export class StockProductionError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "VALIDATION"
      | "INVALID_TRANSITION"
      | "UOM_MISMATCH"
      | "DUPLICATE_LINE"
      | "SELF_COMPONENT"
      | "CYCLE_DETECTED"
      | "CONCURRENT_MODIFICATION"
      | "TYPE_NOT_ALLOWED"
      | "WAREHOUSE_MISMATCH"
      | "SEGREGATION_OF_DUTIES"
      | "SCOPE_MISMATCH"
      | "INSUFFICIENT_STOCK",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "StockProductionError";
  }
}
