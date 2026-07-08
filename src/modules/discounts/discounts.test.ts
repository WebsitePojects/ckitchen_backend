import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../app.js";
import { createDb, type DB } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { eq } from "drizzle-orm";
import { aggregatorAccounts, brands, locations, orders, userOutletAccess, users } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";

let app: Express;
let db: DB;
let brandId: string;
let aggregatorAccountId: string;

let ownerToken: string;
let outletManagerToken: string;
let brandManagerToken: string;
let kitchenCrewToken: string;
let otherMgrToken: string;

const OWNER_CRED = { email: "owner@discounts.local", password: "owner-password" };
const OUTLET_MANAGER_CRED = { email: "outlet-mgr@discounts.local", password: "outlet-password" };
const BRAND_MANAGER_CRED = { email: "brand-mgr@discounts.local", password: "brand-password" };
const KITCHEN_CREW_CRED = { email: "crew@discounts.local", password: "crew-password" };
const OTHER_MGR_CRED = { email: "other-mgr@discounts.local", password: "other-password" };

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** Inserts a bare order row directly (bypasses ingest — only order.total matters here). */
async function createOrder(total: string): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      brandId,
      aggregatorAccountId,
      aggregator: "FOODPANDA",
      externalRef: `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customerName: "Test Customer",
      status: "NEW",
      total,
    })
    .returning();
  return order.id;
}

beforeAll(async () => {
  const created = createDb(); // in-memory PGlite, isolated per test file
  db = created.db;
  await runMigrations(db);

  const [location] = await db
    .insert(locations)
    .values({ code: "DISC1", name: "Discount Test Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();

  const [brand] = await db
    .insert(brands)
    .values({ locationId: location.id, name: "Test Brand", color: "#000000", salesPerfId: "SP-1" })
    .returning();
  brandId = brand.id;

  const [account] = await db
    .insert(aggregatorAccounts)
    .values({ brandId, aggregator: "FOODPANDA", externalMerchantId: "merchant-1" })
    .returning();
  aggregatorAccountId = account.id;

  await db.insert(users).values([
    {
      name: "Owner",
      email: OWNER_CRED.email,
      passwordHash: await hashPassword(OWNER_CRED.password),
      role: "OWNER",
    },
    {
      name: "Outlet Manager",
      email: OUTLET_MANAGER_CRED.email,
      passwordHash: await hashPassword(OUTLET_MANAGER_CRED.password),
      role: "OUTLET_MANAGER",
    },
    {
      name: "Brand Manager",
      email: BRAND_MANAGER_CRED.email,
      passwordHash: await hashPassword(BRAND_MANAGER_CRED.password),
      role: "BRAND_MANAGER",
    },
    {
      name: "Kitchen Crew",
      email: KITCHEN_CREW_CRED.email,
      passwordHash: await hashPassword(KITCHEN_CREW_CRED.password),
      role: "KITCHEN_CREW",
    },
  ]);

  // Grant the primary Outlet Manager access to the test outlet (so, after the
  // F3 outlet-scoping, they CAN approve this outlet's discounts).
  const [omUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, OUTLET_MANAGER_CRED.email));
  await db.insert(userOutletAccess).values({ userId: omUser.id, locationId: location.id });

  // A SECOND outlet + a manager with access ONLY to it — used to prove the F3
  // block: they must NOT be able to approve the FIRST outlet's discounts.
  const [location2] = await db
    .insert(locations)
    .values({ code: "DISC2", name: "Other Outlet", status: "ACTIVE", timezone: "Asia/Manila" })
    .returning();
  await db.insert(users).values({
    name: "Other Manager",
    email: OTHER_MGR_CRED.email,
    passwordHash: await hashPassword(OTHER_MGR_CRED.password),
    role: "OUTLET_MANAGER",
  });
  const [om2] = await db.select({ id: users.id }).from(users).where(eq(users.email, OTHER_MGR_CRED.email));
  await db.insert(userOutletAccess).values({ userId: om2.id, locationId: location2.id });

  app = createApp(db);

  ownerToken = await login(OWNER_CRED.email, OWNER_CRED.password);
  outletManagerToken = await login(OUTLET_MANAGER_CRED.email, OUTLET_MANAGER_CRED.password);
  brandManagerToken = await login(BRAND_MANAGER_CRED.email, BRAND_MANAGER_CRED.password);
  kitchenCrewToken = await login(KITCHEN_CREW_CRED.email, KITCHEN_CREW_CRED.password);
  otherMgrToken = await login(OTHER_MGR_CRED.email, OTHER_MGR_CRED.password);
});

describe("Discount catalog", () => {
  it("creates a catalog discount as BRAND_MANAGER", async () => {
    const res = await request(app)
      .post("/api/v1/discounts")
      .set("Authorization", `Bearer ${brandManagerToken}`)
      .send({ scope: "ORDER", brand_id: brandId, name: "10% Off Promo", type: "PERCENT", value: 10 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("10% Off Promo");
    expect(res.body.active).toBe(true);

    const list = await request(app).get("/api/v1/discounts").set("Authorization", `Bearer ${brandManagerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((d: { id: string }) => d.id === res.body.id)).toBe(true);
  });

  it("rejects catalog create for a non-privileged role (403)", async () => {
    const res = await request(app)
      .post("/api/v1/discounts")
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ scope: "ORDER", name: "Should Fail", type: "PERCENT", value: 5 });
    expect(res.status).toBe(403);
  });
});

