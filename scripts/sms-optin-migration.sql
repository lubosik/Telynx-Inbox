-- Vici Inbox — emailed promotional SMS opt-in invitations. Additive schema.
--
-- WHAT THIS IS FOR
--   There are 926 SMS-reachable contacts in this workspace and zero rows of
--   promotional SMS consent, so the campaign engine correctly suppresses all of
--   them. The privacy policy those customers accepted grants marketing EMAIL
--   permission and is silent on text messages. This table is the paperwork for
--   the only lawful bridge between the two: use the email permission that
--   exists to ASK, and record the click as documented consent.
--
--   Nothing in this file creates consent. It stores questions. The answers live
--   in sms_consent_events, written by lib/campaigns/consent.js, and every one of
--   them points back here through
--   evidence_ref = 'sms_optin_invite:<this table''s id>'.
--
-- SAFETY
--   * Creates one new table, its indexes, and two functions. No table other than
--     this one is altered and no row outside it is changed. Applying this file
--     alone changes nobody's consent state and sends nothing: until a mailing is
--     actually run there is not a single row in here, and an invitation that is
--     never answered leaves the contact exactly as suppressed as they are today.
--   * Re-runnable. Every object is IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--     CREATE OR REPLACE or a guarded DO block, and the whole file is one
--     transaction, so a partial apply cannot happen. The one UPDATE it contains
--     touches only rows of this table whose first_responded_at is still NULL,
--     which on a first apply is no rows at all.
--   * RLS is enabled with deliberately no policies. The Railway backend's
--     service role bypasses RLS; every other Postgres role, including anon and
--     authenticated, sees zero rows. This table holds phone numbers, email
--     addresses and live token hashes, and must never be reachable from a
--     browser key — the same rule as sms_invitations.token_hash and
--     sms_password_resets.token_hash.
--   * Both functions are SECURITY DEFINER with `SET search_path = ''`, revoked
--     from PUBLIC/anon/authenticated and granted only to service_role. A
--     SECURITY DEFINER function callable by anon would bypass the RLS above and
--     would, in this specific case, hand an anonymous caller the ability to mint
--     or spend consent invitations.
--
-- WHY A SQL FUNCTION AND NOT NODE
--   claim_sms_optin_invitation does SELECT ... FOR UPDATE on the invitation row
--   and then performs the unanswered -> answered transition in one transaction.
--   Two simultaneous clicks of one link therefore produce exactly one
--   transition; the loser blocks, re-reads the row it now holds a lock on, sees
--   responded_at set, and is told the answer is already recorded. This is the
--   same construction as complete_sms_password_reset in
--   scripts/password-reset-migration.sql and redeem_sms_invitation in
--   scripts/rbac-migration.sql, for the same reason. Do not reimplement it as
--   read-then-write in the application.
--
--   The application ALSO writes each consent event under a unique dedupe_key
--   ('sms_optin_invite:<id>:opt_in'), which sms_consent_events_dedupe_idx
--   enforces. Two independent guarantees, because a single one that quietly
--   stops working is how a duplicate-consent bug survives a year.
--
-- WHAT IS STORED
--   The sha256 hex of the token and an 8-character prefix OF THAT HASH. Never
--   the raw token, and never any substring of it. A dump of this table hands
--   over neither a working opt-in link nor a head start on guessing one — which
--   matters more here than for a password reset, because a forged link would
--   manufacture consent that LOOKS legitimate in the ledger.
--
--   contact_email is stored on purpose. "Which email produced this consent?" is
--   the first question anybody will ask, and an evidence trail that cannot
--   answer it is not evidence.
--
-- EXPIRY
--   30 days, set by the application in expires_at and CHECKED HERE against
--   now(). Long, because nobody is inconvenienced while it sits unread.
--
-- AN ANSWER IS NEVER OVERWRITTEN OUT OF EXISTENCE
--   A person may confirm and then decline. That transition used to overwrite
--   response, responded_at, responded_ip and responded_user_agent IN PLACE, and
--   the consequence was not cosmetic: the opt_in event already written to
--   sms_consent_events carries
--   evidence_ref = 'sms_optin_invite:<id>', and an auditor resolving that
--   reference landed on a row that said response = 'opt_out', dated later, with
--   the DECLINING device's IP and user agent. The evidence contradicted the
--   record it was evidence for.
--
--   So the first answer is kept in its own columns that no transition ever
--   touches. first_response / first_responded_at / first_responded_ip /
--   first_responded_user_agent are written exactly once, by whichever claim
--   performs the first transition, and are thereafter immutable. response and
--   responded_at continue to mean "the answer that stands today", which is what
--   the gate below reads.
--
--   Two columns rather than a child table because the state machine admits at
--   most two distinct answers: unanswered -> opt_in -> opt_out, and the gate
--   refuses opt_out -> opt_in. The pair therefore records the complete history,
--   not a sample of it. If a future change ever allows a third transition, this
--   becomes a child table on the same day.
--
--   RESOLVING AN evidence_ref, in one sentence: read first_response when the
--   ledger event you are checking is the first one for that invitation, and
--   response when it is the current one. The consent event's own metadata also
--   carries the ip, user_agent and confirmed_at captured at ITS click, so a
--   single ledger row is defensible without this table at all.
--
-- OPT-OUT IS NOT SYMMETRICAL WITH OPT-IN, ON PURPOSE
--   claim_sms_optin_invitation accepts 'opt_out' from an EXPIRED and from a
--   SUPERSEDED invitation, and accepts a change of mind from opt_in to opt_out.
--   It refuses 'opt_in' in all of those cases. Refusing to record somebody's
--   "no" for want of paperwork would be indefensible; accepting a "yes" from a
--   dead link, or flipping a recorded "no" into a "yes" because the same
--   emailed button was pressed a second time, would be worse than indefensible.
--
-- ROLLBACK
--   Everything here is new and independent:
--     DROP FUNCTION IF EXISTS claim_sms_optin_invitation(text, text, text, text);
--     DROP FUNCTION IF EXISTS open_sms_optin_invitation(text, text, text, text, text, timestamptz, text, bigint);
--     DROP TABLE IF EXISTS sms_optin_invitations;
--   The append-only first_* columns go with the table; there is no separate
--   object to drop for them.
--   Dropping the table loses in-flight invitation links and the evidence trail
--   behind any consent already collected through them. The consent events
--   themselves survive in sms_consent_events, but their evidence_ref would then
--   point at nothing, so prefer leaving the table in place over dropping it once
--   a single invitation has been answered.

