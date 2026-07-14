import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  inventoryLots,
  operationalDocuments,
  operationalFeatureFlags,
  topologyMigrationExceptions,
} from "../src/db/enterprise-schema.js";
import {
  ingredients,
  locations,
  userOutletAccess,
  users,
  userSessions,
  warehouses,
  type Role,
} from "../src/db/schema.js";
import { outletScopeForRole } from "../src/modules/auth/roles.js";
import {
  approveStockReturnBatch,
  cancelStockReturnBatch,
  createStockReturnDraft,
  getStockReturnBatch,
  listStockReturnBatches,
  submitStockReturnBatch,
  updateStockReturnDraft,
} from "../src/modules/stock-returns/service.js";
import type { StockReturnLineInput } from "../src/modules/stock-returns/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;
let hqLocationId: string;
let hqWarehouseId: string;

interface Fixture {
  locationId: string;
  warehouseId: string;
  itemId: string;
  lotId: string;
  actorUserId: string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);

  const [hq] = await db
    .insert(locations)
    .values({ code: "SRHQTEST", name: "Stock Return Test HQ" })
    .returning();
  const [hqWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: hq.id,
      type: "MAIN",
      purpose: "HQ_MAIN",
      code: "WH-SRHQTEST-HQ_MAIN",
      name: "Stock Return Test HQ Main Warehouse",
    })
    .returning();
  hqLocationId = hq.id;
  hqWarehouseId = hqWarehouse.id;

  await db
    .insert(warehouses)
    .values({
      // `type` is the legacy MAIN/KITCHEN identity, distinct from `purpose`
      // (the enterprise identity). Using KITCHEN here just avoids colliding
      // with the HQ_MAIN warehouse's (locationId, type) unique index at the
      // same physical HQ location.
      locationId: hq.id,
      type: "KITCHEN",
      purpose: "QUARANTINE",
      code: "WH-SRHQTEST-QUARANTINE",
      name: "Stock Return Test HQ Quarantine Warehouse",
    })
    .returning();

  await db
    .update(topologyMigrationExceptions)
    .set({ status: "RESOLVED", resolutionNote: "Test HQ configured", resolvedAt: new Date() })
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
});

afterAll(async () => {
  await closeDb(client);
});

async function setReturnsEnabled(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, version: 2, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.returns"));
}

async function fixture(role: Role = "WAREHOUSE_OUTLET"): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `SRL${suffix}`, name: `Return Outlet ${suffix}` })
    .returning();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "MAIN",
      purpose: "OUTLET_STORAGE",
      code: `WH-${suffix}`,
      name: `Outlet Storage ${suffix}`,
    })
    .returning();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `ITEM-${suffix}`,
      name: `Return Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({
      itemId: item.id,
      lotCode: `LOT-${suffix}`,
      status: "AVAILABLE",
      unitCost: "10.000000",
    })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Return Actor ${suffix}`,
      email: `return-${suffix}@test.local`,
      passwordHash: "hash",
      role,
    })
    .returning();
  if (outletScopeForRole(role) !== "ALL") {
    await db.insert(userOutletAccess).values({ userId: actor.id, locationId: location.id });
  }
  return {
    locationId: location.id,
    warehouseId: warehouse.id,
    itemId: item.id,
    lotId: lot.id,
    actorUserId: actor.id,
  };
}

