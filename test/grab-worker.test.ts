/**
 * GrabFood Partner API submit-order worker (src/modules/grab/worker.ts) —
 * runGrabSubmitOrderWorkerOnce(db, opts) coverage. service.ts's
 * handleSubmitOrder only persists a PENDING grab_partner_receipt
 * (route=SUBMIT_ORDER); this worker is the async step that maps items[] and
 * ingests via orders/service.ts. Fixture pattern mirrors
 * test/foodpanda-worker.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { grabPartnerReceipts } from "../src/db/grab-schema.js";
import { aggregatorAccounts, brands, ingredients, inventoryStock, kitchenStations, locations, menuItems, orders, recipeLines, warehouses } from "../src/db/schema.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";
import { handleSubmitOrder } from "../src/modules/grab/service.js";
import { submitOrderBodySchema } from "../src/modules/grab/validation.js";
import { runGrabSubmitOrderWorkerOnce } from "../src/modules/grab/worker.js";

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

function suffix(): string {
  sequence += 1;
  return `${sequence}-${randomUUID().slice(0, 6)}`;
}

/** Listing only — brand + outlet + active GRABFOOD aggregator account. No menu item mapped. */
async function makeListing(): Promise<{ partnerMerchantId: string; locationId: string; brandId: string; accountId: string }> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `GRABW-LOC-${s}`, name: `GrabW Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `GrabW Brand ${s}`, color: "#00b14f", salesPerfId: `grabw-brand-${s}` })
    .returning();
  const partnerMerchantId = `GRABW-STORE-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      aggregator: "GRABFOOD",
      externalMerchantId: partnerMerchantId,
      mappingStatus: "RESOLVED",
      isActive: true,
    })
    .returning();
  return { partnerMerchantId, locationId: location!.id, brandId: brand!.id, accountId: account!.id };
}

