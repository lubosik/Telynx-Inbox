-- ═══════════════════════════════════════════════════════════════════════════
-- delete_sms_campaign: "malformed array literal"
--
-- Archiving an approved campaign failed with:
--
--   CAMPAIGN_DELETE_FAILED  malformed array literal: "approved"
--
-- v_blockers is text[], and `text[] || 'approved'` with an UNTYPED literal
-- resolves to anyarray || anyarray, so Postgres tries to parse "approved" as
-- array syntax and throws. The one append that worked,
--
--   v_blockers := v_blockers || ('status_' || v_campaign.status);
--
-- worked only because the right-hand side is a known text expression, which
-- picks anyarray || anyelement instead. The other ten were bare literals.
--
-- Every blocker except the status one was therefore unreachable: any campaign
-- that had been approved, scheduled, submitted, or had touched a recipient,
-- a message, the ledger or an attribution crashed the whole function. Only a
-- pristine draft could ever be archived or deleted, which is why this went
-- unnoticed until the first approved campaign was archived.
--
-- Idempotent: CREATE OR REPLACE of the same function with ::text casts.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_sms_campaign(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_mode text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_blockers text[] := ARRAY[]::text[];
  v_recipients integer := 0;
  v_has_attribution boolean := false;
BEGIN
  IF coalesce(p_mode, 'auto') NOT IN ('auto', 'archive') THEN
    RAISE EXCEPTION 'campaign_delete_mode_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_campaign.status <> 'draft' THEN
    v_blockers := v_blockers || ('status_' || v_campaign.status);
  END IF;
  IF v_campaign.approved_at IS NOT NULL OR v_campaign.approval_audit_recorded_at IS NOT NULL THEN
    v_blockers := v_blockers || 'approved'::text;
  END IF;
  IF v_campaign.scheduled_for IS NOT NULL THEN
    v_blockers := v_blockers || 'scheduled'::text;
  END IF;
  IF v_campaign.submitted_for_review_at IS NOT NULL THEN
    v_blockers := v_blockers || 'submitted_for_review'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_campaign_approvals WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'approval_history'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_campaign_recipient_events WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'recipient_events'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_commercial_contact_ledger WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'commercial_contact_ledger'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_messages WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'linked_messages'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_sent_log WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'linked_sent_log'::text;
  END IF;
  -- Any recipient that reached, or started reaching, a provider.
  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_recipients
    WHERE campaign_id = p_campaign_id
      AND (provider_message_id IS NOT NULL
        OR provider_idempotency_key IS NOT NULL
        OR provider_attempt_started_at IS NOT NULL
        OR sent_at IS NOT NULL
        OR delivered_at IS NOT NULL
        OR failed_at IS NOT NULL
        OR state IN ('claimed', 'sending', 'sent', 'delivered', 'failed', 'reconciliation_required'))
  ) THEN
    v_blockers := v_blockers || 'recipient_reached_provider'::text;
  END IF;
  -- revenue_attributions is created by scripts/analytics-migration.sql, which
  -- may not be applied yet. Probe dynamically rather than failing to compile.
  IF to_regclass('public.revenue_attributions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.revenue_attributions WHERE campaign_id = $1)'
      INTO v_has_attribution USING p_campaign_id;
    IF v_has_attribution THEN
      v_blockers := v_blockers || 'revenue_attribution'::text;
    END IF;
  END IF;

  IF p_mode = 'archive' OR array_length(v_blockers, 1) IS NOT NULL THEN
    UPDATE public.sms_campaigns
    SET archived_at = coalesce(archived_at, now()),
        archived_by = coalesce(archived_by, p_actor_user_id),
        archive_reason = coalesce(archive_reason, left(nullif(trim(coalesce(p_reason, '')), ''), 500)),
        updated_by = p_actor_user_id,
        updated_at = now()
    WHERE id = p_campaign_id AND workspace_id = p_workspace_id;
    RETURN jsonb_build_object(
      'outcome', 'archived',
      'campaignId', p_campaign_id,
      'blockers', to_jsonb(v_blockers),
      'title', v_campaign.title,
      'status', v_campaign.status
    );
  END IF;

  SELECT count(*) INTO v_recipients FROM public.sms_campaign_recipients
  WHERE campaign_id = p_campaign_id;

  -- Recipients cascade; nothing else references a never-approved draft.
  DELETE FROM public.sms_campaign_opportunities
  WHERE workspace_id = p_workspace_id AND created_campaign_id = p_campaign_id;
  DELETE FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'outcome', 'deleted',
    'campaignId', p_campaign_id,
    'blockers', to_jsonb(ARRAY[]::text[]),
    'title', v_campaign.title,
    'status', v_campaign.status,
    'recipientsRemoved', v_recipients
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE SAME BUG, IN THE SEGMENT FUNCTION
--
-- delete_sms_campaign_segment builds its blockers the same way and had six
-- untyped literals. It IS live in production, despite the repo notes marking
-- segment-lifecycle-migration.sql as unapplied — checked against pg_proc
-- rather than the docs.
--
-- So archiving a segment that a campaign had used, or that the engine had
-- ever recomputed, failed exactly like the campaign one.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_sms_campaign_segment(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_mode text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_blockers text[] := ARRAY[]::text[];
  v_members integer := 0;
BEGIN
  IF coalesce(p_mode, 'auto') NOT IN ('auto', 'archive') THEN
    RAISE EXCEPTION 'segment_delete_mode_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Already archived means somebody already chose to keep it. A second request
  -- must not quietly upgrade that decision into a destruction.
  IF v_segment.archived_at IS NOT NULL THEN
    v_blockers := v_blockers || 'already_archived'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaigns c
    WHERE c.workspace_id = p_workspace_id
      AND (c.audience_definition->>'segmentId' = p_segment_id::text
        OR c.audience_definition->>'segment_id' = p_segment_id::text)
  ) THEN
    v_blockers := v_blockers || 'campaign_reference'::text;
  END IF;

  IF v_segment.last_computed_at IS NOT NULL OR v_segment.last_run_id IS NOT NULL THEN
    v_blockers := v_blockers || 'engine_has_run'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_runs WHERE segment_id = p_segment_id
  ) THEN
    v_blockers := v_blockers || 'recompute_history'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_overrides WHERE segment_id = p_segment_id
  ) THEN
    v_blockers := v_blockers || 'override_history'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_members
    WHERE segment_id = p_segment_id
      AND nullif(trim(coalesce(inclusion_evidence->>'reason', '')), '') IS NOT NULL
  ) THEN
    v_blockers := v_blockers || 'member_reasons'::text;
  END IF;

  IF p_mode = 'archive' OR array_length(v_blockers, 1) IS NOT NULL THEN
    UPDATE public.sms_campaign_segments
    SET archived_at = coalesce(archived_at, now()),
        archived_by = coalesce(archived_by, p_actor_user_id),
        archive_reason = coalesce(archive_reason, left(nullif(trim(coalesce(p_reason, '')), ''), 500)),
        updated_by = p_actor_user_id,
        updated_at = now()
    WHERE id = p_segment_id AND workspace_id = p_workspace_id;
    RETURN jsonb_build_object(
      'outcome', 'archived',
      'segmentId', p_segment_id,
      'blockers', to_jsonb(v_blockers),
      'name', v_segment.name,
      'kind', v_segment.segment_kind,
      'membersRemoved', 0
    );
  END IF;

  SELECT count(*) INTO v_members FROM public.sms_campaign_segment_members
  WHERE segment_id = p_segment_id;

  -- Members, overrides and runs all cascade from the segment row. Only the
  -- member rows can exist at this point; the other two are blockers above.
  DELETE FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'outcome', 'deleted',
    'segmentId', p_segment_id,
    'blockers', to_jsonb(ARRAY[]::text[]),
    'name', v_segment.name,
    'kind', v_segment.segment_kind,
    'membersRemoved', v_members
  );
END;
$$;