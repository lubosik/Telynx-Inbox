-- ═══════════════════════════════════════════════════════════════════════════
-- The standing authorisation for the 21-day check-in.
--
-- The check-in used to be a recipe somebody pressed a button on. The owner
-- asked for it to run like the order and payment-reminder messages: nobody
-- presses anything.
--
-- Removing the human from a promotional path means the authorisation has to
-- live somewhere explicit, revocable, and visible in the app. That is this
-- column. It is the ONLY thing standing between the sweep and a send, on our
-- side of the SQL claim function, and lib/campaigns/check-in-automation.js
-- reads it on every run rather than caching it.
--
-- DEFAULT FALSE, deliberately. A migration that silently switches on an
-- automation which messages customers is the wrong default even when the
-- owner has asked for the feature, because the moment it starts should be a
-- moment somebody chose.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sms_campaign_settings
  ADD COLUMN IF NOT EXISTS checkin_automation_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sms_campaign_settings.checkin_automation_enabled IS
  'Standing authorisation for the automatic 21-day post-purchase check-in. '
  'When true, a weekly sweep builds, approves and schedules the check-in with '
  'no human step; approval audit rows are written against the SYSTEM actor '
  'because that is who approved them. Turning it off stops the next sweep and '
  'does not recall an already-scheduled campaign.';

-- Verification.
SELECT
  workspace_id,
  checkin_automation_enabled,
  business_timezone,
  quiet_hours_start,
  quiet_hours_end
FROM sms_campaign_settings
WHERE workspace_id = 'vici';
