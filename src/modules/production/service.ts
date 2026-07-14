/**
 * BOM authoring/version-lifecycle service: header create, draft version
 * create, draft component authoring (full replace), activate, retire, plus
 * read (get/list). Deliberately excludes Job Order code and any posting/
 * inventory-mutation shapes — this module never touches
 * inventory_lot_balances or the central stock posting service.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { itemUomConversions, operationalFeatureFlags, outboxEvents } from "../../db/enterprise-schema.js";
import {
  bomComponents,
  bomHeaders,
  bomVersions,
  type BomComponent,
  type BomHeader,
  type BomVersion,
} from "../../db/production-schema.js";
import { auditLogs, ingredients, users, userSessions, type Ingredient, type Role } from "../../db/schema.js";
import { normalizeRole } from "../auth/roles.js";
import { DecimalValidationError, multiplyFixedExact, normalizeFixed, parseFixed } from "../stock/decimal.js";
import { StockProductionError } from "./errors.js";
import {
  ALLOWED_BOM_ITEM_TYPES,
  BOM_AUTO_RETIRE_ON_ACTIVATE,
  BOM_COMPONENT_MAX_LINES,
  BOM_COMPONENT_MIN_LINES,
  STOCK_PRODUCTION_FEATURE_KEY,
  STOCK_PRODUCTION_ROLES,
} from "./policies.js";
import type {
  ActivateVersionInput,
  BomComponentLineInput,
  BomHeaderWithVersions,
  BomVersionWithComponents,
  CreateBomHeaderInput,
  CreateDraftVersionInput,
  GetBomHeaderInput,
  GetBomVersionInput,
  ListBomHeadersInput,
  ListBomHeadersPage,
  ReplaceDraftComponentsInput,
  RetireVersionInput,
} from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const ALLOWED_ITEM_TYPES_SET = new Set<string>(ALLOWED_BOM_ITEM_TYPES);

interface ResolvedComponent {
  lineNo: number;
  componentItemId: string;
  componentUom: string;
  baseQuantity: string;
  scrapAllowancePct: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Detects a PostgreSQL unique-violation from pglite/postgres-js/drizzle errors. */
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object") {
      const cause = e["cause"] as Record<string, unknown>;
      if (cause["code"] === "23505") return true;
    }
  }
  return false;
}

async function authorizeActor(
  tx: Tx,
  actorUserId: string,
  sessionId: string | null | undefined,
  allowedRoles: readonly Role[],
  lock: boolean,
): Promise<{ id: string; name: string; role: Role }> {
  const query = tx
    .select({ id: users.id, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId));
  const rows = lock ? await query.for("update") : await query;
  const actor = rows[0];
  const role = normalizeRole(actor?.role);
  if (!actor || actor.status !== "ACTIVE" || !role || !allowedRoles.includes(role)) {
    throw new StockProductionError(
      "UNAUTHORIZED",
      "The authenticated actor is not permitted to perform this BOM operation.",
      403,
    );
  }

  if (sessionId) {
    const [session] = await tx
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.id, sessionId),
          eq(userSessions.userId, actor.id),
          sql`${userSessions.logoutAt} IS NULL`,
        ),
      );
    if (!session) {
      throw new StockProductionError("UNAUTHORIZED", "The actor session is not active.", 401);
    }
  }

  return { id: actor.id, name: actor.name, role };
}

async function assertFeatureEnabled(tx: Tx): Promise<void> {
  const [flag] = await tx
    .select()
    .from(operationalFeatureFlags)
    .where(eq(operationalFeatureFlags.key, STOCK_PRODUCTION_FEATURE_KEY))
    .for("update");
  if (!flag?.enabled) {
    throw new StockProductionError(
      "FEATURE_DISABLED",
      `Operational feature "${STOCK_PRODUCTION_FEATURE_KEY}" is disabled.`,
      503,
      { feature: STOCK_PRODUCTION_FEATURE_KEY },
    );
  }
}

