/**
 * ORION Stock Return Batch schema (D35-D46 §5 — outlet return and disposition).
 *
 * Additive/dark: introduces the outlet -> HQ Stock Return Batch header, its
 * multi-line body, and the HQ receipt/disposition evidence that the central
 * posting service (src/modules/stock/posting-service.ts) will later use to
 * atomically post QUARANTINE IN + DISPOSITION OUT. No posting/service/route
 * wiring happens in this migration; only schema.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { inventoryLots, operationalDocuments, stockPostingLines } from "./enterprise-schema.js";
import { ingredients, locations, users, warehouses } from "./schema.js";

export const stockReturnBatchStatusEnum = pgEnum("stock_return_batch_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "DISPATCHED",
  "RECEIVED_DISPOSED",
  "CANCELLED",
]);

export const stockReturnReasonEnum = pgEnum("stock_return_reason", [
  "SPOILED",
  "EXPIRED",
  "DAMAGED",
  "RECALLED",
  "OTHER",
]);

/**
 * Header. Source outlet and HQ destination are set once at DRAFT creation and
 * never change — redistribution/correction always happens through a new
 * linked document, never by mutating an existing batch's route (D35-D46 §2).
 */
export const stockReturnBatches = pgTable(
  "stock_return_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentNo: text("document_no").notNull(),
    sourceLocationId: uuid("source_location_id")
      .notNull()
      .references(() => locations.id),
    destinationLocationId: uuid("destination_location_id")
      .notNull()
      .references(() => locations.id),
    destinationWarehouseId: uuid("destination_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    status: stockReturnBatchStatusEnum("status").notNull().default("DRAFT"),
    remarks: text("remarks"),
    version: integer("version").notNull().default(1),
    // Each links to exactly one operational_document, whose own uniqueness on
    // stock_posting_id (0027 operational_document_posting_unique) is what lets
    // the posting service advance dispatch and receipt exactly once each.
    dispatchDocumentId: uuid("dispatch_document_id").references(() => operationalDocuments.id),
    receiptDocumentId: uuid("receipt_document_id").references(() => operationalDocuments.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    dispatchedBy: uuid("dispatched_by").references(() => users.id),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_return_batch_document_no_unique").on(table.documentNo),
    uniqueIndex("stock_return_batch_dispatch_document_unique")
      .on(table.dispatchDocumentId)
      .where(sql`${table.dispatchDocumentId} IS NOT NULL`),
    uniqueIndex("stock_return_batch_receipt_document_unique")
      .on(table.receiptDocumentId)
      .where(sql`${table.receiptDocumentId} IS NOT NULL`),
    index("stock_return_batch_source_status_idx").on(table.sourceLocationId, table.status),
    index("stock_return_batch_destination_status_idx").on(
      table.destinationLocationId,
      table.status,
    ),
    check("stock_return_batch_version_positive", sql`${table.version} > 0`),
    check(
      "stock_return_batch_source_destination_distinct",
      sql`${table.sourceLocationId} <> ${table.destinationLocationId}`,
    ),
  ],
).enableRLS();

/**
 * Body. One line per item/lot/source-warehouse movement out of the outlet.
 * Entered UOM + conversion factor are snapshotted on the line, matching the
 * stock_posting_line convention (0027) so quantity math never re-derives a
 * conversion after the fact.
 */
export const stockReturnBatchLines = pgTable(
  "stock_return_batch_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => stockReturnBatches.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    sourceWarehouseId: uuid("source_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    enteredQuantity: numeric("entered_quantity", { precision: 20, scale: 6 }).notNull(),
    enteredUom: text("entered_uom").notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    reasonCode: stockReturnReasonEnum("reason_code").notNull(),
    remarks: text("remarks"),
    evidenceRef: text("evidence_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_return_batch_line_batch_line_unique").on(table.batchId, table.lineNo),
    index("stock_return_batch_line_item_lot_idx").on(table.itemId, table.lotId),
    index("stock_return_batch_line_source_warehouse_idx").on(table.sourceWarehouseId),
    check("stock_return_batch_line_number_positive", sql`${table.lineNo} > 0`),
    check("stock_return_batch_line_qty_positive", sql`${table.quantity} > 0`),
    check("stock_return_batch_line_entered_qty_positive", sql`${table.enteredQuantity} > 0`),
    check("stock_return_batch_line_conversion_positive", sql`${table.conversionFactor} > 0`),
  ],
).enableRLS();

/**
 * HQ receipt/disposition evidence, one row per batch line. The unique
 * `batch_line_id` makes receipt exactly-once/replay-safe: the posting service
 * can only ever insert one QUARANTINE IN + DISPOSITION OUT pair per line, and
 * the two posting-line links (once set) are individually unique so no other
 * line can reuse either ledger row (D35-D46 §5: "never becomes allocatable
 * HQ stock", "duplicate receipt/disposition cannot move stock twice").
 */
export const stockReturnReceiptLines = pgTable(
  "stock_return_receipt_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchLineId: uuid("batch_line_id")
      .notNull()
      .references(() => stockReturnBatchLines.id),
    quarantineLotId: uuid("quarantine_lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    receivedQuantity: numeric("received_quantity", { precision: 20, scale: 6 }).notNull(),
    dispositionReasonCode: stockReturnReasonEnum("disposition_reason_code").notNull(),
    dispositionRemarks: text("disposition_remarks"),
    quarantineInPostingLineId: uuid("quarantine_in_posting_line_id").references(
      () => stockPostingLines.id,
    ),
    dispositionOutPostingLineId: uuid("disposition_out_posting_line_id").references(
      () => stockPostingLines.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_return_receipt_line_batch_line_unique").on(table.batchLineId),
    uniqueIndex("stock_return_receipt_line_quarantine_in_unique")
      .on(table.quarantineInPostingLineId)
      .where(sql`${table.quarantineInPostingLineId} IS NOT NULL`),
    uniqueIndex("stock_return_receipt_line_disposition_out_unique")
      .on(table.dispositionOutPostingLineId)
      .where(sql`${table.dispositionOutPostingLineId} IS NOT NULL`),
    check("stock_return_receipt_line_qty_nonnegative", sql`${table.receivedQuantity} >= 0`),
    check(
      "stock_return_receipt_line_posting_lines_distinct",
      sql`${table.quarantineInPostingLineId} IS NULL OR ${table.dispositionOutPostingLineId} IS NULL OR ${table.quarantineInPostingLineId} <> ${table.dispositionOutPostingLineId}`,
    ),
  ],
).enableRLS();

export type StockReturnBatch = typeof stockReturnBatches.$inferSelect;
export type NewStockReturnBatch = typeof stockReturnBatches.$inferInsert;
export type StockReturnBatchLine = typeof stockReturnBatchLines.$inferSelect;
export type NewStockReturnBatchLine = typeof stockReturnBatchLines.$inferInsert;
export type StockReturnReceiptLine = typeof stockReturnReceiptLines.$inferSelect;
export type NewStockReturnReceiptLine = typeof stockReturnReceiptLines.$inferInsert;
