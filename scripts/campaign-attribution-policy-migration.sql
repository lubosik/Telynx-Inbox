-- Versioned campaign attribution windows and evidence policy.
-- Apply after analytics, campaigns, and attribution-reconciliation migrations.
-- This does not create campaign candidates, enable delivery, or send messages.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.revenue_attribution_candidates') IS NULL
     OR to_regclass('public.sms_campaign_recipient_events') IS NULL
     OR to_regprocedure('public.stage_revenue_attribution_candidate(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply analytics, campaigns, and attribution reconciliation migrations first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.campaign_attribution_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  workflow_category text NOT NULL CHECK (workflow_category IN (
    'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
    'reorder', 'reorder_personal', 'reorder_personal_high', 'winback',
    'manual_exact_product', 'manual', 'generic_promotion'
  )),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  methodology_version text NOT NULL,
  strong_window_seconds integer NOT NULL CHECK (strong_window_seconds > 0),
  maximum_window_seconds integer NOT NULL CHECK (maximum_window_seconds >= strong_window_seconds),
  product_identity_required boolean NOT NULL DEFAULT false,
  allowed_direct_evidence text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT false,
  activation_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (workspace_id, workflow_category, policy_version),
  CHECK (NOT active OR activated_at IS NOT NULL),
  CHECK (allowed_direct_evidence <@ ARRAY[
    'verified_recipient_order_link',
    'verified_unique_recipient_coupon',
    'trusted_rule_based_purchase_confirmation'
  ]::text[])
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_attribution_one_active_policy_idx
  ON public.campaign_attribution_policies (workspace_id, workflow_category)
  WHERE active = true;
CREATE INDEX IF NOT EXISTS campaign_attribution_policy_lookup_idx
  ON public.campaign_attribution_policies (workspace_id, active, workflow_category);

-- Conservative product defaults. Direct evidence stays empty until a signed
-- first-party link, unique recipient coupon, or deterministic inbound-intent
-- ledger is implemented; timing alone can never become Direct.
WITH defaults(workflow_category, strong_seconds, maximum_seconds, product_required) AS (
  VALUES
    ('back_in_stock', 259200, 604800, true),
    ('back_in_stock_requested', 259200, 604800, true),
    ('back_in_stock_repeat_buyer', 259200, 604800, true),
    ('reorder', 604800, 1209600, true),
    ('reorder_personal', 604800, 1209600, true),
    ('reorder_personal_high', 604800, 1209600, true),
    ('winback', 259200, 1209600, false),
    ('manual_exact_product', 259200, 604800, true),
    ('manual', 259200, 259200, false),
    ('generic_promotion', 259200, 259200, false)
)
INSERT INTO public.campaign_attribution_policies (
  workspace_id, workflow_category, policy_version, methodology_version,
  strong_window_seconds, maximum_window_seconds, product_identity_required,
  allowed_direct_evidence, active, activation_reason, activated_at
)
SELECT 'vici', d.workflow_category, 1, 'vici-campaign-revenue-v1',
       d.strong_seconds, d.maximum_seconds, d.product_required,
       '{}'::text[], true,
       'Conservative initial policy; campaign Direct evidence sources are not enabled.',
       now()
FROM defaults d
WHERE NOT EXISTS (
  SELECT 1 FROM public.campaign_attribution_policies p
  WHERE p.workspace_id = 'vici' AND p.workflow_category = d.workflow_category
    AND p.active = true
)
ON CONFLICT (workspace_id, workflow_category, policy_version) DO NOTHING;

ALTER TABLE public.campaign_attribution_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.campaign_attribution_policies FROM PUBLIC, anon, authenticated;

COMMIT;
