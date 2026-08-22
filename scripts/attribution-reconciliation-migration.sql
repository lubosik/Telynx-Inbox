-- Global attribution candidate ledger and serialized winner reconciliation.
-- Apply AFTER scripts/analytics-migration.sql and scripts/campaigns-migration.sql.
-- This migration stages evidence only; it does not create campaign candidates
-- or enable campaign sending.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.revenue_attributions') IS NULL THEN
    RAISE EXCEPTION 'analytics-migration.sql must be applied first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.revenue_attribution_order_state (
  workspace_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text,
  contact_phone text,
  currency text NOT NULL DEFAULT 'USD',
  gross_amount numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  refunded_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  net_amount numeric(14,2) NOT NULL CHECK (net_amount = gross_amount - refunded_amount AND net_amount >= 0),
  financial_status text NOT NULL DEFAULT 'unknown',
  financial_observed_at timestamptz NOT NULL,
  financially_invalidated boolean NOT NULL DEFAULT false,
  invalidation_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, order_id)
);

CREATE TABLE IF NOT EXISTS public.revenue_attribution_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  order_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('payment_recovery', 'campaign', 'call', 'conversation')),
  source_key text NOT NULL,
  campaign_id uuid,
  campaign_recipient_id uuid,
  confidence_level text NOT NULL CHECK (confidence_level IN ('direct', 'strong', 'influenced', 'unattributed')),
  confidence_score numeric(3,2) NOT NULL CHECK (
    (confidence_level = 'direct' AND confidence_score = 1.00) OR
    (confidence_level = 'strong' AND confidence_score = 0.90) OR
    (confidence_level = 'influenced' AND confidence_score = 0.60) OR
    (confidence_level = 'unattributed' AND confidence_score = 0.00)
  ),
  evidence_rank integer NOT NULL DEFAULT 0 CHECK (evidence_rank BETWEEN 0 AND 1000),
  attribution_window_seconds integer CHECK (attribution_window_seconds IS NULL OR attribution_window_seconds >= 0),
  action_at timestamptz,
  candidate_observed_at timestamptz NOT NULL,
  candidate_payload jsonb NOT NULL,
  candidate_invalidated_at timestamptz,
  candidate_invalidation_reason text,
  is_winner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id, source_type, source_key),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES public.revenue_attribution_order_state(workspace_id, order_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS revenue_attribution_candidates_order_rank_idx
  ON public.revenue_attribution_candidates
    (workspace_id, order_id, confidence_score DESC, evidence_rank DESC)
  WHERE candidate_invalidated_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS revenue_attribution_candidates_one_winner_idx
  ON public.revenue_attribution_candidates (workspace_id, order_id)
  WHERE is_winner = true;

-- Seed the ledger from every pre-existing global winner before the RPC is used.
-- This prevents the first post-deploy Woo retry from blindly replacing an
-- existing campaign/call winner whose evidence predates this migration.
INSERT INTO public.revenue_attribution_order_state (
  workspace_id, order_id, customer_id, contact_phone, currency,
  gross_amount, refunded_amount, net_amount, financial_status,
  financial_observed_at, financially_invalidated, invalidation_reason
)
SELECT workspace_id, order_id, customer_id, contact_phone, currency,
       gross_amount, refunded_amount, net_amount,
       CASE WHEN invalidated_at IS NOT NULL THEN 'invalidated' ELSE 'historical' END,
       coalesce(updated_at, conversion_at, created_at, now()),
       invalidated_at IS NOT NULL OR net_amount <= 0,
       invalidation_reason
FROM public.revenue_attributions
ON CONFLICT (workspace_id, order_id) DO NOTHING;

INSERT INTO public.revenue_attribution_candidates (
  workspace_id, order_id, source_type, source_key, campaign_id,
  campaign_recipient_id, confidence_level, confidence_score, evidence_rank,
  attribution_window_seconds, action_at, candidate_observed_at,
  candidate_payload, candidate_invalidated_at, candidate_invalidation_reason,
  is_winner
)
SELECT workspace_id, order_id,
       CASE
         WHEN campaign_id IS NOT NULL THEN 'campaign'
         WHEN category = 'payment_recovery' OR workflow = 'payment_recovery' THEN 'payment_recovery'
         WHEN originating_action_type = 'call' THEN 'call'
         ELSE 'conversation'
       END,
       CASE
         WHEN category = 'payment_recovery' OR workflow = 'payment_recovery'
           THEN 'payment-recovery:' || order_id
         WHEN campaign_id IS NOT NULL
           THEN 'campaign:' || campaign_id::text || ':' || coalesce(campaign_recipient_id::text, originating_action_id, id::text)
         ELSE 'legacy:' || id::text
       END,
       campaign_id, campaign_recipient_id, confidence_level, confidence_score,
       CASE
         WHEN supporting_evidence ? 'paymentConfirmationMessageID' THEN 700
         WHEN supporting_evidence @> '{"codes":["verified_unique_recipient_coupon"]}'::jsonb THEN 650
         WHEN supporting_evidence @> '{"codes":["verified_recipient_order_link"]}'::jsonb THEN 640
         WHEN supporting_evidence @> '{"codes":["exact_target_product"]}'::jsonb THEN 400
         ELSE 100
       END,
       attribution_window_seconds, action_at,
       coalesce(updated_at, conversion_at, created_at, now()),
       to_jsonb(revenue_attributions), invalidated_at, invalidation_reason, true
FROM public.revenue_attributions
ON CONFLICT (workspace_id, order_id, source_type, source_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.stage_revenue_attribution_candidate(p_candidate jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace text := nullif(trim(p_candidate->>'workspace_id'), '');
  v_order text := nullif(trim(p_candidate->>'order_id'), '');
  v_source_type text := nullif(trim(p_candidate->>'candidate_source_type'), '');
  v_source_key text := nullif(trim(p_candidate->>'candidate_source_key'), '');
  v_confidence text := nullif(trim(p_candidate->>'confidence_level'), '');
  v_score numeric := nullif(p_candidate->>'confidence_score', '')::numeric;
  v_gross numeric := nullif(p_candidate->>'gross_amount', '')::numeric;
  v_refunded numeric := coalesce(nullif(p_candidate->>'refunded_amount', '')::numeric, 0);
  v_net numeric := nullif(p_candidate->>'net_amount', '')::numeric;
  v_observed timestamptz := nullif(p_candidate->>'financial_observed_at', '')::timestamptz;
  v_winner public.revenue_attribution_candidates%ROWTYPE;
  v_state public.revenue_attribution_order_state%ROWTYPE;
  v_result public.revenue_attributions%ROWTYPE;
BEGIN
  IF v_workspace IS NULL OR v_order IS NULL OR v_source_key IS NULL
     OR v_source_type NOT IN ('payment_recovery', 'campaign', 'call', 'conversation')
     OR v_observed IS NULL OR v_gross IS NULL OR v_net IS NULL
     OR v_gross < 0 OR v_refunded < 0 OR v_refunded > v_gross
     OR v_net <> v_gross - v_refunded
     OR NOT (
       (v_confidence = 'direct' AND v_score = 1.00) OR
       (v_confidence = 'strong' AND v_score = 0.90) OR
       (v_confidence = 'influenced' AND v_score = 0.60) OR
       (v_confidence = 'unattributed' AND v_score = 0.00)
     ) THEN
    RAISE EXCEPTION 'invalid_attribution_candidate' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize every writer for the exact tenant/order before staging either
  -- financial state or evidence. This removes the JS read/choose/write race.
  PERFORM pg_advisory_xact_lock(hashtext(v_workspace), hashtext(v_order));

  INSERT INTO public.revenue_attribution_order_state (
    workspace_id, order_id, customer_id, contact_phone, currency,
    gross_amount, refunded_amount, net_amount, financial_status,
    financial_observed_at, financially_invalidated, invalidation_reason
  ) VALUES (
    v_workspace, v_order, nullif(p_candidate->>'customer_id', ''),
    nullif(p_candidate->>'contact_phone', ''),
    coalesce(nullif(p_candidate->>'currency', ''), 'USD'),
    v_gross, v_refunded, v_net,
    coalesce(nullif(p_candidate->>'financial_status', ''), 'unknown'),
    v_observed,
    coalesce((p_candidate->>'financial_invalidated')::boolean, false),
    nullif(p_candidate->>'invalidation_reason', '')
  )
  ON CONFLICT (workspace_id, order_id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    contact_phone = EXCLUDED.contact_phone,
    currency = EXCLUDED.currency,
    gross_amount = EXCLUDED.gross_amount,
    refunded_amount = EXCLUDED.refunded_amount,
    net_amount = EXCLUDED.net_amount,
    financial_status = EXCLUDED.financial_status,
    financial_observed_at = EXCLUDED.financial_observed_at,
    financially_invalidated = EXCLUDED.financially_invalidated,
    invalidation_reason = EXCLUDED.invalidation_reason,
    updated_at = now()
  WHERE EXCLUDED.financial_observed_at >= public.revenue_attribution_order_state.financial_observed_at;

  INSERT INTO public.revenue_attribution_candidates (
    workspace_id, order_id, source_type, source_key, campaign_id,
    campaign_recipient_id, confidence_level, confidence_score, evidence_rank,
    attribution_window_seconds, action_at, candidate_observed_at,
    candidate_payload, candidate_invalidated_at, candidate_invalidation_reason
  ) VALUES (
    v_workspace, v_order, v_source_type, v_source_key,
    nullif(p_candidate->>'campaign_id', '')::uuid,
    nullif(p_candidate->>'campaign_recipient_id', '')::uuid,
    v_confidence, v_score,
    coalesce(nullif(p_candidate->>'evidence_rank', '')::integer, 0),
    nullif(p_candidate->>'attribution_window_seconds', '')::integer,
    nullif(p_candidate->>'action_at', '')::timestamptz,
    v_observed, p_candidate,
    nullif(p_candidate->>'candidate_invalidated_at', '')::timestamptz,
    nullif(p_candidate->>'candidate_invalidation_reason', '')
  )
  ON CONFLICT (workspace_id, order_id, source_type, source_key) DO UPDATE SET
    campaign_id = EXCLUDED.campaign_id,
    campaign_recipient_id = EXCLUDED.campaign_recipient_id,
    confidence_level = EXCLUDED.confidence_level,
    confidence_score = EXCLUDED.confidence_score,
    evidence_rank = EXCLUDED.evidence_rank,
    attribution_window_seconds = EXCLUDED.attribution_window_seconds,
    action_at = EXCLUDED.action_at,
    candidate_observed_at = EXCLUDED.candidate_observed_at,
    candidate_payload = EXCLUDED.candidate_payload,
    candidate_invalidated_at = EXCLUDED.candidate_invalidated_at,
    candidate_invalidation_reason = EXCLUDED.candidate_invalidation_reason,
    updated_at = now()
  WHERE EXCLUDED.candidate_observed_at >= public.revenue_attribution_candidates.candidate_observed_at;

  SELECT * INTO v_state FROM public.revenue_attribution_order_state
  WHERE workspace_id = v_workspace AND order_id = v_order;

  SELECT * INTO v_winner
  FROM public.revenue_attribution_candidates c
  WHERE c.workspace_id = v_workspace AND c.order_id = v_order
  ORDER BY
    (c.candidate_invalidated_at IS NULL) DESC,
    CASE c.confidence_level WHEN 'direct' THEN 3 WHEN 'strong' THEN 2 WHEN 'influenced' THEN 1 ELSE 0 END DESC,
    c.evidence_rank DESC,
    CASE c.source_type WHEN 'payment_recovery' THEN 4 WHEN 'campaign' THEN 3 WHEN 'call' THEN 2 ELSE 1 END DESC,
    c.attribution_window_seconds ASC NULLS LAST,
    c.action_at DESC NULLS LAST,
    c.source_key ASC
  LIMIT 1;

  -- Clear then set under the same order lock: an immediate partial unique index
  -- must never observe two winners due to row-update order.
  UPDATE public.revenue_attribution_candidates
  SET is_winner = false, updated_at = now()
  WHERE workspace_id = v_workspace AND order_id = v_order AND is_winner = true;
  UPDATE public.revenue_attribution_candidates
  SET is_winner = true, updated_at = now()
  WHERE id = v_winner.id;

  INSERT INTO public.revenue_attributions (
    workspace_id, order_id, customer_id, contact_phone, currency,
    gross_amount, refunded_amount, net_amount, category, workflow,
    originating_action_type, originating_action_id, campaign_id,
    campaign_recipient_id, action_at, conversion_at,
    attribution_window_seconds, confidence_level, confidence_score, reason,
    supporting_evidence, methodology_version, source, is_refunded,
    invalidated_at, invalidation_reason
  ) VALUES (
    v_workspace, v_order, v_state.customer_id, v_state.contact_phone, v_state.currency,
    v_state.gross_amount, v_state.refunded_amount, v_state.net_amount,
    nullif(v_winner.candidate_payload->>'category', ''),
    nullif(v_winner.candidate_payload->>'workflow', ''),
    nullif(v_winner.candidate_payload->>'originating_action_type', ''),
    nullif(v_winner.candidate_payload->>'originating_action_id', ''),
    v_winner.campaign_id, v_winner.campaign_recipient_id,
    v_winner.action_at,
    nullif(v_winner.candidate_payload->>'conversion_at', '')::timestamptz,
    v_winner.attribution_window_seconds,
    v_winner.confidence_level, v_winner.confidence_score,
    coalesce(nullif(v_winner.candidate_payload->>'reason', ''), 'No attributable evidence.'),
    coalesce(v_winner.candidate_payload->'supporting_evidence', '{}'::jsonb) ||
      jsonb_build_object('winnerSourceType', v_winner.source_type, 'winnerSourceKey', v_winner.source_key),
    coalesce(nullif(v_winner.candidate_payload->>'methodology_version', ''), 'unknown'),
    coalesce(nullif(v_winner.candidate_payload->>'source', ''), 'live'),
    v_state.refunded_amount > 0,
    CASE WHEN v_state.financially_invalidated OR v_winner.candidate_invalidated_at IS NOT NULL
      THEN coalesce(v_winner.candidate_invalidated_at, v_state.financial_observed_at) ELSE NULL END,
    CASE WHEN v_winner.candidate_invalidated_at IS NOT NULL
      THEN v_winner.candidate_invalidation_reason
      WHEN v_state.financially_invalidated THEN v_state.invalidation_reason ELSE NULL END
  )
  ON CONFLICT (workspace_id, order_id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id, contact_phone = EXCLUDED.contact_phone,
    currency = EXCLUDED.currency, gross_amount = EXCLUDED.gross_amount,
    refunded_amount = EXCLUDED.refunded_amount, net_amount = EXCLUDED.net_amount,
    category = EXCLUDED.category, workflow = EXCLUDED.workflow,
    originating_action_type = EXCLUDED.originating_action_type,
    originating_action_id = EXCLUDED.originating_action_id,
    campaign_id = EXCLUDED.campaign_id,
    campaign_recipient_id = EXCLUDED.campaign_recipient_id,
    action_at = EXCLUDED.action_at, conversion_at = EXCLUDED.conversion_at,
    attribution_window_seconds = EXCLUDED.attribution_window_seconds,
    confidence_level = EXCLUDED.confidence_level,
    confidence_score = EXCLUDED.confidence_score, reason = EXCLUDED.reason,
    supporting_evidence = EXCLUDED.supporting_evidence,
    methodology_version = EXCLUDED.methodology_version, source = EXCLUDED.source,
    is_refunded = EXCLUDED.is_refunded, invalidated_at = EXCLUDED.invalidated_at,
    invalidation_reason = EXCLUDED.invalidation_reason
  RETURNING * INTO v_result;

  RETURN to_jsonb(v_result);
END;
$$;

ALTER TABLE public.revenue_attribution_order_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_attribution_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.revenue_attribution_order_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.revenue_attribution_candidates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stage_revenue_attribution_candidate(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_revenue_attribution_candidate(jsonb) TO service_role;

COMMIT;
