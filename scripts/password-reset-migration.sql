-- Vici Inbox — self-service password reset. Additive schema.
--
-- SAFETY
--   * Creates one new table, its indexes, and two functions. No existing table
--     is altered and no existing row is changed. Applying this file alone
--     changes nobody's access: the endpoints that use it refuse everything
--     until the matching backend deploy exists, and until somebody actually
--     asks for a reset there is not a single row in here.
--   * RLS is enabled with deliberately no policies. The Railway backend's
--     service role bypasses RLS; every other Postgres role, including anon and
--     authenticated, sees zero rows. Reset token hashes must never be reachable
--     from a browser key, exactly as with sms_invitations.token_hash.
--   * Both functions are SECURITY DEFINER with `SET search_path = ''`, revoked
--     from PUBLIC/anon/authenticated and granted only to service_role. A
--     SECURITY DEFINER function callable by anon would bypass the RLS above.
--
-- WHY A SQL FUNCTION AND NOT NODE
--   complete_sms_password_reset does SELECT ... FOR UPDATE on the reset row and
--   then rewrites the password, bumps the session epoch, clears the lockout and
--   marks the row used, in one transaction. Two simultaneous confirmations of
--   the same token therefore produce exactly one password change; the second
--   caller blocks, re-reads the row it now holds a lock on, sees used_at set,
--   and raises RESET_USED. This is the same construction as
--   redeem_sms_invitation in scripts/rbac-migration.sql, for the same reason.
--   Do not reimplement it as read-then-write in the application.
--
-- WHAT IS STORED
--   The sha256 hex of the token and an 8-character prefix OF THAT HASH. Never
--   the raw token, and never any substring of it. A dump of this table hands
--   over neither a working reset link nor a head start on guessing one.
--
-- EXPIRY
--   60 minutes, set by the application in expires_at and CHECKED HERE against
--   now(). The email states the deadline; this is what enforces it.
--
-- ROLLBACK
--   Everything here is new and independent:
--     DROP FUNCTION IF EXISTS complete_sms_password_reset(text, text);
--     DROP FUNCTION IF EXISTS open_sms_password_reset(bigint, text, text, timestamptz, text, text);
--     DROP TABLE IF EXISTS sms_password_resets;
--   Dropping the table loses only in-flight reset links, which expire in an
--   hour anyway. No account state lives here.

BEGIN;

