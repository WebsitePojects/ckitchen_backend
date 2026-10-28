/**
 * One bearer-token authenticator for REST (requireAuth) and Socket.IO (realtime/hub.ts),
 * so the two can never disagree about who a caller is.
 *
 * Two token kinds are accepted:
 *  1. ORION's own JWT (password login). After Clerk is enabled this is the IT break-glass.
 *  2. A Clerk session token. Clerk proves identity; the role and outlets come from ORION's
 *     `user` row. First sign-in links the Clerk account to the ORION user whose email
 *     matches the VERIFIED Clerk email. Anyone not invited is refused.
 */
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { users, userSessions, WORKSPACE_ONE_ID } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { audit } from "../ems/audit.js";
import { verifyToken, type AuthTokenPayload } from "./service.js";
import { normalizeRole, outletScopeForRole } from "./roles.js";
import type { AuthenticatedUser } from "./middleware.js";
import { clerkSettings, verifiedPrimaryEmail, verifyClerkSessionToken, type ClerkSettings } from "./clerk.js";
import {
  cachedClerkIdentity,
  knownValidSessionWorkspace,
  rememberClerkIdentity,
  rememberValidSession,
} from "./session-cache.js";

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string };

const INVALID: AuthResult = { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Invalid or expired token." };

export async function authenticateBearer(db: DB | undefined, token: string): Promise<AuthResult> {
  let payload: AuthTokenPayload | null = null;
  try {
    payload = verifyToken(token, loadConfig().jwtSecret);
  } catch {
    payload = null;
  }
  if (payload) return authenticateOrionToken(db, payload);

  const settings = clerkSettings();
  if (!settings) return INVALID;
  const clerkUserId = await verifyClerkSessionToken(token, settings);
  if (!clerkUserId) return INVALID;
  if (!db) return { ok: false, status: 503, code: "UNAVAILABLE", message: "Sign-in is temporarily unavailable." };
  return resolveClerkUser(db, clerkUserId, settings);
}

/**
 * The workspace of the session's user (one per account for now), as a subquery so the
 * session check and this lookup share one round trip. The outer reference is spelled
 * "user_session"."user_id" on purpose: see findClerkUser.
 */
const SESSION_WORKSPACE = sql<string | null>`(select m.tenant_id from membership m where m.user_id = "user_session"."user_id" order by m.created_at limit 1)`;

async function authenticateOrionToken(db: DB | undefined, payload: AuthTokenPayload): Promise<AuthResult> {
  // Password sign-in is the IT break-glass for workspace #1; a token with no session or no
  // membership on record (legacy, tests) stays there.
  let tenantId: string = WORKSPACE_ONE_ID;
  // Session revocation check; a positive answer is cached briefly (session-cache.ts).
  if (payload.sid && db) {
    const cached = knownValidSessionWorkspace(payload.sid);
    if (cached) {
      tenantId = cached;
    } else {
      const [session] = await db
        .select({ logoutAt: userSessions.logoutAt, tenantId: SESSION_WORKSPACE })
        .from(userSessions)
        .where(eq(userSessions.id, payload.sid));
      if (!session || session.logoutAt !== null) {
        return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Session ended. Please log in again." };
      }
      tenantId = session.tenantId ?? WORKSPACE_ONE_ID;
      rememberValidSession(payload.sid, payload.sub, tenantId);
    }
  }
  return {
    ok: true,
    user: {
      id: payload.sub,
      role: payload.role,
      sessionId: payload.sid,
      outletScope: payload.outlet_scope ?? outletScopeForRole(payload.role),
      outletIds: Array.isArray(payload.outlet_ids) ? payload.outlet_ids : [],
      name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null,
      tenantId,
    },
  };
}

type UserRow = typeof users.$inferSelect;

/**
 * The ORION user for a Clerk id plus their outlet ids, in ONE round trip: every cache miss
 * pays it, and the database is ~229 ms away from the API (Paris to Tokyo).
 * The outer reference is written as "user"."id" on purpose: Drizzle prints a bare "id"
 * for ${users.id} in a single-table select, which would bind to the subquery's own table.
 */
async function findClerkUser(
  db: DB,
  clerkUserId: string,
): Promise<{ user: UserRow; outletIds: string[]; tenantId: string | null } | undefined> {
  const [row] = await db
    .select({
      user: getTableColumns(users),
      outletIds: sql<string[]>`coalesce((select array_agg(a.location_id) from user_outlet_access a where a.user_id = "user"."id"), '{}')`,
      tenantId: sql<string | null>`(select m.tenant_id from membership m where m.user_id = "user"."id" order by m.created_at limit 1)`,
    })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId));
  return row;
}

