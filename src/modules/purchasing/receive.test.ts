/**
 * PO receive → supplier_item cost tracking.
 *
 * ERP rule: costs track reality, and receiving from a supplier is evidence of
 * affiliation (gprci pattern). Every RECEIVED PO line UPSERTs supplier_item
 * (unique on supplier_id+ingredient_id) with the PO line's ordered unit cost,
 * so `last_unit_cost` always reflects the most recent receipt. See
 * src/modules/purchasing/routes.ts POST /purchase-orders/:id/receive.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../app.js";
import { createDb, type DB } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { ingredients, locations, suppliers, supplierItems, users, warehouses } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";

let app: Express;
let db: DB;
let ingredientId: string;
let supplierId: string;
let ownerToken: string;

const OWNER_CRED = { email: "owner@receive.local", password: "owner-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** Creates a SENT (or PARTIAL) PO for `unitCost` and returns { poId, poLineId }. */
async function createSentPo(quantity: number, unitCost: number): Promise<{ poId: string; poLineId: string }> {
  const create = await request(app)
    .post("/api/v1/purchase-orders")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      supplier_id: supplierId,
      lines: [{ ingredient_id: ingredientId, quantity, unit_cost: unitCost }],
    });
  if (create.status !== 201) throw new Error(`createPo failed: ${create.status} ${JSON.stringify(create.body)}`);
  const poId = create.body.id as string;

  const send = await request(app)
    .post(`/api/v1/purchase-orders/${poId}/send`)
    .set("Authorization", `Bearer ${ownerToken}`);
  if (send.status !== 200) throw new Error(`send failed: ${send.status} ${JSON.stringify(send.body)}`);

  const get = await request(app)
    .get(`/api/v1/purchase-orders/${poId}`)
    .set("Authorization", `Bearer ${ownerToken}`);
  const poLineId = get.body.lines[0].id as string;

  return { poId, poLineId };
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await runMigrations(db);

  await db
    .insert(locations)
    .values({ code: "RCV1", name: "Receive Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [ingredient] = await db
    .insert(ingredients)
    .values({ name: "Receive Test Ingredient", unit: "kg", unitCost: "10.0000", lowStockThreshold: "5.0000" })
    .returning();
  ingredientId = ingredient.id;

  const [supplier] = await db
    .insert(suppliers)
    .values({ code: "SUP-RCV1", name: "Receive Test Supplier" })
    .returning();
  supplierId = supplier.id;

  await db.insert(users).values({
    name: "Owner",
    email: OWNER_CRED.email,
    passwordHash: await hashPassword(OWNER_CRED.password),
    role: "OWNER",
  });

  // POST /outlets creates a location + MAIN/KITCHEN warehouses, but here we
  // inserted the location directly (matching budget.test.ts's pattern), so no
  // MAIN warehouse exists yet. Receive requires one — insert it directly too.
  const [location] = await db.select().from(locations);
  await db.insert(warehouses).values({ locationId: location.id, type: "MAIN" });

  app = createApp(db);
  ownerToken = await login(OWNER_CRED.email, OWNER_CRED.password);
});

describe("POST /purchase-orders/:id/receive — supplier_item cost upsert", () => {
  it("creates a supplier_item row with the PO line's unit cost on first receive", async () => {
    const { poId, poLineId } = await createSentPo(10, 25.5);

    const receive = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 10 }] });
    expect(receive.status).toBe(201);

    const [row] = await db
      .select()
      .from(supplierItems)
      .where(and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)));
    expect(row).toBeDefined();
    expect(Number(row.lastUnitCost)).toBe(25.5);
    expect(row.supplierSku).toBeNull();
  });

  it("receiving again at a different cost updates the SAME row (no duplicate)", async () => {
    const { poId, poLineId } = await createSentPo(5, 30);

    const receive = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 5 }] });
    expect(receive.status).toBe(201);

    const rows = await db
      .select()
      .from(supplierItems)
      .where(and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)));
    expect(rows.length).toBe(1); // still one row — updated, not duplicated
    expect(Number(rows[0].lastUnitCost)).toBe(30);
  });

  it("preserves an existing supplier_sku across the cost-only upsert", async () => {
    await db
      .update(supplierItems)
      .set({ supplierSku: "SKU-KEEP-ME" })
      .where(and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)));

    const { poId, poLineId } = await createSentPo(3, 40);
    const receive = await request(app)
      .post(`/api/v1/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ lines: [{ po_line_id: poLineId, qty_received: 3 }] });
    expect(receive.status).toBe(201);

    const [row] = await db
      .select()
      .from(supplierItems)
      .where(and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)));
    expect(row.supplierSku).toBe("SKU-KEEP-ME"); // untouched by the receive upsert
    expect(Number(row.lastUnitCost)).toBe(40);
  });
});
