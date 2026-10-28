/**
 * Purchasing create endpoints are duplicate-safe (rule: one press = one effect, migration
 * 0053): the same client_request_id, sequential or concurrent, makes one PR / one PO with one
 * audit row; another user's key is refused; lists are newest-first, bounded and validated.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { auditLogs, ingredients, purchaseOrders, purchaseRequests, suppliers } from "../src/db/schema.js";

let app: Express;
let db: DB;
let owner: string;
let purchasing: string;
let ingredientId: string;
let supplierId: string;

async function login(email: string, password: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  owner = await login("admin@cloudkitchen.local", "admin123");
  purchasing = await login("supplier_coordinator@cloudkitchen.local", "password123");
  const [ing] = await db.insert(ingredients).values({ name: `Idem Rice ${randomUUID().slice(0, 6)}`, unit: "kg", unitCost: "50", lowStockThreshold: "0" }).returning();
  ingredientId = ing!.id;
  const [sup] = await db.insert(suppliers).values({ code: `IDEM-${randomUUID().slice(0, 6)}`, name: "Idem Supplier" }).returning();
  supplierId = sup!.id;
});

const prBody = (key: string) => ({ client_request_id: key, department: "KITCHEN", lines: [{ ingredient_id: ingredientId, quantity: 2, est_unit_cost: 50 }] });
const poBody = (key: string) => ({ client_request_id: key, supplier_id: supplierId, lines: [{ ingredient_id: ingredientId, quantity: 3, unit_cost: 48 }] });

describe("POST /purchase-requests with client_request_id", () => {
  it("sequential + concurrent repeats make one PR and one audit row", async () => {
    const key = randomUUID();
    const send = () => request(app).post("/api/v1/purchase-requests").set("Authorization", `Bearer ${owner}`).send(prBody(key));
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const c = await send();
    expect(c.status).toBe(200);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);

    const rows = await db.select().from(purchaseRequests).where(eq(purchaseRequests.clientRequestId, key));
    expect(rows).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, rows[0]!.id));
    expect(audits.filter((x) => x.action === "purchase_request.create")).toHaveLength(1);
  });

  it("another user's key is refused; no key still works (older screens)", async () => {
    const key = randomUUID();
    expect((await request(app).post("/api/v1/purchase-requests").set("Authorization", `Bearer ${owner}`).send(prBody(key))).status).toBe(201);
    const other = await request(app).post("/api/v1/purchase-requests").set("Authorization", `Bearer ${purchasing}`).send(prBody(key));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const { client_request_id: _unused, ...legacy } = prBody(key);
    expect((await request(app).post("/api/v1/purchase-requests").set("Authorization", `Bearer ${owner}`).send(legacy)).status).toBe(201);
  });
});

describe("POST /purchase-orders with client_request_id", () => {
  it("sequential + concurrent repeats make one PO and one audit row", async () => {
    const key = randomUUID();
    const send = () => request(app).post("/api/v1/purchase-orders").set("Authorization", `Bearer ${purchasing}`).send(poBody(key));
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect((await send()).status).toBe(200);

    const rows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.clientRequestId, key));
    expect(rows).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, rows[0]!.id));
    expect(audits.filter((x) => x.action === "purchase_order.create")).toHaveLength(1);
  });
});

describe("purchasing lists", () => {
  it("newest first, bounded by ?limit, unknown filters are 400", async () => {
    const list = await request(app).get("/api/v1/purchase-requests?limit=2").set("Authorization", `Bearer ${owner}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeLessThanOrEqual(2);
    if (list.body.length === 2) expect(list.body[0].createdAt >= list.body[1].createdAt).toBe(true);

    for (const url of ["/api/v1/purchase-requests?status=MAYBE", "/api/v1/purchase-requests?department=SPACE", "/api/v1/purchase-orders?status=LOST", "/api/v1/purchase-orders?supplier_id=x"]) {
      const res = await request(app).get(url).set("Authorization", `Bearer ${owner}`);
      expect(res.status, url).toBe(400);
    }
  });
});
