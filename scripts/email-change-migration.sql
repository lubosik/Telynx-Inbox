-- Vici Inbox — confirmed self-service email changes. Additive schema.
--
-- WHY THIS TABLE EXISTS
--   `POST /api/users/me/email` must not change anything. An email address is
--   half of a credential and the whole of an account-recovery path, so a change
--   that lands the moment it is requested is an account takeover primitive: a
--   borrowed session, or a browser left open, becomes permanent ownership. The
--   address only moves once somebody has proven they can read mail AT THE NEW
--   ADDRESS, and this table is the pending state in between.
--
-- SAFETY
--   * Creates one new table, its indexes, one trigger function and one RPC.
--     No existing table is altered and no existing row is changed. Applying
--     this file alone changes nobody's email and nobody's access.
--   * The table has RLS enabled and deliberately exposes no anon or
--     authenticated policies, exactly as scripts/rbac-migration.sql does. The
--     Railway backend service role is the only application path.
--   * `confirm_sms_email_change` is SECURITY DEFINER with `SET search_path = ''`
--     and is revoked from PUBLIC/anon/authenticated. It is an internal backend
--     RPC, not a client API: an anon caller invoking it would bypass the table
--     RLS below and rewrite an address with nothing but a token.
--
-- WHAT IS STORED, AND WHAT IS NOT
--   The raw token is NEVER stored. Only its sha256 hex and an 8-character
--   prefix OF THAT HASH, which is the pattern sms_invitations already uses:
--   no substring of the live secret is written anywhere, so a database dump
--   hands over neither a working confirmation link nor a head start on
--   guessing one. `token_prefix` exists solely to tell two hashes apart in a
--   log line and is never emitted in an audit row or a response body.
--
-- ONE OPEN REQUEST PER PERSON
--   sms_email_changes_one_open_per_user_idx is a PARTIAL unique index over
--   `user_id` where the row is neither confirmed nor cancelled. Two consequences
--   worth stating plainly:
--     * A second request while one is open fails at the database, not only in
--       the application. The application supersedes the first request by
--       cancelling it before it inserts, so the normal path never sees the
--       violation; the index is there for the concurrent path that would
--       otherwise leave two live confirmation links pointing at one account.
--     * An EXPIRED request is still "open" by this definition and still blocks.
--       That is deliberate and harmless, because the supersede-then-insert in
--       routes/users.js cancels it first. Expiry is enforced by `expires_at`,
--       never by the index.
--
-- CONCURRENCY
--   Confirmation goes through confirm_sms_email_change, which takes a row lock
--   with SELECT ... FOR UPDATE and then validates, rewrites the address, bumps
--   the session epoch and stamps confirmed_at in ONE transaction. Two
--   simultaneous confirmations of the same token therefore produce exactly one
--   change; the loser sees EMAIL_CHANGE_USED. Do not reimplement this as
--   read-then-write in Node — that race is precisely what the function removes,
--   and it is the same reason redeem_sms_invitation exists.
--
-- ROLLBACK
--   Everything here is new and independent:
--     DROP FUNCTION IF EXISTS confirm_sms_email_change(text, timestamptz);
--     DROP TABLE IF EXISTS sms_email_changes;
--     DROP FUNCTION IF EXISTS touch_sms_email_changes_updated_at();
--   Nothing outside this file references any of them, and dropping them cannot
--   affect an address that has already been confirmed.

BEGIN;

