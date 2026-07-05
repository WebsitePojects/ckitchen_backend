/**
 * CORS allowlist — SF-3 (docs/audits/audit-backend.md HIGH: "wildcard CORS").
 *
 * Before this existed, both the REST API (`cors({ origin: "*" })` in app.ts)
 * and Socket.IO (`cors: { origin: "*" }` in server.ts) accepted ANY origin.
 * Bearer-token auth (no cookies) makes a wildcard low-risk for REST reads, but
 * it also meant Socket.IO — which streams live order/stock/print events per
 * outlet room — had no origin restriction at all. Both now share ONE
 * allow-predicate so REST and realtime enforce the same policy.
 *
 * Allowed origins, in order:
 *   1. `CORS_ORIGINS` env (comma-separated, exact match) when set — full
 *      operator control, e.g. for a non-Vercel deploy.
 *   2. Otherwise, defaults: local Vite dev origins + the known production
 *      Vercel frontend (docs/audits/audit-frontend.md: ckitchen-frontend.vercel.app).
 *   3. ALWAYS, regardless of (1)/(2): any `https://*.vercel.app` origin — Vercel
 *      mints a fresh preview subdomain per branch/PR, so hardcoding only the
 *      production URL would break every preview deploy's ability to call the API.
 *
 * A request with NO Origin header (curl, server-to-server, same-origin, the
 * print agent's X-Agent-Token calls, Postman) is not a browser CORS request at
 * all and is always allowed — CORS only ever restricts browser-driven fetches.
 */

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173", // Vite dev server default
  "http://localhost:4173", // Vite preview
  "http://localhost:3000", // fallback dev port some setups use
];

/** Known production frontend (docs/audits/audit-frontend.md). */
export const DEFAULT_PROD_ORIGIN = "https://ckitchen-frontend.vercel.app";

/** Any `https://<subdomain>.vercel.app` — covers Vercel preview deploys. */
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/i;

/**
 * Parses the `CORS_ORIGINS` env var (comma-separated). Also accepts the older
 * single-value `CORS_ORIGIN` as a one-item fallback (Render currently has
 * `CORS_ORIGIN` set — see .claude/context/infrastructure.md — so a rename
 * without this fallback would silently stop honoring whatever operators
 * already configured there; a literal `*` in either var is ignored, since a
 * predicate-based allowlist has no wildcard entry — the built-in Vercel
 * preview-suffix rule covers that need instead).
 */
export function parseCorsOriginsEnv(
  corsOrigins: string | undefined,
  legacyCorsOrigin?: string | undefined,
): string[] | undefined {
  const multi = corsOrigins?.trim();
  if (multi) {
    const list = multi
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== "*");
    if (list.length > 0) return list;
  }

  const legacy = legacyCorsOrigin?.trim();
  if (legacy && legacy !== "*") return [legacy];

  return undefined;
}

/**
 * Builds the allow-predicate. `explicitOrigins` is the parsed `CORS_ORIGINS`
 * (+ legacy `CORS_ORIGIN`) env — undefined/empty falls back to the defaults.
 */
export function createOriginAllowlist(
  explicitOrigins: string[] | undefined,
): (origin: string | undefined) => boolean {
  const allowlist =
    explicitOrigins && explicitOrigins.length > 0
      ? explicitOrigins
      : [...DEFAULT_DEV_ORIGINS, DEFAULT_PROD_ORIGIN];
  const exact = new Set(allowlist);

  return (origin: string | undefined): boolean => {
    if (!origin) return true; // non-browser request — CORS is not in play
    if (exact.has(origin)) return true;
    if (VERCEL_PREVIEW_RE.test(origin)) return true;
    return false;
  };
}

/**
 * Adapts the allow-predicate to the `(origin, callback)` shape both the
 * `cors` npm package AND Socket.IO's `cors` option expect.
 */
export function corsOriginCallback(
  isAllowed: (origin: string | undefined) => boolean,
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    if (isAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin ?? "(none)"} is not allowed by CORS.`));
    }
  };
}
