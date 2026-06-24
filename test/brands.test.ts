import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

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
});
