import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { users, userSessions, userOutletAccess } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { signToken, verifyPassword, fakeVerifyPassword } from "./service.js";
import { requireAuth } from "./middleware.js";
import { normalizeRole, outletScopeForRole } from "./roles.js";
import { audit } from "../ems/audit.js";

function sendError(
  res: import("express").Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

/** Strips password_hash before returning a user over the wire. */
function toPublicUser(user: typeof users.$inferSelect) {
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

export function createAuthRouter(db: DB): Router {
  const router = Router();

  // SF-3 (audit-backend.md HIGH "unthrottled login"): bcrypt is intentionally
  // slow, which is exactly what makes an unthrottled login endpoint a DoS/
  // credential-stuffing vector. Limits are env-tunable (LOGIN_RATE_LIMIT_MAX /
  // LOGIN_RATE_LIMIT_WINDOW_MS); config.ts defaults to a very high ceiling
  // under NODE_ENV=test so the existing test suite's repeated login calls
  // never trip it, and to 10/15min in real dev/prod.
  const { loginRateLimit } = loadConfig();
  const loginLimiter = rateLimit({
    windowMs: loginRateLimit.windowMs,
    limit: loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(
        res,
        429,
        "RATE_LIMITED",
        "Too many login attempts. Please try again later.",
      );
    },
  });

  router.post("/auth/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      sendError(res, 400, "VALIDATION_ERROR", "email and password are required.");
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) {
      // Spend the same time as a real bcrypt check so response timing does not
      // reveal whether the email is registered (user-enumeration oracle).
      await fakeVerifyPassword(password);
      sendError(res, 401, "AUTH_REQUIRED", "Invalid email or password.");
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      sendError(res, 401, "AUTH_REQUIRED", "Invalid email or password.");
      return;
    }

    // M5: RIDER was retired (D29) and normalizes to no access. Block it at login
    // rather than minting a token that would be denied on every requireAuth route
    // anyway — a clear, honest signal. Any future retired/unknown role (normalizeRole
    // → null) is blocked the same way. Checked AFTER password verification so this
    // is not a role-enumeration oracle.
    if (normalizeRole(user.role) === null) {
      sendError(res, 403, "ROLE_RETIRED", "This account's role has been retired. Contact an administrator.");
      return;
    }

    // Create a user_session row to track this login
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket?.remoteAddress
      ?? null;
    const userAgent = req.headers["user-agent"] ?? null;

    const [session] = await db
      .insert(userSessions)
      .values({ userId: user.id, ip, userAgent })
      .returning();

    // Tenancy claims (D22): HQ roles get ALL scope; everyone else is scoped to
    // their user_outlet_access rows. The ids are always loaded (small at 4
    // outlets) so an ASSIGNED user's token carries WHERE they may act.
    const outletScope = outletScopeForRole(user.role);
    const accessRows = await db
      .select({ locationId: userOutletAccess.locationId })
      .from(userOutletAccess)
      .where(eq(userOutletAccess.userId, user.id));
    const outletIds = accessRows.map((row) => row.locationId);

    const { jwtSecret } = loadConfig();
    const token = signToken(user, jwtSecret, {
      sessionId: session.id,
      outletScope,
      outletIds,
    });

    // Audit the login (non-blocking — errors are swallowed inside audit())
    void audit(db, {
      actorUserId: user.id,
      actorName: user.name,
      sessionId: session.id,
      action: "auth.login",
      description: `${user.name} logged in`,
    });

    res.json({ token, user: toPublicUser(user) });
  });

  router.get("/auth/me", requireAuth, async (req, res) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!user) {
      sendError(res, 401, "AUTH_REQUIRED", "User no longer exists.");
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  router.post("/auth/logout", requireAuth, async (req, res) => {
    const sid = req.user?.sessionId;

    if (sid) {
      // Close the session row
      await db
        .update(userSessions)
        .set({ logoutAt: new Date() })
        .where(eq(userSessions.id, sid));

      // Audit the logout (non-blocking)
      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: sid,
        action: "auth.logout",
        description: "User logged out",
      });
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
