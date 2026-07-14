/**
 * ORION BOM and production schema (D35-D46 §6 — BOM and production).
 *
 * Additive/dark: introduces the BOM header/version/component definition chain
 * and the Job Order issue/output chain that the future central posting service
 * (src/modules/stock/posting-service.ts, gated by the `stock.production`
 * feature flag — already seeded false in migration 0027) will use to post
 * component consumption and finished/WIP output atomically. This migration is
 * schema only: no posting/service/route wiring happens here.
 *
 * Component-lot -> output-lot traceability reuses the existing
 * `inventory_lot_genealogy` table (enterprise-schema.ts) rather than a new
 * genealogy table; a Job Order's `jobOrderNo` becomes that table's
 * `productionDocumentNo`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
import {
  inventoryLots,
  operationalDocuments,
  stockPostingLines,
} from "./enterprise-schema.js";
import { consumptionModeEnum, employees, ingredients, locations, users, warehouses } from "./schema.js";

export const bomVersionStatusEnum = pgEnum("bom_version_status", [
  "DRAFT",
  "ACTIVE",
  "RETIRED",
]);

export const jobOrderStatusEnum = pgEnum("job_order_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "RELEASED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

/**
 * BOM header. Identifies WHAT is produced (outputItemId) and in what mode.
 * Versions carry the actual recipe; the header stays stable across revisions.
 */
export const bomHeaders = pgTable(
  "bom_header",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    outputItemId: uuid("output_item_id")
      .notNull()
      .references(() => ingredients.id),
    productionMode: consumptionModeEnum("production_mode").notNull().default("MADE_TO_ORDER"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bom_header_code_unique").on(table.code),
    index("bom_header_output_item_idx").on(table.outputItemId),
  ],
).enableRLS();

/**
 * BOM version. Exactly one ACTIVE version may exist per header at any time
 * (partial unique index below) — this is what enforces "no overlapping active
 * version." Output identity fields become immutable once the version leaves
 * DRAFT (trigger `bom_version_write_guard` in the migration).
 */
