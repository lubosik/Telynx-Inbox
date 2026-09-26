-- Vici Campaigns: safely move a campaign that has not begun sending.
-- Additive and rerunnable. Apply after scripts/campaigns-migration.sql and
-- before deploying the matching backend. This migration sends no messages and
-- changes no existing schedule by itself.

BEGIN;

CREATE OR REPLACE FUNCTION public.reschedule_sms_campaign(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_scheduled_for timestamptz
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_transitioned integer;
BEGIN
  IF p_scheduled_for IS NULL OR p_scheduled_for < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'campaign_schedule_time_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'scheduled' OR v_campaign.approval_audit_recorded_at IS NULL THEN
    RAISE EXCEPTION 'campaign_not_reschedulable' USING ERRCODE = 'P0001';
  END IF;

  -- Once a provider attempt has begun, moving the remaining rows could split
  -- one approved campaign across two send times. Refuse the whole change.
  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_recipients r
    WHERE r.campaign_id = p_campaign_id AND r.workspace_id = p_workspace_id
      AND r.selected = true AND r.approved_in_audience = true
      AND r.approval_revision = v_campaign.revision
      AND (
        r.state IN ('claimed','sending','sent','delivered','reconciliation_required')
        OR r.provider_attempt_started_at IS NOT NULL
        OR r.provider_message_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'campaign_delivery_already_started' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaign_recipients
  SET planned_send_at = p_scheduled_for,
      next_attempt_at = p_scheduled_for,
      claim_token = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
    AND selected = true AND approved_in_audience = true
    AND approval_revision = v_campaign.revision
    AND state IN ('pending','deferred');
  GET DIAGNOSTICS v_transitioned = ROW_COUNT;
  IF v_transitioned = 0 THEN
    RAISE EXCEPTION 'campaign_has_no_pending_recipients' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaigns
  SET scheduled_for = p_scheduled_for,
      scheduled_by = p_actor_user_id,
      updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_campaign;

  RETURN v_campaign;
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_sms_campaign(uuid,text,bigint,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_sms_campaign(uuid,text,bigint,timestamptz)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