/** Fetches an ingredient by id and validates it is active and BOM-eligible (RAW/WIP/FINISHED_GOOD/CONSUMABLE). */
async function fetchAndValidateItem(tx: Tx, itemId: string, roleLabel: string): Promise<Ingredient> {
  const [item] = await tx.select().from(ingredients).where(eq(ingredients.id, itemId));
  if (!item) {
    throw new StockProductionError("NOT_FOUND", `${roleLabel} item ${itemId} was not found.`, 404);
  }
  if (!item.isActive) {
    throw new StockProductionError("VALIDATION", `${roleLabel} item ${itemId} is inactive.`, 409);
  }
  if (!ALLOWED_ITEM_TYPES_SET.has(item.itemType)) {
    throw new StockProductionError(
      "TYPE_NOT_ALLOWED",
      `${roleLabel} item ${itemId} has item_type ${item.itemType}; must be one of ${ALLOWED_BOM_ITEM_TYPES.join(", ")}.`,
      409,
    );
  }
  return item;
}

/** Validates that `uom` is either the item's own base unit or has an active conversion. No quantity math. */
async function assertUomRecognized(tx: Tx, item: Ingredient, uom: string): Promise<void> {
  const trimmed = uom.trim();
  if (!trimmed) {
    throw new StockProductionError("VALIDATION", "A UOM is required.", 400);
  }
  if (item.unit.trim().toLowerCase() === trimmed.toLowerCase()) return;
  const [conversion] = await tx
    .select({ id: itemUomConversions.id })
    .from(itemUomConversions)
    .where(
      and(
        eq(itemUomConversions.itemId, item.id),
        sql`lower(${itemUomConversions.fromUom}) = ${trimmed.toLowerCase()}`,
        eq(itemUomConversions.isActive, true),
      ),
    );
  if (!conversion) {
    throw new StockProductionError(
      "UOM_MISMATCH",
      `No active "${trimmed}" conversion exists for item ${item.id}.`,
      409,
    );
  }
}

function parseDateOnly(value: string, field: string): string {
  const trimmed = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new StockProductionError("VALIDATION", `${field} must be a YYYY-MM-DD date string.`, 400);
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new StockProductionError("VALIDATION", `${field} is not a valid date.`, 400);
  }
  return trimmed;
}

/**
 * Validates 1..BOM_COMPONENT_MAX_LINES proposed component lines (no
 * duplicate item, no self-component), resolves each line's UOM conversion,
 * and computes the exact base quantity + normalized scrap percent. Mirrors
 * src/modules/stock-returns/service.ts resolveAndValidateLines's shape.
 */
