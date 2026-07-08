/**
 * Department budget threshold for purchasing (MOTM 2026-06-24 budget-threshold item).
 *
 * Each department carries a monthly peso budget. When a Purchase Request is
 * submitted, we compute the department's already-committed spend for the PR's
 * period and warn (first cut) if submitting this PR would push committed over
 * the budget. A PR's period is derived from its `created_at` (PRs have no
 * period column). "Committed" = Σ(quantity × est_unit_cost) over every line of
 * every SUBMITTED or APPROVED PR in that department + period.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  departmentBudgets,
  departmentEnum,
  purchaseRequestLines,
  purchaseRequests,
  type DepartmentBudget,
} from "../../db/schema.js";

export type Department = (typeof departmentEnum.enumValues)[number];

/**
 * Soft enforcement: matches the client's "adjust the order" behavior from the
 * MOTM 2026-06-24 — over-budget submits WARN, they do not BLOCK. The client
 * will confirm hard-block vs. warn later; when that decision lands, branch on
 * this const rather than re-hardcoding warn-only logic inline at the call site.
 */
export const BUDGET_ENFORCEMENT: "WARN" | "BLOCK" = "WARN";

/** UTC-based 'YYYY-MM' period key (zero-padded month), e.g. 2026-07. */
export function toPeriod(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Sum of (quantity × est_unit_cost) across ALL lines of every purchase_request
 * whose department matches, whose status is SUBMITTED or APPROVED, and whose
 * created_at falls in `period`. Simple two-step select — no raw SQL aggregate.
 */
export async function computeCommitted(
  db: DB,
  department: Department,
  period: string,
): Promise<number> {
  const prs = await db
    .select()
    .from(purchaseRequests)
    .where(
      and(
        eq(purchaseRequests.department, department),
        inArray(purchaseRequests.status, ["SUBMITTED", "APPROVED"]),
      ),
    );

  const inPeriod = prs.filter((pr) => toPeriod(pr.createdAt) === period);
  if (inPeriod.length === 0) return 0;

  const lines = await db
    .select()
    .from(purchaseRequestLines)
    .where(
      inArray(
        purchaseRequestLines.prId,
        inPeriod.map((pr) => pr.id),
      ),
    );

  return lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.estUnitCost), 0);
}

/**
 * Budget vs. committed status for one (department, period). A missing budget
 * row means `budget = 0` (documented first-cut default — no row = no allowance
 * configured yet).
 */
export async function getBudgetStatus(
  db: DB,
  department: Department,
  period: string,
): Promise<{ department: string; period: string; budget: number; committed: number; remaining: number }> {
  const [row] = await db
    .select()
    .from(departmentBudgets)
    .where(
      and(eq(departmentBudgets.department, department), eq(departmentBudgets.periodMonth, period)),
    );
  const budget = row ? Number(row.amount) : 0;
  const committed = await computeCommitted(db, department, period);
  return { department, period, budget, committed, remaining: budget - committed };
}

/** Insert-or-update the budget for a (department, period). */
export async function upsertBudget(
  db: DB,
  input: {
    department: Department;
    periodMonth: string;
    amount: number;
    note?: string | null;
    createdBy: string;
  },
): Promise<DepartmentBudget> {
  const [row] = await db
    .insert(departmentBudgets)
    .values({
      department: input.department,
      periodMonth: input.periodMonth,
      amount: String(input.amount),
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [departmentBudgets.department, departmentBudgets.periodMonth],
      set: { amount: String(input.amount), note: input.note ?? null, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/**
 * Idempotent example seed: PURCHASING, the CURRENT month, ₱50,000. Uses the
 * current-month period, so re-running in a later month adds a fresh row for
 * that month rather than erroring (the unique constraint is per period). Within
 * the same month, a second run is a silent no-op.
 */
export async function seedExampleBudget(db: DB, ownerUserId: string): Promise<void> {
  const periodMonth = toPeriod(new Date());
  const [existing] = await db
    .select({ id: departmentBudgets.id })
    .from(departmentBudgets)
    .where(
      and(
        eq(departmentBudgets.department, "PURCHASING"),
        eq(departmentBudgets.periodMonth, periodMonth),
      ),
    );
  if (existing) return;
  await db.insert(departmentBudgets).values({
    department: "PURCHASING",
    periodMonth,
    amount: "50000.00",
    note: "Example seed budget",
    createdBy: ownerUserId,
  });
}
