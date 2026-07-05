import { existsSync } from "node:fs";
import { parseCorsOriginsEnv } from "./cors.js";

// Load a local `.env` for real-process runs (dev server, migrate, seed). Tests rely on
// NODE_ENV=test defaults instead. Node 24's native loader — no dotenv dependency needed.
if (process.env.NODE_ENV !== "test" && existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* ignore — fall through to fail-fast in requireSecret */
  }
}

export interface LoginRateLimitConfig {
  windowMs: number;
  max: number;
}

export interface Config {
  port: number;
  jwtSecret: string;
  agentToken: string;
  dbPath: string | undefined;
  /** Raw DATABASE_URL value, unmodified (undefined when unset). */
  databaseUrl: string | undefined;
  /** Parsed `CORS_ORIGINS` allowlist (+ legacy `CORS_ORIGIN` fallback); undefined => use defaults (src/cors.ts). */
  corsOrigins: string[] | undefined;
  /** POST /auth/login throttle (SF-3: audit-backend.md HIGH "unthrottled login"). */
  loginRateLimit: LoginRateLimitConfig;
}

/** True when `url` points at a real Postgres server (e.g. Supabase) rather than PGlite. */
export function isPostgresUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

/**
 * Resolves a required secret from the environment. In `NODE_ENV=test`, falls back to a fixed
 * deterministic value so the test suite stays runnable without a `.env`. In dev/prod, a missing
 * secret is a fatal misconfiguration — fail fast rather than silently using a known constant.
 */
function requireSecret(envVar: string, testDefault: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (process.env.NODE_ENV === "test") return testDefault;
  throw new Error(`${envVar} is required (set it in .env)`);
}

/** Loads runtime config from environment variables with sane local defaults. */
export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 4000);
  const jwtSecret = requireSecret("JWT_SECRET", "test-jwt-secret");
  const agentToken = requireSecret("AGENT_TOKEN", "test-agent-token");
  const url = process.env.DATABASE_URL;
  // A real Postgres URL is handled entirely via `databaseUrl` (see isPostgresUrl) — dbPath
  // stays the PGlite file path/in-memory default so existing file-backed behavior is unchanged.
  let dbPath: string | undefined;
  if (!url) {
    dbPath = "./.data/ck.db";
  } else if (isPostgresUrl(url)) {
    dbPath = undefined;
  } else {
    // NOTE: re-bind to a local so TS doesn't (incorrectly) narrow `url` to `never` here —
    // the `isPostgresUrl` type predicate's negation otherwise collides with the outer `string`
    // narrowing from the `!url` check above.
    const fileUrl: string = url;
    dbPath = fileUrl.replace(/^file:\/\//, "");
  }

  const corsOrigins = parseCorsOriginsEnv(process.env.CORS_ORIGINS, process.env.CORS_ORIGIN);

  // Login rate limit: env-tunable, but defaults to a very high ceiling under
  // NODE_ENV=test so the existing test suite (which legitimately calls
  // /auth/login many times per file — wrong-password / RBAC / session tests)
  // never trips it. Real dev/prod default to a conservative 10 attempts / 15 min.
  const isTest = process.env.NODE_ENV === "test";
  const loginRateLimit: LoginRateLimitConfig = {
    windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? (isTest ? 100_000 : 10)),
  };

  return { port, jwtSecret, agentToken, dbPath, databaseUrl: url, corsOrigins, loginRateLimit };
}
