-- Main/VIP inbox line provenance, additive and repeatable.
-- Owner execution required. Does not send, schedule, change consent, or backfill.
-- Legacy NULL means the historic sending/receiving business line is unknown.
BEGIN;
ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS business_phone text;
COMMENT ON COLUMN public.sms_messages.business_phone IS
  'Actual normalized business line: outbound sender or inbound recipient. NULL for unknown legacy provenance. Not current VIP membership.';
NOTIFY pgrst, 'reload schema';
COMMIT;
