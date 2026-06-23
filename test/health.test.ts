import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";

let app: Express;

beforeAll(() => {
  const { db } = createDb(); // in-memory, isolated
  app = createApp(db);
});

describe("GET /api/v1/health", () => {
  it("returns 200 {status: 'ok'}", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
