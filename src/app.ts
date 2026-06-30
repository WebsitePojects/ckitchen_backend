import express, { type Express } from "express";
import cors from "cors";
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
import { createAnalyticsRouter } from "./modules/analytics/routes.js";
import { createOutletsRouter } from "./modules/outlets/routes.js";
import { createEmsRouter } from "./modules/ems/routes.js";

/**
 * Express app factory.
 *
 * @param db   - Drizzle DB instance (injected so tests can use in-memory PGlite).
 * @param hub  - Realtime hub for emitting Socket.IO events (defaults to a no-op
 *               hub so existing tests calling `createApp(db)` keep working unchanged).
 */
export function createApp(db: DB, hub: RealtimeHub = createNoopHub()): Express {
  const app = express();
  // Allow the hosted frontend (different origin in production) to call the REST API.
  // Bearer-token auth (no cookies), so a wildcard origin is safe; restrict via CORS_ORIGIN if desired.
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json({ limit: "12mb" })); // base64 attendance photos (≤8 MB) must reach the handler, not be 413'd by the parser
  app.set("db", db);

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", createAuthRouter(db));
  app.use("/api/v1", createOutletsRouter(db));
  app.use("/api/v1", createBrandsRouter(db));
  app.use("/api/v1", createStationsRouter(db));
  app.use("/api/v1", createMenuRouter(db));
  app.use("/api/v1", createInventoryRouter(db, hub));
  app.use("/api/v1", createOrdersRouter(db, hub));
  app.use("/api/v1", createPrintingRouter(db, hub));
  app.use("/api/v1", createAnalyticsRouter(db));
  app.use("/api/v1", createEmsRouter(db));

  return app;
}