BEGIN;

-- ── Invitations ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_optin_invitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          text NOT NULL DEFAULT 'vici',
  -- Whose consent is being asked for. The browser never supplies this; it comes
  -- back out of claim_sms_optin_invitation, so no caller can nominate a number.
  contact_phone         text NOT NULL,
  -- The address the invitation was mailed to. Evidence, not contact data.
  contact_email         text,
  -- Identifies the mailing this invitation belonged to, e.g.
  -- 'sms_optin_invite_2026_08'. Present so a whole batch can be traced, paused
  -- or explained as one thing.
  campaign_ref          text NOT NULL,
  -- sha256 hex of the token. The CHECK is what stops a raw token, which is
  -- base64url and therefore contains characters this pattern forbids, from ever
  -- being written into this column by mistake.
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- A prefix of token_hash, NOT of the token. Only ever used to tell two hashes
  -- apart in a log line.
  token_prefix          text NOT NULL CHECK (token_prefix ~ '^[0-9a-f]{8}$'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  created_by            bigint REFERENCES sms_users (id),
  -- THE ANSWER THAT STANDS TODAY. Overwritten by a change of mind.
  responded_at          timestamptz,
  response              text CHECK (response IN ('opt_in', 'opt_out')),
  responded_ip          text,
  responded_user_agent  text,
  -- THE FIRST ANSWER EVER GIVEN. Written once and never touched again, so that
  -- an opt_in consent event's evidence_ref cannot resolve to a row that
  -- contradicts it. See the header.
  first_responded_at         timestamptz,
  first_response             text CHECK (first_response IN ('opt_in', 'opt_out')),
  first_responded_ip         text,
  first_responded_user_agent text,
  cancelled_at          timestamptz,
  cancelled_reason      text,
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  CONSTRAINT sms_optin_invitations_phone_e164
    CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT sms_optin_invitations_campaign_ref_present
    CHECK (char_length(trim(campaign_ref)) > 0),
  -- A response and its timestamp exist together or not at all. Half a row here
  -- would be an answer nobody can date.
  CONSTRAINT sms_optin_invitations_response_paired
    CHECK ((responded_at IS NULL) = (response IS NULL)),
  CONSTRAINT sms_optin_invitations_first_response_paired
    CHECK ((first_responded_at IS NULL) = (first_response IS NULL)),
  -- A first answer cannot exist without a current one, and cannot post-date it.
  CONSTRAINT sms_optin_invitations_first_response_ordered
    CHECK (first_responded_at IS NULL
           OR (responded_at IS NOT NULL AND first_responded_at <= responded_at)),
  CONSTRAINT sms_optin_invitations_expires_after_creation
    CHECK (expires_at > created_at)
);

