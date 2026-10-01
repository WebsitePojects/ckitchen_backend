/**
 * GrabFood Partner API v1.1.3 inbound request/response shapes (src/modules/grab/
 * routes.ts + service.ts + worker.ts). Every schema stays `.passthrough()`
 * except the fixed, documented enums (paymentType, order state, integration
 * status, menu sync status) — those fail closed (rule 14, idempotency-
 * concurrency.md): an unrecognized value is a validation rejection, never a
 * silent pass-through. Field names/shapes are taken verbatim from the
 * contract handed down for this build (Step 2, G1/G3-G8) — nothing here is
 * invented.
 */
import { z } from "zod";

const MAX_SHORT_ID_LEN = 128;
const MAX_TEXT_LEN = 500;
// GetPartnerAccessToken: "client_id (<=32 chars, required), client_secret (<=32 chars, required)".
export const MAX_CREDENTIAL_LEN = 32;

export const boundedId = z.string().trim().min(1).max(MAX_SHORT_ID_LEN);
export const isoDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid RFC3339 date-time string.");

// ---------------------------------------------------------------------------
// G1 — POST /oauth/token
// ---------------------------------------------------------------------------

export const grabOauthTokenBodySchema = z.object({
  client_id: z.string().trim().min(1).max(MAX_CREDENTIAL_LEN),
  client_secret: z.string().trim().min(1).max(MAX_CREDENTIAL_LEN),
  grant_type: z.string().trim().min(1).max(64),
  scope: z.string().trim().min(1).max(64).optional(),
});
export type GrabOauthTokenBody = z.infer<typeof grabOauthTokenBodySchema>;

// ---------------------------------------------------------------------------
// G3 — POST /orders (submit order)
// ---------------------------------------------------------------------------

export const grabCurrencySchema = z.object({
  code: z.string().trim().min(1).max(8),
  symbol: z.string().trim().min(1).max(8),
  exponent: z.number().int().min(0).max(6),
});
export type GrabCurrency = z.infer<typeof grabCurrencySchema>;

const paymentTypeSchema = z.enum(["CASH", "CASHLESS"]);

const featureFlagsSchema = z
  .object({
    orderAcceptedType: z.string().trim().max(MAX_SHORT_ID_LEN).nullable().optional(),
    orderType: z.string().trim().max(MAX_SHORT_ID_LEN).nullable().optional(),
    isMexEditOrder: z.boolean(),
  })
  .passthrough();

const modifierSchema = z
  .object({
    id: boundedId,
    price: z.number(),
    tax: z.number().optional(),
    quantity: z.number().int().min(0),
    bcrsUnitCount: z.number().optional(),
  })
  .passthrough();

const orderItemSchema = z
  .object({
    id: boundedId,
    grabItemID: boundedId.optional(),
    // Drives ORION's actual order qty (worker.ts) — a 0-qty line is not a
    // meaningful order line, so this is validated strictly (>=1) at the
    // boundary (rule 9) rather than tolerated and silently dropped later.
    quantity: z.number().int().min(1),
    price: z.number(),
    tax: z.number().optional(),
    specifications: z.string().max(MAX_TEXT_LEN).nullable().optional(),
    bcrsUnitCount: z.number().optional(),
    outOfStockInstruction: z.string().max(MAX_SHORT_ID_LEN).nullable().optional(),
    modifiers: z.array(modifierSchema).optional(),
  })
  .passthrough();
export type GrabOrderItem = z.infer<typeof orderItemSchema>;

const merchantEarningSchema = z
  .object({
    revenue: z.number().optional(),
    netEarning: z.number().optional(),
    mexFundDiscount: z.number().optional(),
    commission: z.number().optional(),
  })
  .passthrough();

const priceSchema = z
  .object({
    subtotal: z.number(),
    tax: z.number().optional(),
    merchantChargeFee: z.number().optional(),
    serviceChargeFee: z.number().optional(),
    grabFundPromo: z.number().optional(),
    merchantFundPromo: z.number().optional(),
    basketPromo: z.number().optional(),
    deliveryFee: z.number().optional(),
    smallOrderFee: z.number().optional(),
    bcrsDepositFeeInMin: z.number().optional(),
    eaterPayment: z.number().optional(),
    total: z.number(),
    merchantEarning: merchantEarningSchema.optional(),
  })
  .passthrough();
export type GrabOrderPrice = z.infer<typeof priceSchema>;

const dineInSchema = z.object({ tableID: boundedId.optional(), eaterCount: z.number().int().min(0).optional() }).passthrough();

/**
 * PII (rule 11): name/phones/address/virtualContact. src/modules/grab/service.ts
 * MUST only read this out of `rawPayload` (never copy its contents into
 * redactedPayload, an API response, or a log line) — see submitOrderRedaction.
 */
