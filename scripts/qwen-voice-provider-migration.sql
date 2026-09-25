-- LUKO / Vici provider-aware abandoned-cart voices.
-- Additive and rerunnable. Apply AFTER cart-recovery-voice-migration.sql and
-- BEFORE deploying the matching backend. This migration does not create a
-- voice, place a call, change the selected voice, or enable automation.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.luko_cart_recovery_settings') IS NULL
     OR to_regclass('public.luko_cart_voice_attempts') IS NULL
     OR to_regprocedure('public.begin_luko_cart_voice_call(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'scripts/cart-recovery-voice-migration.sql must be applied first';
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recovery_settings
  ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'elevenlabs';

ALTER TABLE public.luko_cart_voice_attempts
  ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'elevenlabs';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='luko_cart_recovery_settings_voice_provider_check'
        AND conrelid='public.luko_cart_recovery_settings'::regclass) THEN
    ALTER TABLE public.luko_cart_recovery_settings
      ADD CONSTRAINT luko_cart_recovery_settings_voice_provider_check
      CHECK (voice_provider IN ('elevenlabs','qwen'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='luko_cart_voice_attempts_voice_provider_check'
        AND conrelid='public.luko_cart_voice_attempts'::regclass) THEN
    ALTER TABLE public.luko_cart_voice_attempts
      ADD CONSTRAINT luko_cart_voice_attempts_voice_provider_check
      CHECK (voice_provider IN ('elevenlabs','qwen'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.begin_luko_cart_voice_call(p_id uuid,p_claim uuid,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE; v_attempt_id uuid; v_number integer;
  v_voice_provider text:=lower(coalesce(nullif(p_attempt->>'voice_provider',''),'elevenlabs'));
BEGIN
  IF v_voice_provider NOT IN ('elevenlabs','qwen') THEN
    RAISE EXCEPTION 'invalid_voice_provider' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL OR v.voice_claim_token IS DISTINCT FROM p_claim OR v.order_id IS NOT NULL
     OR NOT v.voice_marketing_consent OR NOT v.ai_voice_consent OR v.voice_status<>'CLAIMED'
     OR v.voice_attempt_count >= coalesce((SELECT s.voice_max_attempts
       FROM public.luko_cart_recovery_settings s WHERE s.workspace_id=v.workspace_id),0)
     OR EXISTS (SELECT 1 FROM public.luko_voice_suppressions x
       WHERE x.workspace_id=v.workspace_id AND x.contact_phone=v.contact_phone AND x.released_at IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM public.luko_voice_consent_events e
       WHERE e.id=nullif(p_attempt->>'consent_event_id','')::bigint
         AND e.workspace_id=v.workspace_id AND e.contact_phone=v.contact_phone
         AND e.event_type='opt_in' AND e.voice_marketing_consent AND e.ai_voice_consent
         AND NOT EXISTS (
           SELECT 1 FROM public.luko_voice_consent_events newer
           WHERE newer.workspace_id=e.workspace_id AND newer.contact_phone=e.contact_phone
             AND (newer.occurred_at,newer.id)>(e.occurred_at,e.id)
         )
     ) THEN
    RETURN jsonb_build_object('allowed',false);
  END IF;
  v_number:=v.voice_attempt_count+1;
  INSERT INTO public.luko_cart_voice_attempts(workspace_id,recovery_id,attempt_number,state,dry_run,amd_mode,
    human_answer_mode,voice_provider,voice_id,voice_model_id,human_template_version,voicemail_template_version,
    rendered_human_text,rendered_voicemail_text,consent_event_id,provider_command_id,initiated_at)
  VALUES(v.workspace_id,v.id,v_number,CASE WHEN coalesce((p_attempt->>'dry_run')::boolean,true) THEN 'DRY_RUN' ELSE 'DIALING' END,
    coalesce((p_attempt->>'dry_run')::boolean,true),p_attempt->>'amd_mode',p_attempt->>'human_answer_mode',
    v_voice_provider,p_attempt->>'voice_id',p_attempt->>'voice_model_id',p_attempt->>'human_template_version',
    p_attempt->>'voicemail_template_version',p_attempt->>'rendered_human_text',p_attempt->>'rendered_voicemail_text',
    nullif(p_attempt->>'consent_event_id','')::bigint,p_attempt->>'provider_command_id',now()) RETURNING id INTO v_attempt_id;
  UPDATE public.luko_cart_recoveries SET voice_status=CASE WHEN coalesce((p_attempt->>'dry_run')::boolean,true) THEN 'DRY_RUN' ELSE 'DIALING' END,
    voice_attempt_count=v_number,voice_started_at=now(),voice_claim_until=now()+interval '5 minutes',updated_at=now() WHERE id=v.id;
  PERFORM public.append_luko_cart_recovery_timeline(v.id,CASE WHEN coalesce((p_attempt->>'dry_run')::boolean,true)
    THEN 'VOICE_DRY_RUN' ELSE 'VOICE_DIAL_STARTED' END,now(),jsonb_build_object('attempt_id',v_attempt_id),NULL);
  RETURN jsonb_build_object('allowed',true,'dry_run',coalesce((p_attempt->>'dry_run')::boolean,true),
    'attempt_id',v_attempt_id,'attempt_number',v_number);
END;
$$;

COMMIT;
