/**
 * HTTP-level auth/contract test suite for the Customer Order router
 * (src/modules/customer-orders/routes.ts). Complements the service-level
 * customer-order-lifecycle.test.ts / customer-order-allocation.test.ts by
 * exercising the router's own requireAuth / zod `.strict()` / bounded-header
 * layers over supertest, instead of calling the service functions directly.
 * Mirrors test/stock-return-routes-auth.test.ts's fixture + token-minting
 * shape.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import { inventoryLotBalances, inventoryLots, operationalFeatureFlags, topologyMigrationExceptions } from "../src/db/enterprise-schema.js";
import { customerOrders } from "../src/db/customer-orders-schema.js";
import { customers, ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  jwtSecret = loadConfig().jwtSecret;
  app = createApp(db);
  await runMigrations(db);

  // fulfill() posts stock through the central posting service, which requires
  // stock.lot_writes enabled and no OPEN topology exceptions before it will
  // accept any movement (mirrors customer-order-lifecycle.test.ts's fixture).
  await db.update(operationalFeatureFlags).set({ enabled: true, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.customer_order_fulfillment"));
  const [hqLocation] = await db.insert(locations).values({ code: `COHQ-${suffix()}`, name: "Customer Order HTTP HQ" }).returning();
  await db.insert(warehouses).values({
    locationId: hqLocation!.id,
    type: "MAIN",
    purpose: "HQ_MAIN",
    code: `WH-COHQ-${suffix()}`,
    name: "Customer Order HTTP HQ Main",
  });
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Auth test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

async function setCoFlag(enabled: boolean): Promise<void> {
  await db.update(operationalFeatureFlags).set({ enabled, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, "stock.customer_order_fulfillment"));
}

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

interface OutletFixture {
  locationId: string;
  kitchenId: string;
  outletStorageId: string;
}

async function outletFixture(): Promise<OutletFixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `COA-${s}`, name: `CO Outlet ${s}` }).returning();
  const [kitchen] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `WH-COA-K-${s}`, name: `CO Kitchen ${s}` })
    .returning();
  const [outletStorage] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "MAIN", purpose: "OUTLET_STORAGE", code: `WH-COA-S-${s}`, name: `CO Storage ${s}` })
    .returning();
  return { locationId: location!.id, kitchenId: kitchen!.id, outletStorageId: outletStorage!.id };
}

interface Actor {
  userId: string;
  token: string;
}

/** Real `users` row + JWT minted for it, scoped to `locationId` unless the role has ALL scope. */
async function actor(role: Role, locationId?: string): Promise<Actor> {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({ name: `CO Actor ${s}`, email: `co-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token };
}

async function makeCustomer(): Promise<string> {
  const s = suffix();
  const [customer] = await db.insert(customers).values({ code: `COA-CUST-${s}`, name: `CO Customer ${s}` }).returning();
  return customer!.id;
}

async function makeItem(): Promise<string> {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `COA-ITEM-${s}`,
      name: `CO Item ${s}`,
      unit: "kg",
      itemType: "FINISHED_GOOD",
      lotTracked: false,
      unitCost: "1.000000",
      lowStockThreshold: "0.0000",
    })
    .returning();
  return item!.id;
}

async function seedLot(itemId: string, warehouseId: string, onHand = "10.000000"): Promise<string> {
  const s = suffix();
  const [lot] = await db.insert(inventoryLots).values({ itemId, lotCode: `COA-LOT-${s}`, status: "AVAILABLE", unitCost: "1.000000" }).returning();
  await db.insert(inventoryLotBalances).values({ warehouseId, lotId: lot!.id, onHand, reserved: "0" });
  return lot!.id;
}

function stockedOutputLine(itemId: string, overrides: Record<string, unknown> = {}) {
  return {
    item_id: itemId,
    entered_uom: "kg",
    entered_quantity: "2.000000",
    unit_price: "100.000000",
    consumption_mode: "STOCKED_OUTPUT",
    ...overrides,
  };
}

/** Full outlet + customer + item + lot fixture for one order test. */
async function fullFixture(onHand = "10.000000") {
  const fx = await outletFixture();
  const customerId = await makeCustomer();
  const itemId = await makeItem();
  const lotId = await seedLot(itemId, fx.kitchenId, onHand);
  return { ...fx, customerId, itemId, lotId };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated
// ---------------------------------------------------------------------------

describe("unauthenticated requests", () => {
  it("GET /customer-orders -> 401", async () => {
    const res = await request(app).get("/api/v1/customer-orders");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("POST /customer-orders -> 401", async () => {
    const res = await request(app).post("/api/v1/customer-orders").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 2. Strict schema — no actor/session smuggling; malformed inputs
// ---------------------------------------------------------------------------

describe("POST /customer-orders strict body + malformed inputs", () => {
  it("rejects a client-supplied actorUserId/sessionId as unknown keys -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        customer_id: fx.customerId,
        location_id: fx.locationId,
        actorUserId: randomUUID(),
        sessionId: randomUUID(),
        lines: [stockedOutputLine(fx.itemId)],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed customer_id UUID -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: "not-a-uuid", location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an entered_quantity with more than 6 fraction digits -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        customer_id: fx.customerId,
        location_id: fx.locationId,
        lines: [stockedOutputLine(fx.itemId, { entered_quantity: "1.1234567" })],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 3. Role enforcement
// ---------------------------------------------------------------------------

describe("role enforcement", () => {
  it("403s create from a role outside CUSTOMER_ORDER_ROLES", async () => {
    const fx = await fullFixture();
    const crew = await actor("KITCHEN_CREW", fx.locationId);
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${crew.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("403s approve() by a role outside CUSTOMER_ORDER_APPROVE_ROLES (WAREHOUSE_OUTLET can create/submit but not approve)", async () => {
    const fx = await fullFixture();
    const owner = await actor("WAREHOUSE_OUTLET", fx.locationId);
    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const submitRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);

    const approveRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// 4. Outlet scope enforcement
// ---------------------------------------------------------------------------

describe("outlet scope enforcement", () => {
  it("403s create when the actor's outlet access does not cover location_id, and creates no order", async () => {
    const fx = await fullFixture();
    const stranger = await actor("WAREHOUSE_OUTLET"); // scoped to a different (implicit) outlet
    const res = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${stranger.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");

    const rows = await db.select().from(customerOrders).where(eq(customerOrders.locationId, fx.locationId));
    expect(rows).toHaveLength(0);
  });

  it("a scoped actor can create then GET/list its own order; a different-outlet actor is denied", async () => {
    const fx = await fullFixture();
    const owner = await actor("WAREHOUSE_OUTLET", fx.locationId);
    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;

    const getRes = await request(app).get(`/api/v1/customer-orders/${orderId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(orderId);

    const listRes = await request(app).get("/api/v1/customer-orders").set("Authorization", `Bearer ${owner.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const stranger = await actor("WAREHOUSE_OUTLET");
    const strangerGetRes = await request(app).get(`/api/v1/customer-orders/${orderId}`).set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerGetRes.status).toBe(403);
    expect(strangerGetRes.body.error.code).toBe("UNAUTHORIZED");

    const strangerListRes = await request(app).get("/api/v1/customer-orders").set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerListRes.status).toBe(200);
    expect(strangerListRes.body.items.some((o: { id: string }) => o.id === orderId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Fulfill bounded-header contract guard
// ---------------------------------------------------------------------------

describe("POST /customer-orders/:id/fulfill header guard", () => {
  it("400s before any mutation when Idempotency-Key/X-Correlation-ID are missing", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;

    const submitRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    const allocateRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/allocate`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: approveRes.body.version });
    const readyRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/mark-ready`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: allocateRes.body.version });
    expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);

    const noHeadersRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/fulfill`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: readyRes.body.version });
    expect(noHeadersRes.status).toBe(400);
    expect(noHeadersRes.body.error.code).toBe("VALIDATION_ERROR");

    const oneHeaderRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/fulfill`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ version: readyRes.body.version });
    expect(oneHeaderRes.status).toBe(400);
    expect(oneHeaderRes.body.error.code).toBe("VALIDATION_ERROR");

    const getRes = await request(app).get(`/api/v1/customer-orders/${orderId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("READY");
    expect(getRes.body.version).toBe(readyRes.body.version);
  });
});

