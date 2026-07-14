import { createHash } from "node:crypto";
import { formatFixed, normalizeFixed, parseFixed } from "./decimal.js";
import type { StockPostingInput } from "./types.js";

export const STOCK_POSTING_HASH_VERSION = 1;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function movementSortKey(movement: StockPostingInput["movements"][number]): string {
  // IN precedes OUT for the same key. This permits an atomic quarantine IN +
  // disposition OUT while keeping deterministic line balances.
  const directionRank = movement.movementType === "IN" ? "0" : "1";
  return [movement.warehouseId, movement.itemId, movement.lotId, directionRank].join(":");
}

export function canonicalizePosting(input: StockPostingInput): {
  canonicalJson: string;
  requestHash: string;
  normalized: StockPostingInput;
} {
  const grouped = new Map<
    string,
    StockPostingInput["movements"][number] & { quantity: string; enteredQuantity: string }
  >();
  for (const movement of input.movements) {
    const candidate = {
      ...movement,
      quantity: normalizeFixed(movement.quantity, 6),
      enteredQuantity: normalizeFixed(movement.enteredQuantity ?? movement.quantity, 6),
      conversionFactor: normalizeFixed(movement.conversionFactor ?? "1", 8),
      unitCost: normalizeFixed(movement.unitCost ?? "0", 6),
      metadata: movement.metadata
        ? (canonicalValue(movement.metadata) as Record<string, unknown>)
        : undefined,
    };
    const aggregationKey = JSON.stringify(
      canonicalValue({
        warehouseId: candidate.warehouseId,
        itemId: candidate.itemId,
        lotId: candidate.lotId,
        movementType: candidate.movementType,
        enteredUom: candidate.enteredUom,
        conversionFactor: candidate.conversionFactor,
        unitCost: candidate.unitCost,
        reasonCode: candidate.reasonCode,
        sourcePolicy: candidate.sourcePolicy,
        metadata: candidate.metadata,
      }),
    );
    const existing = grouped.get(aggregationKey);
    if (existing) {
      existing.quantity = formatFixed(
        parseFixed(existing.quantity, 6) + parseFixed(candidate.quantity, 6),
        6,
      );
      existing.enteredQuantity = formatFixed(
        parseFixed(existing.enteredQuantity, 6) + parseFixed(candidate.enteredQuantity, 6),
        6,
      );
    } else {
      grouped.set(aggregationKey, candidate);
    }
  }

  const normalized: StockPostingInput = {
    ...input,
    movements: [...grouped.values()].sort((a, b) =>
      movementSortKey(a).localeCompare(movementSortKey(b)),
    ),
  };

  const canonicalJson = JSON.stringify(
    canonicalValue({
      hashVersion: STOCK_POSTING_HASH_VERSION,
      sourceModule: normalized.sourceModule,
      sourceDocumentNo: normalized.sourceDocumentNo,
      locationId: normalized.locationId,
      movements: normalized.movements,
    }),
  );
  const requestHash = createHash("sha256").update(canonicalJson).digest("hex");
  return { canonicalJson, requestHash, normalized };
}

export function hashPostingLine(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}
