import { z } from "zod";

const MAX_ID_LEN = 200;
const MAX_CALLBACK_LEN = 120;
const MAX_MESSAGE_LEN = 1000;

// pluginOrder.yaml Token/Code maxLength.
const MAX_TOKEN_LEN = 512;
const MAX_CODE_LEN = 255;
// Generous bound for callbackUrls.* — pluginOrder.yaml only says `type: string`,
// no maxLength; these are real DH-issued URLs that may carry an order-scoped
// query-string token, so we bound rather than reject on shape.
const MAX_CALLBACK_URL_LEN = 2048;

export const boundedId = z.string().trim().min(1).max(MAX_ID_LEN);
export const boundedCallback = z.string().trim().min(1).max(MAX_CALLBACK_LEN).regex(/^[A-Za-z0-9._~-]+$/);
export const isoDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid date-time string.");

const looseObject = z.object({}).catchall(z.unknown());

// ---------------------------------------------------------------------------
// Order dispatch — rewritten against pluginOrder.yaml's Order schema.
//
// pluginApi.yaml is explicit that "order processing is continuously
// evolving" and plugins "MUST be capable to ignore additional properties" —
// so every object here stays passthrough (never .strict()) except where a
// bug fix specifically requires a fail-closed enum (itemUnavailabilityHandling,
// availability closure `reason`).
// ---------------------------------------------------------------------------

/** pluginOrder.yaml `ItemUnavailabilityHandling` — product- and topping-level. Fail-closed: an unrecognized value is a validation rejection, not a silent pass-through. */
export const itemUnavailabilityHandlingSchema = z.enum(["REMOVE", "REDUCE_QUANTITY", "CALL_CUSTOMER_AND_REPLACE", "CANCEL_ORDER"]);
export type ItemUnavailabilityHandling = z.infer<typeof itemUnavailabilityHandlingSchema>;

/**
 * Summary sentinel for an order whose items carry DIFFERENT handling options and none of them is
 * CANCEL_ORDER. Stored in the `item_unavailability_handling` text column, which is deliberately
 * text rather than an enum so this value is representable.
 */
export const MIXED_ITEM_UNAVAILABILITY_HANDLING = "MIXED" as const;
export type ResolvedItemUnavailabilityHandling = ItemUnavailabilityHandling | typeof MIXED_ITEM_UNAVAILABILITY_HANDLING;

/** pluginOrder.yaml `quantity` on Product — a numeric STRING, not a number. Fail closed on anything that doesn't parse to a finite number > 0. */
const quantityStringSchema = z.string().trim().min(1).refine((value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}, "quantity must be a numeric string greater than 0.");

/** pluginOrder.yaml `Discount` — only `amount` is required by spec; everything else (sponsorships, name, type) is display-only and left passthrough. */
const discountSchema = z.object({ amount: z.unknown() }).catchall(z.unknown());

/**
 * pluginOrder.yaml `Topping` — recursive: "A topping might be a composition
 * of multiple toppings... nested up to 5 levels" via `children`. Needs
 * z.lazy() because the schema references itself.
 */
export interface ToppingInput {
  name?: string;
  price?: string;
  quantity?: string | number;
  remoteCode?: string | null;
  sku?: string;
  type?: "PRODUCT" | "VARIANT" | "EXTRA";
  itemUnavailabilityHandling?: ItemUnavailabilityHandling;
  discounts?: unknown[];
  children?: ToppingInput[];
  [key: string]: unknown;
}

const toppingSchema: z.ZodType<ToppingInput> = z.lazy(() =>
  z
    .object({
      name: z.string().optional(),
      price: z.string().optional(),
      quantity: z.union([z.string(), z.number()]).optional(),
      remoteCode: z.string().nullable().optional(),
      sku: z.string().optional(),
      type: z.enum(["PRODUCT", "VARIANT", "EXTRA"]).optional(),
      itemUnavailabilityHandling: itemUnavailabilityHandlingSchema.optional(),
      discounts: z.array(discountSchema).optional(),
      children: z.array(toppingSchema).optional(),
    })
    .passthrough(),
);

