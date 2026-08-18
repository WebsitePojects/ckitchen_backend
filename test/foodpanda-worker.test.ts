/**
 * Foodpanda Plugin API outbound worker (src/modules/foodpanda/worker.ts) —
 * runFoodpandaOutboundOnce(db, opts) coverage. handleDispatchOrder (service.ts)
 * only persists a PENDING receipt + PENDING ORDER_ACCEPT_REJECT_DECISION task;
 * this worker is the async step that maps products, ingests via
 * orders/service.ts, and notifies Delivery Hero of acceptance. Fixture pattern
 * (outlet/station/menu item/recipe line/menuItemOutlets/KITCHEN stock) mirrors
 * test/middleware-processing.test.ts's proven ingestOrder fixture; the
 * concurrent-claim and bounded-retry test shapes mirror
 * test/outbound-commands.test.ts's processCommands coverage.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { menuItemOutlets } from "../src/db/enterprise-schema.js";
import { foodpandaPluginOutboundTasks, foodpandaPluginReceipts } from "../src/db/foodpanda-plugin-schema.js";
import {
  aggregatorAccounts,
  brands,
  ingredients,
  inventoryStock,
  kitchenStations,
  locations,
  menuItems,
  orders,
  recipeLines,
  warehouses,
} from "../src/db/schema.js";
import { orderDispatchBodySchema } from "../src/modules/foodpanda/validation.js";
import { handleDispatchOrder } from "../src/modules/foodpanda/service.js";
import { runFoodpandaOutboundOnce, type FoodpandaCallbackClient, type FoodpandaSendResult } from "../src/modules/foodpanda/worker.js";

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

// No hardcoded calendar literals — every date a test depends on comes from Date.now().
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

interface CallRecord {
  method: "postFoodpandaCallback" | "updateOrderStatus";
  args: unknown[];
}

function fakeClient(overrides: Partial<Record<"postFoodpandaCallback" | "updateOrderStatus", () => Promise<FoodpandaSendResult>>> = {}): FoodpandaCallbackClient & {
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  return {
    calls,
    async postFoodpandaCallback(rawUrl, body) {
      calls.push({ method: "postFoodpandaCallback", args: [rawUrl, body] });
      return overrides.postFoodpandaCallback ? overrides.postFoodpandaCallback() : { ok: true };
    },
    async updateOrderStatus(orderToken, body) {
      calls.push({ method: "updateOrderStatus", args: [orderToken, body] });
      return overrides.updateOrderStatus ? overrides.updateOrderStatus() : { ok: true };
    },
  };
}

/** Listing only — brand + outlet + active FOODPANDA aggregator account. No menu item mapped. */
async function makeListing(): Promise<{ remoteId: string; locationId: string; brandId: string; accountId: string }> {
  const s = suffix();
  const [location] = await db.insert(locations).values({ code: `FPW-LOC-${s}`, name: `FPW Outlet ${s}` }).returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `FPW Brand ${s}`, color: "#334455", salesPerfId: `fpw-brand-${s}` })
    .returning();
  const remoteId = `FPW-REMOTE-${s}`;
  const [account] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      aggregator: "FOODPANDA",
      apiMerchantId: remoteId,
      externalMerchantId: `legacy-${remoteId}`,
      mappingStatus: "RESOLVED",
      isActive: true,
    })
    .returning();
  return { remoteId, locationId: location!.id, brandId: brand!.id, accountId: account!.id };
}

/** Deploys a stocked, STOCKED_OUTPUT menu item whose item_no equals remoteCode — the mapping key worker.ts looks up. */
async function mapMenuItem(locationId: string, brandId: string, remoteCode: string): Promise<string> {
  const s = suffix();
  const [station] = await db.insert(kitchenStations).values({ locationId, name: `FPW Station ${s}` }).returning();
  const [item] = await db
    .insert(ingredients)
    .values({ code: `FPW-ITEM-${s}`, name: `FPW Item ${s}`, unit: "pcs", itemType: "FINISHED_GOOD", unitCost: "50", lowStockThreshold: "1" })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({
      brandId,
      name: `FPW Dish ${s}`,
      price: "150",
      stationId: station!.id,
      consumptionMode: "STOCKED_OUTPUT",
      stockItemId: item!.id,
      itemNo: remoteCode,
    })
    .returning();
  await db.insert(recipeLines).values({ menuItemId: menuItem!.id, ingredientId: item!.id, portionQty: "1", unit: "pcs" });
  await db.insert(menuItemOutlets).values({ menuItemId: menuItem!.id, locationId, stationId: station!.id });
  const [kitchenWh] = await db
    .insert(warehouses)
    .values({ locationId, type: "KITCHEN", purpose: "KITCHEN", code: `FPW-WH-${s}`, name: `FPW Kitchen ${s}` })
    .returning();
  await db.insert(inventoryStock).values({ warehouseId: kitchenWh!.id, ingredientId: item!.id, quantity: "1000" });
  return menuItem!.id;
}

