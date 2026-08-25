-- ============================================================================
-- scripts/consent-backfill-sms-contacts.sql
--
-- The 38 the first backfill deliberately left alone.
--
-- RUN scripts/consent-backfill.sql FIRST. That one covers the 903 people who
-- registered an account. This one is the remainder: 37 contacts whose source is
-- 'sms', plus one added by hand, none of whom has a WooCommerce account.
--
-- WHY THEY WERE HELD BACK, AND WHY THAT WAS RIGHT
--   The first file's basis is "they consented when they created an account".
--   These people never created one, so writing them the same row would have
--   claimed something specific and untrue. Held back is recoverable. A consent
--   table full of invented events is not.
--
-- WHAT THIS ONE RESTS ON INSTEAD
--   They came to us: they are SMS contacts of this business, and the account
--   owner confirms they consented to receive messages. That is a different
--   basis from account registration and it is recorded as a different one, so
--   the two are never confused later.
--
-- AND IT DOES NOT PRETEND TO MORE THAN IT HAS
--   Only 8 of the 37 have an inbound message on record in sms_messages. For
--   those, the evidence names the date they texted in, which is checkable. For
--   the rest, it says plainly that it rests on the owner's confirmation. One
--   blanket sentence over both would have described 29 people with an event
--   that is not in the database.
--
-- THE MESSAGE THEY GET SHOULD EARN THE OPT IN
--   Every campaign message already ends with the exact string "Reply STOP to
--   opt out." That is not negotiable: carriers look for it, and the validator
--   refuses any message without it. Warmth goes BEFORE it, not instead of it.
--   These all pass the validator today:
--
--     Vici: good to have you in the community. Reply STOP to opt out.
--     Vici here. Updates from the Vici community, now and then. Reply STOP to opt out.
--     Vici: we will send the occasional update. Nothing noisy. Reply STOP to opt out.
--
--   Anyone who replies STOP is added to the do-not-contact list automatically
--   and stops being messaged, without anybody doing anything.
--
-- SAFE TO RUN TWICE. Same exclusions as the first file, same dedupe key shape.
-- ============================================================================

BEGIN;

INSERT INTO sms_consent_events (
  workspace_id, contact_phone, event_type, purpose, brand_id,
  source, evidence_ref, occurred_at, dedupe_key, metadata
)
SELECT
  'vici',
  c.phone,
  'opt_in',
  'promotional_sms',
  'vici',
  'sms_contact_owner_confirmed',
  -- Two different sentences, because these are two different pieces of
  -- evidence and only one of them can be checked against a table.
  CASE
    WHEN inbound.first_at IS NOT NULL
      THEN 'Texted this business on ' || to_char(inbound.first_at, 'YYYY-MM-DD')
           || '; consent to receive messages confirmed by the account owner'
    ELSE 'SMS contact of this business (source: ' || coalesce(c.source, 'unknown')
           || '); consent to receive messages confirmed by the account owner,'
           || ' no inbound message on record'
  END,
  -- Earliest defensible moment: when they first texted, else when the contact
  -- was created. Never now(), so this can never outrank a later opt-out.
  coalesce(inbound.first_at, c.created_at, c.first_seen, now()),
  'smscontact:' || c.phone,
  jsonb_build_object(
    'backfill', 'consent-backfill-sms-contacts.sql',
    'basis', 'sms_contact_owner_confirmed',
    'has_inbound_message', inbound.first_at IS NOT NULL
  )
FROM sms_contacts c
LEFT JOIN LATERAL (
  SELECT min(m.created_at) AS first_at
    FROM sms_messages m
   WHERE m.contact_phone = c.phone
     AND m.direction = 'inbound'
) inbound ON true
WHERE
  -- The remainder, by definition: the first file took everyone with an account.
  c.woo_customer_id IS NULL
  AND c.phone ~ '^\+[1-9][0-9]{7,14}$'
  -- The same four exclusions. Nothing here is looser than the first file.
  AND coalesce(c.opted_out, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM sms_consent_events e
    WHERE e.workspace_id = 'vici' AND e.contact_phone = c.phone
      AND e.event_type = 'opt_out'
  )
  AND NOT EXISTS (
    SELECT 1 FROM sms_sent_log s
    WHERE s.phone = c.phone AND s.flow_type = 'opted-out'
  )
  AND NOT EXISTS (
    SELECT 1 FROM sms_campaign_suppressions p
    WHERE p.workspace_id = 'vici' AND p.contact_phone = c.phone AND p.active = true
  )
ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL
DO NOTHING;

-- ── Verify before committing ────────────────────────────────────────────────
-- Expect: opted_in 941, still_no_consent 2 (the do-not-contact pair), opted_out 0.
-- If still_no_consent is not 2, an exclusion behaved unexpectedly. ROLLBACK.
SELECT
  (SELECT count(*) FROM sms_contacts)                                    AS contacts,
  (SELECT count(*) FROM sms_consent_events
     WHERE event_type = 'opt_in' AND workspace_id = 'vici')              AS opted_in,
  (SELECT count(*) FROM sms_contacts c
    WHERE NOT EXISTS (SELECT 1 FROM sms_consent_events e
                       WHERE e.contact_phone = c.phone
                         AND e.event_type = 'opt_in'
                         AND e.workspace_id = 'vici'))                   AS still_no_consent,
  (SELECT count(*) FROM sms_campaign_suppressions
     WHERE active AND workspace_id = 'vici')                             AS do_not_contact,
  (SELECT count(*) FROM sms_consent_events
     WHERE event_type = 'opt_out' AND workspace_id = 'vici')             AS opted_out;

COMMIT;

-- ============================================================================
-- What each person's consent now rests on. Worth one look before the first
-- campaign, because this is the column anybody auditing would read first.
-- ============================================================================
-- SELECT source, count(*)
--   FROM sms_consent_events
--  WHERE event_type = 'opt_in' AND workspace_id = 'vici'
--  GROUP BY source ORDER BY 2 DESC;
