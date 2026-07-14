/**
 * Domain error for the middleware webhook intake + processor (spec §11).
 * Styled after src/modules/customer-orders/errors.ts CustomerOrderError.
 */
export class MiddlewareError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SIGNATURE"
      | "INVALID_TIMESTAMP"
      | "UNKNOWN_KEY_ID"
      | "MALFORMED_PAYLOAD"
      | "MISSING_HEADER"
      | "EMPTY_BODY"
      | "FEATURE_DISABLED"
      | "NOT_FOUND"
      | "MAPPING_REQUIRED"
      | "QUARANTINED_EVENT"
      | "VALIDATION",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MiddlewareError";
  }
}