const receiverSchema = z
  .object({
    name: z.string().max(MAX_TEXT_LEN).optional(),
    phones: z.array(z.string().max(64)).optional(),
    address: z
      .object({
        unitNumber: z.string().max(MAX_SHORT_ID_LEN).nullable().optional(),
        deliveryInstruction: z.string().max(MAX_TEXT_LEN).nullable().optional(),
        poiSource: z.string().max(MAX_SHORT_ID_LEN).nullable().optional(),
        poiID: z.string().max(MAX_SHORT_ID_LEN).nullable().optional(),
        address: z.string().max(MAX_TEXT_LEN).optional(),
        postcode: z.string().max(32).nullable().optional(),
        coordinates: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
      })
      .passthrough()
      .optional(),
    virtualContact: z
      .object({
        phoneNumber: z.string().max(64).optional(),
        PIN: z.string().max(32).optional(),
        expiredAt: isoDateString.optional(),
        status: z.string().max(MAX_SHORT_ID_LEN).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const submitOrderBodySchema = z
  .object({
    orderID: boundedId,
    shortOrderNumber: boundedId,
    merchantID: boundedId,
    // Not marked "(req)" in the contract's field list, but this is the ONLY
    // identifier this module can resolve a channel listing from (cross-cutting
    // LISTING RESOLUTION requirement) — enforced as required at the service
    // layer (GrabPartnerServiceError, not silently defaulted/guessed).
    partnerMerchantID: boundedId.optional(),
    paymentType: paymentTypeSchema,
    cutlery: z.boolean(),
    orderTime: isoDateString,
    submitTime: isoDateString.optional(),
    completeTime: isoDateString.optional(),
    scheduledTime: isoDateString.optional(),
    orderState: z.string().max(MAX_SHORT_ID_LEN).optional(),
    currency: grabCurrencySchema,
    featureFlags: featureFlagsSchema,
    items: z.array(orderItemSchema).min(1),
    campaigns: z.array(z.unknown()).nullable().optional(),
    promos: z.array(z.unknown()).nullable().optional(),
    price: priceSchema,
    dineIn: dineInSchema.nullable().optional(),
    receiver: receiverSchema.nullable().optional(),
    orderReadyEstimation: z.unknown().nullable().optional(),
    membershipID: boundedId.nullable().optional(),
    discounts: z.array(z.unknown()).nullable().optional(),
    payments: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type SubmitOrderBody = z.infer<typeof submitOrderBodySchema>;

// ---------------------------------------------------------------------------
// G4 — PUT /order/state (push order state)
// ---------------------------------------------------------------------------

/** Grab's EXACT enum (spec G4) — fail closed on anything else (rule 14). */
export const grabOrderStateSchema = z.enum([
  "ACCEPTED",
  "DRIVER_ALLOCATED",
  "DRIVER_ARRIVED",
  "COLLECTED",
  "DELIVERED",
  "BILL_PAID",
  "COMPLETED",
  "REFUNDED",
  "FAILED",
  "CANCELLED",
]);
export type GrabOrderState = z.infer<typeof grabOrderStateSchema>;

export const pushOrderStateBodySchema = z
  .object({
    merchantID: boundedId,
    partnerMerchantID: boundedId.optional(),
    orderID: boundedId,
    state: grabOrderStateSchema,
    driverETA: z.number().int().min(0).optional(),
    code: z.string().max(MAX_SHORT_ID_LEN).optional(),
    message: z.string().max(MAX_TEXT_LEN).optional(),
    order: z.unknown().optional(),
  })
  .passthrough();
export type PushOrderStateBody = z.infer<typeof pushOrderStateBodySchema>;

// ---------------------------------------------------------------------------
// G5 — POST /pushIntegrationStatus
// ---------------------------------------------------------------------------

export const grabIntegrationStatusValueSchema = z.enum(["INACTIVE", "ACTIVE", "SYNCING", "FAILED"]);

export const pushIntegrationStatusBodySchema = z
  .object({
    partnerMerchantID: boundedId,
    grabMerchantID: boundedId,
    integrationStatus: grabIntegrationStatusValueSchema,
  })
  .passthrough();
export type PushIntegrationStatusBody = z.infer<typeof pushIntegrationStatusBodySchema>;

// ---------------------------------------------------------------------------
// G6 — POST /menuSyncState
// ---------------------------------------------------------------------------

// Documented as UUID, but this module bounds by length/shape rather than hard-
// rejecting a non-canonical value Grab might send — dedupe correctness only
// needs requestID to be a stable, comparable string (the partial unique index
// on request_id is what actually enforces the dedupe rule, not this schema).
const grabRequestIdSchema = z.string().trim().min(1).max(64);

export const grabMenuSyncStatusValueSchema = z.enum(["QUEUEING", "PROCESSING", "SUCCESS", "FAILED"]);

export const menuSyncStateBodySchema = z
  .object({
    requestID: grabRequestIdSchema,
    merchantID: boundedId,
    partnerMerchantID: boundedId.optional(),
    jobID: grabRequestIdSchema,
    updatedAt: isoDateString,
    status: grabMenuSyncStatusValueSchema,
    errors: z.array(z.string().max(MAX_TEXT_LEN)).optional(),
  })
  .passthrough();
export type MenuSyncStateBody = z.infer<typeof menuSyncStateBodySchema>;

// ---------------------------------------------------------------------------
// G7 — POST /pushGrabMenu
// ---------------------------------------------------------------------------

/**
 * Grab's self-serve-activation menu push. The contract for this build is
 * explicit: "persist the raw document as a receipt; do not attempt to model
 * or import its interior" — so this schema validates ONLY the routing field
 * this module needs (listing resolution) and passes everything else through
 * untouched into raw_payload.
 */
export const pushGrabMenuBodySchema = z
  .object({
    partnerMerchantID: boundedId,
    merchantID: boundedId.optional(),
  })
  .passthrough();
export type PushGrabMenuBody = z.infer<typeof pushGrabMenuBodySchema>;

// ---------------------------------------------------------------------------
// G8 — GET /merchant/menu
// ---------------------------------------------------------------------------

export const getMerchantMenuQuerySchema = z.object({
  merchantID: boundedId,
  partnerMerchantID: boundedId,
  // Express query params arrive as strings; BusinessType is documented as an integer.
  BusinessType: z.coerce.number().int(),
});
export type GetMerchantMenuQuery = z.infer<typeof getMerchantMenuQuerySchema>;
