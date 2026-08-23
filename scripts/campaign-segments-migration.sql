-- Vici Inbox — Saved campaign segments, per-member inclusion evidence,
-- durable manual overrides, and campaign deletion/archival.
--
-- ADDITIVE / REPEATABLE
--   This migration creates segment-owned tables, indexes, triggers and
--   backend-only RPCs, and adds nullable archival columns to sms_campaigns.
--   It sends nothing, changes no existing workflow, and rewrites no
--   historical row.
--
-- IT IS A NEW FILE ON PURPOSE
--   scripts/campaigns-migration.sql and scripts/sms-optin-migration.sql are
--   already applied in production and must never be edited. Everything this
--   change needs is expressed here instead.
--
-- DEPLOY ORDER
--   Apply after scripts/rbac-migration.sql, scripts/audit-migration.sql and
--   scripts/campaigns-migration.sql, and BEFORE deploying routes/segments.js
--   and the campaign delete/archive endpoint. The application validates every
--   policy permission key against sms_permissions at startup and exits 1 if
--   one is missing, so the wrong order is a crash loop rather than a warning.
--   This migration adds no new permission key: segments reuse campaigns.read
--   and campaigns.manage, both of which campaigns-migration.sql already seeds.
--
-- WHAT THE DATA MODEL COMMITS TO
--   1. AUTOMATIC vs MANUAL is a stored, immutable column, not a UI label. A
--      trigger refuses to change it after insert, because "why is this person
--      in this segment" must have a permanent answer.
--   2. Every member row carries the facts that put them there, in
--      inclusion_evidence, plus which rule version produced them.
--   3. Manual overrides live in their OWN table, never in the member rows,
--      because recompute rewrites member rows and an exclusion that lived
--      there would be destroyed by the next recompute. An exclusion is
--      permanent until explicitly revoked.
--   4. A BEFORE trigger on the member table independently refuses any insert
--      or update for a phone that holds an active exclude override. The
--      application enforces the same rule; neither is trusted alone.

BEGIN;

