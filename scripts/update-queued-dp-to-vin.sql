-- Update all pending scheduled SMS messages: replace "DP" sign-off with "Vin"
-- Run this once in Supabase SQL editor to update messages already queued

UPDATE sms_scheduled
SET message_body = REPLACE(message_body, E'\nDP', E'\nVin')
WHERE status = 'pending'
  AND message_body LIKE E'%\nDP';

-- Verify the count before/after
SELECT COUNT(*) AS updated_rows
FROM sms_scheduled
WHERE status = 'pending'
  AND message_body LIKE E'%\nVin';
