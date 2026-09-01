-- ============================================================================
-- FIX THE SEND PATH: chr(0) IS ILLEGAL IN POSTGRESQL
--
-- Paste this whole file into the Supabase SQL editor and run it. Every line is
-- either SQL or a SQL comment, so there is nothing to trim first.
--
-- WHAT IS BROKEN
--   Four functions build a per-phone advisory lock key like this:
--
--     hashtextextended(p_workspace_id || chr(0) || contact_phone, 0)
--
--   The NUL was meant as a separator that cannot appear in either operand, so
--   that 'a' + 'bc' and 'ab' + 'c' can never collide into one lock. The
--   reasoning is right. The character is not: PostgreSQL text values cannot
--   contain a NUL byte at all, so chr(0) does not produce a separator, it
--   raises
--
--     ERROR: 54000: null character not permitted
--
--   every single time the line is reached.
--
-- WHAT THAT MEANT
--   The four functions are the whole send path:
--
--     claim_sms_campaign_recipients             claims work
--     begin_sms_campaign_provider_attempt       the fence before the provider
--     record_sms_campaign_provider_acceptance   records the send
--     persist_sms_opportunity_draft_bundle      draft persistence
--
--   Every campaign message ever scheduled has failed at the first step. The
--   delivery loop was running, claiming nothing, and logging the same error
--   every two minutes. Four approved campaigns sat at 0 of 427 sent while the
--   app showed them as scheduled, because nothing about a failed claim marks a
--   campaign as failed.
--
-- THE FIX
--   chr(31), the ASCII unit separator. It is a legal PostgreSQL text
--   character, it is non-printing, and it cannot occur in a workspace id or an
--   E.164 phone number, so it does exactly the job chr(0) was chosen for.
--   Verified on this database: chr(31) hashes, chr(0) raises 54000.
--
-- WHAT THIS DOES NOT CHANGE
--   Nothing else. Each definition below was read back out of THIS database
--   with pg_get_functiondef, so any hand-edit made in the dashboard is
--   preserved; the only difference from what is running now is chr(0) to
--   chr(31). CREATE OR REPLACE keeps existing grants.
--
-- AFTER RUNNING
--   The delivery loop picks up work within two minutes. Four campaigns are
--   overdue and live sending is ON, so 427 messages begin going out promptly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- begin_sms_campaign_provider_attempt
-- ---------------------------------------------------------------------------
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
         AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
         AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
         AND c.ghl_dnd_synced_at <= now()
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

-- ---------------------------------------------------------------------------
-- claim_sms_campaign_recipients
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients(p_workspace_id text, p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120)
 RETURNS SETOF sms_campaign_recipients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
            AND public.sms_dnd_says_contactable(
                  d.ghl_dnd, d.ghl_sms_dnd_status, d.ghl_dnd_synced_at,
                  s.dnd_status_max_age_hours)
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
          AND public.sms_dnd_says_contactable(
                d.ghl_dnd, d.ghl_sms_dnd_status, d.ghl_dnd_synced_at,
                s.dnd_status_max_age_hours)
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
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_candidate.contact_phone, 0));

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
           AND public.sms_dnd_says_contactable(
                 c.ghl_dnd, c.ghl_sms_dnd_status, c.ghl_dnd_synced_at,
                 v_settings.dnd_status_max_age_hours)
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
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
    ) OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '7 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
    ) >= v_settings.max_promotional_per_7_days OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '30 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
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
$function$
;

