/**
 * W4 client-rules foundation schema tests (spec section 10 discounts/commercial
 * terms, section 6/7 order-line component snapshot mirror). Mirrors the
 * transfer-order-schema.test.ts harness: fresh in-memory PGlite DB, run the
 * real migration chain, assert columns/enums/constraints/triggers/seed rows
 * exist and behave as specified. Schema/migration-only scope -- no
 * service/route layer exists yet for this stream.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import {
  aggregatorAccounts,
  brands,
  kitchenStations,
  locations,
  menuItems,
  orderDiscounts,
  orderItems,
  orders,
  users,
} from "../src/db/schema.js";
import { channelCommercialTerms, discountEvidenceAccessLogs } from "../src/db/w4-schema.js";

let db: DB;
let client: ReturnType<typeof createDb>["client"];
let sequence = 0;

interface Fixture {
  locationId: string;
  brandId: string;
  aggregatorAccountId: string;
  stationId: string;
  menuItemId: string;
  actorUserId: string;
  orderId: string;
  orderItemId: string;
  orderDiscountId: string;
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
    .values({ code: `W4L${suffix}`, name: `W4 Location ${suffix}` })
    .returning();
  const [brand] = await db
    .insert(brands)
    .values({
      locationId: location.id,
      name: `W4 Brand ${suffix}`,
      color: "#123456",
      salesPerfId: `w4-${suffix}`,
    })
    .returning();
  const [aggregatorAccount] = await db
    .insert(aggregatorAccounts)
    .values({
      brandId: brand.id,
      locationId: location.id,
      aggregator: "FOODPANDA",
      externalMerchantId: `W4-EXT-${suffix}`,
    })
    .returning();
  const [station] = await db
    .insert(kitchenStations)
    .values({ locationId: location.id, name: `W4 Station ${suffix}` })
    .returning();
  const [menuItem] = await db
    .insert(menuItems)
    .values({ brandId: brand.id, name: `W4 Item ${suffix}`, price: "100.00", stationId: station.id })
    .returning();
  const [actor] = await db
    .insert(users)
    .values({
      name: `W4 Actor ${suffix}`,
      email: `w4-${suffix}@test.local`,
      passwordHash: "hash",
      role: "OWNER",
    })
    .returning();
  const [order] = await db
    .insert(orders)
    .values({
      brandId: brand.id,
      locationId: location.id,
      aggregatorAccountId: aggregatorAccount.id,
      aggregator: "FOODPANDA",
      externalRef: `W4-ORD-${suffix}`,
      total: "500.00",
    })
    .returning();
  const [orderItem] = await db
    .insert(orderItems)
    .values({ orderId: order.id, menuItemId: menuItem.id, qty: 1, stationId: station.id })
    .returning();
  const [orderDiscount] = await db
    .insert(orderDiscounts)
    .values({
      orderId: order.id,
      type: "SENIOR",
      label: "Senior citizen",
      amount: "50.00",
      approvalLevel: "AUTO",
      requestedBy: actor.id,
    })
    .returning();

  return {
    locationId: location.id,
    brandId: brand.id,
    aggregatorAccountId: aggregatorAccount.id,
    stationId: station.id,
    menuItemId: menuItem.id,
    actorUserId: actor.id,
    orderId: order.id,
    orderItemId: orderItem.id,
    orderDiscountId: orderDiscount.id,
  };
}

describe("W4 client-rules foundation schema (migration 0032)", () => {
  it("adds order_discount.evidence_ref as a nullable, writable column", async () => {
    const fx = await fixture();
    await db
      .update(orderDiscounts)
      .set({ evidenceRef: "private/evidence/key-1.jpg" })
      .where(eq(orderDiscounts.id, fx.orderDiscountId));
    const [row] = await db
      .select({ evidenceRef: orderDiscounts.evidenceRef })
      .from(orderDiscounts)
      .where(eq(orderDiscounts.id, fx.orderDiscountId));
    expect(row.evidenceRef).toBe("private/evidence/key-1.jpg");
  });

  it("records a discount_evidence_access_log row and keeps it append-only", async () => {
    const fx = await fixture();
    const [logRow] = await db
      .insert(discountEvidenceAccessLogs)
      .values({ orderDiscountId: fx.orderDiscountId, accessedBy: fx.actorUserId, purpose: "audit-review" })
      .returning();
    expect(logRow.purpose).toBe("audit-review");
    expect(logRow.accessedAt).toBeTruthy();

    await expect(
      db
        .update(discountEvidenceAccessLogs)
        .set({ purpose: "tampered" })
        .where(eq(discountEvidenceAccessLogs.id, logRow.id)),
    ).rejects.toThrow();

    await expect(
      db.delete(discountEvidenceAccessLogs).where(eq(discountEvidenceAccessLogs.id, logRow.id)),
    ).rejects.toThrow();
  });

  it("rejects an unknown order_discount_id or accessed_by FK on the access log", async () => {
    const fx = await fixture();
    await expect(
      db
        .insert(discountEvidenceAccessLogs)
        .values({ orderDiscountId: randomUUID(), accessedBy: fx.actorUserId, purpose: "x" }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(discountEvidenceAccessLogs)
        .values({ orderDiscountId: fx.orderDiscountId, accessedBy: randomUUID(), purpose: "x" }),
    ).rejects.toThrow();
  });

  it("defines the channel_commercial_term_rate_type enum with exactly BASE and MARKETING", async () => {
    const result = await client.query(
      "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY enumlabel",
      ["channel_commercial_term_rate_type"],
    );
    const labels = (result.rows as Array<{ enumlabel: string }>).map((r) => r.enumlabel);
    expect(labels).toEqual(["BASE", "MARKETING"]);
  });

  it("inserts a BASE channel_commercial_term and allows a non-overlapping BASE term for the same listing", async () => {
    const fx = await fixture();
    const [first] = await db
      .insert(channelCommercialTerms)
      .values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "BASE",
        percent: "25.00",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      })
      .returning();
    expect(first.percent).toBe("25.00");

    await expect(
      db.insert(channelCommercialTerms).values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "BASE",
        percent: "27.00",
        effectiveFrom: "2026-07-01",
      }),
    ).resolves.not.toThrow();
  });

  it("rejects an overlapping BASE term for the same listing (EXCLUDE USING gist)", async () => {
    const fx = await fixture();
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: fx.aggregatorAccountId,
      rateType: "BASE",
      percent: "25.00",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    });

    await expect(
      db.insert(channelCommercialTerms).values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "BASE",
        percent: "26.00",
        effectiveFrom: "2026-03-01",
      }),
    ).rejects.toThrow();
  });

  it("allows a MARKETING term to overlap a BASE term for the same listing and period", async () => {
    const fx = await fixture();
    await db.insert(channelCommercialTerms).values({
      aggregatorAccountId: fx.aggregatorAccountId,
      rateType: "BASE",
      percent: "25.00",
      effectiveFrom: "2026-01-01",
    });

    await expect(
      db.insert(channelCommercialTerms).values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "MARKETING",
        percent: "5.00",
        effectiveFrom: "2026-01-01",
      }),
    ).resolves.not.toThrow();
  });

  it("rejects a percent outside 0-100 and an effective_to before effective_from", async () => {
    const fx = await fixture();
    await expect(
      db.insert(channelCommercialTerms).values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "BASE",
        percent: "150.00",
        effectiveFrom: "2026-01-01",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(channelCommercialTerms).values({
        aggregatorAccountId: fx.aggregatorAccountId,
        rateType: "MARKETING",
        percent: "5.00",
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-01-01",
      }),
    ).rejects.toThrow();
  });

  it("adds order.commission_rate_snapshot / marketing_rate_snapshot as nullable, range-checked columns", async () => {
    const fx = await fixture();
    const [row] = await db.select().from(orders).where(eq(orders.id, fx.orderId));
    expect(row.commissionRateSnapshot).toBeNull();
    expect(row.marketingRateSnapshot).toBeNull();

    await db
      .update(orders)
      .set({ commissionRateSnapshot: "25.00", marketingRateSnapshot: "5.00" })
      .where(eq(orders.id, fx.orderId));
    const [updated] = await db.select().from(orders).where(eq(orders.id, fx.orderId));
    expect(updated.commissionRateSnapshot).toBe("25.00");
    expect(updated.marketingRateSnapshot).toBe("5.00");

    await expect(
      db.update(orders).set({ commissionRateSnapshot: "150.00" }).where(eq(orders.id, fx.orderId)),
    ).rejects.toThrow();
  });

  it("adds order_item.component_snapshot as a nullable, writable jsonb column", async () => {
    const fx = await fixture();
    const snapshot = [{ ingredientId: randomUUID(), portionQty: "200.000", uom: "g" }];
    await db
      .update(orderItems)
      .set({ componentSnapshot: snapshot })
      .where(eq(orderItems.id, fx.orderItemId));
    const [row] = await db.select().from(orderItems).where(eq(orderItems.id, fx.orderItemId));
    expect(row.componentSnapshot).toEqual(snapshot);
  });

  it("seeds the three W4 feature flags disabled by default", async () => {
    const rows = await db
      .select()
      .from(operationalFeatureFlags)
      .where(
        sql`${operationalFeatureFlags.key} IN ('discounts.strict_approval', 'reports.commission_snapshot', 'orders.legacy_recipe_snapshot')`,
      );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.enabled).toBe(false);
    }
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual([
      "discounts.strict_approval",
      "orders.legacy_recipe_snapshot",
      "reports.commission_snapshot",
    ]);
  });

  it("replays migration 0032 idempotently (running the full chain twice does not throw)", async () => {
    await expect(runMigrations(db)).resolves.not.toThrow();
  });
});