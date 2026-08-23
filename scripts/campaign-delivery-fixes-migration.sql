-- Vici Inbox — campaign delivery correctness fixes. Function replacements only.
--
-- READ THIS FIRST
--   scripts/campaigns-migration.sql has already been applied in production and
--   must not be edited. This file is the follow-up. It contains no CREATE
--   TABLE, no ALTER TABLE, no DROP and no data change: it CREATE OR REPLACEs
--   four functions and creates one new one. Applying it twice is a no-op.
--
-- THE BUG THIS EXISTS TO FIX
--   A promotional message that WAS SENT could become invisible to the
--   frequency caps, permanently.
--
--     1. begin_sms_campaign_provider_attempt puts the recipient in `sending`
--        and leaves the ledger row with accepted_at NULL and
--        reservation_expires_at = now() + lease.
--     2. The provider call succeeds. The text is in the customer's hand.
--     3. record_sms_campaign_provider_acceptance re-ran the FULL eligibility
--        check AFTER the send and raised, so accepted_at stayed NULL.
--     4. release_expired_sms_campaign_claims deliberately refuses to expire a
--        ledger row whose recipient sits in `sending`/`reconciliation_required`,
--        so reservation_expires_at stayed in the past forever.
--     5. Every cadence predicate in claim_sms_campaign_recipients is gated on
--        (accepted_at IS NOT NULL OR reservation_expires_at > now()). Both are
--        now false, so the sent message counted towards NONE of
--        minimum_promotional_spacing_hours, max_promotional_per_7_days or
--        max_promotional_per_30_days.
--
--   Step 3 is routine, not exotic. A contact sitting on the 24-hour
--   ghl_dnd_synced_at freshness boundary flips ineligible between begin_ and
--   record_ as a matter of course; so does an inbound STOP in the same second;
--   so does one PostgREST blip.
--
--   The same hole opens with no re-check at all: if the worker process dies
--   between the provider call and the acceptance RPC, the row is stuck in
--   `sending` with an expired reservation, which is equally uncounted.
--
-- THE PRINCIPLE
--   Refusing to RECORD a send cannot UN-SEND it. All a post-send eligibility
--   check can do is destroy the evidence that a real message left the building.
--   The eligibility gate belongs in begin_sms_campaign_provider_attempt, which
--   already performs it under the same per-phone advisory lock, immediately
--   before provider I/O, and which CAN still prevent the send. After the send,
--   recording is unconditional.
--
--   Consent enforcement is not weakened by this. Nothing here changes who may
--   be claimed or who may be sent to. Every suppression, DND, STOP, consent,
--   quiet-hours and cadence gate in claim_sms_campaign_recipients and
--   begin_sms_campaign_provider_attempt is untouched. The change is that a
--   message which already went out is now always counted against the caps,
--   which makes the caps stricter, never looser.
--
-- WHAT CHANGES
--   1. record_sms_campaign_provider_acceptance
--      * The post-send eligibility block no longer raises. It is evaluated and
--        WRITTEN DOWN as a `provider.accepted_while_ineligible` event with the
--        specific reasons, then acceptance is recorded anyway. Compliance still
--        gets the exact signal ("this person's DND flipped mid-flight"); the
--        record survives.
--      * The live-send settings gate no longer raises. Flipping
--        live_send_enabled off mid-batch must not erase messages already sent.
--      * The campaign-status gate is removed. It was redundant: only
--        begin_sms_campaign_provider_attempt can put a row into `sending`, and
--        it requires status = 'scheduled', so an in-flight attempt already
--        proves the campaign was scheduled. The recipient identity fence
--        (state + claim_token + provider_idempotency_key) is kept in full.
--      * p_accepted_at is CLAMPED into [provider_attempt_started_at, now()]
--        instead of raising. The worker's clock is a Node process on Railway
--        and the comparison clock is Postgres; a few hundred milliseconds of
--        skew must not delete a send record.
--      * A missing ledger reservation is INSERTED rather than raised. A message
--        that went out must have a cadence row, always.
--
--   2. record_sms_campaign_provider_refusal  (NEW)
--      A provider rejection is a third outcome and was not representable. The
--      worker previously classed a definitive HTTP 400 "invalid destination"
--      as `uncertain`, which means a human reconciliation queue built out of
--      ordinary bad phone numbers. This marks the recipient `failed` with the
--      provider error code and RELEASES the ledger reservation, because nothing
--      went out and a refusal is not a contact. It is only ever called for an
--      outcome the provider proved did not reach a carrier.
--
--   3. claim_sms_campaign_recipients
--      The three cadence predicates now also count a ledger row whose recipient
--      is still in `sending` or `reconciliation_required`. That closes the
--      crash-between-send-and-record variant with no dependence on a timer:
--      the moment a row is in flight it counts, and it keeps counting until a
--      person resolves the reconciliation. Nothing else in the function
--      changes.
--
--   4. release_expired_sms_campaign_claims
--      Unchanged in behaviour; replaced only so that the comment explains why
--      it must NOT expire the reservation of an in-flight row, now that
--      claim_sms_campaign_recipients relies on that row still being visible.
--
-- ROLLBACK
--   Re-apply scripts/campaigns-migration.sql. Every function here is a
--   CREATE OR REPLACE of one that file already defines, except
--   record_sms_campaign_provider_refusal, which is new and independent:
--     DROP FUNCTION IF EXISTS public.record_sms_campaign_provider_refusal(uuid,text,uuid,text,text,timestamptz);
--   No table, column, constraint, index or row is touched by this file, so
--   rolling back cannot lose data.

