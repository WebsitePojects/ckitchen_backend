-- ============================================================================
-- One-off: remove demo/simulator data before CloudKitchen starts real use (2026-10-27).
--
-- Run ONCE, against the NEW Paris database right after it is copied from Tokyo, so the old
-- Tokyo database stays untouched as the rollback. Never run it on a database that already
-- holds real orders: the guard below aborts if any order is newer than 2026-08-01.
--
-- Removes: every order (all are simulator/test, last one 2026-07-22) and what hangs off it;
--          all menu items, recipes, discounts, ingredients, stock, lots, adjustments, ITOs;
--          suppliers and purchasing documents; test employees and attendance; the test alert
--          email; the 6 INACTIVE demo brands with their demo listings.
-- Keeps:   the 9 active brands and their listings, users, memberships, workspace, stations,
--          warehouses, printers, role permissions, feature flags, audit history.
-- Hides:   outlets QC2 (Quezon City Outlet) and MTL (Matalino Street) -> INACTIVE.
--
-- All or nothing: one transaction. The two append-only ledgers (stock_ledger_entry,
-- attendance_record) have delete-blocking triggers; they are disabled for this transaction
-- only and re-enabled before COMMIT. Ends with self-checks that RAISE (rolling back) if
-- anything is left behind or a real brand was touched.
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM "order" WHERE placed_at > '2026-08-01') > 0 THEN
    RAISE EXCEPTION 'purge aborted: orders newer than 2026-08-01 exist (real data?)';
  END IF;
  IF (SELECT count(*) FROM brand WHERE is_active) <> 9 THEN
    RAISE EXCEPTION 'purge aborted: expected 9 active brands, found %', (SELECT count(*) FROM brand WHERE is_active);
  END IF;
END $$;

ALTER TABLE stock_ledger_entry DISABLE TRIGGER stock_ledger_append_only;
ALTER TABLE attendance_record DISABLE TRIGGER attendance_append_only;

-- Orders and everything that references them.
DELETE FROM print_job_attempt;
DELETE FROM print_job;
DELETE FROM order_discount;
DELETE FROM order_dispute;
DELETE FROM stock_reservation;
DELETE FROM consumption_log;
DELETE FROM order_item;
DELETE FROM aggregator_command;
DELETE FROM provider_event;
DELETE FROM grab_partner_receipt;
DELETE FROM foodpanda_plugin_receipt;
DELETE FROM "order";

-- Stock, purchasing and ingredients.
DELETE FROM stock_ledger_entry;
DELETE FROM stock_adjustment;
DELETE FROM inventory_lot_balance;
DELETE FROM inventory_lot;
DELETE FROM inventory_stock;
DELETE FROM ito_item;
DELETE FROM ito;
DELETE FROM receiving_report_line;
DELETE FROM receiving_report;
DELETE FROM purchase_order_line;
DELETE FROM purchase_order;
DELETE FROM purchase_request_line;
DELETE FROM purchase_request;
DELETE FROM supplier_item;
DELETE FROM supplier;
DELETE FROM inventory_migration_exception;
DELETE FROM department_budget;

-- Menu (discounts reference both brand and menu item).
DELETE FROM discount;
DELETE FROM recipe_line;
DELETE FROM menu_item_outlet;
DELETE FROM menu_item;
DELETE FROM ingredient;

-- Test employees and their attendance.
DELETE FROM attendance_record;
DELETE FROM employee;

-- Test alert email.
DELETE FROM alert_event;
DELETE FROM alert_email;

-- Demo brands (inactive) and their demo listings.
DELETE FROM listing_migration_exception
  WHERE aggregator_account_id IN (SELECT a.id FROM aggregator_account a JOIN brand b ON b.id = a.brand_id WHERE NOT b.is_active);
DELETE FROM brand_activity_log
  WHERE brand_id IN (SELECT id FROM brand WHERE NOT is_active)
     OR aggregator_account_id IN (SELECT a.id FROM aggregator_account a JOIN brand b ON b.id = a.brand_id WHERE NOT b.is_active);
DELETE FROM aggregator_account WHERE brand_id IN (SELECT id FROM brand WHERE NOT is_active);
DELETE FROM user_brand WHERE brand_id IN (SELECT id FROM brand WHERE NOT is_active);
DELETE FROM brand WHERE NOT is_active;   -- brand_outlet rows cascade

-- Test outlets: hidden, not deleted (warehouses and stations stay attached).
UPDATE location SET status = 'INACTIVE' WHERE code IN ('QC2', 'MTL');

ALTER TABLE stock_ledger_entry ENABLE TRIGGER stock_ledger_append_only;
ALTER TABLE attendance_record ENABLE TRIGGER attendance_append_only;

-- Self-checks: anything wrong rolls the whole purge back.
DO $$
DECLARE leftovers int;
BEGIN
  SELECT (SELECT count(*) FROM "order") + (SELECT count(*) FROM menu_item) + (SELECT count(*) FROM ingredient)
       + (SELECT count(*) FROM stock_ledger_entry) + (SELECT count(*) FROM employee) + (SELECT count(*) FROM supplier)
    INTO leftovers;
  IF leftovers <> 0 THEN RAISE EXCEPTION 'purge check failed: % demo rows left', leftovers; END IF;
  IF (SELECT count(*) FROM brand) <> 9 OR (SELECT count(*) FROM brand WHERE NOT is_active) <> 0 THEN
    RAISE EXCEPTION 'purge check failed: brands are not exactly the 9 active ones';
  END IF;
  IF (SELECT count(*) FROM aggregator_account a JOIN brand b ON b.id = a.brand_id) <> (SELECT count(*) FROM aggregator_account) THEN
    RAISE EXCEPTION 'purge check failed: listing without a brand';
  END IF;
  IF (SELECT count(*) FROM location WHERE status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'purge check failed: expected only CloudKitchen ONE active';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('stock_ledger_append_only', 'attendance_append_only') AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'purge check failed: append-only triggers not re-enabled';
  END IF;
END $$;

COMMIT;
