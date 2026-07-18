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
// Printing v2 (D35-D46 §12). CLAIMED is DERIVED: status=PENDING AND lease_until>now().
export const printerCapabilityEnum = pgEnum("printer_capability", ["ESC_POS_KOT", "WINDOWS_DOCUMENT"]);
export const printerTransportEnum = pgEnum("printer_transport", ["PHYSICAL", "VIRTUAL"]);
export const printAttemptResultEnum = pgEnum("print_attempt_result", ["PRINTED", "FAILED", "LEASE_EXPIRED"]);

/**
 * Outbound integration (migration 0035, AGGREGATOR_API_INTEGRATION_SPEC.md
 * §5 cutover plan): who is authoritative for a channel listing's order
 * accept/reject/ready/pause/availability actions.
 *   DEVICE — the merchant tablet/phone is authoritative; ORION never sends
 *            outbound commands for this listing (default — safe for every
 *            existing listing until a client explicitly cuts over).
 *   SHADOW — ORION ingests read-only in parallel for reconciliation; it may
 *            send NOTIFY_MENU_UPDATED only (never order-affecting commands).
 *   API    — ORION is authoritative; the device becomes standby.
 */
export const channelControlModeEnum = pgEnum("channel_control_mode", ["DEVICE", "SHADOW", "API"]);

export const locationStatusEnum = pgEnum("location_status", ["ACTIVE", "INACTIVE"]);

/** W5 (admin backend): account status. BLOCKED users are refused login (checked
 * AFTER password verification — not an enumeration oracle) and have their live
 * sessions revoked immediately via userSessions.logoutAt. */
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "BLOCKED"]);

export const warehouseTypeEnum = pgEnum("warehouse_type", ["MAIN", "KITCHEN"]);

// Enterprise operations foundation (D35-D46). Legacy enums/columns stay in
// place while feature-flagged migrations move writes to explicit stock nodes,
// generic items, lots, and listing-owned outlet identity.
export const warehousePurposeEnum = pgEnum("warehouse_purpose", [
  "HQ_MAIN",
  "OUTLET_STORAGE",
  "KITCHEN",
  "PRODUCTION",
  "QUARANTINE",
]);

export const itemTypeEnum = pgEnum("item_type", [
  "RAW",
  "PACKAGING",
  "CONSUMABLE",
  "WIP",
  "FINISHED_GOOD",
  "SERVICE",
]);

export const listingMappingStatusEnum = pgEnum("listing_mapping_status", [
  "RESOLVED",
  "MAPPING_REQUIRED",
  "DISABLED",
]);

export const consumptionModeEnum = pgEnum("consumption_mode", [
  "STOCKED_OUTPUT",
  "MADE_TO_ORDER",
]);

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
// brand_outlet  (D30 many-to-many: a brand may operate in 2+ outlets)
//
// TRANSITION STATE: `brand.location_id` is KEPT as the brand's "home" outlet.
// This table records the FULL set of outlets a brand is deployed to. Each brand
// gets one active row for its home outlet (backfilled in migration 0015 + on
// create). Deactivation is a soft `is_active = false`, never a hard delete, so
// the deployment history stays audit-friendly.
// ---------------------------------------------------------------------------

export const brandOutlet = pgTable(
  "brand_outlet",
  {
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.brandId, table.locationId] }),
    index("brand_outlet_location_id_idx").on(table.locationId),
  ],
).enableRLS();

