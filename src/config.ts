export interface Config {
  port: number;
  jwtSecret: string;
  agentToken: string;
  dbPath: string | undefined;
}

/** Loads runtime config from environment variables with sane local defaults. */
export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 4000);
  const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";
  const agentToken = process.env.AGENT_TOKEN ?? "dev-agent-token-change-me";
  const url = process.env.DATABASE_URL;
  const dbPath = url ? url.replace(/^file:\/\//, "") : "./.data/ck.db";

  return { port, jwtSecret, agentToken, dbPath };
}
