-- ============================================================================
-- Migration 0047 -- tenant_id on every workspace table (SaaS step 2+3 of 9, D52).
--
-- WHY: self-serve sign-up needs each business's rows walled off from every other's. The
-- wall (row-level security, step 7) keys on a tenant_id column ON THE ROW, so every table
-- that holds a business's data gets one. This step only ADDS the column: every existing
-- and new row belongs to workspace #1 (CloudKitchen) through the constant default, so
-- behaviour is unchanged. Step 9 switches the default to the request's workspace.
--
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is a catalogue-only change (no table rewrite).
-- One DO block = one round trip: the VPS is ~229 ms from the database, and ~280 separate
-- statements in the migration transaction would hold table locks for over a minute.
--
-- Not given a tenant_id:
--   tenant, user, user_session        platform identity (one person, many workspaces)
--   membership, tenant_settings,
--   workspace_join_link               already carry tenant_id (0045, 0046)
-- Nullable (pre-tenant inboxes: a partner call is stored before its listing is matched):
--   grab_partner_receipt, foodpanda_plugin_receipt, provider_event
--
-- The guard test test/workspace-tenancy.test.ts fails if a future table is added without
-- a tenant_id, so the wall cannot silently miss a table.
--
-- Reversible: ALTER TABLE <t> DROP COLUMN tenant_id; for each table below.
-- ============================================================================
DO $$
DECLARE
  workspace_one constant uuid := '00000000-0000-4000-8000-000000000001';
  t text;
BEGIN
  -- Workspace tables: tenant_id NOT NULL, every existing row -> workspace #1.
  FOREACH t IN ARRAY ARRAY[
    'aggregator_account', 'aggregator_command', 'alert_email', 'alert_event',
    'attendance_record', 'audit_log', 'bom_component', 'bom_header', 'bom_version', 'brand',
    'brand_activity_log', 'brand_outlet', 'business_module', 'channel_commercial_term',
    'consumption_log', 'customer', 'customer_order', 'customer_order_allocation',
    'customer_order_fulfillment', 'customer_order_line', 'data_import_job', 'data_import_row',
    'department_budget', 'department_inventory_access', 'discount',
    'discount_evidence_access_log', 'employee', 'foodpanda_listing_availability',
    'foodpanda_plugin_outbound_task', 'grab_listing_integration', 'grab_menu_sync_job',
    'ingredient', 'inventory_lot', 'inventory_lot_balance', 'inventory_lot_genealogy',
    'inventory_migration_exception', 'inventory_reconciliation_run', 'inventory_stock',
    'item_uom_conversion', 'ito', 'ito_item', 'job_order', 'job_order_component_allocation',
    'job_order_output_lot', 'kitchen_station', 'listing_migration_exception', 'location',
    'menu_item', 'menu_item_outlet', 'menu_option_group', 'menu_option_group_item',
    'operational_document', 'operational_feature_flag', 'order', 'order_discount',
    'order_dispute', 'order_item', 'outbox_event', 'outlet_manager_assignment', 'print_agent',
    'print_job', 'print_job_attempt', 'printer', 'purchase_order', 'purchase_order_line',
    'purchase_request', 'purchase_request_line', 'qa_release', 'qa_release_line',
    'receiving_report', 'receiving_report_line', 'recipe_line', 'role_page_access',
    'stock_adjustment', 'stock_ledger_entry', 'stock_posting', 'stock_posting_line',
    'stock_reservation', 'stock_return_batch', 'stock_return_batch_line',
    'stock_return_receipt_line', 'supplier', 'supplier_item', 'topology_migration_exception',
    'transfer_order', 'transfer_order_line', 'user_brand', 'user_outlet_access', 'warehouse'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT %L', t, workspace_one);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenant(id)', t, t || '_tenant_fk');
  END LOOP;

  -- Pre-tenant inboxes: nullable (set when the partner call is matched to a listing).
  FOREACH t IN ARRAY ARRAY['foodpanda_plugin_receipt', 'grab_partner_receipt', 'provider_event'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid DEFAULT %L', t, workspace_one);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenant(id)', t, t || '_tenant_fk');
  END LOOP;
END $$;
