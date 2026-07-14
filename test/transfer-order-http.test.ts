/**
 * HTTP-level auth/contract test suite for the HQ Transfer Order router
 * (src/modules/transfers/routes.ts). Complements the service-level
 * transfer-order-lifecycle.test.ts by exercising the router's own
 * requireAuth / zod `.strict()` / bounded-header layers over supertest,
 * instead of calling the service functions directly. Fixture + token-minting
 * shape mirrors test/customer-order-http.test.ts and
 * test/stock-return-routes-auth.test.ts; route-fixture shape (HQ_MAIN ->
 * OUTLET_STORAGE) mirrors test/transfer-order-lifecycle.test.ts.
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
import { transferOrders } from "../src/db/transfer-orders-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let sequence = 0;
let hqMainWarehouseId: string;
let hqLocationId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  jwtSecret = loadConfig().jwtSecret;
  app = createApp(db);
  await runMigrations(db);

  await db.update(operationalFeatureFlags).set({ enabled: true, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Transfer HTTP test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));

  // D31: exactly one active HQ_MAIN warehouse company-wide.
  const [hqLocation] = await db.insert(locations).values({ code: `TOH-HQ-${suffix()}`, name: "Transfer HTTP HQ" }).returning();
  hqLocationId = hqLocation!.id;
  const [hqWarehouse] = await db
    .insert(warehouses)
    .values({ locationId: hqLocationId, type: "MAIN", purpose: "HQ_MAIN", code: `WH-TOH-HQ-${suffix()}`, name: "Transfer HTTP HQ Main" })
    .returning();
  hqMainWarehouseId = hqWarehouse!.id;
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function setTransfersEnabled(enabled: boolean): Promise<void> {
  await db.update(operationalFeatureFlags).set({ enabled, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, "stock.transfers"));
}

interface OutletFixture {
  outletLocationId: string;
  outletStorageId: string;
}

async function outletFixture(): Promise<OutletFixture> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `TOH-A-${s}`, name: `TOH Outlet ${s}` }).returning();
  const [outletStorage] = await db
    .insert(warehouses)
    .values({ locationId: location!.id, type: "MAIN", purpose: "OUTLET_STORAGE", code: `WH-TOH-A-${s}`, name: `TOH Storage ${s}` })
    .returning();
  return { outletLocationId: location!.id, outletStorageId: outletStorage!.id };
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
    .values({ name: `TOH Actor ${s}`, email: `toh-actor-${s}@test.local`, passwordHash: "hash", role })
    .returning();
  const scope = outletScopeForRole(role);
  const outletIds = scope === "ALL" || !locationId ? [] : [locationId];
  if (scope !== "ALL" && locationId) {
    await db.insert(userOutletAccess).values({ userId: user!.id, locationId });
  }
  const token = signToken({ id: user!.id, role: user!.role, name: user!.name }, jwtSecret, { outletIds });
  return { userId: user!.id, token };
}

async function makeItem(): Promise<string> {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `TOH-ITEM-${s}`, name: `TOH Item ${s}`, unit: "kg", itemType: "RAW", lotTracked: true, unitCost: "10.000000", lowStockThreshold: "1.0000" })
    .returning();
  return item!.id;
}

async function seedHqLot(itemId: string, onHand = "50.000000"): Promise<string> {
  const s = suffix();
  const [lot] = await db.insert(inventoryLots).values({ itemId, lotCode: `TOH-LOT-${s}`, status: "AVAILABLE", unitCost: "10.000000" }).returning();
  await db.insert(inventoryLotBalances).values({ warehouseId: hqMainWarehouseId, lotId: lot!.id, onHand, reserved: "0" });
  return lot!.id;
}

function lineBody(itemId: string, lotId: string, overrides: Record<string, unknown> = {}) {
  return { item_id: itemId, lot_id: lotId, entered_quantity: "10", entered_uom: "kg", ...overrides };
}

/** Full HQ -> outlet fixture: outlet + item + HQ-side lot balance. */
async function fullFixture(onHand = "50.000000") {
  const outlet = await outletFixture();
  const itemId = await makeItem();
  const lotId = await seedHqLot(itemId, onHand);
  return { ...outlet, itemId, lotId };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated
// ---------------------------------------------------------------------------

describe("unauthenticated requests", () => {
  it("GET /transfer-orders -> 401", async () => {
    const res = await request(app).get("/api/v1/transfer-orders");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("POST /transfer-orders -> 401", async () => {
    const res = await request(app).post("/api/v1/transfer-orders").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 2. Strict schema — no actor/session smuggling; malformed inputs
// ---------------------------------------------------------------------------

describe("POST /transfer-orders strict body + malformed inputs", () => {
  it("rejects a client-supplied actorUserId/sessionId as unknown keys -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_warehouse_id: hqMainWarehouseId,
        destination_warehouse_id: fx.outletStorageId,
        actorUserId: randomUUID(),
        sessionId: randomUUID(),
        lines: [lineBody(fx.itemId, fx.lotId)],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed source_warehouse_id UUID -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: "not-a-uuid", destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an entered_quantity with more than 6 fraction digits -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_warehouse_id: hqMainWarehouseId,
        destination_warehouse_id: fx.outletStorageId,
        lines: [lineBody(fx.itemId, fx.lotId, { entered_quantity: "1.1234567" })],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 3. Role enforcement
// ---------------------------------------------------------------------------

describe("role enforcement", () => {
  it("403s create from a role outside TRANSFER_ROLES", async () => {
    const fx = await fullFixture();
    const crew = await actor("KITCHEN_CREW", hqLocationId);
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${crew.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("403s approve() by a role outside TRANSFER_APPROVE_ROLES (WAREHOUSE_OUTLET can create/submit but not approve)", async () => {
    const fx = await fullFixture();
    const worker = await actor("WAREHOUSE_OUTLET", hqLocationId);
    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${worker.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${worker.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);

    const approveRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${worker.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// 4. Outlet scope enforcement
// ---------------------------------------------------------------------------

describe("outlet scope enforcement", () => {
  it("403s create when the actor's outlet access does not cover the source (HQ) location, and creates no order", async () => {
    const fx = await fullFixture();
    const stranger = await actor("WAREHOUSE_OUTLET", fx.outletLocationId); // scoped to the outlet, not HQ
    const marker = `no-order-${suffix()}`;
    const res = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${stranger.token}`)
      .send({
        source_warehouse_id: hqMainWarehouseId,
        destination_warehouse_id: fx.outletStorageId,
        remarks: marker,
        lines: [lineBody(fx.itemId, fx.lotId)],
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");

    const rows = await db.select().from(transferOrders).where(eq(transferOrders.remarks, marker));
    expect(rows).toHaveLength(0);
  });

  it("a scoped actor can create then GET/list its own order; a different-outlet actor is denied", async () => {
    const fx = await fullFixture();
    const owner = await actor("WAREHOUSE_OUTLET", hqLocationId);
    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;

    const getRes = await request(app).get(`/api/v1/transfer-orders/${orderId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(orderId);

    const listRes = await request(app).get("/api/v1/transfer-orders").set("Authorization", `Bearer ${owner.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const stranger = await actor("WAREHOUSE_OUTLET"); // scoped to a different (implicit) outlet
    const strangerGetRes = await request(app).get(`/api/v1/transfer-orders/${orderId}`).set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerGetRes.status).toBe(403);
    expect(strangerGetRes.body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// 5. Segregation of duties
// ---------------------------------------------------------------------------

describe("segregation of duties", () => {
  it("409s approve() by the same actor who submitted", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);

    const approveRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.error.code).toBe("SEGREGATION_OF_DUTIES");
  });
});

// ---------------------------------------------------------------------------
// 6. Dispatch bounded-header contract guard
// ---------------------------------------------------------------------------

describe("POST /transfer-orders/:id/dispatch header guard", () => {
  it("400s before any mutation when Idempotency-Key/X-Correlation-ID are missing", async () => {
    await setTransfersEnabled(true);
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    const noHeadersRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: approveRes.body.version });
    expect(noHeadersRes.status).toBe(400);
    expect(noHeadersRes.body.error.code).toBe("VALIDATION_ERROR");

    const oneHeaderRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ version: approveRes.body.version });
    expect(oneHeaderRes.status).toBe(400);
    expect(oneHeaderRes.body.error.code).toBe("VALIDATION_ERROR");

    const getRes = await request(app).get(`/api/v1/transfer-orders/${createRes.body.id}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("APPROVED");
    expect(getRes.body.version).toBe(approveRes.body.version);
  });
});

// ---------------------------------------------------------------------------
// 7. Full HTTP lifecycle: create -> submit -> approve -> dispatch -> receive
//    (idempotent retry), then illegal-transition + stale-version checks.
// ---------------------------------------------------------------------------

describe("full transfer order lifecycle over HTTP", () => {
  it("moves an order through every transition and posts stock exactly once on a dispatch retry", async () => {
    await setTransfersEnabled(true);
    const fx = await fullFixture("50.000000");
    const owner = await actor("OWNER"); // creator + submitter + dispatcher + receiver
    const approver = await actor("WAREHOUSE_MAIN"); // distinct actor, maker-checker

    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId, { entered_quantity: "12" })] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;
    expect(createRes.body.status).toBe("DRAFT");

    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.body.status).toBe("SUBMITTED");

    const approveRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.body.status).toBe("APPROVED");

    const dispatchKey = randomUUID();
    const dispatchCorrelation = randomUUID();
    const dispatchRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", dispatchKey)
      .set("X-Correlation-ID", dispatchCorrelation)
      .send({ version: approveRes.body.version });
    expect(dispatchRes.status, JSON.stringify(dispatchRes.body)).toBe(200);
    expect(dispatchRes.body.status).toBe("DISPATCHED");

    const [balanceAfterDispatch] = await db.select().from(inventoryLotBalances).where(eq(inventoryLotBalances.lotId, fx.lotId));
    expect(balanceAfterDispatch!.onHand).toBe("38.000000");

    // Retry the exact same dispatch call: replayed, not double-posted.
    const dispatchRetryRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", dispatchKey)
      .set("X-Correlation-ID", dispatchCorrelation)
      .send({ version: approveRes.body.version });
    expect(dispatchRetryRes.status, JSON.stringify(dispatchRetryRes.body)).toBe(200);
    expect(dispatchRetryRes.body.status).toBe("DISPATCHED");

    const [balanceAfterRetry] = await db.select().from(inventoryLotBalances).where(eq(inventoryLotBalances.lotId, fx.lotId));
    expect(balanceAfterRetry!.onHand).toBe("38.000000");

    const receiveRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/receive`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .set("X-Correlation-ID", randomUUID())
      .send({ version: dispatchRetryRes.body.version });
    expect(receiveRes.status, JSON.stringify(receiveRes.body)).toBe(200);
    expect(receiveRes.body.status).toBe("RECEIVED");

    const [destBalance] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.warehouseId, fx.outletStorageId));
    expect(destBalance!.onHand).toBe("12.000000");

    // Post-receipt cancel is an illegal transition -> 409.
    const cancelRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: receiveRes.body.version, cancel_reason: "Too late" });
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error.code).toBe("INVALID_TRANSITION");
  });
});

// ---------------------------------------------------------------------------
// 8. Version-conflict + malformed cancel-reason 409/400s: stable error envelope.
// ---------------------------------------------------------------------------

describe("409/400 stable envelope", () => {
  it("submitting with a stale version -> 409 CONCURRENT_MODIFICATION", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const orderId = createRes.body.id as string;
    const staleVersion = (createRes.body.version as number) + 1;

    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${orderId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: staleVersion });
    expect(submitRes.status).toBe(409);
    expect(submitRes.body.error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(typeof submitRes.body.error.message).toBe("string");

    const getRes = await request(app).get(`/api/v1/transfer-orders/${orderId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("DRAFT");
    expect(getRes.body.version).toBe(createRes.body.version);
  });

  it("rejects cancel with a blank reason -> 400 before any service call", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    const cancelRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version, cancel_reason: "" });
    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 9. Flag-gated stock-transition refusal surfaces the service's own status.
// ---------------------------------------------------------------------------

describe("stock.transfers dark-mode gate over HTTP", () => {
  it("503s dispatch() while the flag is disabled, with no balance change", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/transfer-orders")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ source_warehouse_id: hqMainWarehouseId, destination_warehouse_id: fx.outletStorageId, lines: [lineBody(fx.itemId, fx.lotId)] });
    const submitRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    await setTransfersEnabled(false);
    const dispatchRes = await request(app)
      .post(`/api/v1/transfer-orders/${createRes.body.id}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .set("X-Correlation-ID", randomUUID())
      .send({ version: approveRes.body.version });
    expect(dispatchRes.status).toBe(503);
    expect(dispatchRes.body.error.code).toBe("FEATURE_DISABLED");

    const [balanceRow] = await db.select().from(inventoryLotBalances).where(eq(inventoryLotBalances.lotId, fx.lotId));
    expect(balanceRow!.onHand).toBe("50.000000");

    await setTransfersEnabled(true); // restore for subsequent tests in this file
  });
});