async function resolveComponentLines(
  tx: Tx,
  headerOutputItemId: string,
  lines: BomComponentLineInput[],
): Promise<ResolvedComponent[]> {
  if (lines.length < BOM_COMPONENT_MIN_LINES || lines.length > BOM_COMPONENT_MAX_LINES) {
    throw new StockProductionError(
      "VALIDATION",
      `A BOM version must contain between ${BOM_COMPONENT_MIN_LINES} and ${BOM_COMPONENT_MAX_LINES} component line(s).`,
      400,
    );
  }

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.componentItemId)) {
      throw new StockProductionError(
        "DUPLICATE_LINE",
        `Duplicate component line for item ${line.componentItemId}.`,
        400,
        { componentItemId: line.componentItemId },
      );
    }
    seen.add(line.componentItemId);
    if (line.componentItemId === headerOutputItemId) {
      throw new StockProductionError(
        "SELF_COMPONENT",
        `Component item ${line.componentItemId} cannot be the BOM's own output item.`,
        409,
        { componentItemId: line.componentItemId },
      );
    }
    if (!line.enteredUom.trim()) {
      throw new StockProductionError(
        "VALIDATION",
        `Component ${line.componentItemId} is missing an entered UOM.`,
        400,
      );
    }
  }

  const itemIds = [...new Set(lines.map((line) => line.componentItemId))];
  const itemRows = await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds));
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));
  for (const itemId of itemIds) {
    const item = itemsById.get(itemId);
    if (!item) {
      throw new StockProductionError("NOT_FOUND", `Component item ${itemId} was not found.`, 404);
    }
    if (!item.isActive) {
      throw new StockProductionError("VALIDATION", `Component item ${itemId} is inactive.`, 409);
    }
    if (!ALLOWED_ITEM_TYPES_SET.has(item.itemType)) {
      throw new StockProductionError(
        "TYPE_NOT_ALLOWED",
        `Component item ${itemId} has item_type ${item.itemType}; must be one of ${ALLOWED_BOM_ITEM_TYPES.join(", ")}.`,
        409,
      );
    }
  }

  const conversionByKey = new Map<string, string>();
  const conversionKeys = [
    ...new Set(lines.map((line) => `${line.componentItemId}:${line.enteredUom.trim().toLowerCase()}`)),
  ];
  for (const conversionKey of conversionKeys) {
    const separator = conversionKey.indexOf(":");
    const itemId = conversionKey.slice(0, separator);
    const enteredUom = conversionKey.slice(separator + 1);
    const item = itemsById.get(itemId)!;
    if (item.unit.trim().toLowerCase() === enteredUom) {
      conversionByKey.set(conversionKey, "1.00000000");
      continue;
    }
    const [conversion] = await tx
      .select()
      .from(itemUomConversions)
      .where(
        and(
          eq(itemUomConversions.itemId, itemId),
          sql`lower(${itemUomConversions.fromUom}) = ${enteredUom}`,
          eq(itemUomConversions.isActive, true),
        ),
      );
    if (!conversion) {
      throw new StockProductionError(
        "UOM_MISMATCH",
        `No active "${enteredUom}" conversion exists for item ${itemId}.`,
        409,
      );
    }
    conversionByKey.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  const resolved: ResolvedComponent[] = [];
  lines.forEach((line, index) => {
    try {
      if (parseFixed(line.enteredQuantity, 6) <= 0n) {
        throw new StockProductionError(
          "VALIDATION",
          `Component ${line.componentItemId} quantity must be positive.`,
          400,
        );
      }
    } catch (error) {
      if (error instanceof StockProductionError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("VALIDATION", `Component ${line.componentItemId}: ${error.message}`, 400);
      }
      throw error;
    }

    const scrapInput = line.scrapAllowancePct ?? "0";
    let scrapAllowancePct: string;
    try {
      const scrapUnits = parseFixed(scrapInput, 4);
      if (scrapUnits < 0n || scrapUnits >= 1_000_000n) {
        throw new StockProductionError(
          "VALIDATION",
          `Component ${line.componentItemId} scrap allowance percent must be >= 0 and < 100.`,
          400,
        );
      }
      scrapAllowancePct = normalizeFixed(scrapInput, 4);
    } catch (error) {
      if (error instanceof StockProductionError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("VALIDATION", `Component ${line.componentItemId}: ${error.message}`, 400);
      }
      throw error;
    }

    const conversionKey = `${line.componentItemId}:${line.enteredUom.trim().toLowerCase()}`;
    const conversionFactor = conversionByKey.get(conversionKey)!;
    let baseQuantity: string;
    try {
      baseQuantity = multiplyFixedExact(line.enteredQuantity, 6, conversionFactor, 8, 6);
    } catch (error) {
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("UOM_MISMATCH", `Component ${line.componentItemId}: ${error.message}`, 409);
      }
      throw error;
    }

    resolved.push({
      lineNo: index + 1,
      componentItemId: line.componentItemId,
      componentUom: line.enteredUom,
      baseQuantity,
      scrapAllowancePct,
    });
  });

  return resolved;
}

/**
 * Builds the directed graph outputItemId -> componentItemId from every
 * bomVersion whose status IN ('ACTIVE','DRAFT') (excluding `excludeVersionId`
 * — the version currently being edited/activated, whose OLD component set
 * shouldn't count), adds the proposed edges on top, then checks whether
 * `outputItemId` can reach itself. In-memory BFS over a joined SELECT rather
 * than a recursive SQL CTE, per this module's design (small dataset, easier
 * to test/reason about).
 */
