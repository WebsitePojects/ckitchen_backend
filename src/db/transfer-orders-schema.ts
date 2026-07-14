/**
 * ORION HQ Transfer Order + QA Release schema (D35-D46 §2 — allowed stock routes).
 *
 * Additive/dark: introduces two document families that the future central
 * posting service (src/modules/stock/posting-service.ts, `HQ_TRANSFER` route
 * class) will use to move stock HQ_MAIN/PRODUCTION -> OUTLET_STORAGE/
 * PRODUCTION/HQ_MAIN (Transfer Order), and HQ QUARANTINE -> HQ_MAIN for
 * reusable returned stock (QA Release). No posting/service/route wiring
 * happens in this migration; only schema.
 *
 * Route legality per D35-D46 §2 is a table keyed on warehouse *purpose*
 * (HQ_MAIN, OUTLET_STORAGE, KITCHEN, PRODUCTION, QUARANTINE), not on the
 * warehouse row's identity — the same shape `posting-service.ts` already
 * enforces for its other route classes (`validateRoute`). A CHECK constraint
 * cannot join out to `warehouse.purpose` to validate the *pair* of nodes
 * against that multi-row table, so Transfer Order full route legality stays
 * service-level; only `source_warehouse_id <> destination_warehouse_id` and
 * quantity/status/version invariants are enforced here.
 *
 * QA Release is narrower: exactly one fixed route (QUARANTINE -> HQ_MAIN), so
 * unlike Transfer Order it CAN be pinned at the DB layer with a single-row
 * purpose lookup per referenced warehouse (see `qa_release_route_check`
 * below), the same pattern `job_order_production_warehouse_check` (0029) uses
 * to pin `job_order.production_warehouse_id` to a single required purpose.
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
import { stockReturnReceiptLines } from "./returns-schema.js";
import { ingredients, locations, users, warehouses } from "./schema.js";

export const transferOrderStatusEnum = pgEnum("transfer_order_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "DISPATCHED",
  "RECEIVED",
  "CANCELLED",
]);

export const qaReleaseStatusEnum = pgEnum("qa_release_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "RELEASED",
  "CANCELLED",
]);

// ---------------------------------------------------------------------------
// HQ Transfer Order — HQ_MAIN/PRODUCTION -> OUTLET_STORAGE/PRODUCTION/HQ_MAIN
// ---------------------------------------------------------------------------

/**
 * Header. Source/destination warehouse are set once and never repointed after
 * creation (D35-D46 §2/§5 convention: redistribution/correction always
 * happens through a new linked document, never by mutating an existing
 * document's route). Location snapshots mirror the warehouse's outlet at
 * creation time so reports/audit never need to re-derive it from a warehouse
 * row that could theoretically be reassigned later.
 */
