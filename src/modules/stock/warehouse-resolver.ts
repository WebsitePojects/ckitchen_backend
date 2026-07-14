import { and, eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { topologyMigrationExceptions } from "../../db/enterprise-schema.js";
import { warehouses, type Warehouse } from "../../db/schema.js";
import { StockPostingError } from "./errors.js";

export type EnterpriseWarehousePurpose = NonNullable<Warehouse["purpose"]>;

export async function resolveWarehouseForPurpose(
  db: DB,
  purpose: EnterpriseWarehousePurpose,
  locationId?: string,
  options: { allowLegacyFallback?: boolean } = {},
): Promise<Warehouse> {
  const purposeRows = await db
    .select()
    .from(warehouses)
    .where(
      locationId
        ? and(
            eq(warehouses.purpose, purpose),
            eq(warehouses.locationId, locationId),
            eq(warehouses.isActive, true),
          )
        : and(eq(warehouses.purpose, purpose), eq(warehouses.isActive, true)),
    );
  if (purposeRows.length === 1) return purposeRows[0]!;
  if (purposeRows.length > 1) {
    throw new StockPostingError(
      "FORBIDDEN_ROUTE",
      `Warehouse purpose ${purpose} is ambiguous${locationId ? ` at outlet ${locationId}` : ""}.`,
      409,
    );
  }

  if (options.allowLegacyFallback && locationId && ["OUTLET_STORAGE", "KITCHEN"].includes(purpose)) {
    const legacyType = purpose === "KITCHEN" ? "KITCHEN" : "MAIN";
    const legacyRows = await db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.locationId, locationId),
          eq(warehouses.type, legacyType),
          eq(warehouses.isActive, true),
        ),
      );
    if (legacyRows.length === 1) return legacyRows[0]!;
    if (legacyRows.length > 1) {
      throw new StockPostingError(
        "FORBIDDEN_ROUTE",
        `Legacy ${legacyType} warehouse resolution is ambiguous at outlet ${locationId}.`,
        409,
      );
    }
  }

  throw new StockPostingError(
    "FORBIDDEN_ROUTE",
    `No active ${purpose} warehouse is configured${locationId ? ` at outlet ${locationId}` : ""}.`,
    409,
  );
}

export async function assertEnterpriseTopologyReady(db: DB): Promise<void> {
  const hqRows = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.purpose, "HQ_MAIN"), eq(warehouses.isActive, true)));
  const openExceptions = await db
    .select({ id: topologyMigrationExceptions.id })
    .from(topologyMigrationExceptions)
    .where(eq(topologyMigrationExceptions.status, "OPEN"));
  if (hqRows.length !== 1 || openExceptions.length > 0) {
    throw new StockPostingError(
      "FEATURE_DISABLED",
      "Enterprise warehouse topology is not ready for stock posting.",
      503,
      { activeHqMainCount: hqRows.length, openTopologyExceptions: openExceptions.length },
    );
  }
}
