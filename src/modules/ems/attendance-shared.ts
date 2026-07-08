/**
 * Attendance punch — shared core (CK1-EMS-005 §3)
 *
 * The single code path that validates, uploads the photo, inserts the
 * attendance_record row, and writes the audit entry. Called by BOTH:
 *   - the authenticated route  (POST /ems/attendance)     — actor from the token
 *   - the public kiosk route   (POST /public/attendance)  — no actor, "Public"
 *
 * Keeping this in one place means the photo size limit, ACTIVE-employee check,
 * Cloudinary upload semantics (incl. the 502-on-failure contract), punch gate
 * (no-double-punch, see below), and audit shape can never drift between the
 * two routes.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { attendanceRecords, attendanceTypeEnum, employees, type AttendanceRecord } from "../../db/schema.js";
import { uploadAttendancePhoto } from "./cloudinary.js";
import { audit } from "./audit.js";

/** Reject attendance photos larger than 8 MB (base64 string length ≈ byte budget). */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export type AttendanceType = (typeof attendanceTypeEnum.enumValues)[number];

export interface PunchInput {
  employeeId: string;
  type: AttendanceType;
  photo: string;
  note?: string | null;
}

/**
 * Who is recording the punch. For an authenticated request these come from the
 * verified token (never the body — anti-spoof). For a public-kiosk punch every
 * user field is null and `source` marks it, which flips the audit actor to
 * "Public" and stamps `metadata.source`.
 */
export interface PunchActor {
  /** attendance_record.recorded_by_user_id — null for a public-kiosk punch. */
  recordedByUserId: string | null;
  /** attendance_record.session_id — null for a public-kiosk punch. */
  sessionId: string | null;
  /** audit_log.actor_user_id — null for a public-kiosk punch. */
  auditActorUserId: string | null;
  /** audit_log.actor_name — a real name for authed, "Public" for the kiosk. */
  auditActorName: string | null;
  /** Set only for a public-kiosk punch; recorded in the audit metadata. */
  source?: "public_kiosk";
}

export type PunchResult =
  | { ok: true; record: AttendanceRecord }
  | { ok: false; status: number; code: string; message: string };

// ---------------------------------------------------------------------------
// DTR pairing — the single source of truth for turning a stream of punches into
// one entry per (employee, UTC date). Extracted from GET /ems/attendance/dtr so
// the DTR route and the Employee 360 profile endpoint pair identically (they
// MUST never drift — a "present" day on the profile is exactly a COMPLETE DTR
// entry). See the 24h-forfeit contract on `status` below.
// ---------------------------------------------------------------------------

/** One paired DTR entry (client review 2026-07-08 status contract). */
export interface DtrEntry {
  date: string;
  employee_id: string;
  time_in: string | null;
  time_out: string | null;
  photo_in: string | null;
  photo_out: string | null;
  minutes: number | null;
  /**
   *   COMPLETE  — paired TIME_IN + TIME_OUT (minutes = the diff).
   *   OPEN      — unpaired TIME_IN < 24h old (shift may still close).
   *   FORFEITED — unpaired TIME_IN ≥ 24h old: no TIME_OUT is ever synthesized,
   *               minutes stays null (HR corrects manually).
   */
  status: "COMPLETE" | "OPEN" | "FORFEITED";
}

const FORFEIT_MS = 24 * 60 * 60 * 1000;

/**
 * Pairs punches into DTR entries, one per (employee, UTC date). Earliest TIME_IN
 * is paired with the latest TIME_OUT that day. `rows` MUST be ordered by
 * capturedAt ASC so the latest TIME_OUT wins. `nowMs` drives the 24h forfeit cut
 * (defaults to now) — pass it explicitly so callers computing several things off
 * one clock stay consistent. Behavior is identical to the original inline DTR
 * loop; its tests pin it.
 */
