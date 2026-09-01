-- ============================================================================
-- FIX 2 OF 2: THE DND CHECK WAS ONLY EVER FIXED IN ONE OF THREE PLACES
--
-- Paste this whole file into the Supabase SQL editor and run it. Every line is
-- either SQL or a SQL comment, so there is nothing to trim first.
--
-- RUN scripts/FIX-NULL-CHARACTER-SEND-PATH FIRST if you have not already.
-- That one unblocked the claim. This one unblocks everything after it.
--
-- WHAT IS BROKEN
--   Sending a campaign message passes three separate database gates:
--
--     claim_sms_campaign_recipients             picks up the work
--     begin_sms_campaign_provider_attempt       the fence just before sending
--     record_sms_campaign_provider_acceptance   records that it went
--
--   Each one re-checks eligibility, deliberately, because a preview is never
--   authority to send later. All three contained the same DND test:
--
--     c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
--
--   GoHighLevel returns dndSettings as per-channel OVERRIDES, so an empty set
--   means "no override, the global flag applies". Every contact in this
--   account has ghl_dnd = false and ghl_sms_dnd_status NULL. NULL is not
--   'inactive', so that test refuses everybody.
--
--   FIX-SEND-GATE-DND corrected it. In ONE function. claim_sms_campaign_
--   recipients got the sms_dnd_says_contactable helper; the fence and the
--   acceptance record kept the old literal and were never touched.
--
--   The effect is worse than leaving all three broken, because it looks like
--   progress. Rows are claimed, the fence refuses every one of them, the lease
--   expires, the rows return to pending, and the loop does it again. Measured
--   on the live queue: 427 recipients cycling between pending and claimed,
--   0 sent, no error surfaced anywhere, campaigns still displayed as
--   scheduled.
--
-- THE FIX
--   Both remaining functions now call the same helper claim already uses:
--
--     public.sms_dnd_says_contactable(ghl_dnd, ghl_sms_dnd_status,
--                                     ghl_dnd_synced_at, max_age_hours)
--
--   One definition of "contactable", used by all three gates. That is the
--   actual repair; correcting the literal in two more places by hand would
--   have left the same bug free to reappear in the next function.
--
-- WHAT THIS DOES NOT CHANGE
--   No refusal is loosened beyond what FIX-SEND-GATE-DND already decided:
--     ghl_dnd = true                     still refused
--     channel status 'active'            still refused
--     channel status 'permanent'         still refused
--     a missing or non-boolean flag      still unknown, still refused
--     a stale or future sync timestamp   still unknown, still refused
--   Only NULL and empty move, and only from "unknown" to "no override".
--
--   Both definitions below were read out of THIS database with
--   pg_get_functiondef, so any hand-edit made in the dashboard is preserved.
--   The only difference from what is running now is the DND test.
--   CREATE OR REPLACE keeps existing grants.
--
-- AFTER RUNNING
--   The delivery loop picks up work within two minutes and the queue starts
--   draining. Four campaigns are overdue and live sending is ON, so roughly
--   427 messages begin going out promptly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.begin_sms_campaign_provider_attempt(p_recipient_id uuid, p_workspace_id text, p_claim_token uuid, p_lease_seconds integer DEFAULT 120)
 RETURNS sms_campaign_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_campaign_id uuid;
  v_idempotency_key text := 'campaign-recipient:' || p_recipient_id::text;
