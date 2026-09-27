-- Additive controls for approved, scheduled campaign-backed automations.
-- Run once in Supabase SQL editor before deploying the matching backend.
-- Pausing/cancelling fences new provider attempts. An attempt already started
-- with Telnyx cannot be recalled and remains in its original audit state.
BEGIN;

ALTER TABLE public.sms_campaigns DROP CONSTRAINT IF EXISTS sms_campaigns_status_check;
ALTER TABLE public.sms_campaigns ADD CONSTRAINT sms_campaigns_status_check
  CHECK (status IN ('draft', 'review_required', 'approval_pending', 'approved',
                   'scheduled', 'sending', 'paused', 'completed', 'rejected',
                   'cancelled', 'failed'));
ALTER TABLE public.sms_campaigns ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE public.sms_campaigns ADD COLUMN IF NOT EXISTS paused_by bigint REFERENCES public.sms_users(id);

CREATE OR REPLACE FUNCTION public.cancel_sms_campaign_recipient(
  p_campaign_id uuid, p_recipient_id uuid, p_workspace_id text, p_actor_user_id bigint
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_campaign public.sms_campaigns%ROWTYPE;
        v_recipient public.sms_campaign_recipients%ROWTYPE;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status NOT IN ('scheduled', 'sending', 'paused') THEN
    RAISE EXCEPTION 'campaign_recipient_not_cancellable' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND campaign_id = p_campaign_id
    AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_recipient.state = 'cancelled' THEN RETURN v_recipient; END IF;
  IF v_recipient.selected IS NOT TRUE OR v_recipient.state NOT IN ('pending', 'deferred', 'claimed')
      OR v_recipient.provider_attempt_started_at IS NOT NULL
      OR v_recipient.provider_message_id IS NOT NULL OR v_recipient.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'campaign_recipient_already_sending' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.sms_campaign_recipients SET state = 'cancelled', claim_token = NULL,
    claimed_at = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
    updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id RETURNING * INTO v_recipient;
  UPDATE public.sms_commercial_contact_ledger SET reservation_expires_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND campaign_id = p_campaign_id
    AND recipient_id = p_recipient_id AND accepted_at IS NULL
    AND reservation_expires_at > now();
  RETURN v_recipient;
END; $$;

CREATE OR REPLACE FUNCTION public.pause_sms_campaign(
  p_campaign_id uuid, p_workspace_id text, p_actor_user_id bigint
) RETURNS public.sms_campaigns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_campaign public.sms_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status = 'paused' THEN RETURN v_campaign; END IF;
  IF v_campaign.status NOT IN ('scheduled', 'sending') THEN
    RAISE EXCEPTION 'campaign_not_pausable' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.sms_campaigns SET status = 'paused', paused_at = now(),
    paused_by = p_actor_user_id, updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id RETURNING * INTO v_campaign;
  UPDATE public.sms_campaign_recipients SET state = 'pending', claim_token = NULL,
    claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
    AND state = 'claimed' AND provider_attempt_started_at IS NULL;
  UPDATE public.sms_commercial_contact_ledger SET reservation_expires_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND campaign_id = p_campaign_id
    AND accepted_at IS NULL AND reservation_expires_at > now()
    AND recipient_id IN (
      SELECT id FROM public.sms_campaign_recipients
      WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
        AND state IN ('pending', 'deferred', 'claimed')
        AND provider_attempt_started_at IS NULL
    );
  RETURN v_campaign;
END; $$;

CREATE OR REPLACE FUNCTION public.resume_sms_campaign(
  p_campaign_id uuid, p_workspace_id text, p_actor_user_id bigint,
  p_scheduled_for timestamptz
) RETURNS public.sms_campaigns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_campaign public.sms_campaigns%ROWTYPE;
        v_remaining integer;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'paused' THEN RAISE EXCEPTION 'campaign_not_paused' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_for IS NULL OR p_scheduled_for < now() + interval '1 minute' THEN
    RAISE EXCEPTION 'campaign_schedule_time_invalid' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.sms_campaign_recipients SET state = 'pending', claim_token = NULL,
    claimed_at = NULL, claim_expires_at = NULL, planned_send_at = p_scheduled_for,
    next_attempt_at = p_scheduled_for, updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
    AND selected = true AND state IN ('pending', 'deferred', 'claimed')
    AND provider_attempt_started_at IS NULL;
  GET DIAGNOSTICS v_remaining = ROW_COUNT;
  IF v_remaining = 0 THEN RAISE EXCEPTION 'campaign_has_no_pending_recipients' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.sms_campaigns SET status = 'scheduled', scheduled_for = p_scheduled_for,
    scheduled_by = p_actor_user_id, paused_at = NULL, paused_by = NULL,
    updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id RETURNING * INTO v_campaign;
  RETURN v_campaign;
END; $$;

REVOKE ALL ON FUNCTION public.cancel_sms_campaign_recipient(uuid,uuid,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_sms_campaign(uuid,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_sms_campaign(uuid,text,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_sms_campaign_recipient(uuid,uuid,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_sms_campaign(uuid,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_sms_campaign(uuid,text,bigint,timestamptz) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
