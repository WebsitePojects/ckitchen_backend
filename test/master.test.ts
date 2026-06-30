/**
 * ERP R2 — master data tests (CK1-ERP-006 §1-2)
 *
 * Suppliers + Customers CRUD (SUPER_ADMIN writes, code uniqueness, audit) and
 * Department↔Warehouse access upsert.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { auditLogs, departmentInventoryAccess } from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string;
let kitchenToken: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);
  adminToken = await login("admin@cloudkitchen.local", "admin123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
}, 60_000);

describe("POST /api/v1/suppliers", () => {
  it("401 without token", async () => {
    const res = await request(app).post("/api/v1/suppliers").send({ code: "S1", name: "X" });
    expect(res.status).toBe(401);
  });

  it("403 for non-admin", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ code: "S1", name: "X" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("creates a supplier and uppercases the code", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "sup-001", name: "Manila Meats", contact_phone: "0917", payment_term_days: 30 });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe("SUP-001");
    expect(res.body.name).toBe("Manila Meats");
    expect(res.body.paymentTermDays).toBe(30);
    expect(res.body.isActive).toBe(true);
  });

  it("409 on duplicate code (case-insensitive)", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "SUP-001", name: "Dup" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("writes an audit row for supplier.create", async () => {
    await new Promise((r) => setTimeout(r, 50));
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "supplier.create"));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1]!.entityType).toBe("supplier");
  });
});

describe("GET + PATCH /api/v1/suppliers", () => {
  it("lists suppliers", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((s: { code: string }) => s.code === "SUP-001")).toBe(true);
  });

  it("patches a supplier (deactivate)", async () => {
    const list = await request(app)
      .get("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`);
    const id = list.body.find((s: { code: string }) => s.code === "SUP-001").id;

    const res = await request(app)
      .patch(`/api/v1/suppliers/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false, contact_name: "Procurement" });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.contactName).toBe("Procurement");
  });

  it("filters by active=false", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers?active=false")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const s of res.body as Array<{ isActive: boolean }>) {
      expect(s.isActive).toBe(false);
    }
  });
});

describe("Customers", () => {
  it("creates and lists a customer", async () => {
    const create = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "cust-001", name: "Acme Catering" });
    expect(create.status).toBe(201);
    expect(create.body.code).toBe("CUST-001");

    const list = await request(app)
      .get("/api/v1/customers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((c: { code: string }) => c.code === "CUST-001")).toBe(true);
  });
});

describe("PUT + GET /api/v1/department-access", () => {
  it("upserts a department access row and is idempotent on (department, warehouse_type)", async () => {
    const first = await request(app)
      .put("/api/v1/department-access")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ department: "KITCHEN", warehouse_type: "KITCHEN", can_receive: true, can_issue: true });
    expect(first.status).toBe(200);
    expect(first.body.canReceive).toBe(true);

    // Same key again with a different value → UPDATE, not a duplicate row.
    const second = await request(app)
      .put("/api/v1/department-access")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ department: "KITCHEN", warehouse_type: "KITCHEN", can_receive: false });
    expect(second.status).toBe(200);
    expect(second.body.canReceive).toBe(false);
    expect(second.body.id).toBe(first.body.id); // same row updated

    const rows = await db
      .select()
      .from(departmentInventoryAccess)
      .where(eq(departmentInventoryAccess.department, "KITCHEN"));
    expect(rows.filter((r) => r.warehouseType === "KITCHEN").length).toBe(1);
  });

  it("403 for non-admin upsert", async () => {
    const res = await request(app)
      .put("/api/v1/department-access")
      .set("Authorization", `Bearer ${kitchenToken}`)
      .send({ department: "ADMIN", warehouse_type: "MAIN" });
    expect(res.status).toBe(403);
  });
});