-- RE-RUN PATH. CREATE TABLE IF NOT EXISTS adds no columns to a table that is
-- already there, so the append-only answer columns are also added explicitly.
-- On a first apply every one of these is a no-op.
ALTER TABLE sms_optin_invitations
  ADD COLUMN IF NOT EXISTS first_responded_at         timestamptz,
  ADD COLUMN IF NOT EXISTS first_response             text,
  ADD COLUMN IF NOT EXISTS first_responded_ip         text,
  ADD COLUMN IF NOT EXISTS first_responded_user_agent text;

-- Any row answered before these columns existed keeps the only answer it has as
-- its first answer. That is the truth for such a row: nothing overwrote it,
-- because there was nothing to overwrite it with.
UPDATE sms_optin_invitations
SET first_response = response,
    first_responded_at = responded_at,
    first_responded_ip = responded_ip,
    first_responded_user_agent = responded_user_agent
WHERE responded_at IS NOT NULL
  AND first_responded_at IS NULL;

-- ADD CONSTRAINT has no IF NOT EXISTS, so the re-run path guards each one the
-- same way scripts/campaigns-migration.sql does.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_optin_invitations'::regclass
      AND conname = 'sms_optin_invitations_first_response_paired'
  ) THEN
    ALTER TABLE public.sms_optin_invitations
      ADD CONSTRAINT sms_optin_invitations_first_response_paired
      CHECK ((first_responded_at IS NULL) = (first_response IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_optin_invitations'::regclass
      AND conname = 'sms_optin_invitations_first_response_ordered'
  ) THEN
    ALTER TABLE public.sms_optin_invitations
      ADD CONSTRAINT sms_optin_invitations_first_response_ordered
      CHECK (first_responded_at IS NULL
             OR (responded_at IS NOT NULL AND first_responded_at <= responded_at));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_optin_invitations'::regclass
      AND conname = 'sms_optin_invitations_first_response_values'
  ) THEN
    ALTER TABLE public.sms_optin_invitations
      ADD CONSTRAINT sms_optin_invitations_first_response_values
      CHECK (first_response IS NULL OR first_response IN ('opt_in', 'opt_out'));
  END IF;
END;
$$;

-- At most one UNANSWERED, uncancelled invitation per number per workspace. A
-- new mailing supersedes the previous invitation by cancelling it, which is
-- what keeps this index satisfiable. An expired but uncancelled row still
-- counts as open here, so open_sms_optin_invitation cancels by
-- responded_at/cancelled_at rather than by expiry.
--
-- Answered rows are deliberately outside the index: they are the evidence trail
-- and must accumulate, not be replaced.
CREATE UNIQUE INDEX IF NOT EXISTS sms_optin_invitations_one_open_per_phone_idx
  ON sms_optin_invitations (workspace_id, contact_phone)
  WHERE responded_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS sms_optin_invitations_open_idx
  ON sms_optin_invitations (expires_at)
  WHERE responded_at IS NULL AND cancelled_at IS NULL;