BEGIN;

-- ── 1. Recording an accepted send is unconditional ───────────────────────────

CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_acceptance(
  p_recipient_id uuid,
  p_workspace_id text,
  p_claim_token uuid,
  p_provider_idempotency_key text,
  p_provider_message_id text,
  p_accepted_at timestamptz
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(0) || v_recipient.contact_phone, 0));

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
        AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
        AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
        AND c.ghl_dnd_synced_at <= now()
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
$$;

-- ── 2. A provider refusal is a real, separate outcome ────────────────────────

-- Called ONLY when the provider rejected the request outright and proved it
-- never reached a carrier: an HTTP 4xx from a parsed Telnyx error body, before
-- submission. A timeout, an abort, a 5xx, a 429 or a broken socket is NOT a
-- refusal — those stay uncertain and are never touched by this function.
--
-- The ledger reservation is RELEASED, not accepted, because a refusal is not a
-- contact and must not consume the recipient's frequency budget.
CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_refusal(
  p_recipient_id uuid,
  p_workspace_id text,
  p_claim_token uuid,
  p_provider_idempotency_key text,
  p_error_code text,
  p_refused_at timestamptz
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_campaign_id uuid;
  v_refused_at timestamptz;
  v_code text;
BEGIN
  IF p_claim_token IS NULL OR char_length(trim(coalesce(p_provider_idempotency_key, ''))) = 0
     OR p_refused_at IS NULL THEN
    RAISE EXCEPTION 'campaign_provider_refusal_invalid' USING ERRCODE = 'P0001';
  END IF;
  v_code := left(nullif(trim(coalesce(p_error_code, '')), ''), 120);

  SELECT campaign_id INTO v_campaign_id FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = v_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND campaign_id = v_campaign.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Replay of the same refusal is a success.
  IF v_recipient.state = 'failed' AND v_recipient.provider_status = 'refused'
     AND v_recipient.claim_token = p_claim_token
     AND v_recipient.provider_idempotency_key = p_provider_idempotency_key THEN
    RETURN v_recipient;
  END IF;

  -- A refusal may never overwrite a recorded send. If the row already carries a
  -- provider_message_id it went out, whatever the caller thinks.
  IF v_recipient.provider_message_id IS NOT NULL
     OR v_recipient.state NOT IN ('sending', 'reconciliation_required')
     OR v_recipient.claim_token <> p_claim_token
     OR v_recipient.provider_idempotency_key <> p_provider_idempotency_key THEN
    RAISE EXCEPTION 'campaign_claim_fence_failed' USING ERRCODE = 'P0001';
  END IF;

  v_refused_at := least(greatest(p_refused_at,
    coalesce(v_recipient.provider_attempt_started_at, p_refused_at)), now());

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(0) || v_recipient.contact_phone, 0));

  -- Nothing was sent, so the reservation is given back rather than accepted.
  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now(), suppression_reason = 'provider_refused',
      suppressed_at = v_refused_at, updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = p_provider_idempotency_key
    AND accepted_at IS NULL;

  UPDATE public.sms_campaign_recipients
  SET state = 'failed', provider_status = 'refused', provider_error_code = v_code,
      failed_at = v_refused_at, claim_expires_at = NULL,
      reconciliation_required_at = NULL, updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;

  -- Not a `provider.` event: that prefix has a CHECK requiring a
  -- provider_message_id, and a refusal has none because nothing was submitted.
  INSERT INTO public.sms_campaign_recipient_events
    (recipient_id, campaign_id, workspace_id, event_type, occurred_at, reason_code,
     trusted, trust_source, metadata, dedupe_key)
  VALUES
    (p_recipient_id, v_campaign.id, p_workspace_id, 'recipient.provider_refused',
     v_refused_at, v_code, true, 'provider_api_response',
     jsonb_build_object('errorCode', v_code, 'submitted', false),
     'provider-refused:' || p_recipient_id::text || ':' || p_provider_idempotency_key)
  ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN v_recipient;