export type BrandOutlet = typeof brandOutlet.$inferSelect;
export type NewBrandOutlet = typeof brandOutlet.$inferInsert;

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
    /** Physical outlet owning this channel listing (D39). Nullable only during migration. */
    locationId: uuid("location_id").references(() => locations.id),
    aggregator: aggregatorEnum("aggregator").notNull(),
    externalMerchantId: text("external_merchant_id").notNull(),
    credentialRef: text("credential_ref"),
    isActive: boolean("is_active").notNull().default(true),
    mappingStatus: listingMappingStatusEnum("mapping_status")
      .notNull()
      .default("MAPPING_REQUIRED"),
    /**
     * W3 (D33 #10): aggregator commission, percent (0-100). NULL = not yet
     * configured — the sales report treats NULL as 0 (gross == net) until the
     * client supplies real per-listing rates (CLIENT_QUESTIONS Part 2).
     */
    commissionRate: numeric("commission_rate", { precision: 5, scale: 2 }),
    /**
     * Outbound integration (migration 0035): who is authoritative for this
     * listing's order accept/reject/ready/pause/availability actions.
     * Defaults DEVICE — every existing listing keeps running on its
     * merchant tablet/phone until explicitly cut over (AGGREGATOR_API_
     * INTEGRATION_SPEC.md §5).
     */
    controlMode: channelControlModeEnum("control_mode").notNull().default("DEVICE"),
    /** Grab merchantID / Delivery Hero (foodpanda) vendor id, once partner API access is issued. */
    apiMerchantId: text("api_merchant_id"),
  },
  (table) => [
    index("aggregator_account_brand_id_idx").on(table.brandId),
    index("aggregator_account_location_id_idx").on(table.locationId),
    index("aggregator_account_mapping_status_idx").on(table.mappingStatus),
  ],
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
  capability: printerCapabilityEnum("capability").notNull().default("ESC_POS_KOT"),
  transport: printerTransportEnum("transport").notNull().default("PHYSICAL"),
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