describe("Apply discount — approval routing + effective_total", () => {
  it("an order with NO discounts has effective_total == order.total", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .get(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`);
    expect(res.status).toBe(200);
    expect(res.body.discounts).toEqual([]);
    expect(res.body.subtotal).toBe("1000.00");
    expect(res.body.discount_total).toBe("0.00");
    expect(res.body.effective_total).toBe("1000.00");
  });

  it("a small % (<=5%) auto-approves and immediately reduces effective_total", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 5, label: "Small promo", reason: "Loyalty" });
    expect(res.status).toBe(201);
    expect(res.body.approvalLevel).toBe("AUTO");
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.amount).toBe("50.00");
    expect(res.body.effective_total).toBe("950.00");

    const detail = await request(app)
      .get(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`);
    expect(detail.body.effective_total).toBe("950.00");
  });

  it("a large % (30%) routes to ADMIN, stays PENDING, effective_total unchanged until approved", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 30, label: "Big promo", reason: "Manager override" });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.approvalLevel).toBe("ADMIN");
    expect(applyRes.body.status).toBe("PENDING");
    expect(applyRes.body.amount).toBe("300.00");
    // Not yet approved — effective_total still full subtotal.
    expect(applyRes.body.effective_total).toBe("1000.00");

    const pendingId = applyRes.body.id as string;

    const queue = await request(app)
      .get("/api/v1/discounts/approvals?status=PENDING")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.some((r: { id: string }) => r.id === pendingId)).toBe(true);

    // Approve as OWNER → effective_total drops.
    const approveRes = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("APPROVED");
    expect(approveRes.body.effective_total).toBe("700.00");

    const detail = await request(app)
      .get(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.effective_total).toBe("700.00");
  });

  it("SUPERVISOR-level (10%) cannot be approved by KITCHEN_CREW (403), but OUTLET_MANAGER can", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 10, label: "Mid promo", reason: "Regular customer" });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.approvalLevel).toBe("SUPERVISOR");
    expect(applyRes.body.status).toBe("PENDING");

    const pendingId = applyRes.body.id as string;

    const forbidden = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`);
    expect(forbidden.status).toBe(403);

    const approved = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${outletManagerToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("APPROVED");
    expect(approved.body.effective_total).toBe("900.00");
  });

  it("F3: an OUTLET_MANAGER cannot see or approve a discount for an outlet outside their access (403)", async () => {
    const orderId = await createOrder("1000.00");
    const applyRes = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "PERCENT", value: 10, label: "Cross-outlet", reason: "tenancy test" });
    const pendingId = applyRes.body.id as string;

    // `otherMgr` is scoped to the SECOND outlet only — this order is in the first.
    const approve = await request(app)
      .post(`/api/v1/order-discounts/${pendingId}/approve`)
      .set("Authorization", `Bearer ${otherMgrToken}`);
    expect(approve.status).toBe(403);

    // ...and the request never appears in their approvals queue.
    const queue = await request(app)
      .get("/api/v1/discounts/approvals?status=PENDING")
      .set("Authorization", `Bearer ${otherMgrToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.some((r: { id: string }) => r.id === pendingId)).toBe(false);
  });

  it("SENIOR discount without id_note is rejected (400)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "SENIOR", value: 20, label: "Senior Citizen", reason: "Statutory" });
    expect(res.status).toBe(400);
  });

  it("SENIOR discount WITH id_note auto-approves (statutory, always AUTO)", async () => {
    const orderId = await createOrder("1000.00");
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/discounts`)
      .set("Authorization", `Bearer ${kitchenCrewToken}`)
      .send({ type: "SENIOR", value: 20, label: "Senior Citizen", reason: "Statutory", id_note: "Senior ID 12345" });
    expect(res.status).toBe(201);
    expect(res.body.approvalLevel).toBe("AUTO");
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.amount).toBe("200.00");
    expect(res.body.effective_total).toBe("800.00");
  });
});
