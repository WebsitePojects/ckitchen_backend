/**
 * Task 4 — Menu Items & Recipes
 *
 * Tests §5 of CK1-API-003 and prove Business Rule #3 (Cardinal Rule):
 * ONE shared ingredient_id, brand-specific portion_qty on each RecipeLine.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { ingredients } from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string;
let staffToken: string;

const ADMIN_EMAIL = "admin@cloudkitchen.local";
const ADMIN_PASSWORD = "admin123";
const STAFF_EMAIL = "kitchen_staff@cloudkitchen.local";
const STAFF_PASSWORD = "password123";

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await seed(db); // runs migrations + seeds 1 location, 5 stations, role users

  app = createApp(db);

  adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  staffToken = await login(STAFF_EMAIL, STAFF_PASSWORD);
});

// ---------------------------------------------------------------------------
// POST /brands/:id/menu
// ---------------------------------------------------------------------------

describe("POST /api/v1/brands/:id/menu", () => {
  let brandId: string;
  let stationId: string;

  beforeAll(async () => {
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Menu Create Brand", color: "#FF0000" });
    brandId = brandRes.body.id as string;

    const stationsRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const grill = stationsRes.body.find((s: { name: string }) => s.name === "Grill");
    stationId = grill.id as string;
  });

  it("creates a menu item as SUPER_ADMIN -> 201, defaults availability to AVAILABLE", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Teriyaki Chicken", price: "150.00", prep_time_min: 10, station_id: stationId });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("Teriyaki Chicken");
    expect(res.body.availability).toBe("AVAILABLE");
    expect(res.body.brandId).toBe(brandId);
    expect(res.body.stationId).toBe(stationId);
  });

  it("accepts price as a number and stores it", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Gyoza", price: 85, prep_time_min: 8, station_id: stationId });

    expect(res.status).toBe(201);
    expect(Number(res.body.price)).toBe(85);
  });

  it("rejects KITCHEN_STAFF creating a menu item with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Staff Item", price: "100.00", prep_time_min: 5, station_id: stationId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects unauthenticated request with 401", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .send({ name: "No Auth", price: "100.00", station_id: stationId });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 404 NOT_FOUND for an unknown brand id", async () => {
    const res = await request(app)
      .post("/api/v1/brands/00000000-0000-0000-0000-000000000000/menu")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Ghost Item", price: "100.00", station_id: stationId });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION_ERROR when name is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ price: "100.00", station_id: stationId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when price is missing", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "No Price Item", station_id: stationId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// GET /brands/:id/menu
// ---------------------------------------------------------------------------

describe("GET /api/v1/brands/:id/menu", () => {
  let brandId: string;
  let stationId: string;

  beforeAll(async () => {
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Menu List Brand", color: "#AAAAAA" });
    brandId = brandRes.body.id as string;

    const stationsRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const grill = stationsRes.body.find((s: { name: string }) => s.name === "Grill");
    stationId = grill.id as string;

    await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Listed Item A", price: "200.00", prep_time_min: 15, station_id: stationId });

    await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Listed Item B", price: "250.00", prep_time_min: 20, station_id: stationId });
  });

  it("lists all menu items for a brand", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    const names = res.body.map((m: { name: string }) => m.name);
    expect(names).toContain("Listed Item A");
    expect(names).toContain("Listed Item B");
  });

  it("returns 404 NOT_FOUND for unknown brand id", async () => {
    const res = await request(app)
      .get("/api/v1/brands/00000000-0000-0000-0000-000000000000/menu")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get(`/api/v1/brands/${brandId}/menu`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /menu/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/menu/:id", () => {
  let menuItemId: string;
  let brandId: string;
  let stationId: string;

  beforeAll(async () => {
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Patch Menu Brand", color: "#BBBBBB" });
    brandId = brandRes.body.id as string;

    const stationsRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const grill = stationsRes.body.find((s: { name: string }) => s.name === "Grill");
    stationId = grill.id as string;

    const menuRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Patch Me", price: "99.00", prep_time_min: 8, station_id: stationId });
    menuItemId = menuRes.body.id as string;
  });

  it("updates name and price as SUPER_ADMIN -> 200", async () => {
    const res = await request(app)
      .patch(`/api/v1/menu/${menuItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Patched Name", price: "120.00" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Patched Name");
    expect(Number(res.body.price)).toBe(120);
  });

  it("toggles availability through AVAILABLE / PAUSED / SOLD_OUT and persists", async () => {
    for (const status of ["AVAILABLE", "PAUSED", "SOLD_OUT"] as const) {
      const patchRes = await request(app)
        .patch(`/api/v1/menu/${menuItemId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ availability: status });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.availability).toBe(status);

      // Confirm it persisted by re-fetching the menu list
      const listRes = await request(app)
        .get(`/api/v1/brands/${brandId}/menu`)
        .set("Authorization", `Bearer ${adminToken}`);
      const item = listRes.body.find((m: { id: string }) => m.id === menuItemId);
      expect(item).toBeTruthy();
      expect(item.availability).toBe(status);
    }
  });

  it("updates availability to SOLD_OUT and it persists independently", async () => {
    // Reset to AVAILABLE first
    await request(app)
      .patch(`/api/v1/menu/${menuItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ availability: "AVAILABLE" });

    // Set SOLD_OUT
    const patchRes = await request(app)
      .patch(`/api/v1/menu/${menuItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ availability: "SOLD_OUT" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.availability).toBe("SOLD_OUT");

    // Verify persists
    const listRes = await request(app)
      .get(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`);
    const item = listRes.body.find((m: { id: string }) => m.id === menuItemId);
    expect(item.availability).toBe("SOLD_OUT");
  });

  it("rejects KITCHEN_STAFF with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .patch(`/api/v1/menu/${menuItemId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ availability: "PAUSED" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 NOT_FOUND for unknown menu item id", async () => {
    const res = await request(app)
      .patch("/api/v1/menu/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION_ERROR when body is empty", async () => {
    const res = await request(app)
      .patch(`/api/v1/menu/${menuItemId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// PUT /menu/:id/recipe + GET /menu/:id/recipe — CARDINAL RULE (Business Rule #3)
// ---------------------------------------------------------------------------

describe("PUT /api/v1/menu/:id/recipe + GET — Cardinal Rule: shared ingredient, per-recipe portion", () => {
  let tokyoBrandId: string;
  let seoulBrandId: string;
  let stationId: string;
  let teriyakiItemId: string;
  let koreanItemId: string;
  let chickenIngredientId: string;

  beforeAll(async () => {
    // Two distinct brands sharing ONE kitchen (one-location model)
    const tokyoRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tokyo House", color: "#FF6600" });
    tokyoBrandId = tokyoRes.body.id as string;

    const seoulRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Seoul Bowl", color: "#0066FF" });
    seoulBrandId = seoulRes.body.id as string;

    // Get the seeded Grill station
    const stationsRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const grill = stationsRes.body.find((s: { name: string }) => s.name === "Grill");
    stationId = grill.id as string;

    // Insert the shared Chicken ingredient directly via Drizzle (Task 5 will add CRUD endpoints)
    const [chicken] = await db
      .insert(ingredients)
      .values({
        name: "Chicken",
        unit: "g",
        unitCost: "0.05",
        lowStockThreshold: "500",
      })
      .returning();
    chickenIngredientId = chicken.id;

    // Create Tokyo House menu item
    const teriyakiRes = await request(app)
      .post(`/api/v1/brands/${tokyoBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Teriyaki Chicken", price: "180.00", prep_time_min: 12, station_id: stationId });
    teriyakiItemId = teriyakiRes.body.id as string;

    // Create Seoul Bowl menu item
    const koreanRes = await request(app)
      .post(`/api/v1/brands/${seoulBrandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Korean Fried Chicken", price: "190.00", prep_time_min: 15, station_id: stationId });
    koreanItemId = koreanRes.body.id as string;
  });

  it("PUT recipe for Tokyo House Teriyaki Chicken → Chicken 200 g -> 200", async () => {
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenIngredientId, portion_qty: 200, unit: "g" }] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].ingredientId).toBe(chickenIngredientId);
    expect(Number(res.body[0].portionQty)).toBe(200);
    expect(res.body[0].unit).toBe("g");
    expect(res.body[0].menuItemId).toBe(teriyakiItemId);
  });

  it("PUT recipe for Seoul Bowl Korean Fried Chicken → Chicken 150 g -> 200", async () => {
    const res = await request(app)
      .put(`/api/v1/menu/${koreanItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenIngredientId, portion_qty: 150, unit: "g" }] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].ingredientId).toBe(chickenIngredientId);
    expect(Number(res.body[0].portionQty)).toBe(150);
    expect(res.body[0].unit).toBe("g");
    expect(res.body[0].menuItemId).toBe(koreanItemId);
  });

  /**
   * CARDINAL RULE (Business Rule #3):
   * Both recipe lines reference THE SAME ingredient_id (one shared stock pool),
   * but each carries its OWN brand-specific portion_qty (200 g vs 150 g).
   */
  it("CARDINAL RULE — same ingredient_id, brand-specific portions (200g vs 150g)", async () => {
    const teriyakiRecipeRes = await request(app)
      .get(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`);
    const koreanRecipeRes = await request(app)
      .get(`/api/v1/menu/${koreanItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(teriyakiRecipeRes.status).toBe(200);
    expect(koreanRecipeRes.status).toBe(200);

    const teriyakiLines: Array<{ ingredientId: string; portionQty: string }> =
      teriyakiRecipeRes.body;
    const koreanLines: Array<{ ingredientId: string; portionQty: string }> =
      koreanRecipeRes.body;

    expect(teriyakiLines).toHaveLength(1);
    expect(koreanLines).toHaveLength(1);

    // ONE shared ingredient_id across both brands
    expect(teriyakiLines[0].ingredientId).toBe(chickenIngredientId);
    expect(koreanLines[0].ingredientId).toBe(chickenIngredientId);
    expect(teriyakiLines[0].ingredientId).toBe(koreanLines[0].ingredientId); // same id

    // But DIFFERENT per-brand portion_qty
    expect(Number(teriyakiLines[0].portionQty)).toBe(200);
    expect(Number(koreanLines[0].portionQty)).toBe(150);
    expect(Number(teriyakiLines[0].portionQty)).not.toBe(Number(koreanLines[0].portionQty));
  });

  it("PUT recipe REPLACES existing lines — PUT twice, only latest lines remain", async () => {
    // Insert a second ingredient for the replacement
    const [soy] = await db
      .insert(ingredients)
      .values({ name: "Soy Sauce", unit: "ml", unitCost: "0.02", lowStockThreshold: "100" })
      .returning();

    // First PUT: Chicken 200g
    await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenIngredientId, portion_qty: 200, unit: "g" }] });

    // Second PUT: Soy Sauce 30ml — should REPLACE, not append
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: soy.id, portion_qty: 30, unit: "ml" }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // Only Soy Sauce; old Chicken line is gone
    expect(res.body[0].ingredientId).toBe(soy.id);
    expect(Number(res.body[0].portionQty)).toBe(30);
    expect(res.body[0].unit).toBe("ml");

    // Verify via GET that only 1 line exists
    const getRes = await request(app)
      .get(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getRes.body).toHaveLength(1);
    expect(getRes.body[0].ingredientId).toBe(soy.id);
  });

  it("PUT recipe with empty lines clears all recipe lines", async () => {
    // First set some lines
    await request(app)
      .put(`/api/v1/menu/${koreanItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenIngredientId, portion_qty: 150, unit: "g" }] });

    // Then PUT with empty lines
    const res = await request(app)
      .put(`/api/v1/menu/${koreanItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);

    // Verify via GET
    const getRes = await request(app)
      .get(`/api/v1/menu/${koreanItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(getRes.body).toHaveLength(0);
  });

  it("GET /menu/:id/recipe returns empty array when no recipe lines exist", async () => {
    const freshBrandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Empty Recipe Brand", color: "#CCCCCC" });

    const freshItemRes = await request(app)
      .post(`/api/v1/brands/${freshBrandRes.body.id}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "No Recipe Item", price: "50.00", prep_time_min: 5, station_id: stationId });

    const res = await request(app)
      .get(`/api/v1/menu/${freshItemRes.body.id}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("PUT recipe returns 400 VALIDATION_ERROR for non-UUID ingredient_id", async () => {
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: "not-a-uuid", portion_qty: 100, unit: "g" }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT recipe returns 400 VALIDATION_ERROR when lines key is missing", async () => {
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ingredient_id: chickenIngredientId }); // wrong shape

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("PUT recipe returns 404 NOT_FOUND for unknown menu item", async () => {
    const res = await request(app)
      .put("/api/v1/menu/00000000-0000-0000-0000-000000000000/recipe")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lines: [{ ingredient_id: chickenIngredientId, portion_qty: 100, unit: "g" }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PUT recipe returns 404 NOT_FOUND for unknown ingredient_id", async () => {
    // Use a properly-formatted UUID v4 (version nibble = 4, variant nibble = a) that
    // is guaranteed not to exist in the database, so Zod v4 accepts the shape but the
    // DB lookup finds nothing → 404.
    const nonExistentIngredientId = "00000000-0000-4000-a000-000000000001";
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        lines: [
          { ingredient_id: nonExistentIngredientId, portion_qty: 100, unit: "g" },
        ],
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PUT recipe returns 403 FORBIDDEN for KITCHEN_STAFF", async () => {
    const res = await request(app)
      .put(`/api/v1/menu/${teriyakiItemId}/recipe`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ lines: [] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("GET /menu/:id/recipe returns 404 NOT_FOUND for unknown menu item", async () => {
    const res = await request(app)
      .get("/api/v1/menu/00000000-0000-0000-0000-000000000000/recipe")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
