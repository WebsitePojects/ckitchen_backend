/**
 * Attendance punch — shared core (CK1-EMS-005 §3)
 *
 * The single code path that validates, uploads the photo, inserts the
 * attendance_record row, and writes the audit entry. Called by BOTH:
 *   - the authenticated route  (POST /ems/attendance)     — actor from the token
 *   - the public kiosk route   (POST /public/attendance)  — no actor, "Public"
 *
 * Keeping this in one place means the photo size limit, ACTIVE-employee check,
 * Cloudinary upload semantics (incl. the 502-on-failure contract), and audit
 * shape can never drift between the two routes.
 */
import { eq } from "drizzle-orm";
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
