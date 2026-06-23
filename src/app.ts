import express, { type Express } from "express";
import type { DB } from "./db/client.js";
import { healthRouter } from "./routes/health.js";
import { createAuthRouter } from "./modules/auth/routes.js";

/** Express app factory. Takes the db so tests can inject an isolated in-memory instance. */
export function createApp(db: DB): Express {
  const app = express();
  app.use(express.json());
  app.set("db", db);

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", createAuthRouter(db));

  return app;
}
