-- Vici Inbox conversation referrals.
--
-- ADDITIVE AND RE-RUNNABLE
--   This migration adds referral permissions, two service-role-only tables,
--   and database-owned transition functions. It does not alter message,
--   contact, calling, campaign, or automation rows.
--
-- DEPLOYMENT ORDER
--   Apply this migration before deploying routes/referrals.js. The backend
--   validates every route-policy permission at startup, so deploying the new
--   policy keys first would deliberately fail boot rather than serve an
--   unguarded endpoint.
--
-- ONE CONVERSATION, ONE OWNER
--   The partial unique index permits only one unresolved referral per phone.
--   Initial claims are conditional UPDATEs inside Postgres. There is no Node
--   check followed by a write, so two Admins tapping an any-admin push cannot
--   both win.
--
-- INTERNAL NOTES
--   Notes live only in these referral tables. They are not message rows and no
--   function in this file touches sms_messages or a provider send path.

BEGIN;

INSERT INTO public.sms_permissions (key, resource, action, description, is_destructive) VALUES
  ('referral.read',   'referral', 'read',   'Read conversation referrals in which this account may participate.', false),
  ('referral.create', 'referral', 'create', 'Refer a visible conversation to an eligible named teammate.', false),
  ('referral.act',    'referral', 'act',    'Claim or act on a referral when its ownership rules allow it.', false)
ON CONFLICT (key) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  is_destructive = EXCLUDED.is_destructive;

