-- ============================================================================
-- Migration 0022 — order_code (human-friendly copyable order reference)
--
-- Adds a nullable `order_code` text column to "order" with a UNIQUE index
-- (order_order_code_unique). New orders get `<BRAND>-<AGG>-<RAND>` codes
-- generated app-side in ingestOrder (orders/service.ts), e.g. TOK-FP-7K3QD:
-- BRAND = first 3 alphanumeric chars of the brand name (X-padded), AGG =
-- FP|GF|WI, RAND = 5 chars of a no-0/O/1/I base32 alphabet via crypto.
--
-- Backfill: existing rows get UPPER(md5(id) first 6 hex chars) — deterministic,
-- idempotent (WHERE order_code IS NULL), and format-distinct from app codes
-- (6 hex chars, no hyphens) so backfilled and generated codes can never collide.
-- A 6-hex-char prefix collision across a few hundred staging rows is
-- practically impossible (~16M space), but the unique index is still created
-- AFTER the backfill inside a DO block that, on a duplicate, regenerates only
-- the colliding rows from a salted hash and retries once.
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: every
-- statement guarded (ADD COLUMN IF NOT EXISTS / backfill scoped to NULL rows /
-- CREATE UNIQUE INDEX IF NOT EXISTS), matching the 0018-0021 convention.
-- Journal `when` = 1784100000000 — strictly greater than 0021's 1784000000000
-- so the incremental migrator does not skip it.
-- ============================================================================

ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "order_code" text;--> statement-breakpoint
UPDATE "order" SET "order_code" = UPPER(SUBSTRING(MD5(id::text) FROM 1 FOR 6)) WHERE "order_code" IS NULL;--> statement-breakpoint
DO $$ BEGIN
	BEGIN
		CREATE UNIQUE INDEX IF NOT EXISTS "order_order_code_unique" ON "order" USING btree ("order_code");
	EXCEPTION WHEN unique_violation THEN
		-- Backfill collision (see header): regenerate ONLY the colliding rows from
		-- a salted hash, then retry once. A second failure aborts the migration —
		-- correct behavior, a silent partial index would be worse.
		UPDATE "order" SET "order_code" = UPPER(SUBSTRING(MD5(id::text || '-dedup') FROM 1 FOR 6))
		WHERE "order_code" IN (
			SELECT "order_code" FROM "order" GROUP BY "order_code" HAVING COUNT(*) > 1
		);
		CREATE UNIQUE INDEX IF NOT EXISTS "order_order_code_unique" ON "order" USING btree ("order_code");
	END;
END $$;