BEGIN
  IF p_claim_token IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'campaign_provider_attempt_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT campaign_id INTO v_campaign_id FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = v_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND campaign_id = v_campaign.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'scheduled' OR v_recipient.state <> 'claimed'
     OR v_recipient.claim_token <> p_claim_token
     OR v_recipient.claim_expires_at IS NULL OR v_recipient.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'campaign_claim_fence_failed' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id AND provider_approved = true AND live_send_enabled = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_live_send_disabled' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_recipient.contact_phone, 0));

  -- Last pre-provider safety check. Unknown/future/stale DND, authoritative
  -- suppressions, STOP and missing positive consent all fail closed.
  IF EXISTS (
       SELECT 1 FROM public.sms_campaign_suppressions x
       WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_recipient.contact_phone
         AND x.active = true AND x.effective_at <= now()
         AND (x.expires_at IS NULL OR x.expires_at > now())
     )
     OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = v_recipient.contact_phone AND l.flow_type = 'opted-out')
     OR EXISTS (SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone AND coalesce(c.opted_out, false) = true)
     OR NOT EXISTS (
       SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone
         AND public.sms_dnd_says_contactable(
                c.ghl_dnd, c.ghl_sms_dnd_status, c.ghl_dnd_synced_at,
                v_settings.dnd_status_max_age_hours)
     )
     OR (v_settings.consent_evidence_required AND NOT EXISTS (
       SELECT 1 FROM public.sms_consent_events ce
       WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_recipient.contact_phone
         AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms' AND ce.brand_id = p_workspace_id
         AND char_length(trim(ce.source)) > 0 AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.sms_consent_events later
           WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
             AND later.event_type = 'opt_out'
             AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
         )
     )) THEN
    RAISE EXCEPTION 'campaign_recipient_no_longer_eligible' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = v_idempotency_key AND accepted_at IS NULL
    AND reservation_expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_claim_reservation_missing' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'sending', provider_idempotency_key = v_idempotency_key,
      provider_attempt_started_at = now(), provider_attempt_heartbeat_at = now(),
      claim_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;
  RETURN v_recipient;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_acceptance(p_recipient_id uuid, p_workspace_id text, p_claim_token uuid, p_provider_idempotency_key text, p_provider_message_id text, p_accepted_at timestamp with time zone)
 RETURNS sms_campaign_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_campaign_id uuid;
  v_accepted_at timestamptz;
  v_reasons text[] := ARRAY[]::text[];
