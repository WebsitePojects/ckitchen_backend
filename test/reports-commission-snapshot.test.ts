/**
 * W4 -- reports.commission_snapshot flag coverage (spec section 10, audit gaps
 * B4/B5). Direct-service harness (no HTTP layer, no seed()) mirroring
 * test/orders-recipe-snapshot.test.ts -- this is the same class of
 * "flag-gated snapshot read" behavior, just for commission/net_sales instead
 * of recipe deduction.
 *
 * Core scenario (B4): an order is ingested while a channel_commercial_term
 * of 25 percent is in effect. That term is later ended and superseded by a
 * 30 percent term. The order's own aggregator_account.commission_rate
 * (legacy field, distinct from the term) is left at 10.00 throughout.
 *   - flag OFF -> getSalesReport uses the LIVE aggregator_account.commission_rate
 *     (10 percent) exactly as before W4 -- proves byte-equivalence, and proves
 *     flag-off is completely blind to channel_commercial_term.
 *   - flag ON  -> getSalesReport uses the order's frozen
 *     order.commission_rate_snapshot (25 percent, captured at ingest) --
 *     NEVER the superseding 30 percent term and NEVER the legacy 10 percent.
 *
 * Second scenario (B5): an order ingested for a listing with NEITHER a
 * channel_commercial_term row NOR a legacy commission_rate resolves a NULL
 * snapshot. That must surface as a non-zero orders_missing_commission_rate
 * count -- never a silently-assumed 0 percent with no visibility.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import { aggregatorAccounts, brands, kitchenStations, locations, menuItems, orders, warehouses } from "../src/db/schema.js";
import { channelCommercialTerms } from "../src/db/w4-schema.js";
import { advanceOrder, ingestOrder } from "../src/modules/orders/service.js";
import { getSalesReport, REPORTS_COMMISSION_SNAPSHOT_FLAG, type OutletFilter } from "../src/modules/reports/service.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let seq = 0;

const ALL_SCOPE: OutletFilter = { scope: "ALL", outletIds: [] };

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  client = created.client;
  await runMigrations(db);
});

afterAll(async () => {
  await closeDb(client);
});

async function setFlag(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, REPORTS_COMMISSION_SNAPSHOT_FLAG));
}

/** Fresh location + brand + RESOLVED listing + station + priced menu item (no recipe -- deduction/reservation stay empty). */
async function makeFixture(legacyCommissionRate: string | null) {
  const s = `RCS-${Date.now()}-${++seq}`;
  const [location] = await db
    .insert(locations)
    .values({ code: `${s}-LOC`, name: `Commission Snapshot ${s}` })
    .returning();
  const [brand] = await db
    .insert(brands)
    .values({ locationId: location!.id, name: `Commission Snapshot Brand ${s}`, color: "#ABCDEF", salesPerfId: `rcs-${s}` })
    .returning();
  const [listing] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand!.id,
      locationId: location!.id,
      mappingStatus: "RESOLVED",
      aggregator: "FOODPANDA",
      externalMerchantId: `FP-${s}`,
      commissionRate: legacyCommissionRate,
    })
    .returning();
  const [station] = await db
    .insert(kitchenStations)
    .values({ locationId: location!.id, name: `Grill ${s}` })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({ brandId: brand!.id, name: `Dish ${s}`, price: "1000.00", stationId: station!.id })
    .returning();
  // advanceOrder (NEW->PREPARING) requires a KITCHEN warehouse to exist for
  // the outlet even when the menu item carries no recipe lines (zero-line
  // deduction still needs somewhere to look).
  await db.insert(warehouses).values({ locationId: location!.id, type: "KITCHEN", purpose: "KITCHEN", code: `${s}-WH` });

  return { s, location: location!, brand: brand!, listing: listing!, station: station!, menuItem: menuItem! };
}

async function ingestAndComplete(
  listingId: string,
  brandId: string,
  menuItemId: string,
  externalRef: string,
  placedAt: string,
): Promise<string> {
  const result = await ingestOrder(db, {
    brand_id: brandId,
    aggregator_account_id: listingId,
    aggregator: "FOODPANDA",
    external_ref: externalRef,
    placed_at: placedAt,
    items: [{ menu_item_id: menuItemId, qty: 1 }],
  });
  const orderId = result.order_id;
  await advanceOrder(db, orderId); // NEW -> PREPARING
  await advanceOrder(db, orderId); // PREPARING -> READY
  await advanceOrder(db, orderId); // READY -> COMPLETED
  return orderId;
}

// ---------------------------------------------------------------------------
// B4 -- flag ON reads the order's frozen snapshot; flag OFF stays on the
// live aggregator_account.commission_rate join, blind to term changes.
// ---------------------------------------------------------------------------

