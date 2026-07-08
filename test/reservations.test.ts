/**
 * S4 — Stock Reservation System tests (+ S3/S5 cancel behavior, S2 emit room)
 *
 * The reservation is a SOFT HOLD: Cardinal Rule #2 is unchanged — real stock
 * deduction still fires at NEW→PREPARING, never earlier or later.
 *
 * Under test:
 *   • reservation rows created at ingest (one per recipe ingredient)
 *   • released at NEW→PREPARING (deduction replaces the hold, same tx)
 *   • released at cancel-from-NEW (no restock — nothing was deducted)
 *   • availability math: available = on-hand − SUM(active reservations);
 *     GET /inventory exposes per-row `reserved` + `available`
 *   • OTHER (walk-in) aggregator → 409 INSUFFICIENT_STOCK on shortfall,
 *     bypassed by allow_oversell: true
 *   • FOODPANDA shortfall still creates the order + returns stock_risk +
 *     emits `stock.risk` to the outlet room
 *   • duplicate ingest (idempotent replay) does NOT double-reserve
 *   • cancel after advance restocks from the consumption ledger and the route
 *     emits `stock.updated` per ingredient (S5); double-cancel is rejected
 *
 * Uses a RECORDING hub so socket emissions can be asserted without a live
 * Socket.IO server (routes emit through the injected RealtimeHub).
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { stockReservations } from "../src/db/schema.js";
import type { RealtimeHub } from "../src/realtime/hub.js";

let app: Express;
let db: DB;
let adminToken: string;
let warehouseToken: string;
let kitchenToken: string;
let grillStationId: string;
let seededLocationId: string;

interface EmittedEvent {
  locationId: string;
  event: string;
  payload: unknown;
}
const emitted: EmittedEvent[] = [];
const recordingHub: RealtimeHub = {
  emitToLocation(locationId, event, payload) {
    emitted.push({ locationId, event, payload });
  },
};

let _seq = 0;
const nextRef = () => `RSV-${Date.now()}-${++_seq}`;

/**
 * The cancel route resolves the outlet room with an awaited DB call AFTER
 * res.json(), so its hub emissions can land a tick after supertest resolves.
 * Poll briefly instead of asserting immediately.
 */
async function waitForEmitted(event: string, timeoutMs = 2000): Promise<EmittedEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = emitted.find((e) => e.event === event);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for hub event "${event}"`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token as string;
}

async function reservationRowsFor(orderId: string) {
  return db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
}

/** Create ingredient → stock MAIN → ITO to KITCHEN (kitchenQty), returns ingredient id. */
async function makeStockedIngredient(name: string, kitchenQty: number): Promise<string> {
  const ingRes = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name, unit: "g", unit_cost: "1.00", low_stock_threshold: "10" });
  expect(ingRes.status).toBe(201);
  const id = ingRes.body.id as string;

  if (kitchenQty > 0) {
    await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: id, quantity: kitchenQty }] });
    const itoRes = await request(app)
      .post("/api/v1/itos")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ from: "MAIN", to: "KITCHEN", items: [{ ingredient_id: id, quantity: kitchenQty }] });
    expect(itoRes.status).toBe(201);
    const confirmRes = await request(app)
      .post(`/api/v1/itos/${itoRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(confirmRes.status).toBe(200);
  }
  return id;
}

/** Create brand (+FOODPANDA/GRABFOOD/OTHER accounts) + one menu item with a recipe. */
async function makeBrandWithDish(
  name: string,
  ingredientId: string,
  portionQty: number,
): Promise<{ brandId: string; menuId: string }> {
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name, color: "#123123" });
  expect(brandRes.status).toBe(201);
  const brandId = brandRes.body.id as string;

  for (const agg of ["FOODPANDA", "GRABFOOD", "OTHER"] as const) {
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: agg, external_merchant_id: `${name}-${agg}`, credential_ref: `ref-${agg}` });
  }

  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `${name} Dish`, price: "100", station_id: grillStationId });
  expect(menuRes.status).toBe(201);
  const menuId = menuRes.body.id as string;

  await request(app)
    .put(`/api/v1/menu/${menuId}/recipe`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ lines: [{ ingredient_id: ingredientId, portion_qty: portionQty, unit: "g" }] });

  return { brandId, menuId };
}

