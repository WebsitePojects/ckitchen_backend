/**
 * Workspace join links: a one-time, expiring link an owner sends by chat. Whoever opens it
 * signs in with any Google account (Clerk) and joins the workspace with the role and outlets
 * the owner chose. Unlike a Clerk invitation, it needs no email address up front.
 *
 * Security shape:
 *  - Token = `<link id>.<HMAC-SHA256(JWT_SECRET, context + id)>`. Nothing secret is stored;
 *    the server re-derives the MAC to verify a token and to show an unused link again.
 *  - One use: redeeming is a conditional UPDATE (unused, unrevoked, unexpired), so parallel
 *    redeems create one account at most. The losing request replays as success when it was
 *    the same person, else gets LINK_INVALID.
 *  - The joining email must be VERIFIED by Clerk, and an email already in ORION is refused
 *    (that person signs in normally and is linked by email), so a link can never take over
 *    an existing account.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import {
  locations,
  tenants,
  userOutletAccess,
  users,
  workspaceJoinLinks,
  WORKSPACE_ONE_ID,
  type Role,
  type User,
  type WorkspaceJoinLink,
} from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { hashPassword } from "../auth/service.js";
import { outletScopeForRole } from "../auth/roles.js";
import { isUuid } from "../http-errors.js";

const TOKEN_CONTEXT = "orion-join-link:v1:";

function tokenMac(id: string): string {
  return createHmac("sha256", loadConfig().jwtSecret).update(TOKEN_CONTEXT + id).digest("base64url");
}

/** The bearer token for a link. Only ever returned to the owner who manages links. */
export function joinLinkToken(id: string): string {
  return `${id}.${tokenMac(id)}`;
}

/** The link id a token was issued for, or null for anything malformed or forged. */
export function linkIdFromToken(token: string): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!isUuid(id)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(tokenMac(id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}

export type JoinLinkStatus = "active" | "used" | "revoked" | "expired";

export function joinLinkStatus(link: WorkspaceJoinLink, now = new Date()): JoinLinkStatus {
  if (link.usedAt) return "used";
  if (link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  return "active";
}

// ---------------------------------------------------------------------------
// Owner side
// ---------------------------------------------------------------------------

export interface CreateJoinLinkInput {
  role: Role;
  inviteeName: string;
  outletIds: string[];
  expiresInDays: number;
  /** Generated once per "create link" intent by the client; a retry replays the same link. */
  clientRequestId: string;
  createdByUserId: string;
}

export type CreateJoinLinkResult =
  | { ok: true; link: WorkspaceJoinLink; replay: boolean }
  | { ok: false; code: "UNKNOWN_OUTLET" | "REQUEST_REUSED" };

export async function createJoinLink(db: DB, input: CreateJoinLinkInput): Promise<CreateJoinLinkResult> {
  // Roles that see every outlet ignore outlet grants; storing none keeps the row honest.
  const outletIds = outletScopeForRole(input.role) === "ALL" ? [] : [...new Set(input.outletIds)];
  if (outletIds.length > 0) {
    const found = await db.select({ id: locations.id }).from(locations).where(inArray(locations.id, outletIds));
    if (found.length !== outletIds.length) return { ok: false, code: "UNKNOWN_OUTLET" };
  }

  const [created] = await db
    .insert(workspaceJoinLinks)
    .values({
      tenantId: WORKSPACE_ONE_ID,
      role: input.role,
      inviteeName: input.inviteeName,
      outletIds,
      clientRequestId: input.clientRequestId,
      createdByUserId: input.createdByUserId,
      expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing({ target: [workspaceJoinLinks.tenantId, workspaceJoinLinks.clientRequestId] })
    .returning();
  if (created) return { ok: true, link: created, replay: false };

  // Same request id seen before: a retried click replays its link; a different payload
  // under a reused id is a client bug and is refused rather than silently merged.
  const [existing] = await db
    .select()
    .from(workspaceJoinLinks)
    .where(and(eq(workspaceJoinLinks.tenantId, WORKSPACE_ONE_ID), eq(workspaceJoinLinks.clientRequestId, input.clientRequestId)));
  const sameIntent =
    existing &&
    existing.role === input.role &&
    existing.inviteeName === input.inviteeName &&
    existing.createdByUserId === input.createdByUserId;
  return sameIntent ? { ok: true, link: existing, replay: true } : { ok: false, code: "REQUEST_REUSED" };
}

/** Newest first, bounded: the owner's screen shows recent links only. */
export async function listJoinLinks(db: DB, limit = 50) {
  return db
    .select({ link: workspaceJoinLinks, usedByName: users.name })
    .from(workspaceJoinLinks)
    .leftJoin(users, eq(users.id, workspaceJoinLinks.usedByUserId))
    .where(eq(workspaceJoinLinks.tenantId, WORKSPACE_ONE_ID))
    .orderBy(desc(workspaceJoinLinks.createdAt), desc(workspaceJoinLinks.id))
    .limit(limit);
}

export type RevokeJoinLinkResult =
  | { ok: true; link: WorkspaceJoinLink }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_USED" };

export async function revokeJoinLink(db: DB, id: string): Promise<RevokeJoinLinkResult> {
  const [revoked] = await db
    .update(workspaceJoinLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(workspaceJoinLinks.id, id),
        eq(workspaceJoinLinks.tenantId, WORKSPACE_ONE_ID),
        isNull(workspaceJoinLinks.usedAt),
        isNull(workspaceJoinLinks.revokedAt),
      ),
    )
    .returning();
  if (revoked) return { ok: true, link: revoked };

  const [link] = await db
    .select()
    .from(workspaceJoinLinks)
    .where(and(eq(workspaceJoinLinks.id, id), eq(workspaceJoinLinks.tenantId, WORKSPACE_ONE_ID)));
  if (!link) return { ok: false, code: "NOT_FOUND" };
  if (link.usedAt) return { ok: false, code: "ALREADY_USED" };
  return { ok: true, link }; // already revoked: a repeated click is a no-op
}

// ---------------------------------------------------------------------------
// Joining side
// ---------------------------------------------------------------------------

/** What the join page shows before sign-in; null when the link cannot be used. */
export async function previewJoinLink(db: DB, linkId: string) {
  const [row] = await db
    .select({ link: workspaceJoinLinks, workspaceName: tenants.name })
    .from(workspaceJoinLinks)
    .innerJoin(tenants, eq(tenants.id, workspaceJoinLinks.tenantId))
    .where(eq(workspaceJoinLinks.id, linkId));
  if (!row || joinLinkStatus(row.link) !== "active") return null;
  return { workspaceName: row.workspaceName, role: row.link.role, inviteeName: row.link.inviteeName, expiresAt: row.link.expiresAt };
}

export type RedeemJoinLinkResult =
  | { ok: true; user: User; replay: boolean }
  | { ok: false; code: "LINK_INVALID" | "ALREADY_MEMBER" | "EMAIL_NOT_VERIFIED" | "EMAIL_ALREADY_ADDED"; email?: string };

class LinkUnavailableError extends Error {}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object") {
      return (e["cause"] as Record<string, unknown>)["code"] === "23505";
    }
  }
  return false;
}

