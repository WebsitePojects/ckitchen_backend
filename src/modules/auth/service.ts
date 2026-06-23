import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User } from "../../db/schema.js";

const BCRYPT_ROUNDS = 10;

export interface AuthTokenPayload {
  sub: string;
  role: User["role"];
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Signs a JWT carrying the user id (`sub`) and role, per CK1-API-003 §2 / security.md. */
export function signToken(
  user: Pick<User, "id" | "role">,
  jwtSecret: string,
): string {
  const payload: AuthTokenPayload = { sub: user.id, role: user.role };
  return jwt.sign(payload, jwtSecret, { expiresIn: "12h" });
}

export function verifyToken(token: string, jwtSecret: string): AuthTokenPayload {
  return jwt.verify(token, jwtSecret) as AuthTokenPayload;
}