async function ingest(
  brandId: string,
  menuId: string,
  aggregator: "FOODPANDA" | "GRABFOOD" | "OTHER",
  qty = 1,
  extra: Record<string, unknown> = {},
) {
  return request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator,
      external_ref: nextRef(),
      ...extra,
      items: [{ menu_item_id: menuId, qty }],
    });
}

async function kitchenRow(ingredientId: string) {
  const res = await request(app)
    .get("/api/v1/inventory?warehouse=KITCHEN")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  return (
    res.body as Array<{
      ingredientId: string;
      quantity: string;
      reserved: number;
      available: number;
    }>
  ).find((r) => r.ingredientId === ingredientId);
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db, recordingHub);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  grillStationId = (stRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  )!.id;

  const outletsRes = await request(app)
    .get("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`);
  seededLocationId = (outletsRes.body as Array<{ id: string; code: string }>).find(
    (o) => o.code === "CK1",
  )!.id;
}, 60_000);

// ---------------------------------------------------------------------------
// Reservation lifecycle: created at ingest, released at advance / cancel
// ---------------------------------------------------------------------------

describe("reservation lifecycle", () => {
  let ingId: string;
  let brandId: string;
  let menuId: string;

  beforeAll(async () => {
    ingId = await makeStockedIngredient("RSV_Lifecycle", 1000);
    ({ brandId, menuId } = await makeBrandWithDish("RSV_Life", ingId, 200));
  });

  it("ingest creates one stock_reservation row per recipe ingredient (portion × qty)", async () => {
    const res = await ingest(brandId, menuId, "FOODPANDA", 2);
    expect(res.status).toBe(201);
    const orderId = res.body.order_id as string;

    const rows = await reservationRowsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].ingredientId).toBe(ingId);
    expect(Number(rows[0].quantity)).toBe(400); // 200g × qty 2

    // Rule #2 intact: on-hand UNCHANGED while NEW — only the hold exists.
    const row = await kitchenRow(ingId);
    expect(Number(row!.quantity)).toBe(1000);
    expect(row!.reserved).toBe(400);
    expect(row!.available).toBe(600);
  });

  it("advance NEW→PREPARING deducts AND releases the reservation in the same tx", async () => {
    const res = await ingest(brandId, menuId, "FOODPANDA", 1);
    expect(res.status).toBe(201);
    const orderId = res.body.order_id as string;
    expect(await reservationRowsFor(orderId)).toHaveLength(1);

    const adv = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adv.status).toBe(200);
    expect(adv.body.status).toBe("PREPARING");

    expect(await reservationRowsFor(orderId)).toHaveLength(0); // hold released
  });

  it("cancel-from-NEW releases the reservation and does NOT restock (nothing deducted)", async () => {
    const before = await kitchenRow(ingId);
    const onHandBefore = Number(before!.quantity);

    const res = await ingest(brandId, menuId, "GRABFOOD", 1);
    expect(res.status).toBe(201);
    const orderId = res.body.order_id as string;
    expect(await reservationRowsFor(orderId)).toHaveLength(1);

    const cancel = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "reservation release test" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    expect(await reservationRowsFor(orderId)).toHaveLength(0);
    const after = await kitchenRow(ingId);
    expect(Number(after!.quantity)).toBe(onHandBefore); // no phantom restock
  });
});

// ---------------------------------------------------------------------------
// Availability math: a second order sees availability reduced by live holds
// ---------------------------------------------------------------------------

