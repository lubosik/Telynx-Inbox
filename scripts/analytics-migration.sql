-- Vici revenue analytics — additive, reversible schema.
--
-- SAFETY
--   * Creates new tables/indexes/functions only; no source rows are changed.
--   * Does not calculate or persist historical attribution.
--   * All analytics tables have RLS enabled and intentionally expose no direct
--     anon/authenticated policies. The Railway backend service role is the only
--     application path.
--   * Run the candidate-only backfill and review its report before using its
--     separately gated --persist mode.

BEGIN;

CREATE TABLE IF NOT EXISTS analytics_attribution_rules (
  workspace_id             text PRIMARY KEY DEFAULT 'vici',
  business_timezone        text NOT NULL DEFAULT 'America/New_York',
  currency                 text NOT NULL DEFAULT 'USD',
  methodology_version      text NOT NULL DEFAULT 'vici-revenue-v1',
  payment_strong_seconds   integer NOT NULL DEFAULT 86400 CHECK (payment_strong_seconds > 0),
  payment_maximum_seconds  integer NOT NULL DEFAULT 86400 CHECK (payment_maximum_seconds >= payment_strong_seconds),
  rules                    jsonb NOT NULL DEFAULT '{"direct_requires_explicit_confirmation":true,"historical_influenced_enabled":false}'::jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

INSERT INTO analytics_attribution_rules (workspace_id)
VALUES ('vici')
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS analytics_order_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             text NOT NULL DEFAULT 'vici',
  provider                 text NOT NULL,
  provider_event_id        text,
  dedup_key                text NOT NULL,
  event_type               text NOT NULL,
  order_id                 text NOT NULL,
  customer_id              text,
  contact_phone            text,
  financial_status         text,
  currency                 text,
  gross_amount             numeric(14,2),
  refunded_amount          numeric(14,2) NOT NULL DEFAULT 0,
  occurred_at              timestamptz NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  trusted                  boolean NOT NULL DEFAULT false,
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (workspace_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS analytics_order_events_order_time_idx
  ON analytics_order_events (workspace_id, order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_order_events_type_time_idx
  ON analytics_order_events (workspace_id, event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS analytics_message_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             text NOT NULL DEFAULT 'vici',
  provider                 text NOT NULL DEFAULT 'telnyx',
  provider_event_id        text NOT NULL,
  message_id               text NOT NULL,
  event_type               text NOT NULL,
  status                   text,
  occurred_at              timestamptz NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  trusted                  boolean NOT NULL DEFAULT false,
  UNIQUE (workspace_id, provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS analytics_message_events_message_status_idx
  ON analytics_message_events (workspace_id, message_id, status, occurred_at DESC)
  WHERE trusted = true;

CREATE TABLE IF NOT EXISTS revenue_attributions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             text NOT NULL DEFAULT 'vici',
  order_id                 text NOT NULL,
  customer_id              text,
  contact_phone            text,
  currency                 text NOT NULL DEFAULT 'USD',
  gross_amount             numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  refunded_amount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  net_amount               numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  category                 text,
  workflow                 text,
  originating_action_type  text,
  originating_action_id    text,
  campaign_id              uuid,
  campaign_recipient_id    uuid,
  action_at                timestamptz,
  conversion_at            timestamptz,
  attribution_window_seconds integer CHECK (attribution_window_seconds IS NULL OR attribution_window_seconds >= 0),
  confidence_level         text NOT NULL CHECK (confidence_level IN ('direct', 'strong', 'influenced', 'unattributed')),
  confidence_score         numeric(3,2) NOT NULL CHECK (confidence_score IN (1.00, 0.90, 0.60, 0.00)),
  reason                   text NOT NULL,
  supporting_evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  methodology_version      text NOT NULL,
  source                   text NOT NULL DEFAULT 'live',
  is_refunded              boolean NOT NULL DEFAULT false,
  invalidated_at           timestamptz,
  invalidation_reason      text,
  revision                 integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id),
  CHECK (refunded_amount <= gross_amount),
  CHECK (net_amount = gross_amount - refunded_amount),
  CHECK (
    (confidence_level = 'direct' AND confidence_score = 1.00) OR
    (confidence_level = 'strong' AND confidence_score = 0.90) OR
    (confidence_level = 'influenced' AND confidence_score = 0.60) OR
    (confidence_level = 'unattributed' AND confidence_score = 0.00)
  )
);

CREATE INDEX IF NOT EXISTS revenue_attributions_action_confidence_idx
  ON revenue_attributions (workspace_id, action_at DESC, confidence_level)
  WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS revenue_attributions_conversion_idx
  ON revenue_attributions (workspace_id, conversion_at DESC);
CREATE INDEX IF NOT EXISTS revenue_attributions_customer_idx
  ON revenue_attributions (workspace_id, contact_phone, conversion_at DESC);
-- Analytics and Campaigns can be applied in either order after their shared
-- RBAC/audit prerequisites. If this table predates campaign columns, converge
-- it now; attach foreign keys only when the campaign tables already exist.
-- scripts/campaigns-migration.sql performs the reciprocal conditional attach.
ALTER TABLE public.revenue_attributions
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_recipient_id uuid;
CREATE INDEX IF NOT EXISTS revenue_attributions_campaign_recipient_idx
  ON revenue_attributions (campaign_id, campaign_recipient_id)
  WHERE campaign_id IS NOT NULL;
DO $$
BEGIN
  IF to_regclass('public.sms_campaigns') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.revenue_attributions'::regclass
         AND conname = 'revenue_attributions_campaign_fk'
         AND pg_get_constraintdef(oid) NOT LIKE 'FOREIGN KEY (workspace_id, campaign_id)%'
     ) THEN
    ALTER TABLE public.revenue_attributions DROP CONSTRAINT revenue_attributions_campaign_fk;
  END IF;
  IF to_regclass('public.sms_campaigns') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.revenue_attributions'::regclass
         AND conname = 'revenue_attributions_campaign_fk'
     ) THEN
    ALTER TABLE public.revenue_attributions
      ADD CONSTRAINT revenue_attributions_campaign_fk
      FOREIGN KEY (workspace_id, campaign_id)
      REFERENCES public.sms_campaigns(workspace_id, id) NOT VALID;
  END IF;
  IF to_regclass('public.sms_campaign_recipients') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.revenue_attributions'::regclass
         AND conname = 'revenue_attributions_campaign_recipient_fk'
         AND pg_get_constraintdef(oid) NOT LIKE 'FOREIGN KEY (workspace_id, campaign_recipient_id)%'
     ) THEN
    ALTER TABLE public.revenue_attributions DROP CONSTRAINT revenue_attributions_campaign_recipient_fk;
  END IF;
  IF to_regclass('public.sms_campaign_recipients') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.revenue_attributions'::regclass
         AND conname = 'revenue_attributions_campaign_recipient_fk'
     ) THEN
    ALTER TABLE public.revenue_attributions
      ADD CONSTRAINT revenue_attributions_campaign_recipient_fk
      FOREIGN KEY (workspace_id, campaign_recipient_id)
      REFERENCES public.sms_campaign_recipients(workspace_id, id) NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS revenue_attribution_history (
  history_id               bigserial PRIMARY KEY,
  attribution_id           uuid NOT NULL,
  workspace_id             text NOT NULL,
  order_id                 text NOT NULL,
  revision                 integer NOT NULL,
  snapshot                 jsonb NOT NULL,
  change_reason            text,
  recorded_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenue_attribution_history_order_idx
  ON revenue_attribution_history (workspace_id, order_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION preserve_revenue_attribution_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.revenue_attribution_history (
    attribution_id, workspace_id, order_id, revision, snapshot, change_reason
  ) VALUES (
    OLD.id,
    OLD.workspace_id,
    OLD.order_id,
    OLD.revision,
    to_jsonb(OLD),
    COALESCE(NEW.invalidation_reason, 'recalculated')
  );
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revenue_attribution_revision_trigger ON revenue_attributions;
CREATE TRIGGER revenue_attribution_revision_trigger
BEFORE UPDATE ON revenue_attributions
FOR EACH ROW EXECUTE FUNCTION preserve_revenue_attribution_revision();

CREATE TABLE IF NOT EXISTS message_sentiment (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             text NOT NULL DEFAULT 'vici',
  message_id               text NOT NULL,
  occurred_at              timestamptz NOT NULL,
  score                    smallint NOT NULL CHECK (score BETWEEN -2 AND 2),
  label                    text NOT NULL CHECK (label IN ('very_negative', 'negative', 'neutral', 'positive', 'very_positive')),
  classifier               text NOT NULL,
  classifier_version       text NOT NULL,
  model                    text,
  confidence               numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, message_id, classifier_version)
);

CREATE INDEX IF NOT EXISTS message_sentiment_time_score_idx
  ON message_sentiment (workspace_id, occurred_at DESC, score);

CREATE TABLE IF NOT EXISTS analytics_backfill_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             text NOT NULL DEFAULT 'vici',
  methodology_version      text NOT NULL,
  mode                     text NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'persist')),
  status                   text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'staged', 'completed', 'failed')),
  source_ranges            jsonb NOT NULL DEFAULT '{}'::jsonb,
  aggregate_result         jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz
);

