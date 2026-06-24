import { Router } from "express";
import { eq } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { signToken, verifyPassword } from "./service.js";
import { requireAuth } from "./middleware.js";

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
      sendError(res, 401, "AUTH_REQUIRED", "Invalid email or password.");
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      sendError(res, 401, "AUTH_REQUIRED", "Invalid email or password.");
      return;
    }

    const { jwtSecret } = loadConfig();
    const token = signToken(user, jwtSecret);
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

  router.post("/auth/logout", (_req, res) => {
    // Stateless JWT: nothing to invalidate server-side for the prototype.
    res.status(200).json({ ok: true });
  });

  return router;
}
