/**
 * SF-3 (docs/audits/audit-backend.md HIGH findings) — helmet, CORS allowlist,
 * login rate-limit.
 *
 * Covers:
 *   - helmet security headers present on every response (CSP incl. Cloudinary
 *     img-src, cross-origin-resource-policy relaxed for the Vercel frontend).
 *   - CORS: allowed origins (explicit list default + *.vercel.app preview
 *     suffix) get Access-Control-Allow-Origin echoed back; disallowed origins
 *     do not. Socket.IO shares the identical predicate (src/cors.ts) — unit
 *     tested directly here since spinning up a real IO server per case is
 *     unnecessary (server.ts wires the SAME createOriginAllowlist()).
 *   - POST /auth/login is throttled per IP once LOGIN_RATE_LIMIT_MAX is
 *     exceeded, returning 429 RATE_LIMITED via the standard error envelope.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { createOriginAllowlist, parseCorsOriginsEnv, DEFAULT_PROD_ORIGIN } from "../src/cors.js";

let app: Express;
let db: DB;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);
});

// ---------------------------------------------------------------------------
// helmet
// ---------------------------------------------------------------------------

describe("helmet security headers", () => {
  it("sets standard hardening headers on a plain API response", async () => {
    const res = await request(app).get("/api/v1/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("CSP img-src allows self, data:, and Cloudinary (attendance/menu/logo photos)", async () => {
    const res = await request(app).get("/api/v1/health");
    const csp = res.headers["content-security-policy"] as string;

    expect(csp).toContain("img-src");
    expect(csp).toContain("https://res.cloudinary.com");
    expect(csp).toContain("'self'");
  });

  it("cross-origin-resource-policy is relaxed so the separate Vercel frontend can read responses", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});

// ---------------------------------------------------------------------------
// CORS allowlist — integration (Express `cors()` wiring)
// ---------------------------------------------------------------------------

describe("CORS allowlist (SF-3: replaces wildcard '*')", () => {
  it("echoes Access-Control-Allow-Origin for the known production Vercel origin", async () => {
    const res = await request(app).get("/api/v1/health").set("Origin", DEFAULT_PROD_ORIGIN);

    expect(res.headers["access-control-allow-origin"]).toBe(DEFAULT_PROD_ORIGIN);
  });

  it("echoes Access-Control-Allow-Origin for a local Vite dev origin", async () => {
    const res = await request(app).get("/api/v1/health").set("Origin", "http://localhost:5173");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("echoes Access-Control-Allow-Origin for ANY *.vercel.app preview deploy origin", async () => {
    const previewOrigin = "https://ckitchen-frontend-git-feature-x-teamname.vercel.app";
    const res = await request(app).get("/api/v1/health").set("Origin", previewOrigin);

    expect(res.headers["access-control-allow-origin"]).toBe(previewOrigin);
  });

  it("does NOT echo Access-Control-Allow-Origin for an unrecognized origin", async () => {
    const res = await request(app).get("/api/v1/health").set("Origin", "https://evil.example.com");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a request with no Origin header (curl/server-to-server/print agent) is never CORS-blocked", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// CORS allowlist — unit tests on the predicate itself (src/cors.ts)
// ---------------------------------------------------------------------------

describe("createOriginAllowlist / parseCorsOriginsEnv (unit)", () => {
  it("defaults allow the known dev + prod origins and reject anything else", () => {
    const isAllowed = createOriginAllowlist(undefined);
    expect(isAllowed("http://localhost:5173")).toBe(true);
    expect(isAllowed(DEFAULT_PROD_ORIGIN)).toBe(true);
    expect(isAllowed("https://random-preview-branch.vercel.app")).toBe(true);
    expect(isAllowed("https://not-vercel-at-all.com")).toBe(false);
    expect(isAllowed(undefined)).toBe(true); // no Origin header => not a CORS request
  });

  it("an explicit CORS_ORIGINS list is used verbatim (still + vercel.app suffix rule)", () => {
    const isAllowed = createOriginAllowlist(["https://custom-domain.example"]);
    expect(isAllowed("https://custom-domain.example")).toBe(true);
    expect(isAllowed("http://localhost:5173")).toBe(false); // dev default NOT included once explicit list is set
    expect(isAllowed("https://any-preview.vercel.app")).toBe(true); // suffix rule always applies
  });

  it("parseCorsOriginsEnv splits a comma-separated CORS_ORIGINS value and trims whitespace", () => {
    const parsed = parseCorsOriginsEnv(" https://a.example , https://b.example ", undefined);
    expect(parsed).toEqual(["https://a.example", "https://b.example"]);
  });

  it("parseCorsOriginsEnv falls back to legacy CORS_ORIGIN as a single-item list", () => {
    expect(parseCorsOriginsEnv(undefined, "https://legacy.example")).toEqual(["https://legacy.example"]);
  });

  it("parseCorsOriginsEnv ignores a literal '*' in either var (predicate has no wildcard entry)", () => {
    expect(parseCorsOriginsEnv("*", undefined)).toBeUndefined();
    expect(parseCorsOriginsEnv(undefined, "*")).toBeUndefined();
  });

  it("parseCorsOriginsEnv returns undefined when both are unset", () => {
    expect(parseCorsOriginsEnv(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Login rate limit
// ---------------------------------------------------------------------------

describe("POST /auth/login rate limit (SF-3: audit-backend.md HIGH 'unthrottled login')", () => {
  const ENV_KEYS = ["LOGIN_RATE_LIMIT_MAX", "LOGIN_RATE_LIMIT_WINDOW_MS"] as const;
  const originalEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    // Never leak an overridden limit into another test file sharing this
    // worker process (vitest test-file isolation does not reset process.env).
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("returns 429 RATE_LIMITED once the configured attempt ceiling is exceeded", async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.LOGIN_RATE_LIMIT_MAX = "3";
    process.env.LOGIN_RATE_LIMIT_WINDOW_MS = String(15 * 60 * 1000);

    // Fresh app/router so createAuthRouter() re-reads the overridden config.
    const limitedDb = createDb().db;
    await seed(limitedDb);
    const limitedApp = createApp(limitedDb);

    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const res = await request(limitedApp)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@cloudkitchen.local", password: "whatever" });
      lastStatus = res.status;
      if (res.status === 429) {
        expect(res.body.error.code).toBe("RATE_LIMITED");
        break;
      }
    }
    expect(lastStatus).toBe(429);
  });

  it("legitimate logins under the limit are unaffected (default high test ceiling)", async () => {
    // No env override here — config.ts's NODE_ENV=test default ceiling applies.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@cloudkitchen.local", password: "admin123" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});
