/**
 * Paired kiosk screens (D56): the unauthenticated attendance kiosk only works on a screen an
 * owner/HR paired to their workspace, and runs as that workspace. Cross-workspace behaviour is
 * proven in workspace-isolation-api.test.ts (real per-workspace roles).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { kioskDevices } from "../src/db/schema.js";

let app: Express;
let db: DB;
let ownerToken: string;
let hrToken: string;
let kitchenToken: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/v1/auth/login").send({ email, password })).body.token as string;

function pair(token: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/v1/kiosk-devices/pair")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Lobby tablet", request_id: randomUUID(), ...body });
}

const employeesVia = (kioskToken?: string) => {
  const req = request(app).get("/api/v1/public/attendance/employees");
  return kioskToken === undefined ? req : req.set("X-Kiosk-Token", kioskToken);
};

beforeAll(async () => {
  db = createDb().db;
  await seed(db);
  app = createApp(db);
  ownerToken = await login("admin@cloudkitchen.local", "admin123");
  hrToken = await login("hr@cloudkitchen.local", "password123");
  kitchenToken = await login("kitchen_staff@cloudkitchen.local", "password123");
});

describe("the kiosk works only on a paired screen", () => {
  it("no token, a forged token, or a token minted for something else -> 401 KIOSK_NOT_PAIRED", async () => {
    const paired = await pair(ownerToken);
    const [id, mac] = (paired.body.token as string).split(".");
    for (const token of [undefined, "", "garbage", `${randomUUID()}.${mac}`, `${id}.${mac!.slice(0, -2)}AA`]) {
      const res = await employeesVia(token);
      expect(res.status, String(token)).toBe(401);
      expect(res.body.error.code).toBe("KIOSK_NOT_PAIRED");
    }
    const punch = await request(app).post("/api/v1/public/attendance").send({ employee_id: randomUUID(), type: "TIME_IN", photo: "x" });
    expect(punch.status).toBe(401);
  });

  it("a join-link token is not a kiosk token (signed for a different purpose)", async () => {
    const link = await request(app)
      .post("/api/v1/admin/join-links")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ invitee_name: "Not a kiosk", role: "HR", request_id: randomUUID() });
    expect(link.status).toBe(201);
    expect((await employeesVia(link.body.token)).status).toBe(401);
  });

  it("a paired screen lists the workspace's employees", async () => {
    const paired = await pair(hrToken);
    expect(paired.status).toBe(201);
    const res = await employeesVia(paired.body.token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("a revoked screen stops working at once; revoking again is a no-op", async () => {
    const paired = await pair(ownerToken);
    expect((await employeesVia(paired.body.token)).status).toBe(200);
    const revoke = () => request(app).post(`/api/v1/kiosk-devices/${paired.body.id}/revoke`).set("Authorization", `Bearer ${ownerToken}`);
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(200);
    expect((await employeesVia(paired.body.token)).status).toBe(401);
  });
});

describe("pairing", () => {
  it("only owners and HR can pair, list or revoke screens", async () => {
    expect((await pair(kitchenToken)).status).toBe(403);
    expect((await request(app).get("/api/v1/kiosk-devices").set("Authorization", `Bearer ${kitchenToken}`)).status).toBe(403);
    expect((await request(app).get("/api/v1/kiosk-devices")).status).toBe(401);
  });

  it("a screen that is already paired keeps its token (no new row each time the kiosk is opened)", async () => {
    const first = await pair(ownerToken);
    const again = await pair(ownerToken, { existing_token: first.body.token });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.token).toBe(first.body.token);
  });

  it("a revoked or forged existing token is replaced by a new pairing", async () => {
    const first = await pair(ownerToken);
    await request(app).post(`/api/v1/kiosk-devices/${first.body.id}/revoke`).set("Authorization", `Bearer ${ownerToken}`);
    const fresh = await pair(ownerToken, { existing_token: first.body.token });
    expect(fresh.status).toBe(201);
    expect(fresh.body.id).not.toBe(first.body.id);
    const forged = await pair(ownerToken, { existing_token: "not-a-token" });
    expect(forged.status).toBe(201);
  });

  it("a double click (same request id) pairs once, sequential and concurrent", async () => {
    const requestId = randomUUID();
    const one = await pair(ownerToken, { request_id: requestId });
    const two = await pair(ownerToken, { request_id: requestId });
    expect([one.status, two.status]).toEqual([201, 200]);
    expect(two.body.id).toBe(one.body.id);

    const concurrentId = randomUUID();
    const both = await Promise.all([0, 1].map(() => pair(ownerToken, { request_id: concurrentId })));
    expect(new Set(both.map((r) => r.body.id)).size).toBe(1);
    expect(await db.select().from(kioskDevices).where(eq(kioskDevices.clientRequestId, concurrentId))).toHaveLength(1);
  });

  it("the list never exposes tokens", async () => {
    await pair(ownerToken);
    const list = await request(app).get("/api/v1/kiosk-devices").set("Authorization", `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toContain('"token"');
  });
});
