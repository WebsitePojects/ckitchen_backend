-- ============================================================================
-- Migration 0048 -- business numbers and codes unique PER WORKSPACE (SaaS step 4, D52).
--
-- WHY: two businesses both start their purchase orders at PO-0001, both have an employee
-- EMP-001, both seed the same role -> page matrix and both have one HQ main warehouse.
-- Each rule below was unique across the whole database, which would refuse the second
-- business's first PO. Each now leads with tenant_id; same name, same partial WHERE.
--
-- Deliberately still GLOBAL (one store belongs to exactly one business, and these are
-- the keys partners and our own idempotency use): aggregator_account external id, Grab
-- partner_merchant_id, order (listing, external_ref), order_code, partner dedupe keys,
-- aggregator_command idempotency_key, print_agent token_hash, provider_event ids. Keys
-- that contain a parent row's uuid (e.g. (warehouse_id, ingredient_id)) already imply the
-- workspace and are unchanged.
--
-- business_module's primary key (key) becomes (tenant_id, key): each workspace switches
-- its own modules on and off.
--
-- One DO block (one round trip, ~229 ms away) inside the migration transaction: each old
-- rule is dropped and its replacement created together.
-- Reversible: recreate each index/constraint without tenant_id (definitions in 0047's
-- predecessors), and business_module PRIMARY KEY (key).
-- ============================================================================
DO $$
BEGIN
  DROP INDEX "bom_header_code_unique";
  CREATE UNIQUE INDEX "bom_header_code_unique" ON "bom_header" ("tenant_id", code);
  ALTER TABLE "customer" DROP CONSTRAINT "customer_code_unique";
  ALTER TABLE "customer" ADD CONSTRAINT "customer_code_unique" UNIQUE ("tenant_id", code);
  DROP INDEX "customer_order_document_no_unique";
  CREATE UNIQUE INDEX "customer_order_document_no_unique" ON "customer_order" ("tenant_id", document_no);
  DROP INDEX "data_import_job_type_hash_unique";
  CREATE UNIQUE INDEX "data_import_job_type_hash_unique" ON "data_import_job" ("tenant_id", import_type, source_file_hash);
  DROP INDEX "department_budget_dept_period_unique";
  CREATE UNIQUE INDEX "department_budget_dept_period_unique" ON "department_budget" ("tenant_id", department, period_month);
  DROP INDEX "department_inventory_access_unique";
  CREATE UNIQUE INDEX "department_inventory_access_unique" ON "department_inventory_access" ("tenant_id", department, warehouse_type);
  ALTER TABLE "employee" DROP CONSTRAINT "employee_employee_no_unique";
  ALTER TABLE "employee" ADD CONSTRAINT "employee_employee_no_unique" UNIQUE ("tenant_id", employee_no);
  DROP INDEX "ingredient_code_unique";
  CREATE UNIQUE INDEX "ingredient_code_unique" ON "ingredient" ("tenant_id", code) WHERE (code IS NOT NULL);
  DROP INDEX "job_order_no_unique";
  CREATE UNIQUE INDEX "job_order_no_unique" ON "job_order" ("tenant_id", job_order_no);
  DROP INDEX "location_code_unique";
  CREATE UNIQUE INDEX "location_code_unique" ON "location" ("tenant_id", code);
  DROP INDEX "operational_document_module_no_unique";
  CREATE UNIQUE INDEX "operational_document_module_no_unique" ON "operational_document" ("tenant_id", module, document_no);
  DROP INDEX "operational_feature_flag_key_unique";
  CREATE UNIQUE INDEX "operational_feature_flag_key_unique" ON "operational_feature_flag" ("tenant_id", key);
  ALTER TABLE "purchase_order" DROP CONSTRAINT "purchase_order_po_no_unique";
  ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_po_no_unique" UNIQUE ("tenant_id", po_no);
  ALTER TABLE "purchase_request" DROP CONSTRAINT "purchase_request_pr_no_unique";
  ALTER TABLE "purchase_request" ADD CONSTRAINT "purchase_request_pr_no_unique" UNIQUE ("tenant_id", pr_no);
  DROP INDEX "qa_release_document_no_unique";
  CREATE UNIQUE INDEX "qa_release_document_no_unique" ON "qa_release" ("tenant_id", document_no);
  ALTER TABLE "receiving_report" DROP CONSTRAINT "receiving_report_rr_no_unique";
  ALTER TABLE "receiving_report" ADD CONSTRAINT "receiving_report_rr_no_unique" UNIQUE ("tenant_id", rr_no);
  DROP INDEX "role_page_access_role_page_unique";
  CREATE UNIQUE INDEX "role_page_access_role_page_unique" ON "role_page_access" ("tenant_id", role, page_key);
  DROP INDEX "stock_ledger_source_unique";
  CREATE UNIQUE INDEX "stock_ledger_source_unique" ON "stock_ledger_entry" ("tenant_id", source_module, source_document_no, source_line_no) NULLS NOT DISTINCT;
  DROP INDEX "stock_posting_idempotency_key_unique";
  CREATE UNIQUE INDEX "stock_posting_idempotency_key_unique" ON "stock_posting" ("tenant_id", idempotency_key);
  DROP INDEX "stock_return_batch_document_no_unique";
  CREATE UNIQUE INDEX "stock_return_batch_document_no_unique" ON "stock_return_batch" ("tenant_id", document_no);
  ALTER TABLE "supplier" DROP CONSTRAINT "supplier_code_unique";
  ALTER TABLE "supplier" ADD CONSTRAINT "supplier_code_unique" UNIQUE ("tenant_id", code);
  DROP INDEX "topology_migration_exception_code_unique";
  CREATE UNIQUE INDEX "topology_migration_exception_code_unique" ON "topology_migration_exception" ("tenant_id", code);
  DROP INDEX "transfer_order_document_no_unique";
  CREATE UNIQUE INDEX "transfer_order_document_no_unique" ON "transfer_order" ("tenant_id", document_no);
  DROP INDEX "warehouse_code_unique";
  CREATE UNIQUE INDEX "warehouse_code_unique" ON "warehouse" ("tenant_id", code) WHERE (code IS NOT NULL);
  DROP INDEX "warehouse_single_hq_main_unique";
  CREATE UNIQUE INDEX "warehouse_single_hq_main_unique" ON "warehouse" ("tenant_id") WHERE ((purpose = 'HQ_MAIN'::warehouse_purpose) AND (is_active = true));
  ALTER TABLE "business_module" DROP CONSTRAINT "business_module_pkey";
  ALTER TABLE "business_module" ADD CONSTRAINT "business_module_pkey" PRIMARY KEY ("tenant_id", "key");
END $$;
