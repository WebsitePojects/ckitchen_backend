import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import {
  inventoryLotBalances,
  inventoryLots,
  itemUomConversions,
  operationalDocuments,
  operationalFeatureFlags,
  outboxEvents,
  stockPostingLines,
  stockPostings,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  auditLogs,
  ingredients,
  inventoryStock,
  locations,
  userOutletAccess,
  users,
  warehouses,
} from "../src/db/schema.js";
import { StockPostingError } from "../src/modules/stock/errors.js";
import { createStockPostingService } from "../src/modules/stock/posting-service.js";
import { runInventoryReconciliation } from "../src/modules/stock/reconciliation-service.js";
import type { StockPostingInput } from "../src/modules/stock/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  locationId: string;
  actorUserId: string;
  itemId: string;
  warehouseId: string;
  lotId: string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
  const [hq] = await db
    .insert(locations)
    .values({ code: "HQTEST", name: "Test HQ" })
    .returning();
  await db.insert(warehouses).values({
    locationId: hq.id,
    type: "MAIN",
    purpose: "HQ_MAIN",
    code: "WH-HQTEST-HQ_MAIN",
    name: "Test HQ Main Warehouse",
  });
  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

async function setPostingEnabled(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
}

async function fixture(
  onHand = "100.000000",
  status: "AVAILABLE" | "QUARANTINED" = "AVAILABLE",
  purpose: "OUTLET_STORAGE" | "QUARANTINE" = "OUTLET_STORAGE",
): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `ES${sequence}${suffix.slice(-2)}`, name: `Enterprise Stock ${suffix}` })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Stock Actor ${suffix}`,
      email: `stock-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `ITEM-${suffix}`,
      name: `Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "125.0000",
      lowStockThreshold: "5.0000",
    })
    .returning();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "MAIN",
      purpose,
      code: `WH-${suffix}`,
      name: `Warehouse ${suffix}`,
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId: item.id,
      lotCode: `LOT-${suffix}`,
      status,
      unitCost: "125.000000",
    })
    .returning();
  await db.insert(inventoryLotBalances).values({
    warehouseId: warehouse.id,
    lotId: lot.id,
    onHand,
    reserved: "0",
  });
  return {
    locationId: location.id,
    actorUserId: actor.id,
    itemId: item.id,
    warehouseId: warehouse.id,
    lotId: lot.id,
  };
}

function posting(fx: Fixture, patch: Partial<StockPostingInput> = {}): StockPostingInput {
  const id = randomUUID();
  return {
    idempotencyKey: `TEST:${id}`,
    sourceModule: "TEST",
    sourceDocumentNo: `DOC-${id}`,
    locationId: fx.locationId,
    actorUserId: fx.actorUserId,
    correlationId: `corr-${id}`,
    movements: [
      {
        warehouseId: fx.warehouseId,
        itemId: fx.itemId,
        lotId: fx.lotId,
        movementType: "OUT",
        quantity: "25",
        enteredUom: "kg",
        sourcePolicy: "ALLOCATABLE",
      },
    ],
    ...patch,
  };
}

const documentPolicies = {
  TEST: {
    routeClass: "ADJUSTMENT",
    allowedRoles: ["OWNER", "WAREHOUSE_OUTLET"],
    fromStatuses: ["APPROVED"],
    nextStatus: "POSTED",
  },
  TEST_DISPOSITION: {
    routeClass: "RETURN_DISPOSITION",
    allowedRoles: ["OWNER"],
    fromStatuses: ["APPROVED"],
    nextStatus: "RECEIVED_DISPOSED",
  },
  TEST_INTERNAL_TRANSFER: {
    routeClass: "INTERNAL_TRANSFER",
    allowedRoles: ["OWNER", "WAREHOUSE_OUTLET"],
    fromStatuses: ["APPROVED"],
    nextStatus: "POSTED",
  },
} as const;

async function registerDocument(input: StockPostingInput, status = "APPROVED"): Promise<void> {
  await db.insert(operationalDocuments).values({
    module: input.sourceModule,
    documentNo: input.sourceDocumentNo,
    locationId: input.locationId,
    status,
    createdBy: input.actorUserId,
  });
}

function stockService(
  extras: Partial<Parameters<typeof createStockPostingService>[1]> = {},
) {
  return createStockPostingService(db, {
    documentPolicies,
    ...extras,
  });
}

async function balanceOf(fx: Fixture): Promise<string> {
  const [row] = await db
    .select()
    .from(inventoryLotBalances)
    .where(
      and(
        eq(inventoryLotBalances.warehouseId, fx.warehouseId),
        eq(inventoryLotBalances.lotId, fx.lotId),
      ),
    );
  return row.onHand;
}

describe("enterprise stock posting foundation", () => {
  it("keeps stock posting dark until the database feature flag is enabled", async () => {
    const fx = await fixture();
    await setPostingEnabled(false);
    const input = posting(fx);
    await registerDocument(input);
    await expect(stockService().post(input)).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
      status: 503,
    });
    expect(await balanceOf(fx)).toBe("100.000000");
    expect(
      await db.select().from(stockPostings).where(eq(stockPostings.idempotencyKey, input.idempotencyKey)),
    ).toHaveLength(0);
  });

  it("posts ledger, balance, audit, and outbox once and replays the stored result", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const input = posting(fx);
    await registerDocument(input);
    const service = stockService();

    const first = await service.post(input);
    expect(first.replayed).toBe(false);
    expect(first.lines[0]).toMatchObject({ balanceBefore: "100.000000", balanceAfter: "75.000000" });
    expect(await balanceOf(fx)).toBe("75.000000");

    const replay = await service.post(input);
    expect(replay.replayed).toBe(true);
    expect(replay.postingId).toBe(first.postingId);
    expect(await balanceOf(fx)).toBe("75.000000");
    expect(await db.select().from(stockPostingLines).where(eq(stockPostingLines.postingId, first.postingId))).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.postingId, first.postingId))).toHaveLength(1);
    expect(await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, first.postingId))).toHaveLength(1);
    const [document] = await db
      .select()
      .from(operationalDocuments)
      .where(
        and(
          eq(operationalDocuments.module, input.sourceModule),
          eq(operationalDocuments.documentNo, input.sourceDocumentNo),
        ),
      );
    expect(document).toMatchObject({ status: "POSTED", stockPostingId: first.postingId, version: 2 });
  });

  it("rejects reuse of an idempotency key with a different canonical plan", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const input = posting(fx);
    await registerDocument(input);
    const service = stockService();
    await service.post(input);

    const changed = {
      ...input,
      movements: [{ ...input.movements[0]!, quantity: "20" }],
    };
    await expect(service.post(changed)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    expect(await balanceOf(fx)).toBe("75.000000");
  });

  it("rolls back posting header and ledger when failure is injected after ledger insertion", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const input = posting(fx);
    await registerDocument(input);
    const lineCountBefore = (await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length;
    const service = stockService({
      faultInjector(stage) {
        if (stage === "after_ledger") throw new Error("injected-after-ledger");
      },
    });
    await expect(service.post(input)).rejects.toThrow("injected-after-ledger");
    expect(await balanceOf(fx)).toBe("100.000000");
    expect(
      await db.select().from(stockPostings).where(eq(stockPostings.idempotencyKey, input.idempotencyKey)),
    ).toHaveLength(0);
    expect((await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length).toBe(
      lineCountBefore,
    );
  });

  it("supports atomic quarantine IN then disposition OUT without making stock available", async () => {
    await setPostingEnabled(true);
    const fx = await fixture("0", "QUARANTINED", "QUARANTINE");
    const input = posting(fx, {
      sourceModule: "TEST_DISPOSITION",
      movements: [
        {
          warehouseId: fx.warehouseId,
          itemId: fx.itemId,
          lotId: fx.lotId,
          movementType: "OUT",
          quantity: "10",
          enteredUom: "kg",
          sourcePolicy: "DISPOSITION",
          reasonCode: "DISPOSITION_SPOILAGE",
        },
        {
          warehouseId: fx.warehouseId,
          itemId: fx.itemId,
          lotId: fx.lotId,
          movementType: "IN",
          quantity: "10",
          enteredUom: "kg",
          reasonCode: "RETURN_RECEIPT",
        },
      ],
    });
    await registerDocument(input);
    const result = await stockService().post(input);
    expect(result.lines.map((line) => line.movementType)).toEqual(["IN", "OUT"]);
    expect(result.lines[0]).toMatchObject({ balanceBefore: "0.000000", balanceAfter: "10.000000" });
    expect(result.lines[1]).toMatchObject({ balanceBefore: "10.000000", balanceAfter: "0.000000" });
    expect(await balanceOf(fx)).toBe("0.000000");
  });

  it("allows only one of two concurrent overdraw attempts to commit", async () => {
    await setPostingEnabled(true);
    const fx = await fixture("100");
    const service = stockService();
    const first = posting(fx, { movements: [{ ...posting(fx).movements[0]!, quantity: "80" }] });
    const second = posting(fx, { movements: [{ ...posting(fx).movements[0]!, quantity: "80" }] });
    await registerDocument(first);
    await registerDocument(second);

    const settled = await Promise.allSettled([service.post(first), service.post(second)]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toBeTruthy();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(StockPostingError);
    expect((rejected as PromiseRejectedResult).reason.code).toBe("INSUFFICIENT_STOCK");
    expect(await balanceOf(fx)).toBe("20.000000");
  });

  it("aggregates identical movement lines into one deterministic ledger line", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const base = posting(fx).movements[0]!;
    const input = posting(fx, {
      movements: [
        { ...base, quantity: "10", enteredQuantity: "10" },
        { ...base, quantity: "10.000000", enteredQuantity: "10.000000" },
      ],
    });
    await registerDocument(input);
    const result = await stockService().post(input);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ quantity: "20.000000", balanceAfter: "80.000000" });
  });

  it("rejects a base quantity that does not match the approved UOM conversion", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    await db.insert(itemUomConversions).values({
      itemId: fx.itemId,
      fromUom: "g",
      toBaseFactor: "0.001",
    });
    const input = posting(fx, {
      movements: [
        {
          warehouseId: fx.warehouseId,
          itemId: fx.itemId,
          lotId: fx.lotId,
          movementType: "OUT",
          quantity: "2",
          enteredQuantity: "1000",
          enteredUom: "g",
          conversionFactor: "0.001",
          sourcePolicy: "ALLOCATABLE",
        },
      ],
    });
    await registerDocument(input);
    await expect(stockService().post(input)).rejects.toMatchObject({ code: "UOM_MISMATCH" });
    expect(await balanceOf(fx)).toBe("100.000000");
  });

  it("rejects an actor whose outlet membership does not cover the stock document", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const [otherLocation] = await db
      .insert(locations)
      .values({ code: `OTHER-${sequence}`, name: "Other Outlet" })
      .returning();
    const [scopedUser] = await db
      .insert(users)
      .values({
        name: "Scoped Warehouse User",
        email: `scoped-${randomUUID()}@test.local`,
        passwordHash: "hash",
        role: "WAREHOUSE_OUTLET",
      })
      .returning();
    await db.insert(userOutletAccess).values({ userId: scopedUser.id, locationId: otherLocation.id });
    const input = posting(fx, { actorUserId: scopedUser.id });
    await registerDocument(input);
    await expect(stockService().post(input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 403,
    });
    expect(await balanceOf(fx)).toBe("100.000000");
  });

  it("rejects an ALL-scope actor's internal transfer that spans two physical outlets", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const [otherLocation] = await db
      .insert(locations)
      .values({ code: `IT-${sequence}`, name: `Internal Transfer Other ${sequence}` })
      .returning();
    const [otherWarehouse] = await db
      .insert(warehouses)
      .values({
        locationId: otherLocation.id,
        type: "MAIN",
        purpose: "KITCHEN",
        code: `WH-IT-${sequence}`,
        name: `Kitchen ${sequence}`,
      })
      .returning();
    const input = posting(fx, {
      sourceModule: "TEST_INTERNAL_TRANSFER",
      movements: [
        {
          warehouseId: fx.warehouseId,
          itemId: fx.itemId,
          lotId: fx.lotId,
          movementType: "OUT",
          quantity: "10",
          enteredUom: "kg",
          sourcePolicy: "CUSTODY_MOVE",
        },
        {
          warehouseId: otherWarehouse.id,
          itemId: fx.itemId,
          lotId: fx.lotId,
          movementType: "IN",
          quantity: "10",
          enteredUom: "kg",
        },
      ],
    });
    await registerDocument(input);
    const postingCountBefore = (await db.select({ id: stockPostings.id }).from(stockPostings)).length;
    const lineCountBefore = (await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length;
    const auditCountBefore = (await db.select({ id: auditLogs.id }).from(auditLogs)).length;
    const outboxCountBefore = (await db.select({ id: outboxEvents.id }).from(outboxEvents)).length;

    await expect(stockService().post(input)).rejects.toMatchObject({
      code: "FORBIDDEN_ROUTE",
      status: 409,
    });

    expect(await balanceOf(fx)).toBe("100.000000");
    expect((await db.select({ id: stockPostings.id }).from(stockPostings)).length).toBe(postingCountBefore);
    expect((await db.select({ id: stockPostingLines.id }).from(stockPostingLines)).length).toBe(
      lineCountBefore,
    );
    expect((await db.select({ id: auditLogs.id }).from(auditLogs)).length).toBe(auditCountBefore);
    expect((await db.select({ id: outboxEvents.id }).from(outboxEvents)).length).toBe(outboxCountBefore);
    const [document] = await db
      .select()
      .from(operationalDocuments)
      .where(
        and(
          eq(operationalDocuments.module, input.sourceModule),
          eq(operationalDocuments.documentNo, input.sourceDocumentNo),
        ),
      );
    expect(document).toMatchObject({ status: "APPROVED", version: 1, stockPostingId: null });
  });

  it("rejects an invalid document transition without claiming a posting", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const input = posting(fx);
    await registerDocument(input, "DRAFT");
    await expect(stockService().post(input)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await balanceOf(fx)).toBe("100.000000");
    expect(
      await db.select().from(stockPostings).where(eq(stockPostings.idempotencyKey, input.idempotencyKey)),
    ).toHaveLength(0);
  });

  it.each(["after_balance", "after_document", "after_audit", "after_outbox"] as const)(
    "rolls back balance, document, audit, and outbox when failure occurs %s",
    async (failureStage) => {
      await setPostingEnabled(true);
      const fx = await fixture();
      const input = posting(fx);
      await registerDocument(input);
      const auditCount = (await db.select({ id: auditLogs.id }).from(auditLogs)).length;
      const outboxCount = (await db.select({ id: outboxEvents.id }).from(outboxEvents)).length;
      const service = stockService({
        faultInjector(stage) {
          if (stage === failureStage) throw new Error(`injected-${failureStage}`);
        },
      });
      await expect(service.post(input)).rejects.toThrow(`injected-${failureStage}`);
      expect(await balanceOf(fx)).toBe("100.000000");
      const [document] = await db
        .select()
        .from(operationalDocuments)
        .where(
          and(
            eq(operationalDocuments.module, input.sourceModule),
            eq(operationalDocuments.documentNo, input.sourceDocumentNo),
          ),
        );
      expect(document).toMatchObject({ status: "APPROVED", version: 1, stockPostingId: null });
      expect((await db.select({ id: auditLogs.id }).from(auditLogs)).length).toBe(auditCount);
      expect((await db.select({ id: outboxEvents.id }).from(outboxEvents)).length).toBe(outboxCount);
    },
  );

  it("locks multi-item plans deterministically even when callers submit reverse line order", async () => {
    await setPostingEnabled(true);
    const fx = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const [secondItem] = await db
      .insert(ingredients)
      .values({
        code: `SECOND-${suffix}`,
        name: `Second ${suffix}`,
        unit: "kg",
        itemType: "RAW",
        lotTracked: true,
        unitCost: "1",
        lowStockThreshold: "0",
      })
      .returning();
    const [secondLot] = await db
      .insert(inventoryLots)
      .values({ itemId: secondItem.id, lotCode: `SECOND-LOT-${suffix}`, unitCost: "1" })
      .returning();
    await db.insert(inventoryLotBalances).values({
      warehouseId: fx.warehouseId,
      lotId: secondLot.id,
      onHand: "100",
    });
    const lineA = posting(fx).movements[0]!;
    const lineB = {
      ...lineA,
      itemId: secondItem.id,
      lotId: secondLot.id,
    };
    const first = posting(fx, { movements: [{ ...lineA, quantity: "10" }, { ...lineB, quantity: "10" }] });
    const second = posting(fx, { movements: [{ ...lineB, quantity: "10" }, { ...lineA, quantity: "10" }] });
    await registerDocument(first);
    await registerDocument(second);
    const results = await Promise.all([stockService().post(first), stockService().post(second)]);
    expect(results).toHaveLength(2);
    expect(await balanceOf(fx)).toBe("80.000000");
    const [secondBalance] = await db
      .select()
      .from(inventoryLotBalances)
      .where(
        and(
          eq(inventoryLotBalances.warehouseId, fx.warehouseId),
          eq(inventoryLotBalances.lotId, secondLot.id),
        ),
      );
    expect(secondBalance.onHand).toBe("80.000000");
  });

  it("records reconciliation drift and atomically disables future posting", async () => {
    await setPostingEnabled(true);
    const fx = await fixture("100");
    await db.insert(inventoryStock).values({
      warehouseId: fx.warehouseId,
      ingredientId: fx.itemId,
      quantity: "100",
    });
    const passed = await runInventoryReconciliation(db, {
      actorUserId: fx.actorUserId,
      correlationId: `reconcile-pass-${randomUUID()}`,
      warehouseId: fx.warehouseId,
    });
    expect(passed).toMatchObject({ status: "PASSED", postingDisabled: false, drift: [] });

    await db
      .update(inventoryLotBalances)
      .set({ onHand: "99", version: 2 })
      .where(
        and(
          eq(inventoryLotBalances.warehouseId, fx.warehouseId),
          eq(inventoryLotBalances.lotId, fx.lotId),
        ),
      );
    const drifted = await runInventoryReconciliation(db, {
      actorUserId: fx.actorUserId,
      correlationId: `reconcile-drift-${randomUUID()}`,
      warehouseId: fx.warehouseId,
    });
    expect(drifted.status).toBe("DRIFT_DETECTED");
    expect(drifted.postingDisabled).toBe(true);
    expect(drifted.drift).toHaveLength(1);
    const [flag] = await db
      .select()
      .from(operationalFeatureFlags)
      .where(eq(operationalFeatureFlags.key, "stock.lot_writes"));
    expect(flag.enabled).toBe(false);
  });
});
