-- Vici Inbox — Segment purpose, and segment deletion/archival.
--
-- ADDITIVE / REPEATABLE
--   Adds one nullable column, backfills it, adds one CHECK, replaces one RPC
--   and creates two more. It sends nothing, messages nobody, and destroys no
--   existing row.
--
-- IT IS A NEW FILE ON PURPOSE
--   scripts/campaign-segments-migration.sql is applied in production and must
--   never be edited. Everything here is expressed as a new statement instead.
--
-- DEPLOY ORDER
--   Apply after scripts/campaign-segments-migration.sql and IN THE SAME WINDOW
--   as the matching backend deploy.
--
--   This file DROPs the nine-argument create_sms_campaign_segment and replaces
--   it with a ten-argument version that takes p_purpose. That is deliberate: an
--   overload pair would leave PostgREST resolving between two functions with
--   different rules about whether a purpose is required, and the wrong one
--   winning would silently reintroduce the purposeless manual segment this
--   change exists to stop.
--
--   The cost is a gap. Between this migration and the deploy, the currently
--   running backend calls the old signature, PostgREST answers PGRST202, and
--   `databaseError()` in lib/campaigns/segment-service.js already turns that
--   into the friendly CampaignNotReadyError. Only segment CREATION degrades.
--   Reading segments, adding members, overrides and recomputes are untouched.
--   Nothing is lost and nothing is destroyed by taking the gap.
--
--   This migration adds no permission key. Segments still reuse campaigns.read
--   and campaigns.manage, so the startup permission check cannot fail on it.
--
-- WHAT THIS COMMITS TO
--   1. A MANUAL segment carries ONE purpose, recorded when it is created and
--      required. It is the explanation for everybody in the segment. An
--      AUTOMATIC segment has none: its detector definition is its purpose, and
--      a second free-text field beside it would be two answers to one question.
--   2. That is NOT the same field as a per-person reason. A purpose describes
--      the group ("customers who asked about the December restock"). A
--      per-person reason describes one decision about one named human ("added
--      at her request on 12 Aug", "excluded because she asked us to stop").
--      The second still lives in sms_campaign_segment_members.inclusion_evidence
--      and in sms_campaign_segment_overrides.reason, untouched by this file.
--   3. Destroying a segment is the narrow case, and the RPC decides, not the
--      caller. See delete_sms_campaign_segment for the full argument.

BEGIN;

-- ── Purpose ─────────────────────────────────────────────────────────────────

ALTER TABLE public.sms_campaign_segments
  ADD COLUMN IF NOT EXISTS purpose text,
  -- Parity with sms_campaigns.archive_reason. The other two archival columns
  -- already exist on this table from the previous migration.
  ADD COLUMN IF NOT EXISTS archive_reason text;

-- Backfill before the constraint, never after.
--
-- A NOT VALID constraint was the obvious tool here and is the wrong one: a
-- NOT VALID CHECK is still enforced on UPDATE, so a manual segment created
-- before this change could never have a member added to it again, because
-- add_sms_campaign_segment_member updates member_count on the parent row.
--
-- So every existing manual segment gets a purpose. Where the operator already
-- wrote a description, that description IS the purpose: the field they typed
-- into was labelled "What is this group for?". Where they wrote nothing, the
-- sentinel says exactly what happened rather than inventing an intention.
UPDATE public.sms_campaign_segments
SET purpose = left(nullif(trim(coalesce(description, '')), ''), 500)
WHERE segment_kind = 'manual'
  AND purpose IS NULL
  AND nullif(trim(coalesce(description, '')), '') IS NOT NULL;

UPDATE public.sms_campaign_segments
SET purpose = 'Recorded before a purpose was required, so none was written down.'
WHERE segment_kind = 'manual' AND purpose IS NULL;

-- An automatic segment must not carry one, so nobody has to work out which of
-- the definition and the purpose is authoritative.
UPDATE public.sms_campaign_segments
SET purpose = NULL
WHERE segment_kind = 'automatic' AND purpose IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sms_campaign_segment_purpose_matches_kind'
      AND conrelid = 'public.sms_campaign_segments'::regclass
  ) THEN
    ALTER TABLE public.sms_campaign_segments
      ADD CONSTRAINT sms_campaign_segment_purpose_matches_kind CHECK (
        (segment_kind = 'automatic' AND purpose IS NULL)
        OR
        (segment_kind = 'manual'
          AND purpose IS NOT NULL
          AND char_length(trim(purpose)) BETWEEN 1 AND 500)
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.sms_campaign_segments.purpose IS
  'Why this manual segment exists, written once by the person who created it '
  'and shown as the explanation for every member. NULL on automatic segments, '
  'whose detector definition is their purpose. Not a per-person reason: those '
  'live in sms_campaign_segment_members.inclusion_evidence and '
  'sms_campaign_segment_overrides.reason.';

-- ── Create, now carrying a purpose ─────────────────────────────────────────
-- Replaces the nine-argument version. See DEPLOY ORDER above for why this is a
-- drop and not an overload.

DROP FUNCTION IF EXISTS public.create_sms_campaign_segment(
  text, bigint, text, text, text, text, jsonb, text, jsonb
);

CREATE OR REPLACE FUNCTION public.create_sms_campaign_segment(
  p_workspace_id text,
  p_actor_user_id bigint,
  p_segment_key text,
  p_name text,
  p_description text,
  p_purpose text,
  p_segment_kind text,
  p_definition jsonb,
  p_rule_version text,
  p_members jsonb
) RETURNS public.sms_campaign_segments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_purpose text;
  v_count integer := 0;
BEGIN
  IF p_segment_kind NOT IN ('automatic', 'manual') THEN
    RAISE EXCEPTION 'segment_kind_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_segment_kind = 'manual' AND p_members IS NOT NULL
     AND jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'segment_members_invalid' USING ERRCODE = 'P0001';
  END IF;

  -- One purpose per manual segment, required. The CHECK constraint enforces the
  -- same thing; this raise exists so the caller gets a token it can turn into a
  -- sentence rather than a bare constraint violation.
  v_purpose := left(nullif(trim(coalesce(p_purpose, '')), ''), 500);
  IF p_segment_kind = 'manual' AND v_purpose IS NULL THEN
    RAISE EXCEPTION 'segment_purpose_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_segment_kind = 'automatic' THEN
    v_purpose := NULL;
  END IF;

  -- Defence in depth behind lib/route-policy.js. A named actor must actually
  -- hold campaigns.manage; a NULL actor is the legacy shared identity, which
  -- the route layer has already authorised.
  IF p_actor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sms_effective_permissions
    WHERE user_id = p_actor_user_id AND permission_key = 'campaigns.manage'
  ) THEN
    RAISE EXCEPTION 'segment_actor_forbidden' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.sms_campaign_segments (
    workspace_id, segment_key, name, description, purpose, segment_kind,
    definition, rule_version, created_by, updated_by
  ) VALUES (
    p_workspace_id, p_segment_key, p_name, nullif(trim(coalesce(p_description, '')), ''),
    v_purpose, p_segment_kind, coalesce(p_definition, '{}'::jsonb), p_rule_version,
    p_actor_user_id, p_actor_user_id
  )
  RETURNING * INTO v_segment;

  IF p_segment_kind = 'manual' AND p_members IS NOT NULL THEN
    INSERT INTO public.sms_campaign_segment_members (
      segment_id, workspace_id, contact_phone, contact_id, contact_name_snapshot,
      membership_source, inclusion_evidence, evidence_rule_version, added_by
    )
    SELECT
      v_segment.id, p_workspace_id,
      member.value->>'contactPhone',
      nullif(member.value->>'contactID', '')::bigint,
      left(nullif(member.value->>'contactName', ''), 200),
      'manual',
      coalesce(member.value->'inclusionEvidence', '{}'::jsonb),
      p_rule_version,
      p_actor_user_id
    FROM jsonb_array_elements(p_members) AS member
    ON CONFLICT (segment_id, contact_phone) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE public.sms_campaign_segments
  SET member_count = v_count, updated_at = now()
  WHERE id = v_segment.id
  RETURNING * INTO v_segment;

  RETURN v_segment;
