/**
 * DTOs for the HQ Transfer Order LIFECYCLE service (create/update/submit/
 * approve/cancel/dispatch/receive/read).
 */
import type {
  transferOrderStatusEnum,
  TransferOrder,
  TransferOrderLine,
} from "../../db/transfer-orders-schema.js";

export type TransferOrderStatus = (typeof transferOrderStatusEnum.enumValues)[number];

/**
 * A caller-supplied transfer line. `lotId` is an OPTIONAL pin: when omitted,
 * dispatchTransferOrder() FEFO-selects a single eligible lot at dispatch time
 * (transfer_order_line has exactly one nullable `lot_id` column — no sibling
 * allocation table like Job Order's component allocations — so unlike
 * production's FEFO helper, a line's need must be coverable by ONE lot; a
 * caller that needs a specific lot, or needs to split one item across
 * multiple lots, expresses that as a pinned lotId per line / multiple lines).
 * Deliberately has NO client-supplied base `baseQuantity` or
 * `conversionFactor` — the service always derives both from the item's
 * configured UOM conversion.
 */
export interface TransferOrderLineInput {
  itemId: string;
  lotId?: string | null;
  enteredQuantity: string | number;
  enteredUom: string;
  remarks?: string | null;
}

export interface CreateTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  remarks?: string | null;
  lines: TransferOrderLineInput[];
}

export interface UpdateTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
  /** Use `"remarks" in input` to distinguish "omitted" from "explicitly null". */
  remarks?: string | null;
  /** When provided, fully replaces the order's line set. */
  lines?: TransferOrderLineInput[];
}

export interface SubmitTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
}

export interface ApproveTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
}

export interface CancelTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
  cancelReason: string;
}

export interface DispatchTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
}

/**
 * One HQ-side/destination receipt decision per order line. Deliberately
 * OPTIONAL and quantity-only (no reason code, unlike Stock Return Batch's
 * disposition receipt): omitting a line's entry receives the FULL dispatched
 * quantity; a caller may supply a smaller `receivedQuantity` to record
 * transit shortage/breakage (DB-enforced `received_quantity <= dispatched_quantity`).
 */
export interface TransferOrderReceiptLineInput {
  lineId: string;
  receivedQuantity?: string | number;
}

export interface ReceiveTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
  receiptLines?: TransferOrderReceiptLineInput[];
}

export interface GetTransferOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
}

export interface ListTransferOrdersInput {
  actorUserId: string;
  sessionId?: string | null;
  sourceLocationId?: string;
  destinationLocationId?: string;
  status?: TransferOrderStatus;
  /** Case-insensitive substring match against the order's document_no. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TransferOrderWithLines extends TransferOrder {
  lines: TransferOrderLine[];
}

export type { TransferOrder, TransferOrderLine };
