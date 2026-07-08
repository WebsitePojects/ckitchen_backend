import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { createDb, type DB } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { ingredients, locations, users } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";
import { toPeriod } from "./budget.js";

let app: Express;
let db: DB;
let ingredientId: string;

let ownerToken: string;
let accountingToken: string;
let kitchenCrewToken: string;

const PERIOD = toPeriod(new Date());

const OWNER_CRED = { email: "owner@budget.local", password: "owner-password" };
const ACCOUNTING_CRED = { email: "acct@budget.local", password: "acct-password" };
const KITCHEN_CREW_CRED = { email: "crew@budget.local", password: "crew-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** Creates a DRAFT PR and returns its id. Uses the OWNER token (a REQUESTER role). */
async function createPr(
  department: string,
  quantity: number,
  estUnitCost: number,
): Promise<string> {
  const res = await request(app)
    .post("/api/v1/purchase-requests")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      department,
      lines: [{ ingredient_id: ingredientId, quantity, est_unit_cost: estUnitCost }],
    });
  if (res.status !== 201) throw new Error(`createPr failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

async function submitPr(id: string) {
  return request(app)
    .post(`/api/v1/purchase-requests/${id}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await runMigrations(db);

  await db
    .insert(locations)
    .values({ code: "BUD1", name: "Budget Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [ingredient] = await db
    .insert(ingredients)
    .values({ name: "Test Ingredient", unit: "kg", unitCost: "100.0000", lowStockThreshold: "5.0000" })
    .returning();
  ingredientId = ingredient.id;

  await db.insert(users).values([
    {
      name: "Owner",
      email: OWNER_CRED.email,
      passwordHash: await hashPassword(OWNER_CRED.password),
      role: "OWNER",
    },
    {
      name: "Accounting",
      email: ACCOUNTING_CRED.email,
      passwordHash: await hashPassword(ACCOUNTING_CRED.password),
      role: "ACCOUNTING",
    },
    {
      name: "Kitchen Crew",
      email: KITCHEN_CREW_CRED.email,
      passwordHash: await hashPassword(KITCHEN_CREW_CRED.password),
      role: "KITCHEN_CREW",
    },
  ]);

  app = createApp(db);

  ownerToken = await login(OWNER_CRED.email, OWNER_CRED.password);
  accountingToken = await login(ACCOUNTING_CRED.email, ACCOUNTING_CRED.password);
  kitchenCrewToken = await login(KITCHEN_CREW_CRED.email, KITCHEN_CREW_CRED.password);
});

describe("Department budgets — CRUD + status", () => {
  it("OWNER sets a budget; GET /budgets lists it; status is correct before any PRs", async () => {
    const put = await request(app)
      .put("/api/v1/budgets")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ department: "SALES", period_month: PERIOD, amount: 10000 });
    expect(put.status).toBe(200);
    expect(put.body.department).toBe("SALES");
    expect(Number(put.body.amount)).toBe(10000);

    const list = await request(app)
      .get(`/api/v1/budgets?period=${PERIOD}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((b: { department: string }) => b.department === "SALES")).toBe(true);

    const status = await request(app)
      .get(`/api/v1/budgets/SALES/status?period=${PERIOD}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      department: "SALES",
      period: PERIOD,
      budget: 10000,
      committed: 0,
      remaining: 10000,
    });
  });

  it("ACCOUNTING may also upsert a budget", async () => {
    const put = await request(app)
      .put("/api/v1/budgets")
      .set("Authorization", `Bearer ${accountingToken}`)
      .send({ department: "ACCOUNTING", period_month: PERIOD, amount: 7500 });
    expect(put.status).toBe(200);
    expect(Number(put.body.amount)).toBe(7500);
  });

  it("a non-OWNER/ACCOUNTING role cannot upsert a budget (403)", async () => {
    const put = await request(app)
      .put("/api/v1/budgets")
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ department: "KITCHEN", period_month: PERIOD, amount: 999 });
    expect(put.status).toBe(403);
  });

  it("status for a department with no budget row reports budget 0", async () => {
    const status = await request(app)
      .get(`/api/v1/budgets/ADMIN/status?period=${PERIOD}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      department: "ADMIN",
      period: PERIOD,
      budget: 0,
      committed: 0,
      remaining: 0,
    });
  });

  it("rejects an unknown department in the status route (400)", async () => {
    const status = await request(app)
      .get(`/api/v1/budgets/NOPE/status?period=${PERIOD}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(status.status).toBe(400);
  });
});

describe("Submit-time budget warning (WARN, not block)", () => {
  it("a PR under budget submits with NO budget_warning key, and status reflects committed", async () => {
    await request(app)
      .put("/api/v1/budgets")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ department: "PRODUCTION", period_month: PERIOD, amount: 10000 });

    // 4 × 1000 = 4000, under the 10000 budget.
    const prId = await createPr("PRODUCTION", 4, 1000);
    const submit = await submitPr(prId);
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe("SUBMITTED");
    expect(submit.body.budget_warning).toBeUndefined();

    const status = await request(app)
      .get(`/api/v1/budgets/PRODUCTION/status?period=${PERIOD}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(status.body.committed).toBe(4000);
    expect(status.body.remaining).toBe(6000);
  });

  it("a PR that pushes committed over budget still SUBMITS but returns a budget_warning", async () => {
    await request(app)
      .put("/api/v1/budgets")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ department: "QA", period_month: PERIOD, amount: 5000 });

    // 8 × 1000 = 8000 > 5000 budget, committedBefore = 0 → over_by 3000.
    const prId = await createPr("QA", 8, 1000);
    const submit = await submitPr(prId);
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe("SUBMITTED"); // warn, not block
    expect(submit.body.budget_warning).toEqual({
      over_by: 3000,
      budget: 5000,
      committed: 0,
    });
  });

  it("a department with NO budget row never warns, regardless of amount", async () => {
    // KITCHEN has no budget row set.
    const prId = await createPr("KITCHEN", 10, 1000); // 10000
    const submit = await submitPr(prId);
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe("SUBMITTED");
    expect(submit.body.budget_warning).toBeUndefined();
  });
});
