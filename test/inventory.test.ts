/**
 * Task 5 — Two-tier Inventory + ITO + Low-stock
 *
 * Tests §6 of CK1-API-003 and Cardinal Business Rules:
 *   #4 — ITO stock moves are atomic: MAIN -= qty AND KITCHEN += qty in ONE transaction.
 *   #8 — Low-stock alert when KITCHEN ingredient <= low_stock_threshold.
 *
 * RBAC (per role matrix §1):
 *   inventory receive / ITO confirm → SUPER_ADMIN | WAREHOUSE
 *   ITO request / consumption log  → SUPER_ADMIN | KITCHEN_STAFF
 *   ingredient create              → SUPER_ADMIN only
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

let app: Express;
let db: DB;
let adminToken: string;
let warehouseToken: string;
let kitchenToken: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await seed(db); // runs migrations + seeds 1 location, 5 stations, 2 warehouses (MAIN+KITCHEN), role users

  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
});

// ---------------------------------------------------------------------------
// Multi-outlet isolation: each outlet owns its MAIN + KITCHEN warehouse pair
// ---------------------------------------------------------------------------

describe("Multi-outlet inventory isolation", () => {
  let ingredientId: string;
  let outletAId: string;
  let outletBId: string;
  let outletBItoId: string;

  beforeAll(async () => {
    const ingredientRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Outlet Isolated Rice",
        unit: "kg",
        unit_cost: "42.00",
        low_stock_threshold: "5",
      });
    ingredientId = ingredientRes.body.id as string;

    const outletsRes = await request(app)
      .get("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`);
    outletAId = outletsRes.body[0].id as string;

    const outletBRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "ISO2", name: "Isolation Outlet" });
    outletBId = outletBRes.body.id as string;
  });

  it("receives stock into a specific outlet MAIN without changing another outlet", async () => {
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        outlet_id: outletAId,
        items: [{ ingredient_id: ingredientId, quantity: 10 }],
      });

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        outlet_id: outletBId,
        items: [{ ingredient_id: ingredientId, quantity: 30 }],
      });

    const outletAStock = await request(app)
      .get(`/api/v1/inventory?warehouse=MAIN&outlet_id=${outletAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outletBStock = await request(app)
      .get(`/api/v1/inventory?warehouse=MAIN&outlet_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const outletARow = outletAStock.body.find((row: { ingredientId: string }) => row.ingredientId === ingredientId);
    const outletBRow = outletBStock.body.find((row: { ingredientId: string }) => row.ingredientId === ingredientId);

    expect(Number(outletARow.quantity)).toBe(10);
    expect(Number(outletBRow.quantity)).toBe(30);
  });

  it("creates and confirms an ITO inside one outlet without touching the other outlet", async () => {
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        outlet_id: outletBId,
        from: "MAIN",
        to: "KITCHEN",
        items: [{ ingredient_id: ingredientId, quantity: 12 }],
      });
    expect(itoRes.status).toBe(201);
    outletBItoId = itoRes.body.id as string;

    const confirmRes = await request(app)
      .post(`/api/v1/itos/${outletBItoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(confirmRes.status).toBe(200);

    const outletAMain = await request(app)
      .get(`/api/v1/inventory?warehouse=MAIN&outlet_id=${outletAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outletBMain = await request(app)
      .get(`/api/v1/inventory?warehouse=MAIN&outlet_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outletBKitchen = await request(app)
      .get(`/api/v1/inventory?warehouse=KITCHEN&outlet_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const outletAMainRow = outletAMain.body.find((row: { ingredientId: string }) => row.ingredientId === ingredientId);
    const outletBMainRow = outletBMain.body.find((row: { ingredientId: string }) => row.ingredientId === ingredientId);
    const outletBKitchenRow = outletBKitchen.body.find((row: { ingredientId: string }) => row.ingredientId === ingredientId);

    expect(Number(outletAMainRow.quantity)).toBe(10);
    expect(Number(outletBMainRow.quantity)).toBe(18);
    expect(Number(outletBKitchenRow.quantity)).toBe(12);
  });

  it("filters ITO list by outlet_id", async () => {
    const outletAItos = await request(app)
      .get(`/api/v1/itos?outlet_id=${outletAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const outletBItos = await request(app)
      .get(`/api/v1/itos?outlet_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(outletAItos.body.some((ito: { id: string }) => ito.id === outletBItoId)).toBe(false);
    expect(outletBItos.body.some((ito: { id: string }) => ito.id === outletBItoId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /warehouses — verify two-tier warehouse setup
// ---------------------------------------------------------------------------

describe("GET /api/v1/warehouses", () => {
  it("returns the two seeded warehouses (MAIN and KITCHEN)", async () => {
    const res = await request(app)
      .get("/api/v1/warehouses")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    const types = res.body.map((w: { type: string }) => w.type);
    expect(types).toContain("MAIN");
    expect(types).toContain("KITCHEN");
  });

  it("returns 401 AUTH_REQUIRED when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/warehouses");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// POST /ingredients + GET /ingredients
// ---------------------------------------------------------------------------

describe("POST /api/v1/ingredients + GET /api/v1/ingredients", () => {
  it("SUPER_ADMIN creates ingredient → 201 with all fields", async () => {
    const res = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Test Salt", unit: "g", unit_cost: "0.01", low_stock_threshold: "100" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("Test Salt");
    expect(res.body.unit).toBe("g");
    expect(Number(res.body.unitCost)).toBe(0.01);
    expect(Number(res.body.lowStockThreshold)).toBe(100);
  });

  it("accepts unit_cost and low_stock_threshold as numbers", async () => {
    const res = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Test Sugar", unit: "kg", unit_cost: 5, low_stock_threshold: 50 });

    expect(res.status).toBe(201);
    expect(Number(res.body.unitCost)).toBe(5);
    expect(Number(res.body.lowStockThreshold)).toBe(50);
  });

  it("KITCHEN_STAFF creating ingredient → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ name: "Unauthorized Salt", unit: "g", unit_cost: "0.01", low_stock_threshold: "100" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("WAREHOUSE creating ingredient → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ name: "Warehouse Salt", unit: "g", unit_cost: "0.01", low_stock_threshold: "100" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 VALIDATION_ERROR when name is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ unit: "g", unit_cost: "0.01", low_stock_threshold: "100" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /ingredients lists all created ingredients", async () => {
    const res = await request(app)
      .get("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((i: { name: string }) => i.name);
    expect(names).toContain("Test Salt");
    expect(names).toContain("Test Sugar");
  });

  it("GET /ingredients returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/v1/ingredients");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CORE: ITO atomicity — MAIN -= qty, KITCHEN += qty in ONE transaction
// Cardinal Business Rule #4
// ---------------------------------------------------------------------------

describe("ITO atomicity: MAIN -= qty, KITCHEN += qty (Cardinal Rule #4)", () => {
  let porkId: string;
  let itoId: string;

  beforeAll(async () => {
    // Create the Pork ingredient (threshold = 5 kg)
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Pork", unit: "kg", unit_cost: "150.00", low_stock_threshold: "5" });
    porkId = ingRes.body.id as string;
  });

  it("POST /inventory/receive — WAREHOUSE adds 10 kg Pork to MAIN → 201", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: porkId, quantity: 10 }] });

    expect(res.status).toBe(201);
  });

  it("GET /inventory?warehouse=MAIN shows Pork quantity=10", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const porkRow = res.body.find((r: { ingredientId: string }) => r.ingredientId === porkId);
    expect(porkRow).toBeTruthy();
    expect(Number(porkRow.quantity)).toBe(10);
  });

  it("POST /itos — KITCHEN_STAFF requests ITO MAIN→KITCHEN for 8 kg Pork → 201 REQUESTED", async () => {
    const res = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        from: "MAIN",
        to: "KITCHEN",
        items: [{ ingredient_id: porkId, quantity: 8 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe("REQUESTED");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(Number(res.body.items[0].quantity)).toBe(8);

    itoId = res.body.id as string;
  });

  it("GET /itos?status=REQUESTED lists the newly created ITO", async () => {
    const res = await request(app)
      .get("/api/v1/itos?status=REQUESTED")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((i: { id: string }) => i.id === itoId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("REQUESTED");
  });

  it("POST /itos/:id/confirm (WAREHOUSE) — ATOMIC: MAIN==2 AND KITCHEN==8 → 200 CONFIRMED", async () => {
    const confirmRes = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("CONFIRMED");
    expect(confirmRes.body.confirmedAt).toBeTruthy();
    expect(confirmRes.body.confirmedBy).toBeTruthy();

    // MAIN must be exactly 2 (not 10, not 8)
    const mainRes = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(mainRes.status).toBe(200);
    const mainPork = mainRes.body.find((r: { ingredientId: string }) => r.ingredientId === porkId);
    expect(mainPork).toBeTruthy();
    expect(Number(mainPork.quantity)).toBe(2); // 10 - 8 = 2

    // KITCHEN must be exactly 8 (upserted from 0)
    const kitRes = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(kitRes.status).toBe(200);
    const kitPork = kitRes.body.find((r: { ingredientId: string }) => r.ingredientId === porkId);
    expect(kitPork).toBeTruthy();
    expect(Number(kitPork.quantity)).toBe(8); // 0 + 8 = 8
  });

  it("GET /itos?status=CONFIRMED lists the ITO after confirm", async () => {
    const res = await request(app)
      .get("/api/v1/itos?status=CONFIRMED")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const found = res.body.find((i: { id: string }) => i.id === itoId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("CONFIRMED");
  });

  it("re-confirming an already-CONFIRMED ITO → 400 VALIDATION_ERROR (not double-counted)", async () => {
    const res = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    // Balances must not change
    const mainRes = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);
    const mainPork = mainRes.body.find((r: { ingredientId: string }) => r.ingredientId === porkId);
    expect(Number(mainPork.quantity)).toBe(2); // still 2
  });
});

// ---------------------------------------------------------------------------
// Atomicity negative: confirming non-existent ITO → 404, stock unchanged
// ---------------------------------------------------------------------------

describe("Atomicity negative: non-existent ITO confirm → 404, no stock mutation", () => {
  let pepperIngredientId: string;

  beforeAll(async () => {
    // Setup: create Pepper ingredient, receive 5 into MAIN
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Pepper", unit: "kg", unit_cost: "200.00", low_stock_threshold: "2" });
    pepperIngredientId = ingRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: pepperIngredientId, quantity: 5 }] });
  });

  it("confirming a non-existent ITO UUID → 404 NOT_FOUND", async () => {
    const res = await request(app)
      .post("/api/v1/itos/00000000-0000-4000-a000-000000000001/confirm")
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("MAIN Pepper stock remains at 5 after the failed confirm (atomicity preserved)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const pepperRow = res.body.find((r: { ingredientId: string }) => r.ingredientId === pepperIngredientId);
    expect(pepperRow).toBeTruthy();
    expect(Number(pepperRow.quantity)).toBe(5); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Low-stock flagging (Cardinal Business Rule #8)
// GET /inventory?warehouse=KITCHEN flags below_threshold=true when qty <= threshold
// ---------------------------------------------------------------------------

describe("Low-stock flagging: below_threshold in GET /inventory (Cardinal Rule #8)", () => {
  let aboveIngId: string; // quantity > threshold → below_threshold=false
  let belowIngId: string; // quantity <= threshold → below_threshold=true

  beforeAll(async () => {
    // ── Above-threshold ingredient ──────────────────────────────────────────
    // "LS_Above": threshold=5, send 8 to KITCHEN → 8 > 5 → below_threshold=false
    const aboveRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LS_Above", unit: "kg", unit_cost: "10.00", low_stock_threshold: "5" });
    aboveIngId = aboveRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: aboveIngId, quantity: 8 }] });

    const itoAboveRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: aboveIngId, quantity: 8 }] });

    await request(app)
      .post(`/api/v1/itos/${itoAboveRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    // ── Below-threshold ingredient ──────────────────────────────────────────
    // "LS_Below": threshold=10, send 3 to KITCHEN → 3 <= 10 → below_threshold=true
    const belowRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LS_Below", unit: "kg", unit_cost: "20.00", low_stock_threshold: "10" });
    belowIngId = belowRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: belowIngId, quantity: 3 }] });

    const itoBelowRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: belowIngId, quantity: 3 }] });

    await request(app)
      .post(`/api/v1/itos/${itoBelowRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);
  });

  it("LS_Above in KITCHEN (qty=8, threshold=5) → below_threshold=false", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = res.body.find((r: { ingredientId: string }) => r.ingredientId === aboveIngId);
    expect(row).toBeTruthy();
    expect(Number(row.quantity)).toBe(8);
    expect(row.below_threshold).toBe(false);
  });

  it("LS_Below in KITCHEN (qty=3, threshold=10) → below_threshold=true (Rule #8)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = res.body.find((r: { ingredientId: string }) => r.ingredientId === belowIngId);
    expect(row).toBeTruthy();
    expect(Number(row.quantity)).toBe(3);
    expect(row.below_threshold).toBe(true);
  });

  it("ingredient exactly AT threshold (qty==threshold) → below_threshold=true (boundary condition)", async () => {
    // Create ingredient with threshold=5, send exactly 5 to KITCHEN
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "LS_AtThreshold", unit: "kg", unit_cost: "5.00", low_stock_threshold: "5" });
    const atId = ingRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: atId, quantity: 5 }] });

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: atId, quantity: 5 }] });

    await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);

    const row = res.body.find((r: { ingredientId: string }) => r.ingredientId === atId);
    expect(row).toBeTruthy();
    expect(Number(row.quantity)).toBe(5);
    expect(row.below_threshold).toBe(true); // 5 <= 5 → true
  });

  it("GET /inventory without warehouse param → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/inventory")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /inventory?warehouse=FREEZER (invalid type) → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=FREEZER")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("RBAC enforcement", () => {
  let rbacIngId: string;
  let rbacItoId: string;

  beforeAll(async () => {
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "RBAC Oil", unit: "L", unit_cost: "80.00", low_stock_threshold: "1" });
    rbacIngId = ingRes.body.id as string;

    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: rbacIngId, quantity: 5 }] });

    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        from: "MAIN",
        to: "KITCHEN",
        items: [{ ingredient_id: rbacIngId, quantity: 2 }],
      });
    rbacItoId = itoRes.body.id as string;
  });

  it("KITCHEN_STAFF confirming an ITO → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/itos/${rbacItoId}/confirm`)
      .set("Authorization", `Bearer ${kitchenToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("KITCHEN_STAFF receiving inventory → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ items: [{ ingredient_id: rbacIngId, quantity: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("WAREHOUSE can confirm an ITO → 200 CONFIRMED", async () => {
    const res = await request(app)
      .post(`/api/v1/itos/${rbacItoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CONFIRMED");
  });

  it("unauthenticated GET /itos → 401 AUTH_REQUIRED", async () => {
    const res = await request(app).get("/api/v1/itos");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("unauthenticated POST /itos → 401 AUTH_REQUIRED", async () => {
    const res = await request(app)
      .post("/api/v1/itos")
      .send({ from: "MAIN", to: "KITCHEN", items: [] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /inventory/consumption
// ---------------------------------------------------------------------------

describe("POST /api/v1/inventory/consumption", () => {
  let consumptionIngId: string;

  beforeAll(async () => {
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Garlic", unit: "g", unit_cost: "1.00", low_stock_threshold: "50" });
    consumptionIngId = ingRes.body.id as string;
  });

  it("KITCHEN_STAFF logs consumption → 201 with log rows", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/consumption")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        log_date: "2026-06-24T00:00:00Z",
        items: [{ ingredient_id: consumptionIngId, quantity: 20 }],
      });

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].ingredientId).toBe(consumptionIngId);
    expect(Number(res.body[0].quantity)).toBe(20);
  });

  it("SUPER_ADMIN logs consumption → 201", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/consumption")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ ingredient_id: consumptionIngId, quantity: 10 }],
      });

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it("WAREHOUSE logging consumption → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/consumption")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: consumptionIngId, quantity: 10 }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 VALIDATION_ERROR when items is empty array", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/consumption")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when items key is missing", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/consumption")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ log_date: "2026-06-24T00:00:00Z" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// POST /inventory/receive — upsert (receiving twice accumulates quantity)
// ---------------------------------------------------------------------------

describe("POST /api/v1/inventory/receive — upsert accumulates stock in MAIN", () => {
  let receiveIngId: string;

  beforeAll(async () => {
    const ingRes = await request(app)
      .post("/api/v1/ingredients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Onion", unit: "kg", unit_cost: "30.00", low_stock_threshold: "3" });
    receiveIngId = ingRes.body.id as string;
  });

  it("first receive of 5 kg → MAIN shows 5", async () => {
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: receiveIngId, quantity: 5 }] });

    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);

    const row = res.body.find((r: { ingredientId: string }) => r.ingredientId === receiveIngId);
    expect(Number(row.quantity)).toBe(5);
  });

  it("second receive of 3 kg → MAIN accumulates to 8 (upsert)", async () => {
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: receiveIngId, quantity: 3 }] });

    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);

    const row = res.body.find((r: { ingredientId: string }) => r.ingredientId === receiveIngId);
    expect(Number(row.quantity)).toBe(8); // 5 + 3 = 8
  });

  it("returns 400 VALIDATION_ERROR for invalid ingredient_id format", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: "not-a-uuid", quantity: 5 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when items is empty", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
