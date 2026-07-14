import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import { ingredients, locations, users, userSessions, warehouses, type Role } from "../src/db/schema.js";
import { StockProductionError } from "../src/modules/production/errors.js";
import { createBomService } from "../src/modules/production/service.js";
import { createJobOrderService } from "../src/modules/production/job-order-service.js";
import type { BomVersion } from "../src/modules/production/types.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

async function setFlags(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, "stock.production"));
}

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

async function makeUser(role: Role, status: "ACTIVE" | "BLOCKED" = "ACTIVE") {
  const s = suffix();
  const [user] = await db
    .insert(users)
    .values({
      name: `JO User ${s}`,
      email: `jo-${s}@test.local`,
      passwordHash: "hash",
      role,
      status,
    })
    .returning();
  return user!;
}

async function makeSession(userId: string, active = true) {
  const [session] = await db
    .insert(userSessions)
    .values({ userId, logoutAt: active ? null : new Date() })
    .returning();
  return session!;
}

async function makeItem(
  itemType: "RAW" | "WIP" | "FINISHED_GOOD" | "CONSUMABLE" | "PACKAGING" | "SERVICE",
  overrides: Partial<{ unit: string; isActive: boolean; name: string }> = {},
) {
  const s = suffix();
  const [item] = await db
    .insert(ingredients)
    .values({
      code: `JO-ITEM-${s}`,
      name: overrides.name ?? `JO Item ${s}`,
      unit: overrides.unit ?? "kg",
      itemType,
      lotTracked: false,
      isActive: overrides.isActive ?? true,
      unitCost: "1.0000",
      lowStockThreshold: "0.0000",
    })
    .returning();
  return item!;
}

async function makeLocation() {
  const s = suffix();
  const [location] = await db
    .insert(locations)
    .values({ code: `JO-LOC-${s}`, name: `JO Location ${s}` })
    .returning();
  return location!;
}

async function makeWarehouse(
  locationId: string,
  purpose: "HQ_MAIN" | "OUTLET_STORAGE" | "KITCHEN" | "PRODUCTION" | "QUARANTINE",
  isActive = true,
) {
  const s = suffix();
  const [warehouse] = await db
    .insert(warehouses)
    .values({
      locationId,
      type: "MAIN",
      purpose,
      code: `JO-WH-${s}`,
      name: `JO Warehouse ${s}`,
      isActive,
    })
    .returning();
  return warehouse!;
}

function bomService() {
  return createBomService(db);
}

function jobService() {
  return createJobOrderService(db);
}

interface ComponentSpec {
  item: { id: string };
  qty: string;
  uom: string;
  scrapAllowancePct?: string;
}

async function createActiveBom(
  ownerId: string,
  outputItem: { id: string },
  componentSpecs: ComponentSpec[],
  outputYieldQty = "1.000000",
  outputUom = "kg",
): Promise<BomVersion> {
  const svc = bomService();
  const header = await svc.createHeader(
    { actorUserId: ownerId },
    { code: `JO-BOM-${suffix()}`, name: "JO Test BOM", outputItemId: outputItem.id },
  );
  const version = await svc.createDraftVersion(
    { actorUserId: ownerId },
    { bomHeaderId: header.id, outputUom, outputYieldQty, effectiveFrom: "2026-01-01" },
  );
  await svc.replaceDraftComponents(
    { actorUserId: ownerId },
    {
      bomVersionId: version.id,
      lines: componentSpecs.map((c) => ({
        componentItemId: c.item.id,
        enteredQuantity: c.qty,
        enteredUom: c.uom,
        scrapAllowancePct: c.scrapAllowancePct,
      })),
    },
  );
  return svc.activateVersion({ actorUserId: ownerId }, { bomVersionId: version.id });
}

async function setupProductionLocation() {
  const location = await makeLocation();
  const productionWarehouse = await makeWarehouse(location.id, "PRODUCTION");
  return { location, productionWarehouse };
}

