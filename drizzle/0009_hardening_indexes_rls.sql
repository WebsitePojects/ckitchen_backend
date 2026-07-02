ALTER TABLE "aggregator_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consumption_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "department_inventory_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingredient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_stock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ito_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ito" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kitchen_station" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "print_agent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "print_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "printer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_request_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receiving_report_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receiving_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipe_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_brand" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "warehouse" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "aggregator_account_brand_id_idx" ON "aggregator_account" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "attendance_employee_captured_idx" ON "attendance_record" USING btree ("employee_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_captured_at_idx" ON "attendance_record" USING btree ("captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_recorded_by_idx" ON "attendance_record" USING btree ("recorded_by_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "brand_location_id_idx" ON "brand" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "consumption_log_ingredient_idx" ON "consumption_log" USING btree ("ingredient_id","log_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "consumption_log_order_id_idx" ON "consumption_log" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "employee_user_id_idx" ON "employee" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inventory_stock_ingredient_idx" ON "inventory_stock" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "ito_item_ito_id_idx" ON "ito_item" USING btree ("ito_id");--> statement-breakpoint
CREATE INDEX "ito_item_ingredient_id_idx" ON "ito_item" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "ito_from_warehouse_idx" ON "ito" USING btree ("from_warehouse_id");--> statement-breakpoint
CREATE INDEX "ito_to_warehouse_idx" ON "ito" USING btree ("to_warehouse_id");--> statement-breakpoint
CREATE INDEX "ito_status_idx" ON "ito" USING btree ("status");--> statement-breakpoint
CREATE INDEX "kitchen_station_location_id_idx" ON "kitchen_station" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "kitchen_station_printer_id_idx" ON "kitchen_station" USING btree ("default_printer_id");--> statement-breakpoint
CREATE INDEX "menu_item_brand_id_idx" ON "menu_item" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "menu_item_station_id_idx" ON "menu_item" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "order_item_order_id_idx" ON "order_item" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_item_menu_item_id_idx" ON "order_item" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "order_item_station_id_idx" ON "order_item" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "order_status_placed_at_idx" ON "order" USING btree ("status","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_brand_placed_at_idx" ON "order" USING btree ("brand_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_aggregator_account_id_idx" ON "order" USING btree ("aggregator_account_id");--> statement-breakpoint
CREATE INDEX "print_agent_location_id_idx" ON "print_agent" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "print_job_pending_created_at_idx" ON "print_job" USING btree ("created_at") WHERE "print_job"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "print_job_status_idx" ON "print_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "print_job_order_id_idx" ON "print_job" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "print_job_station_id_idx" ON "print_job" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "print_job_printer_id_idx" ON "print_job" USING btree ("printer_id");--> statement-breakpoint
CREATE INDEX "po_line_po_id_idx" ON "purchase_order_line" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "po_line_ingredient_idx" ON "purchase_order_line" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "po_supplier_id_idx" ON "purchase_order" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "po_pr_id_idx" ON "purchase_order" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "po_status_idx" ON "purchase_order" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pr_line_pr_id_idx" ON "purchase_request_line" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "pr_line_ingredient_idx" ON "purchase_request_line" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "pr_status_idx" ON "purchase_request" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rr_line_rr_id_idx" ON "receiving_report_line" USING btree ("rr_id");--> statement-breakpoint
CREATE INDEX "rr_line_po_line_id_idx" ON "receiving_report_line" USING btree ("po_line_id");--> statement-breakpoint
CREATE INDEX "rr_line_ingredient_idx" ON "receiving_report_line" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "rr_po_id_idx" ON "receiving_report" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "rr_warehouse_id_idx" ON "receiving_report" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "recipe_line_menu_item_id_idx" ON "recipe_line" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "recipe_line_ingredient_id_idx" ON "recipe_line" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_ing_wh_posted_idx" ON "stock_ledger_entry" USING btree ("ingredient_id","warehouse_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_ledger_wh_posted_idx" ON "stock_ledger_entry" USING btree ("warehouse_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_ledger_encoder_idx" ON "stock_ledger_entry" USING btree ("encoder_user_id");--> statement-breakpoint
CREATE INDEX "supplier_item_ingredient_idx" ON "supplier_item" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "user_brand_brand_id_idx" ON "user_brand" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "user_session_user_id_idx" ON "user_session" USING btree ("user_id");--> statement-breakpoint
-- ============================================================================
-- Hand-written additions below (drizzle-kit has no builder for triggers or
-- NULLS NOT DISTINCT unique indexes in this drizzle-orm/drizzle-kit version;
-- pattern follows 0001/0003, which are also hand-written/hand-augmented).
-- Audit report: audit-db.md §8 (append-only triggers) and §2c-1 (idempotency
-- NULL hole fix). Verified against local PGlite (@electric-sql/pglite 0.5.3):
-- ENABLE ROW LEVEL SECURITY, PL/pgSQL BEFORE UPDATE/DELETE triggers, and
-- UNIQUE ... NULLS NOT DISTINCT all work there, so no PGlite-specific guard
-- is required for this migration to apply cleanly in tests/dev.
-- ============================================================================

-- ── Append-only enforcement (business-rules.md #7: "No KOT silently lost" /
-- cardinal rule that audit_log, attendance_record, and stock_ledger_entry are
-- history — no UPDATE/DELETE, ever. Compensating entries must be NEW rows,
-- e.g. cancel-after-PREPARING restock posts a RESTOCK ledger row.) ─────────
--
-- DEVIATION FROM AUDIT REPORT: the report (§8) lists consumption_log as a
-- 4th append-only table, but src/modules/orders/service.ts:cancelOrder
-- (~line 719-721) DELETEs consumption_log rows for an order as its
-- documented double-cancel guard ("Delete the consumption log rows for this
-- order AFTER restocking. This is the double-cancel guard: if cancelOrder is
-- called again, logRows will be empty and no restock will happen."). A
-- consumption_log_append_only trigger here made that DELETE fail with
-- "consumption_log is append-only: DELETE not allowed", turning every
-- cancel-after-PREPARING call into a 500 — confirmed by running the existing
-- test/deduction.test.ts suite locally (7 failures, all cancel-path, all
-- gone once this trigger was dropped). Since this is a DB-only migration
-- (no service-code changes permitted) and the DELETE is required, correct,
-- existing behavior — not a bug — consumption_log is EXCLUDED from the
-- append-only trigger set. It still gets RLS (above) and its 2 new indexes.
-- Flagged to owner: if consumption_log should become truly append-only,
-- cancelOrder's double-cancel guard needs to change to a status/flag column
-- (e.g. consumption_log.reversed_at) instead of DELETE — a coordinated
-- service-code change, out of scope here.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

CREATE TRIGGER attendance_append_only
  BEFORE UPDATE OR DELETE ON "attendance_record"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

CREATE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON "stock_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- ── Idempotency-key NULL hole fix (audit-db.md §2c-1): PG15 `NULLS NOT
-- DISTINCT` (Postgres 15+ only — Supabase target is PG15, and this is
-- confirmed working under local PGlite 0.5.3 too). Without this, two ledger
-- postings that both have source_line_no IS NULL are NOT considered
-- duplicates by a plain UNIQUE index (standard SQL: NULL <> NULL), so they
-- both insert -> duplicate ledger entries -> wrong stock. This closes that
-- hole. Scoped narrowly per user instruction (only this one idempotency fix
-- ships in 0009); the broader listing-scoped order idempotency change
-- (order_aggregator_external_ref_unique -> order_listing_external_ref_unique)
-- is explicitly OUT of scope here — it needs a coordinated service-code
-- change in orders/service.ts and ships in its own migration later. ───────
DROP INDEX "stock_ledger_source_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ledger_source_unique"
  ON "stock_ledger_entry" USING btree ("source_module","source_document_no","source_line_no")
  NULLS NOT DISTINCT;--> statement-breakpoint

-- ── CHECK constraints (audit-db.md §2a). Added NOT VALID then VALIDATE in
-- the same migration so existing rows are checked without holding a long
-- ACCESS EXCLUSIVE lock during the initial ADD (NOT VALID skips the scan;
-- VALIDATE CONSTRAINT then does a lighter SHARE UPDATE EXCLUSIVE scan).
-- No drizzle-orm mirror: this project's installed drizzle-orm (0.45.2) has
-- `check()` in pg-core, but the existing schema.ts convention (see
-- stock_ledger_source_unique, drizzle/0003) is to hand-write structural SQL
-- that isn't expressible as a clean 1:1 table-builder diff and leave
-- schema.ts to describe columns/indexes/RLS only. Kept consistent with that
-- here rather than mixing partial check() mirroring into 34 table defs.
--
-- SKIPPED per audit report's own exception clause: inventory_stock_qty_nonneg
-- CHECK (quantity >= 0). Verified against src/modules/orders/service.ts
-- (advanceOrder, "FIX D" comment block, ~line 514-520): the PREPARING
-- deduction deliberately allows inventory_stock.quantity to go negative
-- ("prototype allows oversell; production should decide INSUFFICIENT_STOCK
-- block vs allow+flag"). Adding this CHECK today would make that existing,
-- intentional code path start throwing constraint-violation errors on every
-- oversell — a behavior change this DB-only migration is not allowed to make
-- (no service-code changes in scope). Flagged to owner; add the CHECK only
-- after ledger.ts/orders/service.ts is updated to reject/flag below-zero
-- deductions inside the transaction. ───────────────────────────────────────

ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_qty_positive" CHECK ("quantity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" VALIDATE CONSTRAINT "stock_ledger_qty_positive";--> statement-breakpoint

ALTER TABLE "stock_ledger_entry" ADD CONSTRAINT "stock_ledger_cost_nonneg" CHECK ("unit_cost" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_ledger_entry" VALIDATE CONSTRAINT "stock_ledger_cost_nonneg";--> statement-breakpoint

ALTER TABLE "ito_item" ADD CONSTRAINT "ito_item_qty_positive" CHECK ("quantity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ito_item" VALIDATE CONSTRAINT "ito_item_qty_positive";--> statement-breakpoint

ALTER TABLE "ito" ADD CONSTRAINT "ito_distinct_warehouses" CHECK ("from_warehouse_id" <> "to_warehouse_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "ito" VALIDATE CONSTRAINT "ito_distinct_warehouses";--> statement-breakpoint

ALTER TABLE "consumption_log" ADD CONSTRAINT "consumption_qty_positive" CHECK ("quantity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "consumption_log" VALIDATE CONSTRAINT "consumption_qty_positive";--> statement-breakpoint

ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_cost_nonneg" CHECK ("unit_cost" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ingredient" VALIDATE CONSTRAINT "ingredient_cost_nonneg";--> statement-breakpoint

ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_threshold_nonneg" CHECK ("low_stock_threshold" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ingredient" VALIDATE CONSTRAINT "ingredient_threshold_nonneg";--> statement-breakpoint

ALTER TABLE "recipe_line" ADD CONSTRAINT "recipe_line_portion_positive" CHECK ("portion_qty" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "recipe_line" VALIDATE CONSTRAINT "recipe_line_portion_positive";--> statement-breakpoint

ALTER TABLE "order" ADD CONSTRAINT "order_total_nonneg" CHECK ("total" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "order" VALIDATE CONSTRAINT "order_total_nonneg";--> statement-breakpoint

ALTER TABLE "order_item" ADD CONSTRAINT "order_item_qty_positive" CHECK ("qty" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "order_item" VALIDATE CONSTRAINT "order_item_qty_positive";--> statement-breakpoint

ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_price_nonneg" CHECK ("price" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "menu_item" VALIDATE CONSTRAINT "menu_item_price_nonneg";--> statement-breakpoint

ALTER TABLE "print_job" ADD CONSTRAINT "print_job_retries_nonneg" CHECK ("retries" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "print_job" VALIDATE CONSTRAINT "print_job_retries_nonneg";--> statement-breakpoint

ALTER TABLE "purchase_request_line" ADD CONSTRAINT "pr_line_qty_positive" CHECK ("quantity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_request_line" VALIDATE CONSTRAINT "pr_line_qty_positive";--> statement-breakpoint

ALTER TABLE "purchase_request_line" ADD CONSTRAINT "pr_line_cost_nonneg" CHECK ("est_unit_cost" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_request_line" VALIDATE CONSTRAINT "pr_line_cost_nonneg";--> statement-breakpoint

ALTER TABLE "purchase_order_line" ADD CONSTRAINT "po_line_qty_positive" CHECK ("quantity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_line" VALIDATE CONSTRAINT "po_line_qty_positive";--> statement-breakpoint

ALTER TABLE "purchase_order_line" ADD CONSTRAINT "po_line_cost_nonneg" CHECK ("unit_cost" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_line" VALIDATE CONSTRAINT "po_line_cost_nonneg";--> statement-breakpoint

ALTER TABLE "purchase_order_line" ADD CONSTRAINT "po_line_recv_range" CHECK ("qty_received" >= 0 AND "qty_received" <= "quantity") NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_order_line" VALIDATE CONSTRAINT "po_line_recv_range";--> statement-breakpoint

ALTER TABLE "receiving_report_line" ADD CONSTRAINT "rr_line_qty_positive" CHECK ("qty_received" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "receiving_report_line" VALIDATE CONSTRAINT "rr_line_qty_positive";--> statement-breakpoint

ALTER TABLE "supplier" ADD CONSTRAINT "supplier_terms_nonneg" CHECK ("payment_term_days" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "supplier" VALIDATE CONSTRAINT "supplier_terms_nonneg";--> statement-breakpoint

ALTER TABLE "customer" ADD CONSTRAINT "customer_terms_nonneg" CHECK ("payment_term_days" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer" VALIDATE CONSTRAINT "customer_terms_nonneg";--> statement-breakpoint

ALTER TABLE "supplier_item" ADD CONSTRAINT "supplier_item_cost_nonneg" CHECK ("last_unit_cost" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "supplier_item" VALIDATE CONSTRAINT "supplier_item_cost_nonneg";