/** pluginOrder.yaml `Product`. `remoteCode` is nullable (may be absent when the plugin doesn't need POS-side ids); `sku` is a separate, independently-optional identifier. */
const productSchema = z
  .object({
    id: z.string().optional(),
    categoryName: z.string().nullable().optional(),
    name: z.string().optional(),
    paidPrice: z.string().optional(),
    quantity: quantityStringSchema,
    remoteCode: z.string().nullable().optional(),
    sku: z.string().optional(),
    selectedToppings: z.array(toppingSchema).optional(),
    unitPrice: z.string().optional(),
    comment: z.string().nullable().optional(),
    itemUnavailabilityHandling: itemUnavailabilityHandlingSchema.optional(),
    variation: z.object({ name: z.string().optional() }).passthrough().optional(),
    discounts: z.array(discountSchema).optional(),
  })
  .passthrough();
export type ProductInput = z.infer<typeof productSchema>;

/** pluginOrder.yaml `CallbackUrls` — all optional; a Delivery Hero notification may only include the subset applicable to the order type. */
const callbackUrlsSchema = z
  .object({
    orderAcceptedUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
    orderRejectedUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
    orderProductModificationUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
    orderPickedUpUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
    orderPreparedUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
    orderPreparationTimeAdjustmentUrl: z.string().trim().min(1).max(MAX_CALLBACK_URL_LEN).optional(),
  })
  .passthrough();
export type CallbackUrls = z.infer<typeof callbackUrlsSchema>;

export const orderDispatchBodySchema = looseObject
  .extend({
    // pluginOrder.yaml `Token` — unique id of the order in POS middleware.
    // This is the REAL top-level order identifier (bug fix: the previous
    // schema looked for orderId/orderToken/id, none of which exist).
    token: z.string().trim().min(1).max(MAX_TOKEN_LEN),
    // pluginOrder.yaml `Code` — the platform-side order id (e.g. "n0s1-w0k1").
    // A DIFFERENT field from `token`; kept for display/support only.
    code: z.string().trim().min(1).max(MAX_CODE_LEN).optional(),
    expeditionType: z.enum(["pickup", "delivery"]),
    // Accept/reject deadline. Missing it auto-cancels the order and repeated
    // misses close the vendor — persisted (validation.ts callers must not drop it).
    expiryDate: isoDateString.optional(),
    delivery: looseObject
      .extend({
        riderPickupTime: z.union([z.string(), z.null()]).optional(),
      })
      .passthrough()
      .optional(),
    // pluginOrder.yaml `Products` — the real order line array. There is no
    // `items` array (bug fix: the previous schema invented one).
    products: z.array(productSchema).nonempty(),
    callbackUrls: callbackUrlsSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.expeditionType === "delivery" && !Object.prototype.hasOwnProperty.call(value, "delivery")) {
      ctx.addIssue({ code: "custom", path: ["delivery"], message: "delivery is required for delivery orders." });
    }
  });

export const orderStatusSchema = looseObject
  .extend({
    status: z.enum([
      "ORDER_CANCELLED",
      "ORDER_PICKED_UP",
      "PRODUCT_ORDER_MODIFICATION_SUCCESSFUL",
      "PRODUCT_ORDER_MODIFICATION_FAILED",
      "COURIER_ARRIVED_AT_VENDOR",
      "SHOW_RIDER_WAITING_WARNING",
      "HIDE_RIDER_WAITING_WARNING",
    ]),
    message: z.string().max(MAX_MESSAGE_LEN).optional(),
    occurredAt: isoDateString.optional(),
  })
  .passthrough();

const closureReasonSchema = z.enum([
  "TOO_BUSY_NO_DRIVERS",
  "TOO_BUSY_KITCHEN",
  "UPDATES_IN_MENU",
  "UNREACHABLE",
  "TECHNICAL_PROBLEM",
  "CLOSED",
  "OTHER",
  "TOO_MANY_REJECTED_ORDERS",
  "ORDER_FAILURE",
  "COURIER_DELAYED_AT_PICKUP",
  "RESTRICTED_VISIBILITY",
  "BAD_WEATHER",
  "HOLIDAY_SPECIAL_DAY",
  "ONBOARDING",
  "READY_TO_GO_ONLINE",
  "OFFBOARDING",
  "RETENTION",
  "COMPLIANCE_ISSUES",
  "OWNERSHIP_CHANGE",
  "REFURBISHMENT",
  "FOOD_HYGIENE",
  "FRAUD",
  "RELIGIOUS_OBSERVANCE",
  "CHECK_IN_REQUIRED",
  "CHECK_IN_FAILED",
  "AREA_DISRUPTION",
]);