/** Deploys a stocked, STOCKED_OUTPUT menu item whose item_no equals grabItemID — the mapping key worker.ts looks up. */
async function mapMenuItem(locationId: string, brandId: string, grabItemId: string): Promise<string> {
  const s = suffix();
  const [station] = await db.insert(kitchenStations).values({ locationId, name: `GrabW Station ${s}` }).returning();
  const [stockItem] = await db
    .insert(ingredients)
    .values({ code: `GRABW-ITEM-${s}`, name: `GrabW Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "50", lowStockThreshold: "1" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId,
      name: `GrabW Dish ${s}`,
      price: "150",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: stockItem!.id,
      itemNo: grabItemId,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: stockItem!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId, stationId: station!.id });
  const [kitchenWh] = await db.insert(warehouses).values({ locationId, type: "KITCHEN", purpose: "KITCHEN", code: `GRABW-WH-${s}`, name: `GrabW Kitchen ${s}` }).returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: stockItem!.id, quantity: "1000" });
  return menuItem!.id;
}

function rawSubmitOrderBody(partnerMerchantId: string, overrides: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    orderID: `GRABW-ORDER-${s}`,
    shortOrderNumber: `S${s}`,
    merchantID: `GRABW-MERCHANT-${s}`,
    partnerMerchantID: partnerMerchantId,
    paymentType: "CASHLESS",
    cutlery: true,
    orderTime: new Date().toISOString(),
    currency: { code: "PHP", symbol: "₱", exponent: 2 },
    featureFlags: { isMexEditOrder: false },
    items: [{ id: "line-1", grabItemID: `GRABW-SKU-${s}`, quantity: 2, price: 15000 }],
    price: { subtotal: 30000, total: 30000 },
    ...overrides,
  };
}

async function submit(partnerMerchantId: string, overrides: Record<string, unknown> = {}) {
  const body = submitOrderBodySchema.parse(rawSubmitOrderBody(partnerMerchantId, overrides));
  const result = await handleSubmitOrder(db, { partnerMerchantId, body });
  return { body, orderID: result.orderID };
}

async function receiptForOrderId(orderID: string) {
  const [receipt] = await db.select().from(grabPartnerReceipts).where(eq(grabPartnerReceipts.providerOrderId, orderID));
  return receipt!;
}

describe("runGrabSubmitOrderWorkerOnce — happy path", () => {
  it("maps, ingests, and marks the receipt PROCESSED when every item maps to a menu item", async () => {
    const listing = await makeListing();
    const grabItemId = `GRABW-MAPPED-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, grabItemId);
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: "line-1", grabItemID: grabItemId, quantity: 3, price: 15000 }] });

    const result = await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const receipt = await receiptForOrderId(orderID);
    expect(receipt.state).toBe("PROCESSED");
    expect(receipt.orderId).toBeTruthy();
    expect(receipt.lastError).toBeNull();

    const [order] = await db.select().from(orders).where(eq(orders.externalRef, orderID));
    expect(order).toBeTruthy();
    expect(order!.aggregator).toBe("GRABFOOD");
  });

  it("falls back to the item's `id` when grabItemID is absent", async () => {
    const listing = await makeListing();
    const fallbackId = `GRABW-FALLBACK-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, fallbackId);
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: fallbackId, quantity: 1, price: 15000 }] });

    await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    const receipt = await receiptForOrderId(orderID);
    expect(receipt.state).toBe("PROCESSED");
  });
});

describe("runGrabSubmitOrderWorkerOnce — unmapped item", () => {
  it("leaves the receipt WAITING_DEPENDENCY naming the unmapped id, and does NOT ingest", async () => {
    const listing = await makeListing();
    const unmappedId = `GRABW-UNMAPPED-${suffix()}`;
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: "line-1", grabItemID: unmappedId, quantity: 1, price: 15000 }] });

    const result = await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    expect(result.waitingDependency).toBeGreaterThanOrEqual(1);

    const receipt = await receiptForOrderId(orderID);
    expect(receipt.state).toBe("WAITING_DEPENDENCY");
    expect(receipt.orderId).toBeNull();
    expect(receipt.lastError).toContain(unmappedId);

    const orderRows = await db.select().from(orders).where(eq(orders.externalRef, orderID));
    expect(orderRows).toHaveLength(0);
  });

  it("never silently drops the unmapped receipt — a subsequent run still surfaces it in a terminal state, never PENDING forever", async () => {
    const listing = await makeListing();
    const unmappedId = `GRABW-STILLUNMAPPED-${suffix()}`;
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: "line-1", grabItemID: unmappedId, quantity: 1, price: 15000 }] });

    await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    const receipt = await receiptForOrderId(orderID);
    expect(["WAITING_DEPENDENCY", "FAILED"]).toContain(receipt.state);
  });
});

describe("runGrabSubmitOrderWorkerOnce — claim concurrency", () => {
  it("two concurrent calls process the same receipt exactly once (conditional-UPDATE claim, no double ingest)", async () => {
    const listing = await makeListing();
    const grabItemId = `GRABW-RACE-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, grabItemId);
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: "line-1", grabItemID: grabItemId, quantity: 1, price: 15000 }] });

    const [resA, resB] = await Promise.allSettled([runGrabSubmitOrderWorkerOnce(db, { limit: 10 }), runGrabSubmitOrderWorkerOnce(db, { limit: 10 })]);
    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("fulfilled");

    const claimed =
      (resA as PromiseFulfilledResult<Awaited<ReturnType<typeof runGrabSubmitOrderWorkerOnce>>>).value.claimed +
      (resB as PromiseFulfilledResult<Awaited<ReturnType<typeof runGrabSubmitOrderWorkerOnce>>>).value.claimed;
    expect(claimed).toBe(1);

    const receipt = await receiptForOrderId(orderID);
    expect(receipt.state).toBe("PROCESSED");

    const orderRows = await db.select().from(orders).where(eq(orders.externalRef, orderID));
    expect(orderRows).toHaveLength(1);
  });
});

describe("runGrabSubmitOrderWorkerOnce — bounded work", () => {
  it("respects the limit option and never re-touches an already-terminal receipt", async () => {
    const listing = await makeListing();
    const unmappedId = `GRABW-LIMIT-${suffix()}`;
    const { orderID } = await submit(listing.partnerMerchantId, { items: [{ id: "line-1", grabItemID: unmappedId, quantity: 1, price: 15000 }] });

    await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    const receiptAfterFirstPass = await receiptForOrderId(orderID);
    expect(receiptAfterFirstPass.state).toBe("WAITING_DEPENDENCY");
    const updatedAtAfterFirstPass = receiptAfterFirstPass.updatedAt.getTime();

    // A second pass does not touch this receipt again (it's no longer PENDING).
    const secondResult = await runGrabSubmitOrderWorkerOnce(db, { limit: 10 });
    expect(secondResult.claimed).toBe(0);
    const receiptAfterSecondPass = await receiptForOrderId(orderID);
    expect(receiptAfterSecondPass.updatedAt.getTime()).toBe(updatedAtAfterFirstPass);
  });
});
