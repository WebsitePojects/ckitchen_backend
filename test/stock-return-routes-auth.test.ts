/**
 * HTTP-level auth/validation test suite for the Stock Return Batch router
 * (src/modules/stock-returns/routes.ts). Complements the service-level
 * stock-return-lifecycle.test.ts by exercising the router's own
 * requireAuth / zod `.strict()` / bounded-header layers over supertest,
 * instead of calling the service functions directly.
 *
 * Fixture is intentionally minimal: one HQ (HQ_MAIN + QUARANTINE, feature
 * flag enabled) plus small per-test outlet fixtures created on demand.
 * Tokens are minted directly via signToken() (no HTTP login round trip)
 * against a real `users` row, since authorizeActor() in the service looks
 * the actor up by id — a token for a non-existent user would fail service
 * auth for the wrong reason.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, closeDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig } from "../src/config.js";
import { signToken } from "../src/modules/auth/service.js";
import {
  inventoryLotBalances,
  inventoryLots,
  operationalFeatureFlags,
  outboxEvents,
  stockPostingLines,
  stockPostings,
  operationalDocuments,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { stockReturnBatches, stockReturnReceiptLines } from "../src/db/returns-schema.js";
import { auditLogs, ingredients, locations, userOutletAccess, users, warehouses, type Role } from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";

let app: Express;
let db: DB;
let client: ReturnType<typeof createDb>["client"];
let jwtSecret: string;
let sequence = 0;
let hqQuarantineWarehouseId: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  jwtSecret = loadConfig().jwtSecret;
  app = createApp(db);
  await runMigrations(db);

  const [hq] = await db
    .insert(locations)
    .values({ code: "SRATHQ", name: "Stock Return Auth Test HQ" })
    .returning();
  await db.insert(warehouses).values({
    locationId: hq.id,
    type: "MAIN",
    purpose: "HQ_MAIN",
    code: "WH-SRATHQ-HQ_MAIN",
    name: "Stock Return Auth Test HQ Main",
  });
  const [quarantine] = await db
    .insert(warehouses)
    .values({
      locationId: hq.id,
      type: "KITCHEN",
      purpose: "QUARANTINE",
      code: "WH-SRATHQ-QUARANTINE",
      name: "Stock Return Auth Test HQ Quarantine",
    })
    .returning();
  hqQuarantineWarehouseId = quarantine.id;
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Auth test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.returns"));
  // Dispatch/receive-dispose route through the central stock posting service,
  // which independently gates on "stock.lot_writes" (0027) on top of this
  // module's own "stock.returns" flag; the pre-existing fixture only enabled
  // the latter, since the header-guard test above never reaches a real post.
  await db
    .update(operationalFeatureFlags)
    .set({ enabled: true, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
});

afterAll(async () => {
  await closeDb(client);
});

interface OutletActor {
  locationId: string;
  warehouseId: string;
  userId: string;
  token: string;
}

/** Location + OUTLET_STORAGE warehouse + real `users` row + a JWT minted for it. */
async function outletActor(role: Role = "WAREHOUSE_OUTLET"): Promise<OutletActor> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `SRA${suffix}`, name: `Auth Outlet ${suffix}` })
    .returning();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "MAIN",
      purpose: "OUTLET_STORAGE",
      code: `WH-A-${suffix}`,
      name: `Auth Outlet Storage ${suffix}`,
    })
    .returning();
  const [user] = await db
    .insert(users)
    .values({
      name: `Auth Actor ${suffix}`,
      email: `auth-${suffix}@test.local`,
      passwordHash: "hash",
      role,
    })
    .returning();
  const outletIds = outletScopeForRole(role) === "ALL" ? [] : [location.id];
  if (outletScopeForRole(role) !== "ALL") {
    await db.insert(userOutletAccess).values({ userId: user.id, locationId: location.id });
  }
  const token = signToken({ id: user.id, role: user.role, name: user.name }, jwtSecret, { outletIds });
  return { locationId: location.id, warehouseId: warehouse.id, userId: user.id, token };
}

