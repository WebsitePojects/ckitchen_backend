/**
 * ORION enterprise operations schema (D35-D46).
 *
 * Kept separate from the legacy 1,300+ line schema so the new stock core has a
 * bounded ownership surface. Legacy tables are imported only for foreign keys;
 * existing routes remain compatible while dark feature flags keep new posting
 * paths disabled until their invariants pass.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
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
import {
  aggregatorAccounts,
  availabilityEnum,
  employees,
  ingredients,
  kitchenStations,
  locations,
  menuItems,
  orders,
  stockLedgerMovementTypeEnum,
  users,
  warehouses,
} from "./schema.js";

export const inventoryLotStatusEnum = pgEnum("inventory_lot_status", [
  "AVAILABLE",
  "QUARANTINED",
  "EXPIRED",
  "RECALLED",
  "SPOILED",
  "DISPOSED",
  "EXHAUSTED",
]);

export const stockPostingStatusEnum = pgEnum("stock_posting_status", [
  "PROCESSING",
  "COMPLETED",
]);

export const outboxStatusEnum = pgEnum("outbox_status", [
  "PENDING",
  "PROCESSING",
  "PUBLISHED",
  "DEAD_LETTER",
]);

export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "RUNNING",
  "PASSED",
  "DRIFT_DETECTED",
  "FAILED",
]);

export const migrationExceptionStatusEnum = pgEnum("migration_exception_status", [
  "OPEN",
  "RESOLVED",
  "IGNORED",
]);

export const importJobStatusEnum = pgEnum("import_job_status", [
  "UPLOADED",
  "VALIDATED",
  "EXCEPTIONS",
  "APPROVED",
  "COMMITTED",
  "FAILED",
]);

// ---------------------------------------------------------------------------
// Generic Item UOMs and lot-level inventory truth
// ---------------------------------------------------------------------------

export const itemUomConversions = pgTable(
  "item_uom_conversion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    fromUom: text("from_uom").notNull(),
    toBaseFactor: numeric("to_base_factor", { precision: 20, scale: 8 }).notNull(),
    roundingScale: integer("rounding_scale").notNull().default(4),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("item_uom_conversion_item_from_unique").on(table.itemId, table.fromUom),
    check("item_uom_conversion_factor_positive", sql`${table.toBaseFactor} > 0`),
    check(
      "item_uom_conversion_rounding_scale_range",
      sql`${table.roundingScale} >= 0 AND ${table.roundingScale} <= 8`,
    ),
  ],
).enableRLS();

export const inventoryLots = pgTable(
  "inventory_lot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    lotCode: text("lot_code").notNull(),
    supplierLot: text("supplier_lot"),
    manufacturedAt: date("manufactured_at"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: date("expires_at"),
    status: inventoryLotStatusEnum("status").notNull().default("AVAILABLE"),
    unitCost: numeric("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    sourceDocumentType: text("source_document_type"),
    sourceDocumentId: text("source_document_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_lot_item_code_unique").on(table.itemId, table.lotCode),
    index("inventory_lot_item_status_expiry_idx").on(table.itemId, table.status, table.expiresAt),
    check("inventory_lot_unit_cost_nonnegative", sql`${table.unitCost} >= 0`),
  ],
).enableRLS();

export const inventoryLotBalances = pgTable(
  "inventory_lot_balance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    onHand: numeric("on_hand", { precision: 20, scale: 6 }).notNull().default("0"),
    reserved: numeric("reserved", { precision: 20, scale: 6 }).notNull().default("0"),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_lot_balance_warehouse_lot_unique").on(
      table.warehouseId,
      table.lotId,
    ),
    index("inventory_lot_balance_lot_idx").on(table.lotId),
    check("inventory_lot_balance_on_hand_nonnegative", sql`${table.onHand} >= 0`),
    check("inventory_lot_balance_reserved_nonnegative", sql`${table.reserved} >= 0`),
    check("inventory_lot_balance_reserved_lte_on_hand", sql`${table.reserved} <= ${table.onHand}`),
    check("inventory_lot_balance_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

// Parent -> child lot genealogy. Quantity is the parent quantity consumed into
// the child production output; one child may have many parents.
export const inventoryLotGenealogy = pgTable(
  "inventory_lot_genealogy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentLotId: uuid("parent_lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    childLotId: uuid("child_lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    quantityConsumed: numeric("quantity_consumed", { precision: 20, scale: 6 }).notNull(),
    productionDocumentNo: text("production_document_no").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_lot_genealogy_unique").on(
      table.parentLotId,
      table.childLotId,
      table.productionDocumentNo,
    ),
    index("inventory_lot_genealogy_child_idx").on(table.childLotId),
    check("inventory_lot_genealogy_qty_positive", sql`${table.quantityConsumed} > 0`),
    check("inventory_lot_genealogy_distinct_lots", sql`${table.parentLotId} <> ${table.childLotId}`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Exactly-once stock posting, immutable movement lines, audit outbox
// ---------------------------------------------------------------------------

export const stockPostings = pgTable(
  "stock_posting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    hashVersion: integer("hash_version").notNull().default(1),
    status: stockPostingStatusEnum("status").notNull().default("PROCESSING"),
    sourceModule: text("source_module").notNull(),
    sourceDocumentNo: text("source_document_no").notNull(),
    locationId: uuid("location_id").references(() => locations.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    correlationId: text("correlation_id").notNull(),
    result: jsonb("result"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_posting_idempotency_key_unique").on(table.idempotencyKey),
    index("stock_posting_document_idx").on(table.sourceModule, table.sourceDocumentNo),
    index("stock_posting_location_created_idx").on(table.locationId, table.createdAt.desc()),
    check("stock_posting_hash_version_positive", sql`${table.hashVersion} > 0`),
  ],
).enableRLS();

export const stockPostingLines = pgTable(
  "stock_posting_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => stockPostings.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    movementType: stockLedgerMovementTypeEnum("movement_type").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    enteredQuantity: numeric("entered_quantity", { precision: 20, scale: 6 }).notNull(),
    enteredUom: text("entered_uom").notNull(),
    conversionFactor: numeric("conversion_factor", { precision: 20, scale: 8 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    reasonCode: text("reason_code"),
    balanceBefore: numeric("balance_before", { precision: 20, scale: 6 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 20, scale: 6 }).notNull(),
    lineHash: text("line_hash").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_posting_line_posting_line_unique").on(table.postingId, table.lineNo),
    uniqueIndex("stock_posting_line_hash_unique").on(table.postingId, table.lineHash),
    index("stock_posting_line_lot_warehouse_idx").on(table.lotId, table.warehouseId),
    index("stock_posting_line_item_warehouse_idx").on(table.itemId, table.warehouseId),
    check("stock_posting_line_number_positive", sql`${table.lineNo} > 0`),
    check("stock_posting_line_qty_positive", sql`${table.quantity} > 0`),
    check("stock_posting_line_entered_qty_positive", sql`${table.enteredQuantity} > 0`),
    check("stock_posting_line_conversion_positive", sql`${table.conversionFactor} > 0`),
    check("stock_posting_line_cost_nonnegative", sql`${table.unitCost} >= 0`),
    check("stock_posting_line_balances_nonnegative", sql`${table.balanceBefore} >= 0 AND ${table.balanceAfter} >= 0`),
  ],
).enableRLS();

/**
 * Generic state authority for stock-affecting documents. Domain headers (Return,
 * Job Order, Customer Order, etc.) link to this row; the posting service locks
 * and conditionally advances it in the same transaction as stock/audit/outbox.
 */
