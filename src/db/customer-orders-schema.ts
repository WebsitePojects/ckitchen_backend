/**
 * ORION Customer Order schema (D35-D46 §7 — Customer Orders and Job Orders).
 *
 * Additive/dark: introduces the Customer Order header, its multi-line body,
 * lot allocation tracking, and fulfillment history that the future central
 * posting service (src/modules/stock/posting-service.ts) will use to allocate
 * finished lots (make-to-stock) or drive a linked Job Order (make-to-order).
 * No posting/service/route wiring happens in this migration; only schema.
 *
 * No-double-deduction (D35-D46 §6/§7): every line declares a
 * `consumption_mode`. `STOCKED_OUTPUT` lines never carry a component snapshot
 * or a linked job order — fulfillment allocates/deducts the produced output
 * item only. `MADE_TO_ORDER` lines must have EXACTLY ONE consumption owner:
 * either a snapshotted component-requirements payload (order engine owns
 * consumption) or a linked `job_order_id` (the Job Order owns consumption) —
 * never both, never neither. `customer_order_line_consumption_owner_guard`
 * (below) enforces this at the database level, mirroring how
 * production-schema.ts enforces its own single-owner invariants
 * (`job_order_component_allocation_consume_posting_unique`, etc.) with a
 * CHECK/unique-index pair rather than application code.
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { inventoryLots, stockPostings } from "./enterprise-schema.js";
import { jobOrders } from "./production-schema.js";
import { consumptionModeEnum, customers, ingredients, locations, users, warehouses } from "./schema.js";

export const customerOrderStatusEnum = pgEnum("customer_order_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "ALLOCATED",
  "IN_PRODUCTION",
  "READY",
  "FULFILLED",
  "CANCELLED",
]);

export const customerOrderAllocationStatusEnum = pgEnum("customer_order_allocation_status", [
  "ACTIVE",
  "RELEASED",
  "CONSUMED",
]);

/**
 * Header. `locationId` is the outlet snapshot (D35-D46 §7/§8: orders snapshot
 * their outlet and never re-derive it later). `version` is the optimistic-lock
 * counter the posting/lifecycle service advances alongside `status`, matching
 * `job_order.version` / `stock_return_batch.version`.
 */
export const customerOrders = pgTable(
  "customer_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentNo: text("document_no").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    requiredDate: date("required_date"),
    status: customerOrderStatusEnum("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    remarks: text("remarks"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    allocatedBy: uuid("allocated_by").references(() => users.id),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }),
    fulfilledBy: uuid("fulfilled_by").references(() => users.id),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_order_document_no_unique").on(table.documentNo),
    index("customer_order_customer_idx").on(table.customerId),
    index("customer_order_location_status_idx").on(table.locationId, table.status),
    check("customer_order_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

/**
 * Body. Entered UOM + conversion factor + base quantity are snapshotted on the
 * line (D35-D46 §4), and price/tax/discount are immutable point-in-time
 * snapshots — recipe/price edits after acceptance never change an already
 * placed line (D35-D46 §6 "Recipe/BOM edits after order acceptance do not
 * change that order's reservation or deduction snapshot").
 *
 * `componentRequirementsSnapshot` and `jobOrderId` are the two possible
 * consumption owners for a MADE_TO_ORDER line; `customer_order_line_
 * consumption_owner_guard` enforces exactly one is set for MADE_TO_ORDER and
 * neither is set for STOCKED_OUTPUT (see module doc comment above).
 */
export const customerOrderLines = pgTable(
  "customer_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    enteredUom: text("entered_uom").notNull(),
    enteredQuantity: numeric("entered_quantity", { precision: 20, scale: 6 }).notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 6 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 20, scale: 6 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 20, scale: 6 }).notNull(),
    consumptionMode: consumptionModeEnum("consumption_mode").notNull(),
    status: customerOrderStatusEnum("status").notNull().default("DRAFT"),
    componentRequirementsSnapshot: jsonb("component_requirements_snapshot"),
    jobOrderId: uuid("job_order_id").references(() => jobOrders.id),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_order_line_order_line_unique").on(table.orderId, table.lineNo),
    uniqueIndex("customer_order_line_job_order_unique")
      .on(table.jobOrderId)
      .where(sql`${table.jobOrderId} IS NOT NULL`),
    index("customer_order_line_item_idx").on(table.itemId),
    index("customer_order_line_order_status_idx").on(table.orderId, table.status),
    check("customer_order_line_number_positive", sql`${table.lineNo} > 0`),
    check("customer_order_line_entered_qty_positive", sql`${table.enteredQuantity} > 0`),
    check("customer_order_line_conversion_positive", sql`${table.conversionFactor} > 0`),
    check("customer_order_line_base_qty_positive", sql`${table.baseQuantity} > 0`),
    check("customer_order_line_unit_price_nonnegative", sql`${table.unitPrice} >= 0`),
    check("customer_order_line_tax_amount_nonnegative", sql`${table.taxAmount} >= 0`),
    check("customer_order_line_discount_amount_nonnegative", sql`${table.discountAmount} >= 0`),
    check("customer_order_line_total_nonnegative", sql`${table.lineTotal} >= 0`),
    check(
      "customer_order_line_consumption_owner_guard",
      sql`(
        ${table.consumptionMode} = 'STOCKED_OUTPUT'
        AND ${table.componentRequirementsSnapshot} IS NULL
        AND ${table.jobOrderId} IS NULL
      ) OR (
        ${table.consumptionMode} = 'MADE_TO_ORDER'
        AND (
          (${table.componentRequirementsSnapshot} IS NOT NULL AND ${table.jobOrderId} IS NULL)
          OR (${table.componentRequirementsSnapshot} IS NULL AND ${table.jobOrderId} IS NOT NULL)
        )
      )`,
    ),
  ],
).enableRLS();

