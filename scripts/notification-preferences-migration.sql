-- Vici Inbox — per-account notification preferences. Additive schema.
--
-- WHY THIS TABLE EXISTS
--   Notification settings lived nowhere. The Settings screen could report what
--   iOS had granted and could offer to open iPhone Settings, and that was the
--   whole surface: there was no way to say "keep waking me for a customer
--   message but stop telling me a segment moved". A device-local switch would
--   have been the easy answer and the wrong one, because the two people using
--   this product replace and reinstall phones and a preference that lives in
--   UserDefaults is a preference that silently resets. It belongs to the
--   ACCOUNT, so it follows the person to the next device.
--
-- ONE ROW PER ACCOUNT, NOT ONE PER DEVICE
--   Deliberate. "Do not send me campaign proposals" is a statement about a
--   person, not about a handset, and per-device rows would make the answer to
--   "is this person opted in" depend on which of their phones you asked. The
--   iPad-versus-iPhone case does not exist here: this is an iPhone-only app and
--   both operators carry one device each.
--
-- DEFAULTS ARE ALL TRUE, AND THAT IS NOT A LOOPHOLE
--   Every category defaults to true so that applying this migration changes
--   nobody's experience: the alerts that already reach a phone keep reaching
--   it, and the ones that do not are still held shut by their own feature
--   flags in the application (DAILY_DIGEST_NOTIFICATIONS_ENABLED,
--   SEGMENT_CHANGE_NOTIFICATIONS_ENABLED, CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED).
--   A preference is a person saying "not this one". It is never permission to
--   send something that was not already permitted, and no code path reads a
--   default-true row as authorisation for anything.
--
--   The corollary matters more: an ABSENT row means "has expressed no
--   preference" and resolves to the same defaults. Nobody has to be seeded, and
--   an account created after this migration needs no insert.
--
-- WHAT EACH COLUMN ACTUALLY CONTROLS, IN CODE
--   new_customer_messages  lib/apns-notify.js sendNativeMessagePush()
--   missed_calls           whether unseen missed calls are counted into the
--                          Home Screen badge that the same push carries. It
--                          does NOT and CANNOT silence a ringing call: incoming
--                          calls arrive as a Telnyx VoIP push and are presented
--                          by CallKit, which is iOS's business and not ours.
--                          The Settings screen says exactly that rather than
--                          implying a switch it does not have.
--   daily_digest           the once-a-day summary push, and the per-segment
--                          change push, which are two deliveries of one piece
--                          of news. One subject, one toggle: two switches for
--                          one thing is how somebody ends up receiving what
--                          they turned off.
--   campaign_proposals     sendCampaignReadyNotifications()
--   new_releases           sendReleaseNotification()
--
-- SAFETY
--   * One CREATE TABLE IF NOT EXISTS. No existing table is altered, no existing
--     row is rewritten, nobody's access changes, and no permission key is
--     added, so this cannot cause the startup permission check in server.js to
--     fail and crash-loop the deploy.
--   * Transaction-wrapped and re-runnable.
--   * RLS is enabled with no policies, matching every other table added here.
--     Reads and writes go through the service role in the application, which
--     bypasses RLS; enabling it with nothing granted means a future anon key
--     cannot read somebody's preferences by accident.
--   * ON DELETE CASCADE on the account. Accounts are deactivated rather than
--     deleted in this product, so the cascade is a tidiness guarantee rather
--     than a live path.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS sms_user_notification_preferences;
--   Dropping it returns every account to the defaults above, which is the
--   pre-change behaviour. It cannot affect sign-in, permissions, messaging,
--   call handling or campaign delivery: the application treats a missing table
--   exactly as it treats a missing row for the three discretionary categories
--   and fails open for the two operational ones. See lib/notifications/preferences.js.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_user_notification_preferences (
  user_id               bigint PRIMARY KEY
                          REFERENCES sms_users (id) ON DELETE CASCADE,
  new_customer_messages boolean     NOT NULL DEFAULT true,
  missed_calls          boolean     NOT NULL DEFAULT true,
  daily_digest          boolean     NOT NULL DEFAULT true,
  campaign_proposals    boolean     NOT NULL DEFAULT true,
  new_releases          boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sms_user_notification_preferences IS
  'Per-ACCOUNT notification opt-outs, so the choice follows the person to a new '
  'device. An absent row means no preference expressed and resolves to the '
  'column defaults, all true. A true value is never permission to send: every '
  'category is additionally gated by its own feature flag in the application.';

COMMENT ON COLUMN sms_user_notification_preferences.missed_calls IS
  'Whether unseen missed calls count towards the Home Screen badge. It does not '
  'silence a ringing call: incoming calls arrive by Telnyx VoIP push and are '
  'presented by CallKit.';

COMMENT ON COLUMN sms_user_notification_preferences.daily_digest IS
  'The once-a-day summary push AND the per-segment change push. One subject, '
  'one toggle.';

-- Every write goes through the service role. Enabled with no policies so that
-- an anon or authenticated key can never read one person's preferences.
ALTER TABLE sms_user_notification_preferences ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
