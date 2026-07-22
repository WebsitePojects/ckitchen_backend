import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { orders } from "../src/db/schema.js";
import { randomUUID } from "node:crypto";

let app: Express;
let db: DB;
let adminToken: string;
let staffToken: string;

const ADMIN_EMAIL = "admin@cloudkitchen.local";
const ADMIN_PASSWORD = "admin123";
const STAFF_EMAIL = "kitchen_staff@cloudkitchen.local";
const STAFF_PASSWORD = "password123";

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token;
}

beforeAll(async () => {
  const created = createDb(); // in-memory, isolated per test file
  db = created.db;
  await seed(db); // runs migrations + seeds 1 location, 5 stations, role users

  app = createApp(db);

  adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  staffToken = await login(STAFF_EMAIL, STAFF_PASSWORD);
});

describe("POST /api/v1/brands", () => {
  it("creates a brand as SUPER_ADMIN -> 201", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tokyo House", color: "#FF0000" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("Tokyo House");
    expect(res.body.color).toBe("#FF0000");
    expect(res.body.isActive).toBe(true);
    expect(res.body.locationId).toBeTruthy();
  });

  it("rejects a KITCHEN_STAFF token with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Forbidden Brand", color: "#000000" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects an unauthenticated request with 401 AUTH_REQUIRED", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .send({ name: "No Auth Brand", color: "#111111" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("rejects an invalid body with 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ color: "#FF0000" }); // missing name

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/brands", () => {
  it("lists brands including the newly created one", async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Seoul Bowl", color: "#00FF00" });
    expect(createRes.status).toBe(201);

    const listRes = await request(app)
      .get("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const names = listRes.body.map((b: { name: string }) => b.name);
    expect(names).toContain("Seoul Bowl");
  });

  it("filters by is_active", async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Soon Inactive", color: "#ABCDEF" });
    const brandId = createRes.body.id;

    await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false });

    const activeRes = await request(app)
      .get("/api/v1/brands?is_active=true")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.some((b: { id: string }) => b.id === brandId)).toBe(false);

    const inactiveRes = await request(app)
      .get("/api/v1/brands?is_active=false")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(inactiveRes.status).toBe(200);
    expect(inactiveRes.body.some((b: { id: string }) => b.id === brandId)).toBe(true);
  });
});

