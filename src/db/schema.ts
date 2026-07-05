import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums (CK1-ARC-002 §4.2)
// ---------------------------------------------------------------------------

export const aggregatorEnum = pgEnum("aggregator", ["FOODPANDA", "GRABFOOD", "OTHER"]);

/** MOTM 2026-07-01: per-brand active/inactive history. */
export const brandActivityStatusEnum = pgEnum("brand_activity_status", ["ACTIVE", "INACTIVE"]);

export const availabilityEnum = pgEnum("availability", [
  "AVAILABLE",
  "PAUSED",
  "SOLD_OUT",
]);

export const orderStatusEnum = pgEnum("order_status", [
  "NEW",
  "PREPARING",
  "READY",
  "COMPLETED",
  "CANCELLED",
]);

export const itoStatusEnum = pgEnum("ito_status", ["REQUESTED", "CONFIRMED", "CANCELLED"]);

export const printerConnectionEnum = pgEnum("printer_connection", [
  "USB",
  "NETWORK",
  "SERIAL",
]);

export const printerStatusEnum = pgEnum("printer_status", ["ONLINE", "OFFLINE", "ERROR"]);

export const printJobStatusEnum = pgEnum("print_job_status", ["PENDING", "PRINTED", "FAILED"]);

export const locationStatusEnum = pgEnum("location_status", ["ACTIVE", "INACTIVE"]);

export const warehouseTypeEnum = pgEnum("warehouse_type", ["MAIN", "KITCHEN"]);

// Roles v2 (D24/D29): the enum keeps BOTH the original v1 values (as accepted
// aliases — Postgres can't cheaply drop enum values, and legacy tokens/rows may
// still carry them) AND the v2 values. Migration 0012 remaps existing user rows
// v1→v2 via a fresh-type swap (an ALTER TYPE ADD VALUE cannot be used in the same
// transaction that adds it, and the drizzle migrator wraps all pending migrations
// in one transaction). Order below MUST match 0012's role_v2 label order.
export const roleEnum = pgEnum("role", [
  // --- v1 (kept as aliases) ---
  "SUPER_ADMIN",
  "BRAND_MANAGER", // shared: also a v2 role
  "KITCHEN_STAFF",
  "WAREHOUSE",
  "SUPPLIER_COORDINATOR",
  "ACCOUNTANT",
  "RIDER",
  // --- v2 (D24) ---
  "OWNER",
  "OUTLET_MANAGER",
  "KITCHEN_CREW",
  "WAREHOUSE_MAIN",
  "WAREHOUSE_OUTLET",
  "PURCHASING",
  "HR",
  "ACCOUNTING",
]);

// ---------------------------------------------------------------------------
// location
// ---------------------------------------------------------------------------

export const locations = pgTable(
  "location",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    status: locationStatusEnum("status").notNull().default("ACTIVE"),
    timezone: text("timezone").notNull().default("Asia/Manila"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
  },
  (table) => [uniqueIndex("location_code_unique").on(table.code)],
).enableRLS();

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;

// ---------------------------------------------------------------------------
// brand
// ---------------------------------------------------------------------------

export const brands = pgTable(
  "brand",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    color: text("color").notNull(),
    salesPerfId: text("sales_perf_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [index("brand_location_id_idx").on(table.locationId)],
).enableRLS();

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;

// ---------------------------------------------------------------------------
// aggregator_account
// ---------------------------------------------------------------------------

export const aggregatorAccounts = pgTable(
  "aggregator_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    aggregator: aggregatorEnum("aggregator").notNull(),
    externalMerchantId: text("external_merchant_id").notNull(),
    credentialRef: text("credential_ref"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * W3 (D33 #10): aggregator commission, percent (0-100). NULL = not yet
     * configured — the sales report treats NULL as 0 (gross == net) until the
     * client supplies real per-listing rates (CLIENT_QUESTIONS Part 2).
     */
    commissionRate: numeric("commission_rate", { precision: 5, scale: 2 }),
  },
  (table) => [index("aggregator_account_brand_id_idx").on(table.brandId)],
).enableRLS();

export type AggregatorAccount = typeof aggregatorAccounts.$inferSelect;
export type NewAggregatorAccount = typeof aggregatorAccounts.$inferInsert;

// ---------------------------------------------------------------------------
// brand_activity_log  (MOTM 2026-07-01: active/inactive history per brand/day)
// ---------------------------------------------------------------------------

export const brandActivityLog = pgTable(
  "brand_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    // Optional: which channel listing toggled (a brand may toggle at the brand
    // level or per Foodpanda/Grab listing).
    aggregatorAccountId: uuid("aggregator_account_id").references(() => aggregatorAccounts.id),
    status: brandActivityStatusEnum("status").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changedBy: uuid("changed_by").references(() => users.id),
    note: text("note"),
  },
  (table) => [
    index("brand_activity_log_brand_changed_at_idx").on(table.brandId, table.changedAt),
  ],
).enableRLS();

export type BrandActivityLog = typeof brandActivityLog.$inferSelect;
export type NewBrandActivityLog = typeof brandActivityLog.$inferInsert;

// ---------------------------------------------------------------------------
// printer
// ---------------------------------------------------------------------------

export const printers = pgTable("printer", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  connection: printerConnectionEnum("connection").notNull(),
  address: text("address").notNull(),
  status: printerStatusEnum("status").notNull().default("OFFLINE"),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
}).enableRLS();