-- "How did this mailing do?" without scanning the table.
CREATE INDEX IF NOT EXISTS sms_optin_invitations_campaign_idx
  ON sms_optin_invitations (workspace_id, campaign_ref, created_at DESC);

-- "Show me every invitation ever sent to this number", which is the query an
-- audit of one person's consent actually runs.
CREATE INDEX IF NOT EXISTS sms_optin_invitations_phone_time_idx
  ON sms_optin_invitations (workspace_id, contact_phone, created_at DESC);

-- ── Internal RPCs ────────────────────────────────────────────────────────────

-- Supersede any unanswered invitation for this number and open a new one,
-- atomically. Two of these racing cannot both leave an open row.
CREATE OR REPLACE FUNCTION open_sms_optin_invitation(
  p_workspace_id  text,
  p_contact_phone text,
  p_contact_email text,
  p_token_hash    text,
  p_token_prefix  text,
  p_expires_at    timestamptz,
  p_campaign_ref  text,
  p_created_by    bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace text := coalesce(nullif(trim(p_workspace_id), ''), 'vici');
  new_id      uuid;
BEGIN
  IF p_contact_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'OPTIN_INVALID_PHONE';
  END IF;
  IF coalesce(char_length(trim(p_campaign_ref)), 0) = 0 THEN
    RAISE EXCEPTION 'OPTIN_CAMPAIGN_REF_REQUIRED';
  END IF;

  -- An unanswered invitation is a question that has been overtaken. Cancelling
  -- it means only the newest link works, exactly as with a password reset, so a
  -- forwarded older email cannot be used to answer for somebody.
  --
  -- ANSWERED invitations are untouched. Superseding evidence would be
  -- destroying it.
  UPDATE public.sms_optin_invitations
  SET cancelled_at = now(),
      cancelled_reason = 'superseded',
      updated_at = now()
  WHERE workspace_id = v_workspace
    AND contact_phone = p_contact_phone
    AND responded_at IS NULL
    AND cancelled_at IS NULL;

  INSERT INTO public.sms_optin_invitations (
    workspace_id, contact_phone, contact_email, campaign_ref,
    token_hash, token_prefix, expires_at, created_by
  ) VALUES (
    v_workspace, p_contact_phone, nullif(trim(coalesce(p_contact_email, '')), ''),
    trim(p_campaign_ref), p_token_hash, p_token_prefix, p_expires_at, p_created_by
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Spend an invitation token, in ONE transaction.
--
-- The SELECT ... FOR UPDATE serialises concurrent clicks of the same link: the
-- second caller blocks, then re-reads the locked row, sees responded_at set and
-- returns newly_recorded = false. Exactly one state transition results.
--
-- Returns jsonb rather than a scalar because the caller needs four facts at
-- once, and the most important of them is contact_phone: the browser submits a
-- token and nothing else, so the number whose consent is about to be recorded
-- is decided here and never by the client.
--
-- The RAISE messages are the contract confirmErrorFrom() in
-- lib/campaigns/sms-optin-invite.js parses. Changing one is an API change.
CREATE OR REPLACE FUNCTION claim_sms_optin_invitation(
  p_token_hash text,
  p_response   text,
  p_ip         text,
  p_user_agent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invite          public.sms_optin_invitations%ROWTYPE;
  v_newly         boolean := false;
  v_is_opt_out    boolean := (p_response = 'opt_out');
BEGIN
  IF p_response IS NULL OR p_response NOT IN ('opt_in', 'opt_out') THEN
    RAISE EXCEPTION 'OPTIN_NOT_VALID';
  END IF;

  SELECT * INTO invite
  FROM public.sms_optin_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  -- Unknown token. ONE generic answer, shared with a superseded link below, so
  -- that probing this endpoint cannot distinguish "never existed" from
  -- "existed once" and therefore cannot be used to confirm that a number is on
  -- the list.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OPTIN_NOT_VALID';
  END IF;

  -- Everything from here to the transition is skipped for an opt_out. A
  -- withdrawal is accepted from an expired link, from a superseded link, and
  -- from somebody who previously said yes. See the header.
  IF NOT v_is_opt_out THEN
    IF invite.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'OPTIN_NOT_VALID';
    END IF;
    -- Server-side expiry. The 30 days in the email is a courtesy; this is the
    -- control.
    IF invite.expires_at <= now() THEN
      RAISE EXCEPTION 'OPTIN_EXPIRED';
    END IF;
    -- A recorded "no" is not reversible by pressing the other button in the
    -- same email. Anyone holding a forwarded copy could do that.
    IF invite.responded_at IS NOT NULL AND invite.response = 'opt_out' THEN
      RAISE EXCEPTION 'OPTIN_ALREADY_DECLINED';
    END IF;
  END IF;

  IF invite.responded_at IS NULL OR invite.response IS DISTINCT FROM p_response THEN
    -- response/responded_* are the answer that stands. first_* are written by
    -- whichever transition happens first and are never written again, so a
    -- confirm-then-decline leaves BOTH answers on the row instead of destroying
    -- the one an already-written opt_in event points at. The guard is
    -- `first_responded_at IS NULL` rather than `responded_at IS NULL` so that a
    -- row backfilled by the re-run path above is equally immutable.
    UPDATE public.sms_optin_invitations
    SET response = p_response,
        responded_at = now(),
        responded_ip = nullif(left(coalesce(p_ip, ''), 100), ''),
        responded_user_agent = nullif(left(coalesce(p_user_agent, ''), 400), ''),
        first_response = coalesce(invite.first_response, p_response),
        first_responded_at = coalesce(invite.first_responded_at, now()),
        first_responded_ip = CASE
          WHEN invite.first_responded_at IS NULL
            THEN nullif(left(coalesce(p_ip, ''), 100), '')
          ELSE invite.first_responded_ip
        END,
        first_responded_user_agent = CASE
          WHEN invite.first_responded_at IS NULL
            THEN nullif(left(coalesce(p_user_agent, ''), 400), '')
          ELSE invite.first_responded_user_agent
        END,
        updated_at = now()
    WHERE id = invite.id;
    v_newly := true;
  ELSE
    -- The same answer, twice. Nothing changes and no error is raised: the
    -- application re-writes the consent event under its dedupe key anyway, so a
    -- repeat click repairs a ledger write lost between the two steps instead of
    -- inheriting the gap.
    UPDATE public.sms_optin_invitations
    SET attempt_count = invite.attempt_count + 1,
        updated_at = now()
    WHERE id = invite.id;
    v_newly := false;
  END IF;

  RETURN jsonb_build_object(
    'invitation_id', invite.id,
    'workspace_id', invite.workspace_id,
    'contact_phone', invite.contact_phone,
    'campaign_ref', invite.campaign_ref,
    'response', p_response,
    -- The answer this invitation carried BEFORE this call, so a caller can tell
    -- a first answer from a change of mind without a second round trip.
    'previous_response', invite.response,
    'first_response', coalesce(invite.first_response, p_response),
    'newly_recorded', v_newly
  );
END;
$$;

-- Functions in the public schema are executable by PUBLIC unless revoked. Both
-- of these are internal backend RPCs, not client APIs, and the second one
-- WRITES CONSENT-BEARING STATE.

REVOKE ALL ON FUNCTION open_sms_optin_invitation(text, text, text, text, text, timestamptz, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_sms_optin_invitation(text, text, text, text, text, timestamptz, text, bigint) FROM anon;
REVOKE ALL ON FUNCTION open_sms_optin_invitation(text, text, text, text, text, timestamptz, text, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION open_sms_optin_invitation(text, text, text, text, text, timestamptz, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION claim_sms_optin_invitation(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_sms_optin_invitation(text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION claim_sms_optin_invitation(text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_sms_optin_invitation(text, text, text, text) TO service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Enabled with no policies, matching sms_password_resets and every table in
-- scripts/rbac-migration.sql. The service role bypasses RLS; everyone else sees
-- nothing.

ALTER TABLE sms_optin_invitations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sms_optin_invitations FROM PUBLIC;
REVOKE ALL ON sms_optin_invitations FROM anon;
REVOKE ALL ON sms_optin_invitations FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON sms_optin_invitations TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
