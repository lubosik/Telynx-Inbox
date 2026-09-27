-- ADDITIVE / REPEATABLE / NO SEND
-- Installs editable future check-in copy. Existing queued recipients keep
-- their approved rendered_message, and null preserves the shipped defaults.
ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS checkin_message_templates jsonb;

COMMENT ON COLUMN public.sms_campaign_settings.checkin_message_templates IS
  'Validated four-variant template bank for future 21-day check-ins. Null uses reviewed defaults.';

NOTIFY pgrst, 'reload schema';

SELECT workspace_id, checkin_message_templates IS NOT NULL AS customised
FROM public.sms_campaign_settings WHERE workspace_id = 'vici';
