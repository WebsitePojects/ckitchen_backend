/**
 * Finds the problems the owner must hear about and keeps alert_event in step with them.
 *
 * Each rule returns the subjects that are a problem RIGHT NOW. New subjects open an alert
 * (the partial unique index on open alerts makes a repeated or concurrent scan a no-op);
 * open alerts whose subject is no longer a problem are resolved, so a later recurrence is a
 * new alert. Scanning, not hooking every stock write, means no stock path (orders, transfers,
 * adjustments, returns) can be forgotten.
 *
 * Bounded by design: low stock is at most one row per kitchen item, and the order rules only
 * look at the last 24 hours (order_status_placed_at_idx), so old test orders never alert.
 */
import { and, eq, gt, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  alertEvents,
  brands,
  ingredients,
  inventoryStock,
  locations,
  orders,
  warehouses,
  type AlertKind,
} from "../../db/schema.js";
import type { AlertSettings } from "./config.js";
import type { AlertDetails } from "./render.js";

const ORDER_LOOKBACK_MS = 24 * 60 * 60_000;

interface Finding {
  subjectId: string;
  locationId: string | null;
  details: AlertDetails;
}

async function lowStockFindings(db: DB): Promise<Finding[]> {
  const rows = await db
    .select({
      subjectId: inventoryStock.id,
      locationId: warehouses.locationId,
      item: ingredients.name,
      unit: ingredients.unit,
      quantity: inventoryStock.quantity,
      threshold: ingredients.lowStockThreshold,
      outlet: locations.name,
    })
    .from(inventoryStock)
    .innerJoin(warehouses, eq(warehouses.id, inventoryStock.warehouseId))
    .innerJoin(ingredients, eq(ingredients.id, inventoryStock.ingredientId))
    .innerJoin(locations, eq(locations.id, warehouses.locationId))
    .where(
      and(
        // Business rule 8: the kitchen warehouse is what cooks draw from.
        eq(warehouses.type, "KITCHEN"),
        eq(warehouses.isActive, true),
        eq(ingredients.isActive, true),
        // A threshold of 0 means "not tracked": otherwise every unused item at 0 would alert.
        sql`${ingredients.lowStockThreshold}::numeric > 0`,
        sql`${inventoryStock.quantity}::numeric <= ${ingredients.lowStockThreshold}::numeric`,
      ),
    );
  return rows.map(({ subjectId, locationId, ...details }) => ({ subjectId, locationId, details }));
}

async function orderFindings(db: DB, kind: "ORDER_UNATTENDED" | "ORDER_STUCK", settings: AlertSettings, now: Date): Promise<Finding[]> {
  const lookback = new Date(now.getTime() - ORDER_LOOKBACK_MS);
  const condition =
    kind === "ORDER_UNATTENDED"
      ? and(eq(orders.status, "NEW"), lte(orders.placedAt, new Date(now.getTime() - settings.unattendedMinutes * 60_000)))
      : and(eq(orders.status, "PREPARING"), lte(orders.prepAt, new Date(now.getTime() - settings.stuckMinutes * 60_000)));

  const rows = await db
    .select({
      subjectId: orders.id,
      locationId: orders.locationId,
      orderCode: orders.order_code,
      externalRef: orders.externalRef,
      brand: brands.name,
      outlet: locations.name,
      channel: orders.aggregator,
      placedAt: orders.placedAt,
      prepAt: orders.prepAt,
    })
    .from(orders)
    .innerJoin(brands, eq(brands.id, orders.brandId))
    .leftJoin(locations, eq(locations.id, orders.locationId))
    .where(and(condition, gt(orders.placedAt, lookback)));

  return rows.map((r) => ({
    subjectId: r.subjectId,
    locationId: r.locationId,
    details: {
      ref: r.orderCode ?? r.externalRef,
      brand: r.brand,
      outlet: r.outlet,
      channel: r.channel,
      placedAt: r.placedAt.toISOString(),
      prepAt: r.prepAt ? r.prepAt.toISOString() : null,
    },
  }));
}

async function sync(db: DB, kind: AlertKind, findings: Finding[], now: Date): Promise<{ opened: number; resolved: number }> {
  const current = findings.map((f) => f.subjectId);
  const resolved = await db
    .update(alertEvents)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(alertEvents.kind, kind),
        isNull(alertEvents.resolvedAt),
        current.length > 0 ? notInArray(alertEvents.subjectId, current) : undefined,
      ),
    )
    .returning({ id: alertEvents.id });

  if (findings.length === 0) return { opened: 0, resolved: resolved.length };
  const opened = await db
    .insert(alertEvents)
    .values(findings.map((f) => ({ kind, subjectId: f.subjectId, locationId: f.locationId, details: f.details, openedAt: now })))
    .onConflictDoNothing()
    .returning({ id: alertEvents.id });
  return { opened: opened.length, resolved: resolved.length };
}

export interface ScanResult {
  opened: number;
  resolved: number;
}

export async function scanForAlerts(db: DB, settings: AlertSettings, now: Date): Promise<ScanResult> {
  const results = [
    await sync(db, "LOW_STOCK", await lowStockFindings(db), now),
    await sync(db, "ORDER_UNATTENDED", await orderFindings(db, "ORDER_UNATTENDED", settings, now), now),
    await sync(db, "ORDER_STUCK", await orderFindings(db, "ORDER_STUCK", settings, now), now),
  ];
  return {
    opened: results.reduce((n, r) => n + r.opened, 0),
    resolved: results.reduce((n, r) => n + r.resolved, 0),
  };
}
