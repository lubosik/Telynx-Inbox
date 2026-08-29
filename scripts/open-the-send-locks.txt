-- ============================================================================
-- OPENING THE SEND LOCKS: THE DATABASE HALF
--
-- Paste this whole file into the Supabase SQL editor. Every line is SQL or a
-- SQL comment, so there is nothing to trim.
--
-- This is steps 1 and 2 of three. Step 3 is a Railway environment variable and
-- cannot be done from here; see OPEN-THE-SEND-LOCKS.md, which is a document to
-- read rather than a file to paste.
--
-- BEFORE YOU RUN IT: provider_approved is not a feature switch. It is a claim,
-- recorded with your user id against it, that Telnyx has approved this
-- business to send this kind of message on a registered 10DLC campaign. Put
-- the real campaign ID in the reference below. Setting it true without that
-- approval does not make the messages arrive: carriers filter unregistered
-- traffic at the network, and the database then holds a signed statement that
-- is not true.
-- ============================================================================

BEGIN;

UPDATE sms_campaign_settings
   SET provider_approved           = true,
       -- Replace this with the real Telnyx 10DLC campaign ID before running.
       provider_approval_reference = 'PUT-YOUR-TELNYX-10DLC-CAMPAIGN-ID-HERE',
       provider_approved_at        = now(),
       provider_approved_by        = 4,
       live_send_enabled           = true,
       updated_at                  = now()
 WHERE workspace_id = 'vici';

-- Both true, and the reference is not still the placeholder. If either is
-- false, or the reference still says PUT-YOUR, ROLLBACK and fix it.
SELECT provider_approved,
       live_send_enabled,
       provider_approval_reference,
       provider_approved_at
  FROM sms_campaign_settings
 WHERE workspace_id = 'vici';

COMMIT;


-- ── Turning it off again ───────────────────────────────────────────────────
-- Either half alone is enough to stop sending. The Railway variable is faster
-- and needs no database access, so prefer that in a hurry.
--
-- UPDATE sms_campaign_settings
--    SET live_send_enabled = false, updated_at = now()
--  WHERE workspace_id = 'vici';
