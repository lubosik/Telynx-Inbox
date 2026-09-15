-- LUKO WooCommerce abandoned-cart recovery.
-- Additive and rerunnable. Applies after campaigns-migration.sql and analytics-migration.sql.
-- It records carts and dry-run/live attempts, but never enables delivery by itself.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.sms_consent_events') IS NULL THEN
    RAISE EXCEPTION 'campaigns-migration.sql must be applied first';
  END IF;
  IF to_regclass('public.analytics_message_events') IS NULL THEN
    RAISE EXCEPTION 'analytics-migration.sql must be applied first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.luko_cart_connector_events (
  workspace_id text NOT NULL DEFAULT 'vici',
  event_id text NOT NULL,
  event_type text NOT NULL,
  external_cart_id text,
  body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, event_id)
);

CREATE TABLE IF NOT EXISTS public.luko_cart_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  external_cart_id text NOT NULL,
  wordpress_user_id text,
  contact_phone text,
  consent_granted boolean NOT NULL DEFAULT false,
  consent_occurred_at timestamptz,
  event_version bigint NOT NULL DEFAULT 0 CHECK (event_version >= 0),
  cart_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cart_items) = 'array'),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  cart_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (cart_total >= 0),
  recovery_ciphertext text,
  recovery_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active','emptied','clicked','dry_run','sending','sent','delivered','failed',
    'ordered','paid','recovered','suppressed','expired','reconciliation_required'
  )),
  last_activity_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  clicked_at timestamptz,
  proposed_at timestamptz,
  send_started_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  telnyx_message_id text,
  message_ciphertext text,
  dry_run boolean NOT NULL DEFAULT true,
  claim_token uuid,
  claim_until timestamptz,
  send_attempts integer NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  last_failure_code text,
  order_id text,
  order_status text,
  order_total numeric(14,2),
  order_currency text,
  order_created_at timestamptz,
  order_paid_at timestamptz,
  attribution_valid boolean NOT NULL DEFAULT false,
  attributed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_cart_id),
  UNIQUE (workspace_id, telnyx_message_id),
  CONSTRAINT luko_cart_phone_e164 CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE INDEX IF NOT EXISTS luko_cart_recoveries_due_idx
  ON public.luko_cart_recoveries (workspace_id, due_at)
  WHERE status = 'active' AND consent_granted = true;
