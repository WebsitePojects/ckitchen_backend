/**
 * DTOs for the Stock Return Batch LIFECYCLE service (create/update/submit/
 * approve/cancel/read). Deliberately excludes any dispatch/receipt posting
 * shapes — this module never touches inventory_lot_balances or the central
 * stock posting service.
 */
import type {
  stockReturnBatchStatusEnum,
  stockReturnReasonEnum,
  StockReturnBatch,
  StockReturnBatchLine,
} from "../../db/returns-schema.js";

export type StockReturnReasonCode = (typeof stockReturnReasonEnum.enumValues)[number];
export type StockReturnBatchStatus = (typeof stockReturnBatchStatusEnum.enumValues)[number];

/**
 * A caller-supplied return line. Deliberately has NO client-supplied base
 * `quantity` or `conversionFactor` — the service always derives both from the
 * item's configured UOM conversion so an entered-qty-to-base-qty mismatch can
 * never be smuggled in by the client.
 */
export interface StockReturnLineInput {
  itemId: string;
  lotId: string;
  sourceWarehouseId: string;
  enteredQuantity: string | number;
  enteredUom: string;
  reasonCode: StockReturnReasonCode;
  remarks?: string | null;
  evidenceRef?: string | null;
}

export interface CreateStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  sourceLocationId: string;
  remarks?: string | null;
  lines: StockReturnLineInput[];
}

export interface UpdateStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
  /** Use `"remarks" in input` to distinguish "omitted" from "explicitly null". */
  remarks?: string | null;
  /** When provided, fully replaces the batch's line set. */
  lines?: StockReturnLineInput[];
}

export interface SubmitStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
}

export interface ApproveStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
}

export interface CancelStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
  cancelReason: string;
}

export interface GetStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
}

export interface ListStockReturnBatchesInput {
  actorUserId: string;
  sessionId?: string | null;
  sourceLocationId?: string;
  status?: StockReturnBatchStatus;
  /** Case-insensitive substring match against the batch's document_no. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListStockReturnBatchesPage {
  items: StockReturnBatch[];
  total: number;
}

export interface StockReturnBatchWithLines extends StockReturnBatch {
  lines: StockReturnBatchLine[];
}

/**
 * One HQ receipt/disposition decision per batch line. Deliberately has NO
 * client-supplied quantity — the receipt always disposes the full dispatched
 * line quantity, so a partial-quantity mismatch can never be smuggled in.
 */
export interface ReceiptLineInput {
  batchLineId: string;
  dispositionReasonCode: StockReturnReasonCode;
  dispositionRemarks?: string | null;
}

export interface ReceiveAndDisposeStockReturnBatchInput {
  actorUserId: string;
  sessionId?: string | null;
  batchId: string;
  expectedVersion: number;
  receiptLines: ReceiptLineInput[];
}

export type { StockReturnBatch, StockReturnBatchLine };
