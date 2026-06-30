/**
 * Audit helper — CK1-EMS-005 §4
 *
 * Append-only insert into audit_log. Must never throw into the calling request
 * path: any DB failure is caught, logged to stderr, and silently swallowed.
 *
 * Actor/session MUST be derived from the verified JWT (req.user), never from
 * client-supplied body fields (anti-spoof requirement).
 */
import type { DB } from "../../db/client.js";
import { auditLogs } from "../../db/schema.js";

export interface AuditEntry {
  actorUserId?: string | null;
  actorName?: string | null;
  sessionId?: string | null;
  action: string;
  description?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Inserts one audit_log row. Silently swallows errors so a logging failure
 * never breaks the originating request.
 */
export async function audit(db: DB, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: entry.actorUserId ?? null,
      actorName: entry.actorName ?? null,
      sessionId: entry.sessionId ?? null,
      action: entry.action,
      description: entry.description ?? null,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    // Audit must never break the request path.
    console.error("[audit] failed to write audit_log row:", err);
  }
}