/**
 * The account this Clerk user already has, resolved against the link: the person who used
 * this very link gets a replay (double click, retried request); anyone else already in
 * ORION is ALREADY_MEMBER and the link stays unused.
 */
async function resolveExistingMember(db: DB, linkId: string, clerkUserId: string): Promise<RedeemJoinLinkResult | null> {
  const [member] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId));
  if (!member) return null;
  const [link] = await db
    .select({ usedByUserId: workspaceJoinLinks.usedByUserId })
    .from(workspaceJoinLinks)
    .where(eq(workspaceJoinLinks.id, linkId));
  return link?.usedByUserId === member.id ? { ok: true, user: member, replay: true } : { ok: false, code: "ALREADY_MEMBER" };
}

/**
 * Creates the ORION account for a Clerk user from an active link, in one transaction:
 * claim the link (conditional UPDATE), create the user already linked to Clerk, grant the
 * link's outlets, record who used it. `verifiedEmail` asks Clerk for the VERIFIED primary
 * email and may throw when Clerk is unreachable (the caller answers 503).
 */
export async function redeemJoinLink(
  db: DB,
  linkId: string,
  clerkUserId: string,
  verifiedEmail: () => Promise<string | null>,
): Promise<RedeemJoinLinkResult> {
  const existing = await resolveExistingMember(db, linkId, clerkUserId);
  if (existing) return existing;

  const rawEmail = await verifiedEmail();
  if (!rawEmail) return { ok: false, code: "EMAIL_NOT_VERIFIED" };
  const email = rawEmail.trim().toLowerCase();
  const [sameEmail] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (sameEmail) return { ok: false, code: "EMAIL_ALREADY_ADDED", email };

  // Clerk-only account: the password path gets an unusable random hash (as POST /admin/users).
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  try {
    const user = await db.transaction(async (tx) => {
      const [link] = await tx
        .update(workspaceJoinLinks)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(workspaceJoinLinks.id, linkId),
            isNull(workspaceJoinLinks.usedAt),
            isNull(workspaceJoinLinks.revokedAt),
            gt(workspaceJoinLinks.expiresAt, sql`now()`),
          ),
        )
        .returning();
      if (!link) throw new LinkUnavailableError();
      // Until SaaS step 6 the account's workspace comes from the user row (mirrored into
      // workspace #1's membership by trigger), so a link for any other workspace cannot be
      // honoured yet. Fail closed rather than put someone in the wrong business.
      if (link.tenantId !== WORKSPACE_ONE_ID) throw new LinkUnavailableError();

      const [created] = await tx
        .insert(users)
        .values({ name: link.inviteeName, email, passwordHash, role: link.role, clerkUserId })
        .returning();
      if (link.outletIds.length > 0) {
        const stillThere = await tx.select({ id: locations.id }).from(locations).where(inArray(locations.id, link.outletIds));
        if (stillThere.length > 0) {
          await tx.insert(userOutletAccess).values(stillThere.map((o) => ({ userId: created!.id, locationId: o.id })));
        }
      }
      await tx.update(workspaceJoinLinks).set({ usedByUserId: created!.id }).where(eq(workspaceJoinLinks.id, link.id));
      return created!;
    });
    return { ok: true, user, replay: false };
  } catch (err) {
    if (err instanceof LinkUnavailableError) {
      // A parallel request from the same person may have just used this link.
      return (await resolveExistingMember(db, linkId, clerkUserId)) ?? { ok: false, code: "LINK_INVALID" };
    }
    if (isUniqueViolation(err)) {
      // A parallel redeem (this or another link) created this person's account first; the
      // transaction rolled back, so this link is still unused. Re-read outside it.
      return (await resolveExistingMember(db, linkId, clerkUserId)) ?? { ok: false, code: "EMAIL_ALREADY_ADDED", email };
    }
    throw err;
  }
}
