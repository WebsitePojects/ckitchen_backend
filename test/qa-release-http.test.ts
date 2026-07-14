/**
 * HTTP-level auth/contract test suite for the QA Release router
 * (src/modules/qa-releases/routes.ts). Complements the service-level
 * qa-release-lifecycle.test.ts by exercising the router's own requireAuth /
 * zod `.strict()` / bounded-header layers over supertest, instead of calling
 * the service functions directly. Fixture + token-minting shape mirrors
 * test/customer-order-http.test.ts and test/transfer-order-http.test.ts;
 * the stock_return_batch/stock_return_batch_line/stock_return_receipt_line
 * seeding (direct insert, bypassing stock-returns' own service) mirrors
 * test/qa-release-lifecycle.test.ts's own fixture, for the same reason
 * documented there.
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
import { stockReturnBatchLines, stockReturnBatches, stockReturnReceiptLines } from "../src/db/returns-schema.js";
import { qaReleases } from "../src/db/transfer-orders-schema.js";
import { ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let sequence = 0;
let hqLocationId: string;
let hqMainWarehouseId: string;
let quarantineWarehouseId: string;
let outletLocationId: string;
let outletStorageWarehouseId: string;

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
    .set({ status: "RESOLVED", resolutionNote: "QA release HTTP test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));

  const [hqLocation] = await db.insert(locations).values({ code: `QAH-HQ-${suffix()}`, name: "QA Release HTTP HQ" }).returning();
  hqLocationId = hqLocation!.id;
  const [hqWarehouse] = await db
    .insert(warehouses)
    .values({ locationId: hqLocationId, type: "MAIN", purpose: "HQ_MAIN", code: `WH-QAH-HQ-${suffix()}`, name: "QA Release HTTP HQ Main" })
    .returning();
  hqMainWarehouseId = hqWarehouse!.id;
  const [quarantineWarehouse] = await db
    .insert(warehouses)
    // "type" here just avoids colliding with the HQ_MAIN warehouse's own
    // (location_id, type) unique index at the same physical HQ location;
    // "purpose" is the enterprise identity that matters (mirrors
    // test/qa-release-lifecycle.test.ts's identical fixture note).
    .values({ locationId: hqLocationId, type: "KITCHEN", purpose: "QUARANTINE", code: `WH-QAH-QTN-${suffix()}`, name: "QA Release HTTP Quarantine" })
    .returning();
  quarantineWarehouseId = quarantineWarehouse!.id;

  const [outletLocation] = await db.insert(locations).values({ code: `QAH-OUT-${suffix()}`, name: "QA Release HTTP Outlet" }).returning();
  outletLocationId = outletLocation!.id;
  const [outletStorage] = await db
    .insert(warehouses)
    .values({ locationId: outletLocationId, type: "MAIN", purpose: "OUTLET_STORAGE", code: `WH-QAH-OUT-${suffix()}`, name: "QA Release HTTP Outlet Storage" })
    .returning();
  outletStorageWarehouseId = outletStorage!.id;
});

afterAll(async () => {
  await closeDb(client);
});

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function setReturnsEnabled(enabled: boolean): Promise<void> {
  await db.update(operationalFeatureFlags).set({ enabled, updatedAt: new Date() }).where(eq(operationalFeatureFlags.key, "stock.returns"));
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
    .values({ name: `QAH Actor ${s}`, email: `qah-actor-${s}@test.local`, passwordHash: "hash", role })
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
    .values({ code: `QAH-ITEM-${s}`, name: `QAH Item ${s}`, unit: "kg", itemType: "RAW", lotTracked: true, unitCost: "10.000000", lowStockThreshold: "1.0000" })
    .returning();
  return item!.id;
}

type ReasonCode = "SPOILED" | "EXPIRED" | "DAMAGED" | "RECALLED" | "OTHER";

/**
 * Seeds a stock_return_batch -> stock_return_batch_line -> stock_return_
 * receipt_line chain DIRECTLY (bypassing stock-returns' service), plus a
 * QUARANTINED inventory_lot with a genuinely positive on-hand balance at the
 * quarantine warehouse — same construction as
 * test/qa-release-lifecycle.test.ts's makeReceiptLine() and for the same
 * reason (see that file's header comment): the real
 * receiveAndDisposeStockReturnBatch() always nets a receipt line's
 * quarantine balance back to zero regardless of reason code, so no receipt
 * line reachable through that function's real runtime behavior would ever
 * carry a nonzero quarantine balance to release against.
 */
