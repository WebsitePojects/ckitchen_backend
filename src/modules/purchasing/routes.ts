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
  departmentBudgets,
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
  supplierItems,
  suppliers,
  warehouses,
} from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { resolveRequestLocationId } from "../auth/outlet-scope.js";
import { paramAsString, sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";
import { postLedger } from "../inventory/ledger.js";
import { docNo } from "./doc-no.js";
import {
  BUDGET_ENFORCEMENT,
  computeCommitted,
  getBudgetStatus,
  toPeriod,
  upsertBudget,
  type Department,
} from "./budget.js";

const REQUESTER_ROLES = ["OWNER", "PURCHASING", "WAREHOUSE_OUTLET", "KITCHEN_CREW"] as const;
const APPROVER_ROLES = ["OWNER"] as const;
const PO_ROLES = ["OWNER", "PURCHASING"] as const;
const RECEIVE_ROLES = ["OWNER", "WAREHOUSE_OUTLET"] as const;
const BUDGET_ROLES = ["OWNER", "ACCOUNTING"] as const;

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
      actorName: req.user!.name ?? null,
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
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: `purchase_request.${action}`,
        description: `${pr.prNo}: ${from} → ${to}`,
        entityType: "purchase_request",
        entityId: id,
      });
      res.json(updated);
    });
  }

  // `submit` is pulled OUT of the generic prTransition factory because it must
  // also run the budget-threshold check (MOTM 2026-06-24). approve/reject stay
  // generic. The DRAFT→SUBMITTED guard/update/audit below MUST stay byte-for-byte
  // equivalent to what the factory did, so the response is unchanged (full
  // non-regression) whenever there is no budget row / the PR is within budget.
  router.post(
    "/purchase-requests/:id/submit",
    requireAuth,
    requireRole(...REQUESTER_ROLES),
    async (req, res) => {
      const id = paramAsString(req.params.id);
      const [pr] = await db.select().from(purchaseRequests).where(eq(purchaseRequests.id, id));
      if (!pr) {
        sendError(res, 404, "NOT_FOUND", "Purchase request not found.");
        return;
      }
      if (pr.status !== "DRAFT") {
        sendError(res, 409, "CONFLICT", `Purchase request is ${pr.status}; expected DRAFT.`);
        return;
      }

      // This PR's own line total, and the department's committed spend for its
      // period BEFORE this transition — so the PR being submitted (still DRAFT)
      // is correctly excluded from its own committed sum.
      const prLines = await db
        .select()
        .from(purchaseRequestLines)
        .where(eq(purchaseRequestLines.prId, id));
      const prTotal = prLines.reduce(
        (sum, l) => sum + Number(l.quantity) * Number(l.estUnitCost),
        0,
      );
      const period = toPeriod(pr.createdAt);
      const committedBefore = await computeCommitted(db, pr.department, period);

      const [updated] = await db
        .update(purchaseRequests)
        .set({ status: "SUBMITTED", updatedAt: new Date() })
        .where(eq(purchaseRequests.id, id))
        .returning();

      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: "purchase_request.submit",
        description: `${pr.prNo}: DRAFT → SUBMITTED`,
        entityType: "purchase_request",
        entityId: id,
      });

      // Budget-threshold check. BUDGET_ENFORCEMENT is 'WARN' only right now —
      // we never hard-block. Referencing the const (rather than hardcoding
      // "always warn") keeps a future flip to 'BLOCK' a one-line change; the
      // BLOCK branch is intentionally not implemented until the client confirms.
      const [budgetRow] = await db
        .select()
        .from(departmentBudgets)
        .where(
          and(
            eq(departmentBudgets.department, pr.department),
            eq(departmentBudgets.periodMonth, period),
          ),
        );
      if (
        BUDGET_ENFORCEMENT === "WARN" &&
        budgetRow &&
        committedBefore + prTotal > Number(budgetRow.amount)
      ) {
        res.json({
          ...updated,
          budget_warning: {
            over_by: committedBefore + prTotal - Number(budgetRow.amount),
            budget: Number(budgetRow.amount),
            committed: committedBefore,
          },
        });
        return;
      }
      // No budget row, or under/at budget → bare PR row, no budget_warning key.
      res.json(updated);
    },
  );

  prTransition("SUBMITTED", "APPROVED", "approve", APPROVER_ROLES, true);
  prTransition("SUBMITTED", "REJECTED", "reject", APPROVER_ROLES, true);

  // ── Department budgets (MOTM 2026-06-24 budget threshold) ───────────────────

  router.get("/budgets", requireAuth, async (req, res) => {
    const period = (req.query.period as string | undefined) ?? toPeriod(new Date());
    const rows = await db
      .select()
      .from(departmentBudgets)
      .where(eq(departmentBudgets.periodMonth, period));
    res.json(rows);
  });

  const budgetUpsertSchema = z.object({
    department: z.enum(departmentEnum.enumValues),
    period_month: z.string().regex(/^\d{4}-\d{2}$/),
    amount: z.number().min(0),
    note: z.string().optional(),
  });

  router.put("/budgets", requireAuth, requireRole(...BUDGET_ROLES), async (req, res) => {
    const parsed = budgetUpsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid budget payload.", parsed.error.issues);
      return;
    }
    const { department, period_month, amount, note } = parsed.data;
    const row = await upsertBudget(db, {
      department,
      periodMonth: period_month,
      amount,
      note: note ?? null,
      createdBy: req.user!.id,
    });
    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "department_budget.upsert",
      description: `${department} ${period_month} -> ₱${amount}`,
      entityType: "department_budget",
      entityId: row.id,
    });
    res.json(row);
  });

  router.get("/budgets/:department/status", requireAuth, async (req, res) => {
    const department = paramAsString(req.params.department);
    if (!(departmentEnum.enumValues as readonly string[]).includes(department)) {
      sendError(res, 400, "VALIDATION_ERROR", `Unknown department "${department}".`);
      return;
    }
    const period = (req.query.period as string | undefined) ?? toPeriod(new Date());
    const status = await getBudgetStatus(db, department as Department, period);
    res.json(status);
  });

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
      actorName: req.user!.name ?? null,
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
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_order.send",
      description: `${po.poNo}: DRAFT → SENT`,
      entityType: "purchase_order",
      entityId: id,
    });
    res.json(updated);
  });

  // ── Receiving (posts stock ledger IN to MAIN) ───────────────────────────────

  router.post("/purchase-orders/:id/receive", requireAuth, requireRole(...RECEIVE_ROLES), resolveOutletContext, async (req, res) => {
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

    // H6: the purchase_order table has NO location column, so the target outlet is
    // DERIVED from the receiving user's outlet scope (documented choice): an
    // ASSIGNED warehouse user credits THEIR outlet's MAIN; an ALL-scope user uses
    // X-Outlet-Id (or the single-outlet default). This closes the bug where receiving
    // credited the FIRST MAIN warehouse globally regardless of who received where.
    // resolveRequestLocationId applies the M1 membership rules (single-outlet
    // fallback / 400 on ambiguity / 403 on non-member).
    const locationId = await resolveRequestLocationId(db, req, res, undefined);
    if (!locationId) return;

    const [mainWarehouse] = await db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.type, "MAIN"), eq(warehouses.locationId, locationId)));
    if (!mainWarehouse) {
      sendError(res, 500, "NOT_FOUND", "MAIN warehouse not configured for this outlet.");
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

        // Costs track reality: receiving from a supplier is evidence of
        // affiliation, and the price actually paid is the freshest signal we
        // have — so every RECEIVED line upserts supplier_item.last_unit_cost
        // (unique on supplier_id+ingredient_id). Receiving lines carry no cost
        // of their own (receiving_report_line has none), so we use the PO
        // line's ordered unit_cost. supplier_sku is left alone (null on first
        // insert, untouched on update) — this endpoint has no SKU to offer.
        await tx
          .insert(supplierItems)
          .values({
            supplierId: po.supplierId,
            ingredientId: poLine.ingredientId,
            lastUnitCost: poLine.unitCost,
          })
          .onConflictDoUpdate({
            target: [supplierItems.supplierId, supplierItems.ingredientId],
            set: { lastUnitCost: poLine.unitCost },
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
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "purchase_order.receive",
      description: `Received against ${po.poNo} → ${rrNo}`,
      entityType: "receiving_report",
      entityId: rr.id,
    });

    res.status(201).json(rr);
  });

  // 0024: enrich each RR with its supplier (direct receipts carry supplier_id
  // on the RR itself; PO receipts carry it via the purchase order — COALESCE
  // picks whichever exists) and the PO number. po/poNo null = a DIRECT receipt
  // (frontend shows "Direct"). Read-only, additive — every existing RR field
  // is returned unchanged.
  router.get("/receiving-reports", requireAuth, async (_req, res) => {
    const rows = await db
      .select({
        rr: receivingReports,
        poNo: purchaseOrders.poNo,
        supplierId: suppliers.id,
        supplierCode: suppliers.code,
        supplierName: suppliers.name,
      })
      .from(receivingReports)
      .leftJoin(purchaseOrders, eq(receivingReports.poId, purchaseOrders.id))
      .leftJoin(
        suppliers,
        eq(suppliers.id, sql`COALESCE(${receivingReports.supplierId}, ${purchaseOrders.supplierId})`),
      );
    res.json(
      rows.map(({ rr, poNo, supplierId, supplierCode, supplierName }) => ({
        ...rr,
        poNo: poNo ?? null,
        supplier: supplierId ? { id: supplierId, code: supplierCode, name: supplierName } : null,
      })),
    );
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
