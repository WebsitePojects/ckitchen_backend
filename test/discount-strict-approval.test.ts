/**
 * Strict discount approval mode — W4-5 (spec §10 "Discounts", CLIENT-CONFIRMED,
 * supersedes the older MOTM 3-tier AUTO/SUPERVISOR/ADMIN feature).
 *
 * Confirmed gap this closes (W4 audit A3+A4): the legacy routeApproval() in
 * src/modules/discounts/routes.ts let a crew member auto-approve <=5%/<=PHP50
 * discounts and let an OUTLET_MANAGER decide a "SUPERVISOR" tier, and
 * valueRangeError() allowed any 0-100% value. Spec §10 instead requires: ALL
 * non-statutory (not SENIOR/PWD) discounts are 10-30% only, remarks required,
 * PENDING until ADMIN approval — no crew auto-approve, no supervisor tier.
 * SENIOR/PWD stays the existing evidence-gated AUTO path (W4-4), untouched.
 *
 * Gated behind the "discounts.strict_approval" feature flag (seeded false —
 * drizzle/0032). This file proves BOTH states:
 *   - flag ON:  the new strict §10 routing (this file's primary purpose).
 *   - flag OFF: byte-identical to the pre-W4-5 3-tier behavior (regression
 *     proof — mirrors the equivalent assertions already in
 *     src/modules/discounts/discounts.test.ts, run here under an explicit
 *     flag-OFF setup so a future change to the default can't silently break
 *     legacy behavior without this file also failing).
 *
 * Harness mirrors src/modules/discounts/discounts.test.ts (walk-in-only order
 * fixtures + role logins) and test/discount-evidence.test.ts (SENIOR/PWD
 * evidence upload) plus test/orders-recipe-snapshot.test.ts's setFlag()
 * pattern (direct operational_feature_flag row update).
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { operationalFeatureFlags } from "../src/db/enterprise-schema.js";
import { aggregatorAccounts, brands, locations, orders, userOutletAccess, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { DISCOUNTS_STRICT_APPROVAL_FLAG } from "../src/modules/discounts/routes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let app: Express;
let db: DB;
let brandId: string;
let walkInAccountId: string;

let ownerToken: string;
let outletManagerToken: string;
let kitchenCrewToken: string;

const OWNER_CRED = { email: "owner@discount-strict.local", password: "owner-password" };
const OUTLET_MANAGER_CRED = { email: "outlet-mgr@discount-strict.local", password: "outlet-password" };
const KITCHEN_CREW_CRED = { email: "crew@discount-strict.local", password: "crew-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

async function setStrict(enabled: boolean): Promise<void> {
  await db
    .update(operationalFeatureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(operationalFeatureFlags.key, DISCOUNTS_STRICT_APPROVAL_FLAG));
}

/** Bare walk-in (OTHER) order — manual discounts are walk-in only (2026-07-08). */
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

// Minimal valid JPEG (SOI + APP0/JFIF + SOS + fake scan data + EOI), same
// shape test/discount-evidence.test.ts uses — just enough to pass evidence.ts's
// magic-byte/MIME validation for the SENIOR/PWD evidence-gated test below.
function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function buildMinimalJpeg(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const jfifPayload = Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(jfifPayload.length + 2), jfifPayload]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const scanData = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sos, scanData, eoi]);
}

function evidenceDataUrl(): string {
  return `data:image/jpeg;base64,${buildMinimalJpeg().toString("base64")}`;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await runMigrations(db);

  const [location] = await db
    .insert(locations)
    .values({ code: "STRICT1", name: "Strict Approval Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [brand] = await db
    .insert(brands)
    .values({ locationId: location.id, name: "Strict Test Brand", color: "#222222", salesPerfId: "SP-STRICT" })
    .returning();
  brandId = brand.id;

  const [walkInAccount] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, aggregator: "OTHER", externalMerchantId: "walkin-strict-1" })
    .returning();
  walkInAccountId = walkInAccount.id;

  await db.insert(users).values([
    { name: "Owner", email: OWNER_CRED.email, passwordHash: await hashPassword(OWNER_CRED.password), role: "OWNER" },
    {
      name: "Outlet Manager",
      email: OUTLET_MANAGER_CRED.email,
      passwordHash: await hashPassword(OUTLET_MANAGER_CRED.password),
      role: "OUTLET_MANAGER",
    },
    {
      name: "Kitchen Crew",
      email: KITCHEN_CREW_CRED.email,
      passwordHash: await hashPassword(KITCHEN_CREW_CRED.password),
      role: "KITCHEN_CREW",
    },
  ]);

  // Grant the Outlet Manager access to this outlet so the F3 tenancy scope
  // doesn't confound the strict-mode 403 assertions below (they must fail
  // because of ROLE, not because of outlet scope).
  const [omUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, OUTLET_MANAGER_CRED.email));
  await db.insert(userOutletAccess).values({ userId: omUser.id, locationId: location.id });

  app = createApp(db);

  ownerToken = await login(OWNER_CRED.email, OWNER_CRED.password);
  outletManagerToken = await login(OUTLET_MANAGER_CRED.email, OUTLET_MANAGER_CRED.password);
  kitchenCrewToken = await login(KITCHEN_CREW_CRED.email, KITCHEN_CREW_CRED.password);
});

