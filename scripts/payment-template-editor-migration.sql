-- ADDITIVE / REPEATABLE / NO SEND
-- Null preserves the existing approved payment reminder builders. Edits in
-- the app affect only reminders created after saving, never queued messages.
ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS payment_reminder_templates jsonb;

COMMENT ON COLUMN public.sms_campaign_settings.payment_reminder_templates IS
  'Validated six-flow payment reminder template bank. Null uses existing builder copy.';

NOTIFY pgrst, 'reload schema';

SELECT workspace_id, payment_reminder_templates IS NOT NULL AS customised
FROM public.sms_campaign_settings WHERE workspace_id = 'vici';
