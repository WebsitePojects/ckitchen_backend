-- ============================================================================
-- Migration 0023 — attendance_record.recorded_by_user_id nullable (public kiosk)
--
-- The public, unauthenticated attendance kiosk (POST /public/attendance) records
-- a punch with NO logged-in actor: the only identity evidence is the mandatory
-- photo. Such rows carry recorded_by_user_id = NULL (and session_id = NULL), and
-- their audit entry is credited to the "Public" actor category (see
-- docs/audit/audit-event-types.md §1). recorded_by_user_id was created NOT NULL
-- in 0006; this drops that constraint. Authenticated punches still set it from
-- the verified token (anti-spoof) — a NULL therefore means "public-kiosk punch".
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: DROP NOT
-- NULL is inherently a no-op on a second run, and it is additionally guarded by an
-- information_schema check so re-applying (or applying to a DB already patched)
-- never errors — matching the 0018-0022 convention. Journal `when` = 1784200000000
-- — strictly greater than 0022's 1784100000000 so the incremental migrator does
-- not skip it.
-- ============================================================================

DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'attendance_record'
			AND column_name = 'recorded_by_user_id'
			AND is_nullable = 'NO'
	) THEN
		ALTER TABLE "attendance_record" ALTER COLUMN "recorded_by_user_id" DROP NOT NULL;
	END IF;
END $$;
