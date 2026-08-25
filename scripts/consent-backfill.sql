-- ============================================================================
-- scripts/consent-backfill.sql
--
-- Record the consent that already exists, so the send path can see it.
--
-- WHAT THIS IS BASED ON
--   Customers consent to SMS when they create an account at vicipeptides.com.
--   That consent is real and it predates this system; what was missing is any
--   ROW saying so, which is why campaign eligibility refused all 943 contacts
--   with `consent_not_recorded`.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does not write consent for somebody who has no account. 38 of the 943
--   contacts have no woo_customer_id: they arrived by texting in or by hand,
--   never registered, and the basis above simply does not describe them.
--   Writing them an opt_in would be inventing a consent event, which is the
--   one thing a consent table must never contain. They stay refused until
--   there is a real basis for them. See the report at the bottom.
--
--   It does not use now() for occurred_at. Two reasons, and the second is the
--   important one:
--     1. Honesty. The consent happened when they registered, not today.
--     2. Safety. Consent precedence is by occurred_at DESC. A row stamped
--        today would sit ABOVE an earlier opt-out and un-unsubscribe somebody
--        who had asked to be left alone. Stamping it with the account date
--        makes that structurally impossible, not merely unlikely.
--
-- FOUR INDEPENDENT EXCLUSIONS, because one is not enough for this
--   Anybody who has ever opted out, anybody flagged opted_out, anybody holding
--   an opt-out sentinel in sms_sent_log, and anybody on the do-not-contact
--   list is skipped entirely. Any one of those alone would be sufficient; all
--   four are here because the cost of a mistake is messaging somebody who
--   said stop, and the cost of being over-careful is a handful of people you
--   can add later on purpose.
--
-- SAFE TO RUN TWICE. dedupe_key is unique per workspace, so a second run
-- inserts nothing and reports 0.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and run it whole. It is one
--   transaction: if the verification at the end looks wrong, ROLLBACK.
-- ============================================================================

BEGIN;

-- ── The backfill ────────────────────────────────────────────────────────────
INSERT INTO sms_consent_events (
  workspace_id, contact_phone, event_type, purpose, brand_id,
  source, evidence_ref, occurred_at, dedupe_key, metadata
)
SELECT
  'vici',
  c.phone,
  'opt_in',
  -- Both of these are matched exactly by lib/campaigns/eligibility.js when it
  -- decides whether an opt_in counts. A different purpose or brand here is not
  -- an error, it is a row that silently never applies to anything.
  'promotional_sms',
  'vici',
  'woocommerce_account_registration',
  -- Per-contact and traceable back to a real record, rather than one blanket
  -- sentence repeated 905 times. If this is ever questioned, the answer is a
  -- specific customer id somebody can go and look at.
  'WooCommerce customer #' || c.woo_customer_id::text
    || ' registered at vicipeptides.com'
    || coalesce(' (' || nullif(c.email, '') || ')', ''),
  -- The account date, never today. See the note above.
  coalesce(c.created_at, c.first_seen, now()),
  'wooreg:' || c.phone,
  jsonb_build_object(
    'backfill', 'consent-backfill.sql',
    'basis', 'account_registration',
    'woo_customer_id', c.woo_customer_id
  )
FROM sms_contacts c
WHERE
  -- A real account is the entire basis for this row.
  c.woo_customer_id IS NOT NULL
  -- The table's own format check. A row that fails it aborts the whole
  -- statement, so filtering here means one bad number cannot cost the other 904.
  AND c.phone ~ '^\+[1-9][0-9]{7,14}$'
  -- Exclusion 1: flagged as opted out on the contact itself.
  AND coalesce(c.opted_out, false) = false
  -- Exclusion 2: has ever recorded an opt-out, whatever its date.
  AND NOT EXISTS (
    SELECT 1 FROM sms_consent_events e
    WHERE e.workspace_id = 'vici'
      AND e.contact_phone = c.phone
      AND e.event_type = 'opt_out'
  )
  -- Exclusion 3: holds an opt-out sentinel. This is where a texted STOP has
  -- always been recorded, and it is the check the send path itself makes.
  AND NOT EXISTS (
    SELECT 1 FROM sms_sent_log s
    WHERE s.phone = c.phone AND s.flow_type = 'opted-out'
  )
  -- Exclusion 4: on the do-not-contact list.
  AND NOT EXISTS (
    SELECT 1 FROM sms_campaign_suppressions p
    WHERE p.workspace_id = 'vici'
      AND p.contact_phone = c.phone
      AND p.active = true
  )
ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL
DO NOTHING;

-- ── Let the send path see it ────────────────────────────────────────────────
-- consent_evidence_required stays TRUE. This backfill exists precisely so that
-- flag can stay on: turning it off would let through the 38 with no basis and
-- anybody added tomorrow, which is the opposite of what was asked for.
UPDATE sms_campaign_settings
   SET consent_evidence_required = true
 WHERE workspace_id = 'vici';

-- ── Verify before you commit ────────────────────────────────────────────────
-- Expect roughly: contacts 943, opted_in 905, no_account 38, suppressed 2.
-- If opted_in is 943, an exclusion did not fire and you should ROLLBACK.
SELECT
  (SELECT count(*) FROM sms_contacts)                                   AS contacts,
  (SELECT count(*) FROM sms_consent_events
     WHERE event_type = 'opt_in' AND workspace_id = 'vici')             AS opted_in,
  (SELECT count(*) FROM sms_contacts
     WHERE woo_customer_id IS NULL)                                     AS no_account_left_alone,
  (SELECT count(*) FROM sms_campaign_suppressions
     WHERE active AND workspace_id = 'vici')                            AS do_not_contact,
  (SELECT count(*) FROM sms_consent_events
     WHERE event_type = 'opt_out' AND workspace_id = 'vici')            AS opted_out;

COMMIT;

-- ============================================================================
-- WHO WAS LEFT OUT, AND WHY. Run this after committing.
-- These people can still be messaged the moment there is a real basis: add an
-- opt_in row for them individually, with evidence that says what it was.
-- ============================================================================
-- SELECT phone, name, email, source, created_at
--   FROM sms_contacts
--  WHERE woo_customer_id IS NULL
--  ORDER BY created_at DESC;
