/**
 * Regression for the 2026-10-01 production incident: a 64-char
 * GRAB_PARTNER_CLIENT_SECRET passed `isGrabPartnerConfigured()` but exceeded the
 * 32-char cap in the /oauth/token body schema, so every Grab login failed with a
 * misleading 400 and nothing warned at boot.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { closeDb, createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { getGrabPartnerConfigProblem, isGrabPartnerConfigured } from "../src/modules/grab/config.js";
import { MAX_CREDENTIAL_LEN } from "../src/modules/grab/validation.js";

const ENV_KEYS = ["GRAB_PARTNER_BASE_PATH", "GRAB_PARTNER_CLIENT_ID", "GRAB_PARTNER_CLIENT_SECRET", "GRAB_PARTNER_TOKEN_SECRET"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const BASE = "/api/v1/grab";
const VALID_SECRET = "s".repeat(MAX_CREDENTIAL_LEN);
const OVERLONG_SECRET = "x".repeat(64);

beforeEach(() => {
  process.env.GRAB_PARTNER_BASE_PATH = BASE;
  process.env.GRAB_PARTNER_CLIENT_ID = "test-grab-client-id";
  process.env.GRAB_PARTNER_CLIENT_SECRET = VALID_SECRET;
  process.env.GRAB_PARTNER_TOKEN_SECRET = "test-grab-token-secret";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("getGrabPartnerConfigProblem", () => {
  it("flags a 64-char secret without leaking its value, and disables the integration", () => {
    process.env.GRAB_PARTNER_CLIENT_SECRET = OVERLONG_SECRET;

    const problem = getGrabPartnerConfigProblem();

    expect(problem).toContain("GRAB_PARTNER_CLIENT_SECRET");
    expect(problem).toContain("32");
    expect(problem).not.toContain(OVERLONG_SECRET);
    expect(isGrabPartnerConfigured()).toBe(false);
  });

  it("accepts a secret of exactly the limit", () => {
    expect(getGrabPartnerConfigProblem()).toBeNull();
    expect(isGrabPartnerConfigured()).toBe(true);
  });

  it("flags an overlong client_id", () => {
    process.env.GRAB_PARTNER_CLIENT_ID = "i".repeat(MAX_CREDENTIAL_LEN + 1);

    const problem = getGrabPartnerConfigProblem();

    expect(problem).toContain("GRAB_PARTNER_CLIENT_ID");
    expect(problem).not.toContain("GRAB_PARTNER_CLIENT_SECRET");
    expect(isGrabPartnerConfigured()).toBe(false);
  });

  it("names both variables when both are overlong", () => {
    process.env.GRAB_PARTNER_CLIENT_ID = "i".repeat(64);
    process.env.GRAB_PARTNER_CLIENT_SECRET = OVERLONG_SECRET;

    const problem = getGrabPartnerConfigProblem();

    expect(problem).toContain("GRAB_PARTNER_CLIENT_ID");
    expect(problem).toContain("GRAB_PARTNER_CLIENT_SECRET");
  });

  it("reports no problem when the credentials are unset (module simply off)", () => {
    delete process.env.GRAB_PARTNER_CLIENT_ID;
    delete process.env.GRAB_PARTNER_CLIENT_SECRET;

    expect(getGrabPartnerConfigProblem()).toBeNull();
    expect(isGrabPartnerConfigured()).toBe(false);
  });
});

describe("POST /oauth/token with an overlong secret configured", () => {
  let app: Express;
  let client: ReturnType<typeof createDb>["client"];

  beforeAll(async () => {
    const created = createDb();
    client = created.client;
    await runMigrations(created.db);
    app = createApp(created.db);
  });

  afterAll(async () => {
    await closeDb(client);
  });

  it("answers 503 FEATURE_DISABLED (fail closed), not a misleading 400", async () => {
    process.env.GRAB_PARTNER_CLIENT_SECRET = OVERLONG_SECRET;

    const res = await request(app)
      .post(`${BASE}/oauth/token`)
      .send({ client_id: process.env.GRAB_PARTNER_CLIENT_ID, client_secret: "x".repeat(MAX_CREDENTIAL_LEN), grant_type: "client_credentials" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("FEATURE_DISABLED");
  });

  it("answers 503 even when the caller sends the same overlong secret (the real incident)", async () => {
    process.env.GRAB_PARTNER_CLIENT_SECRET = OVERLONG_SECRET;

    const res = await request(app)
      .post(`${BASE}/oauth/token`)
      .send({ client_id: process.env.GRAB_PARTNER_CLIENT_ID, client_secret: OVERLONG_SECRET, grant_type: "client_credentials" });

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("FEATURE_DISABLED");
    expect(JSON.stringify(res.body)).not.toContain(OVERLONG_SECRET);
  });
});