function rawDispatchBody(overrides: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    token: `FPW-TOKEN-${s}`,
    code: `code-${s}`,
    expeditionType: "pickup",
    expiryDate: day(1),
    products: [{ name: "Dish", quantity: "2", remoteCode: `FPW-SKU-${s}` }],
    ...overrides,
  };
}

async function dispatch(remoteId: string, overrides: Record<string, unknown> = {}) {
  const body = orderDispatchBodySchema.parse(rawDispatchBody(overrides));
  const result = await handleDispatchOrder(db, { remoteId, body });
  return { body, remoteOrderId: result.remoteOrderId };
}

async function taskForReceipt(remoteOrderId: string) {
  const [task] = await db.select().from(foodpandaPluginOutboundTasks).where(eq(foodpandaPluginOutboundTasks.remoteOrderId, remoteOrderId));
  return task!;
}

async function receiptFor(remoteOrderId: string) {
  const [receipt] = await db.select().from(foodpandaPluginReceipts).where(eq(foodpandaPluginReceipts.remoteOrderId, remoteOrderId));
  return receipt!;
}

describe("runFoodpandaOutboundOnce — happy path", () => {
  it("maps, ingests, and marks the receipt PROCESSED + task DONE when every product maps to a menu item", async () => {
    const listing = await makeListing();
    const remoteCode = `FPW-MAPPED-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, remoteCode);
    const { body, remoteOrderId } = await dispatch(listing.remoteId, { products: [{ name: "Dish", quantity: "3", remoteCode }] });

    const client1 = fakeClient();
    const result = await runFoodpandaOutboundOnce(db, { client: client1, leaseOwner: `worker-${suffix()}` });
    expect(result.claimed).toBe(1);
    expect(result.done).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.dead).toBe(0);

    const receipt = await receiptFor(remoteOrderId);
    expect(receipt.state).toBe("PROCESSED");
    expect(receipt.orderId).toBeTruthy();
    expect(receipt.lastError).toBeNull();

    const task = await taskForReceipt(remoteOrderId);
    expect(task.status).toBe("DONE");

    // No callbackUrls supplied — notification falls back to the fixed updateOrderStatus(token, ...) endpoint.
    expect(client1.calls).toHaveLength(1);
    expect(client1.calls[0]!.method).toBe("updateOrderStatus");
    expect(client1.calls[0]!.args[0]).toBe(body.token);

    const [order] = await db.select().from(orders).where(eq(orders.externalRef, body.token));
    expect(order).toBeTruthy();
  });

  it("prefers the inbound-supplied callbackUrls.orderAcceptedUrl over the fixed endpoint when present", async () => {
    const listing = await makeListing();
    const remoteCode = `FPW-MAPPED-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, remoteCode);
    const { remoteOrderId } = await dispatch(listing.remoteId, {
      products: [{ name: "Dish", quantity: "1", remoteCode }],
      callbackUrls: { orderAcceptedUrl: "https://vendor.example.restaurant-partners.com/callback/accept" },
    });

    const client1 = fakeClient();
    await runFoodpandaOutboundOnce(db, { client: client1, leaseOwner: `worker-${suffix()}` });

    expect(client1.calls).toHaveLength(1);
    expect(client1.calls[0]!.method).toBe("postFoodpandaCallback");
    expect((await taskForReceipt(remoteOrderId)).status).toBe("DONE");
  });
});

