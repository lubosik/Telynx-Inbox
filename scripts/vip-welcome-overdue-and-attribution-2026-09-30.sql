-- VIP welcome overdue queue repair and per-message order-tracking policy.
-- Run in the Vici Supabase SQL editor. This does not send SMS.
-- Fail-closed: an unexpected live function or queue aborts the transaction.
BEGIN;

DO $repair$
DECLARE
  claim_definition text;
  begin_definition text;
  claim_patched text;
  begin_patched text;
  stale_count integer;
BEGIN
  SELECT pg_get_functiondef('public.claim_sms_campaign_recipients(text,integer,integer)'::regprocedure)
    INTO claim_definition;
  SELECT pg_get_functiondef('public.begin_sms_campaign_provider_attempt(uuid,text,uuid,integer)'::regprocedure)
    INTO begin_definition;

  -- The three scheduled-only checks are the suppression pass, candidate
  -- selection and cadence-reservation insert. All three must change together.
  IF (length(claim_definition) - length(replace(claim_definition, 'c.status = ''scheduled''', '')))
      / length('c.status = ''scheduled''') <> 3
     OR position('v_campaign.status <> ''scheduled''' in begin_definition) = 0 THEN
    RAISE EXCEPTION 'Live send gates differ from the reviewed version; no changes applied';
  END IF;

  claim_patched := replace(claim_definition, 'c.status = ''scheduled''',
    'c.status IN (''scheduled'', ''sending'')');
  -- Only the claim candidate loop gets the VIP send-hour fence. This keeps
  -- consent/suppression checks active even outside that hour.
  IF position('AND r.workspace_id = p_workspace_id' || chr(10) ||
              '      AND r.state IN (''pending'', ''deferred'')' in claim_patched) = 0 THEN
    RAISE EXCEPTION 'Claim candidate loop changed; no changes applied';
  END IF;
  claim_patched := replace(claim_patched,
    'AND r.workspace_id = p_workspace_id' || chr(10) ||
    '      AND r.state IN (''pending'', ''deferred'')',
    'AND r.workspace_id = p_workspace_id' || chr(10) ||
    '      AND (c.workflow_category <> ''vip_welcome'' OR (' ||
    '(now() AT TIME ZONE v_settings.business_timezone)::time >= TIME ''18:00'' AND ' ||
    '(now() AT TIME ZONE v_settings.business_timezone)::time < TIME ''19:00''))' || chr(10) ||
    '      AND r.state IN (''pending'', ''deferred'')');
  EXECUTE claim_patched;

  begin_patched := replace(begin_definition,
    'v_campaign.status <> ''scheduled''',
    'v_campaign.status NOT IN (''scheduled'', ''sending'')');
  IF position('IF NOT FOUND THEN RAISE EXCEPTION ''campaign_live_send_disabled'' USING ERRCODE = ''P0001''; END IF;'
              in begin_patched) = 0 THEN
    RAISE EXCEPTION 'Provider attempt settings gate changed; no changes applied';
  END IF;
  begin_patched := replace(begin_patched,
    'IF NOT FOUND THEN RAISE EXCEPTION ''campaign_live_send_disabled'' USING ERRCODE = ''P0001''; END IF;',
    'IF NOT FOUND THEN RAISE EXCEPTION ''campaign_live_send_disabled'' USING ERRCODE = ''P0001''; END IF;' || chr(10) ||
    '  IF v_campaign.workflow_category = ''vip_welcome'' AND NOT (' ||
    '(now() AT TIME ZONE v_settings.business_timezone)::time >= TIME ''18:00'' AND ' ||
    '(now() AT TIME ZONE v_settings.business_timezone)::time < TIME ''19:00'') THEN' || chr(10) ||
    '    RAISE EXCEPTION ''vip_welcome_outside_send_hour'' USING ERRCODE = ''P0001'';' || chr(10) ||
    '  END IF;');
  EXECUTE begin_patched;

  SELECT count(*) INTO stale_count
  FROM public.sms_campaign_recipients
  WHERE campaign_id = 'ca4c86d5-bf8a-45d2-8c81-05f9d278a68d'::uuid
    AND workspace_id = 'vici' AND state = 'pending' AND selected = true
    AND provider_message_id IS NULL AND sent_at IS NULL;
  IF stale_count <> 4 THEN
    RAISE EXCEPTION 'Expected 4 untouched VIP welcomes; found %. Reinspect live queue.', stale_count;
  END IF;