describe("availability includes active reservations", () => {
  let ingId: string;
  let brandId: string;
  let menuId: string;

  beforeAll(async () => {
    // 500 on hand; dish takes 300 → first order reserves 300, leaving 200 available.
    ingId = await makeStockedIngredient("RSV_Avail", 500);
    ({ brandId, menuId } = await makeBrandWithDish("RSV_Avail", ingId, 300));
  });

  it("second OTHER order is 409'd although on-hand alone would cover it", async () => {
    const first = await ingest(brandId, menuId, "FOODPANDA", 1);
    expect(first.status).toBe(201);
    expect(first.body.stock_risk).toBeUndefined(); // 300 ≤ 500 available

    // On-hand is still 500 (no deduction), but available is 200 < 300 required.
    const second = await ingest(brandId, menuId, "OTHER", 1);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INSUFFICIENT_STOCK");
    const details = second.body.error.details as Array<{
      ingredient_id: string;
      ingredient_name: string;
      required: number;
      available: number;
    }>;
    expect(details).toHaveLength(1);
    expect(details[0].ingredient_id).toBe(ingId);
    expect(details[0].ingredient_name).toBe("RSV_Avail");
    expect(details[0].required).toBe(300);
    expect(details[0].available).toBe(200); // 500 on hand − 300 reserved

    // GET /inventory reflects the same math per row.
    const row = await kitchenRow(ingId);
    expect(Number(row!.quantity)).toBe(500);
    expect(row!.reserved).toBe(300);
    expect(row!.available).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Shortfall policy per aggregator
// ---------------------------------------------------------------------------

describe("shortfall policy: OTHER blocks (unless allow_oversell), aggregators flag", () => {
  let ingId: string;
  let brandId: string;
  let menuId: string;

  beforeAll(async () => {
    // 100 on hand, dish needs 250 → always short.
    ingId = await makeStockedIngredient("RSV_Short", 100);
    ({ brandId, menuId } = await makeBrandWithDish("RSV_Short", ingId, 250));
  });

  it("OTHER (walk-in) shortfall → 409 INSUFFICIENT_STOCK, no order/reservation created", async () => {
    const res = await ingest(brandId, menuId, "OTHER", 1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");

    // No hold left behind by the rejected ingest.
    const row = await kitchenRow(ingId);
    expect(row!.reserved).toBe(0);
  });

  it("OTHER with allow_oversell: true → 201 + stock_risk (behaves like the aggregator path)", async () => {
    const res = await ingest(brandId, menuId, "OTHER", 1, { allow_oversell: true });
    expect(res.status).toBe(201);
    const risk = res.body.stock_risk as Array<{ ingredient_id: string; required: number; available: number }>;
    expect(risk).toHaveLength(1);
    expect(risk[0].ingredient_id).toBe(ingId);
    expect(risk[0].required).toBe(250);
    expect(risk[0].available).toBe(100);

    // The oversold order still reserves (the hold tracks committed demand).
    const rows = await reservationRowsFor(res.body.order_id as string);
    expect(rows).toHaveLength(1);
  });

  it("FOODPANDA shortfall STILL creates the order, returns stock_risk, and emits stock.risk", async () => {
    emitted.length = 0;
    const res = await ingest(brandId, menuId, "FOODPANDA", 1);
    expect(res.status).toBe(201); // platform already took payment — never block
    expect(res.body.order_id).toBeTruthy();
    expect(Array.isArray(res.body.stock_risk)).toBe(true);

    // S2 — order.created goes to the brand's OWN outlet room.
    const createdEvt = emitted.find((e) => e.event === "order.created");
    expect(createdEvt).toBeTruthy();
    expect(createdEvt!.locationId).toBe(seededLocationId);
    expect((createdEvt!.payload as { order_id: string }).order_id).toBe(res.body.order_id);

    // S4 — stock.risk emitted with the shortfall details.
    const riskEvt = emitted.find((e) => e.event === "stock.risk");
    expect(riskEvt).toBeTruthy();
    expect(riskEvt!.locationId).toBe(seededLocationId);
    const payload = riskEvt!.payload as {
      order_id: string;
      brand_id: string;
      external_ref: string;
      shortfalls: Array<{ ingredient_id: string }>;
    };
    expect(payload.order_id).toBe(res.body.order_id);
    expect(payload.brand_id).toBe(brandId);
    expect(payload.shortfalls[0].ingredient_id).toBe(ingId);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: duplicate ingest never double-reserves
// ---------------------------------------------------------------------------

describe("duplicate ingest does not double-reserve", () => {
  it("replaying the same (listing, external_ref) leaves exactly the original hold", async () => {
    const ingId = await makeStockedIngredient("RSV_Dup", 1000);
    const { brandId, menuId } = await makeBrandWithDish("RSV_Dup", ingId, 100);

    const ref = nextRef();
    const send = () =>
      request(app)
        .post("/api/v1/ingest/order")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          brand_id: brandId,
          aggregator: "FOODPANDA",
          external_ref: ref,
          items: [{ menu_item_id: menuId, qty: 1 }],
        });

    const first = await send();
    expect(first.status).toBe(201);
    const orderId = first.body.order_id as string;

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.code).toBe("DUPLICATE_ORDER");
    expect(replay.body.order_id).toBe(orderId);

    const rows = await reservationRowsFor(orderId);
    expect(rows).toHaveLength(1); // NOT 2
    expect(Number(rows[0].quantity)).toBe(100);

    const row = await kitchenRow(ingId);
    expect(row!.reserved).toBe(100); // NOT 200
  });
});

// ---------------------------------------------------------------------------
// S3/S5 — cancel after advance: ledger-driven restock + stock.updated emits
// ---------------------------------------------------------------------------

describe("cancel after advance: consumption-log-driven restock + S5 emissions", () => {
  let ingId: string;
  let brandId: string;
  let menuId: string;
  let orderId: string;

  beforeAll(async () => {
    ingId = await makeStockedIngredient("RSV_CancelAdv", 1000);
    ({ brandId, menuId } = await makeBrandWithDish("RSV_CancelAdv", ingId, 400));

    const res = await ingest(brandId, menuId, "FOODPANDA", 1);
    expect(res.status).toBe(201);
    orderId = res.body.order_id as string;

    const adv = await request(app)
      .post(`/api/v1/orders/${orderId}/advance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adv.status).toBe(200);
    expect(adv.body.status).toBe("PREPARING"); // deducted 400 → 600 on hand
  });

  it("cancel restocks exactly what was deducted and emits stock.updated with the new balance", async () => {
    emitted.length = 0;
    const cancel = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "S5 emission test" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    const row = await kitchenRow(ingId);
    expect(Number(row!.quantity)).toBe(1000); // 600 + 400 back

    // S5 — route emitted stock.updated for the restocked ingredient.
    const stockEvt = await waitForEmitted("stock.updated");
    expect(stockEvt.locationId).toBe(seededLocationId);
    expect(stockEvt.payload).toEqual({
      ingredientId: ingId,
      ingredientName: "RSV_CancelAdv",
      warehouseType: "KITCHEN",
      quantity: 1000,
    });
    expect(emitted.filter((e) => e.event === "stock.updated")).toHaveLength(1);

    // order.updated (CANCELLED) still emitted as before.
    const updEvt = await waitForEmitted("order.updated");
    expect((updEvt.payload as { status: string }).status).toBe("CANCELLED");
  });

  it("double-cancel is rejected (400) and does not double-restock", async () => {
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "second attempt" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    const row = await kitchenRow(ingId);
    expect(Number(row!.quantity)).toBe(1000); // unchanged — no double restock
  });
});

// ---------------------------------------------------------------------------
// No-recipe brands keep working exactly as today (reserve nothing)
// ---------------------------------------------------------------------------

describe("brand without recipe lines reserves nothing", () => {
  it("ingest succeeds with zero reservation rows", async () => {
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "RSV_NoRecipe", color: "#654321" });
    const brandId = brandRes.body.id as string;
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "OTHER", external_merchant_id: "RSV-NR", credential_ref: "ref-nr" });
    const menuRes = await request(app)
      .post(`/api/v1/brands/${brandId}/menu`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "No Recipe Dish", price: "50", station_id: grillStationId });
    const menuId = menuRes.body.id as string;

    // OTHER + zero stock + NO recipe → must still be accepted (no shortfall possible).
    const res = await ingest(brandId, menuId, "OTHER", 3);
    expect(res.status).toBe(201);
    expect(res.body.stock_risk).toBeUndefined();
    expect(await reservationRowsFor(res.body.order_id as string)).toHaveLength(0);
  });
});