export const operationalDocuments = pgTable(
  "operational_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    module: text("module").notNull(),
    documentNo: text("document_no").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    stockPostingId: uuid("stock_posting_id").references(() => stockPostings.id),
    createdBy: uuid("created_by").references(() => users.id),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operational_document_module_no_unique").on(table.module, table.documentNo),
    uniqueIndex("operational_document_posting_unique")
      .on(table.stockPostingId)
      .where(sql`${table.stockPostingId} IS NOT NULL`),
    index("operational_document_location_status_idx").on(
      table.locationId,
      table.module,
      table.status,
    ),
    check("operational_document_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

// Outlet-specific deployment of a global menu item. Station/availability cannot
// live only on menu_item once one brand operates in ACC, ACC2, and SCS.
export const menuItemOutlets = pgTable(
  "menu_item_outlet",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    stationId: uuid("station_id")
      .notNull()
      .references(() => kitchenStations.id),
    availability: availabilityEnum("availability").notNull().default("AVAILABLE"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("menu_item_outlet_item_location_unique").on(table.menuItemId, table.locationId),
    index("menu_item_outlet_location_station_idx").on(table.locationId, table.stationId),
  ],
).enableRLS();

export const outboxEvents = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    locationId: uuid("location_id").references(() => locations.id),
    correlationId: text("correlation_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("outbox_event_correlation_type_aggregate_unique").on(
      table.correlationId,
      table.eventType,
      table.aggregateId,
    ),
    index("outbox_event_pending_idx")
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
    index("outbox_event_location_created_idx").on(table.locationId, table.createdAt.desc()),
    check("outbox_event_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Operational safety, reconciliation, and controlled migration/import
// ---------------------------------------------------------------------------

export const operationalFeatureFlags = pgTable(
  "operational_feature_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    version: integer("version").notNull().default(1),
    description: text("description"),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operational_feature_flag_key_unique").on(table.key),
    check("operational_feature_flag_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const inventoryReconciliationRuns = pgTable(
  "inventory_reconciliation_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: reconciliationStatusEnum("status").notNull().default("RUNNING"),
    scopeWarehouseId: uuid("scope_warehouse_id").references(() => warehouses.id),
    legacyTotal: numeric("legacy_total", { precision: 24, scale: 6 }),
    lotTotal: numeric("lot_total", { precision: 24, scale: 6 }),
    driftQuantity: numeric("drift_quantity", { precision: 24, scale: 6 }),
    details: jsonb("details"),
    startedBy: uuid("started_by").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("inventory_reconciliation_status_started_idx").on(table.status, table.startedAt.desc())],
).enableRLS();

// Manager assignment is a relationship/history, not a mutable free-text or a
// circular location column. One partial unique index keeps one active primary
// manager per outlet while preserving prior assignments.
export const outletManagerAssignments = pgTable(
  "outlet_manager_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    isPrimary: boolean("is_primary").notNull().default(true),
    active: boolean("active").notNull().default(true),
    assignedBy: uuid("assigned_by").references(() => users.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("outlet_manager_active_primary_unique")
      .on(table.locationId)
      .where(sql`${table.active} = true AND ${table.isPrimary} = true`),
    index("outlet_manager_employee_idx").on(table.employeeId, table.active),
  ],
).enableRLS();

export const listingMigrationExceptions = pgTable(
  "listing_migration_exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    reason: text("reason").notNull(),
    candidateLocationIds: jsonb("candidate_location_ids").notNull(),
    affectedOrderCount: integer("affected_order_count").notNull().default(0),
    status: migrationExceptionStatusEnum("status").notNull().default("OPEN"),
    resolvedLocationId: uuid("resolved_location_id").references(() => locations.id),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("listing_migration_exception_account_unique").on(table.aggregatorAccountId),
    index("listing_migration_exception_status_idx").on(table.status, table.createdAt.desc()),
    check("listing_migration_exception_order_count_nonnegative", sql`${table.affectedOrderCount} >= 0`),
  ],
).enableRLS();

export const inventoryMigrationExceptions = pgTable(
  "inventory_migration_exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyStockId: uuid("legacy_stock_id").notNull(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    reason: text("reason").notNull(),
    status: migrationExceptionStatusEnum("status").notNull().default("OPEN"),
    resolutionNote: text("resolution_note"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_migration_exception_stock_unique").on(table.legacyStockId),
    index("inventory_migration_exception_status_idx").on(table.status, table.createdAt.desc()),
  ],
).enableRLS();

export const topologyMigrationExceptions = pgTable(
  "topology_migration_exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    reason: text("reason").notNull(),
    details: jsonb("details").notNull(),
    status: migrationExceptionStatusEnum("status").notNull().default("OPEN"),
    resolutionNote: text("resolution_note"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("topology_migration_exception_code_unique").on(table.code),
    index("topology_migration_exception_status_idx").on(table.status, table.createdAt.desc()),
  ],
).enableRLS();

export const dataImportJobs = pgTable(
  "data_import_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importType: text("import_type").notNull(),
    sourceFileHash: text("source_file_hash").notNull(),
    originalFileName: text("original_file_name").notNull(),
    status: importJobStatusEnum("status").notNull().default("UPLOADED"),
    rowCount: integer("row_count").notNull().default(0),
    validRowCount: integer("valid_row_count").notNull().default(0),
    exceptionCount: integer("exception_count").notNull().default(0),
    dryRunSummary: jsonb("dry_run_summary"),
    approvedByOwner: uuid("approved_by_owner").references(() => users.id),
    approvedByOperations: uuid("approved_by_operations").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("data_import_job_type_hash_unique").on(table.importType, table.sourceFileHash),
    index("data_import_job_status_created_idx").on(table.status, table.createdAt.desc()),
    check(
      "data_import_job_counts_nonnegative",
      sql`${table.rowCount} >= 0 AND ${table.validRowCount} >= 0 AND ${table.exceptionCount} >= 0`,
    ),
  ],
).enableRLS();

export const dataImportRows = pgTable(
  "data_import_row",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importJobId: uuid("import_job_id")
      .notNull()
      .references(() => dataImportJobs.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rowHash: text("row_hash").notNull(),
    rawData: jsonb("raw_data").notNull(),
    normalizedData: jsonb("normalized_data"),
    errors: jsonb("errors"),
    isValid: boolean("is_valid").notNull().default(false),
    committedEntityType: text("committed_entity_type"),
    committedEntityId: text("committed_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("data_import_row_job_number_unique").on(table.importJobId, table.rowNumber),
    uniqueIndex("data_import_row_job_hash_unique").on(table.importJobId, table.rowHash),
    check("data_import_row_number_positive", sql`${table.rowNumber} > 0`),
  ],
).enableRLS();

// Type exports keep module consumers concise.
export type ItemUomConversion = typeof itemUomConversions.$inferSelect;
export type InventoryLot = typeof inventoryLots.$inferSelect;
export type InventoryLotBalance = typeof inventoryLotBalances.$inferSelect;
export type StockPosting = typeof stockPostings.$inferSelect;
export type StockPostingLine = typeof stockPostingLines.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type OperationalFeatureFlag = typeof operationalFeatureFlags.$inferSelect;
export type ListingMigrationException = typeof listingMigrationExceptions.$inferSelect;

// Compile-time dependency markers: these two existing domain entities receive
// additive location snapshots in migration 0027 and are intentionally referenced
// here so schema ownership remains visible to the enterprise module.
void orders;