CREATE TABLE IF NOT EXISTS analytics_backfill_candidates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                   uuid NOT NULL REFERENCES analytics_backfill_runs(id) ON DELETE CASCADE,
  workspace_id             text NOT NULL DEFAULT 'vici',
  order_id                 text NOT NULL,
  confidence_level         text NOT NULL CHECK (confidence_level IN ('direct', 'strong', 'influenced', 'unattributed')),
  confidence_score         numeric(3,2) NOT NULL,
  candidate                jsonb NOT NULL,
  review_status            text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'rule_accepted', 'sample_reviewed', 'approved', 'rejected')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, order_id)
);

CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
  workspace_id             text NOT NULL DEFAULT 'vici',
  business_date            date NOT NULL,
  timezone                 text NOT NULL,
  metrics                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version           bigint NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, business_date)
);

CREATE TABLE IF NOT EXISTS analytics_state (
  workspace_id             text PRIMARY KEY DEFAULT 'vici',
  version                  bigint NOT NULL DEFAULT 1,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

INSERT INTO analytics_state (workspace_id)
VALUES ('vici')
ON CONFLICT (workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_analytics_state(p_workspace_id text DEFAULT 'vici')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE next_version bigint;
BEGIN
  INSERT INTO public.analytics_state (workspace_id, version, updated_at)
  VALUES (p_workspace_id, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET version = public.analytics_state.version + 1,
        updated_at = now()
  RETURNING version INTO next_version;
  RETURN next_version;
END;
$$;

-- Promote a fully staged historical run in one database transaction. Existing
-- rows always win, so a historical snapshot can never overwrite a newer live
-- webhook assessment. A failed call rolls back the entire promotion.
CREATE OR REPLACE FUNCTION promote_analytics_backfill(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_run public.analytics_backfill_runs%ROWTYPE;
  candidate_count integer;
  inserted_count integer;
  result jsonb;
BEGIN
  SELECT * INTO target_run
  FROM public.analytics_backfill_runs
  WHERE id = p_run_id AND workspace_id = 'vici' AND mode = 'persist'
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Approved analytics backfill run not found.'; END IF;
  IF target_run.status <> 'staged' THEN
    RAISE EXCEPTION 'Analytics backfill run is not promotable.';
  END IF;

  SELECT count(*) INTO candidate_count
  FROM public.analytics_backfill_candidates
  WHERE run_id = p_run_id
    AND review_status IN ('rule_accepted', 'sample_reviewed', 'approved');

  IF candidate_count = 0 THEN RAISE EXCEPTION 'Analytics backfill has no reviewed candidates.'; END IF;

  INSERT INTO public.revenue_attributions (
    workspace_id, order_id, customer_id, contact_phone, currency,
    gross_amount, refunded_amount, net_amount, category, workflow,
    originating_action_type, originating_action_id, action_at, conversion_at,
    attribution_window_seconds, confidence_level, confidence_score, reason,
    supporting_evidence, methodology_version, source, is_refunded,
    invalidated_at, invalidation_reason
  )
  SELECT
    c.workspace_id,
    c.order_id,
    nullif(c.candidate->>'customer_id', ''),
    nullif(c.candidate->>'contact_phone', ''),
    coalesce(nullif(c.candidate->>'currency', ''), 'USD'),
    (c.candidate->>'gross_amount')::numeric,
    (c.candidate->>'refunded_amount')::numeric,
    (c.candidate->>'net_amount')::numeric,
    nullif(c.candidate->>'category', ''),
    nullif(c.candidate->>'workflow', ''),
    nullif(c.candidate->>'originating_action_type', ''),
    nullif(c.candidate->>'originating_action_id', ''),
    nullif(c.candidate->>'action_at', '')::timestamptz,
    nullif(c.candidate->>'conversion_at', '')::timestamptz,
    nullif(c.candidate->>'attribution_window_seconds', '')::integer,
    c.confidence_level,
    c.confidence_score,
    c.candidate->>'reason',
    coalesce(c.candidate->'supporting_evidence', '{}'::jsonb),
    target_run.methodology_version,
    'historical_backfill',
    coalesce((c.candidate->>'is_refunded')::boolean, false),
    nullif(c.candidate->>'invalidated_at', '')::timestamptz,
    nullif(c.candidate->>'invalidation_reason', '')
  FROM public.analytics_backfill_candidates c
  WHERE c.run_id = p_run_id
    AND c.review_status IN ('rule_accepted', 'sample_reviewed', 'approved')
  ON CONFLICT (workspace_id, order_id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  result := jsonb_build_object(
    'staged', candidate_count,
    'inserted', inserted_count,
    'preserved_existing', candidate_count - inserted_count
  );

  UPDATE public.analytics_backfill_runs
  SET status = 'completed',
      aggregate_result = aggregate_result || jsonb_build_object('persistence', result),
      completed_at = now()
  WHERE id = p_run_id;

  INSERT INTO public.analytics_state (workspace_id, version, updated_at)
  VALUES (target_run.workspace_id, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET version = public.analytics_state.version + 1,
        updated_at = now();

  RETURN result;
END;
$$;

-- Functions in the public schema are executable by PUBLIC unless privileges
-- are revoked explicitly.  This state counter is an internal backend RPC, not
-- a client API: allowing anon/authenticated callers to invoke the
-- SECURITY DEFINER function would bypass the table RLS policy.
REVOKE ALL ON FUNCTION bump_analytics_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_analytics_state(text) FROM anon;
REVOKE ALL ON FUNCTION bump_analytics_state(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_analytics_state(text) TO service_role;

REVOKE ALL ON FUNCTION promote_analytics_backfill(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION promote_analytics_backfill(uuid) FROM anon;
REVOKE ALL ON FUNCTION promote_analytics_backfill(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION promote_analytics_backfill(uuid) TO service_role;

-- The revision function is trigger-only; direct execution is unnecessary.
REVOKE ALL ON FUNCTION preserve_revenue_attribution_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION preserve_revenue_attribution_revision() FROM anon;
REVOKE ALL ON FUNCTION preserve_revenue_attribution_revision() FROM authenticated;

-- Source-table indexes used by bounded analytics range queries. They are
-- deliberately narrow; review query plans before adding more write overhead.
CREATE INDEX IF NOT EXISTS idx_sms_messages_direction_created
  ON sms_messages (direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_sent_log_flow_sent
  ON sms_sent_log (flow_type, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_direction_status_started
  ON call_logs (direction, status, started_at DESC);

ALTER TABLE analytics_attribution_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_attribution_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_sentiment ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_backfill_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_state ENABLE ROW LEVEL SECURITY;

COMMIT;
