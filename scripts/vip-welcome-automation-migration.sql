-- Vici Inbox — one-time VIP welcome automation.
--
-- ADDITIVE / REPEATABLE / NO SEND
-- Applying this file does not enable the automation. It adds the explicit,
-- revocable standing-authorisation flag and the owner-editable message body.

ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS vip_welcome_automation_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS vip_welcome_message_template text;

COMMENT ON COLUMN public.sms_campaign_settings.vip_welcome_automation_enabled IS
  'Standing authorisation for the one-time VIP welcome automation. Off by default.';

COMMENT ON COLUMN public.sms_campaign_settings.vip_welcome_message_template IS
  'Validated VIP welcome template. Null uses the versioned server default.';

SELECT workspace_id, vip_welcome_automation_enabled,
       vip_welcome_message_template, business_timezone
FROM public.sms_campaign_settings
WHERE workspace_id = 'vici';

NOTIFY pgrst, 'reload schema';