/** A real item + AVAILABLE lot, unscoped by outlet (mirrors stock-return-lifecycle.test.ts). */
async function itemLot(): Promise<{ itemId: string; lotId: string }> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `ITEM-A-${suffix}`,
      name: `Auth Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item.id, lotCode: `LOT-A-${suffix}`, status: "AVAILABLE", unitCost: "10.000000" })
    .returning();
  return { itemId: item.id, lotId: lot.id };
}

/** Same as itemLot(), plus an inventory_lot_balance row so dispatch can actually post an OUT movement. */
async function itemLotWithBalance(warehouseId: string, onHand = "50.000000"): Promise<{ itemId: string; lotId: string }> {
  const il = await itemLot();
  await db.insert(inventoryLotBalances).values({ warehouseId, lotId: il.lotId, onHand, reserved: "0" });
  return il;
}

async function balanceOf(warehouseId: string, lotId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(and(eq(inventoryLotBalances.warehouseId, warehouseId), eq(inventoryLotBalances.lotId, lotId)));
  return row?.onHand;
}

function validLine(overrides: Record<string, unknown> = {}) {
  return {
    item_id: randomUUID(),
    lot_id: randomUUID(),
    source_warehouse_id: randomUUID(),
    entered_quantity: "5",
    entered_uom: "kg",
    reason_code: "SPOILED",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated
// ---------------------------------------------------------------------------

describe("unauthenticated requests", () => {
  it("GET /stock-returns -> 401", async () => {
    const res = await request(app).get("/api/v1/stock-returns");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("POST /stock-returns -> 401", async () => {
    const res = await request(app).post("/api/v1/stock-returns").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 2. Strict schema — no actor/session smuggling
// ---------------------------------------------------------------------------

describe("POST /stock-returns strict body", () => {
  it("rejects a client-supplied actorUserId/sessionId as unknown keys -> 400", async () => {
    const fx = await outletActor();
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({
        source_location_id: fx.locationId,
        actorUserId: randomUUID(),
        sessionId: randomUUID(),
        lines: [validLine()],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed inputs — all rejected by zod before any DB/service call
// ---------------------------------------------------------------------------

describe("POST /stock-returns malformed inputs", () => {
  it("rejects a malformed source_location_id UUID -> 400", async () => {
    const fx = await outletActor();
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({ source_location_id: "not-a-uuid", lines: [validLine()] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an entered_quantity with more than 6 fraction digits -> 400", async () => {
    const fx = await outletActor();
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({
        source_location_id: fx.locationId,
        lines: [validLine({ entered_quantity: "1.1234567" })],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-decimal entered_quantity -> 400", async () => {
    const fx = await outletActor();
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({ source_location_id: fx.locationId, lines: [validLine({ entered_quantity: "abc" })] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty lines array -> 400", async () => {
    const fx = await outletActor();
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({ source_location_id: fx.locationId, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a 251-line batch (STOCK_RETURN_MAX_LINES=250) -> 400", async () => {
    const fx = await outletActor();
    const lines = Array.from({ length: 251 }, () => validLine());
    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${fx.token}`)
      .send({ source_location_id: fx.locationId, lines });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// 4. Outlet scope enforcement on create
// ---------------------------------------------------------------------------