export const ingredients = pgTable(
  "ingredient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Generic Item code. Nullable only while legacy rows are deterministically backfilled. */
    code: text("code"),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    itemType: itemTypeEnum("item_type").notNull().default("RAW"),
    lotTracked: boolean("lot_tracked").notNull().default(false),
    shelfLifeDays: integer("shelf_life_days"),
    isActive: boolean("is_active").notNull().default(true),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
    lowStockThreshold: numeric("low_stock_threshold", { precision: 14, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex("ingredient_code_unique")
      .on(table.code)
      .where(sql`${table.code} IS NOT NULL`),
    index("ingredient_type_active_idx").on(table.itemType, table.isActive),
  ],
).enableRLS();

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
    consumptionMode: consumptionModeEnum("consumption_mode")
      .notNull()
      .default("MADE_TO_ORDER"),
    /** Required for STOCKED_OUTPUT: the produced WIP/finished item consumed at sale time. */
    stockItemId: uuid("stock_item_id").references(() => ingredients.id),
    availability: availabilityEnum("availability").notNull().default("AVAILABLE"),
    /** MOTM 2026-07-01: per-item photo, product number, and remarks. */
    imageUrl: text("image_url"),
    itemNo: text("item_no"),
    remarks: text("remarks"),
  },
  (table) => [
    index("menu_item_brand_id_idx").on(table.brandId),
    index("menu_item_station_id_idx").on(table.stationId),
    index("menu_item_stock_item_id_idx").on(table.stockItemId),
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
    purpose: warehousePurposeEnum("purpose"),
    code: text("code"),
    name: text("name"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    // Purpose is the enterprise identity. Legacy (location,type) uniqueness is
    // retained during the dark migration so old MAIN/KITCHEN resolvers cannot
    // become ambiguous before every writer moves to purpose-aware resolution.
    uniqueIndex("warehouse_location_type_unique").on(table.locationId, table.type),
    uniqueIndex("warehouse_location_purpose_unique")
      .on(table.locationId, table.purpose)
      .where(sql`${table.purpose} IS NOT NULL`),
    uniqueIndex("warehouse_code_unique").on(table.code).where(sql`${table.code} IS NOT NULL`),
    index("warehouse_location_purpose_idx").on(table.locationId, table.purpose),
    uniqueIndex("warehouse_single_hq_main_unique")
      .on(table.purpose)
      .where(sql`${table.purpose} = 'HQ_MAIN' AND ${table.isActive} = true`),
  ],
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
  status: userStatusEnum("status").notNull().default("ACTIVE"),
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
    /** Immutable physical outlet snapshot resolved from the channel listing (D39). */
    locationId: uuid("location_id").references(() => locations.id),
    aggregatorAccountId: uuid("aggregator_account_id")
      .notNull()
      .references(() => aggregatorAccounts.id),
    aggregator: aggregatorEnum("aggregator").notNull(),
    externalRef: text("external_ref").notNull(),
    /**
     * Human-friendly copyable order reference (migration 0022), e.g.
     * "TOK-FP-7K3QD" — <BRAND 3 alnum chars, X-padded>-<FP|GF|WI>-<5-char
     * no-0/O/1/I base32 random>. Generated app-side in ingestOrder; nullable
     * only for schema-level flexibility (backfill gave legacy rows a 6-hex
     * md5(id) prefix). TS property is snake_case ON PURPOSE: order rows are
     * returned verbatim by GET /orders(/:id), so the property name IS the
     * public API field name — the contract says `order_code`.
     */
    order_code: text("order_code"),
    customerName: text("customer_name"),
    status: orderStatusEnum("status").notNull().default("NEW"),
    /** Required when status transitions to CANCELLED (MOTM 2026-07-01). */
    cancelReason: text("cancel_reason"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    prepAt: timestamp("prep_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * W4 (spec §10): the channel's BASE commission percent (0-100), snapshotted
     * from `channel_commercial_term` (src/db/w4-schema.ts) at ingestion time.
     * NULL = terms missing = a finance exception, NEVER silently treated as 0
     * ("Missing terms create a visible finance exception, not a silent 0%.").
     * The snapshot-at-ingestion lookup and finance-exception surfacing are
     * later streams' service logic; this column only stores the immutable
     * snapshot value.
     */
    commissionRateSnapshot: numeric("commission_rate_snapshot", { precision: 5, scale: 2 }),
    /** W4 (spec §10): the channel's MARKETING rate percent snapshot, same rules as above. */
    marketingRateSnapshot: numeric("marketing_rate_snapshot", { precision: 5, scale: 2 }),
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
    // Migration 0022 — copyable order codes are globally unique (NULLs exempt,
    // per Postgres unique-index semantics). ingestOrder retries once with a
    // fresh random suffix if it ever loses this race.
    uniqueIndex("order_order_code_unique").on(table.order_code),
    index("order_status_placed_at_idx").on(table.status, table.placedAt.desc()),
    index("order_brand_placed_at_idx").on(table.brandId, table.placedAt.desc()),
    index("order_aggregator_account_id_idx").on(table.aggregatorAccountId),
    index("order_location_placed_at_idx").on(table.locationId, table.placedAt.desc()),
    check(
      "order_commission_rate_snapshot_range",
      sql`${table.commissionRateSnapshot} IS NULL OR (${table.commissionRateSnapshot} >= 0 AND ${table.commissionRateSnapshot} <= 100)`,
    ),
    check(
      "order_marketing_rate_snapshot_range",
      sql`${table.marketingRateSnapshot} IS NULL OR (${table.marketingRateSnapshot} >= 0 AND ${table.marketingRateSnapshot} <= 100)`,
    ),
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
    /**
     * W4 (spec §6/§7 mirror of `customer_order_line.componentRequirementsSnapshot`,
     * customer-orders-schema.ts): recipe lines captured at order creation, e.g.
     * `[{ ingredientId, portionQty, uom }, ...]`. NULL for orders predating this
     * column / STOCKED_OUTPUT lines that never explode a BOM (spec §6 no-double-
     * deduction rule). Populating this snapshot and switching deduction to read
     * from it (behind the `orders.legacy_recipe_snapshot` feature flag) is later
     * streams' service work; this column only adds the storage.
     */
    componentSnapshot: jsonb("component_snapshot"),
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
    capability: printerCapabilityEnum("capability").notNull().default("ESC_POS_KOT"),
    documentType: text("document_type"),
    contentHash: text("content_hash"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    reprintOfId: uuid("reprint_of_id"),
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

// Immutable per-attempt history (§12): every claim that resolves (PRINTED, FAILED,
// or lease expiry reclaim) appends exactly one row; forbid_mutation enforces append-only.
export const printJobAttempts = pgTable(
  "print_job_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    printJobId: uuid("print_job_id").notNull().references(() => printJobs.id),
    attemptNo: integer("attempt_no").notNull(),
    agentId: uuid("agent_id").references(() => printAgents.id),
    leaseToken: text("lease_token").notNull(),
    result: printAttemptResultEnum("result").notNull(),
    error: text("error"),
    contentHash: text("content_hash"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("print_job_attempt_job_no_unique").on(table.printJobId, table.attemptNo),
    index("print_job_attempt_job_idx").on(table.printJobId),
    check("print_job_attempt_no_positive", sql`${table.attemptNo} > 0`),
  ],
).enableRLS();

export type PrintJobAttempt = typeof printJobAttempts.$inferSelect;

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
    // L4a: one agent identity per (name, location). Closes the registerAgent
    // select-then-insert race — a concurrent double-register now hits a DB
    // unique violation instead of silently creating a duplicate agent row.
    // (name is nullable; Postgres treats NULLs as distinct, so legacy null-name
    // rows are unaffected.)
    uniqueIndex("print_agent_name_location_unique").on(table.name, table.locationId),
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
// stock_reservation  (S4 — soft holds against KITCHEN stock, migration 0020)
//
// One row per (order, ingredient): a SOFT HOLD created at ingest against the
// order's outlet KITCHEN warehouse. available = inventory_stock.quantity −
// SUM(active reservations for that warehouse+ingredient). Rule #2 is NOT
// changed: real deduction still fires at NEW→PREPARING, which DELETES this
// order's reservation rows in the same transaction (the deduction replaces the
// hold). Cancel also deletes them (releases the hold for NEW-status cancels;
// harmless no-op after PREPARING).
// ---------------------------------------------------------------------------

export const stockReservations = pgTable(
  "stock_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stock_reservation_order_id_idx").on(table.orderId),
    index("stock_reservation_warehouse_ingredient_idx").on(
      table.warehouseId,
      table.ingredientId,
    ),
  ],
).enableRLS();

export type StockReservation = typeof stockReservations.$inferSelect;
export type NewStockReservation = typeof stockReservations.$inferInsert;

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
// stock_adjustment  (D26 — approved write-off / correction document, migration 0021)
//
// The client's MoM "ingredient expiry + over-order negligence" ask: a two-step
// (request → approve/reject) flow that, on approval, posts an ADJUSTMENT row to
// stock_ledger_entry and mutates inventory_stock in the SAME transaction.
//   • direction OUT = write-off / removal (decrements the balance);
//     direction IN  = correction that adds stock back.
//   • quantity is ALWAYS positive; the direction carries the sign.
//   • PENDING → APPROVED | REJECTED. Only OWNER / OUTLET_MANAGER may decide;
//     an OUTLET_MANAGER may not approve their OWN request (segregation of duties).
// ---------------------------------------------------------------------------

export const stockAdjustmentDirectionEnum = pgEnum("stock_adjustment_direction", ["IN", "OUT"]);

export const stockAdjustmentReasonEnum = pgEnum("stock_adjustment_reason", [
  "EXPIRY",
  "SPOILAGE",
  "NEGLIGENCE",
  "CORRECTION",
  "OTHER",
]);

export const stockAdjustmentStatusEnum = pgEnum("stock_adjustment_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const stockAdjustments = pgTable(
  "stock_adjustment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id),
    direction: stockAdjustmentDirectionEnum("direction").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    reason: stockAdjustmentReasonEnum("reason").notNull(),
    note: text("note"),
    status: stockAdjustmentStatusEnum("status").notNull().default("PENDING"),
    requestedBy: uuid("requested_by").references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stock_adjustment_status_idx").on(table.status),
    index("stock_adjustment_warehouse_ingredient_idx").on(
      table.warehouseId,
      table.ingredientId,
    ),
    index("stock_adjustment_created_at_idx").on(table.createdAt),
  ],
).enableRLS();

export type StockAdjustment = typeof stockAdjustments.$inferSelect;
export type NewStockAdjustment = typeof stockAdjustments.$inferInsert;

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
    /** Explicit policy: owners may be exempt while accounting/operations staff remain required. */
    attendanceRequired: boolean("attendance_required").notNull().default(true),
    /**
     * Weekly work schedule (Employee 360, migration 0025). CSV of day tokens drawn
     * from MON,TUE,WED,THU,FRI,SAT,SUN in canonical Mon→Sun order. Default = the
     * standard 5-day work week. The profile endpoint parses this into workDays:
     * string[] and uses it to classify each calendar day: a no-show on a SCHEDULED
     * day (from hire date on) is an ABSENCE; an unscheduled day is a REST day.
     */
    workDays: text("work_days").notNull().default("MON,TUE,WED,THU,FRI"),
    /** Hire date — calendar day, no time (migration 0025). NULL = unknown. */
    hiredAt: date("hired_at"),
    /**
     * Per-outlet employee assignment (client 2026-07-09, migration 0026). NULL
     * = unassigned / HQ — the employee is not yet tied to a physical outlet.
     */
    locationId: uuid("location_id").references(() => locations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("employee_user_id_idx").on(table.userId),
    index("employee_location_id_idx").on(table.locationId),
  ],
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
    locationId: uuid("location_id").references(() => locations.id),
    correlationId: text("correlation_id"),
    postingId: uuid("posting_id"),
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
    index("audit_log_location_created_idx").on(table.locationId, table.createdAt.desc()),
    index("audit_log_correlation_idx").on(table.correlationId),
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
    /**
     * The authed user who recorded this punch — derived from req.user (anti-spoof).
     * NULLABLE (0023): NULL = a public-kiosk punch (POST /public/attendance) made
     * with no logged-in session; the mandatory photo is the only identity evidence
     * and the audit row is credited to the "Public" actor. Authenticated punches
     * always set this from the verified token.
     */
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
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
    /**
     * NULLABLE (0024): NULL = a DIRECT receipt (POST /inventory/receive, no
     * purchase order) — gprci standard: every stock entry into MAIN still gets
     * a proper RR document even without a PO behind it.
     */
    poId: uuid("po_id").references(() => purchaseOrders.id),
    /**
     * Who delivered a DIRECT receipt (0024). PO-based receipts leave this NULL
     * and carry the supplier via the purchase order instead.
     */
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    /** Supplier's DR / invoice number for a direct receipt (0024). */
    reference: text("reference"),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    receivedByUserId: uuid("received_by_user_id").notNull().references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rr_po_id_idx").on(table.poId),
    index("rr_warehouse_id_idx").on(table.warehouseId),
    index("rr_supplier_id_idx").on(table.supplierId),
  ],
).enableRLS();
export type ReceivingReport = typeof receivingReports.$inferSelect;