async function resolveClerkUser(db: DB, clerkUserId: string, settings: ClerkSettings): Promise<AuthResult> {
  const cached = cachedClerkIdentity<AuthenticatedUser>(clerkUserId);
  if (cached) return { ok: true, user: cached };

  let found = await findClerkUser(db, clerkUserId);
  if (!found) {
    // First sign-in only: link by verified email, then read the account the same way.
    const linked = await linkByVerifiedEmail(db, clerkUserId, settings);
    if (!linked.ok) return linked;
    found = await findClerkUser(db, clerkUserId);
    if (!found) return INVALID;
  }
  const { user, outletIds, tenantId } = found;

  if (user.status === "BLOCKED") {
    return { ok: false, status: 403, code: "ACCOUNT_BLOCKED", message: "This account has been blocked. Contact the owner." };
  }
  if (normalizeRole(user.role) === null) {
    return { ok: false, status: 403, code: "ROLE_RETIRED", message: "This account's role has been retired. Contact the owner." };
  }
  if (!tenantId) {
    // An account with no workspace has nothing it may see (fail closed).
    return { ok: false, status: 403, code: "NO_WORKSPACE", message: "This account does not belong to a workspace. Ask the owner for a join link." };
  }

  const authenticated: AuthenticatedUser = {
    id: user.id,
    role: user.role,
    outletScope: outletScopeForRole(user.role),
    outletIds,
    name: user.name,
    tenantId,
  };
  rememberClerkIdentity(clerkUserId, user.id, authenticated);
  return { ok: true, user: authenticated };
}

/**
 * First Clerk sign-in: attach this Clerk account to the invited ORION user with the same
 * VERIFIED email. The UPDATE is conditional (clerk_user_id IS NULL), so two simultaneous
 * first sign-ins cannot both link, and an already-linked user cannot be taken over.
 */
async function linkByVerifiedEmail(
  db: DB,
  clerkUserId: string,
  settings: ClerkSettings,
): Promise<{ ok: true; user: UserRow } | Extract<AuthResult, { ok: false }>> {
  let email: string | null;
  try {
    email = await verifiedPrimaryEmail(clerkUserId, settings);
  } catch {
    return { ok: false, status: 503, code: "IDENTITY_UNAVAILABLE", message: "Could not reach the sign-in service. Try again." };
  }
  if (!email) {
    return { ok: false, status: 403, code: "EMAIL_NOT_VERIFIED", message: "Verify your email address, then sign in again." };
  }

  const [linked] = await db
    .update(users)
    .set({ clerkUserId, updatedAt: new Date() })
    .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.clerkUserId)))
    .returning();
  if (linked) {
    void audit(db, {
      actorUserId: linked.id,
      actorName: linked.name,
      action: "auth.clerk_linked",
      description: `${linked.name} signed in with Clerk for the first time; account linked`,
    });
    return { ok: true, user: linked };
  }

  // Lost a race with a parallel first sign-in, or the email belongs to an account already
  // linked to a DIFFERENT Clerk user.
  const [mine] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (mine) return { ok: true, user: mine };
  const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`);
  if (taken) {
    return { ok: false, status: 403, code: "ACCOUNT_LINKED_ELSEWHERE", message: "This email is already linked to another sign-in. Contact the owner." };
  }
  return {
    ok: false,
    status: 403,
    code: "NOT_INVITED",
    message: `${email} has not been added to ORION. Ask the business owner for a join link.`,
  };
}
