/**
 * Line resolution/validation for the Customer Order lifecycle service
 * (extracted from service.ts to keep that file's transition logic readable).
 * `resolveAndValidateLines` is the single place that turns caller-supplied
 * `CreateCustomerOrderLineInput[]` into DB-ready rows: UOM conversion,
 * server-derived baseQuantity/lineTotal, and the consumption-owner XOR check
 * for MADE_TO_ORDER lines.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { itemUomConversions } from "../../db/enterprise-schema.js";
import { bomHeaders, jobOrders } from "../../db/production-schema.js";
import { ingredients } from "../../db/schema.js";
import { DecimalValidationError, formatFixed, multiplyFixedExact, normalizeFixed, parseFixed } from "../stock/decimal.js";
import { CustomerOrderError } from "./errors.js";
import { CUSTOMER_ORDER_MAX_LINES, CUSTOMER_ORDER_MIN_LINES } from "./policies.js";
import type { ComponentRequirementsSnapshot, CreateCustomerOrderLineInput } from "./types.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Rounded (half-up) fixed-point multiplication (mirrors job-order-service.ts's
 * divideFixedRounded, but for the multiply direction): used only for line
 * pricing math (qty * unitPrice), which is a genuinely non-terminating
 * division-equivalent in general -- unlike baseQuantity's exact-conversion
 * requirement below, a rounded money result is the correct, expected
 * behavior here.
 */
function multiplyFixedRounded(
  leftStr: string | number,
  leftScale: number,
  rightStr: string | number,
  rightScale: number,
  outScale: number,
): string {
  const left = parseFixed(leftStr, leftScale);
  const right = parseFixed(rightStr, rightScale);
  const productScale = leftScale + rightScale;
  const product = left * right;
  if (productScale === outScale) return formatFixed(product, outScale);
  if (productScale < outScale) {
    return formatFixed(product * 10n ** BigInt(outScale - productScale), outScale);
  }
  const divisor = 10n ** BigInt(productScale - outScale);
  const quotient = product / divisor;
  const remainder = product % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return formatFixed(rounded, outScale);
}

export interface ResolvedLine {
  lineNo: number;
  itemId: string;
  enteredUom: string;
  enteredQuantity: string;
  conversionFactor: string;
  baseQuantity: string;
  unitPrice: string;
  taxAmount: string;
  discountAmount: string;
  lineTotal: string;
  consumptionMode: "STOCKED_OUTPUT" | "MADE_TO_ORDER";
  componentRequirementsSnapshot: ComponentRequirementsSnapshot | null;
  jobOrderId: string | null;
  remarks: string | null;
}

/**
 * Validates + resolves caller-supplied order lines: UOM conversion (mirrors
 * stock-returns/production's resolveAndValidateLines), server-derived
 * baseQuantity/lineTotal (never trusted from the client), and the
 * consumption-owner XOR for MADE_TO_ORDER lines (also enforced at the DB
 * level by `customer_order_line_consumption_owner_guard` -- this pre-check
 * exists purely to fail with a clearer typed error before hitting the DB).
 *
 * `componentRequirementsSnapshot` is accepted verbatim from the caller rather
 * than derived from a live BOM/recipe here: BOM/recipe resolution is
 * production module's own concern (see CreateJobOrderDraftInput's identical
 * choice to accept an explicit `bomVersionId` rather than resolving "current
 * active version" implicitly). Deriving a snapshot from a BOM would require
 * this module to depend on production-schema's BOM tables for a read-only
 * lookup that adds real complexity without changing any tested invariant;
 * the caller (a future menu/recipe-resolution layer) is expected to have
 * already resolved the current recipe by the time it calls this service.
 */
