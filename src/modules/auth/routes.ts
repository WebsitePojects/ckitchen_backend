import { Router } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { users, userSessions } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { signToken, verifyPassword, fakeVerifyPassword } from "./service.js";
import { requireAuth } from "./middleware.js";
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

  router.post("/auth/login", async (req, res) => {
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

    // Create a user_session row to track this login
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket?.remoteAddress
      ?? null;
    const userAgent = req.headers["user-agent"] ?? null;

    const [session] = await db
      .insert(userSessions)
      .values({ userId: user.id, ip, userAgent })
      .returning();

    const { jwtSecret } = loadConfig();
    const token = signToken(user, jwtSecret, session.id);

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
        sessionId: sid,
        action: "auth.logout",
        description: "User logged out",
      });
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