export const transferOrders = pgTable(
  "transfer_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentNo: text("document_no").notNull(),
    status: transferOrderStatusEnum("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    sourceWarehouseId: uuid("source_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    destinationWarehouseId: uuid("destination_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    sourceLocationId: uuid("source_location_id")
      .notNull()
      .references(() => locations.id),
    destinationLocationId: uuid("destination_location_id")
      .notNull()
      .references(() => locations.id),
    // Each links to exactly one operational_document, whose own uniqueness on
    // stock_posting_id (0027 operational_document_posting_unique) is what lets
    // the posting service advance dispatch and receipt exactly once each —
    // same convention as stock_return_batch (0028).
    dispatchDocumentId: uuid("dispatch_document_id").references(() => operationalDocuments.id),
    receiptDocumentId: uuid("receipt_document_id").references(() => operationalDocuments.id),
    remarks: text("remarks"),
    requestedBy: uuid("requested_by").references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    dispatchedBy: uuid("dispatched_by").references(() => users.id),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transfer_order_document_no_unique").on(table.documentNo),
    uniqueIndex("transfer_order_dispatch_document_unique")
      .on(table.dispatchDocumentId)
      .where(sql`${table.dispatchDocumentId} IS NOT NULL`),
    uniqueIndex("transfer_order_receipt_document_unique")
      .on(table.receiptDocumentId)
      .where(sql`${table.receiptDocumentId} IS NOT NULL`),
    index("transfer_order_source_status_idx").on(table.sourceWarehouseId, table.status),
    index("transfer_order_destination_status_idx").on(table.destinationWarehouseId, table.status),
    check("transfer_order_version_positive", sql`${table.version} > 0`),
    check(
      "transfer_order_source_destination_distinct",
      sql`${table.sourceWarehouseId} <> ${table.destinationWarehouseId}`,
    ),
  ],
).enableRLS();

/**
 * Body. `lotId` is nullable until lot allocation happens (FEFO, at dispatch
 * time — mirrors how `job_order_component_allocation.source_lot_id` stays
 * null at plan/RELEASE time and is filled in only once the posting service
 * actually selects a lot, D35-D46 §4). `dispatchedQuantity`/`receivedQuantity`
 * are base-UOM snapshots of what the posting service actually moved at each
 * phase; both stay null until their phase posts.
 *
 * `dispatchPostingLineId`/`receiptPostingLineId` give per-line traceability
 * into `stock_posting_line`, mirroring `stock_return_receipt_line`'s
 * `quarantine_in_posting_line_id`/`disposition_out_posting_line_id` pair.
 * Unlike a Stock Return Batch (whose dispatch and receipt are two separate
 * tables), a Transfer Order's dispatch and receipt are two phases of the
 * SAME line row, so the append-only guard below is phase-aware rather than a
 * blanket `forbid_mutation()`: the `dispatch_posting_line_id` value, once
 * set, cannot be repointed, and the entire row becomes immutable only once
 * `receipt_posting_line_id` is set (posting fully complete for that line).
 */
export const transferOrderLines = pgTable(
  "transfer_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => transferOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    lotId: uuid("lot_id").references(() => inventoryLots.id),
    enteredUom: text("entered_uom").notNull(),
    enteredQuantity: numeric("entered_quantity", { precision: 20, scale: 6 }).notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 6 }).notNull(),
    dispatchedQuantity: numeric("dispatched_quantity", { precision: 20, scale: 6 }),
    receivedQuantity: numeric("received_quantity", { precision: 20, scale: 6 }),
    status: transferOrderStatusEnum("status").notNull().default("DRAFT"),
    dispatchPostingLineId: uuid("dispatch_posting_line_id").references(() => stockPostingLines.id),
    receiptPostingLineId: uuid("receipt_posting_line_id").references(() => stockPostingLines.id),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transfer_order_line_order_line_unique").on(table.orderId, table.lineNo),
    uniqueIndex("transfer_order_line_dispatch_posting_unique")
      .on(table.dispatchPostingLineId)
      .where(sql`${table.dispatchPostingLineId} IS NOT NULL`),
    uniqueIndex("transfer_order_line_receipt_posting_unique")
      .on(table.receiptPostingLineId)
      .where(sql`${table.receiptPostingLineId} IS NOT NULL`),
    index("transfer_order_line_item_lot_idx").on(table.itemId, table.lotId),
    index("transfer_order_line_order_status_idx").on(table.orderId, table.status),
    check("transfer_order_line_number_positive", sql`${table.lineNo} > 0`),
    check("transfer_order_line_entered_qty_positive", sql`${table.enteredQuantity} > 0`),
    check("transfer_order_line_conversion_positive", sql`${table.conversionFactor} > 0`),
    check("transfer_order_line_base_qty_positive", sql`${table.baseQuantity} > 0`),
    check(
      "transfer_order_line_dispatched_qty_nonnegative",
      sql`${table.dispatchedQuantity} IS NULL OR ${table.dispatchedQuantity} >= 0`,
    ),
    check(
      "transfer_order_line_received_qty_nonnegative",
      sql`${table.receivedQuantity} IS NULL OR ${table.receivedQuantity} >= 0`,
    ),
    check(
      "transfer_order_line_received_lte_dispatched",
      sql`${table.receivedQuantity} IS NULL OR (${table.dispatchedQuantity} IS NOT NULL AND ${table.receivedQuantity} <= ${table.dispatchedQuantity})`,
    ),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// QA Release — HQ QUARANTINE -> HQ_MAIN, reusable returned stock only
// ---------------------------------------------------------------------------