END;
$repair$;

-- For each still-pending person, select the first local 6 p.m. that clears
-- existing 24-hour, 7-day and 30-day promotional frequency caps. The
-- America/New_York timezone handles daylight-saving changes automatically.
WITH settings AS (
  SELECT * FROM public.sms_campaign_settings WHERE workspace_id = 'vici'
), pending AS (
  SELECT r.id, r.contact_phone
  FROM public.sms_campaign_recipients r
  WHERE r.campaign_id = 'ca4c86d5-bf8a-45d2-8c81-05f9d278a68d'::uuid
    AND r.workspace_id = 'vici' AND r.state = 'pending' AND r.selected = true
    AND r.provider_message_id IS NULL AND r.sent_at IS NULL
), first_slot AS (
  SELECT p.id, slots.slot
  FROM pending p CROSS JOIN settings s
  CROSS JOIN LATERAL (
    SELECT ((d.local_day::date + TIME '18:00') AT TIME ZONE s.business_timezone) AS slot
    FROM generate_series((now() AT TIME ZONE s.business_timezone)::date,
      (now() AT TIME ZONE s.business_timezone)::date + 45,
      interval '1 day') AS d(local_day)
  ) slots
  WHERE slots.slot > now() + interval '1 minute'
    AND NOT EXISTS (
      SELECT 1 FROM public.sms_commercial_contact_ledger l
      WHERE l.workspace_id = 'vici' AND l.contact_phone = p.contact_phone
        AND l.classification = 'promotional'
        AND coalesce(l.accepted_at, l.reserved_at) >
            slots.slot - make_interval(hours => s.minimum_promotional_spacing_hours)
        AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slots.slot)
    )
    AND (SELECT count(*) FROM public.sms_commercial_contact_ledger l
      WHERE l.workspace_id = 'vici' AND l.contact_phone = p.contact_phone
        AND l.classification = 'promotional'
        AND coalesce(l.accepted_at, l.reserved_at) > slots.slot - interval '7 days'
        AND coalesce(l.accepted_at, l.reserved_at) <= slots.slot
        AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slots.slot))
        < s.max_promotional_per_7_days
    AND (SELECT count(*) FROM public.sms_commercial_contact_ledger l
      WHERE l.workspace_id = 'vici' AND l.contact_phone = p.contact_phone
        AND l.classification = 'promotional'
        AND coalesce(l.accepted_at, l.reserved_at) > slots.slot - interval '30 days'
        AND coalesce(l.accepted_at, l.reserved_at) <= slots.slot
        AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slots.slot))
        < s.max_promotional_per_30_days
  GROUP BY p.id, slots.slot
), chosen AS (
  SELECT id, min(slot) AS slot FROM first_slot GROUP BY id
)
UPDATE public.sms_campaign_recipients r
SET planned_send_at = chosen.slot, next_attempt_at = chosen.slot, updated_at = now()
FROM chosen WHERE r.id = chosen.id AND r.state = 'pending';

DO $$
BEGIN
  IF (SELECT count(*) FROM public.sms_campaign_recipients
      WHERE campaign_id = 'ca4c86d5-bf8a-45d2-8c81-05f9d278a68d'::uuid
        AND workspace_id = 'vici' AND state = 'pending'
        AND next_attempt_at > now()) <> 4 THEN
    RAISE EXCEPTION 'Could not assign a safe future 6 p.m. slot to all four recipients';
  END IF;
END; $$;