export const receivingReportLines = pgTable(
  "receiving_report_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rrId: uuid("rr_id").notNull().references(() => receivingReports.id),
    /** NULLABLE (0024): NULL = a direct-receipt line (no purchase_order_line). */
    poLineId: uuid("po_line_id").references(() => purchaseOrderLines.id),
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

// ---------------------------------------------------------------------------
// Department budget threshold for purchasing (MOTM 2026-06-24 budget-threshold
// item). Each department gets a monthly peso budget; Purchase Requests warn
// (not block, first cut — see BUDGET_ENFORCEMENT in purchasing/budget.ts) when
// submitting would push that department's committed spend over the cap.
// ---------------------------------------------------------------------------

export const departmentBudgets = pgTable(
  "department_budget",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    department: departmentEnum("department").notNull(),
    periodMonth: text("period_month").notNull(), // 'YYYY-MM'
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("department_budget_dept_period_unique").on(table.department, table.periodMonth),
  ],
).enableRLS();
export type DepartmentBudget = typeof departmentBudgets.$inferSelect;
export type NewDepartmentBudget = typeof departmentBudgets.$inferInsert;

// ---------------------------------------------------------------------------
// W5: role_page_access  (admin-editable role -> page visibility matrix)
//
// Persists the same page-key set as the frontend's PAGE_ROLES map
// (ckitchen_frontend/src/auth/access.ts), so an OWNER can edit access without a
// code deploy. Frontend enforcement of this table is a separate workstream —
// this migration only adds the data + API layer. One row per (role, pageKey);
// every combination is seeded so GET /admin/rbac always returns a dense grid.
// ---------------------------------------------------------------------------