/**
 * Header. Fixed route (QUARANTINE -> HQ_MAIN) pinned by the
 * `qa_release_route_check` trigger in the migration, in addition to the
 * plain `source_warehouse_id <> destination_warehouse_id` CHECK kept for
 * symmetry with `transfer_order`.
 */
export const qaReleases = pgTable(
  "qa_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentNo: text("document_no").notNull(),
    status: qaReleaseStatusEnum("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    sourceWarehouseId: uuid("source_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    destinationWarehouseId: uuid("destination_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    releaseDocumentId: uuid("release_document_id").references(() => operationalDocuments.id),
    remarks: text("remarks"),
    requestedBy: uuid("requested_by").references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("qa_release_document_no_unique").on(table.documentNo),
    uniqueIndex("qa_release_release_document_unique")
      .on(table.releaseDocumentId)
      .where(sql`${table.releaseDocumentId} IS NOT NULL`),
    index("qa_release_source_status_idx").on(table.sourceWarehouseId, table.status),
    index("qa_release_destination_status_idx").on(table.destinationWarehouseId, table.status),
    check("qa_release_version_positive", sql`${table.version} > 0`),
    check(
      "qa_release_source_destination_distinct",
      sql`${table.sourceWarehouseId} <> ${table.destinationWarehouseId}`,
    ),
  ],
).enableRLS();

/**
 * Body. `sourceReturnReceiptLineId` is the provenance FK: the only existing
 * quarantine-IN event in the schema is `stock_return_receipt_line`
 * (`quarantine_in_posting_line_id`, 0028), so every QA-released quantity must
 * trace back to the batch line that quarantined it (D35-D46 §5: "a reusable
 * return may remain quarantined until a separate QA Release moves it to
 * HQ_MAIN"). It is intentionally NOT unique — a single receipt line's
 * quarantined quantity may be released across more than one QA Release over
 * time; the running "quantity already released must not exceed quantity
 * quarantined" balance check is service-level (needs a SUM across sibling
 * release lines, which a CHECK constraint cannot express).
 *
 * `quarantineLotId`/`itemId` are snapshotted directly on the line (same
 * convention as `stock_return_batch_line` snapshotting item/lot rather than
 * forcing every reader to join through the batch), even though both are
 * technically derivable via `sourceReturnReceiptLineId`.
 */
export const qaReleaseLines = pgTable(
  "qa_release_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => qaReleases.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    quarantineLotId: uuid("quarantine_lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    sourceReturnReceiptLineId: uuid("source_return_receipt_line_id")
      .notNull()
      .references(() => stockReturnReceiptLines.id),
    releaseQuantity: numeric("release_quantity", { precision: 20, scale: 6 }).notNull(),
    enteredUom: text("entered_uom").notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    releasePostingLineId: uuid("release_posting_line_id").references(() => stockPostingLines.id),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("qa_release_line_release_line_unique").on(table.releaseId, table.lineNo),
    uniqueIndex("qa_release_line_release_posting_unique")
      .on(table.releasePostingLineId)
      .where(sql`${table.releasePostingLineId} IS NOT NULL`),
    index("qa_release_line_item_lot_idx").on(table.itemId, table.quarantineLotId),
    index("qa_release_line_source_receipt_line_idx").on(table.sourceReturnReceiptLineId),
    check("qa_release_line_number_positive", sql`${table.lineNo} > 0`),
    check("qa_release_line_release_qty_positive", sql`${table.releaseQuantity} > 0`),
    check("qa_release_line_conversion_positive", sql`${table.conversionFactor} > 0`),
  ],
).enableRLS();

export type TransferOrder = typeof transferOrders.$inferSelect;
export type NewTransferOrder = typeof transferOrders.$inferInsert;
export type TransferOrderLine = typeof transferOrderLines.$inferSelect;
export type NewTransferOrderLine = typeof transferOrderLines.$inferInsert;
export type QaRelease = typeof qaReleases.$inferSelect;
export type NewQaRelease = typeof qaReleases.$inferInsert;
export type QaReleaseLine = typeof qaReleaseLines.$inferSelect;
export type NewQaReleaseLine = typeof qaReleaseLines.$inferInsert;