-- Run before each delivery claim. A missed send window or a frequency-cap
-- hold is recalculated instead of leaving a past date in the app forever.
CREATE OR REPLACE FUNCTION public.reschedule_overdue_vip_welcomes(
  p_workspace_id text DEFAULT 'vici'
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_recipient record;
  v_slot timestamptz;
  v_count integer := 0;
BEGIN
  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR v_recipient IN
    SELECT r.id, r.contact_phone
    FROM public.sms_campaign_recipients r
    JOIN public.sms_campaigns c ON c.id = r.campaign_id
    WHERE r.workspace_id = p_workspace_id
      AND c.workflow_category = 'vip_welcome'
      AND c.status IN ('scheduled', 'sending')
      AND r.state IN ('pending', 'deferred') AND r.selected = true
      AND r.provider_message_id IS NULL AND r.sent_at IS NULL
      AND coalesce(r.next_attempt_at, r.planned_send_at) < now() - interval '1 hour'
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    SELECT slot INTO v_slot
    FROM (
      SELECT ((d.local_day::date + TIME '18:00') AT TIME ZONE v_settings.business_timezone) AS slot
      FROM generate_series((now() AT TIME ZONE v_settings.business_timezone)::date,
        (now() AT TIME ZONE v_settings.business_timezone)::date + 45,
        interval '1 day') AS d(local_day)
    ) future
    WHERE slot > now() + interval '1 minute'
      AND NOT EXISTS (
        SELECT 1 FROM public.sms_commercial_contact_ledger l
        WHERE l.workspace_id = p_workspace_id AND l.contact_phone = v_recipient.contact_phone
          AND l.classification = 'promotional'
          AND coalesce(l.accepted_at, l.reserved_at) >
              slot - make_interval(hours => v_settings.minimum_promotional_spacing_hours)
          AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slot)
      )
      AND (SELECT count(*) FROM public.sms_commercial_contact_ledger l
        WHERE l.workspace_id = p_workspace_id AND l.contact_phone = v_recipient.contact_phone
          AND l.classification = 'promotional'
          AND coalesce(l.accepted_at, l.reserved_at) > slot - interval '7 days'
          AND coalesce(l.accepted_at, l.reserved_at) <= slot
          AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slot))
          < v_settings.max_promotional_per_7_days
      AND (SELECT count(*) FROM public.sms_commercial_contact_ledger l
        WHERE l.workspace_id = p_workspace_id AND l.contact_phone = v_recipient.contact_phone
          AND l.classification = 'promotional'
          AND coalesce(l.accepted_at, l.reserved_at) > slot - interval '30 days'
          AND coalesce(l.accepted_at, l.reserved_at) <= slot
          AND (l.accepted_at IS NOT NULL OR l.reservation_expires_at > slot))
          < v_settings.max_promotional_per_30_days
    ORDER BY slot LIMIT 1;

    IF v_slot IS NOT NULL THEN
      UPDATE public.sms_campaign_recipients
      SET planned_send_at = v_slot, next_attempt_at = v_slot, updated_at = now()
      WHERE id = v_recipient.id AND workspace_id = p_workspace_id;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.reschedule_overdue_vip_welcomes(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_overdue_vip_welcomes(text) TO service_role;

-- A shared VIP15 code or a purchase after a welcome is not a deterministic
-- conversion. The existing attribution generator will record a verified
-- per-recipient delivery followed by a paid order as Influenced only.
ALTER TABLE public.campaign_attribution_policies
  DROP CONSTRAINT IF EXISTS campaign_attribution_policies_workflow_category_check;
ALTER TABLE public.campaign_attribution_policies
  ADD CONSTRAINT campaign_attribution_policies_workflow_category_check
  CHECK (workflow_category IN (
    'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
    'reorder', 'reorder_personal', 'reorder_personal_high', 'winback',
    'manual_exact_product', 'manual', 'generic_promotion', 'vip_welcome'
  ));
INSERT INTO public.campaign_attribution_policies (
  workspace_id, workflow_category, policy_version, methodology_version,
  strong_window_seconds, maximum_window_seconds, product_identity_required,
  allowed_direct_evidence, active, activation_reason, activated_at
)
SELECT 'vici', 'vip_welcome', 1, 'vici-campaign-revenue-v1',
       259200, 259200, false, '{}'::text[], true,
       'Verified delivery and matching paid customer; temporal influence only, not direct attribution.', now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaign_attribution_policies
  WHERE workspace_id = 'vici' AND workflow_category = 'vip_welcome' AND active = true
)
ON CONFLICT (workspace_id, workflow_category, policy_version) DO NOTHING;

COMMIT;

-- Verification only. Four future rows should appear after the transaction.
SELECT id, state, planned_send_at,
       planned_send_at AT TIME ZONE 'America/New_York' AS new_york_send_time
FROM public.sms_campaign_recipients
WHERE campaign_id = 'ca4c86d5-bf8a-45d2-8c81-05f9d278a68d'::uuid
  AND state = 'pending'
ORDER BY planned_send_at;
