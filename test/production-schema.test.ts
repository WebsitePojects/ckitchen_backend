import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { inventoryLots, operationalDocuments, stockPostingLines, stockPostings } from "../src/db/enterprise-schema.js";
import { ingredients, locations, users, warehouses } from "../src/db/schema.js";
import {
  bomComponents,
  bomHeaders,
  bomVersions,
  jobOrderComponentAllocations,
  jobOrderOutputLots,
  jobOrders,
} from "../src/db/production-schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  locationId: string;
  actorUserId: string;
  outputItemId: string;
  componentItemId: string;
  otherComponentItemId: string;
  nonPostableItemId: string;
  productionWarehouseId: string;
  nonProductionWarehouseId: string;
  componentLotId: string;
  outputLotId: string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

async function fixture(): Promise<Fixture> {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 6)}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `PSL${suffix}`, name: `Production Location ${suffix}` })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `Production Actor ${suffix}`,
      email: `production-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [outputItem] = await db
    .insert(ingredients)
    .values({
      code: `PS-OUT-${suffix}`,
      name: `Output Item ${suffix}`,
      unit: "kg",
      itemType: "FINISHED_GOOD",
      unitCost: "10.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [componentItem] = await db
    .insert(ingredients)
    .values({
      code: `PS-COMP-${suffix}`,
      name: `Component Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      unitCost: "5.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [otherComponentItem] = await db
    .insert(ingredients)
    .values({
      code: `PS-COMP2-${suffix}`,
      name: `Other Component Item ${suffix}`,
      unit: "kg",
      itemType: "RAW",
      unitCost: "5.0000",
      lowStockThreshold: "1.0000",
    })
    .returning();
  const [nonPostableItem] = await db
    .insert(ingredients)
    .values({
      code: `PS-NP-${suffix}`,
      name: `Non Postable Item ${suffix}`,
      unit: "kg",
      itemType: "SERVICE",
      unitCost: "0.0000",
      lowStockThreshold: "0.0000",
    })
    .returning();
  const [productionWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "MAIN",
      purpose: "PRODUCTION",
      code: `WH-PSP-${suffix}`,
      name: `Production Warehouse ${suffix}`,
    })
    .returning();
  const [nonProductionWarehouse] = await db
    .insert(warehouses)
    .values({
      locationId: location.id,
      type: "KITCHEN",
      purpose: "KITCHEN",
      code: `WH-PSK-${suffix}`,
      name: `Kitchen Warehouse ${suffix}`,
    })
    .returning();
  const [componentLot] = await db
    .insert(inventoryLots)
    .values({ itemId: componentItem.id, lotCode: `PS-CLOT-${suffix}`, unitCost: "5.000000" })
    .returning();
  const [outputLot] = await db
    .insert(inventoryLots)
    .values({ itemId: outputItem.id, lotCode: `PS-OLOT-${suffix}`, unitCost: "10.000000" })
    .returning();
  return {
    locationId: location.id,
    actorUserId: actor.id,
    outputItemId: outputItem.id,
    componentItemId: componentItem.id,
    otherComponentItemId: otherComponentItem.id,
    nonPostableItemId: nonPostableItem.id,
    productionWarehouseId: productionWarehouse.id,
    nonProductionWarehouseId: nonProductionWarehouse.id,
    componentLotId: componentLot.id,
    outputLotId: outputLot.id,
  };
}

