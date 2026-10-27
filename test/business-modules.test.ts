/**
 * Business modules: the owner switches whole parts of ORION on/off; disabled pages vanish
 * from /me/permissions for every role (owner included). Core pages can never be disabled.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";

let app: Express;
let owner: string;
let crew: string;

const login = async (email: string, password: string) =>
  (await request(app).post("/api/v1/auth/login").send({ email, password })).body.token as string;
const pages = async (token: string) =>
  (await request(app).get("/api/v1/me/permissions").set("Authorization", `Bearer ${token}`)).body.pages as string[];
const toggle = (token: string, key: string, body: unknown) =>
  request(app).put(`/api/v1/business-modules/${key}`).set("Authorization", `Bearer ${token}`).send(body as object);

beforeAll(async () => {
  const { db } = createDb();
  await seed(db);
  app = createApp(db);
  owner = await login("admin@cloudkitchen.local", "admin123");
  crew = await login("kitchen_staff@cloudkitchen.local", "password123");
});

describe("business modules", () => {
  it("lists every module, all ON by default (no behaviour change for existing deployments)", async () => {
    const res = await request(app).get("/api/v1/business-modules").set("Authorization", `Bearer ${crew}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((m: { enabled: boolean }) => m.enabled)).toBe(true);
    expect(await pages(owner)).toContain("/purchasing");
  });

  it("switching a module off hides its pages for the owner and for staff; core pages stay", async () => {
    expect((await toggle(owner, "people", { enabled: false })).status).toBe(200);
    const ownerPages = await pages(owner);
    expect(ownerPages).not.toContain("/attendance");
    expect(ownerPages).not.toContain("/employees");
    expect(ownerPages).toContain("/settings");
    expect(ownerPages).toContain("/pos");
    expect(await pages(crew)).not.toContain("/attendance");
    expect(await pages(crew)).toContain("/kitchen");
  });

  it("repeating the same switch is a no-op, and switching back on restores the pages", async () => {
    expect((await toggle(owner, "people", { enabled: false })).status).toBe(200);
    expect(await pages(owner)).not.toContain("/attendance");
    expect((await toggle(owner, "people", { enabled: true })).status).toBe(200);
    expect(await pages(owner)).toContain("/attendance");
  });

  it("only the owner can switch modules", async () => {
    const res = await toggle(crew, "purchasing", { enabled: false });
    expect(res.status).toBe(403);
    expect(await pages(owner)).toContain("/purchasing");
  });

  it("rejects unknown modules and malformed bodies", async () => {
    expect((await toggle(owner, "pos", { enabled: false })).status).toBe(404); // core: not a module
    expect((await toggle(owner, "purchasing", { enabled: "no" })).status).toBe(400);
    expect((await toggle(owner, "purchasing", { enabled: false, extra: 1 })).status).toBe(400);
  });
});
