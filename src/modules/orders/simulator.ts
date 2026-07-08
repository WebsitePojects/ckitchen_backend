/**
 * Order Simulator — CK1-API-003 §7 ("POST /simulator/start|stop")
 *
 * Generates randomised FoodPanda / GrabFood orders at a configurable rate for
 * pilot demos.  The pure `generateOrderInput` function is separated from the
 * timer so it can be unit-tested without starting a setInterval.
 *
 * RBAC: start/stop require SUPER_ADMIN (enforced in routes.ts).
 *
 * S1 — realtime parity with the HTTP ingest route: the simulator calls
 * ingestOrder() directly (no HTTP layer), so it must emit the same socket
 * events itself. After a genuinely-new ingest it emits `order.created` (same
 * payload shape as routes.ts) and, when the order was accepted with a
 * shortfall, `stock.risk` — both to the BRAND'S OWN outlet room.
 */
import type { DB } from "../../db/client.js";
import { aggregatorAccounts, brands, menuItems } from "../../db/schema.js";
import { inArray } from "drizzle-orm";
import type { RealtimeHub } from "../../realtime/hub.js";
import { audit } from "../ems/audit.js";
import { ingestOrder, type IngestOrderInput } from "./service.js";

// ---------------------------------------------------------------------------
// Pure generator — no DB access, no timers, fully unit-testable
// ---------------------------------------------------------------------------

export interface SimulatorBrandData {
  brandId: string;
  aggregator: "FOODPANDA" | "GRABFOOD" | "OTHER";
  menuItemIds: string[];
}

/**
 * Produces a single normalized order input for one brand.
 * - Picks 1–3 random menu items from `menuItemIds`.
 * - Assigns a random qty (1–3) per item.
 * - Alternates aggregators via the caller-supplied `aggregator` field.
 * - Generates a unique `external_ref` (SIM-<timestamp>-<random>).
 *
 * Pure: no side effects, no I/O. Safe to call in tests without a DB.
 */
