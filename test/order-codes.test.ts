/**
 * Order codes (migration 0022) — human-friendly copyable order references.
 *
 * Format: `<BRAND>-<AGG>-<RAND>`, e.g. "TOK-FP-7K3QD".
 *   BRAND — first 3 alphanumeric chars of the brand name, uppercased,
 *           X-padded when shorter ("Bo" → "BOX"); non-alphanumerics are
 *           skipped ("Jo's 7 Grill" → "JOS").
 *   AGG   — FP (FOODPANDA) | GF (GRABFOOD) | WI (OTHER / walk-in).
 *   RAND  — 5 chars from a base32 alphabet WITHOUT 0/O/1/I, via crypto.
 *
 * Coverage:
 *   - pure generator: format, padding, alphabet
 *   - ingest: code returned in IngestResult, per-aggregator AGG part
 *   - uniqueness across many ingests (unique index order_order_code_unique)
 *   - idempotent replay echoes the SAME code (DUPLICATE_ORDER semantics intact)
 *   - order_code present in GET /orders, GET /orders?detail=1, GET /orders/:id
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { generateOrderCode } from "../src/modules/orders/service.js";

/** RAND part alphabet — base32 without the ambiguous 0/O/1/I glyphs. */
const RAND_RE = "[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}";

let app: Express;
let db: DB;
let adminToken: string;

let tokyoBrandId: string;
let tokyoMenuId: string;
let boBrandId: string;
let boMenuId: string;

let _refSeq = 0;
function nextRef(): string {
  return `OC-${Date.now()}-${++_refSeq}`;
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token as string;
}