function headerValues(fx: Fixture, overrides: Partial<typeof bomHeaders.$inferInsert> = {}) {
  return {
    code: `BOM-${randomUUID()}`,
    name: `BOM ${randomUUID()}`,
    outputItemId: fx.outputItemId,
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertHeader(fx: Fixture, overrides: Partial<typeof bomHeaders.$inferInsert> = {}) {
  const [header] = await db.insert(bomHeaders).values(headerValues(fx, overrides)).returning();
  return header;
}

function versionValues(
  fx: Fixture,
  headerId: string,
  overrides: Partial<typeof bomVersions.$inferInsert> = {},
) {
  return {
    bomHeaderId: headerId,
    versionNo: 1,
    outputUom: "kg",
    outputYieldQty: "10.000000",
    effectiveFrom: "2026-01-01",
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertVersion(
  fx: Fixture,
  headerId: string,
  overrides: Partial<typeof bomVersions.$inferInsert> = {},
) {
  const [version] = await db.insert(bomVersions).values(versionValues(fx, headerId, overrides)).returning();
  return version;
}

function componentValues(
  versionId: string,
  itemId: string,
  overrides: Partial<typeof bomComponents.$inferInsert> = {},
) {
  return {
    bomVersionId: versionId,
    lineNo: 1,
    componentItemId: itemId,
    componentUom: "kg",
    baseQuantity: "2.000000",
    ...overrides,
  };
}

async function insertComponent(
  versionId: string,
  itemId: string,
  overrides: Partial<typeof bomComponents.$inferInsert> = {},
) {
  const [component] = await db
    .insert(bomComponents)
    .values(componentValues(versionId, itemId, overrides))
    .returning();
  return component;
}

function jobOrderValues(
  fx: Fixture,
  bomHeaderId: string,
  bomVersionId: string,
  overrides: Partial<typeof jobOrders.$inferInsert> = {},
) {
  return {
    jobOrderNo: `JO-${randomUUID()}`,
    bomHeaderId,
    bomVersionId,
    locationId: fx.locationId,
    productionWarehouseId: fx.productionWarehouseId,
    plannedOutputQty: "10.000000",
    outputUom: "kg",
    createdBy: fx.actorUserId,
    ...overrides,
  };
}

async function insertJobOrder(
  fx: Fixture,
  bomHeaderId: string,
  bomVersionId: string,
  overrides: Partial<typeof jobOrders.$inferInsert> = {},
) {
  const [jobOrder] = await db
    .insert(jobOrders)
    .values(jobOrderValues(fx, bomHeaderId, bomVersionId, overrides))
    .returning();
  return jobOrder;
}

function allocationValues(
  fx: Fixture,
  jobOrderId: string,
  overrides: Partial<typeof jobOrderComponentAllocations.$inferInsert> = {},
) {
  return {
    jobOrderId,
    lineNo: 1,
    componentItemId: fx.componentItemId,
    sourceLotId: fx.componentLotId,
    sourceWarehouseId: fx.productionWarehouseId,
    plannedQuantity: "2.000000",
    enteredUom: "kg",
    conversionFactor: "1.00000000",
    ...overrides,
  };
}

async function insertAllocation(
  fx: Fixture,
  jobOrderId: string,
  overrides: Partial<typeof jobOrderComponentAllocations.$inferInsert> = {},
) {
  const [allocation] = await db
    .insert(jobOrderComponentAllocations)
    .values(allocationValues(fx, jobOrderId, overrides))
    .returning();
  return allocation;
}

function outputLotLineValues(
  fx: Fixture,
  jobOrderId: string,
  overrides: Partial<typeof jobOrderOutputLots.$inferInsert> = {},
) {
  return {
    jobOrderId,
    outputLotId: fx.outputLotId,
    quantity: "10.000000",
    ...overrides,
  };
}

async function insertOutputLot(
  fx: Fixture,
  jobOrderId: string,
  overrides: Partial<typeof jobOrderOutputLots.$inferInsert> = {},
) {
  const [outputLot] = await db
    .insert(jobOrderOutputLots)
    .values(outputLotLineValues(fx, jobOrderId, overrides))
    .returning();
  return outputLot;
}

/** A minimal posted stock_posting_line to exercise the append-only/uniqueness FKs. */
async function postingLineFixture(fx: Fixture) {
  const [posting] = await db
    .insert(stockPostings)
    .values({
      idempotencyKey: `PS-POSTING:${randomUUID()}`,
      requestHash: randomUUID(),
      sourceModule: "JOB_ORDER",
      sourceDocumentNo: `JO-${randomUUID()}`,
      correlationId: randomUUID(),
    })
    .returning();
  const [line] = await db
    .insert(stockPostingLines)
    .values({
      postingId: posting.id,
      lineNo: 1,
      warehouseId: fx.productionWarehouseId,
      itemId: fx.componentItemId,
      lotId: fx.componentLotId,
      movementType: "OUT",
      quantity: "2.000000",
      enteredQuantity: "2.000000",
      enteredUom: "kg",
      conversionFactor: "1.00000000",
      balanceBefore: "10.000000",
      balanceAfter: "8.000000",
      lineHash: randomUUID(),
    })
    .returning();
  return line;
}

/** Creates a header + a DRAFT version with one component line, ready to activate. */
async function draftChain(fx: Fixture) {
  const header = await insertHeader(fx);
  const version = await insertVersion(fx, header.id);
  const component = await insertComponent(version.id, fx.componentItemId);
  return { header, version, component };
}

describe("production schema (BOM / Job Order)", () => {
  it("creates a full BOM header/version/component/job order/allocation/output-lot chain", async () => {
    const fx = await fixture();
    const { header, version, component } = await draftChain(fx);
    expect(header).toMatchObject({ outputItemId: fx.outputItemId, isActive: true });
    expect(version).toMatchObject({ bomHeaderId: header.id, status: "DRAFT" });
    expect(component).toMatchObject({ bomVersionId: version.id, componentItemId: fx.componentItemId });

    await db.update(bomVersions).set({ status: "ACTIVE" }).where(eqId(bomVersions, version.id));

    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    expect(jobOrder).toMatchObject({ status: "DRAFT", version: 1 });

    const allocation = await insertAllocation(fx, jobOrder.id, { bomComponentId: component.id });
    expect(allocation).toMatchObject({ jobOrderId: jobOrder.id, sourceLotId: fx.componentLotId });

    const outputLot = await insertOutputLot(fx, jobOrder.id);
    expect(outputLot).toMatchObject({ jobOrderId: jobOrder.id, outputLotId: fx.outputLotId });
  });

  it("is replay-safe: reapplying migration 0029 does not duplicate enum types", async () => {
    const migrationsDir = resolve(process.cwd(), "drizzle");
    const body = readFileSync(resolve(migrationsDir, "0029_bom_job_orders.sql"), "utf8").replaceAll(
      "--> statement-breakpoint",
      "\n",
    );
    await client.transaction(async (tx: { exec: (sql: string) => Promise<unknown> }) => {
      await tx.exec(body);
    });
    const { rows } = (await client.query(
      `select count(*)::int as count from pg_type where typname in ('bom_version_status','job_order_status')`,
    )) as { rows: { count: number }[] };
    expect(rows[0]?.count).toBe(2);
  });

  it("rejects a bom_header whose output item is not a stock-postable item type", async () => {
    const fx = await fixture();
    await expect(insertHeader(fx, { outputItemId: fx.nonPostableItemId })).rejects.toThrow();
  });

  it("rejects an unknown bom_header output item reference", async () => {
    const fx = await fixture();
    await expect(insertHeader(fx, { outputItemId: randomUUID() })).rejects.toThrow();
  });

  it("enforces a unique bom_header code", async () => {
    const fx = await fixture();
    const code = `BOM-DUP-${randomUUID()}`;
    await insertHeader(fx, { code });
    await expect(insertHeader(fx, { code })).rejects.toThrow();
  });

  it("enforces exactly one ACTIVE version per bom header", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    await insertVersion(fx, header.id, { versionNo: 1, status: "ACTIVE" });
    await expect(insertVersion(fx, header.id, { versionNo: 2, status: "ACTIVE" })).rejects.toThrow();
  });

  it("rejects non-positive yield, version number, or an invalid effective date range", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    await expect(insertVersion(fx, header.id, { outputYieldQty: "0" })).rejects.toThrow();
    await expect(insertVersion(fx, header.id, { versionNo: 0 })).rejects.toThrow();
    await expect(
      insertVersion(fx, header.id, { effectiveFrom: "2026-02-01", effectiveTo: "2026-01-01" }),
    ).rejects.toThrow();
  });

  it("enforces a unique version number per bom header", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    await insertVersion(fx, header.id, { versionNo: 1 });
    await expect(insertVersion(fx, header.id, { versionNo: 1 })).rejects.toThrow();
  });

  it("rejects a bom_component that self-references the header's output item", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await expect(insertComponent(version.id, fx.outputItemId)).rejects.toThrow();
  });

  it("rejects a bom_component whose item type is not stock-postable", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await expect(insertComponent(version.id, fx.nonPostableItemId)).rejects.toThrow();
  });

  it("rejects a duplicate component item within the same bom version", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await insertComponent(version.id, fx.componentItemId, { lineNo: 1 });
    await expect(insertComponent(version.id, fx.componentItemId, { lineNo: 2 })).rejects.toThrow();
  });

  it("rejects a duplicate component line number within the same bom version", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await insertComponent(version.id, fx.componentItemId, { lineNo: 1 });
    await expect(insertComponent(version.id, fx.otherComponentItemId, { lineNo: 1 })).rejects.toThrow();
  });

  it("rejects a non-positive component quantity or an out-of-range scrap allowance", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await expect(insertComponent(version.id, fx.componentItemId, { baseQuantity: "0" })).rejects.toThrow();
    await expect(
      insertComponent(version.id, fx.otherComponentItemId, { lineNo: 2, scrapAllowancePct: "100" }),
    ).rejects.toThrow();
    await expect(
      insertComponent(version.id, fx.otherComponentItemId, { lineNo: 3, scrapAllowancePct: "-1" }),
    ).rejects.toThrow();
  });

  it("keeps a bom_version's identity/output fields immutable once it leaves DRAFT", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await db.update(bomVersions).set({ status: "ACTIVE" }).where(eqId(bomVersions, version.id));
    await expect(
      db.update(bomVersions).set({ outputYieldQty: "20.000000" }).where(eqId(bomVersions, version.id)),
    ).rejects.toThrow();
    await expect(
      db.update(bomVersions).set({ effectiveFrom: "2027-01-01" }).where(eqId(bomVersions, version.id)),
    ).rejects.toThrow();
    // Non-identity fields (e.g. remarks) remain editable once ACTIVE.
    await expect(
      db.update(bomVersions).set({ remarks: "still editable" }).where(eqId(bomVersions, version.id)),
    ).resolves.not.toThrow();
  });

  it("keeps bom_component rows immutable (no insert/update/delete) once the parent version leaves DRAFT", async () => {
    const fx = await fixture();
    const { header: _header, version, component } = await draftChain(fx);
    await db.update(bomVersions).set({ status: "ACTIVE" }).where(eqId(bomVersions, version.id));

    await expect(insertComponent(version.id, fx.otherComponentItemId, { lineNo: 2 })).rejects.toThrow();
    await expect(
      db.update(bomComponents).set({ baseQuantity: "3.000000" }).where(eqId(bomComponents, component.id)),
    ).rejects.toThrow();
    await expect(db.delete(bomComponents).where(eqId(bomComponents, component.id))).rejects.toThrow();
  });

  it("rejects a bom_version status value outside DRAFT/ACTIVE/RETIRED", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    await expect(
      client.query(`update bom_version set status = 'BOGUS' where id = $1`, [version.id]),
    ).rejects.toThrow();
  });

  it("enforces a job_order's production_warehouse_id references a PRODUCTION-purpose warehouse", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    await expect(
      insertJobOrder(fx, header.id, version.id, { productionWarehouseId: fx.nonProductionWarehouseId }),
    ).rejects.toThrow();
  });

  it("rejects an unknown job_order production_warehouse_id reference", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    await expect(
      insertJobOrder(fx, header.id, version.id, { productionWarehouseId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("enforces a unique job_order_no", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrderNo = `JO-DUP-${randomUUID()}`;
    await insertJobOrder(fx, header.id, version.id, { jobOrderNo });
    await expect(insertJobOrder(fx, header.id, version.id, { jobOrderNo })).rejects.toThrow();
  });

  it("rejects non-positive planned/actual quantities or a non-positive optimistic version", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    await expect(insertJobOrder(fx, header.id, version.id, { plannedOutputQty: "0" })).rejects.toThrow();
    await expect(insertJobOrder(fx, header.id, version.id, { actualOutputQty: "-1" })).rejects.toThrow();
    await expect(insertJobOrder(fx, header.id, version.id, { version: 0 })).rejects.toThrow();
  });

  it("rejects a job_order status value outside its lifecycle enum", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await expect(
      client.query(`update job_order set status = 'BOGUS' where id = $1`, [jobOrder.id]),
    ).rejects.toThrow();
  });

  it("allows at most one job order to claim a given consume or output operational_document", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const [consumeDoc] = await db
      .insert(operationalDocuments)
      .values({
        module: "JOB_ORDER_CONSUME",
        documentNo: `JOC-${randomUUID()}`,
        locationId: fx.locationId,
        status: "APPROVED",
      })
      .returning();
    const [outputDoc] = await db
      .insert(operationalDocuments)
      .values({
        module: "JOB_ORDER_OUTPUT",
        documentNo: `JOO-${randomUUID()}`,
        locationId: fx.locationId,
        status: "APPROVED",
      })
      .returning();
    const jobOrderA = await insertJobOrder(fx, header.id, version.id, {
      consumeDocumentId: consumeDoc.id,
      outputDocumentId: outputDoc.id,
    });
    expect(jobOrderA).toMatchObject({ consumeDocumentId: consumeDoc.id, outputDocumentId: outputDoc.id });

    const jobOrderB = await insertJobOrder(fx, header.id, version.id);
    await expect(
      db.update(jobOrders).set({ consumeDocumentId: consumeDoc.id }).where(eqId(jobOrders, jobOrderB.id)),
    ).rejects.toThrow();
    await expect(
      db.update(jobOrders).set({ outputDocumentId: outputDoc.id }).where(eqId(jobOrders, jobOrderB.id)),
    ).rejects.toThrow();
  });

  it("rejects an allocation with a non-positive planned quantity or conversion factor", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await expect(insertAllocation(fx, jobOrder.id, { plannedQuantity: "0" })).rejects.toThrow();
    await expect(
      insertAllocation(fx, jobOrder.id, { lineNo: 2, conversionFactor: "0" }),
    ).rejects.toThrow();
    await expect(
      insertAllocation(fx, jobOrder.id, { lineNo: 3, allocatedQuantity: "-1" }),
    ).rejects.toThrow();
  });

  it("rejects an allocation referencing an unknown lot or warehouse", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await expect(insertAllocation(fx, jobOrder.id, { sourceLotId: randomUUID() })).rejects.toThrow();
    await expect(
      insertAllocation(fx, jobOrder.id, { lineNo: 3, sourceWarehouseId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate allocation line number within the same job order", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await insertAllocation(fx, jobOrder.id, { lineNo: 1 });
    await expect(insertAllocation(fx, jobOrder.id, { lineNo: 1 })).rejects.toThrow();
  });

  it("keeps job_order_component_allocation append-only once a consume posting line is set", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    const allocation = await insertAllocation(fx, jobOrder.id);
    const postingLine = await postingLineFixture(fx);

    await expect(
      db
        .update(jobOrderComponentAllocations)
        .set({ consumePostingLineId: postingLine.id })
        .where(eqId(jobOrderComponentAllocations, allocation.id)),
    ).resolves.not.toThrow();

    await expect(
      db
        .update(jobOrderComponentAllocations)
        .set({ allocatedQuantity: "2.000000" })
        .where(eqId(jobOrderComponentAllocations, allocation.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(jobOrderComponentAllocations).where(eqId(jobOrderComponentAllocations, allocation.id)),
    ).rejects.toThrow();
  });

  it("prevents two allocations from claiming the same consume posting line", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    const allocationA = await insertAllocation(fx, jobOrder.id, { lineNo: 1 });
    const allocationB = await insertAllocation(fx, jobOrder.id, { lineNo: 2 });
    const postingLine = await postingLineFixture(fx);

    await db
      .update(jobOrderComponentAllocations)
      .set({ consumePostingLineId: postingLine.id })
      .where(eqId(jobOrderComponentAllocations, allocationA.id));
    await expect(
      db
        .update(jobOrderComponentAllocations)
        .set({ consumePostingLineId: postingLine.id })
        .where(eqId(jobOrderComponentAllocations, allocationB.id)),
    ).rejects.toThrow();
  });

  it("rejects a non-positive output lot quantity", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await expect(insertOutputLot(fx, jobOrder.id, { quantity: "0" })).rejects.toThrow();
  });

  it("rejects an output lot referencing an unknown lot", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await expect(insertOutputLot(fx, jobOrder.id, { outputLotId: randomUUID() })).rejects.toThrow();
  });

  it("rejects a duplicate output lot within the same job order", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    await insertOutputLot(fx, jobOrder.id);
    await expect(insertOutputLot(fx, jobOrder.id)).rejects.toThrow();
  });

  it("keeps job_order_output_lot append-only once an output posting line is set", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    const outputLot = await insertOutputLot(fx, jobOrder.id);
    const postingLine = await postingLineFixture(fx);

    await expect(
      db
        .update(jobOrderOutputLots)
        .set({ outputPostingLineId: postingLine.id })
        .where(eqId(jobOrderOutputLots, outputLot.id)),
    ).resolves.not.toThrow();

    await expect(
      db
        .update(jobOrderOutputLots)
        .set({ evidenceRef: "changed" })
        .where(eqId(jobOrderOutputLots, outputLot.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(jobOrderOutputLots).where(eqId(jobOrderOutputLots, outputLot.id)),
    ).rejects.toThrow();
  });

  it("prevents two output lots from claiming the same output posting line", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    const [secondOutputLot] = await db
      .insert(inventoryLots)
      .values({ itemId: fx.outputItemId, lotCode: `PS-OLOT2-${randomUUID()}`, unitCost: "10.000000" })
      .returning();
    const outputLotA = await insertOutputLot(fx, jobOrder.id);
    const outputLotB = await insertOutputLot(fx, jobOrder.id, { outputLotId: secondOutputLot.id });
    const postingLine = await postingLineFixture(fx);

    await db
      .update(jobOrderOutputLots)
      .set({ outputPostingLineId: postingLine.id })
      .where(eqId(jobOrderOutputLots, outputLotA.id));
    await expect(
      db
        .update(jobOrderOutputLots)
        .set({ outputPostingLineId: postingLine.id })
        .where(eqId(jobOrderOutputLots, outputLotB.id)),
    ).rejects.toThrow();
  });

  it("cascades allocation and output-lot deletion when the parent job order is removed", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id, { status: "ACTIVE" });
    const jobOrder = await insertJobOrder(fx, header.id, version.id);
    const allocation = await insertAllocation(fx, jobOrder.id);
    const outputLot = await insertOutputLot(fx, jobOrder.id);

    await db.delete(jobOrders).where(eqId(jobOrders, jobOrder.id));

    expect(
      await db
        .select()
        .from(jobOrderComponentAllocations)
        .where(eqId(jobOrderComponentAllocations, allocation.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(jobOrderOutputLots).where(eqId(jobOrderOutputLots, outputLot.id)),
    ).toHaveLength(0);
  });

  it("cascades bom_component deletion when the parent bom version is removed (still DRAFT)", async () => {
    const fx = await fixture();
    const header = await insertHeader(fx);
    const version = await insertVersion(fx, header.id);
    const component = await insertComponent(version.id, fx.componentItemId);

    await db.delete(bomVersions).where(eqId(bomVersions, version.id));

    expect(await db.select().from(bomComponents).where(eqId(bomComponents, component.id))).toHaveLength(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared id-lookup helper across several table shapes
function eqId(table: any, id: string) {
  return eq(table.id, id);
}
