/**
 * Purchasing Routes — ERP R3 (CK1-ERP-006 §4)
 *
 * Flow: Purchase Request (PR) → approve → Purchase Order (PO) → send →
 *       Receiving Report (RR). Receiving posts a RECEIVE IN stock-ledger row
 *       into the MAIN warehouse and bumps inventory_stock — atomically.
 *
 * RBAC (server-side): requesters raise PRs, SUPER_ADMIN approves, purchasing
 * (SUPPLIER_COORDINATOR) issues POs, warehouse receives. Every mutation audited.
 */
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  departmentEnum,
  ingredients,
  inventoryStock,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  roleEnum,
  receivingReportLines,
  receivingReports,
  suppliers,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";
import { postLedger } from "../inventory/ledger.js";

const REQUESTER_ROLES = ["SUPER_ADMIN", "SUPPLIER_COORDINATOR", "WAREHOUSE", "KITCHEN_STAFF"] as const;
const APPROVER_ROLES = ["SUPER_ADMIN"] as const;
const PO_ROLES = ["SUPER_ADMIN", "SUPPLIER_COORDINATOR"] as const;
const RECEIVE_ROLES = ["SUPER_ADMIN", "WAREHOUSE"] as const;

function docNo(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4).toString().padStart(4, "0")}`;
}

const prCreateSchema = z.object({
  department: z.enum(departmentEnum.enumValues),
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        ingredient_id: z.string().uuid(),
        quantity: z.number().positive(),
        est_unit_cost: z.number().min(0).optional(),
      }),
    )
    .min(1),
});

const poCreateSchema = z.object({
  supplier_id: z.string().uuid(),
  pr_id: z.string().uuid().optional(),
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        ingredient_id: z.string().uuid(),
        quantity: z.number().positive(),
        unit_cost: z.number().min(0).optional(),
      }),
    )
    .min(1),
});

const receiveSchema = z.object({
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        po_line_id: z.string().uuid(),
        qty_received: z.number().positive(),
      }),
    )
    .min(1),
});

async function allIngredientsExist(db: DB, ids: string[]): Promise<string | null> {
  for (const id of ids) {
    const [row] = await db.select({ id: ingredients.id }).from(ingredients).where(eq(ingredients.id, id));
    if (!row) return id;
  }
  return null;
}

export function createPurchasingRouter(db: DB): Router {
  const router = Router();

  // ── Purchase Requests ──────────────────────────────────────────────────────

  router.post("/purchase-requests", requireAuth, requireRole(...REQUESTER_ROLES), async (req, res) => {
    const parsed = prCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid purchase request payload.", parsed.error.issues);
      return;
    }
    const missing = await allIngredientsExist(db, parsed.data.lines.map((l) => l.ingredient_id));
    if (missing) {
      sendError(res, 404, "NOT_FOUND", `Ingredient ${missing} not found.`);
      return;
    }

    const prNo = docNo("PR");
    let created!: typeof purchaseRequests.$inferSelect;
    await db.transaction(async (tx) => {
      [created] = await tx
        .insert(purchaseRequests)
        .values({
          prNo,
          department: parsed.data.department,
          status: "DRAFT",
          requestedByUserId: req.user!.id,
          notes: parsed.data.notes ?? null,
        })
        .returning();
      await tx.insert(purchaseRequestLines).values(
        parsed.data.lines.map((l) => ({
          prId: created.id,
          ingredientId: l.ingredient_id,
          quantity: String(l.quantity),
          estUnitCost: String(l.est_unit_cost ?? 0),
        })),
      );
    });

    void audit(db, {
      actorUserId: req.user!.id,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_request.create",
      description: `Created ${prNo} (${parsed.data.department})`,
      entityType: "purchase_request",
      entityId: created.id,
    });
    res.status(201).json(created);
  });

  router.get("/purchase-requests", requireAuth, async (req, res) => {
    const { status, department } = req.query as Record<string, string | undefined>;
    const conditions: ReturnType<typeof eq>[] = [];
    if (status) conditions.push(eq(purchaseRequests.status, status as typeof purchaseRequests.$inferSelect["status"]));
    if (department) conditions.push(eq(purchaseRequests.department, department as typeof purchaseRequests.$inferSelect["department"]));
    const rows = conditions.length
      ? await db.select().from(purchaseRequests).where(and(...conditions))
      : await db.select().from(purchaseRequests);
    res.json(rows);
  });

  router.get("/purchase-requests/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, id));
    if (!pr) {
      sendError(res, 404, "NOT_FOUND", "Purchase request not found.");
      return;
    }
    const lines = await db.select().from(purchaseRequestLines).where(eq(purchaseRequestLines.prId, id));
    res.json({ ...pr, lines });
  });

  /** Guarded status transition helper for PRs. */
  function prTransition(
    from: typeof purchaseRequests.$inferSelect["status"],
    to: typeof purchaseRequests.$inferSelect["status"],
    action: string,
    roles: readonly (typeof roleEnum.enumValues)[number][],
    setApprover = false,
  ) {
    router.post(`/purchase-requests/:id/${action}`, requireAuth, requireRole(...roles), async (req, res) => {
      const id = paramAsString(req.params.id);
      const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, id));
      if (!pr) {
        sendError(res, 404, "NOT_FOUND", "Purchase request not found.");
        return;
      }
      if (pr.status !== from) {
        sendError(res, 409, "CONFLICT", `Purchase request is ${pr.status}; expected ${from}.`);
        return;
      }
      const [updated] = await db
        .update(purchaseRequests)
        .set({
          status: to,
          updatedAt: new Date(),
          ...(setApprover ? { approvedByUserId: req.user!.id } : {}),
        })
        .where(eq(purchaseRequests.id, id))
        .returning();
      void audit(db, {
        actorUserId: req.user!.id,
        sessionId: req.user!.sessionId ?? null,
        action: `purchase_request.${action}`,
        description: `${pr.prNo}: ${from} → ${to}`,
        entityType: "purchase_request",
        entityId: id,
      });
      res.json(updated);
    });
  }

  prTransition("DRAFT", "SUBMITTED", "submit", REQUESTER_ROLES);
  prTransition("SUBMITTED", "APPROVED", "approve", APPROVER_ROLES, true);
  prTransition("SUBMITTED", "REJECTED", "reject", APPROVER_ROLES, true);

  // ── Purchase Orders ────────────────────────────────────────────────────────

  router.post("/purchase-orders", requireAuth, requireRole(...PO_ROLES), async (req, res) => {
    const parsed = poCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid purchase order payload.", parsed.error.issues);
      return;
    }
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, parsed.data.supplier_id));
    if (!supplier) {
      sendError(res, 404, "NOT_FOUND", `Supplier ${parsed.data.supplier_id} not found.`);
      return;
    }
    if (parsed.data.pr_id) {
      const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, parsed.data.pr_id));
      if (!pr) {
        sendError(res, 404, "NOT_FOUND", `Purchase request ${parsed.data.pr_id} not found.`);
        return;
      }
      if (pr.status !== "APPROVED") {
        sendError(res, 409, "CONFLICT", `Purchase request must be APPROVED to raise a PO (is ${pr.status}).`);
        return;
      }
    }
    const missing = await allIngredientsExist(db, parsed.data.lines.map((l) => l.ingredient_id));
    if (missing) {
      sendError(res, 404, "NOT_FOUND", `Ingredient ${missing} not found.`);
      return;
    }

    const poNo = docNo("PO");
    let created!: typeof purchaseOrders.$inferSelect;
    await db.transaction(async (tx) => {
      [created] = await tx
        .insert(purchaseOrders)
        .values({
          poNo,
          supplierId: parsed.data.supplier_id,
          prId: parsed.data.pr_id ?? null,
          status: "DRAFT",
          createdByUserId: req.user!.id,
          notes: parsed.data.notes ?? null,
        })
        .returning();
      await tx.insert(purchaseOrderLines).values(
        parsed.data.lines.map((l) => ({
          poId: created.id,
          ingredientId: l.ingredient_id,
          quantity: String(l.quantity),
          unitCost: String(l.unit_cost ?? 0),
        })),
      );
    });

    void audit(db, {
      actorUserId: req.user!.id,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_order.create",
      description: `Created ${poNo} for ${supplier.name}`,
      entityType: "purchase_order",
      entityId: created.id,
    });
    res.status(201).json(created);
  });

  router.get("/purchase-orders", requireAuth, async (req, res) => {
    const { status, supplier_id } = req.query as Record<string, string | undefined>;
    const conditions: ReturnType<typeof eq>[] = [];
    if (status) conditions.push(eq(purchaseOrders.status, status as typeof purchaseOrders.$inferSelect["status"]));
    if (supplier_id) conditions.push(eq(purchaseOrders.supplierId, supplier_id));
    const rows = conditions.length
      ? await db.select().from(purchaseOrders).where(and(...conditions))
      : await db.select().from(purchaseOrders);
    res.json(rows);
  });

  router.get("/purchase-orders/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) {
      sendError(res, 404, "NOT_FOUND", "Purchase order not found.");
      return;
    }
    const lines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
    res.json({ ...po, lines });
  });

  router.post("/purchase-orders/:id/send", requireAuth, requireRole(...PO_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) {
      sendError(res, 404, "NOT_FOUND", "Purchase order not found.");
      return;
    }
    if (po.status !== "DRAFT") {
      sendError(res, 409, "CONFLICT", `Purchase order is ${po.status}; expected DRAFT.`);
      return;
    }
    const [updated] = await db
      .update(purchaseOrders)
      .set({ status: "SENT", updatedAt: new Date() })
      .where(eq(purchaseOrders.id, id))
      .returning();
    void audit(db, {
      actorUserId: req.user!.id,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_order.send",
      description: `${po.poNo}: DRAFT → SENT`,
      entityType: "purchase_order",
      entityId: id,
    });
    res.json(updated);
  });

  // ── Receiving (posts stock ledger IN to MAIN) ───────────────────────────────

  router.post("/purchase-orders/:id/receive", requireAuth, requireRole(...RECEIVE_ROLES), async (req, res) => {
    const id = paramAsString(req.params.id);
    const parsed = receiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid receive payload.", parsed.error.issues);
      return;
    }

    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!po) {
      sendError(res, 404, "NOT_FOUND", "Purchase order not found.");
      return;
    }
    if (po.status !== "SENT" && po.status !== "PARTIAL") {
      sendError(res, 409, "CONFLICT", `Purchase order must be SENT or PARTIAL to receive (is ${po.status}).`);
      return;
    }

    const poLines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
    const lineById = new Map(poLines.map((l) => [l.id, l]));

    // Validate each receive line: belongs to this PO + does not over-receive.
    for (const rl of parsed.data.lines) {
      const poLine = lineById.get(rl.po_line_id);
      if (!poLine) {
        sendError(res, 400, "VALIDATION_ERROR", `PO line ${rl.po_line_id} does not belong to this purchase order.`);
        return;
      }
      const remaining = Number(poLine.quantity) - Number(poLine.qtyReceived);
      if (rl.qty_received > remaining + 1e-9) {
        sendError(res, 409, "CONFLICT", `Cannot receive ${rl.qty_received}; only ${remaining} remaining on that line.`);
        return;
      }
    }

    const [mainWarehouse] = await db.select().from(warehouses).where(eq(warehouses.type, "MAIN"));
    if (!mainWarehouse) {
      sendError(res, 500, "NOT_FOUND", "MAIN warehouse not configured.");
      return;
    }

    const rrNo = docNo("RR");
    let rr!: typeof receivingReports.$inferSelect;

    await db.transaction(async (tx) => {
      [rr] = await tx
        .insert(receivingReports)
        .values({
          rrNo,
          poId: id,
          warehouseId: mainWarehouse.id,
          receivedByUserId: req.user!.id,
          notes: parsed.data.notes ?? null,
        })
        .returning();

      for (const rl of parsed.data.lines) {
        const poLine = lineById.get(rl.po_line_id)!;

        await tx.insert(receivingReportLines).values({
          rrId: rr.id,
          poLineId: rl.po_line_id,
          ingredientId: poLine.ingredientId,
          qtyReceived: String(rl.qty_received),
        });

        // Bump MAIN inventory_stock (accumulate).
        await tx
          .insert(inventoryStock)
          .values({ warehouseId: mainWarehouse.id, ingredientId: poLine.ingredientId, quantity: String(rl.qty_received) })
          .onConflictDoUpdate({
            target: [inventoryStock.warehouseId, inventoryStock.ingredientId],
            set: { quantity: sql`${inventoryStock.quantity} + EXCLUDED.quantity` },
          });

        // Universal ledger: RECEIVE IN (idempotent on module+doc+line).
        await postLedger(tx, {
          sourceModule: "RECEIVE",
          sourceDocumentNo: rrNo,
          sourceLineNo: rl.po_line_id,
          ingredientId: poLine.ingredientId,
          warehouseId: mainWarehouse.id,
          movementType: "IN",
          quantity: rl.qty_received,
          unitCost: poLine.unitCost,
          encoderUserId: req.user!.id,
        });

        // Advance the PO line's received qty.
        await tx
          .update(purchaseOrderLines)
          .set({ qtyReceived: sql`${purchaseOrderLines.qtyReceived} + ${String(rl.qty_received)}` })
          .where(eq(purchaseOrderLines.id, rl.po_line_id));
      }

      // Recompute PO status: RECEIVED if every line fully received, else PARTIAL.
      const refreshed = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
      const fullyReceived = refreshed.every((l) => Number(l.qtyReceived) >= Number(l.quantity) - 1e-9);
      await tx
        .update(purchaseOrders)
        .set({ status: fullyReceived ? "RECEIVED" : "PARTIAL", updatedAt: new Date() })
        .where(eq(purchaseOrders.id, id));
    });

    void audit(db, {
      actorUserId: req.user!.id,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_order.receive",
      description: `Received against ${po.poNo} → ${rrNo}`,
      entityType: "receiving_report",
      entityId: rr.id,
    });

    res.status(201).json(rr);
  });

  router.get("/receiving-reports", requireAuth, async (_req, res) => {
    const rows = await db.select().from(receivingReports);
    res.json(rows);
  });

  router.get("/receiving-reports/:id", requireAuth, async (req, res) => {
    const id = paramAsString(req.params.id);
    const [rr] = await db.select().from(receivingReports).where(eq(receivingReports.id, id));
    if (!rr) {
      sendError(res, 404, "NOT_FOUND", "Receiving report not found.");
      return;
    }
    const lines = await db.select().from(receivingReportLines).where(eq(receivingReportLines.rrId, id));
    res.json({ ...rr, lines });
  });

  return router;
}