describe("Job Order draft planning service", () => {
  it("keeps createDraft dark until stock.production is enabled, but allows get/list reads", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const fg = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, fg, [{ item: chicken, qty: "1.000000", uom: "kg" }]);

    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `DARK-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "kg",
      },
    );
    expect(draft.status).toBe("DRAFT");

    await setFlags(false);

    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `DARK-JO2-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: location.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });

    const fetched = await svc.get({ actorUserId: owner.id }, { jobOrderId: draft.id });
    expect(fetched.id).toBe(draft.id);

    const list = await svc.list({ actorUserId: owner.id }, { search: draft.jobOrderNo });
    expect(list.total).toBe(1);
  });

  it("enforces role, session, and active-user checks (UNAUTHORIZED / dead session / foreign session)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const kitchenCrew = await makeUser("KITCHEN_CREW");
    const blockedOwner = await makeUser("OWNER", "BLOCKED");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const fg = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, fg, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const svc = jobService();

    const input = {
      jobOrderNo: `ROLE-JO-${suffix()}`,
      bomVersionId: activeVersion.id,
      locationId: location.id,
      plannedOutputQty: "1.000000",
      plannedOutputUom: "kg",
    };

    await expect(
      svc.createDraft({ actorUserId: kitchenCrew.id }, { ...input, jobOrderNo: `ROLE1-${suffix()}` }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    await expect(
      svc.createDraft({ actorUserId: blockedOwner.id }, { ...input, jobOrderNo: `ROLE2-${suffix()}` }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    const deadSession = await makeSession(owner.id, false);
    await expect(
      svc.createDraft(
        { actorUserId: owner.id, sessionId: deadSession.id },
        { ...input, jobOrderNo: `ROLE3-${suffix()}` },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const otherOwner = await makeUser("OWNER");
    const otherSession = await makeSession(otherOwner.id, true);
    await expect(
      svc.createDraft(
        { actorUserId: owner.id, sessionId: otherSession.id },
        { ...input, jobOrderNo: `ROLE4-${suffix()}` },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const warehouseMain = await makeUser("WAREHOUSE_MAIN");
    const draftWm = await svc.createDraft(
      { actorUserId: warehouseMain.id },
      { ...input, jobOrderNo: `ROLE-OK-WM-${suffix()}` },
    );
    expect(draftWm.createdBy).toBe(warehouseMain.id);

    const liveSession = await makeSession(owner.id, true);
    const draftSession = await svc.createDraft(
      { actorUserId: owner.id, sessionId: liveSession.id },
      { ...input, jobOrderNo: `ROLE-OK-SESSION-${suffix()}` },
    );
    expect(draftSession.createdBy).toBe(owner.id);
  });

  it("plans exact chicken/salt/pepper allocations scaled by planned output including scrap allowance", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const pepper = await makeItem("RAW", { unit: "kg" });
    const roastChicken = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Roast Chicken" });

    // BOM yields 1kg from chicken 1kg (5% scrap) + salt 0.05kg + pepper 0.01kg.
    const activeVersion = await createActiveBom(
      owner.id,
      roastChicken,
      [
        { item: chicken, qty: "1.000000", uom: "kg", scrapAllowancePct: "5" },
        { item: salt, qty: "0.050000", uom: "kg" },
        { item: pepper, qty: "0.010000", uom: "kg" },
      ],
      "1.000000",
      "kg",
    );

    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `SCALE-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "2.000000",
        plannedOutputUom: "kg",
      },
    );

    expect(draft.allocations).toHaveLength(3);
    const byItem = new Map(draft.allocations.map((a) => [a.componentItemId, a]));
    expect(byItem.get(chicken.id)!.plannedQuantity).toBe("2.100000"); // (1 * 2/1) * 1.05
    expect(byItem.get(salt.id)!.plannedQuantity).toBe("0.100000"); // 0.05 * 2
    expect(byItem.get(pepper.id)!.plannedQuantity).toBe("0.020000"); // 0.01 * 2
    for (const allocation of draft.allocations) {
      expect(allocation.enteredUom).toBe("kg");
      expect(allocation.conversionFactor).toBe("1.00000000");
    }
  });

  it("derives a fractional-but-exact allocation quantity when division terminates", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const flour = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });

    // Yield 4kg from 1kg flour -> planning 1kg output needs 0.25kg flour exactly.
    const activeVersion = await createActiveBom(
      owner.id,
      output,
      [{ item: flour, qty: "1.000000", uom: "kg" }],
      "4.000000",
      "kg",
    );

    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `FRAC-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "kg",
      },
    );

    expect(draft.allocations).toHaveLength(1);
    expect(draft.allocations[0]!.plannedQuantity).toBe("0.250000");
  });

  it("rejects a planned output quantity that produces a non-terminating allocation quantity", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const flour = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });

    // Yield 3kg from 1kg flour -> planning 1kg output needs 0.333... kg: rejected.
    const activeVersion = await createActiveBom(
      owner.id,
      output,
      [{ item: flour, qty: "1.000000", uom: "kg" }],
      "3.000000",
      "kg",
    );

    const svc = jobService();
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `NONTERM-JO-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: location.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("plans a Job Order output of WIP scale (WIP output item BOM)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const wip = await makeItem("WIP", { unit: "kg", name: "Roasted Chicken WIP" });

    const activeVersion = await createActiveBom(
      owner.id,
      wip,
      [{ item: chicken, qty: "1.000000", uom: "kg" }],
      "1.000000",
      "kg",
    );

    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `WIP-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "kg",
      },
    );

    expect(draft.status).toBe("DRAFT");
    expect(draft.bomVersionId).toBe(activeVersion.id);
    expect(draft.allocations).toHaveLength(1);
  });

  it("rejects a DRAFT or RETIRED BOM version (only ACTIVE may be planned against)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });

    const bomSvc = bomService();
    const header = await bomSvc.createHeader(
      { actorUserId: owner.id },
      { code: `INACTIVE-BOM-${suffix()}`, name: "Inactive BOM", outputItemId: output.id },
    );
    const draftVersion = await bomSvc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    await bomSvc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: draftVersion.id, lines: [{ componentItemId: chicken.id, enteredQuantity: "1.000000", enteredUom: "kg" }] },
    );

    const svc = jobService();
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `INACTIVE-JO1-${suffix()}`,
          bomVersionId: draftVersion.id,
          locationId: location.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });

    const activated = await bomSvc.activateVersion({ actorUserId: owner.id }, { bomVersionId: draftVersion.id });
    const retired = await bomSvc.retireVersion({ actorUserId: owner.id }, { bomVersionId: activated.id });
    expect(retired.status).toBe("RETIRED");

    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `INACTIVE-JO2-${suffix()}`,
          bomVersionId: retired.id,
          locationId: location.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: 409 });
  });

  it("rejects an unknown location (wrong outlet), a location with no active PRODUCTION warehouse (wrong warehouse), and a mismatched planned output UOM", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const svc = jobService();

    // Wrong outlet: location id does not exist.
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `NOLOC-JO-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: randomUUID(),
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    // Wrong warehouse: location exists but has no active PRODUCTION warehouse.
    const bareLocation = await makeLocation();
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `NOWH-JO-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: bareLocation.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "WAREHOUSE_MISMATCH", status: 409 });

    // Inactive PRODUCTION warehouse also counts as no active PRODUCTION warehouse.
    const inactiveLocation = await makeLocation();
    await makeWarehouse(inactiveLocation.id, "PRODUCTION", false);
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `INACTIVEWH-JO-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: inactiveLocation.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "kg",
        },
      ),
    ).rejects.toMatchObject({ code: "WAREHOUSE_MISMATCH", status: 409 });

    // Wrong UOM: planned output UOM does not match the BOM version's output UOM.
    const { location: goodLocation } = await setupProductionLocation();
    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        {
          jobOrderNo: `BADUOM-JO-${suffix()}`,
          bomVersionId: activeVersion.id,
          locationId: goodLocation.id,
          plannedOutputQty: "1.000000",
          plannedOutputUom: "lb",
        },
      ),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH", status: 409 });
  });

  it("rejects a duplicate Job Order number with a 409 conflict", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const svc = jobService();
    const jobOrderNo = `DUP-JO-${suffix()}`;

    await svc.createDraft(
      { actorUserId: owner.id },
      { jobOrderNo, bomVersionId: activeVersion.id, locationId: location.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
    );

    await expect(
      svc.createDraft(
        { actorUserId: owner.id },
        { jobOrderNo, bomVersionId: activeVersion.id, locationId: location.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 409 });
  });

  it("get() returns allocations and rejects an unknown Job Order id with NOT_FOUND", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const activeVersion = await createActiveBom(owner.id, output, [
      { item: chicken, qty: "1.000000", uom: "kg" },
      { item: salt, qty: "0.050000", uom: "kg" },
    ]);
    const svc = jobService();
    const draft = await svc.createDraft(
      { actorUserId: owner.id },
      {
        jobOrderNo: `GET-JO-${suffix()}`,
        bomVersionId: activeVersion.id,
        locationId: location.id,
        plannedOutputQty: "1.000000",
        plannedOutputUom: "kg",
      },
    );

    const fetched = await svc.get({ actorUserId: owner.id }, { jobOrderId: draft.id });
    expect(fetched.id).toBe(draft.id);
    expect(fetched.allocations).toHaveLength(2);
    expect(fetched.allocations.map((a) => a.lineNo)).toEqual([1, 2]);

    await expect(
      svc.get({ actorUserId: owner.id }, { jobOrderId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("list() filters by location, bomHeaderId, status, search, and paginates with a correct total", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const { location: locationA } = await setupProductionLocation();
    const { location: locationB } = await setupProductionLocation();
    const chicken = await makeItem("RAW", { unit: "kg" });
    const outputA = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const outputB = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const versionA = await createActiveBom(owner.id, outputA, [{ item: chicken, qty: "1.000000", uom: "kg" }]);
    const versionB = await createActiveBom(owner.id, outputB, [{ item: chicken, qty: "1.000000", uom: "kg" }]);

    const svc = jobService();
    const tag = suffix();
    const jo1 = await svc.createDraft(
      { actorUserId: owner.id },
      { jobOrderNo: `LIST-A1-${tag}`, bomVersionId: versionA.id, locationId: locationA.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
    );
    const jo2 = await svc.createDraft(
      { actorUserId: owner.id },
      { jobOrderNo: `LIST-A2-${tag}`, bomVersionId: versionA.id, locationId: locationA.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
    );
    const jo3 = await svc.createDraft(
      { actorUserId: owner.id },
      { jobOrderNo: `LIST-B1-${tag}`, bomVersionId: versionB.id, locationId: locationB.id, plannedOutputQty: "1.000000", plannedOutputUom: "kg" },
    );

    const byLocation = await svc.list({ actorUserId: owner.id }, { locationId: locationA.id, search: tag });
    expect(byLocation.total).toBe(2);
    expect(byLocation.items.map((i) => i.id).sort()).toEqual([jo1.id, jo2.id].sort());

    const byBomHeader = await svc.list({ actorUserId: owner.id }, { bomHeaderId: jo3.bomHeaderId, search: tag });
    expect(byBomHeader.total).toBe(1);
    expect(byBomHeader.items[0]!.id).toBe(jo3.id);

    const byStatus = await svc.list({ actorUserId: owner.id }, { status: "DRAFT", search: tag });
    expect(byStatus.total).toBe(3);

    const bySearch = await svc.list({ actorUserId: owner.id }, { search: `LIST-A1-${tag}` });
    expect(bySearch.total).toBe(1);
    expect(bySearch.items[0]!.id).toBe(jo1.id);

    const paged = await svc.list({ actorUserId: owner.id }, { search: tag, limit: 1, offset: 1 });
    expect(paged.total).toBe(3);
    expect(paged.items).toHaveLength(1);
  });
});
