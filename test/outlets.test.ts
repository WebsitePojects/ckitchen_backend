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

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  return res.body.token;
}

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);

  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  staffToken = await login("kitchen_staff@cloudkitchen.local", "password123");
});

describe("physical outlets", () => {
  it("lists the seeded CloudKitchen ONE physical outlet with its two warehouse tiers", async () => {
    const res = await request(app)
      .get("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toBe("CloudKitchen ONE");
    expect(res.body[0].code).toBe("CK1");
    expect(res.body[0].status).toBe("ACTIVE");
    expect(res.body[0].timezone).toBe("Asia/Manila");
    expect(res.body[0].warehouses.map((warehouse: { type: string }) => warehouse.type).sort()).toEqual([
      "KITCHEN",
      "MAIN",
    ]);
  });

  it("creates an outlet and initializes MAIN plus KITCHEN warehouses", async () => {
    const res = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: "QC2",
        name: "Quezon City Outlet",
        address: "Quezon City",
        timezone: "Asia/Manila",
        contact_name: "Outlet Manager",
        contact_phone: "+63 900 000 0000",
      });

    expect(res.status).toBe(201);
    expect(res.body.code).toBe("QC2");
    expect(res.body.name).toBe("Quezon City Outlet");
    expect(res.body.status).toBe("ACTIVE");
    expect(res.body.contactName).toBe("Outlet Manager");
    expect(res.body.contactPhone).toBe("+63 900 000 0000");
    expect(res.body.warehouses.map((warehouse: { type: string }) => warehouse.type).sort()).toEqual([
      "KITCHEN",
      "MAIN",
    ]);
  });

  it("rejects duplicate outlet codes", async () => {
    await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "BGC1", name: "BGC Outlet" });

    const res = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "BGC1", name: "Duplicate BGC" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("allows SUPER_ADMIN to deactivate an outlet", async () => {
    const createRes = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "MKT1", name: "Makati Outlet" });

    const patchRes = await request(app)
      .patch(`/api/v1/outlets/${createRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "INACTIVE" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe("INACTIVE");
  });

  it("rejects KITCHEN_STAFF outlet creation", async () => {
    const res = await request(app)
      .post("/api/v1/outlets")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ code: "NOPE", name: "Forbidden Outlet" });

    expect(res.status).toBe(403);
  });
});