async function createBrandWithMenu(
  name: string,
  aggregators: Array<"FOODPANDA" | "GRABFOOD" | "OTHER">,
  stationId: string,
): Promise<{ brandId: string; menuItemId: string }> {
  const brandRes = await request(app)
    .post("/api/v1/brands")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name, color: "#123456" });
  expect(brandRes.status, JSON.stringify(brandRes.body)).toBe(201);
  const brandId = brandRes.body.id as string;

  for (const agg of aggregators) {
    const accRes = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aggregator: agg,
        external_merchant_id: `OC-${name.slice(0, 4)}-${agg}`,
        credential_ref: `ref-oc-${brandId.slice(0, 6)}-${agg}`,
      });
    expect(accRes.status, JSON.stringify(accRes.body)).toBe(201);
  }

  // No recipe → ingest reserves nothing, OTHER orders never hit the S4 block.
  const menuRes = await request(app)
    .post(`/api/v1/brands/${brandId}/menu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: `${name} Dish`, price: "100", station_id: stationId });
  expect(menuRes.status, JSON.stringify(menuRes.body)).toBe(201);
  return { brandId, menuItemId: menuRes.body.id as string };
}

async function ingest(
  brandId: string,
  menuItemId: string,
  aggregator: "FOODPANDA" | "GRABFOOD" | "OTHER",
  externalRef = nextRef(),
) {
  const res = await request(app)
    .post("/api/v1/ingest/order")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      brand_id: brandId,
      aggregator,
      external_ref: externalRef,
      items: [{ menu_item_id: menuItemId, qty: 1 }],
    });
  return res;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");

  const stRes = await request(app)
    .get("/api/v1/stations")
    .set("Authorization", `Bearer ${adminToken}`);
  const grillId = (stRes.body as Array<{ id: string; name: string }>).find(
    (s) => s.name === "Grill",
  )!.id;

  const tokyo = await createBrandWithMenu(
    "Tokyo House",
    ["FOODPANDA", "GRABFOOD", "OTHER"],
    grillId,
  );
  tokyoBrandId = tokyo.brandId;
  tokyoMenuId = tokyo.menuItemId;

  const bo = await createBrandWithMenu("Bo", ["FOODPANDA"], grillId);
  boBrandId = bo.brandId;
  boMenuId = bo.menuItemId;
}, 60_000);

// ---------------------------------------------------------------------------
// Pure generator
// ---------------------------------------------------------------------------

describe("generateOrderCode (pure)", () => {
  it("builds <BRAND>-<AGG>-<RAND> with hyphens between all three parts", () => {
    const code = generateOrderCode("Tokyo House", "FOODPANDA");
    expect(code).toMatch(new RegExp(`^TOK-FP-${RAND_RE}$`));
  });

  it("maps aggregators FOODPANDA→FP, GRABFOOD→GF, OTHER→WI", () => {
    expect(generateOrderCode("Tokyo House", "GRABFOOD")).toMatch(
      new RegExp(`^TOK-GF-${RAND_RE}$`),
    );
    expect(generateOrderCode("Tokyo House", "OTHER")).toMatch(
      new RegExp(`^TOK-WI-${RAND_RE}$`),
    );
  });

  it("X-pads brand names shorter than 3 alphanumerics", () => {
    expect(generateOrderCode("Bo", "FOODPANDA")).toMatch(new RegExp(`^BOX-FP-${RAND_RE}$`));
  });

  it("skips non-alphanumeric characters in the brand name", () => {
    expect(generateOrderCode("Jo's 7 Grill", "FOODPANDA")).toMatch(
      new RegExp(`^JOS-FP-${RAND_RE}$`),
    );
  });

  it("random part never contains the ambiguous 0/O/1/I glyphs", () => {
    for (let i = 0; i < 200; i++) {
      const rand = generateOrderCode("Tokyo House", "FOODPANDA").split("-")[2];
      expect(rand).not.toMatch(/[0O1I]/);
      expect(rand).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Ingest behavior
// ---------------------------------------------------------------------------

describe("POST /ingest/order returns order_code", () => {
  it("FOODPANDA order → TOK-FP-XXXXX", async () => {
    const res = await ingest(tokyoBrandId, tokyoMenuId, "FOODPANDA");
    expect(res.status).toBe(201);
    expect(res.body.order_code).toMatch(new RegExp(`^TOK-FP-${RAND_RE}$`));
  });

  it("GRABFOOD order → TOK-GF-XXXXX", async () => {
    const res = await ingest(tokyoBrandId, tokyoMenuId, "GRABFOOD");
    expect(res.status).toBe(201);
    expect(res.body.order_code).toMatch(new RegExp(`^TOK-GF-${RAND_RE}$`));
  });

  it("OTHER (walk-in) order → TOK-WI-XXXXX", async () => {
    const res = await ingest(tokyoBrandId, tokyoMenuId, "OTHER");
    expect(res.status).toBe(201);
    expect(res.body.order_code).toMatch(new RegExp(`^TOK-WI-${RAND_RE}$`));
  });

  it("short brand name is X-padded end-to-end (Bo → BOX-FP-XXXXX)", async () => {
    const res = await ingest(boBrandId, boMenuId, "FOODPANDA");
    expect(res.status).toBe(201);
    expect(res.body.order_code).toMatch(new RegExp(`^BOX-FP-${RAND_RE}$`));
  });

  it("codes are unique across many ingests", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const res = await ingest(tokyoBrandId, tokyoMenuId, "FOODPANDA");
      expect(res.status).toBe(201);
      codes.add(res.body.order_code as string);
    }
    expect(codes.size).toBe(15);
  });

  it("idempotent replay (same listing + external_ref) echoes the SAME code with DUPLICATE_ORDER", async () => {
    const ref = nextRef();
    const first = await ingest(tokyoBrandId, tokyoMenuId, "FOODPANDA", ref);
    expect(first.status).toBe(201);
    const firstCode = first.body.order_code as string;

    const replay = await ingest(tokyoBrandId, tokyoMenuId, "FOODPANDA", ref);
    expect(replay.status).toBe(200);
    expect(replay.body.code).toBe("DUPLICATE_ORDER");
    expect(replay.body.order_id).toBe(first.body.order_id);
    expect(replay.body.order_code).toBe(firstCode);
  });
});

// ---------------------------------------------------------------------------
// Read endpoints expose order_code
// ---------------------------------------------------------------------------

describe("order_code in GET /orders(/:id)", () => {
  let orderId: string;
  let orderCode: string;

  beforeAll(async () => {
    const res = await ingest(tokyoBrandId, tokyoMenuId, "FOODPANDA");
    expect(res.status).toBe(201);
    orderId = res.body.order_id as string;
    orderCode = res.body.order_code as string;
  });

  it("GET /orders includes order_code on every row", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; order_code: string | null }>;
    const row = rows.find((o) => o.id === orderId);
    expect(row, "ingested order missing from list").toBeTruthy();
    expect(row!.order_code).toBe(orderCode);
    // every order created through ingest has a code
    for (const o of rows) expect(o.order_code).toMatch(/^.{3}-(FP|GF|WI)-/);
  });

  it("GET /orders?detail=1 includes order_code alongside items/print_jobs", async () => {
    const res = await request(app)
      .get("/api/v1/orders?detail=1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ id: string; order_code: string; items: unknown[] }>).find(
      (o) => o.id === orderId,
    );
    expect(row).toBeTruthy();
    expect(row!.order_code).toBe(orderCode);
    expect(Array.isArray(row!.items)).toBe(true);
  });

  it("GET /orders/:id includes order_code", async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.order_code).toBe(orderCode);
  });
});
