/**
 * Bundles every open, not-yet-emailed alert into ONE digest email row (the delivery outbox).
 *
 * One composer at a time (transaction-scoped advisory lock): a second worker process backs off
 * instead of splitting the digest into several emails or putting one alert in two. The email
 * insert and the event links commit together, so a crash leaves both or neither. Recipients
 * and body are frozen here; delivery only replays them.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { toRows } from "../../db/rows.js";
import { alertEmails, alertEvents, users } from "../../db/schema.js";
import { BUSINESS_TIMEZONE } from "../business-time.js";
import { isDeliverableEmail, type AlertSettings } from "./config.js";
import { renderAlertDigest } from "./render.js";

/** Resend accepts at most 50 recipients per email. */
const MAX_RECIPIENTS = 50;
/** Keeps one email readable; anything beyond goes into the next digest a minute later. */
const MAX_ALERTS_PER_EMAIL = 100;
/** Arbitrary constant naming the "compose alert digest" critical section for pg advisory locks. */
const COMPOSE_LOCK_KEY = 4402440;

/** Active owners plus ALERT_EMAIL_TO, lower-cased, de-duplicated, undeliverable test domains dropped. */
export async function alertRecipients(db: DB, settings: AlertSettings): Promise<string[]> {
  const owners = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, "OWNER"), eq(users.status, "ACTIVE")));
  const all = [...owners.map((o) => o.email.trim().toLowerCase()), ...settings.extraRecipients];
  return [...new Set(all.filter(isDeliverableEmail))].slice(0, MAX_RECIPIENTS);
}

export type ComposeResult =
  | { composed: false; reason: "nothing_new" | "no_recipients" | "busy" }
  | { composed: true; emailId: string; alerts: number };

export async function composeAlertDigest(db: DB, settings: AlertSettings, now: Date): Promise<ComposeResult> {
  const recipients = await alertRecipients(db, settings);
  if (recipients.length === 0) return { composed: false, reason: "no_recipients" };

  return db.transaction(async (tx) => {
    const [lock] = toRows<{ acquired: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${COMPOSE_LOCK_KEY}) AS acquired`));
    if (!lock?.acquired) return { composed: false, reason: "busy" } as const;

    const pending = await tx
      .select({ id: alertEvents.id, kind: alertEvents.kind, details: alertEvents.details })
      .from(alertEvents)
      .where(and(isNull(alertEvents.emailId), isNull(alertEvents.resolvedAt)))
      .orderBy(asc(alertEvents.openedAt))
      .limit(MAX_ALERTS_PER_EMAIL);
    if (pending.length === 0) return { composed: false, reason: "nothing_new" } as const;

    const rendered = renderAlertDigest(pending, { now, timezone: BUSINESS_TIMEZONE, appUrl: settings.appUrl });
    const [email] = await tx
      .insert(alertEmails)
      .values({
        fromAddress: settings.from,
        recipients,
        subject: rendered.subject,
        textBody: rendered.text,
        htmlBody: rendered.html,
        availableAt: now,
        createdAt: now,
      })
      .returning({ id: alertEmails.id });
    await tx
      .update(alertEvents)
      .set({ emailId: email!.id })
      .where(inArray(alertEvents.id, pending.map((p) => p.id)));
    return { composed: true, emailId: email!.id, alerts: pending.length } as const;
  });
}

/** Queues a one-off test email through the same outbox (ops check after setup). */
export async function queueTestEmail(db: DB, settings: AlertSettings, now: Date): Promise<{ emailId: string; recipients: number } | null> {
  const recipients = await alertRecipients(db, settings);
  if (recipients.length === 0) return null;
  const subject = "ORION alert emails are working";
  const text = `${subject}\n\nOwners will get an email like this when kitchen stock runs low, an order is not started within ${settings.unattendedMinutes} minutes, or an order is cooking for over ${settings.stuckMinutes} minutes.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827"><h2 style="font-size:18px">${subject}</h2><p>Owners will get an email like this when kitchen stock runs low, an order is not started within ${settings.unattendedMinutes} minutes, or an order is cooking for over ${settings.stuckMinutes} minutes.</p></div>`;
  const [email] = await db
    .insert(alertEmails)
    .values({ fromAddress: settings.from, recipients, subject, textBody: text, htmlBody: html, availableAt: now, createdAt: now })
    .returning({ id: alertEmails.id });
  return { emailId: email!.id, recipients: recipients.length };
}