export async function resolveAndValidateLines(
  tx: Tx,
  locationId: string,
  lines: CreateCustomerOrderLineInput[],
): Promise<ResolvedLine[]> {
  if (lines.length < CUSTOMER_ORDER_MIN_LINES || lines.length > CUSTOMER_ORDER_MAX_LINES) {
    throw new CustomerOrderError(
      "VALIDATION",
      `A Customer Order must contain between ${CUSTOMER_ORDER_MIN_LINES} and ${CUSTOMER_ORDER_MAX_LINES} line(s).`,
      400,
    );
  }

  lines.forEach((line, index) => {
    if (!line.enteredUom.trim()) {
      throw new CustomerOrderError("VALIDATION", `Line ${index + 1} is missing an entered UOM.`, 400);
    }
    if (line.consumptionMode !== "STOCKED_OUTPUT" && line.consumptionMode !== "MADE_TO_ORDER") {
      throw new CustomerOrderError("VALIDATION", `Line ${index + 1} has an invalid consumption mode.`, 400);
    }
    const hasSnapshot = line.componentRequirementsSnapshot != null;
    const hasJobOrder = line.jobOrderId != null;
    if (line.consumptionMode === "STOCKED_OUTPUT" && (hasSnapshot || hasJobOrder)) {
      throw new CustomerOrderError(
        "CONSUMPTION_OWNER_INVALID",
        `Line ${index + 1} is STOCKED_OUTPUT but carries a component snapshot or linked Job Order.`,
        409,
      );
    }
    if (line.consumptionMode === "MADE_TO_ORDER" && hasSnapshot === hasJobOrder) {
      throw new CustomerOrderError(
        "CONSUMPTION_OWNER_INVALID",
        `Line ${index + 1} is MADE_TO_ORDER and must set EXACTLY ONE of componentRequirementsSnapshot / jobOrderId.`,
        409,
      );
    }
    if (hasSnapshot) {
      const components = line.componentRequirementsSnapshot?.components ?? [];
      if (components.length === 0) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1}'s component snapshot has no components.`, 400);
      }
      for (const component of components) {
        try {
          if (parseFixed(component.quantity, 6) <= 0n) {
            throw new CustomerOrderError(
              "VALIDATION",
              `Line ${index + 1}'s component ${component.itemId} quantity must be positive.`,
              400,
            );
          }
        } catch (error) {
          if (error instanceof CustomerOrderError) throw error;
          if (error instanceof DecimalValidationError) {
            throw new CustomerOrderError("VALIDATION", `Line ${index + 1}'s component ${component.itemId}: ${error.message}`, 400);
          }
          throw error;
        }
      }
    }
    try {
      if (parseFixed(line.enteredQuantity, 6) <= 0n) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1} quantity must be positive.`, 400);
      }
      if (parseFixed(line.unitPrice, 6) < 0n) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1} unit price must be non-negative.`, 400);
      }
      if (parseFixed(line.taxAmount ?? "0", 6) < 0n) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1} tax amount must be non-negative.`, 400);
      }
      if (parseFixed(line.discountAmount ?? "0", 6) < 0n) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1} discount amount must be non-negative.`, 400);
      }
    } catch (error) {
      if (error instanceof CustomerOrderError) throw error;
      if (error instanceof DecimalValidationError) {
        throw new CustomerOrderError("VALIDATION", `Line ${index + 1}: ${error.message}`, 400);
      }
      throw error;
    }
  });

  // Batch-fetch every item this order references (line items + every
  // snapshotted component item), so UOM conversion resolution below never
  // issues a query per component.
  const lineItemIds = lines.map((l) => l.itemId);
  const componentItemIds = lines.flatMap((l) => l.componentRequirementsSnapshot?.components.map((c) => c.itemId) ?? []);
  const itemIds = [...new Set([...lineItemIds, ...componentItemIds])];
  const itemRows = itemIds.length ? await tx.select().from(ingredients).where(inArray(ingredients.id, itemIds)) : [];
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));
  for (const itemId of itemIds) {
    const item = itemsById.get(itemId);
    if (!item || !item.isActive) {
      throw new CustomerOrderError("VALIDATION", `Item ${itemId} is missing or inactive.`, 409);
    }
  }

  const jobOrderIds = [...new Set(lines.map((l) => l.jobOrderId).filter((id): id is string => !!id))];
  const jobOrderRows = jobOrderIds.length ? await tx.select().from(jobOrders).where(inArray(jobOrders.id, jobOrderIds)) : [];
  const jobOrdersById = new Map(jobOrderRows.map((row) => [row.id, row]));
  const bomHeaderIds = [...new Set(jobOrderRows.map((row) => row.bomHeaderId))];
  const bomHeaderRows = bomHeaderIds.length ? await tx.select().from(bomHeaders).where(inArray(bomHeaders.id, bomHeaderIds)) : [];
  const bomHeadersById = new Map(bomHeaderRows.map((row) => [row.id, row]));

  const conversionByKey = new Map<string, string>();
  const conversionKeys = [
    ...new Set([
      ...lines.map((l) => `${l.itemId}:${l.enteredUom.trim().toLowerCase()}`),
      ...lines.flatMap((l) => (l.componentRequirementsSnapshot?.components ?? []).map((c) => `${c.itemId}:base`)),
    ]),
  ];
  for (const conversionKey of conversionKeys) {
    if (conversionKey.endsWith(":base")) continue; // component quantities are already base-uom (see ComponentRequirementLine doc comment)
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
      throw new CustomerOrderError("UOM_MISMATCH", `No active ${enteredUom} conversion exists for item ${itemId}.`, 409);
    }
    conversionByKey.set(conversionKey, normalizeFixed(conversion.toBaseFactor, 8));
  }

  const resolved: ResolvedLine[] = [];
  lines.forEach((line, index) => {
    if (line.jobOrderId) {
      const jobOrder = jobOrdersById.get(line.jobOrderId);
      if (!jobOrder) {
        throw new CustomerOrderError("NOT_FOUND", `Job Order ${line.jobOrderId} was not found.`, 404);
      }
      if (jobOrder.locationId !== locationId) {
        throw new CustomerOrderError(
          "CROSS_OUTLET",
          `Line ${index + 1}'s linked Job Order belongs to a different outlet than this Customer Order.`,
          409,
        );
      }
      const bomHeader = bomHeadersById.get(jobOrder.bomHeaderId);
      if (bomHeader && bomHeader.outputItemId !== line.itemId) {
        throw new CustomerOrderError(
          "VALIDATION",
          `Line ${index + 1}'s item does not match its linked Job Order's produced item.`,
          409,
        );
      }
    }

    const conversionKey = `${line.itemId}:${line.enteredUom.trim().toLowerCase()}`;
    const conversionFactor = conversionByKey.get(conversionKey)!;
    let baseQuantity: string;
    try {
      baseQuantity = multiplyFixedExact(line.enteredQuantity, 6, conversionFactor, 8, 6);
    } catch (error) {
      if (error instanceof DecimalValidationError) {
        throw new CustomerOrderError("UOM_MISMATCH", `Line ${index + 1}: ${error.message}`, 409);
      }
      throw error;
    }

    const enteredQuantity = normalizeFixed(line.enteredQuantity, 6);
    const unitPrice = normalizeFixed(line.unitPrice, 6);
    const taxAmount = normalizeFixed(line.taxAmount ?? "0", 6);
    const discountAmount = normalizeFixed(line.discountAmount ?? "0", 6);
    const gross = multiplyFixedRounded(enteredQuantity, 6, unitPrice, 6, 6);
    const lineTotalValue = parseFixed(gross, 6) + parseFixed(taxAmount, 6) - parseFixed(discountAmount, 6);
    if (lineTotalValue < 0n) {
      throw new CustomerOrderError("VALIDATION", `Line ${index + 1}'s discount exceeds its gross plus tax.`, 400);
    }

    resolved.push({
      lineNo: index + 1,
      itemId: line.itemId,
      enteredUom: line.enteredUom,
      enteredQuantity,
      conversionFactor,
      baseQuantity,
      unitPrice,
      taxAmount,
      discountAmount,
      lineTotal: formatFixed(lineTotalValue, 6),
      consumptionMode: line.consumptionMode,
      componentRequirementsSnapshot: line.componentRequirementsSnapshot ?? null,
      jobOrderId: line.jobOrderId ?? null,
      remarks: line.remarks ?? null,
    });
  });

  return resolved;
}