END;
$$;

-- ── Delete or archive a segment ─────────────────────────────────────────────
--
-- THE LINE, AND THE ARGUMENT FOR IT.
--
-- A campaign is destructible only while it proves nothing: an unapproved,
-- unscheduled draft whose recipients never reached a provider. The equivalent
-- question for a segment is not "is it empty?" but "is any part of it an answer
-- to who did we message and why?".
--
-- Four things make a segment part of that answer, and each one is a blocker:
--
--   1. A CAMPAIGN POINTED AT IT. The moment a campaign is built against a
--      segment, the segment is the record of who that campaign was aimed at.
--      Destroying it would leave the campaign's audience unexplainable. Today
--      nothing writes that link — sms_campaigns.audience_definition has no
--      segmentId key yet — so this blocker is inert and is written anyway, so
--      that the day delivery starts recording the link the rule is already
--      correct rather than needing a second migration nobody remembers.
--
--   2. THE ENGINE HAS RUN ON IT. A recompute run is the engine's own record of
--      what it decided and when, keyed by an input digest. An automatic segment
--      gets one the moment it is turned on, so in practice an automatic segment
--      is archive-only after its first update. That is the right answer: an
--      automatic segment is a standing rule about customers, not a scratch pad.
--
--   3. SOMEBODY OVERRODE IT. An override names a person, an author, a date and
--      usually a reason, and a revoked one is kept precisely so the decision and
--      its reversal both stay readable. Any override row at all, active or
--      revoked, is a written human decision about a named customer.
--
--   4. SOMEBODY WROTE DOWN WHY A NAMED PERSON IS IN IT. A member row whose
--      inclusion_evidence carries a non-empty reason is the same class of thing
--      as an override: an author, a date, and a sentence about one human.
--
-- What is deliberately NOT a blocker is bare membership. A hand-made list of
-- phone numbers with no per-person reasons, that no campaign used and no engine
-- ever touched, records no decision about anybody. It is somebody trying the
-- feature out. Keeping that forever is clutter, not evidence, and the owner
-- having no way to remove it is the papercut this exists to fix.
--
-- Nor is the segment's own PURPOSE a blocker. A purpose describes the group,
-- not a person. Deleting a group nobody ever acted on destroys no answer to
-- "who did we message and why".
--
-- p_mode: 'auto' picks per the rules above. 'archive' always archives.
--         There is deliberately no 'force_delete'. A caller may ask for the
--         safe path and may never ask for the destructive one.
CREATE OR REPLACE FUNCTION public.delete_sms_campaign_segment(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_mode text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_blockers text[] := ARRAY[]::text[];
  v_members integer := 0;
BEGIN
  IF coalesce(p_mode, 'auto') NOT IN ('auto', 'archive') THEN
    RAISE EXCEPTION 'segment_delete_mode_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Already archived means somebody already chose to keep it. A second request
  -- must not quietly upgrade that decision into a destruction.
  IF v_segment.archived_at IS NOT NULL THEN
    v_blockers := v_blockers || 'already_archived'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaigns c
    WHERE c.workspace_id = p_workspace_id
      AND (c.audience_definition->>'segmentId' = p_segment_id::text
        OR c.audience_definition->>'segment_id' = p_segment_id::text)
  ) THEN
    v_blockers := v_blockers || 'campaign_reference'::text;
  END IF;

  IF v_segment.last_computed_at IS NOT NULL OR v_segment.last_run_id IS NOT NULL THEN
    v_blockers := v_blockers || 'engine_has_run'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_runs WHERE segment_id = p_segment_id
  ) THEN
    v_blockers := v_blockers || 'recompute_history'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_overrides WHERE segment_id = p_segment_id
  ) THEN
    v_blockers := v_blockers || 'override_history'::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_members
    WHERE segment_id = p_segment_id
      AND nullif(trim(coalesce(inclusion_evidence->>'reason', '')), '') IS NOT NULL
  ) THEN
    v_blockers := v_blockers || 'member_reasons'::text;
  END IF;

  IF p_mode = 'archive' OR array_length(v_blockers, 1) IS NOT NULL THEN
    UPDATE public.sms_campaign_segments
    SET archived_at = coalesce(archived_at, now()),
        archived_by = coalesce(archived_by, p_actor_user_id),
        archive_reason = coalesce(archive_reason, left(nullif(trim(coalesce(p_reason, '')), ''), 500)),
        updated_by = p_actor_user_id,
        updated_at = now()
    WHERE id = p_segment_id AND workspace_id = p_workspace_id;
    RETURN jsonb_build_object(
      'outcome', 'archived',
      'segmentId', p_segment_id,
      'blockers', to_jsonb(v_blockers),
      'name', v_segment.name,
      'kind', v_segment.segment_kind,
      'membersRemoved', 0
    );
  END IF;

  SELECT count(*) INTO v_members FROM public.sms_campaign_segment_members
  WHERE segment_id = p_segment_id;

  -- Members, overrides and runs all cascade from the segment row. Only the
  -- member rows can exist at this point; the other two are blockers above.
  DELETE FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'outcome', 'deleted',
    'segmentId', p_segment_id,
    'blockers', to_jsonb(ARRAY[]::text[]),
    'name', v_segment.name,
    'kind', v_segment.segment_kind,
    'membersRemoved', v_members
  );
END;
$$;

-- ── Restore ─────────────────────────────────────────────────────────────────
-- Archiving has to be reversible or it is just a slower delete, and an operator
-- who cannot undo it will reach for the destructive path instead. Nothing was
-- removed by the archive, so nothing has to be rebuilt by this.
CREATE OR REPLACE FUNCTION public.restore_sms_campaign_segment(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint
) RETURNS public.sms_campaign_segments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_segment public.sms_campaign_segments%ROWTYPE;
BEGIN
  UPDATE public.sms_campaign_segments
  SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = p_segment_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_segment;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;
  RETURN v_segment;
END;
$$;

-- ── Access ──────────────────────────────────────────────────────────────────
-- Same posture as every other segment RPC: the Railway service role only.

REVOKE ALL ON FUNCTION public.create_sms_campaign_segment(text,bigint,text,text,text,text,text,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_sms_campaign_segment(uuid,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_sms_campaign_segment(uuid,text,bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_sms_campaign_segment(text,bigint,text,text,text,text,text,jsonb,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_sms_campaign_segment(uuid,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_sms_campaign_segment(uuid,text,bigint) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
