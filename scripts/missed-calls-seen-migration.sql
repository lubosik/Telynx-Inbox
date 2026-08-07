-- Missed-call badge support.
--
-- Run this once in the Supabase SQL editor. Until it is applied the app still
-- works: the iPhone falls back to a device-local record of which missed calls
-- have been looked at, and the server simply reports zero missed calls when it
-- computes the Home Screen badge for a message push.
--
-- `seen_at` marks an inbound missed call as looked at. It is deliberately
-- shared rather than per-device, matching how sms_contacts.unread_count already
-- behaves for messages in this shared business inbox.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS seen_at timestamptz;

-- The badge count runs on every outbound message push, so keep it cheap. The
-- partial predicate matches the count query exactly.
CREATE INDEX IF NOT EXISTS call_logs_unseen_missed_idx
  ON call_logs (started_at DESC)
  WHERE seen_at IS NULL AND direction = 'inbound' AND status = 'missed';

-- Calls that already happened are history, not a notification backlog. Without
-- this, applying the migration would light up the badge with every missed call
-- ever recorded.
UPDATE call_logs
   SET seen_at = now()
 WHERE seen_at IS NULL
   AND direction = 'inbound'
   AND status = 'missed';
