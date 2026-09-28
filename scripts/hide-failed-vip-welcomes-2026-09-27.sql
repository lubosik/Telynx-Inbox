-- Owner-requested cleanup of the THREE verified failed VIP batches.
-- Run AFTER failed-message-cleanup-migration.sql. Read-only verification found
-- 102 failed outbound messages and 1 delivered message. Only failures are hidden.
-- Message bodies, IDs, delivery evidence and campaign records remain intact.
-- Reversible: clearing hidden_at on these exact rows makes them visible again.
BEGIN;
UPDATE public.sms_messages SET hidden_at = now()
WHERE campaign_id IN (
  '0b2f6970-4a82-4138-9865-ec89a960fa2d',
  'd1066ccb-b496-46bf-819d-c4614a77fab2',
  '5c4550d6-da4a-4218-93fd-ebd04ee32ee0'
)
AND direction = 'outbound'
AND lower(coalesce(status,'')) IN ('failed','sending_failed','delivery_failed')
AND hidden_at IS NULL;
COMMIT;
