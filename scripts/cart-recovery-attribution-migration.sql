-- LUKO / Vici abandoned-cart revenue attribution and dedicated Analytics.
-- Additive and rerunnable. Apply after cart-recovery-growth-migration.sql.
-- This migration never enables live SMS or push delivery.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.luko_cart_recoveries') IS NULL
     OR to_regclass('public.luko_cart_recovery_settings') IS NULL THEN
    RAISE EXCEPTION 'cart-recovery-growth-migration.sql must be applied first';
  END IF;
  IF to_regprocedure('public.stage_revenue_attribution_candidate(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'attribution-reconciliation-migration.sql must be applied first';
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recovery_settings
  ADD COLUMN IF NOT EXISTS attribution_window_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS push_shop_attribution_window_hours integer NOT NULL DEFAULT 24;

UPDATE public.luko_cart_recovery_settings
SET discount_code='VICI15',
    push_body_template=replace(push_body_template,'Vici15','VICI15')
WHERE lower(discount_code)='vici15';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_attribution_window_check') THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_cart_attribution_window_check
      CHECK (attribution_window_days BETWEEN 1 AND 30);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_push_shop_window_check') THEN
    ALTER TABLE public.luko_cart_recovery_settings ADD CONSTRAINT luko_cart_push_shop_window_check
      CHECK (push_shop_attribution_window_hours BETWEEN 1 AND 168);
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recoveries
  ADD COLUMN IF NOT EXISTS sms_recovery_click_id uuid,
  ADD COLUMN IF NOT EXISTS push_recovery_click_id uuid,
  ADD COLUMN IF NOT EXISTS conversation_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS attribution_method text,
  ADD COLUMN IF NOT EXISTS attribution_strength text,
  ADD COLUMN IF NOT EXISTS attribution_model_version text;

CREATE UNIQUE INDEX IF NOT EXISTS luko_cart_sms_click_unique
  ON public.luko_cart_recoveries(workspace_id,sms_recovery_click_id)
  WHERE sms_recovery_click_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS luko_cart_push_click_unique
  ON public.luko_cart_recoveries(workspace_id,push_recovery_click_id)
  WHERE push_recovery_click_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.luko_cart_recovered_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  recovery_id uuid NOT NULL REFERENCES public.luko_cart_recoveries(id) ON DELETE RESTRICT,
  external_cart_id text NOT NULL,
  customer_identity_id uuid,
  wordpress_user_id text,
  contact_phone text,
  original_cart_value numeric(14,2) NOT NULL CHECK (original_cart_value>=0),
  original_cart_currency text NOT NULL CHECK (original_cart_currency~'^[A-Z]{3}$'),
  message_id text,
  sms_sent_at timestamptz,
  sms_delivered_at timestamptz,
  recovery_click_id uuid,
  recovery_click_at timestamptz,
  push_id text,
  push_sent_at timestamptz,
  push_click_at timestamptz,
  coupon_code text,
  order_id text NOT NULL,
  order_status text NOT NULL,
  order_paid_at timestamptz NOT NULL,
  order_currency text NOT NULL CHECK (order_currency~'^[A-Z]{3}$'),
  gross_recovered_revenue numeric(14,2) NOT NULL CHECK (gross_recovered_revenue>=0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount>=0),
  refund_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (refund_amount>=0),
  net_recovered_revenue numeric(14,2) NOT NULL CHECK (
    net_recovered_revenue>=0 AND net_recovered_revenue=gross_recovered_revenue-refund_amount
  ),
  attribution_method text NOT NULL CHECK (attribution_method IN (
    'sms_recovery_link','push','conversation_assisted','recovery_coupon'
  )),
  attribution_strength text NOT NULL CHECK (attribution_strength IN ('direct','strong')),
  attribution_action_at timestamptz NOT NULL,
  attribution_window_seconds integer NOT NULL CHECK (attribution_window_seconds>=0),
  recovery_channel text NOT NULL CHECK (recovery_channel IN ('sms','push','manual')),
  abandonment_reason_category text,
  conversation_occurred boolean NOT NULL DEFAULT false,
  secondary_signals jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(secondary_signals)='object'),
  evidence_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_codes)='array'),
  attribution_model_version text NOT NULL,
  financial_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,order_id),
  UNIQUE(workspace_id,recovery_id)
);