async function assertNoCycle(
  tx: Tx,
  outputItemId: string,
  excludeVersionId: string | null,
  proposedComponentItemIds: string[],
): Promise<void> {
  const rows = await tx
    .select({
      versionId: bomVersions.id,
      outputItemId: bomHeaders.outputItemId,
      componentItemId: bomComponents.componentItemId,
    })
    .from(bomVersions)
    .innerJoin(bomHeaders, eq(bomVersions.bomHeaderId, bomHeaders.id))
    .innerJoin(bomComponents, eq(bomComponents.bomVersionId, bomVersions.id))
    .where(inArray(bomVersions.status, ["ACTIVE", "DRAFT"]));

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    let set = adjacency.get(from);
    if (!set) {
      set = new Set();
      adjacency.set(from, set);
    }
    set.add(to);
  };

  for (const row of rows) {
    if (excludeVersionId && row.versionId === excludeVersionId) continue;
    addEdge(row.outputItemId, row.componentItemId);
  }
  for (const componentItemId of proposedComponentItemIds) {
    addEdge(outputItemId, componentItemId);
  }

  const start = adjacency.get(outputItemId) ?? new Set<string>();
  if (start.has(outputItemId)) {
    throw new StockProductionError(
      "CYCLE_DETECTED",
      `Adding this BOM would create a circular dependency: ${outputItemId} -> ${outputItemId}.`,
      409,
      { path: [outputItemId, outputItemId] },
    );
  }

  const parent = new Map<string, string>();
  const visited = new Set<string>([outputItemId]);
  const queue: string[] = [];
  for (const next of start) {
    parent.set(next, outputItemId);
    queue.push(next);
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (next === outputItemId) {
        const trail: string[] = [node];
        let cur = node;
        while (parent.has(cur) && parent.get(cur) !== outputItemId) {
          cur = parent.get(cur)!;
          trail.unshift(cur);
        }
        const fullPath = [outputItemId, ...trail, outputItemId];
        throw new StockProductionError(
          "CYCLE_DETECTED",
          `Adding this BOM would create a circular dependency: ${fullPath.join(" -> ")}.`,
          409,
          { path: fullPath },
        );
      }
      if (!visited.has(next)) {
        parent.set(next, node);
        queue.push(next);
      }
    }
  }
}

async function lockHeader(tx: Tx, bomHeaderId: string): Promise<BomHeader> {
  const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, bomHeaderId)).for("update");
  if (!header) {
    throw new StockProductionError("NOT_FOUND", `BOM header ${bomHeaderId} was not found.`, 404);
  }
  return header;
}

async function lockVersion(tx: Tx, bomVersionId: string): Promise<BomVersion> {
  const [version] = await tx.select().from(bomVersions).where(eq(bomVersions.id, bomVersionId)).for("update");
  if (!version) {
    throw new StockProductionError("NOT_FOUND", `BOM version ${bomVersionId} was not found.`, 404);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Exported lifecycle functions
// ---------------------------------------------------------------------------

export async function createBomHeader(db: DB, input: CreateBomHeaderInput): Promise<BomHeader> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, true);

    const code = input.code.trim();
    const name = input.name.trim();
    if (!code) {
      throw new StockProductionError("VALIDATION", "A BOM header code is required.", 400);
    }
    if (!name) {
      throw new StockProductionError("VALIDATION", "A BOM header name is required.", 400);
    }

    const outputItem = await fetchAndValidateItem(tx, input.outputItemId, "Output");

    const [existing] = await tx.select({ id: bomHeaders.id }).from(bomHeaders).where(eq(bomHeaders.code, code));
    if (existing) {
      throw new StockProductionError("VALIDATION", `BOM header code "${code}" is already in use.`, 409, { code });
    }

    let header: BomHeader;
    try {
      const [inserted] = await tx
        .insert(bomHeaders)
        .values({
          code,
          name,
          outputItemId: outputItem.id,
          productionMode: input.productionMode ?? "MADE_TO_ORDER",
          createdBy: actor.id,
        })
        .returning();
      header = inserted!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StockProductionError("VALIDATION", `BOM header code "${code}" is already in use.`, 409, { code });
      }
      throw error;
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      action: "bom.header.created",
      description: `Created BOM header ${header.code} (${header.name}).`,
      entityType: "bom_header",
      entityId: header.id,
    });

    return header;
  });
}