export function generateOrderInput(data: SimulatorBrandData): IngestOrderInput {
  const shuffled = [...data.menuItemIds].sort(() => Math.random() - 0.5);
  const count = Math.min(Math.floor(Math.random() * 3) + 1, shuffled.length);
  const selected = shuffled.slice(0, count);

  const externalRef = `SIM-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;

  return {
    brand_id: data.brandId,
    aggregator: data.aggregator,
    external_ref: externalRef,
    placed_at: new Date().toISOString(),
    items: selected.map((id) => ({
      menu_item_id: id,
      qty: Math.floor(Math.random() * 3) + 1,
    })),
  };
}

// ---------------------------------------------------------------------------
// Simulator state (module-level singleton — one simulator per server instance)
// ---------------------------------------------------------------------------

let simulatorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Last-known start parameters, kept alongside the timer so a page reload (or a
 * second admin tab) can restore "simulator running" state via GET
 * /simulator/status instead of guessing from silence. Cleared (brandIds=[],
 * ratePerMin=null) on stop.
 */
let simulatorBrandIds: string[] = [];
let simulatorRatePerMin: number | null = null;

/** True if the simulator is currently running. */
export function isSimulatorRunning(): boolean {
  return simulatorTimer !== null;
}

export interface SimulatorStatus {
  running: boolean;
  brand_ids: string[];
  rate_per_min: number | null;
}

/** Current simulator state, for GET /simulator/status (any authenticated user). */
export function getSimulatorStatus(): SimulatorStatus {
  return {
    running: simulatorTimer !== null,
    brand_ids: simulatorBrandIds,
    rate_per_min: simulatorRatePerMin,
  };
}

/**
 * Starts the simulator.  Every tick (60_000 / rate_per_min ms) it:
 *   1. Fetches menu items + aggregator accounts + home outlet for each brand_id.
 *   2. Picks a random brand, random aggregator (FOODPANDA / GRABFOOD), random items.
 *   3. Calls `ingestOrder` (the same service function used by the real ingest endpoint).
 *   4. S1 — emits `order.created` (and `stock.risk` when applicable) to the
 *      brand's outlet room, with the SAME payload shape the ingest route emits.
 *
 * Idempotent: calling start when already running silently replaces the timer.
 */
export function startSimulator(
  db: DB,
  hub: RealtimeHub,
  brandIds: string[],
  ratePerMin: number,
): void {
  // Clear any existing timer
  stopSimulator();

  simulatorBrandIds = brandIds;
  simulatorRatePerMin = ratePerMin;

  const intervalMs = Math.max(1000, Math.round(60_000 / ratePerMin));

  simulatorTimer = setInterval(async () => {
    try {
      // ── Build brand datasets (fetch fresh each tick in case menu changes) ─
      const allItems = await db
        .select({ id: menuItems.id, brandId: menuItems.brandId })
        .from(menuItems)
        .where(inArray(menuItems.brandId, brandIds));

      // Group items by brand
      const itemsByBrand = new Map<string, string[]>();
      for (const item of allItems) {
        const arr = itemsByBrand.get(item.brandId) ?? [];
        arr.push(item.id);
        itemsByBrand.set(item.brandId, arr);
      }

      // Fetch available aggregator accounts per brand
      const accounts = await db
        .select({ brandId: aggregatorAccounts.brandId, aggregator: aggregatorAccounts.aggregator })
        .from(aggregatorAccounts)
        .where(inArray(aggregatorAccounts.brandId, brandIds));

      const accountsByBrand = new Map<string, Array<"FOODPANDA" | "GRABFOOD" | "OTHER">>();
      for (const acc of accounts) {
        const arr = accountsByBrand.get(acc.brandId) ?? [];
        arr.push(acc.aggregator);
        accountsByBrand.set(acc.brandId, arr);
      }

      // S1 — each brand's home outlet (brand.location_id) so the events reach
      // the order's OWN room, mirroring the ingest route (S2).
      const brandRows = await db
        .select({ id: brands.id, locationId: brands.locationId })
        .from(brands)
        .where(inArray(brands.id, brandIds));
      const locationByBrand = new Map(brandRows.map((b) => [b.id, b.locationId]));

      // Pick a random brand that has both items and accounts
      const eligibleBrands = brandIds.filter(
        (id) => (itemsByBrand.get(id)?.length ?? 0) > 0 &&
                 (accountsByBrand.get(id)?.length ?? 0) > 0,
      );

      if (eligibleBrands.length === 0) return; // nothing to simulate yet

      const brandId = eligibleBrands[Math.floor(Math.random() * eligibleBrands.length)];
      const brandMenuItems = itemsByBrand.get(brandId)!;
      const brandAggregators = accountsByBrand.get(brandId)!;
      const aggregator = brandAggregators[Math.floor(Math.random() * brandAggregators.length)];

      const orderInput = generateOrderInput({
        brandId,
        aggregator,
        menuItemIds: brandMenuItems,
      });

      const result = await ingestOrder(db, orderInput);

      // Actor attribution: simulator-generated orders have no live request/user
      // behind them, so they are attributed to "System" (never left blank, never
      // spoofable — see docs/audit/audit-event-types.md). Skip the (practically
      // unreachable, since external_ref is timestamp+random) DUPLICATE_ORDER case
      // to mirror the real ingest route, which also only audits genuine creates.
      if (result.code !== "DUPLICATE_ORDER") {
        void audit(db, {
          actorUserId: null,
          actorName: "System",
          action: "order.create",
          description: `Order simulator generated order ${result.order_id} for brand ${brandId} via ${aggregator}`,
          entityType: "order",
          entityId: result.order_id,
          metadata: { source: "simulator", aggregator, brand_id: brandId },
        });

        // S1 — realtime parity with POST /ingest/order: without this, simulated
        // orders never appeared on the live dashboard until a manual refresh.
        const locationId = locationByBrand.get(brandId);
        if (locationId) {
          hub.emitToLocation(locationId, "order.created", {
            order_id: result.order_id,
            status: result.status,
            brand_id: brandId,
            aggregator,
            external_ref: orderInput.external_ref,
            customer_name: orderInput.customer_name ?? null,
            print_jobs: result.print_jobs,
          });

          // S4 — accepted-with-shortfall: same stock.risk event as the route.
          if (result.stock_risk && result.stock_risk.length > 0) {
            hub.emitToLocation(locationId, "stock.risk", {
              order_id: result.order_id,
              external_ref: orderInput.external_ref,
              brand_id: brandId,
              shortfalls: result.stock_risk,
            });
          }
        }
      }
    } catch {
      // Simulator errors are non-fatal; log but keep the timer running
      // (A proper production implementation would log to observability tooling)
    }
  }, intervalMs);
}

/** Stops the simulator and clears the timer. Idempotent. */
export function stopSimulator(): void {
  if (simulatorTimer !== null) {
    clearInterval(simulatorTimer);
    simulatorTimer = null;
  }
  simulatorBrandIds = [];
  simulatorRatePerMin = null;
}