CREATE INDEX IF NOT EXISTS luko_cart_recovered_paid_idx
  ON public.luko_cart_recovered_orders(workspace_id,order_paid_at DESC,id);
CREATE INDEX IF NOT EXISTS luko_cart_recovered_method_idx
  ON public.luko_cart_recovered_orders(workspace_id,attribution_method,order_paid_at DESC);

CREATE OR REPLACE FUNCTION public.record_luko_cart_recovery_click(p_event jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_channel text:=p_event->>'click_channel'; v_click uuid:=nullif(p_event->>'recovery_click_id','')::uuid;
BEGIN
  IF v_click IS NULL OR v_channel NOT IN ('sms','push') THEN RETURN false; END IF;
  UPDATE public.luko_cart_recoveries SET
    sms_recovery_click_id=CASE WHEN v_channel='sms' THEN v_click ELSE sms_recovery_click_id END,
    push_recovery_click_id=CASE WHEN v_channel='push' THEN v_click ELSE push_recovery_click_id END,
    clicked_at=CASE WHEN v_channel='sms' THEN coalesce((p_event->>'clicked_at')::timestamptz,clicked_at) ELSE clicked_at END,
    push_clicked_at=CASE WHEN v_channel='push' THEN coalesce((p_event->>'clicked_at')::timestamptz,push_clicked_at) ELSE push_clicked_at END,
    push_destination_type=CASE WHEN v_channel='push' THEN coalesce(nullif(p_event->>'destination_type',''),push_destination_type) ELSE push_destination_type END,
    updated_at=now()
  WHERE workspace_id=p_event->>'workspace_id' AND external_cart_id=p_event->>'external_cart_id'
    AND (p_event->>'occurred_at')::timestamptz<=coalesce(recovery_expires_at,'infinity'::timestamptz)
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_conversation(p_recovery_id uuid,p_occurred_at timestamptz)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recoveries
  SET conversation_occurred_at=coalesce(conversation_occurred_at,p_occurred_at),updated_at=now()
  WHERE id=p_recovery_id AND p_occurred_at>=last_activity_at
    AND p_occurred_at<=coalesce(recovery_expires_at,last_activity_at+make_interval(days=>coalesce((
      SELECT attribution_window_days FROM public.luko_cart_recovery_settings s
      WHERE s.workspace_id=luko_cart_recoveries.workspace_id
    ),7)))
  RETURNING true;
$$;

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
       OR (v_method IN ('conversation_assisted','recovery_coupon') AND v_strength='strong')) THEN
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
  ELSIF v_method='conversation_assisted' AND v_recovery.conversation_occurred_at IS NULL THEN
    RAISE EXCEPTION 'conversation_recovery_evidence_missing' USING ERRCODE='P0001';
  ELSIF v_method='recovery_coupon' AND (
      upper(coalesce(p_decision->>'coupon_code',''))<>'VICI15'
      OR (v_recovery.push_sent_at IS NULL AND NOT v_recovery.customer_push_permission)
      OR v_recovery.push_due_at IS NULL OR v_paid<v_recovery.push_due_at) THEN
    RAISE EXCEPTION 'coupon_recovery_evidence_missing' USING ERRCODE='P0001';
  END IF;

  -- Serialize both sides of the one-order/one-episode relationship before checking
  -- the unique keys. This avoids a split conflict where one existing row owns the
  -- order while a different row owns the recovery episode.
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
    recovery_click_id,recovery_click_at,push_id,push_sent_at,push_click_at,coupon_code,
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

