export class StockPostingError extends Error {
  constructor(
    public readonly code:
      | "FEATURE_DISABLED"
      | "UNAUTHORIZED"
      | "DOCUMENT_NOT_FOUND"
      | "INVALID_TRANSITION"
      | "IDEMPOTENCY_KEY_REUSED"
      | "POSTING_IN_PROGRESS"
      | "INVALID_MOVEMENT"
      | "LOT_NOT_FOUND"
      | "LOT_ITEM_MISMATCH"
      | "LOT_NOT_ELIGIBLE"
      | "UOM_MISMATCH"
      | "FORBIDDEN_ROUTE"
      | "INSUFFICIENT_STOCK"
      | "CONCURRENT_MODIFICATION"
      | "LEDGER_MISMATCH",
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "StockPostingError";
  }
}

export function findSqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    cursor = candidate.cause;
  }
  return undefined;
}
