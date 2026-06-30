/**
 * ERP R1 — Universal Stock Ledger helper
 *
 * postLedger() inserts a single row into stock_ledger_entry inside the
 * caller's Drizzle transaction (atomic with the balance change).
 *
 * Idempotency: uses onConflictDoNothing on the UNIQUE constraint
 *   (source_module, source_document_no, source_line_no).
 * When source_line_no is null the unique key collapses to
 *   (source_module, source_document_no, NULL) — Postgres treats each NULL
 *   as distinct, so we derive a deterministic synthetic key for null-line
 *   rows using a sentinel string "_" + warehouseId + ingredientId instead.
 *
 * This module does NOT touch inventoryStock. Balance mutations remain in the
 * existing route/service code.
 */
import type { DB } from "../../db/client.js";
import { stockLedgerEntries } from "../../db/schema.js";

// The Drizzle transaction type is the same shape as DB for our purposes
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface PostLedgerInput {
  /** One of the allowed source modules. */
  sourceModule: "RECEIVE" | "ITO" | "ORDER_DEDUCTION" | "ADJUSTMENT" | "RESTOCK";
  /**
   * Unique document identifier (e.g. ITO id, order id, or a generated receive ref).
   * Combined with sourceModule (and sourceLineNo) for the idempotency key.
   */
  sourceDocumentNo: string;
  /**
   * Optional line discriminator within a document (e.g. ingredient id within an ITO,
   * or ingredient id within an order deduction). When null the unique key is
   * (module, documentNo, NULL) — Postgres NULL != NULL so each null-line call is
   * actually always inserted. To make single-item receives idempotent, callers should
   * pass a synthetic line key (e.g. ingredientId) when there is no natural line number.
   */
  sourceLineNo?: string | null;
  ingredientId: string;
  warehouseId: string;
  movementType: "IN" | "OUT";
  quantity: number | string;
  unitCost?: number | string;
  encoderUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert a stock ledger row inside an existing Drizzle transaction.
 * Silently skips if the unique key already exists (idempotent).
 *
 * MUST be called with the same `tx` that mutates inventoryStock so the
 * ledger row and the balance change commit or roll back together.
 */
export async function postLedger(tx: Tx, entry: PostLedgerInput): Promise<void> {
  await tx
    .insert(stockLedgerEntries)
    .values({
      sourceModule: entry.sourceModule,
      sourceDocumentNo: entry.sourceDocumentNo,
      sourceLineNo: entry.sourceLineNo ?? null,
      ingredientId: entry.ingredientId,
      warehouseId: entry.warehouseId,
      movementType: entry.movementType,
      quantity: String(entry.quantity),
      unitCost: entry.unitCost != null ? String(entry.unitCost) : "0",
      encoderUserId: entry.encoderUserId ?? null,
      metadata: entry.metadata ?? null,
    })
    .onConflictDoNothing();
}