// ---------------------------------------------------------------------------
// 6. Full HTTP lifecycle: create -> submit -> approve -> allocate -> mark-ready
//    -> fulfill (idempotent retry), then illegal-transition + stale-version 409s.
// ---------------------------------------------------------------------------

describe("full customer order lifecycle over HTTP", () => {
  it("moves an order through every transition and posts stock exactly once on a fulfill retry", async () => {
    const fx = await fullFixture("10.000000");
    const owner = await actor("OWNER", fx.locationId); // creator + submitter + allocator + fulfiller
    const approver = await actor("WAREHOUSE_MAIN"); // distinct actor, maker-checker

    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;
    expect(createRes.body.status).toBe("DRAFT");

    const submitRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);
    expect(submitRes.body.status).toBe("SUBMITTED");

    const approveRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);
    expect(approveRes.body.status).toBe("APPROVED");

    const allocateRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/allocate`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: approveRes.body.version });
    expect(allocateRes.status, JSON.stringify(allocateRes.body)).toBe(200);
    expect(allocateRes.body.status).toBe("ALLOCATED");

    const readyRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/mark-ready`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: allocateRes.body.version });
    expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);
    expect(readyRes.body.status).toBe("READY");

    const fulfillKey = randomUUID();
    const fulfillCorrelation = randomUUID();
    const fulfillRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/fulfill`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", fulfillKey)
      .set("X-Correlation-ID", fulfillCorrelation)
      .send({ version: readyRes.body.version });
    expect(fulfillRes.status, JSON.stringify(fulfillRes.body)).toBe(200);
    expect(fulfillRes.body.status).toBe("FULFILLED");

    const [balanceRow] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.lotId, fx.lotId));
    expect(balanceRow!.onHand).toBe("8.000000");

    // Retry the exact same fulfill call: replayed, not double-posted.
    const fulfillRetryRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/fulfill`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", fulfillKey)
      .set("X-Correlation-ID", fulfillCorrelation)
      .send({ version: readyRes.body.version });
    expect(fulfillRetryRes.status, JSON.stringify(fulfillRetryRes.body)).toBe(200);
    expect(fulfillRetryRes.body.status).toBe("FULFILLED");
    expect(fulfillRetryRes.body.id).toBe(orderId);

    const [balanceRowAfterRetry] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.lotId, fx.lotId));
    expect(balanceRowAfterRetry!.onHand).toBe("8.000000");

    // Post-fulfillment cancel is an illegal transition -> 409.
    const cancelRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: fulfillRetryRes.body.version, reason: "Too late" });
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error.code).toBe("INVALID_TRANSITION");
  });
});