export async function createDraftVersion(db: DB, input: CreateDraftVersionInput): Promise<BomVersion> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, true);

    const header = await lockHeader(tx, input.bomHeaderId);
    const outputItem = await fetchAndValidateItem(tx, header.outputItemId, "Output");
    await assertUomRecognized(tx, outputItem, input.outputUom);

    let outputYieldQty: string;
    try {
      const units = parseFixed(input.outputYieldQty, 6);
      if (units <= 0n) {
        throw new StockProductionError("VALIDATION", "Output yield quantity must be positive.", 400);
      }
      outputYieldQty = normalizeFixed(input.outputYieldQty, 6);
    } catch (error) {
      if (error instanceof StockProductionError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new StockProductionError("VALIDATION", `Output yield quantity: ${error.message}`, 400);
      }
      throw error;
    }

    const effectiveFrom = parseDateOnly(input.effectiveFrom, "effectiveFrom");
    let effectiveTo: string | null = null;
    if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
      effectiveTo = parseDateOnly(input.effectiveTo, "effectiveTo");
      if (effectiveTo <= effectiveFrom) {
        throw new StockProductionError("VALIDATION", "effectiveTo must be strictly after effectiveFrom.", 400);
      }
    }

    const [{ maxVersionNo }] = await tx
      .select({ maxVersionNo: sql<number | null>`max(${bomVersions.versionNo})` })
      .from(bomVersions)
      .where(eq(bomVersions.bomHeaderId, header.id));
    const nextVersionNo = (maxVersionNo ?? 0) + 1;

    const [version] = await tx
      .insert(bomVersions)
      .values({
        bomHeaderId: header.id,
        versionNo: nextVersionNo,
        outputUom: input.outputUom.trim(),
        outputYieldQty,
        effectiveFrom,
        effectiveTo,
        remarks: input.remarks ?? null,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      action: "bom.version.created",
      description: `Created BOM version ${version!.versionNo} for header ${header.code}.`,
      entityType: "bom_version",
      entityId: version!.id,
    });

    return version!;
  });
}

export async function replaceDraftComponents(db: DB, input: ReplaceDraftComponentsInput): Promise<BomComponent[]> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, true);

    const version = await lockVersion(tx, input.bomVersionId);
    if (version.status !== "DRAFT") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `BOM version ${version.id} is ${version.status}; components may only be edited while DRAFT.`,
        409,
      );
    }

    const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, version.bomHeaderId));
    if (!header) {
      throw new StockProductionError("NOT_FOUND", `BOM header ${version.bomHeaderId} was not found.`, 404);
    }

    const resolvedLines = await resolveComponentLines(tx, header.outputItemId, input.lines);

    await assertNoCycle(
      tx,
      header.outputItemId,
      version.id,
      resolvedLines.map((line) => line.componentItemId),
    );

    await tx.delete(bomComponents).where(eq(bomComponents.bomVersionId, version.id));
    const inserted = await tx
      .insert(bomComponents)
      .values(resolvedLines.map((line) => ({ ...line, bomVersionId: version.id })))
      .returning();
    inserted.sort((a, b) => a.lineNo - b.lineNo);

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      action: "bom.version.components_replaced",
      description: `Replaced components for BOM version ${version.id} with ${inserted.length} line(s).`,
      entityType: "bom_version",
      entityId: version.id,
    });

    return inserted;
  });
}