END;
$$;

-- ── 3. An in-flight or unreconciled attempt counts against the caps ──────────

-- Identical to scripts/campaigns-migration.sql except for the three cadence
-- predicates below, each of which gains:
--
--     OR EXISTS (... sms_campaign_recipients inflight ... state IN
--                ('sending', 'reconciliation_required'))
--
-- Why: the reservation window is a lease, and a lease expires. A row that is
-- still `sending` (worker mid-call, or worker dead) or `reconciliation_required`
-- (a person has not yet decided whether it went out) may correspond to a real
-- message on the wire. Counting it costs at most one deferred promotional
-- message to one person; not counting it costs a cap breach. It also removes
-- any dependence on release_expired_sms_campaign_claims having run recently —
-- the row counts from the instant it enters `sending`.
--
-- Nothing else changes: the same suppression, STOP, opt-out, DND-freshness,
-- consent-evidence, quiet-hours and reservation logic, in the same order.

CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients(
  p_workspace_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 120
) RETURNS SETOF public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim uuid := gen_random_uuid();
  v_candidate public.sms_campaign_recipients%ROWTYPE;
  v_claimed public.sms_campaign_recipients%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_reserved_id bigint;
  v_claimed_count integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid_claim_limit'; END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 900 THEN RAISE EXCEPTION 'invalid_claim_lease'; END IF;

  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id FOR SHARE;
  IF NOT FOUND OR v_settings.provider_approved <> true OR v_settings.live_send_enabled <> true THEN
    RETURN;
  END IF;

  -- Fail-closed suppression. Missing consent is suppressing evidence whenever
  -- the workspace requires positive evidence. STOP sentinels always win.
  UPDATE public.sms_campaign_recipients r
  SET state = 'suppressed',
      suppression_reason = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.sms_campaign_suppressions x
          WHERE x.workspace_id = c.workspace_id AND x.contact_phone = r.contact_phone
            AND x.active = true AND x.effective_at <= now()
            AND (x.expires_at IS NULL OR x.expires_at > now())
        ) THEN 'internal_or_authoritative_suppression'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_sent_log l
          WHERE l.phone = r.contact_phone AND l.flow_type = 'opted-out'
        ) THEN 'opted_out'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_contacts c
          WHERE c.phone = r.contact_phone AND coalesce(c.opted_out, false) = true
        ) THEN 'opted_out'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_contacts d
          WHERE d.phone = r.contact_phone
            AND (d.ghl_dnd = true OR d.ghl_sms_dnd_status IN ('active', 'permanent'))
        ) THEN 'dnd'
        WHEN NOT EXISTS (
          SELECT 1 FROM public.sms_contacts d
          WHERE d.phone = r.contact_phone
            AND d.ghl_dnd = false AND d.ghl_sms_dnd_status = 'inactive'
            AND d.ghl_dnd_synced_at >= now() - make_interval(hours => s.dnd_status_max_age_hours)
            AND d.ghl_dnd_synced_at <= now()
        ) THEN 'dnd_unknown'
        ELSE 'consent_not_recorded'
      END,
      updated_at = now()
  FROM public.sms_campaigns c, public.sms_campaign_settings s
  WHERE r.campaign_id = c.id AND s.workspace_id = c.workspace_id
    AND c.workspace_id = p_workspace_id AND c.status = 'scheduled'
    AND r.state IN ('pending', 'deferred')
    AND coalesce(r.next_attempt_at, r.planned_send_at, now()) <= now()
    AND (
      EXISTS (
        SELECT 1 FROM public.sms_campaign_suppressions x
        WHERE x.workspace_id = c.workspace_id AND x.contact_phone = r.contact_phone
          AND x.active = true AND x.effective_at <= now()
          AND (x.expires_at IS NULL OR x.expires_at > now())
      )
      OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = r.contact_phone AND l.flow_type = 'opted-out')
      OR EXISTS (SELECT 1 FROM public.sms_contacts sc WHERE sc.phone = r.contact_phone AND coalesce(sc.opted_out, false) = true)
      OR EXISTS (
        SELECT 1 FROM public.sms_contacts d WHERE d.phone = r.contact_phone
          AND (d.ghl_dnd = true OR d.ghl_sms_dnd_status IN ('active', 'permanent'))
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.sms_contacts d WHERE d.phone = r.contact_phone
          AND d.ghl_dnd = false AND d.ghl_sms_dnd_status = 'inactive'
          AND d.ghl_dnd_synced_at >= now() - make_interval(hours => s.dnd_status_max_age_hours)
          AND d.ghl_dnd_synced_at <= now()
      )
      OR (s.consent_evidence_required AND NOT EXISTS (
        SELECT 1 FROM public.sms_consent_events ce
        WHERE ce.workspace_id = c.workspace_id AND ce.contact_phone = r.contact_phone
          AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms'
          AND ce.brand_id = c.workspace_id
          AND char_length(trim(ce.source)) > 0
          AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
          AND NOT EXISTS (
            SELECT 1 FROM public.sms_consent_events later
            WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
              AND later.event_type = 'opt_out'
              AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
          )
      ))
    );

  -- One row is processed at a time so the advisory lock is acquired in a
  -- separate SQL statement before cadence is re-read under READ COMMITTED.
  -- The reservation insert then makes the frequency decision durable before a
  -- worker can receive the claimed row. At most one campaign per phone can be
  -- reserved by concurrent claimers.
  FOR v_candidate IN
    SELECT r.*
    FROM public.sms_campaign_recipients r
    JOIN public.sms_campaigns c ON c.id = r.campaign_id
    WHERE c.workspace_id = p_workspace_id
      AND c.status = 'scheduled'
      AND r.workspace_id = p_workspace_id
      AND r.state IN ('pending', 'deferred')
      AND coalesce(r.next_attempt_at, r.planned_send_at, now()) <= now()
      AND NOT (
        (v_settings.quiet_hours_start > v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time >= v_settings.quiet_hours_start)
        OR (v_settings.quiet_hours_start > v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time < v_settings.quiet_hours_end)
        OR (v_settings.quiet_hours_start < v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time >= v_settings.quiet_hours_start AND
          (now() AT TIME ZONE v_settings.business_timezone)::time < v_settings.quiet_hours_end)
      )
    ORDER BY coalesce(r.next_attempt_at, r.planned_send_at), r.created_at
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    EXIT WHEN v_claimed_count >= p_limit;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(0) || v_candidate.contact_phone, 0));

    -- Repeat every mutable suppression after the per-phone lock. Unknown or
    -- stale GHL DND state is ineligible; absence is never interpreted as false.
    IF EXISTS (
         SELECT 1 FROM public.sms_campaign_suppressions x
         WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_candidate.contact_phone
           AND x.active = true AND x.effective_at <= now()
           AND (x.expires_at IS NULL OR x.expires_at > now())
       )
       OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = v_candidate.contact_phone AND l.flow_type = 'opted-out')
       OR EXISTS (SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_candidate.contact_phone AND coalesce(c.opted_out, false) = true)
       OR NOT EXISTS (
         SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_candidate.contact_phone
           AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
           AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
           AND c.ghl_dnd_synced_at <= now()
       )
       OR (v_settings.consent_evidence_required AND NOT EXISTS (
         SELECT 1 FROM public.sms_consent_events ce
         WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_candidate.contact_phone
           AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms'
           AND ce.brand_id = p_workspace_id
           AND char_length(trim(ce.source)) > 0
           AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
           AND NOT EXISTS (
             SELECT 1 FROM public.sms_consent_events later
             WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
               AND later.event_type = 'opt_out'
               AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
           )
       )) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) >
          now() - make_interval(hours => v_settings.minimum_promotional_spacing_hours)
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now()
          OR EXISTS (
            SELECT 1 FROM public.sms_campaign_recipients inflight
            WHERE inflight.workspace_id = ledger.workspace_id
              AND inflight.id = ledger.recipient_id
              AND inflight.state IN ('sending', 'reconciliation_required')
          ))
    ) OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '7 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now()
          OR EXISTS (
            SELECT 1 FROM public.sms_campaign_recipients inflight
            WHERE inflight.workspace_id = ledger.workspace_id
              AND inflight.id = ledger.recipient_id
              AND inflight.state IN ('sending', 'reconciliation_required')
          ))
    ) >= v_settings.max_promotional_per_7_days OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '30 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now()
          OR EXISTS (
            SELECT 1 FROM public.sms_campaign_recipients inflight
            WHERE inflight.workspace_id = ledger.workspace_id
              AND inflight.id = ledger.recipient_id
              AND inflight.state IN ('sending', 'reconciliation_required')
          ))
    ) >= v_settings.max_promotional_per_30_days THEN
      CONTINUE;
    END IF;

    INSERT INTO public.sms_commercial_contact_ledger
      (workspace_id, contact_phone, campaign_id, recipient_id, classification,
       workflow_category, idempotency_key, reserved_at, reservation_expires_at)
    SELECT p_workspace_id, v_candidate.contact_phone, c.id, v_candidate.id, 'promotional',
      c.workflow_category, 'campaign-recipient:' || v_candidate.id::text,
      now(), now() + make_interval(secs => p_lease_seconds)
    FROM public.sms_campaigns c
    WHERE c.id = v_candidate.campaign_id AND c.workspace_id = p_workspace_id AND c.status = 'scheduled'
    ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
      SET reserved_at = EXCLUDED.reserved_at,
          reservation_expires_at = EXCLUDED.reservation_expires_at,
          updated_at = now()
      WHERE public.sms_commercial_contact_ledger.accepted_at IS NULL
        AND public.sms_commercial_contact_ledger.reservation_expires_at <= now()
    RETURNING id INTO v_reserved_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.sms_campaign_recipients r
    SET state = 'claimed', claim_token = v_claim, claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = r.attempt_count + 1, updated_at = now()
    WHERE r.id = v_candidate.id AND r.workspace_id = p_workspace_id
      AND r.state IN ('pending', 'deferred')
    RETURNING r.* INTO v_claimed;
    IF FOUND THEN
      v_claimed_count := v_claimed_count + 1;
      RETURN NEXT v_claimed;
    ELSE
      UPDATE public.sms_commercial_contact_ledger
      SET reservation_expires_at = now(), updated_at = now()
      WHERE id = v_reserved_id AND accepted_at IS NULL;
    END IF;
  END LOOP;
  RETURN;
