import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags, outboxEvents } from "../src/db/enterprise-schema.js";
import { bomVersions } from "../src/db/production-schema.js";
import { ingredients, users, userSessions, type Role } from "../src/db/schema.js";
import { StockProductionError } from "../src/modules/production/errors.js";
import { createBomService } from "../src/modules/production/service.js";
import type { BomComponentLineInput } from "../src/modules/production/types.js";

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
      name: `BOM User ${s}`,
      email: `bom-${s}@test.local`,
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
      code: `BOM-ITEM-${s}`,
      name: overrides.name ?? `BOM Item ${s}`,
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

function service() {
  return createBomService(db);
}

function componentLine(itemId: string, qty: string | number = "1.000000", uom = "kg"): BomComponentLineInput {
  return { componentItemId: itemId, enteredQuantity: qty, enteredUom: uom };
}

describe("BOM authoring/version-lifecycle service", () => {
  it("happy path: chicken+salt+pepper -> Roast Chicken FG BOM through activation", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const salt = await makeItem("RAW", { unit: "kg" });
    const pepper = await makeItem("RAW", { unit: "kg" });
    const roastChicken = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Roast Chicken" });

    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `RC-${suffix()}`, name: "Roast Chicken", outputItemId: roastChicken.id },
    );
    expect(header.isActive).toBe(true);
    expect(header.productionMode).toBe("MADE_TO_ORDER");

    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    expect(version.status).toBe("DRAFT");
    expect(version.versionNo).toBe(1);

    const components = await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      {
        bomVersionId: version.id,
        lines: [
          componentLine(chicken.id, "1.000000", "kg"),
          componentLine(salt.id, "0.050000", "kg"),
          componentLine(pepper.id, "0.010000", "kg"),
        ],
      },
    );
    expect(components).toHaveLength(3);
    expect(components.map((c) => c.lineNo).sort()).toEqual([1, 2, 3]);

    const activated = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: version.id });
    expect(activated.status).toBe("ACTIVE");
    expect(activated.approvedBy).toBe(owner.id);
    expect(activated.approvedAt).toBeTruthy();

    const fetchedVersion = await svc.getVersion({ actorUserId: owner.id }, { bomVersionId: version.id });
    expect(fetchedVersion.components).toHaveLength(3);

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, activated.id), eq(outboxEvents.eventType, "bom_version.activated")));
    expect(outboxRows).toHaveLength(1);
  });

  it("allows a WIP output item to be used as a component of a FINISHED_GOOD BOM", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const wip = await makeItem("WIP", { unit: "kg", name: "Roasted Chicken WIP" });
    const sandwich = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Chicken Sandwich" });

    const svc = service();
    const headerA = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `WIP-A-${suffix()}`, name: "Roasted Chicken WIP BOM", outputItemId: wip.id },
    );
    const versionA = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: headerA.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: versionA.id, lines: [componentLine(chicken.id, "1.000000", "kg")] },
    );
    const activatedA = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: versionA.id });
    expect(activatedA.status).toBe("ACTIVE");

    const headerB = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `SANDWICH-${suffix()}`, name: "Chicken Sandwich BOM", outputItemId: sandwich.id },
    );
    const versionB = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: headerB.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    const componentsB = await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: versionB.id, lines: [componentLine(wip.id, "1.000000", "kg")] },
    );
    expect(componentsB).toHaveLength(1);

    const activatedB = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: versionB.id });
    expect(activatedB.status).toBe("ACTIVE");
  });

  it("rejects a component set that would create a circular BOM dependency", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const itemX = await makeItem("FINISHED_GOOD", { unit: "kg", name: "Item X" });
    const itemY = await makeItem("WIP", { unit: "kg", name: "Item Y" });

    const svc = service();
    const headerX = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `X-${suffix()}`, name: "BOM X", outputItemId: itemX.id },
    );
    const versionX = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: headerX.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    // X's BOM has component Y. Left as DRAFT — the cycle graph considers
    // both ACTIVE and DRAFT versions, so this still counts.
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: versionX.id, lines: [componentLine(itemY.id, "1.000000", "kg")] },
    );

    const headerY = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `Y-${suffix()}`, name: "BOM Y", outputItemId: itemY.id },
    );
    const versionY = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: headerY.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );

    let caught: unknown;
    try {
      // Y's BOM tries to use X as a component: X -> Y -> X, a cycle.
      await svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: versionY.id, lines: [componentLine(itemX.id, "1.000000", "kg")] },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockProductionError);
    expect((caught as StockProductionError).code).toBe("CYCLE_DETECTED");
  });

  it("rejects an entered UOM with no matching unit or active conversion (UOM_MISMATCH)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `UOM-${suffix()}`, name: "UOM Test BOM", outputItemId: output.id },
    );
    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(chicken.id, "1.000000", "lb")] },
      ),
    ).rejects.toMatchObject({ code: "UOM_MISMATCH" });
  });

  it("rejects a non-numeric or too-many-decimal-places quantity with VALIDATION", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `EXACT-${suffix()}`, name: "Exactness Test BOM", outputItemId: output.id },
    );
    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(chicken.id, "not-a-number", "kg")] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(chicken.id, "1.1234567", "kg")] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps only one ACTIVE version per header and blocks editing an ACTIVE/RETIRED version", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `UNIQ-${suffix()}`, name: "Uniqueness Test BOM", outputItemId: output.id },
    );

    const version1 = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: version1.id, lines: [componentLine(chicken.id)] },
    );
    const activated1 = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: version1.id });
    expect(activated1.status).toBe("ACTIVE");

    const version2 = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-02-01" },
    );
    expect(version2.versionNo).toBe(2);
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: version2.id, lines: [componentLine(chicken.id, "2.000000")] },
    );
    const activated2 = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: version2.id });
    expect(activated2.status).toBe("ACTIVE");

    const [rowV1] = await db.select().from(bomVersions).where(eq(bomVersions.id, version1.id));
    expect(rowV1!.status).toBe("RETIRED");

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version1.id, lines: [componentLine(chicken.id)] },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version2.id, lines: [componentLine(chicken.id)] },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("retires an ACTIVE version explicitly and rejects retiring a non-ACTIVE version", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `RETIRE-${suffix()}`, name: "Retire Test BOM", outputItemId: output.id },
    );
    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: version.id, lines: [componentLine(chicken.id)] },
    );

    await expect(
      svc.retireVersion({ actorUserId: owner.id }, { bomVersionId: version.id }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const activated = await svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: version.id });
    const retired = await svc.retireVersion({ actorUserId: owner.id }, { bomVersionId: activated.id });
    expect(retired.status).toBe("RETIRED");

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, retired.id), eq(outboxEvents.eventType, "bom_version.retired")));
    expect(outboxRows).toHaveLength(1);

    await expect(
      svc.retireVersion({ actorUserId: owner.id }, { bomVersionId: retired.id }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("keeps every mutation dark until stock.production is enabled, but allows reads", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `DARK-${suffix()}`, name: "Dark Flag Test BOM", outputItemId: output.id },
    );
    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );
    await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: version.id, lines: [componentLine(chicken.id)] },
    );

    await setFlags(false);

    await expect(
      svc.createHeader(
        { actorUserId: owner.id },
        { code: `DARK2-${suffix()}`, name: "Dark", outputItemId: output.id },
      ),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
    await expect(
      svc.createDraftVersion(
        { actorUserId: owner.id },
        { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-03-01" },
      ),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(chicken.id)] },
      ),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
    await expect(
      svc.activateVersion({ actorUserId: owner.id }, { bomVersionId: version.id }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
    await expect(
      svc.retireVersion({ actorUserId: owner.id }, { bomVersionId: version.id }),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });

    const fetchedHeader = await svc.getHeader({ actorUserId: owner.id }, { bomHeaderId: header.id });
    expect(fetchedHeader.id).toBe(header.id);
    expect(fetchedHeader.versions).toHaveLength(1);

    const list = await svc.listHeaders({ actorUserId: owner.id }, { search: header.code });
    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe(header.id);
  });

  it("enforces role, session, and active-user checks (UNAUTHORIZED / dead session)", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const warehouseMain = await makeUser("WAREHOUSE_MAIN");
    const kitchenCrew = await makeUser("KITCHEN_CREW");
    const blockedOwner = await makeUser("OWNER", "BLOCKED");
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();

    await expect(
      svc.createHeader(
        { actorUserId: kitchenCrew.id },
        { code: `ROLE-${suffix()}`, name: "Role Test", outputItemId: output.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    await expect(
      svc.createHeader(
        { actorUserId: blockedOwner.id },
        { code: `ROLE2-${suffix()}`, name: "Role Test 2", outputItemId: output.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 403 });

    const deadSession = await makeSession(owner.id, false);
    await expect(
      svc.createHeader(
        { actorUserId: owner.id, sessionId: deadSession.id },
        { code: `ROLE3-${suffix()}`, name: "Role Test 3", outputItemId: output.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const otherOwner = await makeUser("OWNER");
    const otherSession = await makeSession(otherOwner.id, true);
    await expect(
      svc.createHeader(
        { actorUserId: owner.id, sessionId: otherSession.id },
        { code: `ROLE4-${suffix()}`, name: "Role Test 4", outputItemId: output.id },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const headerOwner = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `ROLE-OK-OWNER-${suffix()}`, name: "Owner OK", outputItemId: output.id },
    );
    expect(headerOwner.createdBy).toBe(owner.id);

    const headerWarehouseMain = await svc.createHeader(
      { actorUserId: warehouseMain.id },
      { code: `ROLE-OK-WM-${suffix()}`, name: "Warehouse Main OK", outputItemId: output.id },
    );
    expect(headerWarehouseMain.createdBy).toBe(warehouseMain.id);
  });

  it("rejects disallowed output item types/inactive items, bad effective ranges, duplicate lines, and self-components", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const serviceItem = await makeItem("SERVICE", { unit: "kg" });
    const inactiveFg = await makeItem("FINISHED_GOOD", { unit: "kg", isActive: false });
    const validOutput = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const chicken = await makeItem("RAW", { unit: "kg" });
    const svc = service();

    await expect(
      svc.createHeader(
        { actorUserId: owner.id },
        { code: `TYPE-${suffix()}`, name: "Bad Type", outputItemId: serviceItem.id },
      ),
    ).rejects.toMatchObject({ code: "TYPE_NOT_ALLOWED" });

    await expect(
      svc.createHeader(
        { actorUserId: owner.id },
        { code: `INACTIVE-${suffix()}`, name: "Bad Inactive", outputItemId: inactiveFg.id },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `DATE-${suffix()}`, name: "Date Test", outputItemId: validOutput.id },
    );

    await expect(
      svc.createDraftVersion(
        { actorUserId: owner.id },
        {
          bomHeaderId: header.id,
          outputUom: "kg",
          outputYieldQty: "1.000000",
          effectiveFrom: "2026-03-01",
          effectiveTo: "2026-01-01",
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(chicken.id), componentLine(chicken.id)] },
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_LINE" });

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [componentLine(validOutput.id)] },
      ),
    ).rejects.toMatchObject({ code: "SELF_COMPONENT" });
  });

  it("rejects a duplicate BOM header code", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const output1 = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const output2 = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const code = `DUP-CODE-${suffix()}`;

    await svc.createHeader({ actorUserId: owner.id }, { code, name: "First", outputItemId: output1.id });
    await expect(
      svc.createHeader({ actorUserId: owner.id }, { code, name: "Second", outputItemId: output2.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("validates scrap allowance percent range (>= 0 and < 100) and normalizes it", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const chicken = await makeItem("RAW", { unit: "kg" });
    const output = await makeItem("FINISHED_GOOD", { unit: "kg" });
    const svc = service();
    const header = await svc.createHeader(
      { actorUserId: owner.id },
      { code: `SCRAP-${suffix()}`, name: "Scrap Test BOM", outputItemId: output.id },
    );
    const version = await svc.createDraftVersion(
      { actorUserId: owner.id },
      { bomHeaderId: header.id, outputUom: "kg", outputYieldQty: "1.000000", effectiveFrom: "2026-01-01" },
    );

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [{ ...componentLine(chicken.id), scrapAllowancePct: "100" }] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      svc.replaceDraftComponents(
        { actorUserId: owner.id },
        { bomVersionId: version.id, lines: [{ ...componentLine(chicken.id), scrapAllowancePct: "-1" }] },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const components = await svc.replaceDraftComponents(
      { actorUserId: owner.id },
      { bomVersionId: version.id, lines: [{ ...componentLine(chicken.id), scrapAllowancePct: "5.5" }] },
    );
    expect(components[0]!.scrapAllowancePct).toBe("5.5000");
  });

  it("propagates StockProductionError instances with a stable code/status shape for NOT_FOUND", async () => {
    await setFlags(true);
    const owner = await makeUser("OWNER");
    const svc = service();
    try {
      await svc.getHeader({ actorUserId: owner.id }, { bomHeaderId: randomUUID() });
      throw new Error("expected getHeader to reject a missing header id");
    } catch (error) {
      expect(error).toBeInstanceOf(StockProductionError);
      expect((error as StockProductionError).code).toBe("NOT_FOUND");
      expect((error as StockProductionError).status).toBe(404);
    }
  });
});
