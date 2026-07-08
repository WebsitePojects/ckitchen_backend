/**
 * Pilot Seed — CK1-PLAN-004 §5 (5-Brand Pilot Dataset)
 *
 * Idempotently builds the 5-brand pilot on top of the base seed:
 *
 *   Ingredients (with unit_cost + low_stock_threshold):
 *     Chicken (g, threshold 500 g), Pork (g, threshold 5000 g / 5 kg),
 *     Mixed Veg (g), Lettuce (g), Tea Syrup (ml)
 *
 *   Printers: one NETWORK printer each for Grill, Fry, and Beverage stations
 *   Station defaults updated to reference their printer
 *
 *   5 Brands + FOODPANDA & GRABFOOD accounts each:
 *     Tokyo House   → Teriyaki Chicken (Grill, 200 g Chicken)
 *                    Chicken Tonkatsu  (Fry,   150 g Chicken)
 *     Seoul Bowl    → Korean Fried Chicken (Fry, 220 g Chicken — SHARED Chicken pool)
 *     Manila Lechon → Lechon Rice (Grill, 180 g Pork)
 *     Green Garden  → Veggie Wrap (Prep, 120 g Mixed Veg)
 *                    Garden Salad (Prep, 90 g Lettuce)
 *     Sip & Co      → Iced Tea (Beverage, 30 ml Tea Syrup)
 *
 *   Starting stock (MAIN generous; KITCHEN set for the SRS §5.2 scenario):
 *     KITCHEN Pork = 5180 g  (one Lechon Rice order → 5180-180=5000 g → hits threshold)
 *     KITCHEN Chicken = 3000 g (Tokyo House + Seoul Bowl orders deplete 570 g in the test)
 *
 * Safe to re-run: all inserts are guarded by name-based idempotency checks.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { eq, and } from "drizzle-orm";
import type { DB } from "./client.js";
import {
  aggregatorAccounts,
  brands,
  ingredients,
  inventoryStock,
  kitchenStations,
  menuItems,
  printers,
  recipeLines,
  warehouses,
} from "./schema.js";
import { runMigrations } from "./migrate.js";
import { seed as baseSeed } from "./seed.js";

// ---------------------------------------------------------------------------
// Pilot constants
// ---------------------------------------------------------------------------

const PILOT_INGREDIENTS = [
  { name: "Chicken",   unit: "g",  unitCost: "0.15", lowStockThreshold: "500" },
  { name: "Pork",      unit: "g",  unitCost: "0.12", lowStockThreshold: "5000" },
  { name: "Mixed Veg", unit: "g",  unitCost: "0.08", lowStockThreshold: "200" },
  { name: "Lettuce",   unit: "g",  unitCost: "0.05", lowStockThreshold: "100" },
  { name: "Tea Syrup", unit: "ml", unitCost: "0.10", lowStockThreshold: "100" },
] as const;

const PILOT_PRINTERS = [
  { name: "Grill Printer",    connection: "NETWORK" as const, address: "192.168.1.50:9100", station: "Grill" },
  { name: "Fry Printer",      connection: "NETWORK" as const, address: "192.168.1.51:9100", station: "Fry" },
  { name: "Beverage Printer", connection: "NETWORK" as const, address: "192.168.1.52:9100", station: "Beverage" },
] as const;

// Starting KITCHEN stock quantities designed for the SRS §5.2 acceptance scenario:
//   Pork = 5180 g so ONE Lechon Rice order (180 g) puts the balance at exactly 5000 g
//   (the threshold), triggering the low-stock alert.
const KITCHEN_STARTING_STOCK: Record<string, number> = {
  Chicken:   3000,   // enough for the 570 g deduction test
  Pork:      5180,   // one 180 g deduction → 5000 g = threshold
  "Mixed Veg": 1000,
  Lettuce:    500,
  "Tea Syrup": 1000,
};

const MAIN_STARTING_STOCK: Record<string, number> = {
  Chicken:   20000,
  Pork:      20000,
  "Mixed Veg": 10000,
  Lettuce:    5000,
  "Tea Syrup": 5000,
};

// ---------------------------------------------------------------------------
// Brand + menu definitions
// ---------------------------------------------------------------------------

interface MenuItemDef {
  name: string;
  price: string;
  prepTimeMin: number;
  stationName: "Grill" | "Fry" | "Prep" | "Beverage" | "Packing";
  recipe: Array<{ ingredientName: string; portionQty: number; unit: string }>;
}

interface BrandDef {
  name: string;
  color: string;
  items: MenuItemDef[];
}

const PILOT_BRANDS: BrandDef[] = [
  {
    name: "Tokyo House",
    color: "#E63946",
    items: [
      {
        name: "Teriyaki Chicken",
        price: "195.00",
        prepTimeMin: 12,
        stationName: "Grill",
        recipe: [{ ingredientName: "Chicken", portionQty: 200, unit: "g" }],
      },
      {
        name: "Chicken Tonkatsu",
        price: "185.00",
        prepTimeMin: 10,
        stationName: "Fry",
        recipe: [{ ingredientName: "Chicken", portionQty: 150, unit: "g" }],
      },
    ],
  },
  {
    name: "Seoul Bowl",
    color: "#F4A261",
    items: [
      {
        name: "Korean Fried Chicken",
        price: "220.00",
        prepTimeMin: 14,
        stationName: "Fry",
        recipe: [{ ingredientName: "Chicken", portionQty: 220, unit: "g" }],
      },
    ],
  },
  {
    name: "Manila Lechon",
    color: "#8B2FC9",
    items: [
      {
        name: "Lechon Rice",
        price: "175.00",
        prepTimeMin: 8,
        stationName: "Grill",
        recipe: [{ ingredientName: "Pork", portionQty: 180, unit: "g" }],
      },
    ],
  },
  {
    name: "Green Garden",
    color: "#2D6A4F",
    items: [
      {
        name: "Veggie Wrap",
        price: "145.00",
        prepTimeMin: 7,
        stationName: "Prep",
        recipe: [{ ingredientName: "Mixed Veg", portionQty: 120, unit: "g" }],
      },
      {
        name: "Garden Salad",
        price: "120.00",
        prepTimeMin: 5,
        stationName: "Prep",
        recipe: [{ ingredientName: "Lettuce", portionQty: 90, unit: "g" }],
      },
    ],
  },
  {
    name: "Sip & Co",
    color: "#219EBC",
    items: [
      {
        name: "Iced Tea",
        price: "75.00",
        prepTimeMin: 3,
        stationName: "Beverage",
        recipe: [{ ingredientName: "Tea Syrup", portionQty: 30, unit: "ml" }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Public interfaces returned from seedPilot()
// ---------------------------------------------------------------------------

export interface PilotIds {
  ingredients: Record<string, string>; // name → id
  brands: Record<string, string>;      // name → id
  menuItems: Record<string, string>;   // "Brand/ItemName" → id
  accounts: Record<string, { fp: string; gb: string }>; // brandName → { fp, gb }
  printers: Record<string, string>;    // station name → printer id
  warehouses: { main: string; kitchen: string };
}

// ---------------------------------------------------------------------------
// seedPilot — main idempotent function
// ---------------------------------------------------------------------------

export async function seedPilot(db: DB): Promise<PilotIds> {
  await runMigrations(db);

  // ── 0. Ensure base seed has run (location, stations, warehouses) ─────────
  await baseSeed(db);

  // ── 1. Resolve location id ───────────────────────────────────────────────
  const [location] = await db.select().from(
    (await import("./schema.js")).locations,
  );
  if (!location) throw new Error("No location found — run the base seed first.");
  const locationId = location.id;

  // ── 2. Resolve station map ───────────────────────────────────────────────
  const stationRows = await db
    .select()
    .from(kitchenStations)
    .where(eq(kitchenStations.locationId, locationId));
  const stationByName = new Map(stationRows.map((s) => [s.name, s]));

  // ── 3. Resolve warehouse ids ─────────────────────────────────────────────
  const warehouseRows = await db
    .select()
    .from(warehouses)
    .where(eq(warehouses.locationId, locationId));
  const mainWarehouse = warehouseRows.find((w) => w.type === "MAIN");
  const kitchenWarehouse = warehouseRows.find((w) => w.type === "KITCHEN");
  if (!mainWarehouse || !kitchenWarehouse)
    throw new Error("MAIN or KITCHEN warehouse missing — run the base seed first.");

  // ── 3b. Suppliers (idempotent by code) ────────────────────────────────────
  // The recipe builder's inline "New ingredient" flow REQUIRES a supplier
  // affiliation (ERP discipline: every ingredient states where it comes from),
  // so a pilot environment without suppliers dead-ends that flow (live-QA
  // find 2026-07-08 — same data-precondition class as the walk-in listing).
  const { suppliers } = await import("./schema.js");
  const PILOT_SUPPLIERS = [
    { code: "SMF", name: "San Miguel Foods", contactName: "Ana Reyes", paymentTermDays: 30 },
    { code: "MPD", name: "Metro Produce Distributors", contactName: "Jun Santos", paymentTermDays: 15 },
    { code: "MGP", name: "Magnolia Poultry Supply", contactName: "Liza Cruz", paymentTermDays: 30 },
  ];
  for (const s of PILOT_SUPPLIERS) {
    const [existing] = await db.select().from(suppliers).where(eq(suppliers.code, s.code));
    if (!existing) await db.insert(suppliers).values(s);
  }

  // ── 4. Ingredients (idempotent by name) ──────────────────────────────────
  const existingIngredients = await db.select().from(ingredients);
  const ingByName = new Map(existingIngredients.map((i) => [i.name, i]));

  for (const def of PILOT_INGREDIENTS) {
    if (!ingByName.has(def.name)) {
      const [ing] = await db
        .insert(ingredients)
        .values({
          name: def.name,
          unit: def.unit,
          unitCost: def.unitCost,
          lowStockThreshold: def.lowStockThreshold,
        })
        .returning();
      ingByName.set(ing.name, ing);
    }
  }

  const ingredientIds: Record<string, string> = {};
  for (const [name, ing] of ingByName.entries()) {
    ingredientIds[name] = ing.id;
  }

  // ── 5. Printers + station defaults (idempotent by name) ──────────────────
  const existingPrinters = await db.select().from(printers);
  const printerByName = new Map(existingPrinters.map((p) => [p.name, p]));
  const printerIdByStation: Record<string, string> = {};

  for (const def of PILOT_PRINTERS) {
    let printer = printerByName.get(def.name);
    if (!printer) {
      [printer] = await db
        .insert(printers)
        .values({
          name: def.name,
          connection: def.connection,
          address: def.address,
        })
        .returning();
      printerByName.set(printer.name, printer);
    }
    printerIdByStation[def.station] = printer.id;

    // Update the station's default printer if not already set
    const station = stationByName.get(def.station);
    if (station && station.defaultPrinterId !== printer.id) {
      await db
        .update(kitchenStations)
        .set({ defaultPrinterId: printer.id })
        .where(eq(kitchenStations.id, station.id));
    }
  }

  // ── 6. Brands + aggregator accounts + menu items + recipes ───────────────
  const existingBrands = await db
    .select()
    .from(brands)
    .where(eq(brands.locationId, locationId));
  const brandByName = new Map(existingBrands.map((b) => [b.name, b]));

  const brandIds: Record<string, string> = {};
  const menuItemIds: Record<string, string> = {};
  const accountIds: Record<string, { fp: string; gb: string }> = {};

  for (const brandDef of PILOT_BRANDS) {
    // Brand (idempotent by name)
    let brand = brandByName.get(brandDef.name);
    if (!brand) {
      [brand] = await db
        .insert(brands)
        .values({
          locationId,
          name: brandDef.name,
          color: brandDef.color,
          salesPerfId: brandDef.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        })
        .returning();
      brandByName.set(brand.name, brand);
    }
    const brandId = brand.id;
    brandIds[brandDef.name] = brandId;

    // Aggregator accounts (idempotent by brand+aggregator)
    const existingAccounts = await db
      .select()
      .from(aggregatorAccounts)
      .where(eq(aggregatorAccounts.brandId, brandId));
    const accByAgg = new Map(existingAccounts.map((a) => [a.aggregator, a]));

    let fpAcc = accByAgg.get("FOODPANDA");
    if (!fpAcc) {
      [fpAcc] = await db
        .insert(aggregatorAccounts)
        .values({
          brandId,
          aggregator: "FOODPANDA",
          externalMerchantId: `FP-${brandDef.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}`,
          credentialRef: `ref-fp-${brandId.slice(0, 8)}`,
        })
        .returning();
    }

    let gbAcc = accByAgg.get("GRABFOOD");
    if (!gbAcc) {
      [gbAcc] = await db
        .insert(aggregatorAccounts)
        .values({
          brandId,
          aggregator: "GRABFOOD",
          externalMerchantId: `GF-${brandDef.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}`,
          credentialRef: `ref-gf-${brandId.slice(0, 8)}`,
        })
        .returning();
    }

    // Walk-in channel (aggregator OTHER) — required by the Walk-In Order
    // dialog and manual entry: ingest resolves an aggregator account for
    // EVERY order (listing-scoped idempotency, Rule #5), so a brand without
    // an OTHER listing 404s on walk-in ingest (found in live QA 2026-07-08).
    if (!accByAgg.get("OTHER")) {
      await db.insert(aggregatorAccounts).values({
        brandId,
        aggregator: "OTHER",
        externalMerchantId: `WALKIN-${brandDef.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}`,
        credentialRef: `ref-walkin-${brandId.slice(0, 8)}`,
      });
    }

    accountIds[brandDef.name] = { fp: fpAcc.id, gb: gbAcc.id };

    // Menu items + recipes
    const existingItems = await db
      .select()
      .from(menuItems)
      .where(eq(menuItems.brandId, brandId));
    const itemByName = new Map(existingItems.map((i) => [i.name, i]));

    for (const itemDef of brandDef.items) {
      const stationId = stationByName.get(itemDef.stationName)?.id;
      if (!stationId) throw new Error(`Station ${itemDef.stationName} not found.`);

      let item = itemByName.get(itemDef.name);
      if (!item) {
        [item] = await db
          .insert(menuItems)
          .values({
            brandId,
            name: itemDef.name,
            price: itemDef.price,
            prepTimeMin: itemDef.prepTimeMin,
            stationId,
            availability: "AVAILABLE",
          })
          .returning();
        itemByName.set(item.name, item);
      }
      menuItemIds[`${brandDef.name}/${itemDef.name}`] = item.id;

      // Recipes (idempotent: replace if menu item has no recipe lines yet)
      const existingLines = await db
        .select()
        .from(recipeLines)
        .where(eq(recipeLines.menuItemId, item.id));

      if (existingLines.length === 0) {
        for (const recipeDef of itemDef.recipe) {
          const ingId = ingredientIds[recipeDef.ingredientName];
          if (!ingId) throw new Error(`Ingredient ${recipeDef.ingredientName} not found.`);

          await db.insert(recipeLines).values({
            menuItemId: item.id,
            ingredientId: ingId,
            portionQty: String(recipeDef.portionQty),
            unit: recipeDef.unit,
          });
        }
      }
    }
  }

  // ── 7. Starting stock (idempotent: only add if row is absent / qty = 0) ──
  for (const [ingName, qty] of Object.entries(MAIN_STARTING_STOCK)) {
    const ingId = ingredientIds[ingName];
    if (!ingId) continue;

    const [existing] = await db
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.warehouseId, mainWarehouse.id),
          eq(inventoryStock.ingredientId, ingId),
        ),
      );

    if (!existing) {
      await db.insert(inventoryStock).values({
        warehouseId: mainWarehouse.id,
        ingredientId: ingId,
        quantity: String(qty),
      });
    }
  }

  for (const [ingName, qty] of Object.entries(KITCHEN_STARTING_STOCK)) {
    const ingId = ingredientIds[ingName];
    if (!ingId) continue;

    const [existing] = await db
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.warehouseId, kitchenWarehouse.id),
          eq(inventoryStock.ingredientId, ingId),
        ),
      );

    if (!existing) {
      await db.insert(inventoryStock).values({
        warehouseId: kitchenWarehouse.id,
        ingredientId: ingId,
        quantity: String(qty),
      });
    }
  }

  return {
    ingredients: ingredientIds,
    brands: brandIds,
    menuItems: menuItemIds,
    accounts: accountIds,
    printers: printerIdByStation,
    warehouses: { main: mainWarehouse.id, kitchen: kitchenWarehouse.id },
  };
}

// ---------------------------------------------------------------------------
// `npm run seed:pilot` entrypoint
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { createDb, closeDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });

  console.log("Running pilot seed...");
  const ids = await seedPilot(db);

  console.log("\nPilot seed complete.");
  console.log(`\nBrands (${Object.keys(ids.brands).length}):`);
  for (const [name, id] of Object.entries(ids.brands)) {
    console.log(`  ${name.padEnd(20)} ${id}`);
  }
  console.log(`\nMenu items (${Object.keys(ids.menuItems).length}):`);
  for (const [key, id] of Object.entries(ids.menuItems)) {
    console.log(`  ${key.padEnd(35)} ${id}`);
  }
  console.log(`\nIngredients (${Object.keys(ids.ingredients).length}):`);
  for (const [name, id] of Object.entries(ids.ingredients)) {
    console.log(`  ${name.padEnd(15)} ${id}`);
  }
  console.log("\nWarehouses:");
  console.log(`  MAIN    ${ids.warehouses.main}`);
  console.log(`  KITCHEN ${ids.warehouses.kitchen}`);

  await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
}