END;
$$;

-- ── 4. Recovery, unchanged, with the reason it looks the way it does ─────────

-- Byte-identical behaviour to scripts/campaigns-migration.sql. It is repeated
-- here only so this file documents the invariant that section 3 now depends on:
-- the final UPDATE must NOT expire the reservation of a ledger row whose
-- recipient is in `sending` or `reconciliation_required`, because those rows may
-- represent a message that was actually sent. Removing that NOT EXISTS guard
-- would re-open the exact cap-escape this migration exists to close.

CREATE OR REPLACE FUNCTION public.release_expired_sms_campaign_claims(p_workspace_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_reconciliation_count integer;
BEGIN
  UPDATE public.sms_campaign_recipients
  SET state = 'pending', claim_token = NULL, claimed_at = NULL,
      claim_expires_at = NULL, next_attempt_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND state = 'claimed' AND claim_expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.sms_campaign_recipients
  SET state = 'reconciliation_required', reconciliation_required_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND state = 'sending' AND claim_expires_at < now();
  GET DIAGNOSTICS v_reconciliation_count = ROW_COUNT;
  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND accepted_at IS NULL
    AND reservation_expires_at < now()
    AND NOT EXISTS (
      SELECT 1 FROM public.sms_campaign_recipients r
      WHERE r.workspace_id = p_workspace_id
        AND r.id = public.sms_commercial_contact_ledger.recipient_id
        AND r.state IN ('sending', 'reconciliation_required')
    );
  RETURN v_count + v_reconciliation_count;
END;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves existing grants, so these lines are not strictly
-- required for the three replaced functions. They are restated anyway: this
-- file must be auditable on its own, and a reader must not have to open
-- scripts/campaigns-migration.sql to confirm that none of these SECURITY
-- DEFINER functions is reachable from an anon or authenticated browser key.
-- record_sms_campaign_provider_refusal is new and genuinely needs them.

REVOKE ALL ON FUNCTION public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_sms_campaign_provider_refusal(uuid,text,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sms_campaign_recipients(text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_expired_sms_campaign_claims(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sms_campaign_provider_refusal(uuid,text,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sms_campaign_recipients(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expired_sms_campaign_claims(text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
