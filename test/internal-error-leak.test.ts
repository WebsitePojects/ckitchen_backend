/**
 * Regression: unexpected failures must never echo database errors to the client.
 *
 * Found 2026-10-24 while loading demo data: `POST /orders/<not-a-uuid>/advance`
 * answered 500 with the full SQL text and parameters, because the orders route's
 * catch-all forwarded `err.message`. Analytics, printing and reports had the same
 * catch-all. All now go through `sendInternalError`, and the order `:id` routes
 * reject a malformed id with 404 before any query runs.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express, Response } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { isUuid, sendInternalError } from "../src/modules/http-errors.js";

let app: Express;
let db: DB;
let adminToken: string;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "admin@cloudkitchen.local", password: "admin123" });
  expect(res.status).toBe(200);
  adminToken = res.body.token as string;
});

describe("order :id routes with a malformed id", () => {
  const malformed = ["not-a-uuid", encodeURIComponent("x'; drop table \"order\";--"), "123"];

  for (const id of malformed) {
    it(`GET /orders/${id} -> 404 without SQL`, async () => {
      const res = await request(app).get(`/api/v1/orders/${id}`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain("select");
    });

    it(`POST /orders/${id}/advance -> 404 without SQL`, async () => {
      const res = await request(app).post(`/api/v1/orders/${id}/advance`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain("select");
    });

    it(`POST /orders/${id}/cancel -> 404 without SQL`, async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${id}/cancel`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "test" });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain("select");
    });
  }

  it("a well-formed but unknown id still answers 404", async () => {
    const res = await request(app)
      .post("/api/v1/orders/00000000-0000-0000-0000-000000000000/advance")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("sendInternalError", () => {
  it("answers a generic 500 and never forwards the error message", () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    sendInternalError(res, new Error('Failed query: select "secret" from "order" params: abc'), "test");

    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
    expect(spy).toHaveBeenCalled(); // the real error is still logged server-side for debugging
    spy.mockRestore();
  });
});

describe("isUuid", () => {
  it("accepts canonical uuids and rejects everything else", () => {
    expect(isUuid("d3d63b42-7663-43c6-aa54-28b273f7785e")).toBe(true);
    expect(isUuid("D3D63B42-7663-43C6-AA54-28B273F7785E")).toBe(true);
    for (const bad of ["", "not-a-uuid", "d3d63b42-7663-43c6-aa54-28b273f7785", "d3d63b42766343c6aa5428b273f7785e"]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