describe("B4: commission snapshot vs live join", () => {
  it("flag OFF uses the live legacy commission_rate (10 percent); flag ON uses the frozen 25 percent snapshot, ignoring the later 30 percent term", async () => {
    const fx = await makeFixture("10.00");

    // A BASE term of 25 percent is in effect BEFORE the order is placed.
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: fx.listing.id,
      rateType: "BASE",
      percent: "25.00",
      effectiveFrom: "2026-01-01",
    });

    const orderId = await ingestAndComplete(
      fx.listing.id,
      fx.brand.id,
      fx.menuItem.id,
      `${fx.s}-REF`,
      "2026-02-10T09:00:00.000Z",
    );

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.commissionRateSnapshot).toBe("25.00");
    expect(order!.marketingRateSnapshot).toBeNull();

    // The term is later ended and superseded by 30 percent -- AFTER the
    // order was already ingested and snapshotted.
    await db
      .update(channelCommercialTerms)
      .set({ effectiveTo: "2026-02-28" })
      .where(eq(channelCommercialTerms.aggregatorAccountId, fx.listing.id));
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: fx.listing.id,
      rateType: "BASE",
      percent: "30.00",
      effectiveFrom: "2026-03-01",
    });

    const range = {
      from: new Date("2026-02-10T00:00:00.000Z"),
      to: new Date("2026-02-10T23:59:59.999Z"),
      groupBy: "day" as const,
      outletFilter: ALL_SCOPE,
    };

    await setFlag(false);
    const reportOff = await getSalesReport(db, range);
    expect(reportOff.totals.gross_sales).toBe(1000);
    expect(reportOff.totals.net_sales).toBe(900); // 1000 - 1000*10/100 (legacy live rate)
    expect(reportOff.orders_missing_commission_rate).toBe(0);

    await setFlag(true);
    const reportOn = await getSalesReport(db, range);
    expect(reportOn.totals.gross_sales).toBe(1000);
    expect(reportOn.totals.net_sales).toBe(750); // 1000 - 1000*25/100 (frozen snapshot, NOT 30, NOT 10)
    expect(reportOn.orders_missing_commission_rate).toBe(0);

    await setFlag(false);
  });
});

// ---------------------------------------------------------------------------
// B5 -- a NULL snapshot (no term, no legacy rate) is a visible finance
// exception (orders_missing_commission_rate), never a silent 0 percent.
// ---------------------------------------------------------------------------

describe("B5: missing-commission-rate finance exception", () => {
  it("surfaces a NULL snapshot as a non-zero orders_missing_commission_rate count in both flag modes", async () => {
    const fx = await makeFixture(null); // no legacy rate, no channel_commercial_term rows at all

    const orderId = await ingestAndComplete(
      fx.listing.id,
      fx.brand.id,
      fx.menuItem.id,
      `${fx.s}-REF`,
      "2026-04-05T09:00:00.000Z",
    );

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    // Hard rule: a NULL snapshot is NEVER coerced to "0.00" at write time.
    expect(order!.commissionRateSnapshot).toBeNull();
    expect(order!.marketingRateSnapshot).toBeNull();

    const range = {
      from: new Date("2026-04-05T00:00:00.000Z"),
      to: new Date("2026-04-05T23:59:59.999Z"),
      groupBy: "day" as const,
      outletFilter: ALL_SCOPE,
    };

    await setFlag(false);
    const reportOff = await getSalesReport(db, range);
    expect(reportOff.orders_missing_commission_rate).toBe(1);
    // Arithmetic itself is unchanged flag-off: COALESCE(live rate, 0) with a
    // NULL legacy rate -> gross == net, exactly the pre-W4 documented default.
    expect(reportOff.totals.gross_sales).toBe(1000);
    expect(reportOff.totals.net_sales).toBe(1000);

    await setFlag(true);
    const reportOn = await getSalesReport(db, range);
    expect(reportOn.orders_missing_commission_rate).toBe(1);
    // Same COALESCE(..., 0) arithmetic on the snapshot side -- the counter is
    // what makes it visible, not a different formula (see service.ts comment).
    expect(reportOn.totals.gross_sales).toBe(1000);
    expect(reportOn.totals.net_sales).toBe(1000);

    await setFlag(false);
  });
});

// ---------------------------------------------------------------------------
// Flag-off byte-equivalence sanity check -- toggling the flag on and back off
// around an unrelated report call must not perturb the live-JOIN result.
// ---------------------------------------------------------------------------

describe("flag-off byte-equivalence", () => {
  it("produces the identical net_sales figure before and after the flag has been toggled on and back off", async () => {
    const fx = await makeFixture("15.00");
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: fx.listing.id,
      rateType: "BASE",
      percent: "99.00", // deliberately far from the legacy rate -- would be very obvious if flag-off ever leaked snapshot data
      effectiveFrom: "2026-01-01",
    });

    await ingestAndComplete(fx.listing.id, fx.brand.id, fx.menuItem.id, `${fx.s}-REF`, "2026-05-20T09:00:00.000Z");

    const range = {
      from: new Date("2026-05-20T00:00:00.000Z"),
      to: new Date("2026-05-20T23:59:59.999Z"),
      groupBy: "day" as const,
      outletFilter: ALL_SCOPE,
    };

    await setFlag(false);
    const before = await getSalesReport(db, range);
    expect(before.totals.net_sales).toBe(850); // 1000 - 1000*15/100

    await setFlag(true);
    await getSalesReport(db, range); // exercise flag-on path in between

    await setFlag(false);
    const after = await getSalesReport(db, range);
    expect(after.totals.net_sales).toBe(850);
    expect(after).toEqual(before);
  });
});