CREATE OR REPLACE FUNCTION public.reconcile_luko_cart_recovered_order_financials(
  p_recovery_id uuid,p_order_id text,p_status text,p_currency text,p_gross numeric,p_discount numeric,
  p_refunded numeric,p_observed_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_before public.luko_cart_recovered_orders%ROWTYPE; v_after public.luko_cart_recovered_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM public.luko_cart_recovered_orders
  WHERE recovery_id=p_recovery_id AND order_id=p_order_id FOR UPDATE;
  IF v_before.id IS NULL THEN RETURN NULL; END IF;
  IF p_status NOT IN ('processing','completed','refunded','cancelled','failed')
     OR p_currency<>v_before.order_currency OR p_gross<0 OR p_discount<0
     OR p_refunded<0 OR p_refunded>p_gross OR p_observed_at<v_before.financial_observed_at THEN
    RAISE EXCEPTION 'invalid_cart_recovery_financial_update' USING ERRCODE='P0001';
  END IF;
  UPDATE public.luko_cart_recovered_orders SET order_status=p_status,
    gross_recovered_revenue=p_gross,discount_amount=p_discount,refund_amount=p_refunded,
    net_recovered_revenue=p_gross-p_refunded,financial_observed_at=p_observed_at,updated_at=now()
  WHERE id=v_before.id RETURNING * INTO v_after;
  UPDATE public.luko_cart_recoveries SET order_status=p_status,order_total=p_gross,updated_at=now()
  WHERE id=p_recovery_id;
  IF v_after.refund_amount IS DISTINCT FROM v_before.refund_amount THEN
    PERFORM public.append_luko_cart_recovery_timeline(p_recovery_id,'RECOVERED_ORDER_REFUND_UPDATED',p_observed_at,
      jsonb_build_object('order_id',p_order_id,'gross_revenue',p_gross,'refund_amount',p_refunded,
        'net_revenue',p_gross-p_refunded,'currency',p_currency),NULL);
  END IF;
  RETURN to_jsonb(v_after);
END;
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
      'recoveredOrders',v_orders,
      'abandonedCarts',v_abandoned,
      'recoveryRate',CASE WHEN v_abandoned=0 THEN 0 ELSE round(v_cohort_recovered::numeric*100/v_abandoned,2) END,
      'recoveryRateNumerator',v_cohort_recovered,'recoveryRateDenominator',v_abandoned,
      'smsSent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND sent_at>=p_start AND sent_at<p_end),
      'smsDelivered',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND delivered_at>=p_start AND delivered_at<p_end),
      'recoveryLinkClicks',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND clicked_at>=p_start AND clicked_at<p_end),
      'pushSent',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_sent_at>=p_start AND push_sent_at<p_end),
      'pushClicks',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_clicked_at>=p_start AND push_clicked_at<p_end),
      'discountRecoveries',(SELECT count(*) FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace AND coupon_code='VICI15' AND order_paid_at>=p_start AND order_paid_at<p_end),
      'averageRecoveredOrderValue',CASE WHEN v_orders=0 OR v_currency_count>1 THEN NULL ELSE round(v_revenue/v_orders,2) END,
      'currency',coalesce(v_currency,'USD'),'mixedCurrencies',v_currency_count>1
    ),
    'funnel',jsonb_build_array(
      jsonb_build_object('key','abandoned','label','Abandoned carts','count',v_abandoned),
      jsonb_build_object('key','sms_eligible','label','SMS eligible','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND consent_granted AND last_activity_at>=p_start AND last_activity_at<p_end)),
      jsonb_build_object('key','sms_sent','label','SMS sent','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND sent_at>=p_start AND sent_at<p_end)),
      jsonb_build_object('key','delivered','label','Delivered','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND dry_run=false AND delivered_at>=p_start AND delivered_at<p_end)),
      jsonb_build_object('key','engaged','label','Clicked or replied','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND (clicked_at>=p_start AND clicked_at<p_end OR push_clicked_at>=p_start AND push_clicked_at<p_end OR conversation_occurred_at>=p_start AND conversation_occurred_at<p_end))),
      jsonb_build_object('key','push_sent','label','Push sent','count',(SELECT count(*) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace AND push_sent_at>=p_start AND push_sent_at<p_end)),
      jsonb_build_object('key','recovered_orders','label','Recovered orders','count',v_orders)
    ),
    'revenueByMethod',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'method',method,'revenue',revenue,'orders',orders,'currency',currency
    ) ORDER BY method) FROM (
      SELECT attribution_method method,sum(net_recovered_revenue) revenue,count(*) orders,min(order_currency) currency
      FROM public.luko_cart_recovered_orders WHERE workspace_id=p_workspace
        AND order_paid_at>=p_start AND order_paid_at<p_end
      GROUP BY attribution_method
    ) b),'[]'::jsonb),
    'orders',coalesce((SELECT jsonb_agg(row_json ORDER BY paid_at DESC,id) FROM (
      SELECT jsonb_build_object(
        'id',a.id,'abandonmentEpisodeId',a.recovery_id,'externalCartId',a.external_cart_id,
        'customerName',coalesce(nullif(r.customer_first_name,''),nullif(r.customer_email,''),'Customer'),
        'products',coalesce((SELECT jsonb_agg(coalesce(nullif(i->>'product_name',''),nullif(i->>'name','Product'))) FROM jsonb_array_elements(r.cart_items) i),'[]'::jsonb),
        'abandonedCartValue',a.original_cart_value,'recoveryMethod',a.attribution_method,
        'channel',a.recovery_channel,'messageId',a.message_id,'pushId',a.push_id,
        'coupon',a.coupon_code,'orderId',a.order_id,'grossRecoveredRevenue',a.gross_recovered_revenue,
        'discountAmount',a.discount_amount,'refundAmount',a.refund_amount,
        'netRecoveredRevenue',a.net_recovered_revenue,'currency',a.order_currency,
        'paidAt',a.order_paid_at,'attributionStrength',a.attribution_strength,
        'conversationOccurred',a.conversation_occurred,'secondarySignals',a.secondary_signals
      ) row_json,a.order_paid_at paid_at,a.id
      FROM public.luko_cart_recovered_orders a JOIN public.luko_cart_recoveries r ON r.id=a.recovery_id
      WHERE a.workspace_id=p_workspace AND a.order_paid_at>=p_start AND a.order_paid_at<p_end
      ORDER BY a.order_paid_at DESC,a.id
      OFFSET (v_page-1)*v_size LIMIT v_size
    ) rows_page),'[]'::jsonb),
    'pagination',jsonb_build_object('page',v_page,'pageSize',v_size,'total',v_total,'hasMore',v_page*v_size<v_total)
  ) INTO v_result;
  RETURN v_result;
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