export type Printer = typeof printers.$inferSelect;
export type NewPrinter = typeof printers.$inferInsert;

// ---------------------------------------------------------------------------
// kitchen_station
// ---------------------------------------------------------------------------

export const kitchenStations = pgTable(
  "kitchen_station",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    name: text("name").notNull(),
    defaultPrinterId: uuid("default_printer_id").references(() => printers.id),
  },
  (table) => [
    index("kitchen_station_location_id_idx").on(table.locationId),
    index("kitchen_station_printer_id_idx").on(table.defaultPrinterId),
  ],
).enableRLS();

export type KitchenStation = typeof kitchenStations.$inferSelect;
export type NewKitchenStation = typeof kitchenStations.$inferInsert;

// ---------------------------------------------------------------------------
// ingredient
// ---------------------------------------------------------------------------

export const ingredients = pgTable("ingredient", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
  lowStockThreshold: numeric("low_stock_threshold", { precision: 14, scale: 4 }).notNull(),
}).enableRLS();

export type Ingredient = typeof ingredients.$inferSelect;
export type NewIngredient = typeof ingredients.$inferInsert;

// ---------------------------------------------------------------------------
// menu_item
// ---------------------------------------------------------------------------

export const menuItems = pgTable(
  "menu_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    name: text("name").notNull(),
    price: numeric("price", { precision: 14, scale: 2 }).notNull(),
    prepTimeMin: integer("prep_time_min"),
    stationId: uuid("station_id").references(() => kitchenStations.id),
    availability: availabilityEnum("availability").notNull().default("AVAILABLE"),
    /** MOTM 2026-07-01: per-item photo, product number, and remarks. */
    imageUrl: text("image_url"),
    itemNo: text("item_no"),
    remarks: text("remarks"),
  },
  (table) => [
    index("menu_item_brand_id_idx").on(table.brandId),
    index("menu_item_station_id_idx").on(table.stationId),
    // Product number unique within a brand (only when set).
    uniqueIndex("menu_item_brand_item_no_unique")
      .on(table.brandId, table.itemNo)
      .where(sql`${table.itemNo} IS NOT NULL`),
  ],
).enableRLS();

export type MenuItem = typeof menuItems.$inferSelect;
export type NewMenuItem = typeof menuItems.$inferInsert;

// ---------------------------------------------------------------------------
// recipe_line
// ---------------------------------------------------------------------------

export const recipeLines = pgTable(
  "recipe_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    portionQty: numeric("portion_qty", { precision: 14, scale: 4 }).notNull(),
    unit: text("unit").notNull(),
  },
  (table) => [
    index("recipe_line_menu_item_id_idx").on(table.menuItemId),
    index("recipe_line_ingredient_id_idx").on(table.ingredientId),
  ],
).enableRLS();

export type RecipeLine = typeof recipeLines.$inferSelect;
export type NewRecipeLine = typeof recipeLines.$inferInsert;

// ---------------------------------------------------------------------------
// warehouse / inventory_stock
// ---------------------------------------------------------------------------

export const warehouses = pgTable(
  "warehouse",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    type: warehouseTypeEnum("type").notNull(),
  },
  (table) => [uniqueIndex("warehouse_location_type_unique").on(table.locationId, table.type)],
).enableRLS();

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;