export const availabilitySchema = z.object({
  timestamp: isoDateString,
  closures: z
    .array(
      z
        .object({
          // Fail-closed per pluginApi.yaml VendorAvailabilityUpdate/Closures — an
          // unrecognized reason is a rejection, not a silent pass-through.
          reason: closureReasonSchema,
          start: isoDateString,
          end: isoDateString.nullable().optional(),
          changeable: z.boolean(),
        })
        // Loosened from .strict(): pluginApi.yaml requires plugins to tolerate
        // unknown additional properties without failing (same reasoning as the
        // order dispatch body above).
        .passthrough(),
    ),
});

export const menuImportQuerySchema = z.object({
  vendorCode: boundedId,
  menuImportId: boundedId,
});

export const catalogStatusSchema = z.enum(["in_progress", "done", "done_with_errors", "failed"]);

export const catalogCallbackSchema = z
  .object({
    catalogImportId: boundedId,
    status: catalogStatusSchema,
    message: z.string().max(MAX_MESSAGE_LEN).optional(),
    details: z
      .array(
        z
          .object({
            status: catalogStatusSchema,
            posVendorId: boundedId.optional(),
            platformVendorId: boundedId.optional(),
            globalEntityId: boundedId.optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  })
  .strict();

export type OrderDispatchBody = z.infer<typeof orderDispatchBodySchema>;
export type OrderStatusBody = z.infer<typeof orderStatusSchema>;
export type AvailabilityBody = z.infer<typeof availabilitySchema>;
export type CatalogCallbackBody = z.infer<typeof catalogCallbackSchema>;

/** The real top-level order identifier (pluginOrder.yaml `Token`). Replaces the old, wrong providerOrderIdentity() which looked for orderId/orderToken/id. */
export function orderToken(body: OrderDispatchBody): string {
  return body.token;
}

/**
 * Order-level resolution of `itemUnavailabilityHandling`, applied across every
 * root product and its (possibly nested) toppings, with the spec's precedence
 * rule: "When multiple items are out-of-stock and any of those items has
 * CANCEL_ORDER option, then the cancel order option takes precedence."
 *
 * Returns:
 *  - "CANCEL_ORDER" if ANY product/topping carries it;
 *  - the single value, if every product/topping that sets one agrees;
 *  - null if no item sets one, or if the set values disagree without a
 *    CANCEL_ORDER present (no single order-level policy applies — the
 *    per-item values remain in `raw_payload` for a human to consult).
 */
export function resolveItemUnavailabilityHandling(body: OrderDispatchBody): ResolvedItemUnavailabilityHandling | null {
  const values: ItemUnavailabilityHandling[] = [];

  const collectFromTopping = (topping: ToppingInput): void => {
    if (topping.itemUnavailabilityHandling) values.push(topping.itemUnavailabilityHandling);
    for (const child of topping.children ?? []) collectFromTopping(child);
  };

  for (const product of body.products) {
    if (product.itemUnavailabilityHandling) values.push(product.itemUnavailabilityHandling);
    for (const topping of product.selectedToppings ?? []) collectFromTopping(topping);
  }

  if (values.length === 0) return null;
  if (values.includes("CANCEL_ORDER")) return "CANCEL_ORDER";
  const [first, ...rest] = values;
  // A mix is normal per pluginOrder.yaml ("for a given order there can be a mix of options
  // provided for different order items"), so it must NOT collapse to null — null means Delivery
  // Hero sent no handling instruction at all, and an operator needs to tell those two apart.
  // The authoritative per-item values stay in raw_payload; this column is the summary.
  return rest.every((value) => value === first) ? first! : MIXED_ITEM_UNAVAILABILITY_HANDLING;
}

export function classifyOrderType(body: OrderDispatchBody): "pickup" | "vendor_delivery" | "own_delivery" {
  if (body.expeditionType === "pickup") return "pickup";
  return body.delivery && body.delivery.riderPickupTime === null ? "vendor_delivery" : "own_delivery";
}