/** A second item+lot pair (items/lots are not outlet-scoped). */
async function extraItemLot(): Promise<{ itemId: string; lotId: string }> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `EX-${suffix}`,
      name: `Extra Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      lotTracked: true,
      unitCost: "5.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [lot] = await db
    .insert(inventoryLots)
    .values({ itemId: item.id, lotCode: `EX-LOT-${suffix}`, status: "AVAILABLE", unitCost: "5.000000" })
    .returning();
  return { itemId: item.id, lotId: lot.id };
}

function lineInput(fx: Fixture, overrides: Partial<StockReturnLineInput> = {}): StockReturnLineInput {
  return {
    itemId: fx.itemId,
    lotId: fx.lotId,
    sourceWarehouseId: fx.warehouseId,
    enteredQuantity: "5",
    enteredUom: "kg",
    reasonCode: "SPOILED",
    ...overrides,
  };
}

describe("stock return batch lifecycle", () => {
  it("creates a DRAFT, submits it (linking dispatch+receipt documents), and approves with a different actor", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const extra1 = await extraItemLot();
    const extra2 = await extraItemLot();

    const created = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [
        lineInput(fx),
        lineInput(fx, { itemId: extra1.itemId, lotId: extra1.lotId }),
        lineInput(fx, { itemId: extra2.itemId, lotId: extra2.lotId }),
      ],
    });
    expect(created).toMatchObject({ status: "DRAFT", version: 1, destinationLocationId: hqLocationId });
    expect(created.lines).toHaveLength(3);

    const submitted = await submitStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: created.id,
      expectedVersion: created.version,
    });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.dispatchDocumentId).toBeTruthy();
    expect(submitted.receiptDocumentId).toBeTruthy();

    const docs = await db
      .select()
      .from(operationalDocuments)
      .where(eq(operationalDocuments.documentNo, created.documentNo));
    expect(docs).toHaveLength(2);
    const dispatchDoc = docs.find((doc) => doc.module === "STOCK_RETURN_DISPATCH");
    const receiptDoc = docs.find((doc) => doc.module === "STOCK_RETURN_RECEIPT");
    expect(dispatchDoc).toMatchObject({ status: "APPROVED", locationId: fx.locationId });
    expect(receiptDoc).toMatchObject({ status: "DISPATCHED", locationId: hqLocationId });

    const approver = await fixture("OWNER");
    const approved = await approveStockReturnBatch(db, {
      actorUserId: approver.actorUserId,
      batchId: created.id,
      expectedVersion: submitted.version,
    });
    expect(approved.status).toBe("APPROVED");

    const fetched = await getStockReturnBatch(db, { actorUserId: approver.actorUserId, batchId: created.id });
    expect(fetched.status).toBe("APPROVED");
    expect(fetched.lines).toHaveLength(3);

    const listed = await listStockReturnBatches(db, {
      actorUserId: approver.actorUserId,
      sourceLocationId: fx.locationId,
    });
    expect(listed.some((batch) => batch.id === created.id)).toBe(true);
  });

  it("rejects create when a line's entered UOM has no matching item unit or active conversion", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx, { enteredUom: "liters" })],
      }),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH" });
  });

  it("rejects a line whose source warehouse belongs to a different outlet", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const other = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx, { sourceWarehouseId: other.warehouseId })],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects create when the HQ_MAIN topology is not ready", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await db.update(warehouses).set({ isActive: false }).where(eq(warehouses.id, hqWarehouseId));
    try {
      await expect(
        createStockReturnDraft(db, {
          actorUserId: fx.actorUserId,
          sourceLocationId: fx.locationId,
          lines: [lineInput(fx)],
        }),
      ).rejects.toMatchObject({ code: "TOPOLOGY_NOT_READY" });
    } finally {
      await db.update(warehouses).set({ isActive: true }).where(eq(warehouses.id, hqWarehouseId));
    }
  });

  it("rejects an inactive actor", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await db.update(users).set({ status: "BLOCKED" }).where(eq(users.id, fx.actorUserId));
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a session id that does not resolve to an active session", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sessionId: randomUUID(),
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const [expiredSession] = await db
      .insert(userSessions)
      .values({ userId: fx.actorUserId, logoutAt: new Date() })
      .returning();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sessionId: expiredSession.id,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an actor role outside STOCK_RETURN_ROLES", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture("KITCHEN_CREW");
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an actor whose outlet access does not cover the batch's source outlet", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const other = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: other.locationId,
        lines: [lineInput(other)],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects approval by the same actor who submitted", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture("OWNER");
    const created = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    const submitted = await submitStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: created.id,
      expectedVersion: created.version,
    });
    await expect(
      approveStockReturnBatch(db, {
        actorUserId: fx.actorUserId,
        batchId: created.id,
        expectedVersion: submitted.version,
      }),
    ).rejects.toMatchObject({ code: "SEGREGATION_OF_DUTIES" });
  });

  it("rejects update and submit calls made with a stale expectedVersion", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const created = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    await expect(
      updateStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        batchId: created.id,
        expectedVersion: created.version + 1,
        remarks: "stale",
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    await expect(
      submitStockReturnBatch(db, {
        actorUserId: fx.actorUserId,
        batchId: created.id,
        expectedVersion: created.version + 1,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("allows cancel from DRAFT and from SUBMITTED, but rejects cancel from APPROVED", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();

    const draft = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    const cancelledDraft = await cancelStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: draft.id,
      expectedVersion: draft.version,
      cancelReason: "created by mistake",
    });
    expect(cancelledDraft.status).toBe("CANCELLED");

    const draft2 = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    const submitted2 = await submitStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: draft2.id,
      expectedVersion: draft2.version,
    });
    const cancelledSubmitted = await cancelStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: draft2.id,
      expectedVersion: submitted2.version,
      cancelReason: "no longer needed",
    });
    expect(cancelledSubmitted.status).toBe("CANCELLED");

    const draft3 = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    const submitted3 = await submitStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: draft3.id,
      expectedVersion: draft3.version,
    });
    const approver = await fixture("OWNER");
    const approved3 = await approveStockReturnBatch(db, {
      actorUserId: approver.actorUserId,
      batchId: draft3.id,
      expectedVersion: submitted3.version,
    });
    await expect(
      cancelStockReturnBatch(db, {
        actorUserId: fx.actorUserId,
        batchId: draft3.id,
        expectedVersion: approved3.version,
        cancelReason: "too late",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("rejects re-submitting an already-SUBMITTED batch and does not duplicate operational documents", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const created = await createStockReturnDraft(db, {
      actorUserId: fx.actorUserId,
      sourceLocationId: fx.locationId,
      lines: [lineInput(fx)],
    });
    const submitted = await submitStockReturnBatch(db, {
      actorUserId: fx.actorUserId,
      batchId: created.id,
      expectedVersion: created.version,
    });
    await expect(
      submitStockReturnBatch(db, {
        actorUserId: fx.actorUserId,
        batchId: created.id,
        expectedVersion: submitted.version,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const docs = await db
      .select()
      .from(operationalDocuments)
      .where(eq(operationalDocuments.documentNo, created.documentNo));
    expect(docs).toHaveLength(2);
  });

  it("rejects duplicate line identity within one create call", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx), lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });
  });

  it("rejects a non-positive line quantity", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx, { enteredQuantity: "0" })],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a lot that does not belong to the line's item", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    const extra = await extraItemLot();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx, { itemId: fx.itemId, lotId: extra.lotId })],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a DISPOSED lot as LOT_NOT_ELIGIBLE", async () => {
    await setReturnsEnabled(true);
    const fx = await fixture();
    await db.update(inventoryLots).set({ status: "DISPOSED" }).where(eq(inventoryLots.id, fx.lotId));
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "LOT_NOT_ELIGIBLE" });
  });

  it("rejects a batch whose source outlet equals the resolved HQ location", async () => {
    await setReturnsEnabled(true);
    const [actor] = await db
      .insert(users)
      .values({
        name: "HQ Actor",
        email: `hq-actor-${randomUUID()}@test.local`,
        passwordHash: "hash",
        role: "OWNER",
      })
      .returning();
    const extra = await extraItemLot();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: actor.id,
        sourceLocationId: hqLocationId,
        lines: [
          {
            itemId: extra.itemId,
            lotId: extra.lotId,
            sourceWarehouseId: randomUUID(),
            enteredQuantity: "1",
            enteredUom: "kg",
            reasonCode: "SPOILED",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects create when the stock.returns feature flag is disabled", async () => {
    await setReturnsEnabled(false);
    const fx = await fixture();
    await expect(
      createStockReturnDraft(db, {
        actorUserId: fx.actorUserId,
        sourceLocationId: fx.locationId,
        lines: [lineInput(fx)],
      }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    await setReturnsEnabled(true);
  });
});
