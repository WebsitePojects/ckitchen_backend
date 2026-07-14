/**
 * Domain error for the Customer Order lifecycle service (create draft/update/
 * submit/approve/allocate/markInProduction/markReady/fulfill/cancel/read).
 * Styled after src/modules/production/errors.ts StockProductionError and
 * src/modules/stock-returns/errors.ts StockReturnError.
 */
export class CustomerOrderError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "VALIDATION"
      | "INVALID_TRANSITION"
      | "UOM_MISMATCH"
      | "DUPLICATE_LINE"
      | "CONCURRENT_MODIFICATION"
      | "SEGREGATION_OF_DUTIES"
      | "SCOPE_MISMATCH"
      | "CROSS_OUTLET"
      | "INSUFFICIENT_STOCK"
      | "JOB_ORDER_NOT_READY"
      | "CONSUMPTION_OWNER_INVALID",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CustomerOrderError";
  }
}
