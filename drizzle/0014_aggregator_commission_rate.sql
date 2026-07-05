-- ── W3 sales reports (D33 #10): aggregator commission rate ──────────────────
--
-- Adds a nullable commission_rate (percent, 0-100) to aggregator_account so
-- GET /reports/sales can compute net = gross - commission per order via the
-- order's channel listing. NULL = not yet configured (client rates are still
-- pending — CLIENT_QUESTIONS Part 2); the report service treats NULL as 0,
-- so gross == net until real rates are entered. Default is NULL, not 0, so a
-- future "rate configured as literal zero" is distinguishable from "not set"
-- if that distinction ever matters (e.g. a UI badge for "needs commission").
--
-- Hand-written (not `drizzle-kit generate`): the drizzle snapshot chain is
-- already broken as of migration 0012 (see 0013's header for the full
-- explanation — no 0012_snapshot.json/0013_snapshot.json were ever committed).
-- This migration is additive-only (one nullable column + a NOT VALID CHECK),
-- verified by manual diff against schema.ts, following the 0009 pattern of
-- adding CHECK constraints NOT VALID (no full-table validation scan needed
-- for a brand-new nullable column with no existing rows to violate it).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "aggregator_account" ADD COLUMN "commission_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "aggregator_account" ADD CONSTRAINT "aggregator_account_commission_rate_range" CHECK ("commission_rate" IS NULL OR ("commission_rate" >= 0 AND "commission_rate" <= 100)) NOT VALID;
