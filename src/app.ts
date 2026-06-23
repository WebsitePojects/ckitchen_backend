import express, { type Express } from "express";
import type { DB } from "./db/client.js";
import { healthRouter } from "./routes/health.js";
import { createAuthRouter } from "./modules/auth/routes.js";
import { createBrandsRouter } from "./modules/brands/routes.js";
import { createStationsRouter } from "./modules/stations/routes.js";
import { createMenuRouter } from "./modules/menu/routes.js";

/** Express app factory. Takes the db so tests can inject an isolated in-memory instance. */
export function createApp(db: DB): Express {
  const app = express();
  app.use(express.json());
  app.set("db", db);

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", createAuthRouter(db));
  app.use("/api/v1", createBrandsRouter(db));
  app.use("/api/v1", createStationsRouter(db));
  app.use("/api/v1", createMenuRouter(db));

  return app;
}