export const inventoryStock = pgTable(
  "inventory_stock",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull().default("0"),
  },
  (table) => [
    uniqueIndex("inventory_stock_warehouse_ingredient_unique").on(
      table.warehouseId,
      table.ingredientId,
    ),
    index("inventory_stock_ingredient_idx").on(table.ingredientId),
  ],
).enableRLS();

export type InventoryStock = typeof inventoryStock.$inferSelect;
export type NewInventoryStock = typeof inventoryStock.$inferInsert;

// ---------------------------------------------------------------------------
// user / user_brand
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Role = User["role"];

export const userBrands = pgTable(
  "user_brand",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
  },
  (table) => [
    uniqueIndex("user_brand_user_brand_unique").on(table.userId, table.brandId),
    index("user_brand_brand_id_idx").on(table.brandId),
  ],
).enableRLS();

export type UserBrand = typeof userBrands.$inferSelect;
export type NewUserBrand = typeof userBrands.$inferInsert;

// ---------------------------------------------------------------------------
// user_outlet_access  (D22/D31 tenancy: source of truth for WHERE a user may act)
//
// Role = WHAT a user can do; this table = WHICH outlets. Consulted at login to
// build the JWT `outlet_ids` claim, and by the X-Outlet-Id membership middleware.
// HQ/ALL-scope roles (OWNER, HR, ACCOUNTING, WAREHOUSE_MAIN) ignore this table
// for authorization, but rows may still exist for them (harmless).
// ---------------------------------------------------------------------------

export const userOutletAccess = pgTable(
  "user_outlet_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.locationId] }),
    index("user_outlet_access_location_id_idx").on(table.locationId),
  ],
).enableRLS();

export type UserOutletAccess = typeof userOutletAccess.$inferSelect;
export type NewUserOutletAccess = typeof userOutletAccess.$inferInsert;

// ---------------------------------------------------------------------------
// order / order_item   (table name is the reserved word "order"; exported as `orders`)
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    aggregator: aggregatorEnum("aggregator").notNull(),
    externalRef: text("external_ref").notNull(),
    customerName: text("customer_name"),
    status: orderStatusEnum("status").notNull().default("NEW"),
    /** Required when status transitions to CANCELLED (MOTM 2026-07-01). */
    cancelReason: text("cancel_reason"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    prepAt: timestamp("prep_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Listing-scoped idempotency (D-migration 0010, supersedes the old global
    // (aggregator, external_ref) unique): a replay of the same external_ref on
    // the SAME channel listing (aggregator_account_id) is an idempotent no-op;
    // the same external_ref arriving via a DIFFERENT listing is a distinct
    // order. See orders/service.ts ingestOrder/buildDuplicateResponse.
    uniqueIndex("order_listing_external_ref_unique").on(
      table.aggregatorAccountId,
      table.externalRef,
    ),
    index("order_status_placed_at_idx").on(table.status, table.placedAt.desc()),
    index("order_brand_placed_at_idx").on(table.brandId, table.placedAt.desc()),
    index("order_aggregator_account_id_idx").on(table.aggregatorAccountId),
  ],
).enableRLS();

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export const orderItems = pgTable(
  "order_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id),
    qty: integer("qty").notNull(),
    stationId: uuid("station_id")
      .notNull()
      .references(() => kitchenStations.id),
    notes: text("notes"),
  },
  (table) => [
    index("order_item_order_id_idx").on(table.orderId),
    index("order_item_menu_item_id_idx").on(table.menuItemId),
    index("order_item_station_id_idx").on(table.stationId),
  ],
).enableRLS();

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

// ---------------------------------------------------------------------------
// ito / ito_item   (Internal Transfer Order)
// ---------------------------------------------------------------------------

export const itos = pgTable(
  "ito",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromWarehouseId: uuid("from_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    toWarehouseId: uuid("to_warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    status: itoStatusEnum("status").notNull().default("REQUESTED"),
    requestedBy: uuid("requested_by").references(() => users.id),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    index("ito_from_warehouse_idx").on(table.fromWarehouseId),
    index("ito_to_warehouse_idx").on(table.toWarehouseId),
    index("ito_status_idx").on(table.status),
  ],
).enableRLS();

export type Ito = typeof itos.$inferSelect;
export type NewIto = typeof itos.$inferInsert;

export const itoItems = pgTable(
  "ito_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itoId: uuid("ito_id")
      .notNull()
      .references(() => itos.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  },
  (table) => [
    index("ito_item_ito_id_idx").on(table.itoId),
    index("ito_item_ingredient_id_idx").on(table.ingredientId),
  ],
).enableRLS();

