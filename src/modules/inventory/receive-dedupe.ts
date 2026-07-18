/**
 * Double-submit guard for Receiving Report creation.
 *
 * Both RR-creating endpoints (POST /inventory/receive — direct receipt, and
 * POST /purchase-orders/:id/receive — PO-driven receipt) hand-roll a fresh
 * `rrNo = docNo("RR")` (timestamp + random suffix) on every call and have no
 * client-supplied Idempotency-Key. That means postLedger()'s own dedup key
 * `(sourceModule, sourceDocumentNo, sourceLineNo)` never collides across two
 * calls of the same logical request (each call mints a different rrNo), so a
 * double-click or a client retry-after-timeout would otherwise create a
 * second Receiving Report and credit MAIN stock twice — exactly the doubled
 * business effect this audit targets.
 *
 * Fix: `findDuplicateReceivingReport()` must be called AFTER the caller has
 * taken a `SELECT ... FOR UPDATE` row lock on the scoping row (the purchase
 * order for a PO receipt, or the destination warehouse for a direct receipt)
 * INSIDE the same transaction that will insert the new RR. That lock
 * serializes two truly concurrent identical requests so the second one's
 * lookback query runs only after the first has committed (or rolled back);
 * a purely sequential retry (the more common case — user double-clicks, or
 * the client re-POSTs after a dropped response) needs no lock at all since
 * the first request has already committed by the time the retry lands.
 *
 * Matching rule: same actor, same scope (poId, or warehouseId+supplierId+
 * reference for a direct receipt), an RR created within the last
 * DUPLICATE_LOOKBACK_MS, AND the exact same set of (lineKey, quantity)
 * pairs. lineKey is the PO line id for a PO receipt (stable, unambiguous)
 * or the ingredient id for a direct receipt. A real second, intentionally
 * distinct partial receipt against the same PO/warehouse (different lines,
 * different quantities, or landing outside the lookback window) is never
 * treated as a duplicate.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { receivingReportLines, receivingReports } from "../../db/schema.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Generous enough to cover a slow-network double-click or a client retry after a dropped response. */
export const DUPLICATE_LOOKBACK_MS = 30_000;

export interface ReceiveLineFingerprint {
  /** PO line id (PO-driven receipt) or ingredient id (direct receipt). */
  key: string;
  /** Quantity received on this line, as entered (string or number). */
  quantity: string | number;
}

export interface ReceiveScope {
  poId: string | null;
  warehouseId: string;
  /** Only meaningful for a direct (poId === null) receipt. */
  supplierId?: string | null;
  reference?: string | null;
}

function normalizeQty(q: string | number): string {
  return Number(q).toFixed(6);
}

/**
 * Returns the id of a matching recent Receiving Report if this request is a
 * duplicate of one already committed, or null if the caller should proceed
 * to insert a new RR. Must run inside the same transaction as the intended
 * insert, after locking the scoping row FOR UPDATE.
 */
export async function findDuplicateReceivingReport(
  tx: Tx,
  scope: ReceiveScope,
  receivedByUserId: string,
  lines: ReceiveLineFingerprint[],
): Promise<string | null> {
  const since = new Date(Date.now() - DUPLICATE_LOOKBACK_MS);
  const conditions = [
    eq(receivingReports.warehouseId, scope.warehouseId),
    eq(receivingReports.receivedByUserId, receivedByUserId),
    gte(receivingReports.createdAt, since),
    scope.poId ? eq(receivingReports.poId, scope.poId) : isNull(receivingReports.poId),
  ];
  if (!scope.poId) {
    conditions.push(scope.supplierId ? eq(receivingReports.supplierId, scope.supplierId) : isNull(receivingReports.supplierId));
    conditions.push(scope.reference ? eq(receivingReports.reference, scope.reference) : isNull(receivingReports.reference));
  }

  const candidates = await tx
    .select({ id: receivingReports.id })
    .from(receivingReports)
    .where(and(...conditions))
    .orderBy(desc(receivingReports.createdAt))
    .limit(5);

  if (candidates.length === 0) return null;

  const wanted = new Set(lines.map((l) => `${l.key}:${normalizeQty(l.quantity)}`));

  for (const candidate of candidates) {
    const existingLines = await tx
      .select({
        poLineId: receivingReportLines.poLineId,
        ingredientId: receivingReportLines.ingredientId,
        qtyReceived: receivingReportLines.qtyReceived,
      })
      .from(receivingReportLines)
      .where(eq(receivingReportLines.rrId, candidate.id));

    if (existingLines.length !== lines.length) continue;

    const existingSet = new Set(
      existingLines.map((l) => `${l.poLineId ?? l.ingredientId}:${normalizeQty(l.qtyReceived)}`),
    );
    if (existingSet.size !== wanted.size) continue;

    let allMatch = true;
    for (const key of wanted) {
      if (!existingSet.has(key)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return candidate.id;
  }

  return null;
}
