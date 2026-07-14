/**
 * Discount evidence tests — W4 spec §10 ("Discounts") private-evidence contract.
 *
 * Confirmed gaps this closes (W4 audit):
 *   A1 — SENIOR/PWD discounts only required free-text id_note; nothing wrote
 *        order_discount.evidence_ref.
 *   A5 — no private evidence pipeline existed; the only image path
 *        (ems/cloudinary.ts uploadImage) returns PERMANENT public URLs.
 *
 * This file exercises src/modules/discounts/evidence.ts both directly (pure
 * metadata-stripping / token functions) and through the HTTP surface wired
 * into src/modules/discounts/routes.ts. No CLOUDINARY_* env vars are set in
 * this test process, so the service auto-selects LocalFsProvider — evidence
 * is written under ./.evidence/ and served via the signed
 * GET /discount-evidence/:token route.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { aggregatorAccounts, brands, locations, orderDiscounts, orders, users } from "../src/db/schema.js";
import { discountEvidenceAccessLogs } from "../src/db/w4-schema.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { stripJpegMetadata, stripPngMetadata, stripWebpMetadata, verifyEvidenceToken } from "../src/modules/discounts/evidence.js";

// ---------------------------------------------------------------------------
// Fixture image builders — hand-rolled minimal buffers, not real photos. They
// only need to satisfy each format's container structure well enough for the
// manual segment/chunk walkers in evidence.ts to parse correctly.
// ---------------------------------------------------------------------------

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** A minimal JPEG: SOI, APP0 (JFIF, kept), APP1 (EXIF, must be stripped), SOS+fake scan data, EOI. */
function buildJpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);

  const jfifPayload = Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(jfifPayload.length + 2), jfifPayload]);

  const exifPayload = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(exifPayload.length + 2), exifPayload]);

  // SOS: 1 component, minimal baseline header.
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const scanData = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);
  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([soi, app0, app1, sos, scanData, eoi]);
}

/** A minimal PNG: signature, IHDR, an eXIf ancillary chunk (must be stripped), IDAT, IEND. */
function buildPngWithExif(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type: string, data: Buffer): Buffer {
    // CRC content is irrelevant to the stripper (it only reads length/type to
    // find chunk boundaries), so a placeholder 4-byte CRC is fine here.
    return Buffer.concat([u32be(data.length), Buffer.from(type, "ascii"), data, Buffer.from([0, 0, 0, 0])]);
  }
  const ihdr = chunk("IHDR", Buffer.alloc(13));
  const exif = chunk("eXIf", Buffer.from("FAKE-EXIF-PAYLOAD", "latin1"));
  const idat = chunk("IDAT", Buffer.from([0x01, 0x02, 0x03]));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, exif, idat, iend]);
}

/** A minimal WEBP RIFF container with an EXIF sub-chunk (must be stripped). */
function buildWebpWithExif(): Buffer {
  function riffChunk(fourcc: string, data: Buffer): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length, 0);
    const padding = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(fourcc, "ascii"), size, data, padding]);
  }
  const vp8x = riffChunk("VP8X", Buffer.alloc(10));
  const exif = riffChunk("EXIF", Buffer.from("FAKE-WEBP-EXIF", "latin1"));
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), vp8x, exif]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), riffSize, body]);
}

function toDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Pure-function unit tests (no app/db needed)
// ---------------------------------------------------------------------------

