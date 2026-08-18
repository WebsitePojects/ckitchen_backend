/**
 * Anti-regression coverage for the REAL Delivery Hero Plugin API order shape.
 *
 * test/fixtures/foodpanda-generic-order.json is DH's own genericOrderExample.yaml
 * converted to JSON (Documents/foodpanda-api/pluginOrder.yaml). This file exists so
 * the rest of the Foodpanda test suite can never again drift back to the fabricated
 * shape the old tests were written against (top-level `orderId`/`orderToken`/`id`,
 * an `items[]` array — none of which exist in the real payload).
 *
 * Two known traps in the fixture (both deliberate, both DH's own placeholders):
 *   1. products[0].quantity is the literal string "string" — it does NOT parse as a
 *      number and MUST fail validation. Behavioural tests override it to a real
 *      numeric string ("2").
 *   2. expiryDate is 2016-03-14T17:15:00.000Z — a decade in the past. Nothing in
 *      orderDispatchBodySchema rejects a stale expiryDate (that is a worker/ops
 *      concern, not a shape concern), but any test that DOES care about freshness
 *      derives its own date from Date.now() rather than trusting the fixture's.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { orderDispatchBodySchema, orderToken } from "../src/modules/foodpanda/validation.js";

// Read via fs rather than a JSON import attribute — keeps this file free of any
// bundler-specific ESM import-assertion syntax so it runs identically under
// vitest's transform and any future toolchain.
const fixtureOrder: unknown = JSON.parse(readFileSync(new URL("./fixtures/foodpanda-generic-order.json", import.meta.url), "utf8"));

// No hardcoded calendar literals — every date a test depends on comes from Date.now().
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

type RawFixture = Record<string, unknown>;
type RawProduct = Record<string, unknown>;

function fixtureProducts(): RawProduct[] {
  return (fixtureOrder as RawFixture).products as RawProduct[];
}

/** The fixture's real shape, with the two known traps neutralized so it's usable as a behavioural test body. */
function realisticOrder(overrides: RawFixture = {}): RawFixture {
  const [firstProduct, ...restProducts] = fixtureProducts();
  return {
    ...(fixtureOrder as RawFixture),
    expiryDate: day(1),
    products: [{ ...firstProduct, quantity: "2" }, ...restProducts],
    ...overrides,
  };
}

describe("foodpanda-generic-order.json fixture shape", () => {
  it("still has the fields the implementation depends on", () => {
    const raw = fixtureOrder as RawFixture;
    expect(typeof raw.token).toBe("string");
    expect((raw.token as string).length).toBeGreaterThan(0);
    expect(typeof raw.code).toBe("string");
    expect(raw.expeditionType).toBe("pickup");
    expect(Array.isArray(raw.products)).toBe(true);
    expect((raw.products as unknown[]).length).toBeGreaterThan(0);

    const callbackUrls = raw.callbackUrls as RawFixture;
    expect(typeof callbackUrls.orderAcceptedUrl).toBe("string");
    expect(typeof callbackUrls.orderRejectedUrl).toBe("string");
  });

  it("does NOT have any of the fabricated fields the old tests invented (orderId/orderToken/id/items)", () => {
    const raw = fixtureOrder as RawFixture;
    expect(raw.orderId).toBeUndefined();
    expect(raw.orderToken).toBeUndefined();
    expect(raw.id).toBeUndefined();
    expect(raw.items).toBeUndefined();
  });

  it("documents trap #1: products[0].quantity is DH's literal placeholder string, not a real quantity", () => {
    expect(fixtureProducts()[0]!.quantity).toBe("string");
  });

  it("documents trap #2: expiryDate is a decade in the past", () => {
    const raw = fixtureOrder as RawFixture;
    expect(new Date(raw.expiryDate as string).getTime()).toBeLessThan(Date.now());
  });
});

describe("orderDispatchBodySchema against the real Delivery Hero shape", () => {
  it("rejects the raw fixture unmodified — the placeholder quantity correctly fails validation", () => {
    const parsed = orderDispatchBodySchema.safeParse(fixtureOrder);
    expect(parsed.success).toBe(false);
  });

  it("accepts the fixture once the placeholder quantity is overridden to a realistic numeric string", () => {
    const parsed = orderDispatchBodySchema.safeParse(realisticOrder());
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload missing token", () => {
    const body = realisticOrder();
    delete body.token;
    const parsed = orderDispatchBodySchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-numeric quantity", () => {
    const [firstProduct] = fixtureProducts();
    const body = realisticOrder({ products: [{ ...firstProduct, quantity: "not-a-number" }] });
    const parsed = orderDispatchBodySchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("fails closed on an unrecognized itemUnavailabilityHandling value", () => {
    const [firstProduct] = fixtureProducts();
    const body = realisticOrder({
      products: [{ ...firstProduct, quantity: "2", itemUnavailabilityHandling: "SUBSTITUTE_SILENTLY" }],
    });
    const parsed = orderDispatchBodySchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("accepts an unknown/new extra top-level field — pluginApi.yaml requires plugins to tolerate additive evolution", () => {
    const body = realisticOrder({ aFieldDeliveryHeroAddsNextQuarter: { nested: true, ok: 1 } });
    const parsed = orderDispatchBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("orderToken() returns the fixture's token, and passthrough preserves an unmodeled field (customer)", () => {
    const parsed = orderDispatchBodySchema.parse(realisticOrder());
    expect(orderToken(parsed)).toBe((fixtureOrder as RawFixture).token);

    const preservedCustomer = (parsed as RawFixture).customer as RawFixture;
    expect(preservedCustomer).toBeDefined();
    expect(preservedCustomer.email).toBe(((fixtureOrder as RawFixture).customer as RawFixture).email);
  });
});
