/**
 * End-to-End Integration Test — SRS §5.2 Acceptance Scenario
 *
 * Walks ALL 7 steps of the acceptance scenario using an in-memory PGlite database,
 * the base seed, the pilot seed, and the real Express app via supertest.
 * No hardware, no network — fully deterministic.
 *
 * Step assertions (each maps to an SRS §5.2 sub-step):
 *   (a) Ingest FoodPanda + GrabFood orders for all 5 brands → unified feed labels brand+aggregator,
 *       each order creates PENDING print jobs per station.
 *   (b) Drain print jobs as the mock agent does (GET pending → ack PRINTED) → jobs become PRINTED.
 *   (c) Advance Tokyo House order (Teriyaki 200g + Tonkatsu 150g) and Seoul Bowl order (KFC 220g)
 *       to PREPARING → assert shared Chicken KITCHEN pool dropped by exactly 570g.
 *   (d) Advance Manila Lechon order (Lechon Rice 180g) to PREPARING → assert KITCHEN Pork
 *       is at/below the 5 kg (5000g) threshold and GET /inventory flags it below_threshold.
 *   (e) POST /itos (MAIN → KITCHEN, Pork 2000g) → POST /itos/:id/confirm → assert KITCHEN Pork
 *       is above threshold and MAIN Pork decremented by exactly 2000g.
 *   (f) GET /analytics/brands → ranked top→weak, last entry has is_weakest=true;
 *       GET /analytics/orders-by-hour → at least one hour has order_count > 0.
 *   (g) ACK one job FAILED → POST /print-jobs/:id/reprint → new PENDING job exists.
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seedPilot } from "../src/db/seed-pilot.js";

// ---------------------------------------------------------------------------
// Shared state (set up once in the file-level beforeAll)
// ---------------------------------------------------------------------------

let app: Express;
let db: DB;
let adminToken: string;
let kitchenToken: string;
let warehouseToken: string;

// Ids resolved from the pilot seed
let brandIds: Record<string, string>;
let menuItemIds: Record<string, string>;
let accountIds: Record<string, { fp: string; gb: string }>;
let ingredientIds: Record<string, string>;
let warehouseIds: { main: string; kitchen: string };

// Unique ref counter (avoids (aggregator, external_ref) collisions)
let _refSeq = 0;
function nextRef(prefix = "E2E"): string {
  return `${prefix}-${Date.now()}-${++_refSeq}`;
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  // In-memory PGlite — fresh DB for every run
  const created = createDb();
  db = created.db;

  // Run base seed + pilot seed
  const pilotIds = await seedPilot(db);
  brandIds = pilotIds.brands;
  menuItemIds = pilotIds.menuItems;
  accountIds = pilotIds.accounts;
  ingredientIds = pilotIds.ingredients;
  warehouseIds = pilotIds.warehouses;

  app = createApp(db);

  adminToken   = await login("admin@cloudkitchen.local",     "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");
}, 60_000); // generous timeout for in-memory Postgres migrations

// ---------------------------------------------------------------------------
// Step (a): Ingest orders across all 5 brands from both aggregators
//           → unified feed labels brand + aggregator
//           → each order creates PENDING print jobs per station
// ---------------------------------------------------------------------------

describe("Step (a): Ingest orders across 5 brands from FoodPanda + GrabFood", () => {
  // Orders ingested in this step (ids stored for downstream steps)
  let tokyoOrderId: string;
  let seoulOrderId: string;
  let manilaOrderId: string;
  let greenOrderId: string;
  let sipOrderId: string;

  // Each order gets a unique external_ref
  const refs: Record<string, string> = {};

  beforeAll(async () => {
    // Tokyo House — FOODPANDA — Teriyaki + Tonkatsu (2 stations: Grill + Fry)
    refs.tokyo = nextRef("FP-TK");
    const tokyoRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:      brandIds["Tokyo House"],
        aggregator:    "FOODPANDA",
        external_ref:  refs.tokyo,
        customer_name: "Alice",
        placed_at:     "2026-06-24T10:00:00Z",
        items: [
          { menu_item_id: menuItemIds["Tokyo House/Teriyaki Chicken"],  qty: 1 },
          { menu_item_id: menuItemIds["Tokyo House/Chicken Tonkatsu"],  qty: 1 },
        ],
      });
    expect(tokyoRes.status, "Tokyo House ingest").toBe(201);
    tokyoOrderId = tokyoRes.body.order_id as string;

    // Seoul Bowl — GRABFOOD — Korean Fried Chicken (station: Fry)
    refs.seoul = nextRef("GF-SB");
    const seoulRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:      brandIds["Seoul Bowl"],
        aggregator:    "GRABFOOD",
        external_ref:  refs.seoul,
        customer_name: "Bob",
        placed_at:     "2026-06-24T10:05:00Z",
        items: [{ menu_item_id: menuItemIds["Seoul Bowl/Korean Fried Chicken"], qty: 1 }],
      });
    expect(seoulRes.status, "Seoul Bowl ingest").toBe(201);
    seoulOrderId = seoulRes.body.order_id as string;

    // Manila Lechon — FOODPANDA — Lechon Rice (station: Grill)
    refs.manila = nextRef("FP-ML");
    const manilaRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:      brandIds["Manila Lechon"],
        aggregator:    "FOODPANDA",
        external_ref:  refs.manila,
        customer_name: "Carol",
        placed_at:     "2026-06-24T10:10:00Z",
        items: [{ menu_item_id: menuItemIds["Manila Lechon/Lechon Rice"], qty: 1 }],
      });
    expect(manilaRes.status, "Manila Lechon ingest").toBe(201);
    manilaOrderId = manilaRes.body.order_id as string;

    // Green Garden — GRABFOOD — Veggie Wrap + Garden Salad (both Prep → 1 print job)
    refs.green = nextRef("GF-GG");
    const greenRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:      brandIds["Green Garden"],
        aggregator:    "GRABFOOD",
        external_ref:  refs.green,
        customer_name: "Dave",
        placed_at:     "2026-06-24T10:15:00Z",
        items: [
          { menu_item_id: menuItemIds["Green Garden/Veggie Wrap"],   qty: 1 },
          { menu_item_id: menuItemIds["Green Garden/Garden Salad"],  qty: 1 },
        ],
      });
    expect(greenRes.status, "Green Garden ingest").toBe(201);
    greenOrderId = greenRes.body.order_id as string;

    // Sip & Co — FOODPANDA — Iced Tea (station: Beverage)
    refs.sip = nextRef("FP-SC");
    const sipRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:      brandIds["Sip & Co"],
        aggregator:    "FOODPANDA",
        external_ref:  refs.sip,
        customer_name: "Eve",
        placed_at:     "2026-06-24T10:20:00Z",
        items: [{ menu_item_id: menuItemIds["Sip & Co/Iced Tea"], qty: 1 }],
      });
    expect(sipRes.status, "Sip & Co ingest").toBe(201);
    sipOrderId = sipRes.body.order_id as string;

    // Store the ids on the outer scope so later describes can use them
    (globalThis as Record<string, unknown>)["__e2e_tokyoOrderId__"]  = tokyoOrderId;
    (globalThis as Record<string, unknown>)["__e2e_seoulOrderId__"]  = seoulOrderId;
    (globalThis as Record<string, unknown>)["__e2e_manilaOrderId__"] = manilaOrderId;
  });

  it("GET /orders includes all 5 ingested orders with correct brand + aggregator labels", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const allOrders = res.body as Array<{
      id: string;
      brandId: string;
      aggregator: string;
      externalRef: string;
      status: string;
    }>;

    // All 5 are present
    const ids = new Set(allOrders.map((o) => o.id));
    expect(ids.has(tokyoOrderId),  "Tokyo House order in feed").toBe(true);
    expect(ids.has(seoulOrderId),  "Seoul Bowl order in feed").toBe(true);
    expect(ids.has(manilaOrderId), "Manila Lechon order in feed").toBe(true);
    expect(ids.has(greenOrderId),  "Green Garden order in feed").toBe(true);
    expect(ids.has(sipOrderId),    "Sip & Co order in feed").toBe(true);

    // Brand labels
    const tokyo = allOrders.find((o) => o.id === tokyoOrderId)!;
    expect(tokyo.brandId).toBe(brandIds["Tokyo House"]);
    expect(tokyo.aggregator).toBe("FOODPANDA");

    const seoul = allOrders.find((o) => o.id === seoulOrderId)!;
    expect(seoul.brandId).toBe(brandIds["Seoul Bowl"]);
    expect(seoul.aggregator).toBe("GRABFOOD");
  });

  it("All 5 orders start with status=NEW", async () => {
    for (const [label, orderId] of [
      ["Tokyo House",   tokyoOrderId],
      ["Seoul Bowl",    seoulOrderId],
      ["Manila Lechon", manilaOrderId],
      ["Green Garden",  greenOrderId],
      ["Sip & Co",      sipOrderId],
    ] as const) {
      const res = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status, `GET order ${label}`).toBe(200);
      expect(res.body.status, `${label} status=NEW`).toBe("NEW");
    }
  });

  it("Tokyo House order has 2 PENDING print jobs (Grill + Fry, different stations)", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${tokyoOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const jobs = res.body.print_jobs as Array<{ status: string; stationId: string }>;
    expect(jobs.length).toBe(2); // Grill + Fry
    expect(jobs.every((j) => j.status === "PENDING")).toBe(true);
  });

  it("Manila Lechon order has 1 PENDING print job (Grill)", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${manilaOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const jobs = res.body.print_jobs as Array<{ status: string }>;
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.status).toBe("PENDING");
  });

  it("Green Garden order (2 Prep items) has exactly 1 PENDING print job (same station)", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${greenOrderId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const jobs = res.body.print_jobs as Array<{ status: string }>;
    expect(jobs.length).toBe(1); // both items are Prep → 1 KOT
    expect(jobs[0]!.status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
// Step (b): Drain print jobs — GET pending with agent token → ack PRINTED
//           → assert all jobs become PRINTED
// ---------------------------------------------------------------------------

describe("Step (b): Mock agent drains all pending print jobs → PRINTED", () => {
  const AGENT_TOKEN = "test-agent-token"; // matches config.ts test default

  it("GET /agent/print-jobs/pending returns at least 5 PENDING jobs", async () => {
    const res = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", AGENT_TOKEN);

    expect(res.status).toBe(200);
    const jobs = res.body as Array<{ id: string; payload: unknown }>;
    expect(jobs.length).toBeGreaterThanOrEqual(5); // 5 orders → ≥5 station groups
  });

  it("Agent acks all pending jobs as PRINTED → no more PENDING jobs", async () => {
    // Drain loop (mirrors agent-mock/index.ts logic)
    let rounds = 0;
    while (rounds < 10) {
      const res = await request(app)
        .get("/api/v1/agent/print-jobs/pending")
        .set("X-Agent-Token", AGENT_TOKEN);

      const jobs = res.body as Array<{ id: string }>;
      if (jobs.length === 0) break;

      for (const job of jobs) {
        const ack = await request(app)
          .post(`/api/v1/agent/print-jobs/${job.id}/ack`)
          .set("X-Agent-Token", AGENT_TOKEN)
          .send({ status: "PRINTED" });
        expect(ack.status, `ack job ${job.id.slice(0, 8)}`).toBe(200);
        expect(ack.body.status).toBe("PRINTED");
      }
      rounds++;
    }

    // Verify: no PENDING jobs remain
    const finalRes = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", AGENT_TOKEN);
    expect(finalRes.body).toHaveLength(0);
  });

  it("All print jobs for the 5 pilot orders now have status=PRINTED", async () => {
    const res = await request(app)
      .get("/api/v1/print-jobs?status=PRINTED")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const jobs = res.body as Array<{ status: string }>;
    // We ingested at least 5 orders → at least 5 station print jobs
    expect(jobs.length).toBeGreaterThanOrEqual(5);
    expect(jobs.every((j) => j.status === "PRINTED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step (c): Advance Tokyo House (Teriyaki 200g + Tonkatsu 150g) and
//           Seoul Bowl (Korean Fried Chicken 220g) to PREPARING
//           → assert SHARED Chicken KITCHEN pool drops by exactly 570g
// ---------------------------------------------------------------------------

describe("Step (c): Shared Chicken pool deduction — Tokyo House + Seoul Bowl → 570g", () => {
  it("Captures pre-deduction Chicken KITCHEN balance", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      ingredientId: string;
      quantity: string;
      ingredient: { name: string };
    }>;
    const chickenRow = rows.find((r) => r.ingredient.name === "Chicken");
    expect(chickenRow, "Chicken must be in KITCHEN inventory").toBeTruthy();

    // Store for the next assertion
    (globalThis as Record<string, unknown>)["__e2e_chickenBefore__"] = Number(chickenRow!.quantity);
  });

  it("Advancing Tokyo House order to PREPARING deducts 200+150=350g of shared Chicken", async () => {
    const tokyoOrderId = (globalThis as Record<string, unknown>)["__e2e_tokyoOrderId__"] as string;
    const res = await request(app)
      .post(`/api/v1/orders/${tokyoOrderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PREPARING");
  });

  it("Advancing Seoul Bowl order to PREPARING deducts 220g of the SAME shared Chicken pool", async () => {
    const seoulOrderId = (globalThis as Record<string, unknown>)["__e2e_seoulOrderId__"] as string;
    const res = await request(app)
      .post(`/api/v1/orders/${seoulOrderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PREPARING");
  });

  it("Chicken KITCHEN balance dropped by exactly 570g (200+150+220 — shared pool)", async () => {
    const chickenBefore = (globalThis as Record<string, unknown>)["__e2e_chickenBefore__"] as number;

    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      ingredientId: string;
      quantity: string;
      ingredient: { name: string };
    }>;
    const chickenRow = rows.find((r) => r.ingredient.name === "Chicken");
    expect(chickenRow, "Chicken still in KITCHEN inventory after deduction").toBeTruthy();

    const chickenAfter = Number(chickenRow!.quantity);
    const deducted = chickenBefore - chickenAfter;

    // Exact: Teriyaki(200) + Tonkatsu(150) + KFC(220) = 570g
    expect(deducted).toBe(570);
    expect(chickenAfter).toBe(chickenBefore - 570);
  });
});

// ---------------------------------------------------------------------------
// Step (d): Advance Manila Lechon Lechon Rice (180g Pork) to PREPARING
//           → KITCHEN Pork hits exactly 5000g = threshold
//           → GET /inventory flags Pork below_threshold=true
// ---------------------------------------------------------------------------

describe("Step (d): Manila Lechon Pork deduction → low-stock alert at 5kg threshold", () => {
  it("Captures pre-deduction Pork KITCHEN balance (expect ~5180g from pilot seed)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      ingredientId: string;
      quantity: string;
      ingredient: { name: string };
    }>;
    const porkRow = rows.find((r) => r.ingredient.name === "Pork");
    expect(porkRow, "Pork must be in KITCHEN inventory").toBeTruthy();

    const porkQty = Number(porkRow!.quantity);
    // Pilot seed sets KITCHEN Pork = 5180g
    expect(porkQty).toBe(5180);
    (globalThis as Record<string, unknown>)["__e2e_porkBefore__"] = porkQty;
  });

  it("Advancing Manila Lechon order to PREPARING deducts 180g of Pork", async () => {
    const manilaOrderId = (globalThis as Record<string, unknown>)["__e2e_manilaOrderId__"] as string;
    const res = await request(app)
      .post(`/api/v1/orders/${manilaOrderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PREPARING");
  });

  it("GET /inventory?warehouse=KITCHEN flags Pork below_threshold after reaching exactly 5000g", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      ingredientId: string;
      quantity: string;
      ingredient: { name: string; lowStockThreshold: string };
      below_threshold: boolean;
    }>;

    const porkRow = rows.find((r) => r.ingredient.name === "Pork");
    expect(porkRow, "Pork still in KITCHEN inventory after advance").toBeTruthy();

    const porkAfter = Number(porkRow!.quantity);
    // 5180 - 180 = 5000 = threshold
    expect(porkAfter).toBe(5000);

    // Cardinal Rule #8: quantity <= low_stock_threshold → below_threshold=true
    const threshold = Number(porkRow!.ingredient.lowStockThreshold);
    expect(threshold).toBe(5000);
    expect(porkAfter).toBeLessThanOrEqual(threshold);
    expect(porkRow!.below_threshold).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step (e): ITO from MAIN → KITCHEN for Pork 2000g, confirm
//           → assert KITCHEN Pork back above threshold
//           → assert MAIN Pork decremented by exactly 2000g
// ---------------------------------------------------------------------------

describe("Step (e): ITO replenishment — MAIN → KITCHEN Pork 2000g (atomic)", () => {
  let itoId: string;
  let mainPorkBefore: number;

  it("Captures MAIN Pork balance before ITO", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      quantity: string;
      ingredient: { name: string };
    }>;
    const porkRow = rows.find((r) => r.ingredient.name === "Pork");
    expect(porkRow, "Pork in MAIN warehouse").toBeTruthy();
    mainPorkBefore = Number(porkRow!.quantity);
    expect(mainPorkBefore).toBeGreaterThan(0);
  });

  it("POST /itos creates a REQUESTED ITO for Pork 2000g MAIN → KITCHEN", async () => {
    const res = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({
        from: "MAIN",
        to: "KITCHEN",
        items: [{ ingredient_id: ingredientIds["Pork"], quantity: 2000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("REQUESTED");
    itoId = res.body.id as string;
  });

  it("POST /itos/:id/confirm moves Pork atomically MAIN−=2000 KITCHEN+=2000", async () => {
    const res = await request(app)
      .post(`/api/v1/itos/${itoId}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CONFIRMED");
  });

  it("KITCHEN Pork is now 7000g — above the 5000g threshold (no longer flagged)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=KITCHEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      quantity: string;
      ingredient: { name: string };
      below_threshold: boolean;
    }>;
    const porkRow = rows.find((r) => r.ingredient.name === "Pork");
    expect(porkRow, "Pork in KITCHEN").toBeTruthy();

    const porkKitchenAfter = Number(porkRow!.quantity);
    // Was 5000g after deduction; ITO adds 2000g → 7000g
    expect(porkKitchenAfter).toBe(7000);
    expect(porkRow!.below_threshold).toBe(false);
  });

  it("MAIN Pork decremented by exactly 2000g after ITO confirm (atomic)", async () => {
    const res = await request(app)
      .get("/api/v1/inventory?warehouse=MAIN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      quantity: string;
      ingredient: { name: string };
    }>;
    const porkRow = rows.find((r) => r.ingredient.name === "Pork");
    expect(porkRow, "Pork in MAIN warehouse post-ITO").toBeTruthy();

    const mainPorkAfter = Number(porkRow!.quantity);
    expect(mainPorkAfter).toBe(mainPorkBefore - 2000);
  });
});

// ---------------------------------------------------------------------------
// Step (f): Analytics
//   GET /analytics/brands → ranked top→weak; last entry is_weakest=true
//   GET /analytics/orders-by-hour → at least one peak hour present
// ---------------------------------------------------------------------------

describe("Step (f): Analytics — per-brand ranking and peak-hour breakdown", () => {
  it("GET /analytics/brands returns all 5 brands ranked top→weak with a weakest flag", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/brands")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      brand_id: string;
      name: string;
      revenue: number;
      order_count: number;
      is_weakest: boolean;
    }>;

    // All 5 pilot brands present
    expect(rows.length).toBeGreaterThanOrEqual(5);

    // Only one brand is flagged weakest
    const weakest = rows.filter((r) => r.is_weakest);
    expect(weakest).toHaveLength(1);

    // Weakest is the last in the ranked list (lowest revenue)
    expect(rows[rows.length - 1]!.is_weakest).toBe(true);

    // Revenue descending (no row has higher revenue than the one before it)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.revenue).toBeLessThanOrEqual(rows[i - 1]!.revenue);
    }
  });

  it("GET /analytics/orders-by-hour for 2026-06-24 shows at least one peak hour", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/orders-by-hour?date=2026-06-24")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const rows = res.body as Array<{ hour: number; order_count: number }>;

    // All 5 orders were placed at 2026-06-24 10:xx UTC → hour 10 should show up
    expect(rows.length).toBeGreaterThan(0);

    const hour10 = rows.find((r) => r.hour === 10);
    expect(hour10, "Hour 10 in orders-by-hour").toBeTruthy();
    expect(hour10!.order_count).toBeGreaterThanOrEqual(5); // all 5 pilot orders placed at 10:xx
  });
});

// ---------------------------------------------------------------------------
// Step (g): Failed print → reprint from web app → new PENDING job
// ---------------------------------------------------------------------------

describe("Step (g): Failed print job reprinted via web app → new PENDING job", () => {
  const AGENT_TOKEN = "test-agent-token";

  it("Ingests a fresh order, acks its print job as FAILED, then reprints → new PENDING job", async () => {
    // Ingest a new Sip & Co order
    const ingestRes = await request(app)
      .post("/api/v1/ingest/order")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        brand_id:     brandIds["Sip & Co"],
        aggregator:   "GRABFOOD",
        external_ref: nextRef("GF-SC-FAIL"),
        customer_name: "Reprint Test",
        placed_at:    "2026-06-24T11:00:00Z",
        items: [{ menu_item_id: menuItemIds["Sip & Co/Iced Tea"], qty: 1 }],
      });
    expect(ingestRes.status).toBe(201);
    const jobId = (ingestRes.body.print_jobs as Array<{ id: string }>)[0]!.id;
    expect(jobId).toBeTruthy();

    // Agent ACKs it as FAILED
    const failAck = await request(app)
      .post(`/api/v1/agent/print-jobs/${jobId}/ack`)
      .set("X-Agent-Token", AGENT_TOKEN)
      .send({ status: "FAILED", error: "printer offline: 192.168.1.52:9100 timeout" });
    expect(failAck.status).toBe(200);
    expect(failAck.body.status).toBe("FAILED");

    // Verify the job is now FAILED in the list
    const failedRes = await request(app)
      .get("/api/v1/print-jobs?status=FAILED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(failedRes.status).toBe(200);
    const failedJobs = failedRes.body as Array<{ id: string; status: string }>;
    expect(failedJobs.some((j) => j.id === jobId)).toBe(true);

    // User triggers a reprint from the web app
    const reprintRes = await request(app)
      .post(`/api/v1/print-jobs/${jobId}/reprint`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reprintRes.status).toBe(201);
    const newJobId = reprintRes.body.id as string;
    expect(newJobId).toBeTruthy();
    expect(newJobId).not.toBe(jobId); // new job, not mutation of original
    expect(reprintRes.body.status).toBe("PENDING");

    // Verify the new PENDING job is visible in the agent's poll
    const pendingRes = await request(app)
      .get("/api/v1/agent/print-jobs/pending")
      .set("X-Agent-Token", AGENT_TOKEN);
    expect(pendingRes.status).toBe(200);
    const pending = pendingRes.body as Array<{ id: string }>;
    expect(pending.some((j) => j.id === newJobId)).toBe(true);

    // Original FAILED job is untouched (audit trail)
    const originalRes = await request(app)
      .get("/api/v1/print-jobs?status=FAILED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(originalRes.status).toBe(200);
    const stillFailed = originalRes.body as Array<{ id: string }>;
    expect(stillFailed.some((j) => j.id === jobId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Teardown (no-op: in-memory PGlite is discarded automatically)
// ---------------------------------------------------------------------------

afterAll(() => {
  // Nothing to close — in-memory PGlite is GC-collected.
  // Clearing global state used for cross-describe sharing.
  delete (globalThis as Record<string, unknown>)["__e2e_tokyoOrderId__"];
  delete (globalThis as Record<string, unknown>)["__e2e_seoulOrderId__"];
  delete (globalThis as Record<string, unknown>)["__e2e_manilaOrderId__"];
  delete (globalThis as Record<string, unknown>)["__e2e_chickenBefore__"];
  delete (globalThis as Record<string, unknown>)["__e2e_porkBefore__"];
});