-- ── Segments ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_campaign_segments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        text NOT NULL DEFAULT 'vici',
  -- Stable machine key. For an automatic segment this is the detector
  -- definition key from lib/campaigns/segment-definitions.js, so a recompute
  -- can find its segment without a name match.
  segment_key         text NOT NULL,
  name                text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  description         text CHECK (description IS NULL OR char_length(description) <= 1000),
  -- Immutable after insert. See the trigger below.
  segment_kind        text NOT NULL CHECK (segment_kind IN ('automatic', 'manual')),
  definition          jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_version        text,
  member_count        integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  last_computed_at    timestamptz,
  last_run_id         uuid,
  archived_at         timestamptz,
  archived_by         bigint REFERENCES sms_users(id),
  created_by          bigint REFERENCES sms_users(id),
  updated_by          bigint REFERENCES sms_users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaign_segments_workspace_id_key UNIQUE (workspace_id, id),
  -- An automatic segment is worthless without the detector that computes it,
  -- and a manual segment must never carry one, or a recompute could silently
  -- overwrite a human's list.
  CONSTRAINT sms_campaign_segment_definition_matches_kind CHECK (
    (segment_kind = 'automatic' AND char_length(coalesce(definition->>'detector', '')) > 0)
    OR
    (segment_kind = 'manual' AND definition->>'detector' IS NULL)
  ),
  CONSTRAINT sms_campaign_segment_manual_never_computed CHECK (
    segment_kind = 'automatic' OR (last_computed_at IS NULL AND last_run_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_segments_workspace_key_idx
  ON sms_campaign_segments (workspace_id, segment_key);
CREATE INDEX IF NOT EXISTS sms_campaign_segments_live_idx
  ON sms_campaign_segments (workspace_id, segment_kind, updated_at DESC)
  WHERE archived_at IS NULL;

-- ── Members ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_campaign_segment_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id            uuid NOT NULL REFERENCES sms_campaign_segments(id) ON DELETE CASCADE,
  workspace_id          text NOT NULL DEFAULT 'vici',
  contact_phone         text NOT NULL,
  contact_id            bigint,
  contact_name_snapshot text,
  -- computed        the engine put them here (automatic segments only)
  -- manual          a person picked them (manual segments only)
  -- forced_include  a person overrode the engine on an automatic segment
  membership_source     text NOT NULL CHECK (membership_source IN ('computed', 'manual', 'forced_include')),
  -- The facts that put this person in this segment. For a computed row this
  -- is the detector's own evidence: median interval days, intervals observed,
  -- confidence and last order date among them.
  inclusion_evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_rule_version text,
  -- Whether the engine ALSO matched this person at the last recompute. On a
  -- forced_include row this is what makes "a person added them, and the
  -- engine agrees / does not agree" answerable.
  engine_matched        boolean NOT NULL DEFAULT false,
  engine_evidence       jsonb,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  computed_run_id       uuid,
  added_by              bigint REFERENCES sms_users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id, contact_phone),
  CONSTRAINT sms_campaign_segment_members_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT sms_campaign_segment_member_workspace_segment_fk
    FOREIGN KEY (workspace_id, segment_id) REFERENCES sms_campaign_segments(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sms_campaign_segment_member_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE INDEX IF NOT EXISTS sms_campaign_segment_members_segment_idx
  ON sms_campaign_segment_members (segment_id, contact_phone);
CREATE INDEX IF NOT EXISTS sms_campaign_segment_members_phone_idx
  ON sms_campaign_segment_members (workspace_id, contact_phone);
CREATE INDEX IF NOT EXISTS sms_campaign_segment_members_computed_idx
  ON sms_campaign_segment_members (segment_id, membership_source, last_seen_at);

-- ── Overrides ───────────────────────────────────────────────────────────────
-- Deliberately a separate table. Recompute rewrites member rows; an exclusion
-- stored on a member row would be deleted by the very operation it exists to
-- survive. A revoked override is kept, never deleted, so the history of who
-- excluded whom and who reversed it stays readable.

CREATE TABLE IF NOT EXISTS sms_campaign_segment_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id      uuid NOT NULL REFERENCES sms_campaign_segments(id) ON DELETE CASCADE,
  workspace_id    text NOT NULL DEFAULT 'vici',
  contact_phone   text NOT NULL,
  override_type   text NOT NULL CHECK (override_type IN ('include', 'exclude')),
  reason          text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_by      bigint REFERENCES sms_users(id),
  revoked_at      timestamptz,
  revoked_by      bigint REFERENCES sms_users(id),
  revoke_reason   text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaign_segment_overrides_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT sms_campaign_segment_override_workspace_segment_fk
    FOREIGN KEY (workspace_id, segment_id) REFERENCES sms_campaign_segments(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sms_campaign_segment_override_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT sms_campaign_segment_override_revocation_pair CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL) OR revoked_at IS NOT NULL
  )
);

-- At most one ACTIVE override per person per segment. Revoked rows accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_segment_override_active_idx
  ON sms_campaign_segment_overrides (segment_id, contact_phone)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sms_campaign_segment_override_segment_idx
  ON sms_campaign_segment_overrides (segment_id, override_type, created_at DESC);

-- ── Recompute runs ──────────────────────────────────────────────────────────
-- One row per recompute. `run_key` is the idempotency key: replaying a run key
-- returns the original counts and changes nothing.

CREATE TABLE IF NOT EXISTS sms_campaign_segment_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id          uuid NOT NULL REFERENCES sms_campaign_segments(id) ON DELETE CASCADE,
  workspace_id        text NOT NULL DEFAULT 'vici',
  run_key             text NOT NULL,
  rule_version        text,
  input_digest        text,
  member_count        integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  joined_count        integer NOT NULL DEFAULT 0 CHECK (joined_count >= 0),
  left_count          integer NOT NULL DEFAULT 0 CHECK (left_count >= 0),
  refreshed_count     integer NOT NULL DEFAULT 0 CHECK (refreshed_count >= 0),
  forced_include_count integer NOT NULL DEFAULT 0 CHECK (forced_include_count >= 0),
  excluded_count      integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  actor_user_id       bigint REFERENCES sms_users(id),
  completed_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (segment_id, run_key),
  CONSTRAINT sms_campaign_segment_runs_workspace_id_key UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS sms_campaign_segment_runs_recent_idx
  ON sms_campaign_segment_runs (segment_id, completed_at DESC);

