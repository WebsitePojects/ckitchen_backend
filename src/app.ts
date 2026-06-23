import express, { type Express } from "express";
import type { DB } from "./db/client.js";
import { createNoopHub, type RealtimeHub } from "./realtime/hub.js";
import { healthRouter } from "./routes/health.js";
import { createAuthRouter } from "./modules/auth/routes.js";
import { createBrandsRouter } from "./modules/brands/routes.js";
import { createStationsRouter } from "./modules/stations/routes.js";
import { createMenuRouter } from "./modules/menu/routes.js";
import { createInventoryRouter } from "./modules/inventory/routes.js";
import { createOrdersRouter } from "./modules/orders/routes.js";
import { createPrintingRouter } from "./modules/printing/routes.js";

/**
 * Express app factory.
 *
 * @param db   - Drizzle DB instance (injected so tests can use in-memory PGlite).
 * @param hub  - Realtime hub for emitting Socket.IO events (defaults to a no-op
 *               hub so existing tests calling `createApp(db)` keep working unchanged).
 */
export function createApp(db: DB, hub: RealtimeHub = createNoopHub()): Express {
  const app = express();
  app.use(express.json());
  app.set("db", db);

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", createAuthRouter(db));
  app.use("/api/v1", createBrandsRouter(db));
  app.use("/api/v1", createStationsRouter(db));
  app.use("/api/v1", createMenuRouter(db));
  app.use("/api/v1", createInventoryRouter(db, hub));
  app.use("/api/v1", createOrdersRouter(db, hub));
  app.use("/api/v1", createPrintingRouter(db, hub));

  return app;
}
