-- Fix existing call_logs rows where contact_phone was stored without E.164 prefix.
-- Run this once in the Supabase SQL editor after deploying the phone normalisation fix.

-- Fix 10-digit US numbers missing the +1 prefix (e.g. "3055551234" -> "+13055551234")
UPDATE call_logs
SET contact_phone = '+1' || contact_phone
WHERE contact_phone ~ '^\d{10}$';

-- Fix 11-digit US numbers missing the + prefix (e.g. "13055551234" -> "+13055551234")
UPDATE call_logs
SET contact_phone = '+' || contact_phone
WHERE contact_phone ~ '^1\d{10}$';

-- Verify
SELECT DISTINCT contact_phone FROM call_logs ORDER BY contact_phone;