CREATE OR REPLACE VIEW public.luko_cart_recovery_journey_list WITH (security_invoker=true) AS
SELECT r.id,r.workspace_id,r.external_cart_id,r.wordpress_user_id,r.customer_email,r.customer_first_name,r.contact_phone,
  r.identity_resolution_ambiguous,r.consent_granted,r.customer_push_permission,
  r.primary_product_name,r.item_count,r.cart_items,r.currency,r.cart_total,r.last_activity_at,r.due_at,r.journey_status,
  r.sms_status,r.reply_status,r.objection_category,r.objection_secondary_category,r.objection_confidence,r.objection_summary,
  r.push_due_at,r.push_status,r.push_destination_type,r.push_destination_url,r.push_coupon_verified_at,r.push_coupon_block_reason,
  r.order_id,r.order_status,r.order_total,r.order_currency,r.status AS attribution_status,r.created_at,r.updated_at,
  a.attribution_method,a.attribution_strength,a.gross_recovered_revenue,a.refund_amount,a.net_recovered_revenue,
  a.order_paid_at,a.attribution_model_version
FROM public.luko_cart_recoveries r
LEFT JOIN public.luko_cart_recovered_orders a ON a.recovery_id=r.id;

ALTER TABLE public.luko_cart_recovered_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luko_cart_recovered_orders FROM public,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.luko_cart_recovered_orders TO service_role;

REVOKE ALL ON FUNCTION public.record_luko_cart_recovery_click(jsonb),
  public.mark_luko_cart_conversation(uuid,timestamptz),
  public.persist_luko_cart_recovered_order(jsonb),
  public.reconcile_luko_cart_recovered_order_financials(uuid,text,text,text,numeric,numeric,numeric,timestamptz),
  public.luko_cart_recovery_analytics(text,timestamptz,timestamptz,integer,integer)
FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_luko_cart_recovery_click(jsonb),
  public.mark_luko_cart_conversation(uuid,timestamptz),
  public.persist_luko_cart_recovered_order(jsonb),
  public.reconcile_luko_cart_recovered_order_financials(uuid,text,text,text,numeric,numeric,numeric,timestamptz),
  public.luko_cart_recovery_analytics(text,timestamptz,timestamptz,integer,integer)
TO service_role;

NOTIFY pgrst,'reload schema';

COMMIT;