-- ── Reset requests ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_password_resets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               bigint NOT NULL REFERENCES sms_users (id) ON DELETE CASCADE,
  -- sha256 hex of the token. The CHECK is what stops a raw token, which is
  -- base64url and therefore contains characters this pattern forbids, from
  -- ever being written into this column by mistake.
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- A prefix of token_hash, NOT of the token. Only ever used to tell two
  -- hashes apart in a log line.
  token_prefix          text NOT NULL CHECK (token_prefix ~ '^[0-9a-f]{8}$'),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  cancelled_at          timestamptz,
  cancelled_reason      text,
  requested_ip          text,
  requested_user_agent  text,
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- A row is open, used, or cancelled. Never two of those at once.
  CONSTRAINT sms_password_resets_not_used_and_cancelled
    CHECK (NOT (used_at IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT sms_password_resets_expires_after_request
    CHECK (expires_at > requested_at)
);

-- At most one OPEN request per person. A new request supersedes the previous
-- one by cancelling it, which is what keeps this index satisfiable: an expired
-- but uncancelled row still counts as open here, so open_sms_password_reset
-- cancels by used_at/cancelled_at rather than by expiry.
CREATE UNIQUE INDEX IF NOT EXISTS sms_password_resets_one_open_per_user_idx
  ON sms_password_resets (user_id)
  WHERE used_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS sms_password_resets_open_idx
  ON sms_password_resets (expires_at)
  WHERE used_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS sms_password_resets_user_time_idx
  ON sms_password_resets (user_id, requested_at DESC);

-- ── Internal RPCs ────────────────────────────────────────────────────────────

-- Supersede any open request for this person and open a new one, atomically.
-- Two of these racing cannot both leave an open row.
--
-- The caller has already established that the account exists, is active and is
-- not the shared identity; those are re-checked here anyway, because this
-- function is the security boundary and the caller is not.
CREATE OR REPLACE FUNCTION open_sms_password_reset(
  p_user_id    bigint,
  p_token_hash text,
  p_token_prefix text,
  p_expires_at timestamptz,
  p_ip         text,
  p_user_agent text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  account   public.sms_users%ROWTYPE;
  new_id    uuid;
BEGIN
  SELECT * INTO account
  FROM public.sms_users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_NOT_FOUND';
  END IF;
  -- The shared identity's credential is INBOX_PASSWORD, held by Railway, not a
  -- row. There is nothing here to reset.
  IF account.is_legacy_shared THEN
    RAISE EXCEPTION 'RESET_NOT_ALLOWED';
  END IF;
  IF NOT account.is_active THEN
    RAISE EXCEPTION 'RESET_NOT_ALLOWED';
  END IF;

  UPDATE public.sms_password_resets
  SET cancelled_at = now(),
      cancelled_reason = 'superseded'
  WHERE user_id = p_user_id
    AND used_at IS NULL
    AND cancelled_at IS NULL;

  INSERT INTO public.sms_password_resets (
    user_id, token_hash, token_prefix, expires_at, requested_ip, requested_user_agent
  ) VALUES (
    p_user_id, p_token_hash, p_token_prefix, p_expires_at, p_ip, p_user_agent
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Spend a reset token and rewrite the password, in ONE transaction.
--
-- The SELECT ... FOR UPDATE serialises concurrent confirmations of the same
-- token: the second caller blocks, then re-reads the locked row, sees used_at
-- set and raises RESET_USED. Exactly one password change results.
--
-- Everything a reset must do beyond setting the hash happens in the same
-- statement as the hash:
--   session_epoch + 1     ends every existing session, including on a device
--                         the owner no longer holds. The backend compares the
--                         cookie's `se` against this on every request.
--   failed_login_count/locked_until cleared. A lock outranks a correct password
--                         in routes/auth.js, so without this an account locked
--                         out by an attacker could never recover.
--   must_change_password false. They chose this password themselves, seconds
--                         ago, and nobody else has ever seen it.
CREATE OR REPLACE FUNCTION complete_sms_password_reset(p_token_hash text, p_password_hash text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request public.sms_password_resets%ROWTYPE;
  account public.sms_users%ROWTYPE;
BEGIN
  SELECT * INTO request
  FROM public.sms_password_resets
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_NOT_FOUND';
  END IF;
  IF request.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESET_USED';
  END IF;
  IF request.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESET_CANCELLED';
  END IF;
  -- Server-side expiry. The 60 minutes in the email is a courtesy; this is the
  -- control.
  IF request.expires_at <= now() THEN
    RAISE EXCEPTION 'RESET_EXPIRED';
  END IF;

  SELECT * INTO account
  FROM public.sms_users
  WHERE id = request.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_NOT_FOUND';
  END IF;
  -- Re-checked at spend time, not only at request time. An account deactivated
  -- during the hour the link was live must not be reopened by it.
  IF account.is_legacy_shared THEN
    RAISE EXCEPTION 'RESET_NOT_ALLOWED';
  END IF;
  IF NOT account.is_active THEN
    RAISE EXCEPTION 'RESET_NOT_ALLOWED';
  END IF;

  UPDATE public.sms_users
  SET password_hash        = p_password_hash,
      password_set_at      = now(),
      must_change_password = false,
      failed_login_count   = 0,
      locked_until         = NULL,
      session_epoch        = session_epoch + 1
  WHERE id = account.id;

  UPDATE public.sms_password_resets
  SET used_at = now()
  WHERE id = request.id;

  -- Any other link for this person is dead the moment one of them is spent.
  UPDATE public.sms_password_resets
  SET cancelled_at = now(),
      cancelled_reason = 'superseded'
  WHERE user_id = account.id
    AND id <> request.id
    AND used_at IS NULL
    AND cancelled_at IS NULL;

  RETURN account.id;
END;
$$;

-- Functions in the public schema are executable by PUBLIC unless revoked. Both
-- of these are internal backend RPCs, not client APIs.

REVOKE ALL ON FUNCTION open_sms_password_reset(bigint, text, text, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_sms_password_reset(bigint, text, text, timestamptz, text, text) FROM anon;
REVOKE ALL ON FUNCTION open_sms_password_reset(bigint, text, text, timestamptz, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION open_sms_password_reset(bigint, text, text, timestamptz, text, text) TO service_role;

REVOKE ALL ON FUNCTION complete_sms_password_reset(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_sms_password_reset(text, text) FROM anon;
REVOKE ALL ON FUNCTION complete_sms_password_reset(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_sms_password_reset(text, text) TO service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Enabled with no policies, matching every other table in
-- scripts/rbac-migration.sql. The service role bypasses RLS; everyone else
-- sees nothing.

ALTER TABLE sms_password_resets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sms_password_resets FROM PUBLIC;
REVOKE ALL ON sms_password_resets FROM anon;
REVOKE ALL ON sms_password_resets FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON sms_password_resets TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
