import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import type { DB } from "./db/client.js";
import { loadConfig } from "./config.js";
import { corsOriginCallback, createOriginAllowlist } from "./cors.js";
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
import { createMasterRouter } from "./modules/master/routes.js";
import { createPurchasingRouter } from "./modules/purchasing/routes.js";
import { createReportsRouter } from "./modules/reports/routes.js";
import { createAdminRouter } from "./modules/admin/routes.js";
import { createMeRouter } from "./modules/me/routes.js";
import { errorHandler, notFoundHandler } from "./modules/error-middleware.js";

/**
 * Express app factory.
 *
 * @param db   - Drizzle DB instance (injected so tests can use in-memory PGlite).
 * @param hub  - Realtime hub for emitting Socket.IO events (defaults to a no-op
 *               hub so existing tests calling `createApp(db)` keep working unchanged).
 */
export function createApp(db: DB, hub: RealtimeHub = createNoopHub()): Express {
  const app = express();

  // H5 (Fable review 2026-07-05): trust exactly ONE proxy hop. In prod the API sits
  // behind Render/Nginx, so without this `req.ip` is the proxy's address and the login
  // rate-limiter keys every user into a SINGLE shared bucket → one attacker (or a burst
  // of legit logins) locks out the whole platform. `1` makes Express read the real
  // client from the last X-Forwarded-For entry. NOT `true`: trusting the entire XFF
  // chain lets a client spoof its IP and trips express-rate-limit's
  // ERR_ERL_PERMISSIVE_TRUST_PROXY safety guard.
  app.set("trust proxy", 1);

  // SF-3 (audit-backend.md HIGH "no helmet"): security headers. CSP is mostly
  // inert for a JSON-only API (no HTML/script is ever served), but img-src is
  // widened for res.cloudinary.com so any future HTML surface (docs, admin
  // pages) that embeds a Cloudinary photo isn't broken by the default policy.
  // crossOriginResourcePolicy is relaxed to "cross-origin": the default
  // "same-origin" blocks the separate Vercel frontend from reading fetch/XHR
  // responses cross-origin in browsers that enforce CORP on all fetches, not
  // just no-cors subresource loads — that would break every API call from
  // the deployed frontend.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "img-src": ["'self'", "data:", "https://res.cloudinary.com"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // SF-3 (audit-backend.md HIGH "wildcard CORS"): allowlist instead of "*".
  // Bearer-token auth (no cookies) made a wildcard low-risk for reads, but an
  // explicit allowlist is the correct default regardless; see src/cors.ts for
  // the full policy (env override, Vercel prod + preview, local dev origins).
  const { corsOrigins } = loadConfig();
  const isOriginAllowed = createOriginAllowlist(corsOrigins);
  // exposedHeaders: the reports export UI reads Content-Disposition to name the
  // downloaded .xlsx/.pdf; a cross-origin browser hides that header unless exposed.
  app.use(
    cors({
      origin: corsOriginCallback(isOriginAllowed),
      exposedHeaders: ["Content-Disposition"],
    }),
  );

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
  app.use("/api/v1", createMasterRouter(db));
  app.use("/api/v1", createPurchasingRouter(db));
  app.use("/api/v1", createReportsRouter(db));
  app.use("/api/v1", createAdminRouter(db));
  app.use("/api/v1", createMeRouter(db));

  // Safety net — unmatched routes → 404; anything thrown/rejected in a handler
  // is normalized here so internals (stack/SQL) never leak to the client.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
