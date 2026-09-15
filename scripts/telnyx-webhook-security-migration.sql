-- Durable Telnyx webhook claim state. Additive and rerunnable.
-- Existing trusted analytics rows are treated as processed historical events.

BEGIN;

ALTER TABLE public.analytics_message_events
  ADD COLUMN IF NOT EXISTS processing_status text,
  ADD COLUMN IF NOT EXISTS processing_token uuid,
  ADD COLUMN IF NOT EXISTS processing_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_error text;

UPDATE public.analytics_message_events
SET processing_status='processed',processed_at=coalesce(processed_at,received_at)
WHERE processing_status IS NULL;

ALTER TABLE public.analytics_message_events
  ALTER COLUMN processing_status SET DEFAULT 'processed',
  ALTER COLUMN processing_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.analytics_message_events'::regclass
      AND conname='analytics_message_events_processing_status_check'
  ) THEN
    ALTER TABLE public.analytics_message_events ADD CONSTRAINT analytics_message_events_processing_status_check
      CHECK (processing_status IN ('processing','processed','failed'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.claim_telnyx_message_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  v_workspace text := coalesce(nullif(p_event->>'workspace_id',''),'vici');
  v_event text := nullif(p_event->>'provider_event_id','');
  v_message text := nullif(p_event->>'message_id','');
  v_type text := nullif(p_event->>'event_type','');
  v_token uuid := gen_random_uuid();
  v_row public.analytics_message_events%ROWTYPE;
BEGIN
  IF v_event IS NULL OR v_message IS NULL OR v_type IS NULL THEN
    RAISE EXCEPTION 'invalid_telnyx_event' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.analytics_message_events (
    workspace_id,provider,provider_event_id,message_id,event_type,status,occurred_at,trusted,
    processing_status,processing_token,processing_lease_until,processing_attempts
  ) VALUES (
    v_workspace,'telnyx',v_event,v_message,v_type,nullif(p_event->>'status',''),
    (p_event->>'occurred_at')::timestamptz,true,'processing',v_token,now()+interval '2 minutes',1
  ) ON CONFLICT (workspace_id,provider,provider_event_id) DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('claimed',true,'token',v_token); END IF;

  SELECT * INTO v_row FROM public.analytics_message_events
  WHERE workspace_id=v_workspace AND provider='telnyx' AND provider_event_id=v_event FOR UPDATE;
  IF v_row.processing_status='processed' THEN
    RETURN jsonb_build_object('claimed',false,'duplicate',true);
  END IF;
  IF v_row.processing_status='processing' AND v_row.processing_lease_until>now() THEN
    RETURN jsonb_build_object('claimed',false,'busy',true);
  END IF;
  UPDATE public.analytics_message_events SET processing_status='processing',processing_token=v_token,
    processing_lease_until=now()+interval '2 minutes',processing_attempts=processing_attempts+1,
    processing_error=NULL,status=coalesce(nullif(p_event->>'status',''),status),
    occurred_at=greatest(occurred_at,(p_event->>'occurred_at')::timestamptz)
  WHERE id=v_row.id;
  RETURN jsonb_build_object('claimed',true,'token',v_token,'retry',true);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_telnyx_message_event(p_event_id text,p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.analytics_message_events SET processing_status='processed',processed_at=now(),
    processing_token=NULL,processing_lease_until=NULL,processing_error=NULL
  WHERE workspace_id='vici' AND provider='telnyx' AND provider_event_id=p_event_id
    AND processing_token=p_token AND processing_status='processing' RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.fail_telnyx_message_event(p_event_id text,p_token uuid,p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.analytics_message_events SET processing_status='failed',processing_token=NULL,
    processing_lease_until=NULL,processing_error=left(coalesce(p_error,'processing_error'),80)
  WHERE workspace_id='vici' AND provider='telnyx' AND provider_event_id=p_event_id
    AND processing_token=p_token AND processing_status='processing' RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.claim_telnyx_message_event(jsonb),
  public.finish_telnyx_message_event(text,uuid),public.fail_telnyx_message_event(text,uuid,text)
  FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_telnyx_message_event(jsonb),
  public.finish_telnyx_message_event(text,uuid),public.fail_telnyx_message_event(text,uuid,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
