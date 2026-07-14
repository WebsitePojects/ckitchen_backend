/**
 * DTOs for the BOM authoring/version-lifecycle service (header create, draft
 * version create, draft component replace, activate, retire, read).
 * Deliberately excludes Job Order shapes and any posting/inventory-mutation
 * shapes — this module never touches inventory_lot_balances or the central
 * stock posting service.
 */
import type {
  bomVersionStatusEnum,
  BomComponent,
  BomHeader,
  BomVersion,
  JobOrder,
  JobOrderComponentAllocation,
  jobOrderStatusEnum,
} from "../../db/production-schema.js";
import type { consumptionModeEnum } from "../../db/schema.js";

export type BomVersionStatus = (typeof bomVersionStatusEnum.enumValues)[number];
export type BomProductionMode = (typeof consumptionModeEnum.enumValues)[number];

export interface CreateBomHeaderInput {
  actorUserId: string;
  sessionId?: string | null;
  code: string;
  name: string;
  outputItemId: string;
  productionMode?: BomProductionMode;
}

export interface CreateDraftVersionInput {
  actorUserId: string;
  sessionId?: string | null;
  bomHeaderId: string;
  outputUom: string;
  outputYieldQty: string | number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  remarks?: string | null;
}

/**
 * A caller-supplied component line. Deliberately has NO client-supplied
 * `baseQuantity` — the service always derives it from the item's configured
 * UOM conversion so an entered-qty-to-base-qty mismatch can never be
 * smuggled in by the client (mirrors StockReturnLineInput's shape).
 */
export interface BomComponentLineInput {
  componentItemId: string;
  enteredQuantity: string | number;
  enteredUom: string;
  scrapAllowancePct?: string | number;
}

export interface ReplaceDraftComponentsInput {
  actorUserId: string;
  sessionId?: string | null;
  bomVersionId: string;
  lines: BomComponentLineInput[];
}

export interface ActivateVersionInput {
  actorUserId: string;
  sessionId?: string | null;
  bomVersionId: string;
}

export interface RetireVersionInput {
  actorUserId: string;
  sessionId?: string | null;
  bomVersionId: string;
}

export interface GetBomHeaderInput {
  actorUserId: string;
  sessionId?: string | null;
  bomHeaderId: string;
}

export interface GetBomVersionInput {
  actorUserId: string;
  sessionId?: string | null;
  bomVersionId: string;
}

export interface ListBomHeadersInput {
  actorUserId: string;
  sessionId?: string | null;
  /** Case-insensitive substring match against the header's code or name. */
  search?: string;
  outputItemId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListBomHeadersPage {
  items: BomHeader[];
  total: number;
}

export interface BomHeaderWithVersions extends BomHeader {
  versions: BomVersion[];
}

export interface BomVersionWithComponents extends BomVersion {
  components: BomComponent[];
}

export type JobOrderStatus = (typeof jobOrderStatusEnum.enumValues)[number];

/**
 * Job Order draft creation. `bomVersionId` is an explicit caller choice (no
 * implicit "current active version of this header" resolution) so the
 * produced Job Order snapshots exactly the version the caller reviewed.
 * `plannedOutputUom` must match the BOM version's `outputUom` exactly —
 * this service never performs a UOM conversion on the planned output itself.
 */
export interface CreateJobOrderDraftInput {
  actorUserId: string;
  sessionId?: string | null;
  jobOrderNo: string;
  bomVersionId: string;
  locationId: string;
  plannedOutputQty: string | number;
  plannedOutputUom: string;
  remarks?: string | null;
}

export interface GetJobOrderInput {
  actorUserId: string;
  sessionId?: string | null;
  jobOrderId: string;
}

export interface ListJobOrdersInput {
  actorUserId: string;
  sessionId?: string | null;
  locationId?: string;
  bomHeaderId?: string;
  status?: JobOrderStatus;
  /** Case-insensitive substring match against the job order number. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListJobOrdersPage {
  items: JobOrder[];
  total: number;
}

export interface JobOrderWithAllocations extends JobOrder {
  allocations: JobOrderComponentAllocation[];
}

/**
 * Base shape shared by every Job Order lifecycle transition below: the
 * actor performing it, the job order being transitioned, and the optimistic
 * lock (`expectedVersion`) that must match the row's current `version`.
 */
interface JobOrderTransitionInput {
  actorUserId: string;
  sessionId?: string | null;
  jobOrderId: string;
  expectedVersion: number;
}

export type SubmitJobOrderInput = JobOrderTransitionInput;

export type ApproveJobOrderInput = JobOrderTransitionInput;

export type ReleaseJobOrderInput = JobOrderTransitionInput;

export interface StartJobOrderInput extends JobOrderTransitionInput {
  operatorEmployeeId: string;
}

export interface CancelJobOrderInput extends JobOrderTransitionInput {
  reason: string;
}

export interface FailJobOrderInput extends JobOrderTransitionInput {
  reason: string;
}

/**
 * IN_PROGRESS -> COMPLETED. `actualOutputQty` is the real produced quantity
 * (may differ from `plannedOutputQty` on under/over-yield) in the job's
 * already-pinned `outputUom`/base unit — this service performs no UOM
 * conversion on it. No operator field: the operator was already fixed on the
 * job order by startJobOrder(); completion is authorized the same way every
 * other transition in this module is, via authorizeActor()/STOCK_PRODUCTION_ROLES.
 */
export interface CompleteJobOrderInput extends JobOrderTransitionInput {
  actualOutputQty: string | number;
  evidenceRef?: string | null;
}

export type { BomHeader, BomVersion, BomComponent, JobOrder, JobOrderComponentAllocation };