export const rolePageAccess = pgTable(
  "role_page_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: roleEnum("role").notNull(),
    pageKey: text("page_key").notNull(),
    allowed: boolean("allowed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("role_page_access_role_page_unique").on(table.role, table.pageKey)],
).enableRLS();

export type RolePageAccess = typeof rolePageAccess.$inferSelect;
export type NewRolePageAccess = typeof rolePageAccess.$inferInsert;

// ---------------------------------------------------------------------------
// Discounts / Promos + 3-layer approval workflow
// (MOTM 2026-07-01 items 2b, 2c, 7 — per-product promo/discount, 3 layers of
// approval [Generally Approved / Supervisor / Admin-Manager], discount per item)
//
// NON-REGRESSIVE (backend builder instructions): this is a SEPARATE layer on
// top of `order`. An order's total math and lifecycle (orders/service.ts) are
// NEVER mutated here. "Effective total" = order.total − Σ(APPROVED
// order_discount.amount), computed in this module only. An order with no
// discount rows behaves exactly as it does today.
//
// `discount` is the reusable catalog (promos/vouchers/statutory templates,
// optionally scoped to a brand and/or a single menu item — item 2b: "per
// Product an option to place promo/discount"). `order_discount` is what was
// actually APPLIED to a specific order (or a single order item via `label`),
// carrying the computed peso `amount` and the 3-layer approval routing.
// ---------------------------------------------------------------------------

export const discountTypeEnum = pgEnum("discount_type", [
  "PERCENT",
  "FIXED",
  "SENIOR",
  "PWD",
  "VOUCHER",
]);

export const discountScopeEnum = pgEnum("discount_scope", ["ITEM", "ORDER"]);

/** 3 layers of approval (MOTM 2c): AUTO = "Generally Approved". */
export const approvalLevelEnum = pgEnum("approval_level", ["AUTO", "SUPERVISOR", "ADMIN"]);

export const orderDiscountStatusEnum = pgEnum("order_discount_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

/** Promo/discount catalog. `value` is a percent (0-100) for PERCENT/SENIOR/PWD, a peso amount for FIXED. */
export const discounts = pgTable(
  "discount",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: discountScopeEnum("scope").notNull(),
    // Optional targeting (item 2b): null brand_id = platform-wide; null
    // menu_item_id with scope=ITEM = "any item" template, not yet targeted.
    brandId: uuid("brand_id").references(() => brands.id),
    menuItemId: uuid("menu_item_id").references(() => menuItems.id),
    name: text("name").notNull(),
    type: discountTypeEnum("type").notNull(),
    value: numeric("value", { precision: 14, scale: 2 }).notNull(),
    code: text("code"),
    vatExempt: boolean("vat_exempt").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("discount_brand_id_idx").on(table.brandId),
    index("discount_menu_item_id_idx").on(table.menuItemId),
    index("discount_active_idx").on(table.active),
  ],
).enableRLS();

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;

/**
 * A discount actually applied to an order (from the catalog, or ad-hoc), plus
 * its 3-layer approval state. `amount` is the computed peso reduction, snapshot
 * at apply time (never recomputed off a later-edited catalog row). Only
 * APPROVED rows reduce the order's effective total (see service.ts).
 */
export const orderDiscounts = pgTable(
  "order_discount",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    discountId: uuid("discount_id").references(() => discounts.id),
    type: discountTypeEnum("type").notNull(),
    label: text("label").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    approvalLevel: approvalLevelEnum("approval_level").notNull(),
    status: orderDiscountStatusEnum("status").notNull().default("PENDING"),
    reason: text("reason"),
    // Senior/PWD ID capture (statutory requirement — rejected without it).
    idNote: text("id_note"),
    /**
     * W4 (spec §10): private storage key for the discount's ID-image evidence
     * (senior/PWD or other variable-discount proof). NEVER a public URL — the
     * evidence is served only through short-lived signed URLs, excluded from
     * ordinary order/report responses, and every access is durably audited
     * via `discount_evidence_access_log` (src/db/w4-schema.ts). The signed-URL
     * issuance flow itself is later streams' service work.
     */
    evidenceRef: text("evidence_ref"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("order_discount_order_id_idx").on(table.orderId),
    index("order_discount_status_idx").on(table.status),
    index("order_discount_discount_id_idx").on(table.discountId),
  ],
).enableRLS();

export type OrderDiscount = typeof orderDiscounts.$inferSelect;
export type NewOrderDiscount = typeof orderDiscounts.$inferInsert;
