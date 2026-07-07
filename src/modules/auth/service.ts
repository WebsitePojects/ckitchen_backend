import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User } from "../../db/schema.js";
import { outletScopeForRole, type OutletScope } from "./roles.js";

const BCRYPT_ROUNDS = 10;

export interface AuthTokenPayload {
  sub: string;
  role: User["role"];
  /** Session id — links this token to a user_session row. */
  sid?: string;
  /** Tenancy (D22): 'ALL' for HQ roles, else 'ASSIGNED'. Optional on legacy tokens. */
  outlet_scope?: OutletScope;
  /** Tenancy (D22): outlet ids the user may act in (from user_outlet_access). */
  outlet_ids?: string[];
  /**
   * Display name at sign-in time. Carried on the token so every downstream
   * `audit(...)` call can attribute a human-readable actor without an extra
   * DB round-trip (see docs/audit/audit-event-types.md). Optional so tokens
   * minted before this claim existed still verify; those requests fall back
   * to a null actorName rather than crashing.
   */
  name?: string;
}

/** Options for {@link signToken}: session id + tenancy claims (D22). */
export interface SignTokenOptions {
  sessionId?: string;
  outletScope?: OutletScope;
  outletIds?: string[];
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

/**
 * Signs a JWT carrying the user id (`sub`), role, optional session id (`sid`),
 * the tenancy claims `outlet_scope`/`outlet_ids` (D22), and — when the caller
 * has it on hand — the user's display `name` (audit actor attribution). When
 * scope/ids are not supplied, scope defaults to the role's default (HQ→ALL,
 * else ASSIGNED) and ids default to empty, so callers that don't care still
 * mint a valid token. `name` is optional on the input type too (existing
 * direct callers that only have {id, role}, e.g. tests, keep compiling).
 */
export function signToken(
  user: Pick<User, "id" | "role"> & Partial<Pick<User, "name">>,
  jwtSecret: string,
  opts: SignTokenOptions = {},
): string {
  const outletScope = opts.outletScope ?? outletScopeForRole(user.role);
  const outletIds = opts.outletIds ?? [];
  const payload: AuthTokenPayload = {
    sub: user.id,
    role: user.role,
    outlet_scope: outletScope,
    outlet_ids: outletIds,
  };
  if (opts.sessionId) payload.sid = opts.sessionId;
  if (user.name) payload.name = user.name;
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