describe("POST /stock-returns outlet scope", () => {
  it("403s when the actor's outlet access does not cover source_location_id, and creates no batch", async () => {
    const actorFx = await outletActor();
    const otherFx = await outletActor();

    const res = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${actorFx.token}`)
      .send({
        source_location_id: otherFx.locationId,
        lines: [validLine({ source_warehouse_id: otherFx.warehouseId })],
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("UNAUTHORIZED");

    const rows = await db
      .select()
      .from(stockReturnBatches)
      .where(eq(stockReturnBatches.sourceLocationId, otherFx.locationId));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Create + read/list scoping
// ---------------------------------------------------------------------------

describe("GET /stock-returns scoping", () => {
  it("a scoped actor can create then GET/list its own batch; a different-outlet actor is denied", async () => {
    const owner = await outletActor();
    const il = await itemLot();

    const createRes = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_location_id: owner.locationId,
        lines: [validLine({ item_id: il.itemId, lot_id: il.lotId, source_warehouse_id: owner.warehouseId })],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const batchId = createRes.body.id as string;

    // Owner can GET it directly.
    const getRes = await request(app)
      .get(`/api/v1/stock-returns/${batchId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(batchId);

    // Owner sees it in their list.
    const listRes = await request(app)
      .get("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((b: { id: string }) => b.id === batchId)).toBe(true);

    // A different-outlet actor is denied direct GET...
    const stranger = await outletActor();
    const strangerGetRes = await request(app)
      .get(`/api/v1/stock-returns/${batchId}`)
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerGetRes.status).toBe(403);
    expect(strangerGetRes.body.error.code).toBe("UNAUTHORIZED");

    // ...and does not see it in their own list.
    const strangerListRes = await request(app)
      .get("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${stranger.token}`);
    expect(strangerListRes.status).toBe(200);
    expect(strangerListRes.body.items.some((b: { id: string }) => b.id === batchId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Dispatch bounded-header contract guard
// ---------------------------------------------------------------------------

describe("POST /stock-returns/:id/dispatch header guard", () => {
  it("400s before any mutation when Idempotency-Key/X-Correlation-ID are missing", async () => {
    const owner = await outletActor();
    const il = await itemLot();

    const createRes = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_location_id: owner.locationId,
        lines: [validLine({ item_id: il.itemId, lot_id: il.lotId, source_warehouse_id: owner.warehouseId })],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const batchId = createRes.body.id as string;
    const version = createRes.body.version as number;

    // Neither header present.
    const noHeadersRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version });
    expect(noHeadersRes.status).toBe(400);
    expect(noHeadersRes.body.error.code).toBe("VALIDATION_ERROR");

    // Only Idempotency-Key present, X-Correlation-ID still missing.
    const oneHeaderRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ version });
    expect(oneHeaderRes.status).toBe(400);
    expect(oneHeaderRes.body.error.code).toBe("VALIDATION_ERROR");

    // No mutation happened: batch is still DRAFT at its original version.
    const getRes = await request(app)
      .get(`/api/v1/stock-returns/${batchId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe("DRAFT");
    expect(getRes.body.version).toBe(version);
  });
});

// ---------------------------------------------------------------------------
// 8. Full HTTP lifecycle: create -> submit -> approve (different actor) ->
//    dispatch -> receive-dispose, with inventory/evidence/audit/outbox checks.
// ---------------------------------------------------------------------------

describe("full stock return lifecycle over HTTP", () => {
  it("moves a batch through every transition, posts stock exactly once, and leaves full evidence", async () => {
    const owner = await outletActor(); // creator + submitter + dispatcher
    const approver = await outletActor("OWNER"); // distinct actor, maker-checker
    const receiver = await outletActor("WAREHOUSE_MAIN"); // HQ-tier, receives/disposes
    const il = await itemLotWithBalance(owner.warehouseId, "50.000000");

    const createRes = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_location_id: owner.locationId,
        lines: [
          validLine({
            item_id: il.itemId,
            lot_id: il.lotId,
            source_warehouse_id: owner.warehouseId,
            entered_quantity: "5",
            reason_code: "SPOILED",
          }),
        ],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const batchId = createRes.body.id as string;
    const documentNo = createRes.body.documentNo as string;
    expect(createRes.body.status).toBe("DRAFT");

    const submitRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: createRes.body.version });
    expect(submitRes.status, JSON.stringify(submitRes.body)).toBe(200);
    expect(submitRes.body.status).toBe("SUBMITTED");

    const approveRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/approve`)
      .set("Authorization", `Bearer ${approver.token}`)
      .send({ version: submitRes.body.version });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);
    expect(approveRes.body.status).toBe("APPROVED");
    const preDispatchVersion = approveRes.body.version as number;

    const dispatchKey = randomUUID();
    const dispatchCorrelation = randomUUID();
    const dispatchRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", dispatchKey)
      .set("X-Correlation-ID", dispatchCorrelation)
      .send({ version: preDispatchVersion });
    expect(dispatchRes.status, JSON.stringify(dispatchRes.body)).toBe(200);
    expect(dispatchRes.body.status).toBe("DISPATCHED");

    // Source balance decreased by exactly the dispatched quantity.
    expect(await balanceOf(owner.warehouseId, il.lotId)).toBe("45.000000");

    // -----------------------------------------------------------------------
    // Retry the exact same dispatch call immediately (same headers, same
    // body), before receive-dispose: replayed, not double-posted.
    // -----------------------------------------------------------------------
    const dispatchRetryRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", dispatchKey)
      .set("X-Correlation-ID", dispatchCorrelation)
      .send({ version: preDispatchVersion });
    expect(dispatchRetryRes.status, JSON.stringify(dispatchRetryRes.body)).toBe(200);
    expect(dispatchRetryRes.body.status).toBe("DISPATCHED");
    expect(dispatchRetryRes.body.id).toBe(batchId);

    expect(
      await db.select().from(stockPostings).where(eq(stockPostings.sourceDocumentNo, `${documentNo}:DISPATCH`)),
    ).toHaveLength(1);
    expect(await balanceOf(owner.warehouseId, il.lotId)).toBe("45.000000");
    expect(
      await db
        .select()
        .from(operationalDocuments)
        .where(
          and(
            eq(operationalDocuments.module, "STOCK_RETURN_DISPATCH"),
            eq(operationalDocuments.documentNo, `${documentNo}:DISPATCH`),
          ),
        ),
    ).toHaveLength(1);

    const batchLineId = dispatchRes.body.lines[0].id as string;
    const preReceiveVersion = dispatchRes.body.version as number;

    const receiveKey = randomUUID();
    const receiveCorrelation = randomUUID();
    const receiveRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/receive-dispose`)
      .set("Authorization", `Bearer ${receiver.token}`)
      .set("Idempotency-Key", receiveKey)
      .set("X-Correlation-ID", receiveCorrelation)
      .send({
        version: preReceiveVersion,
        receipt_lines: [
          { batch_line_id: batchLineId, disposition_reason_code: "DAMAGED", disposition_remarks: "Disposed at HQ" },
        ],
      });
    expect(receiveRes.status, JSON.stringify(receiveRes.body)).toBe(200);
    expect(receiveRes.body.status).toBe("RECEIVED_DISPOSED");

    // Dispatch-time reason (SPOILED) and disposition-time reason (DAMAGED) are independent.
    expect(receiveRes.body.lines[0].reasonCode).toBe("SPOILED");

    const qLotCode = `RETURN:${batchId}:${receiveRes.body.lines[0].lineNo}`;
    const [qLot] = await db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.itemId, il.itemId), eq(inventoryLots.lotCode, qLotCode)));
    expect(qLot).toBeTruthy();
    expect(qLot!.status).toBe("QUARANTINED");
    // Quarantine balance ends exactly zero: quarantine IN, then disposition OUT, same qty.
    expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("0.000000");

    const [receiptRow] = await db
      .select()
      .from(stockReturnReceiptLines)
      .where(eq(stockReturnReceiptLines.batchLineId, batchLineId));
    expect(receiptRow).toBeTruthy();
    expect(receiptRow!.dispositionReasonCode).toBe("DAMAGED");
    expect(receiptRow!.quarantineInPostingLineId).toBeTruthy();
    expect(receiptRow!.dispositionOutPostingLineId).toBeTruthy();
    expect(receiptRow!.quarantineInPostingLineId).not.toBe(receiptRow!.dispositionOutPostingLineId);

    const dispatchPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${documentNo}:DISPATCH`));
    expect(dispatchPostings).toHaveLength(1);
    const receiptPostings = await db
      .select()
      .from(stockPostings)
      .where(eq(stockPostings.sourceDocumentNo, `${documentNo}:RECEIPT`));
    expect(receiptPostings).toHaveLength(1);

    const auditRows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, batchId));
    const auditActions = auditRows.map((row) => row.action);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        "stock_return.created",
        "stock_return.submitted",
        "stock_return.approved",
        "stock_return.dispatched",
        "stock_return.received_disposed",
      ]),
    );

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, "stock.posting.completed"),
          eq(outboxEvents.aggregateType, "stock_posting"),
        ),
      );
    const outboxCorrelationIds = outboxRows.map((row) => row.correlationId);
    expect(outboxCorrelationIds).toEqual(
      expect.arrayContaining([`${documentNo}:DISPATCH`, `${documentNo}:RECEIPT`]),
    );

    // -----------------------------------------------------------------------
    // Retry the exact same receive-dispose call immediately (same headers,
    // same body): replayed, not double-posted/double-evidenced.
    // -----------------------------------------------------------------------
    const receiveRetryRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/receive-dispose`)
      .set("Authorization", `Bearer ${receiver.token}`)
      .set("Idempotency-Key", receiveKey)
      .set("X-Correlation-ID", receiveCorrelation)
      .send({
        version: preReceiveVersion,
        receipt_lines: [
          { batch_line_id: batchLineId, disposition_reason_code: "DAMAGED", disposition_remarks: "Disposed at HQ" },
        ],
      });
    expect(receiveRetryRes.status, JSON.stringify(receiveRetryRes.body)).toBe(200);
    expect(receiveRetryRes.body.status).toBe("RECEIVED_DISPOSED");
    expect(receiveRetryRes.body.id).toBe(batchId);

    expect(
      await db.select().from(stockPostings).where(eq(stockPostings.sourceDocumentNo, `${documentNo}:RECEIPT`)),
    ).toHaveLength(1);
    expect(
      await db.select().from(stockReturnReceiptLines).where(eq(stockReturnReceiptLines.batchLineId, batchLineId)),
    ).toHaveLength(1);
    expect(await balanceOf(hqQuarantineWarehouseId, qLot!.id)).toBe("0.000000");

    // -----------------------------------------------------------------------
    // After RECEIVED_DISPOSED, a new/stale dispatch command is an illegal
    // transition -> 409 INVALID_TRANSITION (fresh idempotency key, so this
    // is a real transition check, not an idempotent replay).
    // -----------------------------------------------------------------------
    const postDisposeDispatchRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .set("X-Correlation-ID", randomUUID())
      .send({ version: receiveRetryRes.body.version });
    expect(postDisposeDispatchRes.status).toBe(409);
    expect(postDisposeDispatchRes.body.error).toMatchObject({ code: "INVALID_TRANSITION" });
  });
});

// ---------------------------------------------------------------------------
// 9. Illegal transition and stale-version 409s: stable error envelope.
// ---------------------------------------------------------------------------

describe("409 stable envelope: illegal transition and stale version", () => {
  it("dispatching a DRAFT batch (never submitted/approved) is an illegal transition -> 409", async () => {
    const owner = await outletActor();
    const il = await itemLotWithBalance(owner.warehouseId);

    const createRes = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_location_id: owner.locationId,
        lines: [validLine({ item_id: il.itemId, lot_id: il.lotId, source_warehouse_id: owner.warehouseId })],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const batchId = createRes.body.id as string;

    const dispatchRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/dispatch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .set("Idempotency-Key", randomUUID())
      .set("X-Correlation-ID", randomUUID())
      .send({ version: createRes.body.version });
    expect(dispatchRes.status).toBe(409);
    expect(dispatchRes.body.error).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(typeof dispatchRes.body.error.message).toBe("string");
  });

  it("submitting with a stale version -> 409 CONCURRENT_MODIFICATION", async () => {
    const owner = await outletActor();
    const il = await itemLotWithBalance(owner.warehouseId);

    const createRes = await request(app)
      .post("/api/v1/stock-returns")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        source_location_id: owner.locationId,
        lines: [validLine({ item_id: il.itemId, lot_id: il.lotId, source_warehouse_id: owner.warehouseId })],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const batchId = createRes.body.id as string;
    const staleVersion = (createRes.body.version as number) + 1;

    const submitRes = await request(app)
      .post(`/api/v1/stock-returns/${batchId}/submit`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ version: staleVersion });
    expect(submitRes.status).toBe(409);
    expect(submitRes.body.error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(typeof submitRes.body.error.message).toBe("string");

    // Confirm the 409 was truly a no-op: batch is still DRAFT at its original version.
    const getRes = await request(app)
      .get(`/api/v1/stock-returns/${batchId}`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(getRes.body.status).toBe("DRAFT");
    expect(getRes.body.version).toBe(createRes.body.version);
  });
});
