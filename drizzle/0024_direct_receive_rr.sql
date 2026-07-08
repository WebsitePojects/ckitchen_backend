-- ============================================================================
-- Migration 0024 — direct-receive Receiving Reports (gprci standard)
--
-- Client review 2026-07-08: "when main warehouse receives there is an RR…
-- fields are so incomplete". A DIRECT receipt (POST /inventory/receive, no
-- purchase order) must now produce a PROPER receiving_report + lines, exactly
-- like the PO-receive path, so the RR register is the single source of truth
-- for everything that entered MAIN.
--
--   1. receiving_report.po_id DROP NOT NULL  — NULL = a direct (PO-less) receipt.
--   2. receiving_report.supplier_id uuid NULL REFERENCES supplier(id) — who
--      delivered a direct receipt (PO receipts keep carrying it via the PO).
--   3. receiving_report.reference text NULL — the supplier's DR / invoice no.
--   4. receiving_report_line.po_line_id DROP NOT NULL — direct-receipt lines
--      have no purchase_order_line to point at.
--
-- Hand-written (snapshot chain hand-maintained since 0012). IDEMPOTENT: DROP
-- NOT NULL guarded by information_schema checks (0023 convention), ADD COLUMN
-- IF NOT EXISTS, FK via DO..EXCEPTION duplicate_object, CREATE INDEX IF NOT
-- EXISTS — matching the 0018-0023 convention. Journal `when` = 1784300000000 —
-- strictly greater than 0023's 1784200000000 so the incremental migrator does
-- not skip it.
-- ============================================================================

DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'receiving_report'
			AND column_name = 'po_id'
			AND is_nullable = 'NO'
	) THEN
		ALTER TABLE "receiving_report" ALTER COLUMN "po_id" DROP NOT NULL;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "receiving_report" ADD COLUMN IF NOT EXISTS "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "receiving_report" ADD COLUMN IF NOT EXISTS "reference" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "receiving_report" ADD CONSTRAINT "receiving_report_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rr_supplier_id_idx" ON "receiving_report" USING btree ("supplier_id");--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'receiving_report_line'
			AND column_name = 'po_line_id'
			AND is_nullable = 'NO'
	) THEN
		ALTER TABLE "receiving_report_line" ALTER COLUMN "po_line_id" DROP NOT NULL;
	END IF;
END $$;