-- ── The pending-change table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_email_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              bigint NOT NULL REFERENCES sms_users (id) ON DELETE CASCADE,
  -- The address being moved TO. The address being moved FROM is whatever
  -- sms_users holds when the change is confirmed, deliberately: snapshotting it
  -- here would let a stale copy overwrite a newer one.
  new_email            text NOT NULL,
  -- sha256 hex of the raw token. The raw token exists only in the confirmation
  -- email and in the request that redeems it.
  token_hash           text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- First 8 characters OF THE HASH, never of the token.
  token_prefix         text NOT NULL,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  -- Provenance for "who asked for this?" after the fact. Text rather than inet
  -- because the application already stores IPs as text in sms_auth_events and a
  -- proxied X-Forwarded-For value is not always a valid inet literal.
  requested_ip         text,
  requested_user_agent text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- A request cannot be both confirmed and cancelled. Without this, a cancel
  -- racing a confirm could leave a row that reads as either depending on which
  -- column you look at, and the audit trail would be unarguable in the wrong
  -- direction.
  CONSTRAINT sms_email_changes_not_both_outcomes
    CHECK (NOT (confirmed_at IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT sms_email_changes_expires_after_request
    CHECK (expires_at > requested_at)
);

-- At most one request per person that is neither confirmed nor cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS sms_email_changes_one_open_per_user_idx
  ON sms_email_changes (user_id)
  WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

-- The confirm path looks a row up by hash and nothing else.
CREATE INDEX IF NOT EXISTS sms_email_changes_token_hash_idx
  ON sms_email_changes (token_hash);

-- "Show me this person's history of address changes", newest first.
CREATE INDEX IF NOT EXISTS sms_email_changes_user_requested_idx
  ON sms_email_changes (user_id, requested_at DESC);

-- ── updated_at ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_sms_email_changes_updated_at()
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

DROP TRIGGER IF EXISTS sms_email_changes_touch_updated_at ON sms_email_changes;
CREATE TRIGGER sms_email_changes_touch_updated_at
  BEFORE UPDATE ON sms_email_changes
  FOR EACH ROW EXECUTE FUNCTION touch_sms_email_changes_updated_at();

-- ── Confirmation ────────────────────────────────────────────────────────────
--
-- Every refusal is a distinct RAISE so the HTTP layer can map each one to its
-- own code. The application matches on these exact strings; see
-- CONFIRMATION_ERRORS in routes/users.js.
--
-- `p_now` is a parameter rather than a call to now() so a test can drive the
-- expiry boundary without waiting. It defaults to now(), and the application
-- never passes it.

CREATE OR REPLACE FUNCTION confirm_sms_email_change(
  p_token_hash text,
  p_now        timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change     public.sms_email_changes%ROWTYPE;
  v_user       public.sms_users%ROWTYPE;
  v_previous   text;
  v_next_epoch integer;
BEGIN
  -- FOR UPDATE is the whole point of this function. Two requests carrying the
  -- same token serialise here; the second one re-reads a row whose confirmed_at
  -- is already set and falls into EMAIL_CHANGE_USED below.
  SELECT * INTO v_change
  FROM public.sms_email_changes
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_NOT_FOUND';
  END IF;
  IF v_change.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_USED';
  END IF;
  IF v_change.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_CANCELLED';
  END IF;
  IF v_change.expires_at <= p_now THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_EXPIRED';
  END IF;

  SELECT * INTO v_user
  FROM public.sms_users
  WHERE id = v_change.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_USER_NOT_FOUND';
  END IF;
  -- Defence in depth. routes/users.js refuses to open a request for the shared
  -- identity in the first place, and syncLegacySharedRole() exits the process
  -- at boot if that row is missing, so its address must not be rewritable by
  -- anything holding a token.
  IF v_user.is_legacy_shared THEN
    RAISE EXCEPTION 'LEGACY_USER_IMMUTABLE';
  END IF;
  -- A person deactivated while their confirmation was in flight does not get to
  -- complete it. Reactivation is an administrative decision, and letting a
  -- removed account quietly move its address first would hand it a recovery
  -- path nobody approved.
  IF NOT v_user.is_active THEN
    RAISE EXCEPTION 'EMAIL_CHANGE_USER_INACTIVE';
  END IF;

  -- Checked inside the lock, not only at request time: an address that was free
  -- when the link was mailed can be taken before the link is clicked. The unique
  -- index on lower(email) would raise a constraint violation anyway; this turns
  -- it into a named error the HTTP layer can explain.
  IF EXISTS (
    SELECT 1 FROM public.sms_users
    WHERE lower(email) = lower(v_change.new_email)
      AND id <> v_change.user_id
  ) THEN
    RAISE EXCEPTION 'EMAIL_ALREADY_EXISTS';
  END IF;

  v_previous := v_user.email;

  -- The address and the session epoch move together. The epoch bump is not
  -- housekeeping: the address is part of who this account is, so every other
  -- live session must re-establish rather than keep running against an identity
  -- that has changed underneath it.
  UPDATE public.sms_users
  SET email         = v_change.new_email,
      session_epoch = session_epoch + 1
  WHERE id = v_change.user_id
  RETURNING session_epoch INTO v_next_epoch;

  UPDATE public.sms_email_changes
  SET confirmed_at = p_now
  WHERE id = v_change.id;

  RETURN jsonb_build_object(
    'change_id',      v_change.id,
    'user_id',        v_change.user_id,
    'previous_email', v_previous,
    'new_email',      v_change.new_email,
    'session_epoch',  v_next_epoch,
    'confirmed_at',   p_now
  );
END;
$$;

-- Functions in the public schema are executable by PUBLIC unless revoked, and
-- this one is SECURITY DEFINER: an anon caller reaching it would rewrite an
-- account's address while bypassing the RLS below.
REVOKE ALL ON FUNCTION confirm_sms_email_change(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_sms_email_change(text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION confirm_sms_email_change(text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION confirm_sms_email_change(text, timestamptz) TO service_role;

-- Trigger-only; direct execution is unnecessary.
REVOKE ALL ON FUNCTION touch_sms_email_changes_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_sms_email_changes_updated_at() FROM anon;
REVOKE ALL ON FUNCTION touch_sms_email_changes_updated_at() FROM authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Enabled with no policies: the service role used by the Railway backend
-- bypasses RLS, and every other Postgres role sees zero rows. A token hash must
-- never be reachable from a browser key.

ALTER TABLE sms_email_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sms_email_changes FROM PUBLIC;
REVOKE ALL ON sms_email_changes FROM anon;
REVOKE ALL ON sms_email_changes FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON sms_email_changes TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
