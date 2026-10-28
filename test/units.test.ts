/**
 * Units of measure (D57): exact conversion, any number of typed decimals, custom units per
 * ingredient, and the end-to-end guarantee that matters for stock: a recipe typed as 250 g
 * for an ingredient stocked in kg deducts 0.25 kg per serving, never 250.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { QuantityError, normalizeQuantity, parseDecimal, scaleQuantity, standardUnitCode } from "../src/modules/units/catalog.js";
import { toStockQuantity, type IngredientUnits } from "../src/modules/units/service.js";

describe("exact conversion", () => {
  it("keeps the 6-decimal standard, rounding half-up once", () => {
    expect(normalizeQuantity("0.112312312312312")).toBe("0.112312");
    expect(normalizeQuantity("0.1123125")).toBe("0.112313");
    expect(normalizeQuantity(0.25)).toBe("0.250000");
    expect(normalizeQuantity(".5")).toBe("0.500000");
    expect(normalizeQuantity("-1.0000005")).toBe("-1.000001");
  });

  it("converts between units of a kind without floating-point drift", () => {
    expect(scaleQuantity("250", "1", "1000")).toBe("0.250000"); // g -> kg
    expect(scaleQuantity("0.25", "1000", "1")).toBe("250.000000"); // kg -> g
    expect(scaleQuantity("1", "453.59237", "1000")).toBe("0.453592"); // lb -> kg
    expect(scaleQuantity("1", "1000", "453.59237")).toBe("2.204623"); // kg -> lb (non-terminating)
    expect(scaleQuantity("3", "14.78676478125", "1")).toBe("44.360294"); // tbsp -> mL
    expect(scaleQuantity("0.1", "3", "1")).toBe("0.300000"); // 0.1 * 3 is exactly 0.3 here
  });

  it("rejects what is not a plain number", () => {
    for (const bad of ["1e3", "abc", "", "1,5", "NaN", "--1"]) expect(() => parseDecimal(bad), bad).toThrow(QuantityError);
  });

  it("recognises everyday spellings", () => {
    expect(standardUnitCode("Kgs")).toBe("kg");
    expect(standardUnitCode(" grams ")).toBe("g");
    expect(standardUnitCode("Liter")).toBe("L");
    expect(standardUnitCode("pcs")).toBe("pc");
    expect(standardUnitCode("sack")).toBeNull();
  });
});

describe("typed quantity -> stock unit", () => {
  const potato: IngredientUnits = {
    ingredientId: "x",
    ingredientName: "Potato",
    stockUnit: "kg",
    custom: [{ name: "sack", toStock: "25" }],
  };

  it("standard units of the same kind convert; the typed value is kept for display", () => {
    expect(toStockQuantity(potato, "250", "g")).toEqual({ stockQuantity: "0.250000", enteredQuantity: "250.000000", enteredUnit: "g" });
    expect(toStockQuantity(potato, "0.112312312312312", "kg").stockQuantity).toBe("0.112312");
    expect(toStockQuantity(potato, "112312.312312", "mg").stockQuantity).toBe("0.112312");
    expect(toStockQuantity(potato, "2", "Kgs").enteredUnit).toBe("kg");
  });

  it("a custom unit of the ingredient converts by its own factor", () => {
    expect(toStockQuantity(potato, "2", "sack").stockQuantity).toBe("50.000000");
    expect(toStockQuantity(potato, "0.5", "SACK").stockQuantity).toBe("12.500000");
  });

  it("no unit means the stock unit", () => {
    expect(toStockQuantity(potato, "1.5").stockQuantity).toBe("1.500000");
  });

  it("a unit of another kind, or unknown, is refused with both units named", () => {
    expect(() => toStockQuantity(potato, "1", "L")).toThrow(/stocked in kg/);
    expect(() => toStockQuantity(potato, "1", "box")).toThrow(/"box" cannot be converted/);
  });
});

describe("API", () => {
  let app: Express;
  let db: DB;
  let owner: string;
  let warehouse: string;
  let kitchen: string;
  let grillStationId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (email: string, password: string) => (await request(app).post("/api/v1/auth/login").send({ email, password })).body.token as string;

  async function ingredient(name: string, unit: string) {
    const res = await request(app).post("/api/v1/ingredients").set(auth(owner)).send({ name, unit, unit_cost: "100", low_stock_threshold: "1" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; unit: string };
  }

  beforeAll(async () => {
    db = createDb().db;
    await seed(db);
    app = createApp(db);
    owner = await login("admin@cloudkitchen.local", "admin123");
    warehouse = await login("warehouse@cloudkitchen.local", "password123");
    kitchen = await login("kitchen_staff@cloudkitchen.local", "password123");
    const stations = await request(app).get("/api/v1/stations").set(auth(owner));
    grillStationId = (stations.body as { id: string; name: string }[]).find((s) => s.name === "Grill")!.id;
  });

  it("a new ingredient's unit is saved in its catalogue spelling", async () => {
    expect((await ingredient("Units Rice", "Kgs")).unit).toBe("kg");
    expect((await ingredient("Units Egg", "pieces")).unit).toBe("pc");
    expect((await ingredient("Units Bread", "loaf")).unit).toBe("loaf"); // custom stock unit kept
  });

  it("lists the units a quantity may be typed in, and saves custom units by what was typed", async () => {
    const potato = await ingredient("Units Potato", "kg");
    const before = await request(app).get(`/api/v1/ingredients/${potato.id}/units`).set(auth(kitchen));
    expect(before.status).toBe(200);
    expect(before.body.choices.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(["kg", "g", "mg", "lb", "oz"]));
    expect(before.body.choices.map((c: { code: string }) => c.code)).not.toContain("L");

    const put = await request(app)
      .put(`/api/v1/ingredients/${potato.id}/units`)
      .set(auth(owner))
      .send({ custom: [{ name: "sack", amount: "25", unit: "kg" }, { name: "scoop", amount: "120", unit: "g" }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.custom).toEqual(expect.arrayContaining([{ name: "sack", toStock: "25.00000000" }, { name: "scoop", toStock: "0.12000000" }]));

    // Absolute state: saving again with one unit removes the other.
    const again = await request(app).put(`/api/v1/ingredients/${potato.id}/units`).set(auth(owner)).send({ custom: [{ name: "sack", amount: "25", unit: "kg" }] });
    expect(again.body.custom.map((c: { name: string }) => c.name)).toEqual(["sack"]);

    for (const bad of [
      { name: "g", amount: "1", unit: "kg" }, // already a standard unit
      { name: "box", amount: "1", unit: "L" }, // other kind
      { name: "zero", amount: "0", unit: "kg" },
    ]) {
      const res = await request(app).put(`/api/v1/ingredients/${potato.id}/units`).set(auth(owner)).send({ custom: [bad] });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await request(app).put(`/api/v1/ingredients/${potato.id}/units`).set(auth(kitchen)).send({ custom: [] })).status).toBe(403);
  });

  it("recipe: 250 g of an ingredient stocked in kg is stored as 0.25 kg, and shown as typed", async () => {
    const potato = await ingredient("Units Recipe Potato", "kg");
    const brand = await request(app).post("/api/v1/brands").set(auth(owner)).send({ name: "Units Fries", color: "#123456" });
    const item = await request(app).post(`/api/v1/brands/${brand.body.id}/menu`).set(auth(owner)).send({ name: "Large Fries", price: "90", station_id: grillStationId });
    const put = await request(app)
      .put(`/api/v1/menu/${item.body.id}/recipe`)
      .set(auth(owner))
      .send({ lines: [{ ingredient_id: potato.id, quantity: "250", unit: "g" }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body[0]).toMatchObject({ portionQty: "0.250000", unit: "kg", enteredQuantity: "250.000000", enteredUnit: "g" });

    const precise = await request(app)
      .put(`/api/v1/menu/${item.body.id}/recipe`)
      .set(auth(owner))
      .send({ lines: [{ ingredient_id: potato.id, quantity: "0.112312312312312", unit: "kg" }] });
    expect(precise.body[0].portionQty).toBe("0.112312");

    const wrongKind = await request(app)
      .put(`/api/v1/menu/${item.body.id}/recipe`)
      .set(auth(owner))
      .send({ lines: [{ ingredient_id: potato.id, quantity: "1", unit: "L" }] });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.message).toMatch(/stocked in kg/);
  });

  it("an older client sending portion_qty in the stock unit still works", async () => {
    const salt = await ingredient("Units Salt", "g");
    const brand = await request(app).post("/api/v1/brands").set(auth(owner)).send({ name: "Units Legacy", color: "#123456" });
    const item = await request(app).post(`/api/v1/brands/${brand.body.id}/menu`).set(auth(owner)).send({ name: "Salted", price: "10", station_id: grillStationId });
    const put = await request(app).put(`/api/v1/menu/${item.body.id}/recipe`).set(auth(owner)).send({ lines: [{ ingredient_id: salt.id, portion_qty: 5, unit: "g" }] });
    expect(put.status).toBe(200);
    expect(put.body[0]).toMatchObject({ portionQty: "5.000000", unit: "g" });
  });

  it("an order deducts in the stock unit: 2 x (250 g) from potatoes stocked in kg = 0.5 kg", async () => {
    const potato = await ingredient("Units Deduct Potato", "kg");
    await request(app).post("/api/v1/inventory/receive").set(auth(warehouse)).send({ items: [{ ingredient_id: potato.id, quantity: 10 }] });
    const ito = await request(app).post("/api/v1/itos").set(auth(kitchen)).send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: potato.id, quantity: 10 }] });
    await request(app).post(`/api/v1/itos/${ito.body.id}/confirm`).set(auth(warehouse));

    const brand = await request(app).post("/api/v1/brands").set(auth(owner)).send({ name: "Units Deduct Brand", color: "#123456" });
    await request(app).post(`/api/v1/brands/${brand.body.id}/accounts`).set(auth(owner)).send({ aggregator: "FOODPANDA", external_merchant_id: "FP-UNITS-1", credential_ref: "ref-units" });
    const item = await request(app).post(`/api/v1/brands/${brand.body.id}/menu`).set(auth(owner)).send({ name: "Fries 250g", price: "90", station_id: grillStationId });
    await request(app).put(`/api/v1/menu/${item.body.id}/recipe`).set(auth(owner)).send({ lines: [{ ingredient_id: potato.id, quantity: "250", unit: "g" }] });

    const order = await request(app)
      .post("/api/v1/ingest/order")
      .set(auth(owner))
      .send({ brand_id: brand.body.id, aggregator: "FOODPANDA", external_ref: "FP-UNITS-ORDER-1", customer_name: "Units", items: [{ menu_item_id: item.body.id, qty: 2 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect((await request(app).post(`/api/v1/orders/${order.body.order_id}/advance`).set(auth(owner))).status).toBe(200);

    const stock = await request(app).get("/api/v1/inventory?warehouse=KITCHEN").set(auth(owner));
    const row = (stock.body as { ingredientId: string; quantity: string }[]).find((r) => r.ingredientId === potato.id);
    expect(Number(row!.quantity)).toBeCloseTo(9.5, 6);
  });

  it("stock routes take any unit: receive 2 sacks at 1000 per sack = 50 kg at 40/kg; transfer and request in grams", async () => {
    const rice = await ingredient("Units Rice Sacks", "kg");
    await request(app).put(`/api/v1/ingredients/${rice.id}/units`).set(auth(owner)).send({ custom: [{ name: "sack", amount: "25", unit: "kg" }] });

    const received = await request(app)
      .post("/api/v1/inventory/receive")
      .set(auth(warehouse))
      .send({ items: [{ ingredient_id: rice.id, quantity: 2, unit: "sack", unit_cost: 1000 }] });
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    const main = async () =>
      Number(((await request(app).get("/api/v1/inventory?warehouse=MAIN").set(auth(owner))).body as { ingredientId: string; quantity: string }[]).find((r) => r.ingredientId === rice.id)!.quantity);
    expect(await main()).toBeCloseTo(50, 6);
    // The delivery is recorded in the stock ledger in kg, at the price per kg.
    const ledgerRows = await db.execute(
      sql`select quantity, unit_cost from stock_ledger_entry where source_module = 'RECEIVE' and source_document_no = ${received.body.rr.rrNo}`,
    );
    const entry = ((ledgerRows as unknown as { rows: { quantity: string; unit_cost: string }[] }).rows)[0]!;
    expect(Number(entry.quantity)).toBeCloseTo(50, 6);
    expect(Number(entry.unit_cost)).toBeCloseTo(40, 6); // 1000 per sack -> 40 per kg

    const ito = await request(app)
      .post("/api/v1/itos")
      .set(auth(kitchen))
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: rice.id, quantity: 1500, unit: "g" }] });
    expect(ito.status, JSON.stringify(ito.body)).toBe(201);
    const itoRows = await db.execute(sql`select quantity from ito_item where ito_id = ${ito.body.id}`);
    expect(Number(((itoRows as unknown as { rows: { quantity: string }[] }).rows)[0]!.quantity)).toBeCloseTo(1.5, 6); // 1500 g

    const unitMismatch = await request(app)
      .post("/api/v1/inventory/receive")
      .set(auth(warehouse))
      .send({ items: [{ ingredient_id: rice.id, quantity: 1, unit: "L" }] });
    expect(unitMismatch.status).toBe(400);

    const pr = await request(app)
      .post("/api/v1/purchase-requests")
      .set(auth(owner))
      .send({ department: "KITCHEN", lines: [{ ingredient_id: rice.id, quantity: 500, unit: "g", est_unit_cost: 0.05 }] });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const prRows = await db.execute(sql`select quantity, est_unit_cost from purchase_request_line where pr_id = ${pr.body.id}`);
    const prLine = ((prRows as unknown as { rows: { quantity: string; est_unit_cost: string }[] }).rows)[0]!;
    expect(Number(prLine.quantity)).toBeCloseTo(0.5, 6); // 500 g
    expect(Number(prLine.est_unit_cost)).toBeCloseTo(50, 6); // 0.05 per g = 50 per kg
  });

  it("a stock adjustment typed in grams is requested in kg", async () => {
    const butter = await ingredient("Units Butter", "kg");
    await request(app).post("/api/v1/inventory/receive").set(auth(warehouse)).send({ items: [{ ingredient_id: butter.id, quantity: 2 }] });
    const warehouses = await db.execute(sql`select id from warehouse where type = 'MAIN' limit 1`);
    const warehouseId = ((warehouses as unknown as { rows: { id: string }[] }).rows)[0]!.id;
    const adjustment = await request(app)
      .post("/api/v1/adjustments")
      .set(auth(owner))
      .send({ warehouse_id: warehouseId, ingredient_id: butter.id, direction: "OUT", quantity: 125, unit: "g", reason: "SPOILAGE" });
    expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(201);
    const rows = await db.execute(sql`select quantity from stock_adjustment where ingredient_id = ${butter.id}`);
    expect(Number(((rows as unknown as { rows: { quantity: string }[] }).rows)[0]!.quantity)).toBeCloseTo(0.125, 6);
  });

  it("the stock unit cannot be switched once stock, history or recipes use it", async () => {
    const flour = await ingredient("Units Flour", "kg");
    expect((await request(app).patch(`/api/v1/ingredients/${flour.id}`).set(auth(owner)).send({ unit: "g" })).status).toBe(200); // unused: allowed
    await request(app).post("/api/v1/inventory/receive").set(auth(warehouse)).send({ items: [{ ingredient_id: flour.id, quantity: 500 }] });
    const blocked = await request(app).patch(`/api/v1/ingredients/${flour.id}`).set(auth(owner)).send({ unit: "kg" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("UNIT_IN_USE");
  });
});
