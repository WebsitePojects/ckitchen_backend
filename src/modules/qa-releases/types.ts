/**
 * DTOs for the QA Release LIFECYCLE service (create/update/submit/approve/
 * cancel/release/read). Architectural template: src/modules/transfers/types.ts
 * (closest single-line-quantity-column stock document in this codebase).
 */
import type { stockReturnReasonEnum } from "../../db/returns-schema.js";
import type { qaReleaseStatusEnum, QaRelease, QaReleaseLine } from "../../db/transfer-orders-schema.js";

export type QaReleaseStatus = (typeof qaReleaseStatusEnum.enumValues)[number];
export type StockReturnReasonCode = (typeof stockReturnReasonEnum.enumValues)[number];

/**
 * A caller-supplied QA release line. Deliberately has NO client-supplied
 * `quarantineLotId`/`itemId` — the service always derives both server-side
 * from the referenced stock_return_receipt_line row (via its quarantine
 * lot), the same "never trust a client-declared route" convention
 * CreateStockReturnBatchInput's destination fields follow in
 * stock-returns/service.ts.
 */
export interface QaReleaseLineInput {
  sourceReturnReceiptLineId: string;
  enteredQuantity: string | number;
  enteredUom: string;
  remarks?: string | null;
}

export interface CreateQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  remarks?: string | null;
  lines: QaReleaseLineInput[];
}

export interface UpdateQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
  expectedVersion: number;
  /** Use `"remarks" in input` to distinguish "omitted" from "explicitly null". */
  remarks?: string | null;
  /** When provided, fully replaces the release's line set. */
  lines?: QaReleaseLineInput[];
}

export interface SubmitQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
  expectedVersion: number;
}

export interface ApproveQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
  expectedVersion: number;
}

export interface CancelQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
  expectedVersion: number;
  cancelReason: string;
}

export interface ReleaseQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
  expectedVersion: number;
}

export interface GetQaReleaseInput {
  actorUserId: string;
  sessionId?: string | null;
  releaseId: string;
}

export interface ListQaReleasesInput {
  actorUserId: string;
  sessionId?: string | null;
  status?: QaReleaseStatus;
  /** Case-insensitive substring match against the release's document_no. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QaReleaseWithLines extends QaRelease {
  lines: QaReleaseLine[];
}

export type { QaRelease, QaReleaseLine };
