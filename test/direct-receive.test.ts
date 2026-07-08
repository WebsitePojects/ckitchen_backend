/**
 * 0024 — Direct receive = PROPER Receiving Report (gprci standard)
 *
 * Client review 2026-07-08: "when main warehouse receives there is an RR…
 * fields are so incomplete". POST /inventory/receive now creates, in the SAME
 * transaction as the stock increments:
 *   - ONE receiving_report row  (rr_no from the shared RR-… generator,
 *     po_id NULL, optional supplier_id / reference / notes)
 *   - its receiving_report_line rows (po_line_id NULL)
 *   - RECEIVE ledger rows stamped sourceDocumentNo = rr_no (matching the
 *     PO-receive path, so the ledger's source_ref enrichment covers both)
 *   - a supplier_item.last_unit_cost upsert per line when supplier + cost given
 *
 * Legacy minimal bodies (just items[]) stay valid — the RR is still created,
 * with supplier NULL. Response keeps { ok: true } and adds rr: { id, rrNo }.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import {
  receivingReportLines,
  receivingReports,
  stockLedgerEntries,
  supplierItems,
  suppliers,
} from "../src/db/schema.js";

let app: Express;
let db: DB;
let adminToken: string;
let warehouseToken: string;
let supplierId: string;
let ingredientId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  warehouseToken = await login("warehouse@cloudkitchen.local", "password123");

  const [supplier] = await db
    .insert(suppliers)
    .values({ code: "SUP-DR1", name: "Direct Receive Supplier" })
    .returning();
  supplierId = supplier!.id;

  const ingRes = await request(app)
    .post("/api/v1/ingredients")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "DirectReceiveRice", unit: "kg", unit_cost: "42.00", low_stock_threshold: "5" });
  expect(ingRes.status).toBe(201);
  ingredientId = ingRes.body.id as string;
}, 60_000);

describe("POST /api/v1/inventory/receive — direct Receiving Report (0024)", () => {
  let rrId: string;
  let rrNo: string;

  it("creates the RR + lines + ledger rows atomically (full body)", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        supplier_id: supplierId,
        reference: "DR-778899",
        notes: "walk-in delivery",
        items: [{ ingredient_id: ingredientId, quantity: 10, unit_cost: 42.5 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true); // existing field kept
    expect(res.body.rr).toBeTruthy(); // additive field
    expect(res.body.rr.rrNo).toMatch(/^RR-/); // same generator as the PO path
    rrId = res.body.rr.id as string;
    rrNo = res.body.rr.rrNo as string;

    const [rr] = await db.select().from(receivingReports).where(eq(receivingReports.id, rrId));
    expect(rr).toBeDefined();
    expect(rr!.poId).toBeNull(); // direct receipt — no PO behind it
    expect(rr!.supplierId).toBe(supplierId);
    expect(rr!.reference).toBe("DR-778899");
    expect(rr!.notes).toBe("walk-in delivery");
    expect(rr!.receivedByUserId).toBeTruthy(); // from the token, never the body

    const lines = await db
      .select()
      .from(receivingReportLines)
      .where(eq(receivingReportLines.rrId, rrId));
    expect(lines.length).toBe(1);
    expect(lines[0]!.poLineId).toBeNull(); // direct-receipt line
    expect(lines[0]!.ingredientId).toBe(ingredientId);
    expect(Number(lines[0]!.qtyReceived)).toBe(10);

    // Ledger rows carry the RR reference — same stamp as the PO-receive path.
    const ledger = await db
      .select()
      .from(stockLedgerEntries)
      .where(
        and(
          eq(stockLedgerEntries.sourceModule, "RECEIVE"),
          eq(stockLedgerEntries.sourceDocumentNo, rrNo),
        ),
      );
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.movementType).toBe("IN");
    expect(Number(ledger[0]!.quantity)).toBe(10);
    expect(Number(ledger[0]!.unitCost)).toBe(42.5); // cost stamped when provided
  });

  it("upserts supplier_item.last_unit_cost with the delivered cost", async () => {
    const [row] = await db
      .select()
      .from(supplierItems)
      .where(
        and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)),
      );
    expect(row).toBeDefined();
    expect(Number(row!.lastUnitCost)).toBe(42.5);
    expect(row!.supplierSku).toBeNull(); // never clobbered by the cost upsert
  });

  it("receiving again at a new cost updates the SAME supplier_item row", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        supplier_id: supplierId,
        items: [{ ingredient_id: ingredientId, quantity: 2, unit_cost: 44 }],
      });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(supplierItems)
      .where(
        and(eq(supplierItems.supplierId, supplierId), eq(supplierItems.ingredientId, ingredientId)),
      );
    expect(rows.length).toBe(1); // updated, not duplicated
    expect(Number(rows[0]!.lastUnitCost)).toBe(44);
  });

  it("404 for an unknown supplier_id (validated before touching stock)", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        supplier_id: "00000000-0000-0000-0000-000000000000",
        items: [{ ingredient_id: ingredientId, quantity: 1 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("legacy minimal body still 201 — RR created with supplier null", async () => {
    const res = await request(app)
      .post("/api/v1/inventory/receive")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ items: [{ ingredient_id: ingredientId, quantity: 3 }] });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.rr.rrNo).toMatch(/^RR-/);

    const [rr] = await db
      .select()
      .from(receivingReports)
      .where(eq(receivingReports.id, res.body.rr.id));
    expect(rr).toBeDefined();
    expect(rr!.poId).toBeNull();
    expect(rr!.supplierId).toBeNull();
    expect(rr!.reference).toBeNull();
  });

  it("GET /receiving-reports carries supplier info for direct RRs; poNo null → 'Direct'", async () => {
    const res = await request(app)
      .get("/api/v1/receiving-reports")
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(res.status).toBe(200);

    const rows = res.body as Array<{
      id: string;
      poNo: string | null;
      supplier: { id: string; code: string; name: string } | null;
    }>;
    const direct = rows.find((r) => r.id === rrId);
    expect(direct).toBeTruthy();
    expect(direct!.poNo).toBeNull(); // frontend renders "Direct"
    expect(direct!.supplier).toBeTruthy();
    expect(direct!.supplier!.id).toBe(supplierId);
    expect(direct!.supplier!.name).toBe("Direct Receive Supplier");
  });
});