CREATE INDEX IF NOT EXISTS luko_cart_recoveries_message_idx
  ON public.luko_cart_recoveries (workspace_id, telnyx_message_id)
  WHERE telnyx_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS luko_cart_recoveries_order_idx
  ON public.luko_cart_recoveries (workspace_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.apply_luko_cart_event(p_event jsonb, p_digest text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace text := p_event->>'workspace_id';
  v_event_id text := p_event->>'event_id';
  v_type text := p_event->>'event_type';
  v_cart text := nullif(p_event->>'external_cart_id', '');
  v_existing_digest text;
  v_phone text := nullif(p_event->>'phone', '');
  v_customer text := nullif(p_event->>'customer_id', '');
  v_occurred timestamptz := (p_event->>'occurred_at')::timestamptz;
  v_version bigint := coalesce((p_event->>'version')::bigint, 0);
  v_granted boolean := coalesce((p_event#>>'{consent,granted}')::boolean, false);
BEGIN
  INSERT INTO public.luko_cart_connector_events (
    workspace_id,event_id,event_type,external_cart_id,body_digest,occurred_at
  ) VALUES (v_workspace,v_event_id,v_type,v_cart,p_digest,v_occurred)
  ON CONFLICT (workspace_id,event_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT body_digest INTO v_existing_digest
    FROM public.luko_cart_connector_events
    WHERE workspace_id=v_workspace AND event_id=v_event_id;
    IF v_existing_digest <> p_digest THEN
      RAISE EXCEPTION 'connector_event_id_reused' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('accepted',true,'duplicate',true);
  END IF;

  IF v_type = 'consent.updated' THEN
    IF v_phone IS NOT NULL THEN
      INSERT INTO public.sms_consent_events (
        workspace_id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,
        occurred_at,metadata,dedupe_key
      ) VALUES (
        v_workspace,v_phone,CASE WHEN v_granted THEN 'opt_in' ELSE 'opt_out' END,
        'promotional_sms',v_workspace,coalesce(nullif(p_event#>>'{consent,source}',''),'vici_registration'),
        CASE WHEN v_granted THEN 'wordpress-event:' || v_event_id ELSE NULL END,
        coalesce((p_event#>>'{consent,occurred_at}')::timestamptz,v_occurred),
        jsonb_build_object(
          'disclosure_version',p_event#>>'{consent,version}',
          'source_url',p_event#>>'{consent,source_url}',
          'privacy_url',p_event#>>'{consent,privacy_url}',
          'terms_url',p_event#>>'{consent,terms_url}',
          'ip_hash',p_event#>>'{consent,ip_hash}',
          'user_agent_hash',p_event#>>'{consent,user_agent_hash}',
          'disclosure_sha256',encode(digest(coalesce(p_event#>>'{consent,disclosure}',''),'sha256'),'hex')
        ), 'wordpress:' || v_event_id
      ) ON CONFLICT (workspace_id,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      UPDATE public.luko_cart_recoveries SET
        consent_granted=v_granted,
        consent_occurred_at=coalesce((p_event#>>'{consent,occurred_at}')::timestamptz,v_occurred),
        status=CASE WHEN NOT v_granted AND status IN ('active','clicked') THEN 'suppressed' ELSE status END,
        updated_at=now()
      WHERE workspace_id=v_workspace AND wordpress_user_id=v_customer
        AND status NOT IN ('ordered','paid','recovered');
    END IF;
    RETURN jsonb_build_object('accepted',true,'duplicate',false,'event_type',v_type);
  END IF;

  IF v_type = 'cart.updated' THEN
    INSERT INTO public.luko_cart_recoveries (
      workspace_id,external_cart_id,wordpress_user_id,contact_phone,consent_granted,
      consent_occurred_at,event_version,cart_items,currency,cart_total,recovery_ciphertext,
      recovery_expires_at,status,last_activity_at,due_at,dry_run
    ) VALUES (
      v_workspace,v_cart,v_customer,v_phone,v_granted,
      nullif(p_event#>>'{consent,occurred_at}','')::timestamptz,v_version,
      coalesce(p_event->'items','[]'::jsonb),p_event->>'currency',(p_event->>'total')::numeric,
      p_event->>'recovery_ciphertext',(p_event->>'expires_at')::timestamptz,
      CASE WHEN v_granted THEN 'active' ELSE 'suppressed' END,
      (p_event->>'last_activity_at')::timestamptz,
      (p_event->>'last_activity_at')::timestamptz + interval '30 minutes',true
    )
    ON CONFLICT (workspace_id,external_cart_id) DO UPDATE SET
      wordpress_user_id=EXCLUDED.wordpress_user_id,
      contact_phone=EXCLUDED.contact_phone,
      consent_granted=EXCLUDED.consent_granted,
      consent_occurred_at=EXCLUDED.consent_occurred_at,
      event_version=EXCLUDED.event_version,
      cart_items=EXCLUDED.cart_items,currency=EXCLUDED.currency,cart_total=EXCLUDED.cart_total,
      recovery_ciphertext=EXCLUDED.recovery_ciphertext,recovery_expires_at=EXCLUDED.recovery_expires_at,
      status=CASE WHEN EXCLUDED.consent_granted THEN 'active' ELSE 'suppressed' END,
      last_activity_at=EXCLUDED.last_activity_at,due_at=EXCLUDED.due_at,
      claim_token=NULL,claim_until=NULL,proposed_at=NULL,send_started_at=NULL,message_ciphertext=NULL,
      dry_run=true,last_failure_code=NULL,updated_at=now()
    WHERE EXCLUDED.event_version > public.luko_cart_recoveries.event_version
      AND public.luko_cart_recoveries.status NOT IN ('ordered','paid','recovered','sending','sent','delivered','failed','reconciliation_required');
  ELSIF v_type IN ('cart.emptied','cart.clicked') THEN
    UPDATE public.luko_cart_recoveries SET
      event_version=greatest(event_version,v_version),
      status=CASE WHEN v_type='cart.emptied' THEN 'emptied'
                  WHEN status IN ('active','sent','delivered') THEN 'clicked' ELSE status END,
      clicked_at=CASE WHEN v_type='cart.clicked' THEN coalesce(clicked_at,v_occurred) ELSE clicked_at END,
      claim_token=NULL,claim_until=NULL,updated_at=now()
    WHERE workspace_id=v_workspace AND external_cart_id=v_cart
      AND v_version >= event_version AND status NOT IN ('ordered','paid','recovered');
  ELSIF v_type = 'order.created' THEN
    INSERT INTO public.luko_cart_recoveries (
      workspace_id,external_cart_id,wordpress_user_id,event_version,status,last_activity_at,due_at,
      order_id,order_status,order_total,order_currency,order_created_at,attribution_valid
    ) VALUES (
      v_workspace,v_cart,v_customer,v_version,'ordered',v_occurred,v_occurred,
      p_event#>>'{order,order_id}',p_event#>>'{order,status}',(p_event#>>'{order,total}')::numeric,
      p_event#>>'{order,currency}',v_occurred,coalesce((p_event#>>'{order,attribution_valid}')::boolean,false)
    )
    ON CONFLICT (workspace_id,external_cart_id) DO UPDATE SET
      status='ordered',order_id=EXCLUDED.order_id,order_status=EXCLUDED.order_status,
      order_total=EXCLUDED.order_total,order_currency=EXCLUDED.order_currency,
      order_created_at=least(coalesce(public.luko_cart_recoveries.order_created_at,EXCLUDED.order_created_at),EXCLUDED.order_created_at),
      attribution_valid=EXCLUDED.attribution_valid,claim_token=NULL,claim_until=NULL,updated_at=now();
  ELSIF v_type = 'order.paid' THEN
    UPDATE public.luko_cart_recoveries SET
      status=CASE WHEN dry_run=false AND delivered_at IS NOT NULL AND clicked_at IS NOT NULL
                       AND coalesce((p_event#>>'{order,attribution_valid}')::boolean,false)
                       AND (p_event#>>'{order,paid_at}')::timestamptz <= clicked_at + interval '24 hours'
                  THEN 'recovered' ELSE 'paid' END,
      order_id=p_event#>>'{order,order_id}',order_status=p_event#>>'{order,status}',
      order_total=(p_event#>>'{order,total}')::numeric,order_currency=p_event#>>'{order,currency}',
      order_paid_at=(p_event#>>'{order,paid_at}')::timestamptz,
      attribution_valid=coalesce((p_event#>>'{order,attribution_valid}')::boolean,false),updated_at=now()
    WHERE workspace_id=v_workspace AND external_cart_id=v_cart;
  END IF;
  RETURN jsonb_build_object('accepted',true,'duplicate',false,'event_type',v_type,'external_cart_id',v_cart);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_luko_cart_recoveries(p_workspace text,p_limit integer DEFAULT 20)
RETURNS SETOF public.luko_cart_recoveries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.luko_cart_recoveries
    WHERE workspace_id=p_workspace AND status='active' AND consent_granted=true
      AND due_at <= now() AND recovery_expires_at > now()
      AND (claim_until IS NULL OR claim_until < now())
    ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT least(greatest(p_limit,1),100)
  )
  UPDATE public.luko_cart_recoveries r SET claim_token=gen_random_uuid(),claim_until=now()+interval '2 minutes',updated_at=now()
  FROM due WHERE r.id=due.id RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.defer_luko_cart_recovery(p_id uuid,p_claim uuid,p_reason text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries SET claim_token=NULL,claim_until=NULL,
    due_at=greatest(due_at,now()+interval '5 minutes'),last_failure_code=left(p_reason,80),updated_at=now()
  WHERE id=p_id AND claim_token=p_claim AND status='active' RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.begin_luko_cart_recovery(
  p_id uuid,p_claim uuid,p_version bigint,p_dry_run boolean,p_live_allowed boolean,p_message_ciphertext text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL OR v.claim_token<>p_claim OR v.event_version<>p_version OR v.status<>'active'
     OR NOT v.consent_granted OR v.order_id IS NOT NULL OR v.recovery_expires_at<=now() THEN
    RETURN jsonb_build_object('allowed',false,'reason','state_changed');
  END IF;
  IF p_dry_run OR NOT p_live_allowed THEN
    UPDATE public.luko_cart_recoveries SET status='dry_run',dry_run=true,proposed_at=now(),
      message_ciphertext=p_message_ciphertext,claim_token=NULL,claim_until=NULL,updated_at=now() WHERE id=p_id;
    RETURN jsonb_build_object('allowed',true,'dry_run',true);
  END IF;
  UPDATE public.luko_cart_recoveries SET status='sending',dry_run=false,proposed_at=now(),send_started_at=now(),
    send_attempts=send_attempts+1,message_ciphertext=p_message_ciphertext,updated_at=now() WHERE id=p_id;
  RETURN jsonb_build_object('allowed',true,'dry_run',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_luko_cart_recovery(p_id uuid,p_claim uuid,p_message_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries SET status=CASE WHEN status='sending' THEN 'sent' ELSE status END,
    telnyx_message_id=p_message_id,sent_at=now(),
    claim_token=NULL,claim_until=NULL,updated_at=now()
  WHERE id=p_id AND send_started_at IS NOT NULL AND telnyx_message_id IS NULL
    AND ((status='sending' AND claim_token=p_claim) OR status IN ('ordered','paid')) RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.cancel_luko_cart_recovery_send(p_id uuid,p_claim uuid,p_reason text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries SET status='suppressed',last_failure_code=left(p_reason,80),
    claim_token=NULL,claim_until=NULL,updated_at=now()
  WHERE id=p_id AND claim_token=p_claim AND status='sending' AND telnyx_message_id IS NULL RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_send_uncertain(p_id uuid,p_claim uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries SET status='reconciliation_required',last_failure_code='provider_result_uncertain',
    claim_token=NULL,claim_until=NULL,updated_at=now()
  WHERE id=p_id AND claim_token=p_claim AND status='sending' AND telnyx_message_id IS NULL RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_delivery(p_message_id text,p_status text,p_occurred_at timestamptz)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries SET
    status=CASE
      WHEN p_status='delivered' AND status IN ('paid','ordered') AND clicked_at IS NOT NULL AND attribution_valid
        AND order_paid_at IS NOT NULL AND order_paid_at <= clicked_at + interval '24 hours' THEN 'recovered'
      WHEN p_status='delivered' AND status IN ('sent','sending') THEN 'delivered'
      WHEN p_status='failed' AND status IN ('sent','sending') THEN 'failed'
      ELSE status END,
    delivered_at=CASE WHEN p_status='delivered' THEN coalesce(delivered_at,p_occurred_at) ELSE delivered_at END,
    last_failure_code=CASE WHEN p_status='failed' THEN 'provider_failed' ELSE last_failure_code END,updated_at=now()
  WHERE telnyx_message_id=p_message_id AND dry_run=false RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.luko_cart_recovery_metrics(p_workspace text DEFAULT 'vici')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'abandoned_carts_identified',count(*) FILTER (WHERE due_at<=now() AND status NOT IN ('emptied','suppressed','expired')),
    'sms_eligible',count(*) FILTER (WHERE consent_granted),
    'sms_scheduled',count(*) FILTER (WHERE status='active'),
    'dry_run_proposals',count(*) FILTER (WHERE status='dry_run'),
    'sms_sent',count(*) FILTER (WHERE dry_run=false AND sent_at IS NOT NULL),
    'sms_delivered',count(*) FILTER (WHERE dry_run=false AND delivered_at IS NOT NULL),
    'sms_clicked',count(*) FILTER (WHERE dry_run=false AND clicked_at IS NOT NULL),
    'recovered_orders',count(*) FILTER (WHERE status='recovered'),
    'recovered_revenue',coalesce(sum(order_total) FILTER (WHERE status='recovered'),0),
    'currency',coalesce(min(order_currency) FILTER (WHERE status='recovered'),'USD')
  ) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace;
$$;

ALTER TABLE public.luko_cart_connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_cart_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luko_cart_connector_events,public.luko_cart_recoveries FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.apply_luko_cart_event(jsonb,text),public.claim_luko_cart_recoveries(text,integer),
  public.defer_luko_cart_recovery(uuid,uuid,text),public.begin_luko_cart_recovery(uuid,uuid,bigint,boolean,boolean,text),
  public.finish_luko_cart_recovery(uuid,uuid,text),public.cancel_luko_cart_recovery_send(uuid,uuid,text),
  public.mark_luko_cart_send_uncertain(uuid,uuid),
  public.mark_luko_cart_delivery(text,text,timestamptz),
  public.luko_cart_recovery_metrics(text) FROM public,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.luko_cart_connector_events,public.luko_cart_recoveries TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_luko_cart_event(jsonb,text),public.claim_luko_cart_recoveries(text,integer),
  public.defer_luko_cart_recovery(uuid,uuid,text),public.begin_luko_cart_recovery(uuid,uuid,bigint,boolean,boolean,text),
  public.finish_luko_cart_recovery(uuid,uuid,text),public.cancel_luko_cart_recovery_send(uuid,uuid,text),
  public.mark_luko_cart_send_uncertain(uuid,uuid),
  public.mark_luko_cart_delivery(text,text,timestamptz),
  public.luko_cart_recovery_metrics(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