// ---------------------------------------------------------------------------
// Flag ON — strict §10 routing
// ---------------------------------------------------------------------------

describe("discounts.strict_approval flag ON", () => {
  beforeAll(async () => {
    await setStrict(true);
  });

  it("rejects a non-statutory PERCENT discount below 10% (400 VALIDATION_ERROR)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 5, label: "Too small", reason: "loyalty" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-statutory PERCENT discount above 30% (400 VALIDATION_ERROR)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 35, label: "Too big", reason: "manager override" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("a 15% non-statutory PERCENT discount is accepted but PENDING (not auto-approved), level ADMIN", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 15, label: "In range", reason: "regular customer" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.approvalLevel).toBe("ADMIN");
    // Not applied yet — effective_total is unaffected until an admin approves.
    expect(res.body.effective_total).toBe("1000.00");
  });

  it("boundary: exactly 10% is accepted (PENDING/ADMIN, not rejected)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 10, label: "Lower boundary", reason: "boundary test" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.approvalLevel).toBe("ADMIN");
  });

  it("boundary: exactly 30% is accepted (PENDING/ADMIN, not rejected)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 30, label: "Upper boundary", reason: "boundary test" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.approvalLevel).toBe("ADMIN");
  });

  it("rejects a strict-mode PERCENT discount with missing remarks/reason (400)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 15, label: "No reason given" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("a FIXED (peso) non-statutory discount skips the % range check but is still forced PENDING/ADMIN", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "FIXED", value: 500, label: "Peso promo", reason: "manager comp" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.approvalLevel).toBe("ADMIN");
  });

  it("a VOUCHER non-statutory discount is also forced PENDING/ADMIN under strict mode", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "VOUCHER", value: 100, label: "Gift voucher", reason: "voucher redemption" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.approvalLevel).toBe("ADMIN");
  });

  it("OUTLET_MANAGER cannot approve a strict-mode PENDING discount (403 — no supervisor tier)", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 15, label: "Blocked approver", reason: "regular customer" });
    const pendingId = applyRes.body.id as string;

    const res = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${outletManagerToken}`);
    expect(res.status).toBe(403);
  });

  it("OWNER (admin) CAN approve a strict-mode PENDING discount -> APPROVED", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 15, label: "Admin approves", reason: "regular customer" });
    const pendingId = applyRes.body.id as string;

    const res = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.effective_total).toBe("850.00");
  });

  it("SENIOR discount with evidence is still AUTO-approved, unaffected by strict mode", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({
        type: "SENIOR",
        value: 20,
        label: "Senior Citizen",
        reason: "Statutory",
        id_note: "Senior ID strict-1",
        evidence_image: evidenceDataUrl(),
      });
    expect(res.status).toBe(201);
    expect(res.body.approvalLevel).toBe("AUTO");
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.effective_total).toBe("800.00");
  });

  it("SENIOR discount WITHOUT evidence is still rejected under strict mode (W4-4 untouched)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "SENIOR", value: 20, label: "Senior Citizen", reason: "Statutory", id_note: "Senior ID strict-2" });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.reason).toBe("EVIDENCE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Flag OFF — legacy 3-tier regression proof
// ---------------------------------------------------------------------------

describe("discounts.strict_approval flag OFF (legacy 3-tier regression)", () => {
  beforeAll(async () => {
    await setStrict(false);
  });

  it("a <=5% non-statutory PERCENT discount still auto-approves (AUTO tier intact)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 5, label: "Small promo", reason: "Loyalty" });
    expect(res.status).toBe(201);
    expect(res.body.approvalLevel).toBe("AUTO");
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.effective_total).toBe("950.00");
  });

  it("OUTLET_MANAGER can still approve a SUPERVISOR-tier (10%) discount (legacy supervisor tier intact)", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 10, label: "Mid promo", reason: "Regular customer" });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.approvalLevel).toBe("SUPERVISOR");
    expect(applyRes.body.status).toBe("PENDING");

    const res = await request(app)
      .post(`/api/v1/order-discounts/${applyRes.body.id}/approve`)
      .set("Authorization", `Bearer ${outletManagerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.effective_total).toBe("900.00");
  });

  it("a 35% PERCENT discount (outside the strict 10-30 band) is still accepted — no range check when flag is off", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 35, label: "Big legacy promo", reason: "Manager override" });
    expect(res.status).toBe(201);
    expect(res.body.approvalLevel).toBe("ADMIN");
    expect(res.body.status).toBe("PENDING");
  });
});