export const bomVersions = pgTable(
  "bom_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bomHeaderId: uuid("bom_header_id")
      .notNull()
      .references(() => bomHeaders.id),
    versionNo: integer("version_no").notNull(),
    status: bomVersionStatusEnum("status").notNull().default("DRAFT"),
    outputUom: text("output_uom").notNull(),
    outputYieldQty: numeric("output_yield_qty", { precision: 20, scale: 6 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    remarks: text("remarks"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bom_version_header_version_unique").on(table.bomHeaderId, table.versionNo),
    uniqueIndex("bom_version_one_active_per_header_unique")
      .on(table.bomHeaderId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("bom_version_header_status_idx").on(table.bomHeaderId, table.status),
    check("bom_version_yield_positive", sql`${table.outputYieldQty} > 0`),
    check("bom_version_number_positive", sql`${table.versionNo} > 0`),
    check(
      "bom_version_effective_range_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
).enableRLS();

/**
 * BOM component lines. Frozen once the parent version leaves DRAFT (trigger
 * `bom_component_write_guard`); cannot self-reference the header's output item;
 * component item type must be a stock-postable type.
 */
export const bomComponents = pgTable(
  "bom_component",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bomVersionId: uuid("bom_version_id")
      .notNull()
      .references(() => bomVersions.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => ingredients.id),
    componentUom: text("component_uom").notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 6 }).notNull(),
    scrapAllowancePct: numeric("scrap_allowance_pct", { precision: 7, scale: 4 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bom_component_version_line_unique").on(table.bomVersionId, table.lineNo),
    uniqueIndex("bom_component_version_item_unique").on(table.bomVersionId, table.componentItemId),
    index("bom_component_item_idx").on(table.componentItemId),
    check("bom_component_line_positive", sql`${table.lineNo} > 0`),
    check("bom_component_qty_positive", sql`${table.baseQuantity} > 0`),
    check(
      "bom_component_scrap_pct_range",
      sql`${table.scrapAllowancePct} >= 0 AND ${table.scrapAllowancePct} < 100`,
    ),
  ],
).enableRLS();

/**
 * Job Order header. Stateful audited document tracking a single production run
 * of a specific BOM version at a specific outlet's PRODUCTION warehouse
 * (enforced by trigger `job_order_production_warehouse_check`). Links to the
 * generic operational_document/stock_posting chain for consume/output posting.
 */
export const jobOrders = pgTable(
  "job_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobOrderNo: text("job_order_no").notNull(),
    bomHeaderId: uuid("bom_header_id")
      .notNull()
      .references(() => bomHeaders.id),
    bomVersionId: uuid("bom_version_id")
      .notNull()
      .references(() => bomVersions.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    productionWarehouseId: uuid("production_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    status: jobOrderStatusEnum("status").notNull().default("DRAFT"),
    plannedOutputQty: numeric("planned_output_qty", { precision: 20, scale: 6 }).notNull(),
    actualOutputQty: numeric("actual_output_qty", { precision: 20, scale: 6 }),
    outputUom: text("output_uom").notNull(),
    version: integer("version").notNull().default(1),
    consumeDocumentId: uuid("consume_document_id").references(() => operationalDocuments.id),
    outputDocumentId: uuid("output_document_id").references(() => operationalDocuments.id),
    remarks: text("remarks"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    operatorId: uuid("operator_id").references(() => employees.id),
    operatorAssignedAt: timestamp("operator_assigned_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("job_order_no_unique").on(table.jobOrderNo),
    uniqueIndex("job_order_consume_document_unique")
      .on(table.consumeDocumentId)
      .where(sql`${table.consumeDocumentId} IS NOT NULL`),
    uniqueIndex("job_order_output_document_unique")
      .on(table.outputDocumentId)
      .where(sql`${table.outputDocumentId} IS NOT NULL`),
    index("job_order_location_status_idx").on(table.locationId, table.status),
    index("job_order_bom_version_idx").on(table.bomVersionId),
    check("job_order_planned_qty_positive", sql`${table.plannedOutputQty} > 0`),
    check(
      "job_order_actual_qty_nonnegative",
      sql`${table.actualOutputQty} IS NULL OR ${table.actualOutputQty} >= 0`,
    ),
    check("job_order_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

/**
 * Component allocation lines. Append-only once `consumePostingLineId` is set
 * (trigger `job_order_component_allocation_append_only`) — the posting service
 * may set it exactly once per line; nothing may mutate or delete it afterward.
 */
export const jobOrderComponentAllocations = pgTable(
  "job_order_component_allocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    bomComponentId: uuid("bom_component_id").references(() => bomComponents.id),
    componentItemId: uuid("component_item_id")
      .notNull()
      .references(() => ingredients.id),
    /**
     * Nullable: at RELEASE time the Job Order lifecycle service plans
     * component allocations by quantity only — lot selection (FEFO/etc.) is
     * the future posting service's job at actual consumption time, not this
     * service's (see `.claude/rules/business-rules.md` D46 "no inventory
     * mutation" boundary for this module).
     */
    sourceLotId: uuid("source_lot_id").references(() => inventoryLots.id),
    sourceWarehouseId: uuid("source_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    plannedQuantity: numeric("planned_quantity", { precision: 20, scale: 6 }).notNull(),
    allocatedQuantity: numeric("allocated_quantity", { precision: 20, scale: 6 }),
    enteredUom: text("entered_uom").notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    consumePostingLineId: uuid("consume_posting_line_id").references(() => stockPostingLines.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("job_order_component_allocation_job_line_unique").on(table.jobOrderId, table.lineNo),
    uniqueIndex("job_order_component_allocation_consume_posting_unique")
      .on(table.consumePostingLineId)
      .where(sql`${table.consumePostingLineId} IS NOT NULL`),
    index("job_order_component_allocation_job_idx").on(table.jobOrderId),
    index("job_order_component_allocation_lot_warehouse_idx").on(
      table.sourceLotId,
      table.sourceWarehouseId,
    ),
    check("job_order_component_allocation_line_positive", sql`${table.lineNo} > 0`),
    check(
      "job_order_component_allocation_planned_qty_positive",
      sql`${table.plannedQuantity} > 0`,
    ),
    check(
      "job_order_component_allocation_allocated_qty_nonnegative",
      sql`${table.allocatedQuantity} IS NULL OR ${table.allocatedQuantity} >= 0`,
    ),
    check(
      "job_order_component_allocation_conversion_positive",
      sql`${table.conversionFactor} > 0`,
    ),
  ],
).enableRLS();

/**
 * Output lot lines. Append-only once `outputPostingLineId` is set (trigger
 * `job_order_output_lot_append_only`), mirroring the component-allocation
 * append-only pattern.
 */
export const jobOrderOutputLots = pgTable(
  "job_order_output_lot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobOrderId: uuid("job_order_id")
      .notNull()
      .references(() => jobOrders.id, { onDelete: "cascade" }),
    outputLotId: uuid("output_lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    outputPostingLineId: uuid("output_posting_line_id").references(() => stockPostingLines.id),
    evidenceRef: text("evidence_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("job_order_output_lot_job_lot_unique").on(table.jobOrderId, table.outputLotId),
    uniqueIndex("job_order_output_lot_posting_unique")
      .on(table.outputPostingLineId)
      .where(sql`${table.outputPostingLineId} IS NOT NULL`),
    index("job_order_output_lot_job_idx").on(table.jobOrderId),
    check("job_order_output_lot_qty_positive", sql`${table.quantity} > 0`),
  ],
).enableRLS();

export type BomHeader = typeof bomHeaders.$inferSelect;
export type NewBomHeader = typeof bomHeaders.$inferInsert;
export type BomVersion = typeof bomVersions.$inferSelect;
export type NewBomVersion = typeof bomVersions.$inferInsert;
export type BomComponent = typeof bomComponents.$inferSelect;
export type NewBomComponent = typeof bomComponents.$inferInsert;
export type JobOrder = typeof jobOrders.$inferSelect;
export type NewJobOrder = typeof jobOrders.$inferInsert;
export type JobOrderComponentAllocation = typeof jobOrderComponentAllocations.$inferSelect;
export type NewJobOrderComponentAllocation = typeof jobOrderComponentAllocations.$inferInsert;
export type JobOrderOutputLot = typeof jobOrderOutputLots.$inferSelect;
export type NewJobOrderOutputLot = typeof jobOrderOutputLots.$inferInsert;
