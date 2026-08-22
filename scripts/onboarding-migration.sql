-- Vici Inbox - server-owned first-time onboarding state
--
-- Safe rollout order:
--   1. Apply this additive migration.
--   2. Deploy the backend endpoint.
--   3. Release the iOS client.
--
-- Existing accounts are intentionally marked `ineligible`. The full tour is
-- for genuinely new named accounts, not everyone who installs a new build.
-- After the existing rows have been protected, the column default is changed
-- to `not_started`, so future users created by any supported path are eligible
-- without duplicating that decision in each application insert.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sms_users'
      AND column_name = 'onboarding_status'
  ) THEN
    ALTER TABLE public.sms_users
      ADD COLUMN onboarding_status text NOT NULL DEFAULT 'ineligible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sms_users'
      AND column_name = 'onboarding_version'
  ) THEN
    ALTER TABLE public.sms_users
      ADD COLUMN onboarding_version integer NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sms_users'
      AND column_name = 'onboarding_decided_at'
  ) THEN
    ALTER TABLE public.sms_users
      ADD COLUMN onboarding_decided_at timestamptz;
  END IF;
END
$$;

-- Converge a manually/partially created predecessor schema before constraints
-- are attached. Unknown state is never treated as tour eligibility.
UPDATE public.sms_users
SET onboarding_status = 'ineligible'
WHERE onboarding_status IS NULL
   OR onboarding_status NOT IN ('not_started', 'completed', 'skipped', 'ineligible');
UPDATE public.sms_users
SET onboarding_version = 1
WHERE onboarding_version IS NULL OR onboarding_version <= 0;

ALTER TABLE public.sms_users
  ALTER COLUMN onboarding_status SET NOT NULL,
  ALTER COLUMN onboarding_version SET NOT NULL;

-- Record that pre-existing accounts were deliberately excluded from an
-- automatic tour. Reruns do not alter completed, skipped or new not_started
-- accounts.
UPDATE public.sms_users
SET onboarding_decided_at = COALESCE(onboarding_decided_at, now())
WHERE onboarding_status = 'ineligible'
  AND onboarding_decided_at IS NULL;

ALTER TABLE public.sms_users
  ALTER COLUMN onboarding_status SET DEFAULT 'not_started',
  ALTER COLUMN onboarding_version SET DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sms_users_onboarding_status_check'
      AND conrelid = 'public.sms_users'::regclass
  ) THEN
    ALTER TABLE public.sms_users
      ADD CONSTRAINT sms_users_onboarding_status_check
      CHECK (onboarding_status IN ('not_started', 'completed', 'skipped', 'ineligible'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sms_users_onboarding_version_check'
      AND conrelid = 'public.sms_users'::regclass
  ) THEN
    ALTER TABLE public.sms_users
      ADD CONSTRAINT sms_users_onboarding_version_check
      CHECK (onboarding_version > 0);
  END IF;
END
$$;

-- Atomic and idempotent. A racing completion/skip request can only decide an
-- account once, and a later request can read the winning terminal state. The
-- backend also checks that p_user_id is the authenticated actor before calling
-- this internal function.
CREATE OR REPLACE FUNCTION public.decide_sms_user_onboarding(
  p_user_id bigint,
  p_status text,
  p_version integer
)
RETURNS TABLE (
  onboarding_status text,
  onboarding_version integer,
  onboarding_decided_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'skipped') THEN
    RAISE EXCEPTION 'ONBOARDING_STATUS_INVALID';
  END IF;

  IF p_version IS NULL OR p_version <= 0 THEN
    RAISE EXCEPTION 'ONBOARDING_VERSION_INVALID';
  END IF;

  RETURN QUERY
  UPDATE public.sms_users AS u
  SET onboarding_status = p_status,
      onboarding_decided_at = now()
  WHERE u.id = p_user_id
    AND u.onboarding_status = 'not_started'
    AND u.onboarding_version = p_version
  RETURNING u.onboarding_status, u.onboarding_version, u.onboarding_decided_at;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Idempotent terminal response or an explicit state/version conflict. Row
  -- locking keeps the result stable if another request just won the update.
  RETURN QUERY
  SELECT u.onboarding_status, u.onboarding_version, u.onboarding_decided_at
  FROM public.sms_users AS u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ONBOARDING_USER_NOT_FOUND';
  END IF;
END;
$$;

-- This is a service-only RPC. Public execution of a SECURITY DEFINER function
-- would let a database API caller modify another person's onboarding state.
REVOKE ALL ON FUNCTION public.decide_sms_user_onboarding(bigint, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_sms_user_onboarding(bigint, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.decide_sms_user_onboarding(bigint, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decide_sms_user_onboarding(bigint, text, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
