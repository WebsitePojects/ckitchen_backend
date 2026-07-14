/**
 * Domain error for the HQ Transfer Order LIFECYCLE service
 * (create/update/submit/approve/cancel/dispatch/receive/read). Styled after
 * src/modules/stock-returns/errors.ts StockReturnError. `ROUTE_NOT_ALLOWED`
 * is specific to this module: the service-level check against D35-D46 §2's
 * (source purpose, destination purpose) route table, which cannot be
 * expressed as a DB CHECK constraint (see src/db/transfer-orders-schema.ts
 * header comment) because it would need to join out to `warehouse.purpose`
 * for BOTH referenced warehouses against a multi-row legality table.
 */
export class TransferOrderError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "VALIDATION"
      | "INVALID_TRANSITION"
      | "ROUTE_NOT_ALLOWED"
      | "UOM_MISMATCH"
      | "LOT_NOT_ELIGIBLE"
      | "INSUFFICIENT_STOCK"
      | "DUPLICATE_LINE"
      | "SEGREGATION_OF_DUTIES"
      | "CONCURRENT_MODIFICATION",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TransferOrderError";
  }
}