export type ItoItem = typeof itoItems.$inferSelect;
export type NewItoItem = typeof itoItems.$inferInsert;

// ---------------------------------------------------------------------------
// print_job / print_agent / consumption_log
// ---------------------------------------------------------------------------

export const printJobs = pgTable(
  "print_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    stationId: uuid("station_id")
      .notNull()
      .references(() => kitchenStations.id),
    printerId: uuid("printer_id").references(() => printers.id),
    payload: jsonb("payload").notNull(),
    status: printJobStatusEnum("status").notNull().default("PENDING"),
    error: text("error"),
    retries: integer("retries").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    printedAt: timestamp("printed_at", { withTimezone: true }),
  },
  (table) => [
    // Partial: agent pull loop hits this continuously (`WHERE status='PENDING' ORDER BY
    // created_at ASC`); tiny + always hot, so a partial index stays cheap as print_job grows.
    index("print_job_pending_created_at_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
    index("print_job_status_idx").on(table.status),
    index("print_job_order_id_idx").on(table.orderId),
    index("print_job_station_id_idx").on(table.stationId),
    index("print_job_printer_id_idx").on(table.printerId),
  ],
).enableRLS();

export type PrintJob = typeof printJobs.$inferSelect;
export type NewPrintJob = typeof printJobs.$inferInsert;

export const printAgents = pgTable(
  "print_agent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    // Legacy shared-secret column (audit-backend.md CRITICAL #2: "one process-wide
    // AGENT_TOKEN, stored plaintext per row"). Kept nullable during the SF-2
    // transition — new registrations no longer populate it (a hashed per-agent
    // token is issued instead; see tokenHash below). Not backfilled/dropped yet
    // so any pre-SF-2 row (and its FK-safe history) survives the migration.
    apiToken: text("api_token"),
    // SF-2: sha256(rawToken) hex digest. Deterministic (unlike bcrypt) so a
    // per-request lookup can index straight to the owning agent row — the raw
    // token itself is never stored, only shown once in the register response.
    tokenHash: text("token_hash"),
    name: text("name"),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
  },
  (table) => [
    index("print_agent_location_id_idx").on(table.locationId),
    uniqueIndex("print_agent_token_hash_unique").on(table.tokenHash),
  ],
).enableRLS();

export type PrintAgent = typeof printAgents.$inferSelect;
export type NewPrintAgent = typeof printAgents.$inferInsert;

export const consumptionLogs = pgTable(
  "consumption_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    logDate: timestamp("log_date", { withTimezone: true }).notNull().defaultNow(),
    loggedBy: uuid("logged_by").references(() => users.id),
    orderId: uuid("order_id").references(() => orders.id),
    // Tenancy backfill (audit-db.md §3, BUILDER TASK 5, mechanical subset only):
    // nullable, no product decision required — outlet is derivable via
    // warehouse once populated. NOT wired to any insert call site in this
    // migration: POST /inventory/consumption (inventory/routes.ts) takes no
    // warehouse in its request shape today, and picking one would be an API
    // change, not a backfill. Left null until that's decided; superseded
    // long-term by stock_ledger_entry, which already carries warehouse_id.
    warehouseId: uuid("warehouse_id").references(() => warehouses.id),
  },
  (table) => [
    index("consumption_log_ingredient_idx").on(table.ingredientId, table.logDate.desc()),
    index("consumption_log_order_id_idx").on(table.orderId),
    index("consumption_log_warehouse_id_idx").on(table.warehouseId),
  ],
).enableRLS();

export type ConsumptionLog = typeof consumptionLogs.$inferSelect;
export type NewConsumptionLog = typeof consumptionLogs.$inferInsert;

// ---------------------------------------------------------------------------
// ERP R1: stock_ledger_entry  (append-only audit trail, shadows inventoryStock)
// ---------------------------------------------------------------------------

export const stockLedgerSourceModuleEnum = pgEnum("stock_ledger_source_module", [
  "RECEIVE",
  "ITO",
  "ORDER_DEDUCTION",
  "ADJUSTMENT",
  "RESTOCK",
]);

export const stockLedgerMovementTypeEnum = pgEnum("stock_ledger_movement_type", ["IN", "OUT"]);