-- ── Invariants enforced by the database, not only by the application ────────

-- segment_kind is the answer to "why is this person here?" for every member
-- row beneath it. Flipping it after the fact would silently relabel history.
CREATE OR REPLACE FUNCTION public.sms_campaign_segment_kind_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.segment_kind IS DISTINCT FROM OLD.segment_kind THEN
    RAISE EXCEPTION 'segment_kind_is_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'segment_identity_is_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_campaign_segment_kind_immutable ON public.sms_campaign_segments;
CREATE TRIGGER sms_campaign_segment_kind_immutable
  BEFORE UPDATE ON public.sms_campaign_segments
  FOR EACH ROW EXECUTE FUNCTION public.sms_campaign_segment_kind_is_immutable();

-- membership_source has to agree with the parent segment's kind. Without this
-- a 'computed' row could appear under a manual segment and the next recompute
-- of some other segment would look like it had authority over a human's list.
-- The same trigger is where an ACTIVE exclude override becomes unbreakable:
-- recompute cannot reinsert an excluded person, whatever the caller sends.
CREATE OR REPLACE FUNCTION public.sms_campaign_segment_member_is_permitted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_kind text;
BEGIN
  SELECT segment_kind INTO v_kind FROM public.sms_campaign_segments
  WHERE id = NEW.segment_id AND workspace_id = NEW.workspace_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind = 'manual' AND NEW.membership_source <> 'manual' THEN
    RAISE EXCEPTION 'manual_segment_members_must_be_manual' USING ERRCODE = 'P0001';
  END IF;
  IF v_kind = 'automatic' AND NEW.membership_source NOT IN ('computed', 'forced_include') THEN
    RAISE EXCEPTION 'automatic_segment_members_must_be_computed_or_forced' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_segment_overrides o
    WHERE o.segment_id = NEW.segment_id
      AND o.contact_phone = NEW.contact_phone
      AND o.override_type = 'exclude'
      AND o.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'segment_member_is_excluded_by_override' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_campaign_segment_member_permitted ON public.sms_campaign_segment_members;
CREATE TRIGGER sms_campaign_segment_member_permitted
  BEFORE INSERT OR UPDATE ON public.sms_campaign_segment_members
  FOR EACH ROW EXECUTE FUNCTION public.sms_campaign_segment_member_is_permitted();

-- Recording an exclusion evicts the member row in the same transaction, so
-- there is no window in which a person is both excluded and a member.
CREATE OR REPLACE FUNCTION public.sms_campaign_segment_override_applies()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.override_type = 'exclude' AND NEW.revoked_at IS NULL THEN
    DELETE FROM public.sms_campaign_segment_members
    WHERE segment_id = NEW.segment_id AND contact_phone = NEW.contact_phone;

    UPDATE public.sms_campaign_segments
    SET member_count = (
          SELECT count(*) FROM public.sms_campaign_segment_members
          WHERE segment_id = NEW.segment_id
        ),
        updated_at = now()
    WHERE id = NEW.segment_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_campaign_segment_override_applied ON public.sms_campaign_segment_overrides;
CREATE TRIGGER sms_campaign_segment_override_applied
  AFTER INSERT OR UPDATE ON public.sms_campaign_segment_overrides
  FOR EACH ROW EXECUTE FUNCTION public.sms_campaign_segment_override_applies();