describe("evidence.ts metadata stripping (pure functions)", () => {
  it("stripJpegMetadata removes the EXIF marker bytes but preserves SOI/EOI", () => {
    const original = buildJpegWithExif();
    expect(original.includes("Exif")).toBe(true); // sanity: fixture actually has it

    const stripped = stripJpegMetadata(original);
    expect(stripped.includes("Exif")).toBe(false);
    // Structure preserved: still starts with SOI and ends with EOI.
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
    // JFIF (APP0) is NOT metadata in the privacy sense — kept.
    expect(stripped.includes("JFIF")).toBe(true);
  });

  it("stripPngMetadata removes the eXIf chunk but preserves IHDR/IDAT/IEND", () => {
    const original = buildPngWithExif();
    expect(original.includes("FAKE-EXIF-PAYLOAD")).toBe(true);

    const stripped = stripPngMetadata(original);
    expect(stripped.includes("FAKE-EXIF-PAYLOAD")).toBe(false);
    expect(stripped.includes("IHDR")).toBe(true);
    expect(stripped.includes("IDAT")).toBe(true);
    expect(stripped.includes("IEND")).toBe(true);
  });

  it("stripWebpMetadata removes the EXIF RIFF chunk and fixes the container size", () => {
    const original = buildWebpWithExif();
    expect(original.includes("FAKE-WEBP-EXIF")).toBe(true);

    const stripped = stripWebpMetadata(original);
    expect(stripped.includes("FAKE-WEBP-EXIF")).toBe(false);
    expect(stripped.toString("ascii", 0, 4)).toBe("RIFF");
    expect(stripped.toString("ascii", 8, 12)).toBe("WEBP");
    const declaredSize = stripped.readUInt32LE(4);
    expect(declaredSize).toBe(stripped.length - 8);
  });

  it("verifyEvidenceToken rejects a garbage token as invalid", () => {
    const result = verifyEvidenceToken("not-a-real-token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("verifyEvidenceToken rejects a tampered signature as invalid", () => {
    const result = verifyEvidenceToken("eyJyZWYiOiJsb2NhbDp4LmpwZyIsImV4cCI6OTk5OTk5OTk5OTk5OX0.tampered-signature");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests
// ---------------------------------------------------------------------------

let app: Express;
let db: DB;
let brandId: string;
let walkInAccountId: string;

let ownerToken: string;
let accountingToken: string;
let kitchenCrewToken: string;
let ownerUserId: string;

const OWNER_CRED = { email: "owner@discount-evidence.local", password: "owner-password" };
const ACCOUNTING_CRED = { email: "accounting@discount-evidence.local", password: "accounting-password" };
const KITCHEN_CREW_CRED = { email: "crew@discount-evidence.local", password: "crew-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

async function createOrder(total: string): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      brandId,
      aggregatorAccountId: walkInAccountId,
      aggregator: "OTHER",
      externalRef: `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customerName: "Test Customer",
      status: "NEW",
      total,
    })
    .returning();
  return order.id;
}

function readLocalEvidenceBytes(evidenceRef: string): Buffer {
  expect(evidenceRef.startsWith("local:")).toBe(true);
  const filename = evidenceRef.slice("local:".length);
  return readFileSync(path.resolve("./.evidence", filename));
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await runMigrations(db);

  const [location] = await db
    .insert(locations)
    .values({ code: "EVID1", name: "Evidence Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [brand] = await db
    .insert(brands)
    .values({ locationId: location.id, name: "Evidence Test Brand", color: "#111111", salesPerfId: "SP-EV" })
    .returning();
  brandId = brand.id;

  const [walkInAccount] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, aggregator: "OTHER", externalMerchantId: "walkin-evid-1" })
    .returning();
  walkInAccountId = walkInAccount.id;

  await db.insert(users).values([
    { name: "Owner", email: OWNER_CRED.email, passwordHash: await hashPassword(OWNER_CRED.password), role: "OWNER" },
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
  const [ownerRow] = await db.select({ id: users.id }).from(users).where(eq(users.email, OWNER_CRED.email));
  ownerUserId = ownerRow.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Apply discount — evidence requirement + storage", () => {
  it("rejects a SENIOR discount with no evidence_image (400, EVIDENCE_REQUIRED)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "SENIOR", value: 20, label: "Senior Citizen", reason: "Statutory", id_note: "Senior ID 1" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details?.reason).toBe("EVIDENCE_REQUIRED");
  });

  it("rejects a PWD discount with no evidence_image (400)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PWD", value: 20, label: "PWD", reason: "Statutory", id_note: "PWD ID 1" });
    expect(res.status).toBe(400);
  });

  it("accepts a SENIOR discount WITH a valid JPEG evidence_image, persists evidence_ref, response excludes it", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 2",
        evidence_image: dataUrl,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body).not.toHaveProperty("evidenceRef");
    expect(res.body).not.toHaveProperty("evidence_ref");
    expect(JSON.stringify(res.body)).not.toContain("evidenceRef");
    expect(JSON.stringify(res.body)).not.toContain("local:");

    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, res.body.id));
    expect(row.evidenceRef).toBeTruthy();
    expect(row.evidenceRef!.startsWith("local:")).toBe(true);
  });

  it("strips the EXIF marker from the bytes actually written to storage", async () => {
    const orderId = await createOrder("1000.00");
    const fixture = buildJpegWithExif();
    const dataUrl = toDataUrl(fixture, "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 3",
        evidence_image: dataUrl,
      });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, res.body.id));
    const stored = readLocalEvidenceBytes(row.evidenceRef!);
    expect(stored.includes("Exif")).toBe(false);
    // Sanity: the original fixture DID have it, and the stored file isn't empty/corrupted.
    expect(fixture.includes("Exif")).toBe(true);
    expect(stored.length).toBeGreaterThan(0);
  });

  it("rejects an oversized evidence_image (400, EVIDENCE_TOO_LARGE)", async () => {
    const orderId = await createOrder("1000.00");
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0x42); // 6 MB > 5 MB cap
    const dataUrl = toDataUrl(oversized, "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 4",
        evidence_image: dataUrl,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.reason).toBe("EVIDENCE_TOO_LARGE");
  });

  it("rejects a disallowed MIME type (400, EVIDENCE_INVALID_MIME)", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(Buffer.from("GIF89a fake content"), "image/gif");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 5",
        evidence_image: dataUrl,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.reason).toBe("EVIDENCE_INVALID_MIME");
  });

  it("does NOT require evidence for a non-statutory (FIXED) discount", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "FIXED", value: 30, label: "Promo", reason: "Manual promo" });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, res.body.id));
    expect(row.evidenceRef).toBeNull();
  });

  it("stores evidence for a non-statutory discount when it IS provided (optional, not ignored)", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "FIXED", value: 30, label: "Promo with proof", reason: "Manual promo", evidence_image: dataUrl });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, res.body.id));
    expect(row.evidenceRef).toBeTruthy();
  });
});

describe("Exclusion — evidence_ref never appears in ordinary responses", () => {
  it("GET /orders/:id/discounts list response excludes evidenceRef on every row", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 6",
        evidence_image: dataUrl,
      });

    const res = await request(app)
      .get(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`);
    expect(res.status).toBe(200);
    expect(res.body.discounts.length).toBeGreaterThan(0);
    for (const row of res.body.discounts) {
      expect(row).not.toHaveProperty("evidenceRef");
    }
    expect(JSON.stringify(res.body)).not.toContain("evidenceRef");
  });

  it("GET /discounts/approvals excludes evidenceRef even for a PENDING row with evidence attached", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    // FIXED, amount 100 on a 1000 order: 10% > AUTO_MAX_PERCENT(5) and amount
    // 100 <= SUPERVISOR_MAX_AMOUNT(200) => SUPERVISOR-level, PENDING.
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "FIXED", value: 100, label: "Big promo", reason: "Manager comp", evidence_image: dataUrl });
    expect(applyRes.body.status).toBe("PENDING");

    const res = await request(app).get("/api/v1/discounts/approvals").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const mine = res.body.find((r: { id: string }) => r.id === applyRes.body.id);
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty("evidenceRef");

    // Approve it and check the decision response is clean too.
    const approveRes = await request(app)
      .post(`/api/v1/order-discounts/${applyRes.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body).not.toHaveProperty("evidenceRef");

    const [row] = await db.select().from(orderDiscounts).where(eq(orderDiscounts.id, applyRes.body.id));
    expect(row.evidenceRef).toBeTruthy(); // still persisted server-side, just never returned
  });
});

describe("GET /order-discounts/:id/evidence-url — role-gated signed access", () => {
  let discountId: string;

  beforeAll(async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 7",
        evidence_image: dataUrl,
      });
    discountId = res.body.id;
  });

  it("forbids a KITCHEN_CREW caller (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`);
    expect(res.status).toBe(403);
  });

  it("allows OWNER, returns { url, expires_at }, and writes an access-log row", async () => {
    const res = await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url?purpose=audit-review`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.url).toBe("string");
    expect(res.body.url).toContain("/discount-evidence/");
    expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const logRows = await db
      .select()
      .from(discountEvidenceAccessLogs)
      .where(eq(discountEvidenceAccessLogs.orderDiscountId, discountId));
    const mine = logRows.find((r) => r.purpose === "audit-review" && r.accessedBy === ownerUserId);
    expect(mine).toBeTruthy();
  });

  it("allows ACCOUNTING as well", async () => {
    const res = await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url`)
      .set("Authorization", `Bearer ${accountingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
  });

  it("404s when the target discount has no evidence attached", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "FIXED", value: 10, label: "No evidence", reason: "test" });
    const res = await request(app)
      .get(`/api/v1/order-discounts/${applyRes.body.id}/evidence-url`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("each access-url issuance writes its OWN access-log row (every access audited, not just the first)", async () => {
    const before = await db
      .select()
      .from(discountEvidenceAccessLogs)
      .where(eq(discountEvidenceAccessLogs.orderDiscountId, discountId));
    await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const after = await db
      .select()
      .from(discountEvidenceAccessLogs)
      .where(eq(discountEvidenceAccessLogs.orderDiscountId, discountId));
    expect(after.length).toBe(before.length + 1);
  });
});

describe("GET /discount-evidence/:token — LocalFsProvider serving route", () => {
  let discountId: string;

  beforeAll(async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 8",
        evidence_image: dataUrl,
      });
    discountId = res.body.id;
  });

  it("streams the file for a valid, unexpired token with the correct content-type", async () => {
    const urlRes = await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(urlRes.status).toBe(200);
    const relativeUrl = urlRes.body.url as string;

    const fileRes = await request(app).get(relativeUrl.replace(/^\/api\/v1/, "/api/v1"));
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers["content-type"]).toContain("image/jpeg");
    expect(Buffer.isBuffer(fileRes.body) || typeof fileRes.body === "object").toBeTruthy();
  });

  it("returns 404 for a garbage/invalid token", async () => {
    const res = await request(app).get("/api/v1/discount-evidence/not-a-real-token");
    expect(res.status).toBe(404);
  });

  it("returns 410 for an expired (but well-formed/valid-signature) token", async () => {
    const originalNow = Date.now();
    const urlRes = await request(app)
      .get(`/api/v1/order-discounts/${discountId}/evidence-url`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const relativeUrl = urlRes.body.url as string;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(originalNow + 121_000); // past the 120s TTL

    const res = await request(app).get(relativeUrl);
    expect(res.status).toBe(410);
  });
});

describe("discount_evidence_access_log stays append-only end-to-end", () => {
  it("rejects UPDATE and DELETE on a row written by the real evidence-url flow", async () => {
    const orderId = await createOrder("1000.00");
    const dataUrl = toDataUrl(buildJpegWithExif(), "image/jpeg");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID 9",
        evidence_image: dataUrl,
      });
    const urlRes = await request(app)
      .get(`/api/v1/order-discounts/${applyRes.body.id}/evidence-url`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(urlRes.status).toBe(200);

    const [logRow] = await db
      .select()
      .from(discountEvidenceAccessLogs)
      .where(eq(discountEvidenceAccessLogs.orderDiscountId, applyRes.body.id));
    expect(logRow).toBeTruthy();

    await expect(
      db.update(discountEvidenceAccessLogs).set({ purpose: "tampered" }).where(eq(discountEvidenceAccessLogs.id, logRow.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(discountEvidenceAccessLogs).where(eq(discountEvidenceAccessLogs.id, logRow.id)),
    ).rejects.toThrow();
  });
});