export const stockLedgerEntries = pgTable(
  "stock_ledger_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceModule: stockLedgerSourceModuleEnum("source_module").notNull(),
    sourceDocumentNo: text("source_document_no").notNull(),
    sourceLineNo: text("source_line_no"),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    movementType: stockLedgerMovementTypeEnum("movement_type").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    encoderUserId: uuid("encoder_user_id").references(() => users.id),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("stock_ledger_source_unique").on(
      table.sourceModule,
      table.sourceDocumentNo,
      table.sourceLineNo,
    ),
    index("stock_ledger_ing_wh_posted_idx").on(
      table.ingredientId,
      table.warehouseId,
      table.postedAt.desc(),
    ),
    index("stock_ledger_wh_posted_idx").on(table.warehouseId, table.postedAt.desc()),
    index("stock_ledger_encoder_idx").on(table.encoderUserId),
  ],
).enableRLS();

export type StockLedgerEntry = typeof stockLedgerEntries.$inferSelect;
export type NewStockLedgerEntry = typeof stockLedgerEntries.$inferInsert;

// ---------------------------------------------------------------------------
// EMS: departmentEnum / employee / userSession / auditLog  (CK1-EMS-005)
// ---------------------------------------------------------------------------

export const departmentEnum = pgEnum("department", [
  "KITCHEN",
  "WAREHOUSE",
  "PURCHASING",
  "SALES",
  "PRODUCTION",
  "QA",
  "ACCOUNTING",
  "ADMIN",
]);

export const employeeStatusEnum = pgEnum("employee_status", ["ACTIVE", "INACTIVE"]);

export const employees = pgTable(
  "employee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    employeeNo: text("employee_no").notNull().unique(),
    fullName: text("full_name").notNull(),
    department: departmentEnum("department").notNull(),
    position: text("position"),
    photoUrl: text("photo_url"),
    status: employeeStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("employee_user_id_idx").on(table.userId)],
).enableRLS();

export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;

export const userSessions = pgTable(
  "user_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    loginAt: timestamp("login_at", { withTimezone: true }).notNull().defaultNow(),
    logoutAt: timestamp("logout_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [index("user_session_user_id_idx").on(table.userId)],
).enableRLS();

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;

export const auditLogs = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorName: text("actor_name"),
    sessionId: uuid("session_id").references(() => userSessions.id),
    action: text("action").notNull(),
    description: text("description"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_created_at_idx").on(table.createdAt.desc()),
    index("audit_log_actor_idx").on(table.actorUserId),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ],
).enableRLS();

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

// ---------------------------------------------------------------------------
// EMS E3: attendance_record  (photo-based DTR — CK1-EMS-005 §3)
// ---------------------------------------------------------------------------

export const attendanceTypeEnum = pgEnum("attendance_type", ["TIME_IN", "TIME_OUT"]);

export const attendanceRecords = pgTable(
  "attendance_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    type: attendanceTypeEnum("type").notNull(),
    photoUrl: text("photo_url").notNull(),
    photoPublicId: text("photo_public_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    /** The authed user who recorded this punch — derived from req.user (anti-spoof). */
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id),
    /** Session from req.user.sessionId — links to the actor's login session. */
    sessionId: uuid("session_id").references(() => userSessions.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attendance_employee_captured_idx").on(table.employeeId, table.capturedAt.desc()),
    index("attendance_captured_at_idx").on(table.capturedAt.desc()),
    index("attendance_recorded_by_idx").on(table.recordedByUserId),
  ],
).enableRLS();

export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type NewAttendanceRecord = typeof attendanceRecords.$inferInsert;

// ---------------------------------------------------------------------------
// ERP R2: master data — suppliers / supplier_items / customers /
// department_inventory_access  (CK1-ERP-006 §1-2). Additive. `ingredients`
// stays the item catalog; supplier_items link a supplier to an ingredient.
// ---------------------------------------------------------------------------