-- ── Campaign archival ───────────────────────────────────────────────────────
-- Additive, nullable columns only. Nothing existing is rewritten. A campaign
-- that has been approved, scheduled, or has any recipient that reached a
-- provider is archived rather than deleted; see delete_sms_campaign below.

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by bigint REFERENCES sms_users(id),
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS sms_campaigns_live_list_idx
  ON public.sms_campaigns (workspace_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ── RPCs ────────────────────────────────────────────────────────────────────

-- Create a segment. Manual segments may carry an initial member list; an
-- automatic segment starts empty and is filled by recompute.
CREATE OR REPLACE FUNCTION public.create_sms_campaign_segment(
  p_workspace_id text,
  p_actor_user_id bigint,
  p_segment_key text,
  p_name text,
  p_description text,
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
  v_count integer := 0;
BEGIN
  IF p_segment_kind NOT IN ('automatic', 'manual') THEN
    RAISE EXCEPTION 'segment_kind_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_segment_kind = 'manual' AND p_members IS NOT NULL
     AND jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'segment_members_invalid' USING ERRCODE = 'P0001';
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
    workspace_id, segment_key, name, description, segment_kind,
    definition, rule_version, created_by, updated_by
  ) VALUES (
    p_workspace_id, p_segment_key, p_name, nullif(trim(coalesce(p_description, '')), ''),
    p_segment_kind, coalesce(p_definition, '{}'::jsonb), p_rule_version,
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

-- Add one member to a MANUAL segment. Automatic segments take force-includes
-- through set_sms_campaign_segment_override instead, so that the reason a
-- person is present is never ambiguous.
CREATE OR REPLACE FUNCTION public.add_sms_campaign_segment_member(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_contact_phone text,
  p_contact_id bigint,
  p_contact_name text,
  p_reason text
) RETURNS public.sms_campaign_segment_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_member public.sms_campaign_segment_members%ROWTYPE;
BEGIN
  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_segment.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'segment_archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_segment.segment_kind <> 'manual' THEN
    RAISE EXCEPTION 'segment_is_automatic_use_override' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.sms_campaign_segment_members (
    segment_id, workspace_id, contact_phone, contact_id, contact_name_snapshot,
    membership_source, inclusion_evidence, evidence_rule_version, added_by
  ) VALUES (
    p_segment_id, p_workspace_id, p_contact_phone, p_contact_id,
    left(nullif(trim(coalesce(p_contact_name, '')), ''), 200), 'manual',
    jsonb_build_object(
      'source', 'manual_selection',
      'reason', left(nullif(trim(coalesce(p_reason, '')), ''), 500),
      'addedByUserID', p_actor_user_id,
      'addedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    v_segment.rule_version, p_actor_user_id
  )
  ON CONFLICT (segment_id, contact_phone) DO UPDATE
    SET contact_id = coalesce(EXCLUDED.contact_id, public.sms_campaign_segment_members.contact_id),
        contact_name_snapshot = coalesce(EXCLUDED.contact_name_snapshot,
                                         public.sms_campaign_segment_members.contact_name_snapshot),
        last_seen_at = now(), updated_at = now()
  RETURNING * INTO v_member;

  UPDATE public.sms_campaign_segments
  SET member_count = (SELECT count(*) FROM public.sms_campaign_segment_members WHERE segment_id = p_segment_id),
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = p_segment_id;

  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_sms_campaign_segment_member(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_contact_phone text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_removed integer := 0;
BEGIN
  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_segment.segment_kind <> 'manual' THEN
    RAISE EXCEPTION 'segment_is_automatic_use_override' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.sms_campaign_segment_members
  WHERE segment_id = p_segment_id AND workspace_id = p_workspace_id
    AND contact_phone = p_contact_phone;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.sms_campaign_segments
  SET member_count = (SELECT count(*) FROM public.sms_campaign_segment_members WHERE segment_id = p_segment_id),
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = p_segment_id;

  RETURN v_removed;
END;
$$;

-- Force-include or force-exclude on an AUTOMATIC segment. An exclusion is
-- permanent until revoked: the row survives every recompute, and the member
-- trigger refuses to reinsert the phone while it is active.
CREATE OR REPLACE FUNCTION public.set_sms_campaign_segment_override(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_contact_phone text,
  p_override_type text,
  p_reason text,
  p_contact_id bigint,
  p_contact_name text
) RETURNS public.sms_campaign_segment_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_override public.sms_campaign_segment_overrides%ROWTYPE;
BEGIN
  IF p_override_type NOT IN ('include', 'exclude') THEN
    RAISE EXCEPTION 'segment_override_type_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_segment.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'segment_archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_segment.segment_kind <> 'automatic' THEN
    RAISE EXCEPTION 'segment_is_manual_use_member_endpoints' USING ERRCODE = 'P0001';
  END IF;

  -- Replacing an override is an explicit revoke plus a new row, so the trail
  -- keeps both decisions rather than mutating one into the other.
  UPDATE public.sms_campaign_segment_overrides
  SET revoked_at = now(), revoked_by = p_actor_user_id,
      revoke_reason = 'replaced_by_new_override', updated_at = now()
  WHERE segment_id = p_segment_id AND contact_phone = p_contact_phone
    AND revoked_at IS NULL AND override_type <> p_override_type;

  INSERT INTO public.sms_campaign_segment_overrides (
    segment_id, workspace_id, contact_phone, override_type, reason, created_by
  ) VALUES (
    p_segment_id, p_workspace_id, p_contact_phone, p_override_type,
    left(nullif(trim(coalesce(p_reason, '')), ''), 500), p_actor_user_id
  )
  ON CONFLICT (segment_id, contact_phone) WHERE revoked_at IS NULL
  DO UPDATE SET reason = coalesce(EXCLUDED.reason, public.sms_campaign_segment_overrides.reason),
                updated_at = now()
  RETURNING * INTO v_override;

  IF p_override_type = 'include' THEN
    INSERT INTO public.sms_campaign_segment_members (
      segment_id, workspace_id, contact_phone, contact_id, contact_name_snapshot,
      membership_source, inclusion_evidence, evidence_rule_version, added_by
    ) VALUES (
      p_segment_id, p_workspace_id, p_contact_phone, p_contact_id,
      left(nullif(trim(coalesce(p_contact_name, '')), ''), 200), 'forced_include',
      jsonb_build_object(
        'source', 'manual_override_include',
        'reason', left(nullif(trim(coalesce(p_reason, '')), ''), 500),
        'addedByUserID', p_actor_user_id,
        'addedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      v_segment.rule_version, p_actor_user_id
    )
    ON CONFLICT (segment_id, contact_phone) DO UPDATE
      SET membership_source = 'forced_include',
          inclusion_evidence = EXCLUDED.inclusion_evidence,
          added_by = EXCLUDED.added_by,
          last_seen_at = now(), updated_at = now();
  END IF;

  UPDATE public.sms_campaign_segments
  SET member_count = (SELECT count(*) FROM public.sms_campaign_segment_members WHERE segment_id = p_segment_id),
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = p_segment_id;

  RETURN v_override;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_sms_campaign_segment_override(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_contact_phone text,
  p_reason text
) RETURNS public.sms_campaign_segment_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_override public.sms_campaign_segment_overrides%ROWTYPE;
BEGIN
  UPDATE public.sms_campaign_segment_overrides
  SET revoked_at = now(), revoked_by = p_actor_user_id,
      revoke_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 500),
      updated_at = now()
  WHERE segment_id = p_segment_id AND workspace_id = p_workspace_id
    AND contact_phone = p_contact_phone AND revoked_at IS NULL
  RETURNING * INTO v_override;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_override_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Revoking a force-include removes the row it created. Revoking an
  -- exclusion does NOT resurrect anybody: the next recompute decides, which is
  -- the whole point of the automatic segment.
  IF v_override.override_type = 'include' THEN
    DELETE FROM public.sms_campaign_segment_members
    WHERE segment_id = p_segment_id AND contact_phone = p_contact_phone
      AND membership_source = 'forced_include';
  END IF;

  UPDATE public.sms_campaign_segments
  SET member_count = (SELECT count(*) FROM public.sms_campaign_segment_members WHERE segment_id = p_segment_id),
      updated_by = p_actor_user_id, updated_at = now()
  WHERE id = p_segment_id;

  RETURN v_override;
END;
$$;

-- Apply one recompute of an automatic segment, atomically and idempotently.
--
-- `p_members` is the engine's full computed membership set, already filtered
-- by lib/campaigns/segment-membership.js. This function does NOT trust that
-- filtering: the member trigger refuses any actively excluded phone, and this
-- body skips them explicitly so the run counts stay honest.
--
-- Replaying the same p_run_key returns the ORIGINAL run row and changes
-- nothing, so a retried request cannot double-count a join.
CREATE OR REPLACE FUNCTION public.apply_sms_campaign_segment_recompute(
  p_segment_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_run_key text,
  p_rule_version text,
  p_input_digest text,
  p_members jsonb
) RETURNS public.sms_campaign_segment_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_segment public.sms_campaign_segments%ROWTYPE;
  v_run public.sms_campaign_segment_runs%ROWTYPE;
  v_run_id uuid := gen_random_uuid();
  v_joined integer := 0;
  v_left integer := 0;
  v_refreshed integer := 0;
  v_forced integer := 0;
  v_excluded integer := 0;
  v_total integer := 0;
  v_candidate_count integer := 0;
  v_incoming jsonb := '[]'::jsonb;
BEGIN
  IF p_members IS NULL OR jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'segment_members_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(coalesce(trim(p_run_key), '')) = 0 THEN
    RAISE EXCEPTION 'segment_run_key_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_segment FROM public.sms_campaign_segments
  WHERE id = p_segment_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'segment_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_segment.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'segment_archived' USING ERRCODE = 'P0001';
  END IF;
  IF v_segment.segment_kind <> 'automatic' THEN
    RAISE EXCEPTION 'segment_is_manual_and_is_not_recomputable' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency. The unique index on (segment_id, run_key) is the authority;
  -- this read makes the replay cheap and returns the original counts.
  SELECT * INTO v_run FROM public.sms_campaign_segment_runs
  WHERE segment_id = p_segment_id AND run_key = p_run_key;
  IF FOUND THEN RETURN v_run; END IF;

  -- Deduplicate the incoming set, then drop every actively excluded phone.
  -- Doing this here rather than trusting the caller is deliberate: the
  -- application filters too, and neither filter is relied on alone.
  SELECT
    count(*)::integer,
    coalesce(jsonb_agg(candidate.value ORDER BY candidate.phone)
      FILTER (WHERE NOT candidate.is_excluded), '[]'::jsonb)
  INTO v_candidate_count, v_incoming
  FROM (
    SELECT DISTINCT ON (element.value->>'contactPhone')
      element.value->>'contactPhone' AS phone,
      element.value AS value,
      EXISTS (
        SELECT 1 FROM public.sms_campaign_segment_overrides o
        WHERE o.segment_id = p_segment_id
          AND o.contact_phone = element.value->>'contactPhone'
          AND o.override_type = 'exclude'
          AND o.revoked_at IS NULL
      ) AS is_excluded
    FROM jsonb_array_elements(p_members) AS element
    WHERE element.value->>'contactPhone' IS NOT NULL
    ORDER BY element.value->>'contactPhone'
  ) AS candidate;

  v_excluded := v_candidate_count - jsonb_array_length(v_incoming);

  -- Computed rows the engine no longer matches leave. Force-included rows are
  -- never touched here: a person put them there.
  DELETE FROM public.sms_campaign_segment_members m
  WHERE m.segment_id = p_segment_id
    AND m.membership_source = 'computed'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_incoming) AS element
      WHERE element.value->>'contactPhone' = m.contact_phone
    );
  GET DIAGNOSTICS v_left = ROW_COUNT;

  WITH upserted AS (
    INSERT INTO public.sms_campaign_segment_members (
      segment_id, workspace_id, contact_phone, contact_id, contact_name_snapshot,
      membership_source, inclusion_evidence, evidence_rule_version,
      engine_matched, engine_evidence, computed_run_id
    )
    SELECT
      p_segment_id, p_workspace_id,
      element.value->>'contactPhone',
      nullif(element.value->>'contactID', '')::bigint,
      left(nullif(element.value->>'contactName', ''), 200),
      'computed',
      coalesce(element.value->'inclusionEvidence', '{}'::jsonb),
      p_rule_version, true,
      coalesce(element.value->'inclusionEvidence', '{}'::jsonb),
      v_run_id
    FROM jsonb_array_elements(v_incoming) AS element
    ON CONFLICT (segment_id, contact_phone) DO UPDATE SET
      contact_id = coalesce(EXCLUDED.contact_id, public.sms_campaign_segment_members.contact_id),
      contact_name_snapshot = coalesce(EXCLUDED.contact_name_snapshot,
                                       public.sms_campaign_segment_members.contact_name_snapshot),
      -- A force-included row keeps its human reason and its source. Only the
      -- engine's own view of it is refreshed.
      inclusion_evidence = CASE
        WHEN public.sms_campaign_segment_members.membership_source = 'forced_include'
        THEN public.sms_campaign_segment_members.inclusion_evidence
        ELSE EXCLUDED.inclusion_evidence END,
      membership_source = public.sms_campaign_segment_members.membership_source,
      evidence_rule_version = EXCLUDED.evidence_rule_version,
      engine_matched = true,
      engine_evidence = EXCLUDED.engine_evidence,
      computed_run_id = EXCLUDED.computed_run_id,
      last_seen_at = now(),
      updated_at = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT
    coalesce(count(*) FILTER (WHERE inserted), 0)::integer,
    coalesce(count(*) FILTER (WHERE NOT inserted), 0)::integer
  INTO v_joined, v_refreshed
  FROM upserted;

  -- Force-included people the engine did NOT match this run stay members and
  -- are marked as such, so the UI can say "kept by a person, engine no longer
  -- agrees".
  UPDATE public.sms_campaign_segment_members m
  SET engine_matched = false, engine_evidence = NULL, computed_run_id = v_run_id, updated_at = now()
  WHERE m.segment_id = p_segment_id
    AND m.membership_source = 'forced_include'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_incoming) AS element
      WHERE element.value->>'contactPhone' = m.contact_phone
    );

  SELECT
    coalesce(count(*) FILTER (WHERE membership_source = 'forced_include'), 0)::integer,
    count(*)::integer
  INTO v_forced, v_total
  FROM public.sms_campaign_segment_members WHERE segment_id = p_segment_id;

  INSERT INTO public.sms_campaign_segment_runs (
    id, segment_id, workspace_id, run_key, rule_version, input_digest,
    member_count, joined_count, left_count, refreshed_count,
    forced_include_count, excluded_count, actor_user_id
  ) VALUES (
    v_run_id, p_segment_id, p_workspace_id, p_run_key, p_rule_version, p_input_digest,
    v_total, v_joined, v_left, v_refreshed, v_forced, v_excluded, p_actor_user_id
  )
  RETURNING * INTO v_run;

  UPDATE public.sms_campaign_segments
  SET member_count = v_total, last_computed_at = now(), last_run_id = v_run_id,
      rule_version = coalesce(p_rule_version, rule_version), updated_at = now()
  WHERE id = p_segment_id;

  RETURN v_run;
END;
$$;

-- Delete or archive a campaign.
--
-- DESTRUCTIVE IS THE NARROW CASE. A draft that was never approved, never
-- scheduled, never reached a provider and has no approval history is somebody
-- pressing "new campaign" by mistake; keeping it forever is clutter, not
-- evidence. Everything else is an audit trail and financial attribution
-- evidence, so it is archived instead and this function REFUSES to destroy it
-- even if the caller asks.
--
-- p_mode: 'auto' picks per the rules above. 'archive' always archives.
--         There is deliberately no 'force_delete'.
CREATE OR REPLACE FUNCTION public.delete_sms_campaign(
  p_campaign_id uuid,
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
  v_campaign public.sms_campaigns%ROWTYPE;
  v_blockers text[] := ARRAY[]::text[];
  v_recipients integer := 0;
  v_has_attribution boolean := false;
BEGIN
  IF coalesce(p_mode, 'auto') NOT IN ('auto', 'archive') THEN
    RAISE EXCEPTION 'campaign_delete_mode_invalid' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_campaign.status <> 'draft' THEN
    v_blockers := v_blockers || ('status_' || v_campaign.status);
  END IF;
  IF v_campaign.approved_at IS NOT NULL OR v_campaign.approval_audit_recorded_at IS NOT NULL THEN
    v_blockers := v_blockers || 'approved';
  END IF;
  IF v_campaign.scheduled_for IS NOT NULL THEN
    v_blockers := v_blockers || 'scheduled';
  END IF;
  IF v_campaign.submitted_for_review_at IS NOT NULL THEN
    v_blockers := v_blockers || 'submitted_for_review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_campaign_approvals WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'approval_history';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_campaign_recipient_events WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'recipient_events';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_commercial_contact_ledger WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'commercial_contact_ledger';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_messages WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'linked_messages';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sms_sent_log WHERE campaign_id = p_campaign_id) THEN
    v_blockers := v_blockers || 'linked_sent_log';
  END IF;
  -- Any recipient that reached, or started reaching, a provider.
  IF EXISTS (
    SELECT 1 FROM public.sms_campaign_recipients
    WHERE campaign_id = p_campaign_id
      AND (provider_message_id IS NOT NULL
        OR provider_idempotency_key IS NOT NULL
        OR provider_attempt_started_at IS NOT NULL
        OR sent_at IS NOT NULL
        OR delivered_at IS NOT NULL
        OR failed_at IS NOT NULL
        OR state IN ('claimed', 'sending', 'sent', 'delivered', 'failed', 'reconciliation_required'))
  ) THEN
    v_blockers := v_blockers || 'recipient_reached_provider';
  END IF;
  -- revenue_attributions is created by scripts/analytics-migration.sql, which
  -- may not be applied yet. Probe dynamically rather than failing to compile.
  IF to_regclass('public.revenue_attributions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.revenue_attributions WHERE campaign_id = $1)'
      INTO v_has_attribution USING p_campaign_id;
    IF v_has_attribution THEN
      v_blockers := v_blockers || 'revenue_attribution';
    END IF;
  END IF;

  IF p_mode = 'archive' OR array_length(v_blockers, 1) IS NOT NULL THEN
    UPDATE public.sms_campaigns
    SET archived_at = coalesce(archived_at, now()),
        archived_by = coalesce(archived_by, p_actor_user_id),
        archive_reason = coalesce(archive_reason, left(nullif(trim(coalesce(p_reason, '')), ''), 500)),
        updated_by = p_actor_user_id,
        updated_at = now()
    WHERE id = p_campaign_id AND workspace_id = p_workspace_id;
    RETURN jsonb_build_object(
      'outcome', 'archived',
      'campaignId', p_campaign_id,
      'blockers', to_jsonb(v_blockers),
      'title', v_campaign.title,
      'status', v_campaign.status
    );
  END IF;

  SELECT count(*) INTO v_recipients FROM public.sms_campaign_recipients
  WHERE campaign_id = p_campaign_id;

  -- Recipients cascade; nothing else references a never-approved draft.
  DELETE FROM public.sms_campaign_opportunities
  WHERE workspace_id = p_workspace_id AND created_campaign_id = p_campaign_id;
  DELETE FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'outcome', 'deleted',
    'campaignId', p_campaign_id,
    'blockers', to_jsonb(ARRAY[]::text[]),
    'title', v_campaign.title,
    'status', v_campaign.status,
    'recipientsRemoved', v_recipients
  );
END;
$$;

-- ── Access ──────────────────────────────────────────────────────────────────
-- RLS is fail-closed with no anon/authenticated policies. The Railway backend
-- service role remains the only application access path, exactly as the
-- existing campaign tables do it.

ALTER TABLE sms_campaign_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_segment_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_segment_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_segment_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_campaign_segments, public.sms_campaign_segment_members,
  public.sms_campaign_segment_overrides, public.sms_campaign_segment_runs
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.sms_campaign_segments, public.sms_campaign_segment_members,
  public.sms_campaign_segment_overrides, public.sms_campaign_segment_runs TO service_role;

REVOKE ALL ON FUNCTION public.create_sms_campaign_segment(text,bigint,text,text,text,text,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_sms_campaign_segment_member(uuid,text,bigint,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_sms_campaign_segment_member(uuid,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_sms_campaign_segment_override(uuid,text,bigint,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_sms_campaign_segment_override(uuid,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_sms_campaign_segment_recompute(uuid,text,bigint,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_sms_campaign(uuid,text,bigint,text,text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_sms_campaign_segment(text,bigint,text,text,text,text,jsonb,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_sms_campaign_segment_member(uuid,text,bigint,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_sms_campaign_segment_member(uuid,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_sms_campaign_segment_override(uuid,text,bigint,text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_sms_campaign_segment_override(uuid,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_sms_campaign_segment_recompute(uuid,text,bigint,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_sms_campaign(uuid,text,bigint,text,text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
