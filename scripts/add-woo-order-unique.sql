-- Run once in Supabase SQL editor.
--
-- Adds a UNIQUE constraint on sms_orders.woo_order_id so that concurrent webhook
-- requests for the same WooCommerce order can never insert duplicate rows.
-- The application uses upsert with ignoreDuplicates:true which requires this constraint.
--
-- If duplicate rows already exist, the first SELECT below will show them.
-- Remove duplicates with the DELETE before adding the constraint.

-- 1. Check for existing duplicates (should return 0 rows in a clean DB):
-- SELECT woo_order_id, COUNT(*) FROM sms_orders GROUP BY woo_order_id HAVING COUNT(*) > 1;

-- 2. Remove duplicate rows — keep the one with the lowest id (oldest insert):
DELETE FROM sms_orders
WHERE id NOT IN (
  SELECT MIN(id) FROM sms_orders GROUP BY woo_order_id
);

-- 3. Add the constraint:
ALTER TABLE sms_orders
  ADD CONSTRAINT sms_orders_woo_order_id_unique UNIQUE (woo_order_id);