BEGIN
  -- Shape validation only. These are programming errors, not clock skew and
  -- not a change in the world, so they still refuse.
  IF p_claim_token IS NULL OR char_length(trim(coalesce(p_provider_idempotency_key, ''))) = 0
     OR char_length(trim(coalesce(p_provider_message_id, ''))) = 0
     OR p_accepted_at IS NULL THEN
    RAISE EXCEPTION 'campaign_provider_acceptance_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT campaign_id INTO v_campaign_id FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Campaign-first locking matches cancellation/scheduling and avoids stale
  -- workers crossing a completed cancellation.
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = v_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND campaign_id = v_campaign.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Already recorded. Replaying the same acceptance is a success, not a fault.
  IF v_recipient.state IN ('sent', 'delivered', 'failed')
     AND v_recipient.provider_message_id = p_provider_message_id
     AND v_recipient.claim_token = p_claim_token
     AND v_recipient.provider_idempotency_key = p_provider_idempotency_key THEN
    RETURN v_recipient;
  END IF;

  -- IDENTITY fence. This proves the caller owns this exact in-flight attempt.
  -- It is kept in full and is the only thing that can now refuse a recording.
  -- Only begin_sms_campaign_provider_attempt can produce state = 'sending',
  -- and it requires the campaign to be `scheduled`, so a separate campaign
  -- status test here would be redundant and could only destroy evidence.
  IF v_recipient.state NOT IN ('sending', 'reconciliation_required')
     OR v_recipient.claim_token <> p_claim_token
     OR v_recipient.provider_idempotency_key <> p_provider_idempotency_key THEN
    RAISE EXCEPTION 'campaign_claim_fence_failed' USING ERRCODE = 'P0001';
  END IF;

  -- Clamp rather than refuse. The worker clock and the database clock are
  -- different machines; skew must never delete the record of a real message.
  v_accepted_at := least(greatest(p_accepted_at,
    coalesce(v_recipient.provider_attempt_started_at, p_accepted_at)), now());

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_recipient.contact_phone, 0));

  -- Settings are read WITHOUT the provider_approved/live_send_enabled
  -- predicate. Turning sending off mid-batch stops the next claim; it cannot
  -- retract a message already in a customer's hand, so it must not stop the
  -- bookkeeping for one.
  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id FOR SHARE;
  IF FOUND AND (v_settings.provider_approved <> true OR v_settings.live_send_enabled <> true) THEN
    v_reasons := array_append(v_reasons, 'live_send_disabled_mid_flight');
  END IF;

  -- Eligibility is still evaluated, but it is now EVIDENCE, not a veto. Each
  -- reason is recorded individually so that "their DND went stale" and "they
  -- sent STOP while we were on the wire" are distinguishable afterwards.
  IF v_settings.workspace_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.sms_campaign_suppressions x
      WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_recipient.contact_phone
        AND x.active = true AND x.effective_at <= now()
        AND (x.expires_at IS NULL OR x.expires_at > now())
    ) THEN v_reasons := array_append(v_reasons, 'suppressed'); END IF;

    IF EXISTS (SELECT 1 FROM public.sms_sent_log l
      WHERE l.phone = v_recipient.contact_phone AND l.flow_type = 'opted-out')
    THEN v_reasons := array_append(v_reasons, 'stop_received'); END IF;

    IF EXISTS (SELECT 1 FROM public.sms_contacts c
      WHERE c.phone = v_recipient.contact_phone AND coalesce(c.opted_out, false) = true)
    THEN v_reasons := array_append(v_reasons, 'opted_out'); END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone
        AND public.sms_dnd_says_contactable(
                c.ghl_dnd, c.ghl_sms_dnd_status, c.ghl_dnd_synced_at,
                v_settings.dnd_status_max_age_hours)
    ) THEN v_reasons := array_append(v_reasons, 'dnd_unknown_or_stale'); END IF;

    IF v_settings.consent_evidence_required AND NOT EXISTS (
      SELECT 1 FROM public.sms_consent_events ce
      WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_recipient.contact_phone
        AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms' AND ce.brand_id = p_workspace_id
        AND char_length(trim(ce.source)) > 0 AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.sms_consent_events later
          WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
            AND later.event_type = 'opt_out'
            AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
        )
    ) THEN v_reasons := array_append(v_reasons, 'consent_not_recorded'); END IF;
  END IF;

  -- The cadence row. UPDATE first; if the reservation is somehow gone, INSERT
  -- one. A message that left the building must always have a ledger row, or
  -- the frequency caps are counting fiction.
  UPDATE public.sms_commercial_contact_ledger
  SET provider_message_id = p_provider_message_id, accepted_at = v_accepted_at,
      sent_at = v_accepted_at, reservation_expires_at = NULL, updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = p_provider_idempotency_key
    AND accepted_at IS NULL;
  IF NOT FOUND THEN
    INSERT INTO public.sms_commercial_contact_ledger
      (workspace_id, contact_phone, campaign_id, recipient_id, classification,
       workflow_category, idempotency_key, provider_message_id, reserved_at,
       reservation_expires_at, accepted_at, sent_at)
    VALUES
      (p_workspace_id, v_recipient.contact_phone, v_campaign.id, p_recipient_id, 'promotional',
       v_campaign.workflow_category, p_provider_idempotency_key, p_provider_message_id,
       coalesce(v_recipient.provider_attempt_started_at, v_accepted_at),
       NULL, v_accepted_at, v_accepted_at)
    ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
      SET provider_message_id = coalesce(public.sms_commercial_contact_ledger.provider_message_id, excluded.provider_message_id),
          accepted_at = coalesce(public.sms_commercial_contact_ledger.accepted_at, excluded.accepted_at),
          sent_at = coalesce(public.sms_commercial_contact_ledger.sent_at, excluded.sent_at),
          reservation_expires_at = NULL,
          updated_at = now();
  END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'sent', provider_message_id = p_provider_message_id,
      provider_status = 'accepted', sent_at = v_accepted_at,
      claim_expires_at = NULL, reconciliation_required_at = NULL, updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;

  INSERT INTO public.sms_campaign_recipient_events
    (recipient_id, campaign_id, workspace_id, event_type, occurred_at,
     provider, provider_message_id, trusted, trust_source, metadata, dedupe_key)
  VALUES
    (p_recipient_id, v_campaign.id, p_workspace_id, 'provider.accepted', v_accepted_at,
     'telnyx', p_provider_message_id, true, 'provider_api_response', '{"trusted":true}'::jsonb,
     'provider-accepted:' || p_provider_message_id)
  ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  -- The compliance signal that used to be a RAISE. It is deliberately written
  -- AFTER acceptance so it can never be the reason acceptance did not happen.
  IF array_length(v_reasons, 1) > 0 THEN
    INSERT INTO public.sms_campaign_recipient_events
      (recipient_id, campaign_id, workspace_id, event_type, occurred_at, reason_code,
       provider, provider_message_id, trusted, trust_source, metadata, dedupe_key)
    VALUES
      (p_recipient_id, v_campaign.id, p_workspace_id, 'provider.accepted_while_ineligible',
       v_accepted_at, v_reasons[1], 'telnyx', p_provider_message_id, true, 'provider_api_response',
       jsonb_build_object('reasons', to_jsonb(v_reasons),
         'note', 'message already sent; recorded so it counts against frequency caps'),
       'provider-accepted-ineligible:' || p_provider_message_id)
    ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END IF;

  RETURN v_recipient;
END;
$function$
;
