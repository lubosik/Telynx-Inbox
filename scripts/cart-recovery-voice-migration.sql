-- LUKO / Vici abandoned-cart voice recovery.
-- Additive, rerunnable, and OFF by default. Apply after the cart-recovery
-- Growth and attribution migrations. This migration never places a call.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.luko_cart_recoveries') IS NULL
     OR to_regclass('public.luko_cart_recovery_settings') IS NULL
     OR to_regclass('public.luko_cart_recovery_timeline') IS NULL
     OR to_regclass('public.luko_cart_recovered_orders') IS NULL
     OR to_regprocedure('public.append_luko_cart_recovery_timeline(uuid,text,timestamptz,jsonb,bigint)') IS NULL
     OR to_regprocedure('public.persist_luko_cart_recovered_order(jsonb)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='luko_cart_recovery_settings'
         AND column_name='attribution_window_days') THEN
    RAISE EXCEPTION 'cart recovery Growth and attribution migrations must be applied first';
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recovery_settings
  ADD COLUMN IF NOT EXISTS voice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_delay_minutes integer NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS voice_amd_mode text NOT NULL DEFAULT 'premium_ios_call_screening_detection',
  ADD COLUMN IF NOT EXISTS voice_human_answer_mode text NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN IF NOT EXISTS voice_id text,
  ADD COLUMN IF NOT EXISTS voice_name text,
  ADD COLUMN IF NOT EXISTS voice_model_id text NOT NULL DEFAULT 'eleven_turbo_v2_5',
  ADD COLUMN IF NOT EXISTS voice_human_template text NOT NULL DEFAULT 'Hi {{first_name}}, this is an automated message from Vin at Vici Peptides. You left {{product_phrase}} in your cart. I was just wondering if you''re still interested. I sent you a text earlier, so you can pick up where you left off there. To speak with our customer care team, press 1. To stop automated calls, say "stop" or press 9.',
  ADD COLUMN IF NOT EXISTS voice_voicemail_template text NOT NULL DEFAULT 'Hi {{first_name}}, it''s Vin from Vici Peptides. You left {{product_phrase}} in your cart. I was just wondering if you''re still interested. I sent you a text earlier, so you can pick up where you left off there. To stop future automated calls from Vici, call {{voice_opt_out_toll_free_number}}.',
  ADD COLUMN IF NOT EXISTS voice_calling_window_start text NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS voice_calling_window_end text NOT NULL DEFAULT '20:00',
  ADD COLUMN IF NOT EXISTS voice_default_timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS voice_max_attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS voice_cancel_on_active_conversation boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS voice_active_conversation_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS voice_transfer_number text,
  ADD COLUMN IF NOT EXISTS voice_opt_out_toll_free_number text,
  ADD COLUMN IF NOT EXISTS voice_human_timing_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_compliance_approved boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_voice_delay_check'
      AND conrelid='public.luko_cart_recovery_settings'::regclass) THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_voice_delay_check
      CHECK (voice_delay_minutes BETWEEN 15 AND 10080);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_voice_amd_mode_check'
      AND conrelid='public.luko_cart_recovery_settings'::regclass) THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_voice_amd_mode_check CHECK (voice_amd_mode IN
      ('detect','detect_beep','detect_words','greeting_end','premium','premium_ios_call_screening_detection'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_voice_human_mode_check'
      AND conrelid='public.luko_cart_recovery_settings'::regclass) THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_voice_human_mode_check
      CHECK (voice_human_answer_mode IN ('DISABLED','TRANSFER_ONLY','PRERECORDED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_voice_attempt_limit_check'
      AND conrelid='public.luko_cart_recovery_settings'::regclass) THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_voice_attempt_limit_check
      CHECK (voice_max_attempts BETWEEN 1 AND 3);
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recoveries
  ADD COLUMN IF NOT EXISTS voice_marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_voice_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_consent_version text,
  ADD COLUMN IF NOT EXISTS voice_consent_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_timezone text,
  ADD COLUMN IF NOT EXISTS customer_timezone_source text,
  ADD COLUMN IF NOT EXISTS voice_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_status text NOT NULL DEFAULT 'BLOCKED_NO_CONSENT',
  ADD COLUMN IF NOT EXISTS voice_claim_token uuid,
  ADD COLUMN IF NOT EXISTS voice_claim_until timestamptz,
  ADD COLUMN IF NOT EXISTS voice_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_last_failure_code text,
  ADD COLUMN IF NOT EXISTS voice_call_control_id text,
  ADD COLUMN IF NOT EXISTS voice_call_session_id text,
  ADD COLUMN IF NOT EXISTS voice_call_leg_id text,
  ADD COLUMN IF NOT EXISTS voice_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_transfer_connected_at timestamptz;

-- Extend the existing recovered-order model without changing its one-order /
-- one-episode uniqueness guarantees. These constraints are named explicitly
-- so rerunning this migration is deterministic on existing installations.
ALTER TABLE public.luko_cart_recovered_orders
  ADD COLUMN IF NOT EXISTS voice_call_control_id text;
ALTER TABLE public.luko_cart_recovered_orders
  DROP CONSTRAINT IF EXISTS luko_cart_recovered_orders_attribution_method_check;
ALTER TABLE public.luko_cart_recovered_orders
  ADD CONSTRAINT luko_cart_recovered_orders_attribution_method_check CHECK (attribution_method IN (
    'sms_recovery_link','push','voice_transfer_assisted','conversation_assisted','recovery_coupon'
  ));
ALTER TABLE public.luko_cart_recovered_orders
  DROP CONSTRAINT IF EXISTS luko_cart_recovered_orders_recovery_channel_check;
ALTER TABLE public.luko_cart_recovered_orders
  ADD CONSTRAINT luko_cart_recovered_orders_recovery_channel_check
    CHECK (recovery_channel IN ('sms','push','voice','manual'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_voice_status_check'
      AND conrelid='public.luko_cart_recoveries'::regclass) THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_voice_status_check CHECK (voice_status IN (
      'QUEUED','CLAIMED','DRY_RUN','DIALING','INITIATED','ANSWERED','HUMAN_DETECTED','MACHINE_DETECTED',
      'GREETING_END_DETECTED','HUMAN_MESSAGE_PLAYING','HUMAN_MESSAGE_PLAYED','VOICEMAIL_PLAYING','VOICEMAIL_PLAYED',
      'TRANSFER_REQUESTED','TRANSFER_INITIATED','TRANSFER_RINGING','TRANSFER_CONNECTED','TRANSFER_FAILED','TRANSFER_NO_ANSWER',
      'VOICE_OPT_OUT_DTMF','VOICE_OPT_OUT_SPOKEN','BLOCKED_NO_CONSENT','BLOCKED_SUPPRESSED','BLOCKED_CONFIGURATION',
      'DEFERRED_CALLING_WINDOW','CANCELLED_ACTIVE_CONVERSATION','CANCELLED_PURCHASED','CANCELLED_CART_CHANGED',
      'FAILED','RECONCILIATION_REQUIRED','NOT_SURE','FAX_OR_SILENCE'
    ));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS luko_cart_voice_due_idx
  ON public.luko_cart_recoveries(workspace_id,voice_due_at,id)
  WHERE voice_status IN ('QUEUED','DEFERRED_CALLING_WINDOW');
CREATE UNIQUE INDEX IF NOT EXISTS luko_cart_voice_control_idx
  ON public.luko_cart_recoveries(workspace_id,voice_call_control_id)
  WHERE voice_call_control_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.luko_voice_consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'vici',
  contact_phone text NOT NULL CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  event_type text NOT NULL CHECK (event_type IN ('opt_in','opt_out')),
  voice_marketing_consent boolean NOT NULL,
  ai_voice_consent boolean NOT NULL,
  consent_version text NOT NULL,
  disclosure_text text,
  source text NOT NULL,
  source_url text,
  privacy_url text,
  terms_url text,
  occurred_at timestamptz NOT NULL,
  ip_hash text,
  user_agent_hash text,
  wordpress_user_id text,
  evidence_ref text,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS luko_voice_consent_phone_idx
  ON public.luko_voice_consent_events(workspace_id,contact_phone,occurred_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS public.luko_voice_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  contact_phone text NOT NULL CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  reason_code text NOT NULL CHECK (reason_code IN
    ('spoken_stop','dtmf_9','manual_block','national_dnc','compliance_hold','provider_opt_out')),
  source_call_id text,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object')
);
CREATE UNIQUE INDEX IF NOT EXISTS luko_voice_suppressions_active_idx
  ON public.luko_voice_suppressions(workspace_id,contact_phone) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS public.luko_cart_voice_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  recovery_id uuid NOT NULL REFERENCES public.luko_cart_recoveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  state text NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  provider text NOT NULL DEFAULT 'telnyx',
  amd_mode text NOT NULL,
  human_answer_mode text NOT NULL,
  voice_id text NOT NULL,
  voice_model_id text NOT NULL,
  human_template_version text NOT NULL,
  voicemail_template_version text NOT NULL,
  rendered_human_text text NOT NULL,
  rendered_voicemail_text text NOT NULL,
  consent_event_id bigint REFERENCES public.luko_voice_consent_events(id),
  call_control_id text,
  call_session_id text,
  call_leg_id text,
  provider_command_id text NOT NULL,
  provider_call_id text,
  amd_result text,
  answered_at timestamptz,
  amd_decided_at timestamptz,
  first_audio_at timestamptz,
  human_answer_detection_latency_ms integer,
  human_answer_first_audio_latency_ms integer,
  voicemail_played_at timestamptz,
  human_message_played_at timestamptz,
  transfer_requested_at timestamptz,
  transfer_connected_at timestamptz,
  opt_out_at timestamptz,
  opt_out_method text,
  failure_code text,
  initiated_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,recovery_id,attempt_number),
  UNIQUE(workspace_id,provider_command_id),
  UNIQUE(workspace_id,call_control_id)
);
CREATE INDEX IF NOT EXISTS luko_voice_attempt_call_session_idx
  ON public.luko_cart_voice_attempts(workspace_id,call_session_id) WHERE call_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.telnyx_voice_webhook_events (
  provider_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  call_control_id text,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','PROCESSED','FAILED')),
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  delivery_count integer NOT NULL DEFAULT 1,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  last_claimed_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- Keep reruns compatible with an installation that created the ledger from an
-- earlier draft of this migration.
ALTER TABLE public.telnyx_voice_webhook_events
  ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz NOT NULL DEFAULT now();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='telnyx_voice_webhook_delivery_count_check'
        AND conrelid='public.telnyx_voice_webhook_events'::regclass) THEN
    ALTER TABLE public.telnyx_voice_webhook_events
      ADD CONSTRAINT telnyx_voice_webhook_delivery_count_check
      CHECK (delivery_count BETWEEN 1 AND 10);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.record_luko_voice_consent(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id bigint; v_phone text:=nullif(p_event->>'phone','');
  v_workspace text:=coalesce(nullif(p_event->>'workspace_id',''),'vici');
  v_voice boolean:=coalesce((p_event->>'voice_marketing_consent')::boolean,false);
  v_ai boolean:=coalesce((p_event->>'ai_voice_consent')::boolean,false);
  v_granted boolean;
  v_occurred timestamptz:=coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now());
  v_record public.luko_voice_consent_events%ROWTYPE;
  v_latest public.luko_voice_consent_events%ROWTYPE;
BEGIN
  IF v_phone IS NULL OR v_phone !~ '^\+[1-9][0-9]{7,14}$'
     OR nullif(p_event->>'dedupe_key','') IS NULL OR nullif(p_event->>'consent_version','') IS NULL THEN
    RAISE EXCEPTION 'invalid_voice_consent_event' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.luko_voice_consent_events(workspace_id,contact_phone,event_type,
    voice_marketing_consent,ai_voice_consent,consent_version,disclosure_text,source,source_url,
    privacy_url,terms_url,occurred_at,ip_hash,user_agent_hash,wordpress_user_id,evidence_ref,dedupe_key)
  VALUES(v_workspace,v_phone,CASE WHEN v_voice AND v_ai THEN 'opt_in' ELSE 'opt_out' END,
    v_voice,v_ai,p_event->>'consent_version',
    nullif(p_event->>'disclosure_text',''),coalesce(nullif(p_event->>'source',''),'vici_registration'),
    nullif(p_event->>'source_url',''),nullif(p_event->>'privacy_url',''),nullif(p_event->>'terms_url',''),
    v_occurred,nullif(p_event->>'ip_hash',''),nullif(p_event->>'user_agent_hash',''),
    nullif(p_event->>'wordpress_user_id',''),nullif(p_event->>'evidence_ref',''),p_event->>'dedupe_key')
  ON CONFLICT(workspace_id,dedupe_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT * INTO v_record FROM public.luko_voice_consent_events
    WHERE workspace_id=v_workspace AND dedupe_key=p_event->>'dedupe_key' FOR UPDATE;
    IF v_record.contact_phone IS DISTINCT FROM v_phone
       OR v_record.voice_marketing_consent IS DISTINCT FROM v_voice
       OR v_record.ai_voice_consent IS DISTINCT FROM v_ai
       OR v_record.consent_version IS DISTINCT FROM p_event->>'consent_version'
       OR v_record.occurred_at IS DISTINCT FROM v_occurred THEN
      RAISE EXCEPTION 'voice_consent_dedupe_key_reused' USING ERRCODE='P0001';
    END IF;
    v_id:=v_record.id;
  END IF;
  -- A delayed or replayed opt-in must never resurrect consent after a newer
  -- opt-out. Apply only the latest durable evidence to active recoveries.
  SELECT * INTO v_latest FROM public.luko_voice_consent_events
  WHERE workspace_id=v_workspace AND contact_phone=v_phone
  ORDER BY occurred_at DESC,id DESC LIMIT 1;
  v_granted:=v_latest.event_type='opt_in'
    AND v_latest.voice_marketing_consent AND v_latest.ai_voice_consent;
  UPDATE public.luko_cart_recoveries SET
    voice_marketing_consent=v_latest.voice_marketing_consent,
    ai_voice_consent=v_latest.ai_voice_consent,
    voice_consent_version=v_latest.consent_version,voice_consent_occurred_at=v_latest.occurred_at,
    voice_status=CASE WHEN v_granted AND order_id IS NULL AND recovery_expires_at>now() THEN 'QUEUED'
      WHEN NOT v_granted AND voice_started_at IS NULL THEN 'BLOCKED_NO_CONSENT' ELSE voice_status END,
    voice_claim_token=CASE WHEN v_granted THEN voice_claim_token ELSE NULL END,
    voice_claim_until=CASE WHEN v_granted THEN voice_claim_until ELSE NULL END,updated_at=now()
  WHERE workspace_id=v_workspace AND contact_phone=v_phone AND order_id IS NULL;
  RETURN jsonb_build_object('recorded',true,'consent_event_id',v_id,'granted',v_granted);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_luko_cart_voice_calls(p_workspace text,p_limit integer DEFAULT 20)
RETURNS SETOF public.luko_cart_recoveries LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT r.id FROM public.luko_cart_recoveries r
    JOIN public.luko_cart_recovery_settings s ON s.workspace_id=r.workspace_id
    WHERE r.workspace_id=p_workspace AND s.voice_enabled=true
      AND r.voice_marketing_consent=true AND r.ai_voice_consent=true
      AND r.voice_status IN ('QUEUED','DEFERRED_CALLING_WINDOW')
      AND coalesce(r.voice_due_at,r.last_activity_at+make_interval(mins=>s.voice_delay_minutes))<=now()
      AND r.order_id IS NULL AND r.recovery_expires_at>now()
      AND r.voice_attempt_count<s.voice_max_attempts
      AND (r.voice_claim_until IS NULL OR r.voice_claim_until<now())
      AND NOT EXISTS (SELECT 1 FROM public.luko_voice_suppressions x WHERE x.workspace_id=r.workspace_id
        AND x.contact_phone=r.contact_phone AND x.released_at IS NULL)
    ORDER BY coalesce(r.voice_due_at,r.last_activity_at+make_interval(mins=>s.voice_delay_minutes)),r.id
    FOR UPDATE OF r SKIP LOCKED LIMIT greatest(1,least(coalesce(p_limit,20),100))
  ), claimed AS (
    UPDATE public.luko_cart_recoveries r SET voice_status='CLAIMED',voice_claim_token=gen_random_uuid(),
      voice_claim_until=now()+interval '5 minutes',voice_due_at=coalesce(r.voice_due_at,r.last_activity_at+
        make_interval(mins=>(SELECT s.voice_delay_minutes FROM public.luko_cart_recovery_settings s WHERE s.workspace_id=r.workspace_id))),updated_at=now()
    FROM due WHERE r.id=due.id RETURNING r.*
  ) SELECT * FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.defer_luko_cart_voice_call(p_id uuid,p_claim uuid,p_status text,p_reason text,p_due_at timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean; v_status text:=upper(coalesce(p_status,'FAILED'));
BEGIN
  IF v_status NOT IN ('DEFERRED_CALLING_WINDOW','CANCELLED_ACTIVE_CONVERSATION','CANCELLED_PURCHASED',
      'CANCELLED_CART_CHANGED','BLOCKED_NO_CONSENT','BLOCKED_SUPPRESSED','BLOCKED_CONFIGURATION','FAILED','RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'invalid_voice_defer_status' USING ERRCODE='22023';
  END IF;
  UPDATE public.luko_cart_recoveries SET voice_status=v_status,voice_last_failure_code=left(coalesce(p_reason,''),80),
    voice_due_at=coalesce(p_due_at,voice_due_at),voice_claim_token=NULL,voice_claim_until=NULL,updated_at=now()
  WHERE id=p_id AND voice_claim_token=p_claim RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) THEN
    PERFORM public.append_luko_cart_recovery_timeline(p_id,'VOICE_'||v_status,now(),jsonb_build_object('reason',left(coalesce(p_reason,''),80)),NULL);
  END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_luko_cart_voice_call(p_id uuid,p_claim uuid,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE; v_attempt_id uuid; v_number integer;
BEGIN
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
    human_answer_mode,voice_id,voice_model_id,human_template_version,voicemail_template_version,
    rendered_human_text,rendered_voicemail_text,consent_event_id,provider_command_id,initiated_at)
  VALUES(v.workspace_id,v.id,v_number,CASE WHEN coalesce((p_attempt->>'dry_run')::boolean,true) THEN 'DRY_RUN' ELSE 'DIALING' END,
    coalesce((p_attempt->>'dry_run')::boolean,true),p_attempt->>'amd_mode',p_attempt->>'human_answer_mode',
    p_attempt->>'voice_id',p_attempt->>'voice_model_id',p_attempt->>'human_template_version',
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

CREATE OR REPLACE FUNCTION public.finish_luko_cart_voice_dial(p_id uuid,p_claim uuid,p_attempt_id uuid,
  p_call_control_id text,p_call_session_id text,p_call_leg_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean; v public.luko_cart_recoveries%ROWTYPE;
BEGIN
  IF nullif(p_call_control_id,'') IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.luko_cart_voice_attempts WHERE id=p_attempt_id AND recovery_id=p_id
  ) THEN
    RETURN false;
  END IF;
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN false; END IF;
  -- A repeated provider response is safe, but a different call may never take
  -- over an episode after its claim has been released.
  IF v.voice_claim_token IS DISTINCT FROM p_claim THEN
    RETURN coalesce(v.voice_call_control_id=p_call_control_id AND EXISTS (
      SELECT 1 FROM public.luko_cart_voice_attempts
      WHERE id=p_attempt_id AND recovery_id=p_id AND call_control_id=p_call_control_id
    ),false);
  END IF;
  UPDATE public.luko_cart_recoveries SET
    voice_status=CASE WHEN voice_status='DIALING' THEN 'INITIATED' ELSE voice_status END,
    voice_call_control_id=p_call_control_id,
    voice_call_session_id=nullif(p_call_session_id,''),voice_call_leg_id=nullif(p_call_leg_id,''),
    voice_claim_token=NULL,voice_claim_until=NULL,updated_at=now()
  WHERE id=p_id AND voice_claim_token=p_claim RETURNING true INTO v_ok;
  IF NOT coalesce(v_ok,false) THEN RETURN false; END IF;
  UPDATE public.luko_cart_voice_attempts SET
    state=CASE WHEN state='DIALING' THEN 'INITIATED' ELSE state END,call_control_id=p_call_control_id,
    call_session_id=nullif(p_call_session_id,''),call_leg_id=nullif(p_call_leg_id,''),updated_at=now()
  WHERE id=p_attempt_id AND recovery_id=p_id;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_telnyx_voice_event(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_token uuid:=gen_random_uuid(); v_digest text:=p_event->>'payload_digest';
  v_existing text; v_claimed uuid;
BEGIN
  INSERT INTO public.telnyx_voice_webhook_events(provider_event_id,event_type,call_control_id,payload_digest,occurred_at,claim_token)
  VALUES(p_event->>'provider_event_id',p_event->>'event_type',nullif(p_event->>'call_control_id',''),v_digest,
    coalesce(nullif(p_event->>'occurred_at','')::timestamptz,now()),v_token)
  ON CONFLICT(provider_event_id) DO UPDATE SET
    status='PROCESSING',claim_token=v_token,last_error=NULL,processed_at=NULL,
    delivery_count=public.telnyx_voice_webhook_events.delivery_count+1,last_claimed_at=now()
  WHERE public.telnyx_voice_webhook_events.payload_digest=EXCLUDED.payload_digest
    AND public.telnyx_voice_webhook_events.delivery_count<10
    AND (public.telnyx_voice_webhook_events.status='FAILED'
      OR (public.telnyx_voice_webhook_events.status='PROCESSING'
        AND public.telnyx_voice_webhook_events.last_claimed_at<now()-interval '5 minutes'))
  RETURNING claim_token INTO v_claimed;
  IF v_claimed IS NOT NULL THEN
    RETURN jsonb_build_object('claimed',true,'claim_token',v_claimed);
  END IF;
  SELECT payload_digest INTO v_existing FROM public.telnyx_voice_webhook_events WHERE provider_event_id=p_event->>'provider_event_id';
  IF v_existing IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'voice_webhook_event_id_reused' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('claimed',false,'duplicate',true);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_telnyx_voice_event(p_event_id text,p_token uuid,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean;
BEGIN
  UPDATE public.telnyx_voice_webhook_events SET status=CASE WHEN p_error IS NULL THEN 'PROCESSED' ELSE 'FAILED' END,
    last_error=left(p_error,120),processed_at=now() WHERE provider_event_id=p_event_id AND claim_token=p_token
    AND status='PROCESSING' RETURNING true INTO v_ok;
  RETURN coalesce(v_ok,false);
END;
$$;

-- Replace the attribution writer so a deterministically connected live-team
-- transfer can be the single STRONG primary method. A voicemail or human
-- message alone remains only a secondary signal and never earns revenue.
CREATE OR REPLACE FUNCTION public.persist_luko_cart_recovered_order(p_decision jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_recovery public.luko_cart_recoveries%ROWTYPE;
  v_settings public.luko_cart_recovery_settings%ROWTYPE;
  v_existing public.luko_cart_recovered_orders%ROWTYPE;
  v_result public.luko_cart_recovered_orders%ROWTYPE;
  v_paid timestamptz:=nullif(p_decision->>'order_paid_at','')::timestamptz;
  v_action timestamptz:=nullif(p_decision->>'attribution_action_at','')::timestamptz;
  v_method text:=p_decision->>'attribution_method';
  v_strength text:=p_decision->>'attribution_strength';
  v_order text:=nullif(p_decision->>'order_id','');
  v_gross numeric:=nullif(p_decision->>'gross_recovered_revenue','')::numeric;
  v_discount numeric:=coalesce(nullif(p_decision->>'discount_amount','')::numeric,0);
  v_refund numeric:=coalesce(nullif(p_decision->>'refund_amount','')::numeric,0);
  v_net numeric:=nullif(p_decision->>'net_recovered_revenue','')::numeric;
  v_click uuid:=nullif(p_decision->>'recovery_click_id','')::uuid;
  v_new boolean:=false;
BEGIN
  SELECT * INTO v_recovery FROM public.luko_cart_recoveries
  WHERE id=nullif(p_decision->>'recovery_id','')::uuid FOR UPDATE;
  IF v_recovery.id IS NULL OR v_recovery.workspace_id<>p_decision->>'workspace_id'
     OR v_recovery.external_cart_id<>p_decision->>'external_cart_id'
     OR v_recovery.order_id IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION 'cart_attribution_episode_mismatch' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_settings FROM public.luko_cart_recovery_settings WHERE workspace_id=v_recovery.workspace_id;
  IF v_paid IS NULL OR v_action IS NULL OR v_paid<v_action OR v_paid<v_recovery.last_activity_at
     OR v_paid>v_recovery.last_activity_at+make_interval(days=>coalesce(v_settings.attribution_window_days,7))
     OR (v_recovery.recovery_expires_at IS NOT NULL AND v_paid>v_recovery.recovery_expires_at)
     OR p_decision->>'order_status' NOT IN ('processing','completed')
     OR p_decision->>'order_currency' !~ '^[A-Z]{3}$'
     OR v_gross IS NULL OR v_gross<=0 OR v_refund<0 OR v_refund>v_gross OR v_net<>v_gross-v_refund
     OR NOT ((v_method IN ('sms_recovery_link','push') AND v_strength='direct')
       OR (v_method IN ('voice_transfer_assisted','conversation_assisted','recovery_coupon') AND v_strength='strong')) THEN
    RAISE EXCEPTION 'invalid_cart_attribution_decision' USING ERRCODE='P0001';
  END IF;
  IF v_method='sms_recovery_link' AND (
      v_click IS NULL OR v_click IS DISTINCT FROM v_recovery.sms_recovery_click_id
      OR v_recovery.telnyx_message_id IS NULL OR v_recovery.sent_at IS NULL OR v_recovery.dry_run) THEN
    RAISE EXCEPTION 'sms_recovery_evidence_missing' USING ERRCODE='P0001';
  ELSIF v_method='push' AND (
      v_click IS NULL OR v_click IS DISTINCT FROM v_recovery.push_recovery_click_id
      OR v_recovery.push_provider_message_id IS NULL OR v_recovery.push_sent_at IS NULL) THEN
    RAISE EXCEPTION 'push_recovery_evidence_missing' USING ERRCODE='P0001';
  ELSIF v_method='voice_transfer_assisted' AND (
      v_recovery.voice_transfer_connected_at IS NULL
      OR nullif(p_decision->>'voice_call_control_id','') IS DISTINCT FROM v_recovery.voice_call_control_id) THEN
    RAISE EXCEPTION 'voice_transfer_recovery_evidence_missing' USING ERRCODE='P0001';
  ELSIF v_method='conversation_assisted' AND v_recovery.conversation_occurred_at IS NULL THEN
    RAISE EXCEPTION 'conversation_recovery_evidence_missing' USING ERRCODE='P0001';
  ELSIF v_method='recovery_coupon' AND (
      upper(coalesce(p_decision->>'coupon_code',''))<>'VICI15'
      OR (v_recovery.push_sent_at IS NULL AND NOT v_recovery.customer_push_permission)
      OR v_recovery.push_due_at IS NULL OR v_paid<v_recovery.push_due_at) THEN
    RAISE EXCEPTION 'coupon_recovery_evidence_missing' USING ERRCODE='P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_recovery.workspace_id),hashtext(v_order));
  IF EXISTS(
    SELECT 1 FROM public.luko_cart_recovered_orders
    WHERE workspace_id=v_recovery.workspace_id
      AND ((order_id=v_order AND recovery_id<>v_recovery.id)
        OR (recovery_id=v_recovery.id AND order_id<>v_order))
  ) THEN
    RAISE EXCEPTION 'cart_recovered_order_conflict' USING ERRCODE='23505';
  END IF;
  SELECT * INTO v_existing FROM public.luko_cart_recovered_orders
  WHERE workspace_id=v_recovery.workspace_id AND order_id=v_order AND recovery_id=v_recovery.id
  FOR UPDATE;
  v_new:=v_existing.id IS NULL;
  INSERT INTO public.luko_cart_recovered_orders(
    workspace_id,recovery_id,external_cart_id,customer_identity_id,wordpress_user_id,contact_phone,
    original_cart_value,original_cart_currency,message_id,sms_sent_at,sms_delivered_at,
    recovery_click_id,recovery_click_at,push_id,push_sent_at,push_click_at,voice_call_control_id,coupon_code,
    order_id,order_status,order_paid_at,order_currency,gross_recovered_revenue,discount_amount,refund_amount,
    net_recovered_revenue,attribution_method,attribution_strength,attribution_action_at,
    attribution_window_seconds,recovery_channel,abandonment_reason_category,conversation_occurred,
    secondary_signals,evidence_codes,attribution_model_version,financial_observed_at
  ) VALUES(
    v_recovery.workspace_id,v_recovery.id,v_recovery.external_cart_id,v_recovery.customer_identity_id,
    v_recovery.wordpress_user_id,v_recovery.contact_phone,v_recovery.cart_total,v_recovery.currency,
    v_recovery.telnyx_message_id,v_recovery.sent_at,v_recovery.delivered_at,v_click,
    CASE WHEN v_method='sms_recovery_link' THEN v_recovery.clicked_at WHEN v_method='push' THEN v_recovery.push_clicked_at ELSE NULL END,
    v_recovery.push_provider_message_id,v_recovery.push_sent_at,v_recovery.push_clicked_at,
    CASE WHEN v_method='voice_transfer_assisted' THEN v_recovery.voice_call_control_id ELSE nullif(p_decision->>'voice_call_control_id','') END,
    CASE WHEN upper(coalesce(p_decision->>'coupon_code',''))='VICI15' THEN 'VICI15' ELSE NULL END,
    v_order,p_decision->>'order_status',v_paid,p_decision->>'order_currency',v_gross,v_discount,v_refund,v_net,
    v_method,v_strength,v_action,coalesce((p_decision->>'attribution_window_seconds')::integer,0),
    p_decision->>'recovery_channel',nullif(v_recovery.objection_category,'UNKNOWN'),
    coalesce((p_decision->>'conversation_occurred')::boolean,false),
    coalesce(p_decision->'secondary_signals','{}'::jsonb),coalesce(p_decision->'evidence_codes','[]'::jsonb),
    p_decision->>'attribution_model_version',v_paid
  )
  ON CONFLICT(workspace_id,order_id) DO UPDATE SET
    order_status=EXCLUDED.order_status,order_paid_at=EXCLUDED.order_paid_at,order_currency=EXCLUDED.order_currency,
    gross_recovered_revenue=EXCLUDED.gross_recovered_revenue,discount_amount=EXCLUDED.discount_amount,
    refund_amount=EXCLUDED.refund_amount,net_recovered_revenue=EXCLUDED.net_recovered_revenue,
    voice_call_control_id=EXCLUDED.voice_call_control_id,
    secondary_signals=EXCLUDED.secondary_signals,evidence_codes=EXCLUDED.evidence_codes,
    financial_observed_at=greatest(public.luko_cart_recovered_orders.financial_observed_at,EXCLUDED.financial_observed_at),
    updated_at=now()
  WHERE public.luko_cart_recovered_orders.recovery_id=EXCLUDED.recovery_id
  RETURNING * INTO v_result;
  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'cart_recovered_order_conflict' USING ERRCODE='23505';
  END IF;

  UPDATE public.luko_cart_recoveries SET status='recovered',journey_status='CONVERTED',
    attribution_valid=true,attributed_at=coalesce(attributed_at,now()),
    attribution_method=v_method,attribution_strength=v_strength,
    attribution_model_version=p_decision->>'attribution_model_version',updated_at=now()
  WHERE id=v_recovery.id;
  IF v_new THEN
    PERFORM public.append_luko_cart_recovery_timeline(v_recovery.id,'REVENUE_ATTRIBUTED',v_paid,
      jsonb_build_object('order_id',v_order,'method',v_method,'strength',upper(v_strength),
        'gross_revenue',v_gross,'refund_amount',v_refund,'net_revenue',v_net,'currency',p_decision->>'order_currency'),NULL);
  END IF;
  RETURN to_jsonb(v_result);
END;
$$;

CREATE OR REPLACE FUNCTION public.luko_cart_recovery_metrics(p_workspace text DEFAULT 'vici')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'abandoned_carts_identified',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND due_at<=now() AND status NOT IN('emptied','expired')),
    'sms_eligible',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND consent_granted),
    'sms_scheduled',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND status='active'),
    'dry_run_proposals',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND status='dry_run'),
    'sms_sent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND sent_at IS NOT NULL),
    'sms_delivered',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND delivered_at IS NOT NULL),
    'sms_clicked',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND sms_recovery_click_id IS NOT NULL),
    'customer_replies',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND conversation_occurred_at IS NOT NULL),
    'ai_drafts',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND reply_status IN('DRAFT_READY','APPROVED','SENT')),
    'push_scheduled',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_status='QUEUED'),
    'push_blocked',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_status='BLOCKED'),
    'push_sent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_sent_at IS NOT NULL),
    'push_clicked',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_recovery_click_id IS NOT NULL),
    'voice_eligible',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND voice_marketing_consent AND ai_voice_consent),
    'voice_queued',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND voice_status IN('QUEUED','DEFERRED_CALLING_WINDOW','CLAIMED')),
    'voice_initiated',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND dry_run=false),
    'voice_human_detected',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND amd_result LIKE 'human%'),
    'voice_voicemails_played',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND voicemail_played_at IS NOT NULL),
    'voice_transfers_connected',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND transfer_connected_at IS NOT NULL),
    'voice_opt_outs',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND opt_out_at IS NOT NULL),
    'recovered_orders',(SELECT count(*) FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace),
    'recovered_revenue',(SELECT coalesce(sum(net_recovered_revenue),0) FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace),
    'currency',coalesce((SELECT min(order_currency) FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace),'USD'),
    'top_abandonment_reasons',coalesce((SELECT jsonb_agg(x ORDER BY (x->>'count')::int DESC) FROM (
      SELECT jsonb_build_object('category',objection_category,'count',count(*)) x
      FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND objection_category<>'UNKNOWN'
      GROUP BY objection_category LIMIT 12
    ) q),'[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.luko_cart_recovery_analytics(
  p_workspace text,p_start timestamptz,p_end timestamptz,p_page integer DEFAULT 1,p_page_size integer DEFAULT 25
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_abandoned bigint; v_cohort_recovered bigint; v_currency text; v_currency_count integer;
  v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,25),1),100);
  v_total bigint; v_revenue numeric; v_orders bigint; v_result jsonb;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start>=p_end THEN
    RAISE EXCEPTION 'invalid_cart_analytics_range' USING ERRCODE='22023';
  END IF;
  SELECT count(*),count(*) FILTER(WHERE EXISTS(
    SELECT 1 FROM public.luko_cart_recovered_orders a WHERE a.recovery_id=r.id
  )) INTO v_abandoned,v_cohort_recovered
  FROM public.luko_cart_recoveries r
  WHERE r.workspace_id=p_workspace AND r.last_activity_at>=p_start AND r.last_activity_at<p_end;
  SELECT count(*),coalesce(sum(net_recovered_revenue),0),count(DISTINCT order_currency),min(order_currency)
  INTO v_orders,v_revenue,v_currency_count,v_currency
  FROM public.luko_cart_recovered_orders
  WHERE workspace_id=p_workspace AND order_paid_at>=p_start AND order_paid_at<p_end;
  v_total:=v_orders;

  SELECT jsonb_build_object(
    'metrics',jsonb_build_object(
      'recoveredRevenue',CASE WHEN v_currency_count<=1 THEN v_revenue ELSE NULL END,
      'recoveredOrders',v_orders,'abandonedCarts',v_abandoned,
      'recoveryRate',CASE WHEN v_abandoned=0 THEN 0 ELSE round(v_cohort_recovered::numeric*100/v_abandoned,2) END,
      'recoveryRateNumerator',v_cohort_recovered,'recoveryRateDenominator',v_abandoned,
      'smsSent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND sent_at>=p_start AND sent_at<p_end),
      'smsDelivered',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND delivered_at>=p_start AND delivered_at<p_end),
      'recoveryLinkClicks',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND clicked_at>=p_start AND clicked_at<p_end),
      'pushSent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_sent_at>=p_start AND push_sent_at<p_end),
      'pushClicks',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_clicked_at>=p_start AND push_clicked_at<p_end),
      'voiceEligible',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND voice_marketing_consent AND ai_voice_consent AND last_activity_at>=p_start AND last_activity_at<p_end),
      'voiceCallsStarted',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND dry_run=false AND initiated_at>=p_start AND initiated_at<p_end),
      'voiceHumanDetected',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND amd_result LIKE 'human%' AND amd_decided_at>=p_start AND amd_decided_at<p_end),
      'voiceMachineDetected',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND amd_result LIKE 'machine%' AND amd_decided_at>=p_start AND amd_decided_at<p_end),
      'voiceVoicemailsPlayed',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND voicemail_played_at>=p_start AND voicemail_played_at<p_end),
      'voiceTransfersConnected',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND transfer_connected_at>=p_start AND transfer_connected_at<p_end),
      'voiceOptOuts',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND opt_out_at>=p_start AND opt_out_at<p_end),
      'averageHumanFirstAudioMs',(SELECT round(avg(human_answer_first_audio_latency_ms),1) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND human_answer_first_audio_latency_ms IS NOT NULL AND first_audio_at>=p_start AND first_audio_at<p_end),
      'discountRecoveries',(SELECT count(*) FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace AND coupon_code='VICI15' AND order_paid_at>=p_start AND order_paid_at<p_end),
      'averageRecoveredOrderValue',CASE WHEN v_orders=0 OR v_currency_count>1 THEN NULL ELSE round(v_revenue/v_orders,2) END,
      'currency',coalesce(v_currency,'USD'),'mixedCurrencies',v_currency_count>1
    ),
    'funnel',jsonb_build_array(
      jsonb_build_object('key','abandoned','label','Abandoned carts','count',v_abandoned),
      jsonb_build_object('key','sms_eligible','label','SMS eligible','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND consent_granted AND last_activity_at>=p_start AND last_activity_at<p_end)),
      jsonb_build_object('key','sms_sent','label','SMS sent','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND sent_at>=p_start AND sent_at<p_end)),
      jsonb_build_object('key','delivered','label','SMS delivered','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND delivered_at>=p_start AND delivered_at<p_end)),
      jsonb_build_object('key','voice_eligible','label','Voice eligible','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND voice_marketing_consent AND ai_voice_consent AND last_activity_at>=p_start AND last_activity_at<p_end)),
      jsonb_build_object('key','voice_started','label','Voice calls started','count',(SELECT count(*) FROM public.luko_cart_voice_attempts WHERE workspace_id=p_workspace AND dry_run=false AND initiated_at>=p_start AND initiated_at<p_end)),
      jsonb_build_object('key','engaged','label','Clicked, replied or transferred','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND (clicked_at>=p_start AND clicked_at<p_end OR push_clicked_at>=p_start AND push_clicked_at<p_end OR conversation_occurred_at>=p_start AND conversation_occurred_at<p_end OR voice_transfer_connected_at>=p_start AND voice_transfer_connected_at<p_end))),
      jsonb_build_object('key','push_sent','label','Push sent','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_sent_at>=p_start AND push_sent_at<p_end)),
      jsonb_build_object('key','recovered_orders','label','Recovered orders','count',v_orders)
    ),
    'revenueByMethod',coalesce((SELECT jsonb_agg(jsonb_build_object('method',method,'revenue',revenue,'orders',orders,'currency',currency) ORDER BY method) FROM (
      SELECT attribution_method method,sum(net_recovered_revenue) revenue,count(*) orders,min(order_currency) currency
      FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace AND order_paid_at>=p_start AND order_paid_at<p_end GROUP BY attribution_method
    ) b),'[]'::jsonb),
    'orders',coalesce((SELECT jsonb_agg(row_json ORDER BY paid_at DESC,id) FROM (
      SELECT jsonb_build_object(
        'id',a.id,'abandonmentEpisodeId',a.recovery_id,'externalCartId',a.external_cart_id,
        'customerName',coalesce(nullif(r.customer_first_name,''),nullif(r.customer_email,''),'Customer'),
        'products',coalesce((SELECT jsonb_agg(coalesce(nullif(i->>'product_name',''),nullif(i->>'name','Product'))) FROM jsonb_array_elements(r.cart_items) i),'[]'::jsonb),
        'abandonedCartValue',a.original_cart_value,'recoveryMethod',a.attribution_method,
        'channel',a.recovery_channel,'messageId',a.message_id,'pushId',a.push_id,
        'voiceCallControlId',a.voice_call_control_id,'coupon',a.coupon_code,'orderId',a.order_id,
        'grossRecoveredRevenue',a.gross_recovered_revenue,'discountAmount',a.discount_amount,
        'refundAmount',a.refund_amount,'netRecoveredRevenue',a.net_recovered_revenue,'currency',a.order_currency,
        'paidAt',a.order_paid_at,'attributionStrength',a.attribution_strength,
        'conversationOccurred',a.conversation_occurred,'secondarySignals',a.secondary_signals
      ) row_json,a.order_paid_at paid_at,a.id
      FROM public.luko_cart_recovered_orders a JOIN public.luko_cart_recoveries r ON r.id=a.recovery_id
      WHERE a.workspace_id=p_workspace AND a.order_paid_at>=p_start AND a.order_paid_at<p_end
      ORDER BY a.order_paid_at DESC,a.id OFFSET (v_page-1)*v_size LIMIT v_size
    ) rows_page),'[]'::jsonb),
    'pagination',jsonb_build_object('page',v_page,'pageSize',v_size,'total',v_total,'hasMore',v_page*v_size<v_total)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE VIEW public.luko_cart_recovery_journey_list WITH (security_invoker=true) AS
SELECT r.id,r.workspace_id,r.external_cart_id,r.wordpress_user_id,r.customer_email,r.customer_first_name,r.contact_phone,
  r.identity_resolution_ambiguous,r.consent_granted,r.customer_push_permission,
  r.primary_product_name,r.item_count,r.cart_items,r.currency,r.cart_total,r.last_activity_at,r.due_at,r.journey_status,
  r.sms_status,r.reply_status,r.objection_category,r.objection_secondary_category,r.objection_confidence,r.objection_summary,
  r.push_due_at,r.push_status,r.push_destination_type,r.push_destination_url,r.push_coupon_verified_at,r.push_coupon_block_reason,
  r.order_id,r.order_status,r.order_total,r.order_currency,r.status AS attribution_status,r.created_at,r.updated_at,
  a.attribution_method,a.attribution_strength,a.gross_recovered_revenue,a.refund_amount,a.net_recovered_revenue,
  a.order_paid_at,a.attribution_model_version,
  r.voice_marketing_consent,r.ai_voice_consent,r.voice_consent_version,r.voice_due_at,r.voice_status,
  r.voice_attempt_count,r.voice_last_failure_code,r.voice_started_at,r.voice_completed_at,r.voice_transfer_connected_at
FROM public.luko_cart_recoveries r
LEFT JOIN public.luko_cart_recovered_orders a ON a.recovery_id=r.id;

ALTER TABLE public.luko_voice_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_voice_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_cart_voice_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telnyx_voice_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luko_voice_consent_events,public.luko_voice_suppressions,
  public.luko_cart_voice_attempts,public.telnyx_voice_webhook_events FROM public,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.luko_voice_consent_events,public.luko_voice_suppressions,
  public.luko_cart_voice_attempts,public.telnyx_voice_webhook_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.luko_voice_consent_events_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.record_luko_voice_consent(jsonb),public.claim_luko_cart_voice_calls(text,integer),
  public.defer_luko_cart_voice_call(uuid,uuid,text,text,timestamptz),public.begin_luko_cart_voice_call(uuid,uuid,jsonb),
  public.finish_luko_cart_voice_dial(uuid,uuid,uuid,text,text,text),public.claim_telnyx_voice_event(jsonb),
  public.finish_telnyx_voice_event(text,uuid,text),public.persist_luko_cart_recovered_order(jsonb),
  public.luko_cart_recovery_metrics(text),
  public.luko_cart_recovery_analytics(text,timestamptz,timestamptz,integer,integer)
FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_luko_voice_consent(jsonb),public.claim_luko_cart_voice_calls(text,integer),
  public.defer_luko_cart_voice_call(uuid,uuid,text,text,timestamptz),public.begin_luko_cart_voice_call(uuid,uuid,jsonb),
  public.finish_luko_cart_voice_dial(uuid,uuid,uuid,text,text,text),public.claim_telnyx_voice_event(jsonb),
  public.finish_telnyx_voice_event(text,uuid,text),public.persist_luko_cart_recovered_order(jsonb),
  public.luko_cart_recovery_metrics(text),
  public.luko_cart_recovery_analytics(text,timestamptz,timestamptz,integer,integer)
TO service_role;

NOTIFY pgrst,'reload schema';

COMMIT;
