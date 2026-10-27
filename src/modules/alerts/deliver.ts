/**
 * Sends queued alert emails: lease-claim, send, then a terminal or retry state.
 *
 * Claim is a conditional UPDATE (PENDING and due, or SENDING with an expired lease), so two
 * workers racing for one row get exactly one winner. The idempotency key is the row id and the
 * request is the frozen row, so re-sending after a crash between "Resend accepted" and "marked
 * SENT" returns Resend's original result instead of a second email.
 * Bounded: MAX_ATTEMPTS with exponential backoff, then FAILED (kept, never deleted).
 */
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { alertEmails } from "../../db/schema.js";
import type { AlertSettings } from "./config.js";
import type { SendEmail } from "./resend.js";

export const MAX_ATTEMPTS = 6;
const LEASE_MS = 2 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Small batches keep a tick short and stay well under the provider's per-second limit. */
const BATCH = 5;

export function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

export interface DeliverResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

export async function deliverAlertEmails(db: DB, settings: AlertSettings, send: SendEmail, now: Date): Promise<DeliverResult> {
  const due = or(
    and(eq(alertEmails.status, "PENDING"), lte(alertEmails.availableAt, now)),
    and(eq(alertEmails.status, "SENDING"), lte(alertEmails.leaseUntil, now)),
  );
  const candidates = await db
    .select({ id: alertEmails.id })
    .from(alertEmails)
    .where(due)
    .orderBy(asc(alertEmails.createdAt))
    .limit(BATCH);

  const result: DeliverResult = { claimed: 0, sent: 0, retrying: 0, failed: 0 };
  for (const candidate of candidates) {
    const [row] = await db
      .update(alertEmails)
      .set({ status: "SENDING", leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: sql`${alertEmails.attempts} + 1` })
      .where(and(eq(alertEmails.id, candidate.id), due))
      .returning();
    if (!row) continue; // another worker won this row
    result.claimed += 1;

    const outcome = await send(
      settings.resendApiKey,
      { from: row.fromAddress, to: row.recipients, subject: row.subject, text: row.textBody, html: row.htmlBody },
      row.id,
    );

    // Every finish is guarded by the lease we hold, so a slow send that lost its lease cannot
    // overwrite the result written by whoever re-claimed it.
    const ours = and(eq(alertEmails.id, row.id), eq(alertEmails.status, "SENDING"), eq(alertEmails.attempts, row.attempts));
    if (outcome.ok) {
      await db
        .update(alertEmails)
        .set({ status: "SENT", sentAt: now, providerMessageId: outcome.providerMessageId || null, leaseUntil: null, lastError: null })
        .where(ours);
      result.sent += 1;
    } else if (outcome.retryable && row.attempts < MAX_ATTEMPTS) {
      await db
        .update(alertEmails)
        .set({ status: "PENDING", availableAt: new Date(now.getTime() + backoffMs(row.attempts)), leaseUntil: null, lastError: outcome.message })
        .where(ours);
      result.retrying += 1;
    } else {
      await db.update(alertEmails).set({ status: "FAILED", leaseUntil: null, lastError: outcome.message }).where(ours);
      result.failed += 1;
    }
  }
  return result;
}