-- ---------------------------------------------------------------------------
-- persist_sms_opportunity_draft_bundle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.persist_sms_opportunity_draft_bundle(p_workspace_id text, p_actor_user_id bigint, p_rule_version text, p_opportunities jsonb, p_drafts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_opportunity jsonb;
  v_draft jsonb;
  v_recipient jsonb;
  v_key text;
  v_preparation_key text;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_expected integer;
  v_available integer;
  v_inserted integer := 0;
  v_reused integer := 0;
  v_campaigns jsonb := '[]'::jsonb;
BEGIN
  IF char_length(trim(coalesce(p_workspace_id, ''))) = 0
     OR char_length(trim(coalesce(p_rule_version, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_generation_identity_required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_opportunities) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_drafts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'campaign_generation_arrays_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_settings FROM public.sms_campaign_settings s
  WHERE s.workspace_id = p_workspace_id FOR SHARE;
  IF NOT FOUND OR v_settings.drafts_enabled <> true THEN
    RAISE EXCEPTION 'campaign_drafting_disabled' USING ERRCODE = 'P0001';
  END IF;
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.sms_users u
    JOIN public.sms_effective_permissions ep ON ep.user_id = u.id
    WHERE u.id = p_actor_user_id AND u.is_active = true
      AND ep.permission_key = 'campaigns.manage'
  ) THEN
    RAISE EXCEPTION 'campaign_generation_actor_forbidden' USING ERRCODE = 'P0001';
  END IF;

  FOR v_opportunity IN SELECT value FROM jsonb_array_elements(p_opportunities)
  LOOP
    IF v_opportunity->>'workspaceID' IS DISTINCT FROM p_workspace_id
       OR coalesce(v_opportunity->>'status', '') <> 'open'
       OR coalesce(v_opportunity->>'dedupeKey', '') = ''
       OR coalesce(v_opportunity->>'opportunityType', '') = ''
       OR coalesce(v_opportunity->>'sourceType', '') = ''
       OR v_opportunity#>>'{structuredContext,ruleVersion}' IS DISTINCT FROM p_rule_version
       OR coalesce(v_opportunity#>>'{structuredContext,contactPhone}', '') !~ '^\+[1-9][0-9]{7,14}$'
       OR (
         v_opportunity#>'{structuredContext,wooCustomerID}' IS NOT NULL
         AND jsonb_typeof(v_opportunity#>'{structuredContext,wooCustomerID}') <> 'null'
         AND coalesce(v_opportunity#>>'{structuredContext,wooCustomerID}', '') !~ '^[1-9][0-9]*$'
       )
       OR coalesce(v_opportunity#>>'{structuredContext,productID}', '') !~ '^[1-9][0-9]*$'
       OR (
         v_opportunity#>'{structuredContext,variationID}' IS NOT NULL
         AND jsonb_typeof(v_opportunity#>'{structuredContext,variationID}') <> 'null'
         AND coalesce(v_opportunity#>>'{structuredContext,variationID}', '') !~ '^(0|[1-9][0-9]*)$'
       ) THEN
      RAISE EXCEPTION 'campaign_opportunity_evidence_invalid' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.sms_campaign_opportunities
      (workspace_id, opportunity_type, source_type, source_id, dedupe_key,
       status, structured_context, explanation, expires_at)
    VALUES
      (p_workspace_id, left(v_opportunity->>'opportunityType', 100),
       left(v_opportunity->>'sourceType', 100), nullif(v_opportunity->>'sourceID', ''),
       v_opportunity->>'dedupeKey', 'open', v_opportunity->'structuredContext',
       left(v_opportunity->>'explanation', 1000),
       nullif(v_opportunity->>'expiresAt', '')::timestamptz)
    ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
  END LOOP;

  IF (
    SELECT count(DISTINCT value->>'dedupeKey') FROM jsonb_array_elements(p_opportunities)
  ) <> jsonb_array_length(p_opportunities)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_opportunities) opportunity(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_drafts) draft(value)
         CROSS JOIN LATERAL jsonb_array_elements_text(
           draft.value#>'{audienceDefinition,opportunityDedupeKeys}'
         ) draft_key(value)
         WHERE draft_key.value = opportunity.value->>'dedupeKey'
       )
     ) OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_drafts) draft(value)
       CROSS JOIN LATERAL jsonb_array_elements_text(
         draft.value#>'{audienceDefinition,opportunityDedupeKeys}'
       ) draft_key(value)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_opportunities) opportunity(value)
         WHERE opportunity.value->>'dedupeKey' = draft_key.value
       )
     ) THEN
    RAISE EXCEPTION 'campaign_opportunity_bundle_set_invalid' USING ERRCODE = 'P0001';
  END IF;

  FOR v_draft IN SELECT value FROM jsonb_array_elements(p_drafts)
  LOOP
    v_preparation_key := nullif(trim(v_draft->>'preparationID'), '');
    IF v_preparation_key IS NULL
       OR v_draft->>'workspaceID' IS DISTINCT FROM p_workspace_id
       OR v_draft->>'status' IS DISTINCT FROM 'draft'
       OR v_draft#>>'{audienceDefinition,ruleVersion}' IS DISTINCT FROM p_rule_version
       OR char_length(trim(coalesce(v_draft->>'campaignType', ''))) NOT BETWEEN 1 AND 100
       OR coalesce(v_draft->>'workflowCategory', '') NOT IN ('back_in_stock', 'reorder', 'winback')
       OR char_length(trim(coalesce(v_draft->>'title', ''))) NOT BETWEEN 1 AND 160
       OR char_length(trim(coalesce(v_draft->>'proposedMessage', ''))) NOT BETWEEN 1 AND 1600
       OR jsonb_typeof(v_draft->'recipients') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_draft->'recipients') < 1
       OR jsonb_array_length(v_draft->'recipients') > v_settings.max_recipients_per_campaign
       OR jsonb_typeof(v_draft#>'{audienceDefinition,opportunityDedupeKeys}') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_draft#>'{audienceDefinition,opportunityDedupeKeys}') < 1 THEN
      RAISE EXCEPTION 'campaign_generated_draft_invalid' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_preparation_key, 0));
    SELECT * INTO v_campaign FROM public.sms_campaigns
    WHERE workspace_id = p_workspace_id AND preparation_key = v_preparation_key;
    IF FOUND THEN
      v_reused := v_reused + 1;
      v_campaigns := v_campaigns || jsonb_build_array(to_jsonb(v_campaign));
      CONTINUE;
    END IF;

    -- Lock every referenced opportunity before checking linkage so two
    -- different generation runs cannot attach one opportunity twice.
    FOR v_key IN
      SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      ORDER BY value
    LOOP
      PERFORM 1 FROM public.sms_campaign_opportunities o
      WHERE o.workspace_id = p_workspace_id AND o.dedupe_key = v_key
      FOR UPDATE;
    END LOOP;
    v_expected := jsonb_array_length(v_draft#>'{audienceDefinition,opportunityDedupeKeys}');
    IF jsonb_array_length(v_draft->'recipients') <> v_expected
       OR (
         SELECT count(DISTINCT value)
         FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
       ) <> v_expected
       OR (
         SELECT count(DISTINCT value->'inclusionReason'->>'opportunityDedupeKey')
         FROM jsonb_array_elements(v_draft->'recipients')
       ) <> v_expected THEN
      RAISE EXCEPTION 'campaign_generated_audience_set_invalid' USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO v_available
    FROM public.sms_campaign_opportunities o
    WHERE o.workspace_id = p_workspace_id
      AND o.dedupe_key IN (
        SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      )
      AND o.status = 'open' AND o.created_campaign_id IS NULL;
    IF v_available <> v_expected THEN
      RAISE EXCEPTION 'campaign_opportunity_bundle_conflict' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.sms_campaigns
      (workspace_id, campaign_type, workflow_category, title, status,
       audience_definition, preparation_key, proposed_message, created_by, updated_by)
    VALUES
      (p_workspace_id, left(v_draft->>'campaignType', 100),
       v_draft->>'workflowCategory', trim(v_draft->>'title'), 'draft',
       (v_draft->'audienceDefinition') || jsonb_build_object(
         'preparationID', v_preparation_key, 'ruleVersion', p_rule_version
       ),
       v_preparation_key, trim(v_draft->>'proposedMessage'), p_actor_user_id, p_actor_user_id)
    RETURNING * INTO v_campaign;

    FOR v_recipient IN SELECT value FROM jsonb_array_elements(v_draft->'recipients')
    LOOP
      IF coalesce(v_recipient->>'contactPhone', '') !~ '^\+[1-9][0-9]{7,14}$'
         OR (
           v_recipient->'contactID' IS NOT NULL
           AND jsonb_typeof(v_recipient->'contactID') <> 'null'
           AND coalesce(v_recipient->>'contactID', '') !~ '^[1-9][0-9]*$'
         )
         OR coalesce(v_recipient#>>'{inclusionReason,opportunityDedupeKey}', '') = ''
         OR v_recipient#>>'{inclusionReason,ruleVersion}' IS DISTINCT FROM p_rule_version
         OR (
           v_recipient#>'{inclusionReason,wooCustomerID}' IS NOT NULL
           AND jsonb_typeof(v_recipient#>'{inclusionReason,wooCustomerID}') <> 'null'
           AND coalesce(v_recipient#>>'{inclusionReason,wooCustomerID}', '') !~ '^[1-9][0-9]*$'
         )
         OR coalesce(v_recipient#>>'{inclusionReason,productID}', '') !~ '^[1-9][0-9]*$'
         OR (
           v_recipient#>'{inclusionReason,variationID}' IS NOT NULL
           AND jsonb_typeof(v_recipient#>'{inclusionReason,variationID}') <> 'null'
           AND coalesce(v_recipient#>>'{inclusionReason,variationID}', '') !~ '^(0|[1-9][0-9]*)$'
         ) OR NOT EXISTS (
           SELECT 1 FROM public.sms_campaign_opportunities o
           WHERE o.workspace_id = p_workspace_id
             AND o.dedupe_key = v_recipient#>>'{inclusionReason,opportunityDedupeKey}'
             AND o.dedupe_key IN (
               SELECT value FROM jsonb_array_elements_text(
                 v_draft#>'{audienceDefinition,opportunityDedupeKeys}'
               )
             )
             AND o.structured_context->>'contactPhone' = v_recipient->>'contactPhone'
             AND coalesce(o.structured_context->>'wooCustomerID', '') =
                 coalesce(v_recipient#>>'{inclusionReason,wooCustomerID}', '')
             AND o.structured_context->>'productID' = v_recipient#>>'{inclusionReason,productID}'
             AND coalesce(o.structured_context->>'variationID', '') =
                 coalesce(v_recipient#>>'{inclusionReason,variationID}', '')
         ) THEN
        RAISE EXCEPTION 'campaign_generated_recipient_evidence_invalid' USING ERRCODE = 'P0001';
      END IF;

      INSERT INTO public.sms_campaign_recipients
        (campaign_id, workspace_id, contact_id, contact_phone, inclusion_reason, state)
      VALUES
        (v_campaign.id, p_workspace_id, nullif(v_recipient->>'contactID', '')::bigint,
         v_recipient->>'contactPhone', v_recipient->'inclusionReason', 'draft');
    END LOOP;

    UPDATE public.sms_campaign_opportunities o
    SET status = 'converted_to_draft', created_campaign_id = v_campaign.id, updated_at = now()
    WHERE o.workspace_id = p_workspace_id
      AND o.dedupe_key IN (
        SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      )
      AND o.status = 'open' AND o.created_campaign_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_opportunity_link_failed' USING ERRCODE = 'P0001';
    END IF;

    v_inserted := v_inserted + 1;
    v_campaigns := v_campaigns || jsonb_build_array(to_jsonb(v_campaign));
  END LOOP;

  RETURN jsonb_build_object(
    'campaigns', v_campaigns,
    'insertedCampaigns', v_inserted,
    'reusedCampaigns', v_reused
  );
END;
$function$
;

-- ---------------------------------------------------------------------------
-- record_sms_campaign_provider_acceptance
-- ---------------------------------------------------------------------------
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
$function$
;
