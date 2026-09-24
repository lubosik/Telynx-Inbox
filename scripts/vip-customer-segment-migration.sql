-- Vici Inbox — canonical Best Repeat Customers segment.
--
-- ADDITIVE / REPEATABLE / NO SEND
--   Creates one automatic segment definition if it does not already exist.
--   It sends no message, changes no consent state, and does not import the
--   workbook. Membership remains a view of authoritative paid-order history.
--
-- WHY DIRECT INSERT
--   Production may still have the original nine-argument segment-creation RPC
--   while scripts/segment-lifecycle-migration.sql is waiting to be applied.
--   This seed is compatible before and after that migration and does not
--   replace either RPC. The normal recompute path fills membership afterwards.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.sms_campaign_segments') IS NULL THEN
    RAISE EXCEPTION 'campaign_segments_migration_required' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

INSERT INTO public.sms_campaign_segments (
  workspace_id,
  segment_key,
  name,
  description,
  segment_kind,
  definition,
  rule_version
) VALUES (
  'vici',
  'best_repeat_customers',
  'Best Repeat Customers',
  'Customers with at least 3 paid orders and at least $500 in lifetime spend.',
  'automatic',
  jsonb_build_object(
    'detector', 'rules',
    'definitionKey', 'rules',
    'rules', jsonb_build_object(
      'version', 1,
      'schemaVersion', 'segment-rules-2026-08-23',
      'match', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('dimension', 'order_count', 'operator', 'at_least', 'value', 3),
        jsonb_build_object('dimension', 'lifetime_spend', 'operator', 'at_least', 'value', 500)
      )
    ),
    'describedAs', 'our best repeat customers',
    'plainEnglish', 'Customers with at least 3 paid orders and at least $500 in lifetime spend.'
  ),
  'segment-rules-2026-08-23'
)
ON CONFLICT (workspace_id, segment_key) DO NOTHING;

-- A stable key is valuable only when it has one stable meaning. Refuse a
-- pre-existing row with a different meaning instead of silently overwriting a
-- human decision or pointing the VIP inbox at an unrelated audience.
DO $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_expected jsonb := jsonb_build_object(
    'version', 1,
    'schemaVersion', 'segment-rules-2026-08-23',
    'match', 'all',
    'conditions', jsonb_build_array(
      jsonb_build_object('dimension', 'order_count', 'operator', 'at_least', 'value', 3),
      jsonb_build_object('dimension', 'lifetime_spend', 'operator', 'at_least', 'value', 500)
    )
  );
BEGIN
  SELECT * INTO v_segment
  FROM public.sms_campaign_segments
  WHERE workspace_id = 'vici'
    AND segment_key = 'best_repeat_customers';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'best_repeat_customers_seed_failed' USING ERRCODE = 'P0001';
  END IF;

  IF v_segment.segment_kind <> 'automatic'
     OR v_segment.archived_at IS NOT NULL
     OR v_segment.definition->>'detector' <> 'rules'
     OR v_segment.definition->'rules' <> v_expected THEN
    RAISE EXCEPTION 'best_repeat_customers_definition_conflict' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
