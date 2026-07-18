/**
 * Domain error for the outbound aggregator command module (AGGREGATOR_API_
 * INTEGRATION_SPEC.md §4-5). Styled after src/modules/middleware/errors.ts
 * MiddlewareError / src/modules/customer-orders/errors.ts CustomerOrderError.
 */
export class OutboundError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "VALIDATION"
      | "CONTROL_MODE"
      | "OUT_OF_ORDER"
      | "FEATURE_DISABLED"
      | "CONFLICT",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "OutboundError";
  }
}
