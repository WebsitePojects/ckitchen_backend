-- ============================================================================
-- Migration 0053 -- one purchase request / purchase order per user intent.
--
-- WHY: POST /purchase-requests and POST /purchase-orders had no duplicate guard. On a slow
-- connection a second press of "Create" made a second PR or PO with the same lines, which
-- then double-counted against the department budget and could be sent to the supplier twice.
-- The screen now sends a client_request_id generated once per intent; a repeat of the same
-- id returns the document the first request created.
--
-- Nullable: older clients that send no id keep working exactly as before. The partial
-- unique index is per workspace (tenant_id), like every scoped unique since 0048.
--
-- Reversible: DROP INDEX "purchase_request_client_request_unique";
--             DROP INDEX "purchase_order_client_request_unique";
--             ALTER TABLE "purchase_request" DROP COLUMN "client_request_id";
--             ALTER TABLE "purchase_order" DROP COLUMN "client_request_id";
-- ============================================================================
ALTER TABLE "purchase_request" ADD COLUMN IF NOT EXISTS "client_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN IF NOT EXISTS "client_request_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_request_client_request_unique" ON "purchase_request" ("tenant_id", "client_request_id") WHERE "client_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_client_request_unique" ON "purchase_order" ("tenant_id", "client_request_id") WHERE "client_request_id" IS NOT NULL;