-- Future permissions are not inherited by roles from the original
-- INSERT...SELECT seed. Grant these explicitly. The shared legacy identity is
-- intentionally omitted because assignment needs one accountable person.
INSERT INTO public.sms_role_permissions (role_key, permission_key)
SELECT role_key, permission_key
FROM (VALUES
  ('owner', 'referral.read'), ('owner', 'referral.create'), ('owner', 'referral.act'),
  ('admin', 'referral.read'), ('admin', 'referral.create'), ('admin', 'referral.act'),
  ('agent', 'referral.read'), ('agent', 'referral.create'), ('agent', 'referral.act')
) AS grants(role_key, permission_key)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sms_conversation_referrals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            text NOT NULL DEFAULT 'vici',
  contact_phone           text NOT NULL
                            CHECK (contact_phone ~ '^[+][1-9][0-9]{7,14}$'),
  referred_by_user_id     bigint NOT NULL REFERENCES public.sms_users (id),
  target_kind             text NOT NULL CHECK (target_kind IN ('directed', 'any_admin')),
  original_target_user_id bigint REFERENCES public.sms_users (id),
  owner_user_id           bigint REFERENCES public.sms_users (id),
  state                   text NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'owned', 'resolved')),
  initial_note            text CHECK (initial_note IS NULL OR char_length(initial_note) <= 1000),
  claimed_at              timestamptz,
  resolved_at             timestamptz,
  resolved_by_user_id     bigint REFERENCES public.sms_users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT sms_referrals_target_shape CHECK (
    (target_kind = 'directed' AND original_target_user_id IS NOT NULL)
    OR (target_kind = 'any_admin' AND original_target_user_id IS NULL)
  ),
  CONSTRAINT sms_referrals_state_shape CHECK (
    (state = 'pending' AND owner_user_id IS NULL AND claimed_at IS NULL
      AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
    OR (state = 'owned' AND owner_user_id IS NOT NULL AND claimed_at IS NOT NULL
      AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
    OR (state = 'resolved' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_conversation_referrals_one_open_phone_idx
  ON public.sms_conversation_referrals (workspace_id, contact_phone)
  WHERE state IN ('pending', 'owned');
CREATE INDEX IF NOT EXISTS sms_conversation_referrals_creator_idx
  ON public.sms_conversation_referrals (workspace_id, referred_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_conversation_referrals_target_idx
  ON public.sms_conversation_referrals (workspace_id, original_target_user_id, created_at DESC)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS sms_conversation_referrals_owner_idx
  ON public.sms_conversation_referrals (workspace_id, owner_user_id, updated_at DESC)
  WHERE state = 'owned';
CREATE INDEX IF NOT EXISTS sms_conversation_referrals_unclaimed_idx
  ON public.sms_conversation_referrals (workspace_id, created_at)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS public.sms_conversation_referral_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   text NOT NULL DEFAULT 'vici',
  referral_id    uuid NOT NULL REFERENCES public.sms_conversation_referrals (id) ON DELETE CASCADE,
  action         text NOT NULL CHECK (action IN ('created', 'claimed', 'reassigned', 'handed_back', 'resolved')),
  actor_user_id  bigint NOT NULL REFERENCES public.sms_users (id),
  from_user_id   bigint REFERENCES public.sms_users (id),
  to_user_id     bigint REFERENCES public.sms_users (id),
  note           text CHECK (note IS NULL OR char_length(note) <= 1000),
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_conversation_referral_events_referral_idx
  ON public.sms_conversation_referral_events (workspace_id, referral_id, id);

CREATE OR REPLACE FUNCTION public.touch_sms_conversation_referral_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_conversation_referrals_touch_updated_at
  ON public.sms_conversation_referrals;
CREATE TRIGGER sms_conversation_referrals_touch_updated_at
BEFORE UPDATE ON public.sms_conversation_referrals
FOR EACH ROW EXECUTE FUNCTION public.touch_sms_conversation_referral_updated_at();

CREATE OR REPLACE FUNCTION public.block_sms_conversation_referral_event_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'sms_conversation_referral_events is append-only: % is not permitted.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS sms_conversation_referral_events_immutable
  ON public.sms_conversation_referral_events;
CREATE TRIGGER sms_conversation_referral_events_immutable
BEFORE UPDATE OR DELETE ON public.sms_conversation_referral_events
FOR EACH ROW EXECUTE FUNCTION public.block_sms_conversation_referral_event_change();

DROP TRIGGER IF EXISTS sms_conversation_referral_events_no_truncate
  ON public.sms_conversation_referral_events;
CREATE TRIGGER sms_conversation_referral_events_no_truncate
BEFORE TRUNCATE ON public.sms_conversation_referral_events
FOR EACH STATEMENT EXECUTE FUNCTION public.block_sms_conversation_referral_event_change();

-- Effective permissions include role grants, explicit allows, and denials.
CREATE OR REPLACE FUNCTION public.sms_referral_actor_has(
  p_user_id bigint,
  p_permission text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.sms_users u
    JOIN public.sms_effective_permissions p ON p.user_id = u.id
    WHERE u.id = p_user_id
      AND u.is_active = true
      AND u.is_legacy_shared = false
      AND p.permission_key = p_permission
  );
$$;

CREATE OR REPLACE FUNCTION public.sms_referral_recipient_eligible(p_user_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.sms_referral_actor_has(p_user_id, 'conversation.read')
     AND public.sms_referral_actor_has(p_user_id, 'message.send')
     AND public.sms_referral_actor_has(p_user_id, 'referral.read')
     AND public.sms_referral_actor_has(p_user_id, 'referral.act');
$$;

CREATE OR REPLACE FUNCTION public.create_sms_conversation_referral(
  p_workspace_id text,
  p_contact_phone text,
  p_actor_user_id bigint,
  p_target_kind text,
  p_target_user_id bigint,
  p_note text
)
RETURNS public.sms_conversation_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sms_conversation_referrals%ROWTYPE;
  v_note text := NULLIF(trim(coalesce(p_note, '')), '');
BEGIN
  IF p_workspace_id <> 'vici' THEN RAISE EXCEPTION 'REFERRAL_WORKSPACE_INVALID'; END IF;
  IF p_contact_phone IS NULL OR p_contact_phone !~ '^[+][1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'REFERRAL_PHONE_INVALID';
  END IF;
  IF char_length(coalesce(v_note, '')) > 1000 THEN RAISE EXCEPTION 'REFERRAL_NOTE_TOO_LONG'; END IF;
  IF NOT public.sms_referral_actor_has(p_actor_user_id, 'referral.create')
     OR NOT public.sms_referral_recipient_eligible(p_actor_user_id) THEN
    RAISE EXCEPTION 'REFERRAL_ACTOR_INELIGIBLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sms_contacts WHERE phone = p_contact_phone) THEN
    RAISE EXCEPTION 'REFERRAL_CONVERSATION_NOT_FOUND';
  END IF;
  IF p_target_kind = 'directed' THEN
    IF p_target_user_id IS NULL OR p_target_user_id = p_actor_user_id
       OR NOT public.sms_referral_recipient_eligible(p_target_user_id) THEN
      RAISE EXCEPTION 'REFERRAL_TARGET_INELIGIBLE';
    END IF;
  ELSIF p_target_kind = 'any_admin' THEN
    IF p_target_user_id IS NOT NULL THEN RAISE EXCEPTION 'REFERRAL_TARGET_INVALID'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.sms_users u
      WHERE u.id <> p_actor_user_id AND u.is_active = true
        AND u.is_legacy_shared = false AND u.role IN ('owner', 'admin')
        AND public.sms_referral_recipient_eligible(u.id)
    ) THEN
      RAISE EXCEPTION 'REFERRAL_TARGET_INELIGIBLE';
    END IF;
  ELSE
    RAISE EXCEPTION 'REFERRAL_TARGET_KIND_INVALID';
  END IF;

  BEGIN
    INSERT INTO public.sms_conversation_referrals (
      workspace_id, contact_phone, referred_by_user_id,
      target_kind, original_target_user_id, initial_note
    ) VALUES (
      p_workspace_id, p_contact_phone, p_actor_user_id,
      p_target_kind, p_target_user_id, v_note
    ) RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'REFERRAL_ALREADY_OPEN' USING ERRCODE = 'P0001';
  END;

  INSERT INTO public.sms_conversation_referral_events (
    workspace_id, referral_id, action, actor_user_id, to_user_id, note
  ) VALUES (
    p_workspace_id, v_row.id, 'created', p_actor_user_id, p_target_user_id, v_note
  );
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_sms_conversation_referral(
  p_workspace_id text,
  p_referral_id uuid,
  p_actor_user_id bigint
)
RETURNS public.sms_conversation_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sms_conversation_referrals%ROWTYPE;
BEGIN
  IF NOT public.sms_referral_actor_has(p_actor_user_id, 'referral.act')
     OR NOT public.sms_referral_recipient_eligible(p_actor_user_id) THEN
    RAISE EXCEPTION 'REFERRAL_ACTOR_INELIGIBLE';
  END IF;

  UPDATE public.sms_conversation_referrals r
  SET owner_user_id = p_actor_user_id,
      state = 'owned',
      claimed_at = now(),
      version = version + 1
  WHERE r.id = p_referral_id
    AND r.workspace_id = p_workspace_id
    AND r.state = 'pending'
    AND r.owner_user_id IS NULL
    AND r.referred_by_user_id <> p_actor_user_id
    AND (
      (r.target_kind = 'directed' AND r.original_target_user_id = p_actor_user_id)
      OR (
        r.target_kind = 'any_admin'
        AND EXISTS (
          SELECT 1 FROM public.sms_users u
          WHERE u.id = p_actor_user_id AND u.is_active = true
            AND u.is_legacy_shared = false AND u.role IN ('owner', 'admin')
        )
      )
    )
  RETURNING r.* INTO v_row;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.sms_conversation_referrals
      WHERE id = p_referral_id AND workspace_id = p_workspace_id
        AND state <> 'pending'
    ) THEN
      RAISE EXCEPTION 'REFERRAL_ALREADY_CLAIMED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'REFERRAL_NOT_CLAIMABLE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.sms_conversation_referral_events (
    workspace_id, referral_id, action, actor_user_id, to_user_id
  ) VALUES (p_workspace_id, v_row.id, 'claimed', p_actor_user_id, p_actor_user_id);
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.reassign_sms_conversation_referral(
  p_workspace_id text,
  p_referral_id uuid,
  p_actor_user_id bigint,
  p_target_user_id bigint,
  p_note text
)
RETURNS public.sms_conversation_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sms_conversation_referrals%ROWTYPE;
  v_actor_role text;
  v_previous bigint;
  v_note text := NULLIF(trim(coalesce(p_note, '')), '');
BEGIN
  SELECT role INTO v_actor_role FROM public.sms_users
  WHERE id = p_actor_user_id AND is_active = true AND is_legacy_shared = false;
  IF NOT public.sms_referral_actor_has(p_actor_user_id, 'referral.act') THEN
    RAISE EXCEPTION 'REFERRAL_ACTOR_INELIGIBLE';
  END IF;
  IF NOT public.sms_referral_recipient_eligible(p_target_user_id) THEN
    RAISE EXCEPTION 'REFERRAL_TARGET_INELIGIBLE';
  END IF;
  IF char_length(coalesce(v_note, '')) > 1000 THEN RAISE EXCEPTION 'REFERRAL_NOTE_TOO_LONG'; END IF;

  SELECT * INTO v_row FROM public.sms_conversation_referrals
  WHERE id = p_referral_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFERRAL_NOT_FOUND'; END IF;
  IF v_row.state <> 'owned' THEN RAISE EXCEPTION 'REFERRAL_NOT_OWNED'; END IF;
  IF v_row.owner_user_id <> p_actor_user_id AND v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'REFERRAL_ACTION_FORBIDDEN';
  END IF;
  -- Returning ownership to the original referrer has its own explicit action
  -- and requires a note. It cannot be smuggled through generic reassignment.
  IF p_target_user_id = v_row.referred_by_user_id THEN
    RAISE EXCEPTION 'REFERRAL_USE_HAND_BACK';
  END IF;
  IF v_row.owner_user_id = p_target_user_id THEN RAISE EXCEPTION 'REFERRAL_TARGET_UNCHANGED'; END IF;
  v_previous := v_row.owner_user_id;

  UPDATE public.sms_conversation_referrals
  SET owner_user_id = p_target_user_id, version = version + 1
  WHERE id = p_referral_id
  RETURNING * INTO v_row;
  INSERT INTO public.sms_conversation_referral_events (
    workspace_id, referral_id, action, actor_user_id, from_user_id, to_user_id, note
  ) VALUES (
    p_workspace_id, v_row.id, 'reassigned', p_actor_user_id, v_previous, p_target_user_id, v_note
  );
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hand_back_sms_conversation_referral(
  p_workspace_id text,
  p_referral_id uuid,
  p_actor_user_id bigint,
  p_note text
)
RETURNS public.sms_conversation_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sms_conversation_referrals%ROWTYPE;
  v_actor_role text;
  v_previous bigint;
  v_note text := NULLIF(trim(coalesce(p_note, '')), '');
BEGIN
  IF v_note IS NULL THEN RAISE EXCEPTION 'REFERRAL_NOTE_REQUIRED'; END IF;
  IF char_length(v_note) > 1000 THEN RAISE EXCEPTION 'REFERRAL_NOTE_TOO_LONG'; END IF;
  SELECT role INTO v_actor_role FROM public.sms_users
  WHERE id = p_actor_user_id AND is_active = true AND is_legacy_shared = false;
  IF NOT public.sms_referral_actor_has(p_actor_user_id, 'referral.act') THEN
    RAISE EXCEPTION 'REFERRAL_ACTOR_INELIGIBLE';
  END IF;

  SELECT * INTO v_row FROM public.sms_conversation_referrals
  WHERE id = p_referral_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFERRAL_NOT_FOUND'; END IF;
  IF v_row.state <> 'owned' THEN RAISE EXCEPTION 'REFERRAL_NOT_OWNED'; END IF;
  IF v_row.owner_user_id <> p_actor_user_id AND v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'REFERRAL_ACTION_FORBIDDEN';
  END IF;
  IF NOT public.sms_referral_recipient_eligible(v_row.referred_by_user_id) THEN
    RAISE EXCEPTION 'REFERRAL_REFERRER_UNAVAILABLE';
  END IF;
  IF v_row.owner_user_id = v_row.referred_by_user_id THEN
    RAISE EXCEPTION 'REFERRAL_ALREADY_HANDED_BACK';
  END IF;
  v_previous := v_row.owner_user_id;

  UPDATE public.sms_conversation_referrals
  SET owner_user_id = referred_by_user_id, version = version + 1
  WHERE id = p_referral_id
  RETURNING * INTO v_row;
  INSERT INTO public.sms_conversation_referral_events (
    workspace_id, referral_id, action, actor_user_id, from_user_id, to_user_id, note
  ) VALUES (
    p_workspace_id, v_row.id, 'handed_back', p_actor_user_id,
    v_previous, v_row.referred_by_user_id, v_note
  );
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_sms_conversation_referral(
  p_workspace_id text,
  p_referral_id uuid,
  p_actor_user_id bigint
)
RETURNS public.sms_conversation_referrals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sms_conversation_referrals%ROWTYPE;
  v_actor_role text;
BEGIN
  SELECT role INTO v_actor_role FROM public.sms_users
  WHERE id = p_actor_user_id AND is_active = true AND is_legacy_shared = false;
  IF NOT public.sms_referral_actor_has(p_actor_user_id, 'referral.act') THEN
    RAISE EXCEPTION 'REFERRAL_ACTOR_INELIGIBLE';
  END IF;

  SELECT * INTO v_row FROM public.sms_conversation_referrals
  WHERE id = p_referral_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFERRAL_NOT_FOUND'; END IF;
  IF v_row.state = 'resolved' THEN RAISE EXCEPTION 'REFERRAL_ALREADY_RESOLVED'; END IF;
  IF (v_row.owner_user_id IS NULL OR v_row.owner_user_id <> p_actor_user_id)
     AND v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'REFERRAL_ACTION_FORBIDDEN';
  END IF;

  UPDATE public.sms_conversation_referrals
  SET state = 'resolved', resolved_at = now(), resolved_by_user_id = p_actor_user_id,
      version = version + 1
  WHERE id = p_referral_id
  RETURNING * INTO v_row;
  INSERT INTO public.sms_conversation_referral_events (
    workspace_id, referral_id, action, actor_user_id, from_user_id
  ) VALUES (
    p_workspace_id, v_row.id, 'resolved', p_actor_user_id, v_row.owner_user_id
  );
  RETURN v_row;
END;
$$;

-- Direct table access stays behind Railway's service-role client.
ALTER TABLE public.sms_conversation_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_conversation_referral_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_conversation_referrals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sms_conversation_referral_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sms_conversation_referrals TO service_role;
GRANT SELECT ON TABLE public.sms_conversation_referral_events TO service_role;

REVOKE ALL ON FUNCTION public.touch_sms_conversation_referral_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_sms_conversation_referral_event_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sms_referral_actor_has(bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sms_referral_recipient_eligible(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_sms_conversation_referral(text,text,bigint,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sms_conversation_referral(text,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reassign_sms_conversation_referral(text,uuid,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hand_back_sms_conversation_referral(text,uuid,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_sms_conversation_referral(text,uuid,bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.sms_referral_actor_has(bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sms_referral_recipient_eligible(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_sms_conversation_referral(text,text,bigint,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sms_conversation_referral(text,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.reassign_sms_conversation_referral(text,uuid,bigint,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hand_back_sms_conversation_referral(text,uuid,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_sms_conversation_referral(text,uuid,bigint) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
