export interface Config {
  port: number;
  jwtSecret: string;
  agentToken: string;
  dbPath: string | undefined;
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
  const dbPath = url ? url.replace(/^file:\/\//, "") : "./.data/ck.db";

  return { port, jwtSecret, agentToken, dbPath };
}
