/**
 * Operator (Prince IT) account commands, run from the server CLI, never over HTTP.
 *
 *   grantFirstOwner   creates the business owner's ORION account for a real email and sends
 *                     the Clerk invitation, so they can sign in with Google or an email code.
 *   retireSeedAccounts  blocks the seeded demo accounts (admin@cloudkitchen.local etc.) and
 *                     ends their sessions, once a real owner can sign in.
 *
 * Both are idempotent: running one twice changes nothing the second time. Neither ever
 * promotes or demotes an existing person silently; those cases stop with a reason.
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { userSessions, users } from "../../db/schema.js";
import { isDeliverableEmail } from "../alerts/config.js";
import { clerkSettings, sendClerkInvitation } from "../auth/clerk.js";
import { hashPassword } from "../auth/service.js";
import { audit } from "../ems/audit.js";

const OPERATOR_ACTOR = "operator (server CLI)";

export type GrantOwnerResult =
  | {
      outcome: "created" | "already_owner";
      userId: string;
      invitation: "sent" | "already_linked" | "not_configured";
      /** Sign-up link for this email, to send by chat when the email does not arrive. */
      inviteUrl?: string | null;
    }
  | { outcome: "refused"; reason: string };

export type InviteSender = (email: string) => Promise<{ url: string | null } | null>;

const defaultInvite: InviteSender = (email) => sendClerkInvitation(email, clerkSettings());

export async function grantFirstOwner(
  db: DB,
  input: { email: string; name: string },
  invite: InviteSender = defaultInvite,
): Promise<GrantOwnerResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!isDeliverableEmail(email)) return { outcome: "refused", reason: `"${email}" is not a real, deliverable email address.` };
  if (name.length < 2 || name.length > 120) return { outcome: "refused", reason: "Name must be 2-120 characters." };

  const findByEmail = async () =>
    (await db.select().from(users).where(sql`lower(${users.email}) = ${email}`))[0];

  let user = await findByEmail();
  let outcome: "created" | "already_owner" = "already_owner";
  if (!user) {
    // No password: the account can only be entered through Clerk (Google or email code).
    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
    await db.insert(users).values({ name, email, passwordHash, role: "OWNER" }).onConflictDoNothing();
    user = await findByEmail(); // a concurrent run may have inserted it first; either way, read the row
    outcome = "created";
  }
  if (!user) return { outcome: "refused", reason: "The account could not be created." };
  if (user.role !== "OWNER") {
    return { outcome: "refused", reason: `${email} already exists as ${user.role}. Change their role in Users & Roles instead of granting here.` };
  }
  if (user.status !== "ACTIVE") return { outcome: "refused", reason: `${email} is ${user.status}. Unblock it in Users & Roles first.` };

  if (outcome === "created") {
    await audit(db, {
      actorName: OPERATOR_ACTOR,
      action: "operator.owner_granted",
      description: `Created owner account for ${name} <${email}>`,
      entityType: "user",
      entityId: user.id,
    });
  }

  if (user.clerkUserId) return { outcome, userId: user.id, invitation: "already_linked" };
  const sent = await invite(email);
  return sent
    ? { outcome, userId: user.id, invitation: "sent", inviteUrl: sent.url }
    : { outcome, userId: user.id, invitation: "not_configured" };
}

/** Seed/demo accounts: any user on a reserved, undeliverable domain such as cloudkitchen.local. */
const SEED_EMAIL_SQL = sql`lower(${users.email}) ~ '\\.(local|localhost|test|example|invalid)$'`;

export type RetireSeedsResult =
  | { outcome: "retired"; blocked: number; sessionsEnded: number }
  | { outcome: "refused"; reason: string };

export async function retireSeedAccounts(db: DB, now: Date = new Date()): Promise<RetireSeedsResult> {
  // Lockout guard: only once a real owner has actually signed in through Clerk.
  const realOwners = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "OWNER"), eq(users.status, "ACTIVE"), isNotNull(users.clerkUserId)));
  if (!realOwners.some((o) => isDeliverableEmail(o.email.toLowerCase()))) {
    return {
      outcome: "refused",
      reason: "No real owner has signed in with Google/email yet. Run owner:grant, sign in once, then retire the seed accounts.",
    };
  }

  return db.transaction(async (tx) => {
    const blocked = await tx
      .update(users)
      .set({ status: "BLOCKED", updatedAt: now })
      .where(and(SEED_EMAIL_SQL, eq(users.status, "ACTIVE")))
      .returning({ id: users.id, email: users.email });
    const seedIds = (await tx.select({ id: users.id }).from(users).where(SEED_EMAIL_SQL)).map((u) => u.id);
    const ended =
      seedIds.length === 0
        ? []
        : await tx
            .update(userSessions)
            .set({ logoutAt: now })
            .where(and(inArray(userSessions.userId, seedIds), isNull(userSessions.logoutAt)))
            .returning({ id: userSessions.id });
    if (blocked.length > 0) {
      await audit(tx as unknown as DB, {
        actorName: OPERATOR_ACTOR,
        action: "operator.seed_accounts_retired",
        description: `Blocked ${blocked.length} seed/demo account(s)`,
        entityType: "user",
        metadata: { emails: blocked.map((b) => b.email) },
      });
    }
    return { outcome: "retired", blocked: blocked.length, sessionsEnded: ended.length } as const;
  });
}