export const suppliers = pgTable("supplier", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  email: text("email"),
  address: text("address"),
  paymentTermDays: integer("payment_term_days").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;

export const supplierItems = pgTable(
  "supplier_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    supplierSku: text("supplier_sku"),
    lastUnitCost: numeric("last_unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
  },
  (table) => [
    uniqueIndex("supplier_item_unique").on(table.supplierId, table.ingredientId),
    index("supplier_item_ingredient_idx").on(table.ingredientId),
  ],
).enableRLS();
export type SupplierItem = typeof supplierItems.$inferSelect;

export const customers = pgTable("customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  email: text("email"),
  address: text("address"),
  paymentTermDays: integer("payment_term_days").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

/** gprci-style per-department warehouse permissions (CK1-ERP-006 §2). */
export const departmentInventoryAccess = pgTable(
  "department_inventory_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    department: departmentEnum("department").notNull(),
    warehouseType: warehouseTypeEnum("warehouse_type").notNull(),
    canView: boolean("can_view").notNull().default(true),
    canViewCost: boolean("can_view_cost").notNull().default(false),
    canReceive: boolean("can_receive").notNull().default(false),
    canIssue: boolean("can_issue").notNull().default(false),
    canAdjust: boolean("can_adjust").notNull().default(false),
    canApprove: boolean("can_approve").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("department_inventory_access_unique").on(table.department, table.warehouseType),
  ],
).enableRLS();
export type DepartmentInventoryAccess = typeof departmentInventoryAccess.$inferSelect;

// ---------------------------------------------------------------------------
// ERP R3: purchasing — Purchase Request → Purchase Order → Receiving Report
// (CK1-ERP-006 §4). Receiving posts a RECEIVE IN ledger row into the MAIN
// warehouse (reuses postLedger + inventoryStock).
// ---------------------------------------------------------------------------

export const purchaseRequestStatusEnum = pgEnum("purchase_request_status", [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "CLOSED",
]);
export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "DRAFT",
  "SENT",
  "PARTIAL",
  "RECEIVED",
  "CANCELLED",
]);

export const purchaseRequests = pgTable(
  "purchase_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prNo: text("pr_no").notNull().unique(),
    department: departmentEnum("department").notNull(),
    status: purchaseRequestStatusEnum("status").notNull().default("DRAFT"),
    requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("pr_status_idx").on(table.status, table.createdAt.desc())],
).enableRLS();
export type PurchaseRequest = typeof purchaseRequests.$inferSelect;

export const purchaseRequestLines = pgTable(
  "purchase_request_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prId: uuid("pr_id").notNull().references(() => purchaseRequests.id),
    ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    estUnitCost: numeric("est_unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
  },
  (table) => [
    index("pr_line_pr_id_idx").on(table.prId),
    index("pr_line_ingredient_idx").on(table.ingredientId),
  ],
).enableRLS();
export type PurchaseRequestLine = typeof purchaseRequestLines.$inferSelect;

export const purchaseOrders = pgTable(
  "purchase_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNo: text("po_no").notNull().unique(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    prId: uuid("pr_id").references(() => purchaseRequests.id),
    status: purchaseOrderStatusEnum("status").notNull().default("DRAFT"),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("po_supplier_id_idx").on(table.supplierId),
    index("po_pr_id_idx").on(table.prId),
    index("po_status_idx").on(table.status, table.createdAt.desc()),
  ],
).enableRLS();
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const purchaseOrderLines = pgTable(
  "purchase_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id").notNull().references(() => purchaseOrders.id),
    ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
    qtyReceived: numeric("qty_received", { precision: 14, scale: 4 }).notNull().default("0"),
  },
  (table) => [
    index("po_line_po_id_idx").on(table.poId),
    index("po_line_ingredient_idx").on(table.ingredientId),
  ],
).enableRLS();
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;

export const receivingReports = pgTable(
  "receiving_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rrNo: text("rr_no").notNull().unique(),
    poId: uuid("po_id").notNull().references(() => purchaseOrders.id),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    receivedByUserId: uuid("received_by_user_id").notNull().references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rr_po_id_idx").on(table.poId),
    index("rr_warehouse_id_idx").on(table.warehouseId),
  ],
).enableRLS();
export type ReceivingReport = typeof receivingReports.$inferSelect;

export const receivingReportLines = pgTable(
  "receiving_report_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rrId: uuid("rr_id").notNull().references(() => receivingReports.id),
    poLineId: uuid("po_line_id").notNull().references(() => purchaseOrderLines.id),
    ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
    qtyReceived: numeric("qty_received", { precision: 14, scale: 4 }).notNull(),
  },
  (table) => [
    index("rr_line_rr_id_idx").on(table.rrId),
    index("rr_line_po_line_id_idx").on(table.poLineId),
    index("rr_line_ingredient_idx").on(table.ingredientId),
  ],
).enableRLS();
export type ReceivingReportLine = typeof receivingReportLines.$inferSelect;
