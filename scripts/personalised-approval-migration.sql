-- ============================================================================
-- scripts/personalised-approval-migration.sql
--
-- Stop approval from overwriting per-person messages with the template.
--
-- Paste this whole file into the Supabase SQL editor. Every line is SQL or a
-- SQL comment, so there is nothing to trim. Safe to run twice.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
--
-- prepare_sms_campaign_approval currently does this, for every recipient:
--
--     rendered_message = v_campaign.final_message
--
-- The same string, copied to every row. The delivery worker then sends
-- rendered_message verbatim and deliberately refuses to build any text of its
-- own, so approving a campaign whose copy says "Hi {{first_name}}" sends the
-- literal characters
--
--     Hi {{first_name}}, ... use {{code}} for 15% off
--
-- to every customer on the list. On the staged win-back that is 376 people
-- receiving visibly broken mail merge. Nothing downstream catches it: the
-- template is valid copy, the audience is real, the send gate is about consent
-- and quiet hours, and the worker's only refusal is an EMPTY rendered_message,
-- which this never is.
--
-- ── WHAT THIS CHANGES ───────────────────────────────────────────────────────
--
-- The API now renders one message per recipient BEFORE calling this function,
-- and writes it to rendered_message itself. So the function stops writing that
-- column and starts CHECKING it:
--
--   * p_personalised = false  (default, unchanged behaviour)
--       Every selected recipient gets final_message, exactly as before. This
--       is what a campaign with no merge fields still wants.
--
--   * p_personalised = true
--       rendered_message is left alone, and approval is REFUSED unless every
--       selected recipient already has a non-empty one. A campaign that half
--       rendered must not be approvable: the missing half would reach the
--       delivery worker with nothing to send, be logged as
--       rendered_message_empty, and silently never arrive.
--
-- Either way the guarantee that matters is unchanged. What a person approves
-- is frozen at approval and is what the customer receives. The only difference
-- is whether "what was approved" is one string or one string per person.
--
-- ── ROLLING BACK ────────────────────────────────────────────────────────────
--
-- Re-run the previous definition from scripts/campaigns-migration.sql. The
-- new parameter has a default, so old callers keep working and nothing else
-- needs reverting.
-- ============================================================================

BEGIN;

-- ── The discount a {{code}} is worth ────────────────────────────────────────
--
-- Needed because the coupon is minted at approval and something has to say
-- what percentage to mint it for. The alternative considered and rejected was
-- reading the number out of the copy: "15% off" is easy to parse and easy to
-- get wrong, and a parser that misreads "50%" as "5%" mints the wrong coupon
-- for every recipient with no error anywhere.
--
-- NULL means the campaign names no code, which is most of them. A campaign
-- whose template uses {{code}} and whose discount_percent is NULL falls back
-- to the application default rather than minting something arbitrary.
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS discount_percent smallint
  CONSTRAINT sms_campaigns_discount_percent_range
  CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent < 100));

CREATE OR REPLACE FUNCTION public.prepare_sms_campaign_approval(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_revision integer,
  p_audience_hash text,
  p_message_hash text,
  p_personalised boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_count integer;
  v_unrendered integer;
  v_approval_id bigint;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'review_required' OR v_campaign.revision <> p_revision THEN
    RAISE EXCEPTION 'campaign_revision_not_reviewable' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(trim(coalesce(v_campaign.final_message, ''))) = 0
     OR char_length(trim(coalesce(p_audience_hash, ''))) = 0
     OR char_length(trim(coalesce(p_message_hash, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_approval_evidence_incomplete' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_count FROM public.sms_campaign_recipients
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id AND selected = true;
  IF v_count = 0 THEN RAISE EXCEPTION 'campaign_audience_empty' USING ERRCODE = 'P0001'; END IF;

  IF p_personalised THEN
    -- Refuse rather than fill the gap. A recipient with no rendered message is
    -- one the renderer could not personalise, and the correct outcome is that
    -- the operator sees it and deselects them, not that they silently receive
    -- the raw template with {{first_name}} in it.
    SELECT count(*) INTO v_unrendered FROM public.sms_campaign_recipients
    WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
      AND selected = true
      AND char_length(trim(coalesce(rendered_message, ''))) = 0;
    IF v_unrendered > 0 THEN
      RAISE EXCEPTION 'campaign_personalisation_incomplete: % selected recipients have no rendered message', v_unrendered
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.sms_campaign_recipients
    SET approved_in_audience = selected,
        approval_revision = p_revision,
        updated_at = now()
    WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id;
  ELSE
    UPDATE public.sms_campaign_recipients
    SET approved_in_audience = selected,
        approval_revision = p_revision,
        rendered_message = v_campaign.final_message,
        updated_at = now()
    WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id;
  END IF;

  INSERT INTO public.sms_campaign_approvals
    (workspace_id, campaign_id, revision, actor_user_id, decision, audience_hash, message_hash, recipient_count)
  VALUES
    (p_workspace_id, p_campaign_id, p_revision, p_actor_user_id, 'approved', p_audience_hash, p_message_hash, v_count)
  ON CONFLICT (campaign_id, revision, decision) DO UPDATE
    SET actor_user_id = public.sms_campaign_approvals.actor_user_id
    WHERE public.sms_campaign_approvals.workspace_id = EXCLUDED.workspace_id
      AND public.sms_campaign_approvals.audience_hash = EXCLUDED.audience_hash
      AND public.sms_campaign_approvals.message_hash = EXCLUDED.message_hash
      AND public.sms_campaign_approvals.recipient_count = EXCLUDED.recipient_count
  RETURNING id INTO v_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_approval_record_mismatch' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaigns
  SET status = 'approval_pending', approved_by = p_actor_user_id,
      approved_at = now(), approval_audit_recorded_at = NULL, updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id;

  -- The first three keys are exactly what the previous definition returned and
  -- are load-bearing for the approval-retry path in lib/campaigns/service.js.
  -- `personalised` is additive.
  RETURN jsonb_build_object(
    'campaign_id', p_campaign_id,
    'revision', p_revision,
    'recipient_count', v_count,
    'personalised', p_personalised
  );
END;
$$;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Should list the function with SEVEN arguments, the last being p_personalised.
SELECT p.proname,
       pg_get_function_arguments(p.oid) AS arguments
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'prepare_sms_campaign_approval';