export function pairDtrEntries(
  rows: ReadonlyArray<{ employeeId: string; type: AttendanceType; photoUrl: string; capturedAt: Date | string }>,
  nowMs: number = Date.now(),
): DtrEntry[] {
  const byKey = new Map<string, DtrEntry>();
  for (const r of rows) {
    const iso = new Date(r.capturedAt).toISOString();
    const date = iso.slice(0, 10);
    const key = `${r.employeeId}|${date}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { date, employee_id: r.employeeId, time_in: null, time_out: null, photo_in: null, photo_out: null, minutes: null, status: "OPEN" };
      byKey.set(key, entry);
    }
    if (r.type === "TIME_IN") {
      if (!entry.time_in) {
        entry.time_in = iso;
        entry.photo_in = r.photoUrl;
      }
    } else {
      entry.time_out = iso; // latest TIME_OUT wins (rows asc by time)
      entry.photo_out = r.photoUrl;
    }
  }
  for (const entry of byKey.values()) {
    if (entry.time_in && entry.time_out) {
      entry.minutes = Math.round(
        (new Date(entry.time_out).getTime() - new Date(entry.time_in).getTime()) / 60000,
      );
      entry.status = "COMPLETE";
    } else if (entry.time_in) {
      // 24h forfeit: no TIME_OUT synthesized, minutes stays null. Within 24h the
      // shift is simply still OPEN.
      entry.status = nowMs - new Date(entry.time_in).getTime() > FORFEIT_MS ? "FORFEITED" : "OPEN";
    } else {
      // Degenerate: a TIME_OUT with no TIME_IN that day (data anomaly — the punch
      // gate prevents new ones). Nothing is open to forfeit; surface as
      // COMPLETE-with-null-minutes so HR spots and corrects it.
      entry.status = "COMPLETE";
    }
  }
  return Array.from(byKey.values());
}

/**
 * Validates + persists one attendance punch. Returns a discriminated result so
 * each route maps it to HTTP itself (the authed route and the kiosk route share
 * identical failure semantics: 400 oversized photo, 404 unknown employee, 400
 * inactive employee, 502 photo-upload failure).
 */
export async function recordAttendancePunch(
  db: DB,
  input: PunchInput,
  actor: PunchActor,
): Promise<PunchResult> {
  if (input.photo.length > MAX_PHOTO_BYTES) {
    return { ok: false, status: 400, code: "PAYLOAD_TOO_LARGE", message: "Attendance photo exceeds the 8 MB limit." };
  }

  const [emp] = await db.select().from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: `Employee ${input.employeeId} not found.` };
  }
  if (emp.status !== "ACTIVE") {
    return { ok: false, status: 400, code: "VALIDATION_ERROR", message: `Employee ${emp.fullName} is not ACTIVE.` };
  }

  // ── Punch gate (client review 2026-07-08): server-enforced, no exceptions ──
  // The sequence within one day is strictly TIME_IN → TIME_OUT. Enforced HERE
  // in the shared core so the authed route (including the OWNER kiosk
  // override) and the public kiosk can never drift:
  //   TIME_IN  while a TIME_IN exists today          → 409 ALREADY_TIMED_IN
  //   TIME_OUT with no TIME_IN today                 → 409 NOT_TIMED_IN
  //   TIME_OUT while a TIME_OUT exists today         → 409 ALREADY_TIMED_OUT
  // Day-scoped on UTC day boundaries — the same window /ems/attendance/self/
  // today uses (Manila-day boundaries are the same documented follow-up), so a
  // forfeited/unclosed yesterday never blocks today's TIME_IN. Checked BEFORE
  // the Cloudinary upload so a rejected punch costs no network round-trip.
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const todays = await db
    .select({ type: attendanceRecords.type })
    .from(attendanceRecords)
    .where(
      and(
        eq(attendanceRecords.employeeId, input.employeeId),
        gte(attendanceRecords.capturedAt, startOfDay),
        lte(attendanceRecords.capturedAt, endOfDay),
      ),
    );
  const hasIn = todays.some((r) => r.type === "TIME_IN");
  const hasOut = todays.some((r) => r.type === "TIME_OUT");
  if (input.type === "TIME_IN" && hasIn) {
    return { ok: false, status: 409, code: "ALREADY_TIMED_IN", message: `${emp.fullName} already timed in today.` };
  }
  if (input.type === "TIME_OUT" && !hasIn) {
    return { ok: false, status: 409, code: "NOT_TIMED_IN", message: `${emp.fullName} has not timed in today.` };
  }
  if (input.type === "TIME_OUT" && hasOut) {
    return { ok: false, status: 409, code: "ALREADY_TIMED_OUT", message: `${emp.fullName} already timed out today.` };
  }

  let uploaded: { url: string; publicId: string };
  try {
    uploaded = await uploadAttendancePhoto(input.photo);
  } catch {
    // Never leak Cloudinary config/secret detail to the caller.
    return { ok: false, status: 502, code: "UPLOAD_FAILED", message: "Failed to upload attendance photo." };
  }

  const [record] = await db
    .insert(attendanceRecords)
    .values({
      employeeId: input.employeeId,
      type: input.type,
      photoUrl: uploaded.url,
      photoPublicId: uploaded.publicId,
      recordedByUserId: actor.recordedByUserId,
      sessionId: actor.sessionId,
      note: input.note ?? null,
    })
    .returning();

  const via = actor.source === "public_kiosk" ? " via public kiosk" : "";
  void audit(db, {
    actorUserId: actor.auditActorUserId,
    actorName: actor.auditActorName,
    sessionId: actor.sessionId,
    action: input.type === "TIME_IN" ? "attendance.time_in" : "attendance.time_out",
    description: `${input.type} for ${emp.fullName} (${emp.employeeNo})${via}`,
    entityType: "attendance_record",
    entityId: record!.id,
    metadata: actor.source ? { source: actor.source } : null,
  });

  return { ok: true, record: record! };
}