async function makeReceiptLine(itemId: string, opts: { receivedQuantity?: string; reasonCode?: ReasonCode } = {}) {
  const s = suffix();
  const receivedQuantity = opts.receivedQuantity ?? "10.000000";
  const reasonCode = opts.reasonCode ?? "OTHER";

  const [sourceLot] = await db.insert(inventoryLots).values({ itemId, lotCode: `QAH-SRC-${s}`, unitCost: "10.000000", status: "AVAILABLE" }).returning();

  const [batch] = await db
    .insert(stockReturnBatches)
    .values({
      documentNo: `SRB-QAH-${s}`,
      sourceLocationId: outletLocationId,
      destinationLocationId: hqLocationId,
      destinationWarehouseId: hqMainWarehouseId,
      status: "RECEIVED_DISPOSED",
    })
    .returning();

  const [batchLine] = await db
    .insert(stockReturnBatchLines)
    .values({
      batchId: batch!.id,
      lineNo: 1,
      itemId,
      lotId: sourceLot!.id,
      sourceWarehouseId: outletStorageWarehouseId,
      quantity: receivedQuantity,
      enteredQuantity: receivedQuantity,
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      reasonCode,
    })
    .returning();

  const [quarantineLot] = await db.insert(inventoryLots).values({ itemId, lotCode: `QAH-QTN-${s}`, unitCost: "10.000000", status: "QUARANTINED" }).returning();
  await db.insert(inventoryLotBalances).values({ warehouseId: quarantineWarehouseId, lotId: quarantineLot!.id, onHand: receivedQuantity });

  const [receiptLine] = await db
    .insert(stockReturnReceiptLines)
    .values({ batchLineId: batchLine!.id, quarantineLotId: quarantineLot!.id, receivedQuantity, dispositionReasonCode: reasonCode })
    .returning();

  return { receiptLine: receiptLine!, quarantineLot: quarantineLot! };
}

function lineBody(receiptLineId: string, overrides: Record<string, unknown> = {}) {
  return { source_return_receipt_line_id: receiptLineId, entered_quantity: "10", entered_uom: "kg", ...overrides };
}

