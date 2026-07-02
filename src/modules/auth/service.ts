import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User } from "../../db/schema.js";

const BCRYPT_ROUNDS = 10;

export interface AuthTokenPayload {
  sub: string;
  role: User["role"];
  /** Session id — links this token to a user_session row. */
  sid?: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A real bcrypt hash of a throwaway value, computed once at startup. Used to
 * equalize response time on the "email not found" login path so an attacker
 * cannot distinguish a registered email (bcrypt runs) from an unknown one
 * (bcrypt skipped) by timing — a user-enumeration oracle (audit-backend.md).
 */
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer-not-a-real-password", BCRYPT_ROUNDS);

/** Runs a bcrypt comparison against a dummy hash purely to spend the same time. */
export async function fakeVerifyPassword(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}

/** Signs a JWT carrying the user id (`sub`), role, and optional session id (`sid`). */
export function signToken(
  user: Pick<User, "id" | "role">,
  jwtSecret: string,
  sessionId?: string,
): string {
  const payload: AuthTokenPayload = { sub: user.id, role: user.role };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(payload, jwtSecret, { algorithm: "HS256", expiresIn: "12h" });
}

/**
 * Verifies a JWT, pinning the algorithm to HS256 (prevents alg-confusion attacks) and rejecting
 * a signed-but-malformed payload (missing `sub`/`role`) rather than yielding undefined authz
 * fields to callers.
 */
export function verifyToken(token: string, jwtSecret: string): AuthTokenPayload {
  const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).sub !== "string" ||
    typeof (payload as Record<string, unknown>).role !== "string"
  ) {
    throw new Error("Invalid token payload: missing sub/role.");
  }
  return payload as unknown as AuthTokenPayload;
}