describe("PATCH /api/v1/brands/{id}", () => {
  it("updates brand fields and toggles is_active as SUPER_ADMIN", async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Edit Me", color: "#123456" });
    const brandId = createRes.body.id;

    const patchRes = await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Edited Name", is_active: false });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe("Edited Name");
    expect(patchRes.body.isActive).toBe(false);
  });

  it("rejects KITCHEN_STAFF with 403 FORBIDDEN", async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Patch Forbidden", color: "#654321" });
    const brandId = createRes.body.id;

    const patchRes = await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Hacked" });

    expect(patchRes.status).toBe(403);
  });

  it("returns 404 NOT_FOUND for an unknown brand id", async () => {
    const res = await request(app)
      .patch("/api/v1/brands/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("Brand activity log (MOTM 2026-07-01)", () => {
  let brandId: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Activity Brand", color: "#0f0f0f" });
    brandId = createRes.body.id;
  });

  it("records an event only when is_active actually flips", async () => {
    // Toggle to inactive → 1 event
    await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: false, activity_note: "closed for the day" });

    // A no-op patch (same value, different field) → NO new event
    await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Activity Brand Renamed" });

    // Toggle back to active → 2nd event
    await request(app)
      .patch(`/api/v1/brands/${brandId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ is_active: true });

    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events).toHaveLength(2);
    // Chronological: INACTIVE first, then ACTIVE
    expect(res.body.events[0].status).toBe("INACTIVE");
    expect(res.body.events[0].note).toBe("closed for the day");
    expect(res.body.events[1].status).toBe("ACTIVE");
    expect(res.body.events[0].changedBy).toBeTruthy();
  });

  it("rejects from > to with 400", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity?from=2026-07-31&to=2026-07-01`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for an unknown brand", async () => {
    const res = await request(app)
      .get("/api/v1/brands/00000000-0000-0000-0000-000000000000/activity")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("a date window that excludes all events returns an empty list", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity?from=2020-01-01&to=2020-01-31`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
  });
});

describe("Brand activity — ?detail=daily&month= (client review 2026-07-08)", () => {
  let brandId: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Daily Activity Brand", color: "#224466" });
    brandId = createRes.body.id;

    const accRes = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-DAILY", credential_ref: "daily-ref" });
    const accountId = accRes.body.id as string;

    // Seed orders DIRECTLY so placed_at lands on exact UTC days of 2026-03.
    await db.insert(orders).values([
      { brandId, aggregatorAccountId: accountId, aggregator: "FOODPANDA", externalRef: "daily-1", total: "100.50", status: "COMPLETED", placedAt: new Date("2026-03-05T10:00:00Z") },
      { brandId, aggregatorAccountId: accountId, aggregator: "FOODPANDA", externalRef: "daily-2", total: "49.50", status: "NEW", placedAt: new Date("2026-03-05T22:30:00Z") },
      { brandId, aggregatorAccountId: accountId, aggregator: "FOODPANDA", externalRef: "daily-3", total: "999.00", status: "CANCELLED", cancelReason: "test", placedAt: new Date("2026-03-05T12:00:00Z") },
      { brandId, aggregatorAccountId: accountId, aggregator: "FOODPANDA", externalRef: "daily-4", total: "25.00", status: "COMPLETED", placedAt: new Date("2026-03-31T23:59:00Z") },
    ]);
  });

  it("returns { changes, daily } with dense zero-filled day buckets; cancelled excluded", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity?detail=daily&month=2026-03`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.changes)).toBe(true);
    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.daily).toHaveLength(31); // dense — every day of March

    const day5 = res.body.daily[4];
    expect(day5.date).toBe("2026-03-05");
    expect(day5.orders).toBe(2); // the CANCELLED order is excluded
    expect(day5.revenue).toBe(150); // 100.50 + 49.50 — not the cancelled 999

    expect(res.body.daily[30]).toEqual({ date: "2026-03-31", orders: 1, revenue: 25 });
    expect(res.body.daily[0]).toEqual({ date: "2026-03-01", orders: 0, revenue: 0 });
  });

  it("default (no detail param) shape is unchanged — { events }, no daily/changes", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.daily).toBeUndefined();
    expect(res.body.changes).toBeUndefined();
  });

  it("400 when detail=daily lacks a valid month=YYYY-MM", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity?detail=daily`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 for an unknown detail value", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/activity?detail=hourly&month=2026-03`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe("Aggregator accounts", () => {
  let brandId: string;

  beforeAll(async () => {
    const createRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Accounts Brand", color: "#777777" });
    brandId = createRes.body.id;
  });

  it("adds a FOODPANDA account -> 201, credential_ref never returned", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aggregator: "FOODPANDA",
        external_merchant_id: "FP-1001",
        credential_ref: "super-secret-credential-value",
      });

    expect(res.status).toBe(201);
    expect(res.body.aggregator).toBe("FOODPANDA");
    expect(res.body.externalMerchantId).toBe("FP-1001");
    expect(res.body.credentialRef).toBeUndefined();
    expect(res.body.credential_ref).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("super-secret-credential-value");
  });

  it("adds a GRABFOOD account -> list returns both, neither leaks credential_ref", async () => {
    await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aggregator: "GRABFOOD",
        external_merchant_id: "GF-2002",
        credential_ref: "another-secret-value",
      });

    const listRes = await request(app)
      .get(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const aggregators = listRes.body.map((a: { aggregator: string }) => a.aggregator);
    expect(aggregators).toContain("FOODPANDA");
    expect(aggregators).toContain("GRABFOOD");

    const raw = JSON.stringify(listRes.body);
    expect(raw).not.toContain("credentialRef");
    expect(raw).not.toContain("credential_ref");
    expect(raw).not.toContain("super-secret-credential-value");
    expect(raw).not.toContain("another-secret-value");
  });

  it("rejects KITCHEN_STAFF creating an account with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        aggregator: "FOODPANDA",
        external_merchant_id: "FP-9999",
        credential_ref: "forbidden",
      });

    expect(res.status).toBe(403);
  });

  it("deletes an account as SUPER_ADMIN -> subsequent list excludes it", async () => {
    const addRes = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        aggregator: "OTHER",
        external_merchant_id: "OT-3003",
        credential_ref: "to-be-deleted",
      });
    const accountId = addRes.body.id;

    const delRes = await request(app)
      .delete(`/api/v1/accounts/${accountId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(delRes.status).toBe(200);

    const listRes = await request(app)
      .get(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.body.some((a: { id: string }) => a.id === accountId)).toBe(false);
  });
});

describe("Stations & printers", () => {
  it("lists seeded stations with default printer null initially", async () => {
    const res = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    const grill = res.body.find((s: { name: string }) => s.name === "Grill");
    expect(grill).toBeTruthy();
    expect(grill.defaultPrinter ?? null).toBeNull();
  });

  it("registers a printer as SUPER_ADMIN -> 201", async () => {
    const res = await request(app)
      .post("/api/v1/printers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Grill Printer", connection: "NETWORK", address: "192.168.1.50:9100" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("Grill Printer");
    expect(res.body.status).toBe("OFFLINE");
  });

  it("rejects KITCHEN_STAFF registering a printer with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/printers")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Sneaky Printer", connection: "USB", address: "COM3" });

    expect(res.status).toBe(403);
  });

  it("lists printers with status + last_seen", async () => {
    const res = await request(app)
      .get("/api/v1/printers")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty("status");
    expect(res.body[0]).toHaveProperty("lastSeen");
  });

  it("maps a station's default_printer_id to a registered printer; GET /stations reflects it", async () => {
    const printerRes = await request(app)
      .post("/api/v1/printers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Fry Printer", connection: "NETWORK", address: "192.168.1.51:9100" });
    const printerId = printerRes.body.id;

    const stationsRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const fryStation = stationsRes.body.find((s: { name: string }) => s.name === "Fry");
    expect(fryStation).toBeTruthy();

    const createStationRes = await request(app)
      .post("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Wok Station", default_printer_id: printerId });
    expect(createStationRes.status).toBe(201);

    const afterRes = await request(app)
      .get("/api/v1/stations")
      .set("Authorization", `Bearer ${adminToken}`);
    const wokStation = afterRes.body.find((s: { name: string }) => s.name === "Wok Station");
    expect(wokStation).toBeTruthy();
    expect(wokStation.defaultPrinterId).toBe(printerId);
    expect(wokStation.defaultPrinter).toBeTruthy();
    expect(wokStation.defaultPrinter.id).toBe(printerId);
    expect(wokStation.defaultPrinter.name).toBe("Fry Printer");
  });

  it("rejects KITCHEN_STAFF creating a station with 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/stations")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Forbidden Station" });

    expect(res.status).toBe(403);
  });

  it("updates a printer's connection/address via PATCH as SUPER_ADMIN", async () => {
    const printerRes = await request(app)
      .post("/api/v1/printers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Patchable Printer", connection: "USB", address: "COM5" });
    const printerId = printerRes.body.id;

    const patchRes = await request(app)
      .patch(`/api/v1/printers/${printerId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ connection: "NETWORK", address: "192.168.1.99:9100" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.connection).toBe("NETWORK");
    expect(patchRes.body.address).toBe("192.168.1.99:9100");
  });

  describe("GET /api/v1/stations?location_id= (outlet-scoping leak fix)", () => {
    let outletBId: string;

    beforeAll(async () => {
      const outletRes = await request(app)
        .post("/api/v1/outlets")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ code: `STA-${Date.now()}`, name: "Stations Second Outlet" });
      expect(outletRes.status).toBe(201);
      outletBId = outletRes.body.id as string;

      const createRes = await request(app)
        .post("/api/v1/stations")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Outlet B Only Station", location_id: outletBId });
      expect(createRes.status).toBe(201);
    });

    it("omitting location_id keeps the unfiltered platform-wide list (unchanged default)", async () => {
      const unfiltered = await request(app).get("/api/v1/stations").set("Authorization", `Bearer ${adminToken}`);
      expect(unfiltered.status).toBe(200);
      expect(unfiltered.body.some((s: { name: string }) => s.name === "Grill")).toBe(true);
      expect(unfiltered.body.some((s: { name: string }) => s.name === "Outlet B Only Station")).toBe(true);
    });

    it("filters stations to the given outlet only", async () => {
      const filtered = await request(app)
        .get(`/api/v1/stations?location_id=${outletBId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(filtered.status).toBe(200);
      const names = filtered.body.map((s: { name: string }) => s.name);
      expect(names).toContain("Outlet B Only Station");
      expect(names).not.toContain("Grill"); // Grill lives at the seeded CK1 outlet
    });

    it("a malformed location_id → 400 VALIDATION_ERROR", async () => {
      const res = await request(app)
        .get("/api/v1/stations?location_id=not-a-uuid")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});

describe("GET /api/v1/brands?location_id= (outlet-scoping leak fix)", () => {
  let outletBId: string;
  let homeBrandId: string; // home = outlet B
  let deployedBrandId: string; // home = CK1 (default), deployed to outlet B
  let unrelatedBrandId: string; // home = CK1, never touches outlet B

  beforeAll(async () => {
    const outletRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `BRD-${Date.now()}`, name: "Brands Filter Second Outlet" });
    expect(outletRes.status).toBe(201);
    outletBId = outletRes.body.id as string;

    const home = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `Home At B ${Date.now()}`, color: "#101010", location_id: outletBId });
    expect(home.status).toBe(201);
    homeBrandId = home.body.id as string;

    const deployed = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `Deployed To B ${Date.now()}`, color: "#202020" });
    expect(deployed.status).toBe(201);
    deployedBrandId = deployed.body.id as string;
    const deploy = await request(app)
      .post(`/api/v1/brands/${deployedBrandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outletBId });
    expect(deploy.status).toBe(201);

    const unrelated = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `Unrelated To B ${Date.now()}`, color: "#303030" });
    expect(unrelated.status).toBe(201);
    unrelatedBrandId = unrelated.body.id as string;
  });

  it("omitting location_id keeps the unfiltered platform-wide list (unchanged default — Merchant Management needs it)", async () => {
    const res = await request(app).get("/api/v1/brands").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(homeBrandId);
    expect(ids).toContain(deployedBrandId);
    expect(ids).toContain(unrelatedBrandId);
  });

  it("filters to brands whose HOME is that outlet OR that have an active deployment there", async () => {
    const res = await request(app)
      .get(`/api/v1/brands?location_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(homeBrandId);
    expect(ids).toContain(deployedBrandId);
    expect(ids).not.toContain(unrelatedBrandId);
  });

  it("deactivating the deployment removes the brand from the outlet's filtered list", async () => {
    const del = await request(app)
      .delete(`/api/v1/brands/${deployedBrandId}/outlets/${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/brands?location_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(homeBrandId); // home brand still shows regardless
    expect(ids).not.toContain(deployedBrandId); // deactivated deployment excluded
  });

  it("combines with ?is_active= filtering", async () => {
    const res = await request(app)
      .get(`/api/v1/brands?location_id=${outletBId}&is_active=true`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.every((b: { isActive: boolean }) => b.isActive === true)).toBe(true);
  });

  it("a malformed location_id → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/brands?location_id=not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("an unknown-but-valid-shape location_id returns an empty (or home-only) list, never an error", async () => {
    const res = await request(app)
      .get(`/api/v1/brands?location_id=${randomUUID()}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("GET /api/v1/brands/{id}/accounts?location_id= (outlet-scoping leak fix)", () => {
  let brandId: string;
  let outletBId: string;
  let ckAccountId: string;
  let outletBAccountId: string;

  beforeAll(async () => {
    const brandRes = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `Accounts Filter Brand ${Date.now()}`, color: "#444444" });
    expect(brandRes.status).toBe(201);
    brandId = brandRes.body.id as string;
    const ckLocationId = brandRes.body.locationId as string;

    const outletRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: `ACC-${Date.now()}`, name: "Accounts Filter Second Outlet" });
    expect(outletRes.status).toBe(201);
    outletBId = outletRes.body.id as string;

    const deploy = await request(app)
      .post(`/api/v1/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outletBId });
    expect(deploy.status).toBe(201);

    const ckAcc = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "FOODPANDA", external_merchant_id: "FP-CK", credential_ref: "ref-ck", location_id: ckLocationId });
    expect(ckAcc.status).toBe(201);
    ckAccountId = ckAcc.body.id as string;

    const bAcc = await request(app)
      .post(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ aggregator: "GRABFOOD", external_merchant_id: "GF-B", credential_ref: "ref-b", location_id: outletBId });
    expect(bAcc.status).toBe(201);
    outletBAccountId = bAcc.body.id as string;
  });

  it("omitting location_id returns every listing for the brand (unchanged default)", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/accounts`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(ckAccountId);
    expect(ids).toContain(outletBAccountId);
  });

  it("filters to only listings pinned to that outlet", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/accounts?location_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(outletBAccountId);
    expect(ids).not.toContain(ckAccountId);
  });

  it("a malformed location_id → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get(`/api/v1/brands/${brandId}/accounts?location_id=not-a-uuid`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