/**
 * Make-to-stock lot allocation. The partial unique index prevents the same
 * lot from being claimed twice as an ACTIVE allocation on the same line —
 * releasing (status -> RELEASED) or consuming (status -> CONSUMED) frees the
 * lot to be reconsidered, mirroring the FEFO/no-double-reservation intent of
 * D35-D46 §4 ("Available stock excludes reserved... lots").
 */
export const customerOrderAllocations = pgTable(
  "customer_order_allocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => customerOrderLines.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    status: customerOrderAllocationStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_order_allocation_line_lot_active_unique")
      .on(table.lineId, table.lotId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("customer_order_allocation_line_idx").on(table.lineId),
    index("customer_order_allocation_lot_warehouse_idx").on(table.lotId, table.warehouseId),
    check("customer_order_allocation_qty_positive", sql`${table.quantity} > 0`),
  ],
).enableRLS();

/**
 * Fulfillment history. Append-only rows recording each partial/complete
 * fulfillment event; `stockPostingId` links to the posting that actually
 * moved stock once the posting service lands (nullable until then). The
 * `forbid_mutation()` trigger (migration 0030) blocks UPDATE/DELETE on this
 * table, including deletes cascaded from the parent order/line FKs — once a
 * fulfillment row exists, its parent order/line can no longer be hard-deleted
 * either. That is intentional: fulfillment is audit history and must never
 * disappear, even via cascade (D35-D46 §7/business-rules.md #8).
 */
export const customerOrderFulfillments = pgTable(
  "customer_order_fulfillment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "cascade" }),
    lineId: uuid("line_id")
      .notNull()
      .references(() => customerOrderLines.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    stockPostingId: uuid("stock_posting_id").references(() => stockPostings.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customer_order_fulfillment_order_idx").on(table.orderId),
    index("customer_order_fulfillment_line_idx").on(table.lineId),
    check("customer_order_fulfillment_qty_positive", sql`${table.quantity} > 0`),
  ],
).enableRLS();

export type CustomerOrder = typeof customerOrders.$inferSelect;
export type NewCustomerOrder = typeof customerOrders.$inferInsert;
export type CustomerOrderLine = typeof customerOrderLines.$inferSelect;
export type NewCustomerOrderLine = typeof customerOrderLines.$inferInsert;
export type CustomerOrderAllocation = typeof customerOrderAllocations.$inferSelect;
export type NewCustomerOrderAllocation = typeof customerOrderAllocations.$inferInsert;
export type CustomerOrderFulfillment = typeof customerOrderFulfillments.$inferSelect;
export type NewCustomerOrderFulfillment = typeof customerOrderFulfillments.$inferInsert;