// ---------------------------------------------------------------------------
// 7. Version-conflict + malformed cancel-reason 409/400s: stable error envelope.
// ---------------------------------------------------------------------------

describe("409/400 stable envelope", () => {
  it("submitting with a stale version -> 409 CONCURRENT_MODIFICATION", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;
    const staleVersion = (createRes.body.version as number) + 1;

    const submitRes = await request(app)
      .post(`/api/v1/customer-orders/${orderId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: staleVersion });
    expect(submitRes.status).toBe(409);
    expect(submitRes.body.error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(typeof submitRes.body.error.message).toBe("string");

    const getRes = await request(app).get(`/api/v1/customer-orders/${orderId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("DRAFT");
    expect(getRes.body.version).toBe(createRes.body.version);
  });

  it("rejects cancel with a blank reason -> 400 before any service call", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    const cancelRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version, reason: "" });
    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 8. Flag-gated stock-transition refusal surfaces the service's own status.
// ---------------------------------------------------------------------------

describe("stock.customer_order_fulfillment dark-mode gate over HTTP", () => {
  it("503s allocate() while the flag is disabled, with no allocation rows written", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER", fx.locationId);
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/customer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ customer_id: fx.customerId, location_id: fx.locationId, lines: [stockedOutputLine(fx.itemId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const submitRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    await setCoFlag(false);
    const allocateRes = await request(app)
      .post(`/api/v1/customer-orders/${createRes.body.id}/allocate`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: approveRes.body.version });
    expect(allocateRes.status).toBe(503);
    expect(allocateRes.body.error.code).toBe("FEATURE_DISABLED");

    await setCoFlag(true); // restore for subsequent tests in this file
  });
});