export async function activateVersion(db: DB, input: ActivateVersionInput): Promise<BomVersion> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, true);

    const version = await lockVersion(tx, input.bomVersionId);
    if (version.status !== "DRAFT") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `BOM version ${version.id} is ${version.status}; expected DRAFT.`,
        409,
      );
    }

    const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, version.bomHeaderId)).for("update");
    if (!header) {
      throw new StockProductionError("NOT_FOUND", `BOM header ${version.bomHeaderId} was not found.`, 404);
    }

    const components = await tx
      .select()
      .from(bomComponents)
      .where(eq(bomComponents.bomVersionId, version.id))
      .orderBy(asc(bomComponents.lineNo));
    if (components.length === 0) {
      throw new StockProductionError("VALIDATION", "Cannot activate a BOM version with no components.", 400);
    }

    // Re-validate output + every component item is still active/allowed type
    // (the graph may have shifted since the draft was authored).
    await fetchAndValidateItem(tx, header.outputItemId, "Output");
    for (const component of components) {
      await fetchAndValidateItem(tx, component.componentItemId, "Component");
    }

    await assertNoCycle(
      tx,
      header.outputItemId,
      version.id,
      components.map((component) => component.componentItemId),
    );

    const [currentActive] = await tx
      .select()
      .from(bomVersions)
      .where(and(eq(bomVersions.bomHeaderId, header.id), eq(bomVersions.status, "ACTIVE")))
      .for("update");

    if (currentActive) {
      if (!BOM_AUTO_RETIRE_ON_ACTIVATE) {
        throw new StockProductionError(
          "INVALID_TRANSITION",
          `BOM header ${header.code} already has an active version (${currentActive.id}).`,
          409,
        );
      }
      const [retired] = await tx
        .update(bomVersions)
        .set({ status: "RETIRED", updatedAt: new Date() })
        .where(and(eq(bomVersions.id, currentActive.id), eq(bomVersions.status, "ACTIVE")))
        .returning();
      if (!retired) {
        throw new StockProductionError(
          "CONCURRENT_MODIFICATION",
          `BOM version ${currentActive.id} changed concurrently.`,
          409,
        );
      }
      await tx.insert(auditLogs).values({
        actorUserId: actor.id,
        actorName: actor.name,
        sessionId: input.sessionId ?? null,
        action: "bom.version.retired",
        description: `Auto-retired BOM version ${retired.versionNo} for header ${header.code} on activation of version ${version.versionNo}.`,
        entityType: "bom_version",
        entityId: retired.id,
      });
    }

    const [activated] = await tx
      .update(bomVersions)
      .set({ status: "ACTIVE", approvedBy: actor.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bomVersions.id, version.id), eq(bomVersions.status, "DRAFT")))
      .returning();
    if (!activated) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `BOM version ${version.id} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      action: "bom.version.activated",
      description: `Activated BOM version ${activated.versionNo} for header ${header.code}.`,
      entityType: "bom_version",
      entityId: activated.id,
    });

    await tx
      .insert(outboxEvents)
      .values({
        eventType: "bom_version.activated",
        aggregateType: "bom_version",
        aggregateId: activated.id,
        locationId: null,
        correlationId: activated.id,
        payload: {
          bomHeaderId: header.id,
          versionNo: activated.versionNo,
          previousActiveVersionId: currentActive?.id ?? null,
        },
      })
      .onConflictDoNothing();

    return activated;
  });
}

export async function retireVersion(db: DB, input: RetireVersionInput): Promise<BomVersion> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx);
    const actor = await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, true);

    const version = await lockVersion(tx, input.bomVersionId);
    if (version.status !== "ACTIVE") {
      throw new StockProductionError(
        "INVALID_TRANSITION",
        `BOM version ${version.id} is ${version.status}; expected ACTIVE.`,
        409,
      );
    }

    const [retired] = await tx
      .update(bomVersions)
      .set({ status: "RETIRED", updatedAt: new Date() })
      .where(and(eq(bomVersions.id, version.id), eq(bomVersions.status, "ACTIVE")))
      .returning();
    if (!retired) {
      throw new StockProductionError(
        "CONCURRENT_MODIFICATION",
        `BOM version ${version.id} changed concurrently.`,
        409,
      );
    }

    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      actorName: actor.name,
      sessionId: input.sessionId ?? null,
      action: "bom.version.retired",
      description: `Retired BOM version ${retired.versionNo}.`,
      entityType: "bom_version",
      entityId: retired.id,
    });

    await tx
      .insert(outboxEvents)
      .values({
        eventType: "bom_version.retired",
        aggregateType: "bom_version",
        aggregateId: retired.id,
        locationId: null,
        correlationId: retired.id,
        payload: { bomHeaderId: retired.bomHeaderId, versionNo: retired.versionNo },
      })
      .onConflictDoNothing();

    return retired;
  });
}

export async function getBomHeader(db: DB, input: GetBomHeaderInput): Promise<BomHeaderWithVersions> {
  return db.transaction(async (tx) => {
    await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, false);

    const [header] = await tx.select().from(bomHeaders).where(eq(bomHeaders.id, input.bomHeaderId));
    if (!header) {
      throw new StockProductionError("NOT_FOUND", `BOM header ${input.bomHeaderId} was not found.`, 404);
    }
    const versions = await tx
      .select()
      .from(bomVersions)
      .where(eq(bomVersions.bomHeaderId, header.id))
      .orderBy(desc(bomVersions.versionNo));

    return { ...header, versions };
  });
}

export async function getBomVersion(db: DB, input: GetBomVersionInput): Promise<BomVersionWithComponents> {
  return db.transaction(async (tx) => {
    await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, false);

    const [version] = await tx.select().from(bomVersions).where(eq(bomVersions.id, input.bomVersionId));
    if (!version) {
      throw new StockProductionError("NOT_FOUND", `BOM version ${input.bomVersionId} was not found.`, 404);
    }
    const components = await tx
      .select()
      .from(bomComponents)
      .where(eq(bomComponents.bomVersionId, version.id))
      .orderBy(asc(bomComponents.lineNo));

    return { ...version, components };
  });
}

export async function listBomHeaders(db: DB, input: ListBomHeadersInput): Promise<ListBomHeadersPage> {
  return db.transaction(async (tx) => {
    await authorizeActor(tx, input.actorUserId, input.sessionId, STOCK_PRODUCTION_ROLES, false);

    const conditions = [];
    if (input.outputItemId) {
      conditions.push(eq(bomHeaders.outputItemId, input.outputItemId));
    }
    if (input.isActive !== undefined) {
      conditions.push(eq(bomHeaders.isActive, input.isActive));
    }
    if (input.search?.trim()) {
      const term = `%${input.search.trim()}%`;
      conditions.push(or(ilike(bomHeaders.code, term), ilike(bomHeaders.name, term)));
    }

    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = input.offset ?? 0;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const baseQuery = tx.select().from(bomHeaders);
    const items = await (whereClause
      ? baseQuery.where(whereClause).orderBy(desc(bomHeaders.createdAt))
      : baseQuery.orderBy(desc(bomHeaders.createdAt))
    )
      .limit(limit)
      .offset(offset);

    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(bomHeaders)
      .where(whereClause ?? sql`true`);

    return { items, total: row?.count ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

interface BomActorContext {
  actorUserId: string;
  sessionId?: string | null;
}

type CreateHeaderServiceInput = Omit<CreateBomHeaderInput, "actorUserId" | "sessionId">;
type CreateDraftVersionServiceInput = Omit<CreateDraftVersionInput, "actorUserId" | "sessionId">;
type ReplaceDraftComponentsServiceInput = Omit<ReplaceDraftComponentsInput, "actorUserId" | "sessionId">;
type ActivateVersionServiceInput = Omit<ActivateVersionInput, "actorUserId" | "sessionId">;
type RetireVersionServiceInput = Omit<RetireVersionInput, "actorUserId" | "sessionId">;
type GetHeaderServiceInput = Omit<GetBomHeaderInput, "actorUserId" | "sessionId">;
type GetVersionServiceInput = Omit<GetBomVersionInput, "actorUserId" | "sessionId">;
type ListHeadersServiceInput = Omit<ListBomHeadersInput, "actorUserId" | "sessionId">;

/** Facade over the standalone lifecycle functions above. */
export function createBomService(db: DB) {
  return {
    createHeader(ctx: BomActorContext, input: CreateHeaderServiceInput) {
      return createBomHeader(db, { ...ctx, ...input });
    },
    createDraftVersion(ctx: BomActorContext, input: CreateDraftVersionServiceInput) {
      return createDraftVersion(db, { ...ctx, ...input });
    },
    replaceDraftComponents(ctx: BomActorContext, input: ReplaceDraftComponentsServiceInput) {
      return replaceDraftComponents(db, { ...ctx, ...input });
    },
    activateVersion(ctx: BomActorContext, input: ActivateVersionServiceInput) {
      return activateVersion(db, { ...ctx, ...input });
    },
    retireVersion(ctx: BomActorContext, input: RetireVersionServiceInput) {
      return retireVersion(db, { ...ctx, ...input });
    },
    getHeader(ctx: BomActorContext, input: GetHeaderServiceInput) {
      return getBomHeader(db, { ...ctx, ...input });
    },
    getVersion(ctx: BomActorContext, input: GetVersionServiceInput) {
      return getBomVersion(db, { ...ctx, ...input });
    },
    listHeaders(ctx: BomActorContext, input: ListHeadersServiceInput) {
      return listBomHeaders(db, { ...ctx, ...input });
    },
  };
}
