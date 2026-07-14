/**
 * DTOs for the Customer Order lifecycle service (D35-D46 §7 — Customer
 * Orders and Job Orders). See src/db/customer-orders-schema.ts for the
 * underlying tables/enums and their invariants.
 */
import type {
  CustomerOrder,
  CustomerOrderAllocation,
  CustomerOrderFulfillment,
  CustomerOrderLine,
  customerOrderAllocationStatusEnum,
  customerOrderStatusEnum,
} from "../../db/customer-orders-schema.js";
import type { consumptionModeEnum } from "../../db/schema.js";

export type CustomerOrderStatus = (typeof customerOrderStatusEnum.enumValues)[number];
export type CustomerOrderAllocationStatus = (typeof customerOrderAllocationStatusEnum.enumValues)[number];
export type CustomerOrderConsumptionMode = (typeof consumptionModeEnum.enumValues)[number];

/**
 * Caller-supplied MADE_TO_ORDER direct-component-requirements payload,
 * snapshotted verbatim onto `customer_order_line.component_requirements_snapshot`
 * at line-creation time (D35-D46 §6: "Recipe/BOM edits after order acceptance
 * do not change that order's reservation or deduction snapshot" — this
 * service accepts an already-resolved snapshot from the caller rather than
 * deriving one from a live BOM/recipe itself, which is the BOM module's own
 * concern; see service.ts's createCustomerOrderDraft doc comment for the
 * full reasoning). Every `itemId` is validated to be an active stock-postable
 * item at line-creation time.
 */
export interface ComponentRequirementLine {
  itemId: string;
  /** Quantity in the component item's base UOM. */
  quantity: string | number;
}

export interface ComponentRequirementsSnapshot {
  components: ComponentRequirementLine[];
}

/**
 * A caller-supplied order line. Deliberately has NO client-supplied
 * `conversionFactor`/`baseQuantity`/`lineTotal` — the service always derives
 * them (mirrors BomComponentLineInput / StockReturnLineInput) so an
 * entered-qty-to-base-qty or total mismatch can never be smuggled in.
 *
 * Exactly one of `componentRequirementsSnapshot` / `jobOrderId` must be set
 * for a MADE_TO_ORDER line, and neither for a STOCKED_OUTPUT line — this
 * mirrors (and is additionally enforced at the DB level by)
 * `customer_order_line_consumption_owner_guard`.
 */
export interface CreateCustomerOrderLineInput {
  itemId: string;
  enteredUom: string;
  enteredQuantity: string | number;
  unitPrice: string | number;
  taxAmount?: string | number;
  discountAmount?: string | number;
  consumptionMode: CustomerOrderConsumptionMode;
  componentRequirementsSnapshot?: ComponentRequirementsSnapshot | null;
  jobOrderId?: string | null;
  remarks?: string | null;
}

export interface CreateCustomerOrderDraftInput {
  actorUserId: string;
  sessionId?: string | null;
  /** Auto-generated (`CO-<uuid>`) when omitted. */
  documentNo?: string;
  customerId: string;
  locationId: string;
  requiredDate?: string | null;
  remarks?: string | null;
  lines: CreateCustomerOrderLineInput[];
}

/** Base shape shared by every Customer Order lifecycle transition below. */
interface CustomerOrderTransitionInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
  expectedVersion: number;
}

export interface UpdateCustomerOrderDraftInput extends CustomerOrderTransitionInput {
  requiredDate?: string | null;
  remarks?: string | null;
  lines?: CreateCustomerOrderLineInput[];
}

export type SubmitCustomerOrderInput = CustomerOrderTransitionInput;
export type ApproveCustomerOrderInput = CustomerOrderTransitionInput;
export type AllocateCustomerOrderInput = CustomerOrderTransitionInput;
export type MarkCustomerOrderInProductionInput = CustomerOrderTransitionInput;
export type MarkCustomerOrderReadyInput = CustomerOrderTransitionInput;
export type FulfillCustomerOrderInput = CustomerOrderTransitionInput;

export interface CancelCustomerOrderInput extends CustomerOrderTransitionInput {
  reason: string;
}

export interface GetCustomerOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  orderId: string;
}

export interface ListCustomerOrdersInput {
  actorUserId: string;
  sessionId?: string | null;
  locationId?: string;
  customerId?: string;
  status?: CustomerOrderStatus;
  /** Case-insensitive substring match against the order's document number. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListCustomerOrdersPage {
  items: CustomerOrder[];
  total: number;
}

export interface CustomerOrderWithLines extends CustomerOrder {
  lines: CustomerOrderLine[];
}

export type {
  CustomerOrder,
  CustomerOrderAllocation,
  CustomerOrderFulfillment,
  CustomerOrderLine,
};