/** Full item + reusable (OTHER-reason) receipt-line fixture for one release test. */
async function fullFixture(receivedQuantity = "10.000000") {
  const itemId = await makeItem();
  const { receiptLine, quarantineLot } = await makeReceiptLine(itemId, { receivedQuantity });
  return { itemId, receiptLineId: receiptLine.id, quarantineLotId: quarantineLot.id };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated
// ---------------------------------------------------------------------------

describe("unauthenticated requests", () => {
  it("GET /qa-releases -> 401", async () => {
    const res = await request(app).get("/api/v1/qa-releases");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("POST /qa-releases -> 401", async () => {
    const res = await request(app).post("/api/v1/qa-releases").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 2. Strict schema — no actor/session smuggling; malformed inputs
// ---------------------------------------------------------------------------

describe("POST /qa-releases strict body + malformed inputs", () => {
  it("rejects a client-supplied actorUserId/sessionId as unknown keys -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ actorUserId: randomUUID(), sessionId: randomUUID(), lines: [lineBody(fx.receiptLineId)] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed source_return_receipt_line_id UUID -> 400", async () => {
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody("not-a-uuid")] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an entered_quantity with more than 6 fraction digits -> 400", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId, { entered_quantity: "1.1234567" })] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array -> 400", async () => {
    const owner = await actor("OWNER");
    const res = await request(app).post("/api/v1/qa-releases").set("Authorization", `Bearer ${owner.token}`).send({ lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 3. Role enforcement (RBAC per policies.ts: QA_RELEASE_ROLES = OWNER, WAREHOUSE_MAIN)
// ---------------------------------------------------------------------------

describe("role enforcement", () => {
  it("403s create from a role outside QA_RELEASE_ROLES", async () => {
    const fx = await fullFixture();
    const outletManager = await actor("OUTLET_MANAGER", hqLocationId);
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${outletManager.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("403s create from WAREHOUSE_OUTLET (allowed on transfers, not on QA release)", async () => {
    const fx = await fullFixture();
    const warehouseOutlet = await actor("WAREHOUSE_OUTLET", hqLocationId);
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${warehouseOutlet.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// 4. Segregation of duties
// ---------------------------------------------------------------------------

describe("segregation of duties", () => {
  it("409s approve() by the same actor who submitted", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const submitRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);

    const approveRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.error.code).toBe("SEGREGATION_OF_DUTIES");
  });
});

// ---------------------------------------------------------------------------
// 5. Release bounded-header contract guard
// ---------------------------------------------------------------------------

describe("POST /qa-releases/:id/release header guard", () => {
  it("400s before any mutation when Idempotency-Key/X-Correlation-ID are missing", async () => {
    await setReturnsEnabled(true);
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    const submitRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    const noHeadersRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/release`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: approveRes.body.version });
    expect(noHeadersRes.status).toBe(400);
    expect(noHeadersRes.body.error.code).toBe("VALIDATION_ERROR");

    const oneHeaderRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/release`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ version: approveRes.body.version });
    expect(oneHeaderRes.status).toBe(400);
    expect(oneHeaderRes.body.error.code).toBe("VALIDATION_ERROR");

    const getRes = await request(app).get(`/api/v1/qa-releases/${createRes.body.id}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("APPROVED");
    expect(getRes.body.version).toBe(approveRes.body.version);
  });
});

// ---------------------------------------------------------------------------
// 6. Full HTTP lifecycle: create -> submit -> approve -> release (idempotent
//    retry), then illegal-transition + stale-version checks.
// ---------------------------------------------------------------------------

describe("full QA release lifecycle over HTTP", () => {
  it("moves a release through every transition and posts stock exactly once on a release retry", async () => {
    await setReturnsEnabled(true);
    const fx = await fullFixture("10.000000");
    const owner = await actor("OWNER"); // creator + submitter + releaser
    const approver = await actor("WAREHOUSE_MAIN"); // distinct actor, maker-checker

    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ remarks: "reusable overstock return", lines: [lineBody(fx.receiptLineId, { entered_quantity: "10" })] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const releaseId = createRes.body.id as string;
    expect(createRes.body.status).toBe("DRAFT");

    const submitRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.body.status).toBe("SUBMITTED");

    const approveRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.body.status).toBe("APPROVED");

    const releaseKey = randomUUID();
    const releaseCorrelation = randomUUID();
    const releaseRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/release`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", releaseKey)
      .set("X-Correlation-ID", releaseCorrelation)
      .send({ version: approveRes.body.version });
    expect(releaseRes.status, JSON.stringify(releaseRes.body)).toBe(200);
    expect(releaseRes.body.status).toBe("RELEASED");

    const [quarantineBalance] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.lotId, fx.quarantineLotId));
    expect(quarantineBalance!.onHand).toBe("0.000000");

    // Retry the exact same release call: replayed, not double-posted.
    const releaseRetryRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/release`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", releaseKey)
      .set("X-Correlation-ID", releaseCorrelation)
      .send({ version: approveRes.body.version });
    expect(releaseRetryRes.status, JSON.stringify(releaseRetryRes.body)).toBe(200);
    expect(releaseRetryRes.body.status).toBe("RELEASED");
    expect(releaseRetryRes.body.id).toBe(releaseId);

    const [quarantineBalanceAfterRetry] = await db
      .select()
      .from(inventoryLotBalances)
      .where(eq(inventoryLotBalances.lotId, fx.quarantineLotId));
    expect(quarantineBalanceAfterRetry!.onHand).toBe("0.000000");

    // Post-release cancel is an illegal transition -> 409.
    const cancelRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: releaseRetryRes.body.version, cancel_reason: "Too late" });
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error.code).toBe("INVALID_TRANSITION");
  });
});

// ---------------------------------------------------------------------------
// 7. GET/list
// ---------------------------------------------------------------------------

describe("GET /qa-releases and /qa-releases/:id", () => {
  it("a QA_RELEASE_ROLES actor can create then GET/list its own release", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const releaseId = createRes.body.id as string;

    const getRes = await request(app).get(`/api/v1/qa-releases/${releaseId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(releaseId);

    const listRes = await request(app).get("/api/v1/qa-releases").set("Authorization", `Bearer ${owner.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((r: { id: string }) => r.id === releaseId)).toBe(true);
    expect(typeof listRes.body.total).toBe("number");
  });

  it("403s GET for a role outside QA_RELEASE_ROLES", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    const outletManager = await actor("OUTLET_MANAGER", hqLocationId);
    const getRes = await request(app)
      .get(`/api/v1/qa-releases/${createRes.body.id}`)
      .set("Authorization", `Bearer ${outletManager.token}`);
    expect(getRes.status).toBe(403);
    expect(getRes.body.error.code).toBe("UNAUTHORIZED");
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
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const releaseId = createRes.body.id as string;
    const staleVersion = (createRes.body.version as number) + 1;

    const submitRes = await request(app)
      .post(`/api/v1/qa-releases/${releaseId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: staleVersion });
    expect(submitRes.status).toBe(409);
    expect(submitRes.body.error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(typeof submitRes.body.error.message).toBe("string");

    const getRes = await request(app).get(`/api/v1/qa-releases/${releaseId}`).set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("DRAFT");
    expect(getRes.body.version).toBe(createRes.body.version);
  });

  it("rejects cancel with a blank reason -> 400 before any service call", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    const cancelRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version, cancel_reason: "" });
    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 9. REASON_NOT_RELEASABLE — disposition-reason stock never reaches HQ_MAIN.
// ---------------------------------------------------------------------------

describe("REASON_NOT_RELEASABLE over HTTP", () => {
  it("400s create for a SPOILED-reason receipt line", async () => {
    const itemId = await makeItem();
    const { receiptLine } = await makeReceiptLine(itemId, { reasonCode: "SPOILED" });
    const owner = await actor("OWNER");
    const res = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(receiptLine.id)] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REASON_NOT_RELEASABLE");
  });
});

// ---------------------------------------------------------------------------
// 10. Flag-gated stock-transition refusal surfaces the service's own status.
// ---------------------------------------------------------------------------

describe("stock.returns dark-mode gate over HTTP (QA release side)", () => {
  it("503s release() while the flag is disabled, with no balance change", async () => {
    const fx = await fullFixture();
    const owner = await actor("OWNER");
    const approver = await actor("WAREHOUSE_MAIN");

    const createRes = await request(app)
      .post("/api/v1/qa-releases")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ lines: [lineBody(fx.receiptLineId)] });
    const submitRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    const approveRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);

    await setReturnsEnabled(false);
    const releaseRes = await request(app)
      .post(`/api/v1/qa-releases/${createRes.body.id}/release`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .set("X-Correlation-ID", randomUUID())
      .send({ version: approveRes.body.version });
    expect(releaseRes.status).toBe(503);
    expect(releaseRes.body.error.code).toBe("FEATURE_DISABLED");

    const [balanceRow] = await db.select().from(inventoryLotBalances).where(eq(inventoryLotBalances.lotId, fx.quarantineLotId));
    expect(balanceRow!.onHand).toBe("10.000000");

    await setReturnsEnabled(true); // restore for subsequent tests in this file
  });
});