describe("runFoodpandaOutboundOnce — unmapped product", () => {
  it("leaves the receipt WAITING_DEPENDENCY naming the unmapped code, and does NOT auto-accept", async () => {
    const listing = await makeListing();
    const unmappedCode = `FPW-UNMAPPED-${suffix()}`;
    const { remoteOrderId } = await dispatch(listing.remoteId, { products: [{ name: "Dish", quantity: "1", remoteCode: unmappedCode }] });

    const client1 = fakeClient();
    const result = await runFoodpandaOutboundOnce(db, { client: client1, leaseOwner: `worker-${suffix()}` });
    expect(result.claimed).toBe(1);
    expect(result.done).toBe(0);

    const receipt = await receiptFor(remoteOrderId);
    expect(receipt.state).toBe("WAITING_DEPENDENCY");
    expect(receipt.orderId).toBeNull();
    expect(receipt.lastError).toContain(unmappedCode);

    // Never auto-accepted — no notification call of any kind.
    expect(client1.calls).toHaveLength(0);
  });
});

describe("runFoodpandaOutboundOnce — lease-claim concurrency", () => {
  it("two concurrent calls process the same task exactly once (conditional-UPDATE claim, no double ingest)", async () => {
    const listing = await makeListing();
    const remoteCode = `FPW-RACE-${suffix()}`;
    await mapMenuItem(listing.locationId, listing.brandId, remoteCode);
    const { body, remoteOrderId } = await dispatch(listing.remoteId, { products: [{ name: "Dish", quantity: "1", remoteCode }] });

    const clientA = fakeClient();
    const clientB = fakeClient();
    const [resA, resB] = await Promise.allSettled([
      runFoodpandaOutboundOnce(db, { client: clientA, leaseOwner: "fpw-worker-A" }),
      runFoodpandaOutboundOnce(db, { client: clientB, leaseOwner: "fpw-worker-B" }),
    ]);
    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("fulfilled");

    const claimed = (resA as PromiseFulfilledResult<Awaited<ReturnType<typeof runFoodpandaOutboundOnce>>>).value.claimed
      + (resB as PromiseFulfilledResult<Awaited<ReturnType<typeof runFoodpandaOutboundOnce>>>).value.claimed;
    const done = (resA as PromiseFulfilledResult<Awaited<ReturnType<typeof runFoodpandaOutboundOnce>>>).value.done
      + (resB as PromiseFulfilledResult<Awaited<ReturnType<typeof runFoodpandaOutboundOnce>>>).value.done;
    expect(claimed).toBe(1);
    expect(done).toBe(1);

    const receipt = await receiptFor(remoteOrderId);
    expect(receipt.state).toBe("PROCESSED");

    const orderRows = await db.select().from(orders).where(eq(orders.externalRef, body.token));
    expect(orderRows).toHaveLength(1);

    const totalNotifyCalls = clientA.calls.length + clientB.calls.length;
    expect(totalNotifyCalls).toBe(1);
  });
});

describe("runFoodpandaOutboundOnce — bounded retry", () => {
  it("repeated mapping failures terminate in FAILED/DEAD rather than retrying forever", async () => {
    const listing = await makeListing();
    const unmappedCode = `FPW-NEVERMAP-${suffix()}`;
    const { remoteOrderId } = await dispatch(listing.remoteId, { products: [{ name: "Dish", quantity: "1", remoteCode: unmappedCode }] });

    let status = (await taskForReceipt(remoteOrderId)).status;
    // Force-clear next_attempt_at between forced attempts to unit-test the bounded-retry
    // OUTCOME deterministically, not real wall-clock backoff (mirrors
    // test/outbound-commands.test.ts's "exhausts bounded retries" pattern).
    for (let i = 0; i < 10 && status !== "FAILED" && status !== "DEAD"; i++) {
      await db.update(foodpandaPluginOutboundTasks).set({ nextAttemptAt: null }).where(eq(foodpandaPluginOutboundTasks.remoteOrderId, remoteOrderId));
      await runFoodpandaOutboundOnce(db, { client: fakeClient(), leaseOwner: `fpw-retry-${i}-${suffix()}` });
      status = (await taskForReceipt(remoteOrderId)).status;
    }

    expect(["FAILED", "DEAD"]).toContain(status);
    const finalTask = await taskForReceipt(remoteOrderId);
    expect(finalTask.lastError).toBeTruthy();

    // A further pass never touches a terminal row again.
    const attemptsAtTerminal = finalTask.attempts;
    await runFoodpandaOutboundOnce(db, { client: fakeClient(), leaseOwner: `fpw-retry-final-${suffix()}` });
    const afterExtraPass = await taskForReceipt(remoteOrderId);
    expect(afterExtraPass.attempts).toBe(attemptsAtTerminal);
    expect(afterExtraPass.status).toBe(status);
  });
});
