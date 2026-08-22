-- Vici Inbox — multi-user accounts, roles, and permissions. Additive schema.
--
-- SAFETY
--   * Creates new tables/indexes/functions/views only. No existing table is
--     altered and no existing row is changed.
--   * Every human seeded here gets password_hash NULL, which means "this person
--     exists but cannot log in yet". Applying this file alone therefore changes
--     nothing about who can reach the inbox.
--   * All new tables have RLS enabled and deliberately expose no anon or
--     authenticated policies. The Railway backend service role is the only
--     application path, exactly as scripts/analytics-migration.sql does.
--   * SECURITY DEFINER functions are internal backend RPCs. They are revoked
--     from PUBLIC/anon/authenticated and granted only to service_role.
--
-- ROLLOUT NOTE — READ BEFORE CHANGING THE SEEDS
--   Two people currently share one password (INBOX_PASSWORD) on an iOS build
--   that cannot be updated without a multi-day TestFlight round trip. The
--   `legacy` role below is therefore seeded with EXACTLY the same permission
--   grants as `admin`, and the shared session resolves to the single
--   is_legacy_shared user. Day one after this migration plus the matching
--   deploy, both of them see precisely what they see today. Tightening the
--   shared login later is an environment-variable flip
--   (LEGACY_SHARED_ROLE / LEGACY_SHARED_LOGIN), not a migration.
--
-- ROLLBACK
--   Everything here is new and independent. To reverse: DROP the sms_users,
--   sms_roles, sms_permissions, sms_role_permissions,
--   sms_user_permission_grants, sms_invitations and sms_auth_events tables,
--   the sms_effective_permissions view, and the two functions.

BEGIN;

-- ── Roles ────────────────────────────────────────────────────────────────────
-- `rank` orders privilege for comparison only; it never grants anything by
-- itself. Authority always comes from sms_role_permissions.

CREATE TABLE IF NOT EXISTS sms_roles (
  key           text PRIMARY KEY,
  display_name  text NOT NULL,
  rank          integer NOT NULL,
  is_assignable boolean NOT NULL DEFAULT true,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sms_roles (key, display_name, rank, is_assignable, description) VALUES
  ('owner',  'Owner',                  300, true,
   'Full control, including granting and revoking Owner.'),
  ('admin',  'Admin',                  200, true,
   'Everything except granting or revoking Owner.'),
  ('agent',  'Support Agent',          100, true,
   'Day-to-day inbox work: conversations, messages, contacts, calls.'),
  ('legacy', 'Team (shared password)',  90, false,
   'The single pre-existing shared-password identity. Not assignable to a named person.')
ON CONFLICT (key) DO NOTHING;

-- ── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                text NOT NULL,
  display_name         text NOT NULL,
  phone                text,
  role                 text NOT NULL REFERENCES sms_roles (key),
  is_active            boolean NOT NULL DEFAULT true,
  is_legacy_shared     boolean NOT NULL DEFAULT false,
  password_hash        text,
  password_set_at      timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  session_epoch        integer NOT NULL DEFAULT 1 CHECK (session_epoch > 0),
  failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  last_seen_at         timestamptz,
  deactivated_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- The shared identity is a session target, never a credential holder. Its
  -- password lives in INBOX_PASSWORD and is verified by the application.
  CONSTRAINT sms_users_legacy_has_no_password
    CHECK (NOT (is_legacy_shared AND password_hash IS NOT NULL)),
  -- One source of truth for "disabled". Nothing may set one without the other.
  CONSTRAINT sms_users_active_matches_deactivated_at
    CHECK (is_active = (deactivated_at IS NULL))
);

-- Email identity is case-insensitive; the stored value keeps the typed casing.
CREATE UNIQUE INDEX IF NOT EXISTS sms_users_lower_email_idx
  ON sms_users (lower(email));

-- Exactly one shared-password identity may ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS sms_users_single_legacy_idx
  ON sms_users (is_legacy_shared)
  WHERE is_legacy_shared = true;

CREATE INDEX IF NOT EXISTS sms_users_active_role_idx
  ON sms_users (role)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION touch_sms_users_updated_at()
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

DROP TRIGGER IF EXISTS sms_users_touch_updated_at ON sms_users;
CREATE TRIGGER sms_users_touch_updated_at
BEFORE UPDATE ON sms_users
FOR EACH ROW EXECUTE FUNCTION touch_sms_users_updated_at();

-- ── Permission catalogue ─────────────────────────────────────────────────────
-- These keys are the contract with lib/route-policy.js. The backend validates
-- every policy key against this table at boot, so a typo fails startup rather
-- than silently granting nothing.

CREATE TABLE IF NOT EXISTS sms_permissions (
  key            text PRIMARY KEY,
  resource       text NOT NULL,
  action         text NOT NULL,
  description    text,
  is_destructive boolean NOT NULL DEFAULT false
);

INSERT INTO sms_permissions (key, resource, action, description, is_destructive) VALUES
  ('conversation.read',       'conversation',  'read',    'Read the shared inbox and conversation threads.', false),
  ('message.send',            'message',       'send',    'Send SMS/MMS, upload media, and send tapback reactions.', false),
  ('contact.read',            'contact',       'read',    'Read contact records and order context.', false),
  ('contact.write',           'contact',       'write',   'Create and edit contact records.', false),
  ('realtime.subscribe',      'realtime',      'subscribe','Open the server-sent events stream.', false),
  ('automation.read',         'automation',    'read',    'View automation stats, queue, and recent activity.', false),
  ('automation.cancel',       'automation',    'cancel',  'Cancel a queued automated message before it sends.', true),
  ('call.read',               'call',          'read',    'View call history and missed-call state.', false),
  ('call.log',                'call',          'log',     'Write a call log entry from a client.', false),
  ('voice.token',             'voice',         'token',   'Fetch native iOS SIP credentials.', false),
  ('call.recording.play',     'call.recording','play',    'Play an archived call recording.', false),
  ('call.recording.control',  'call.recording','control', 'Start or stop recording on a live call.', false),
  ('analytics.read',          'analytics',     'read',    'View revenue analytics and attribution drill-downs.', false),
  ('intelligence.read',       'intelligence',  'read',    'Read and request per-contact conversation intelligence.', false),
  ('intelligence.manage',     'intelligence',  'manage',  'View and dismiss intelligence campaign suggestions.', false),
  ('intelligence.send',       'intelligence',  'send',    'Send an intelligence campaign to customers.', true),
  ('sync.read',               'sync',          'read',    'Read integration sync status.', false),
  ('sync.run',                'sync',          'run',     'Trigger a GHL/WooCommerce/status sync.', false),
  ('sync.import',             'sync',          'import',  'Bulk-import or seed contact data.', true),
  ('catchup.preview',         'catchup',       'preview', 'Preview the unanswered-conversation catch-up batch.', false),
  ('catchup.send',            'catchup',       'send',    'Send the catch-up batch to customers.', true),
  ('device.register',         'device',        'register','Register or unregister this device for notifications.', false),
  ('device.read',             'device',        'read',    'View push/APNs configuration and registered devices.', false),
  ('device.test',             'device',        'test',    'Send a test push notification.', false),
  ('user.read',               'user',          'read',    'List team members and outstanding invitations.', false),
  ('user.manage',             'user',          'manage',  'Invite, edit, deactivate, and reset passwords for users.', true),
  ('user.manage.owner',       'user',          'manage.owner','Grant or revoke the Owner role.', true),
  ('admin.backfill',          'admin',         'backfill','Run historical backfill jobs against provider APIs.', true),
  ('audit.read',              'audit',         'read',    'Read the authentication and authorisation audit trail.', false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sms_role_permissions (
  role_key       text NOT NULL REFERENCES sms_roles (key) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES sms_permissions (key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

-- owner: everything.
INSERT INTO sms_role_permissions (role_key, permission_key)
SELECT 'owner', key FROM sms_permissions
ON CONFLICT DO NOTHING;

-- admin: everything except granting/revoking Owner.
INSERT INTO sms_role_permissions (role_key, permission_key)
SELECT 'admin', key FROM sms_permissions WHERE key <> 'user.manage.owner'
ON CONFLICT DO NOTHING;

-- legacy: identical to admin, on purpose. See the ROLLOUT NOTE at the top.
INSERT INTO sms_role_permissions (role_key, permission_key)
SELECT 'legacy', key FROM sms_permissions WHERE key <> 'user.manage.owner'
ON CONFLICT DO NOTHING;

-- agent (Support Agent): day-to-day inbox work and nothing else. In
-- particular: no automation.cancel, no analytics.read, no catchup.*, no
-- sync.run/sync.import, no user.*, no admin.backfill, no audit.read.
INSERT INTO sms_role_permissions (role_key, permission_key)
SELECT 'agent', key FROM sms_permissions WHERE key IN (
  'conversation.read',
  'message.send',
  'contact.read',
  'contact.write',
  'realtime.subscribe',
  'automation.read',
  'call.read',
  'call.log',
  'voice.token',
  'call.recording.play',
  'call.recording.control',
  'intelligence.read',
  'sync.read',
  'device.register'
)
ON CONFLICT DO NOTHING;

-- ── Per-user overrides ───────────────────────────────────────────────────────
-- A deny always beats an allow. An allow with a past expires_at is inert. A
-- deny is deliberately NOT expiry-checked: a deny is a safety brake, and a
-- brake that releases itself on a timer is the wrong failure direction. To
-- lift a deny, delete the row.

CREATE TABLE IF NOT EXISTS sms_user_permission_grants (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES sms_users (id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES sms_permissions (key) ON DELETE CASCADE,
  effect         text NOT NULL CHECK (effect IN ('allow', 'deny')),
  reason         text,
  granted_by     bigint REFERENCES sms_users (id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  UNIQUE (user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS sms_user_permission_grants_user_idx
  ON sms_user_permission_grants (user_id);

CREATE OR REPLACE VIEW sms_effective_permissions
WITH (security_invoker = true) AS
WITH role_grants AS (
  SELECT u.id AS user_id, rp.permission_key
  FROM sms_users u
  JOIN sms_role_permissions rp ON rp.role_key = u.role
),
allow_grants AS (
  SELECT g.user_id, g.permission_key
  FROM sms_user_permission_grants g
  WHERE g.effect = 'allow'
    AND (g.expires_at IS NULL OR g.expires_at > now())
),
denies AS (
  SELECT g.user_id, g.permission_key
  FROM sms_user_permission_grants g
  WHERE g.effect = 'deny'
),
combined AS (
  SELECT user_id, permission_key FROM role_grants
  UNION
  SELECT user_id, permission_key FROM allow_grants
)
SELECT c.user_id, c.permission_key
FROM combined c
WHERE NOT EXISTS (
  SELECT 1 FROM denies d
  WHERE d.user_id = c.user_id AND d.permission_key = c.permission_key
);

-- ── Invitations ──────────────────────────────────────────────────────────────
-- Only the sha256 hex of the token is stored. The raw token is shown to the
-- inviting Admin exactly once, in the creation response, and is unrecoverable
-- afterwards.

CREATE TABLE IF NOT EXISTS sms_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  display_name     text NOT NULL,
  phone            text,
  role_key         text NOT NULL REFERENCES sms_roles (key),
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix     text NOT NULL,
  invited_by       bigint REFERENCES sms_users (id),
  invited_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id bigint REFERENCES sms_users (id),
  revoked_at       timestamptz,
  revoked_by       bigint REFERENCES sms_users (id),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);

-- At most one OPEN invitation per email address. Accepted and revoked
-- invitations stay as history and do not block a re-invite.
CREATE UNIQUE INDEX IF NOT EXISTS sms_invitations_one_open_per_email_idx
  ON sms_invitations (lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sms_invitations_open_idx
  ON sms_invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── Authentication audit trail ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_auth_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  user_id         bigint REFERENCES sms_users (id) ON DELETE SET NULL,
  email_attempted text,
  method          text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('success', 'failure')),
  code            text,
  ip              text,
  user_agent      text,
  client          text
);

CREATE INDEX IF NOT EXISTS sms_auth_events_time_idx
  ON sms_auth_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS sms_auth_events_user_time_idx
  ON sms_auth_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sms_auth_events_failure_idx
  ON sms_auth_events (occurred_at DESC)
  WHERE outcome = 'failure';

-- ── Seeds ────────────────────────────────────────────────────────────────────
-- Every human below is seeded with password_hash NULL: the account exists, is
-- listed in the team UI, and CANNOT log in. Give someone a password with
-- `node scripts/set-password.js` or by inviting them. This is what makes
-- applying this migration a no-op for live access.

-- The single shared-password identity. Pre-existing cookies that carry no user
-- id resolve to this row, which is what stops the deploy logging anybody out.
INSERT INTO sms_users (email, display_name, role, is_legacy_shared, password_hash)
VALUES ('legacy@vici.local', 'Team', 'legacy', true, NULL)
ON CONFLICT DO NOTHING;

INSERT INTO sms_users (email, display_name, role, password_hash)
VALUES ('lubosikongwa1@gmail.com', 'Lubosi', 'owner', NULL)
ON CONFLICT DO NOTHING;

-- Dominic's TestFlight address. If he should sign in with a different one,
-- change it here before running, or afterwards with:
--   UPDATE sms_users SET email = 'other@example.com'
--   WHERE email = 'dompandolfo9@gmail.com';
INSERT INTO sms_users (email, display_name, role, password_hash)
VALUES ('dompandolfo9@gmail.com', 'Dominic', 'admin', NULL)
ON CONFLICT DO NOTHING;

-- ── Internal RPCs ────────────────────────────────────────────────────────────

-- Redeem an invitation and create its user in ONE statement-level transaction.
-- The SELECT ... FOR UPDATE serialises concurrent redemptions of the same
-- token: the second caller blocks, then sees accepted_at set and raises
-- INVITATION_USED. That single-statement atomicity is what makes concurrent
-- redemption safe; do not reimplement this as read-then-write in Node.
CREATE OR REPLACE FUNCTION redeem_sms_invitation(p_token_hash text, p_password_hash text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invitation  public.sms_invitations%ROWTYPE;
  new_user_id bigint;
BEGIN
  SELECT * INTO invitation
  FROM public.sms_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND';
  END IF;
  IF invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITATION_REVOKED';
  END IF;
  IF invitation.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITATION_USED';
  END IF;
  IF invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED';
  END IF;

  INSERT INTO public.sms_users (
    email, display_name, phone, role,
    password_hash, password_set_at, must_change_password
  ) VALUES (
    invitation.email, invitation.display_name, invitation.phone, invitation.role_key,
    -- must_change_password = false: the invitee chose this password themselves
    -- on the accept-invite page, seconds ago. Nobody else has ever seen it, so
    -- forcing an immediate second change protects nothing. The admin-set paths
    -- (POST /api/users, /reset-password) set the flag in application code and
    -- are unaffected. See scripts/invitation-password-fix-migration.sql.
    p_password_hash, now(), false
  )
  RETURNING id INTO new_user_id;

  UPDATE public.sms_invitations
  SET accepted_at = now(),
      accepted_user_id = new_user_id
  WHERE id = invitation.id;

  RETURN new_user_id;
END;
$$;

-- Invalidate every existing session for one user. Called after a role change,
-- deactivation, permission-override change, or password reset. The backend
-- compares the cookie's `se` against session_epoch on every request and
-- answers 401 SESSION_STALE when they differ.
CREATE OR REPLACE FUNCTION bump_sms_user_session_epoch(p_user_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE next_epoch integer;
BEGIN
  UPDATE public.sms_users
  SET session_epoch = session_epoch + 1
  WHERE id = p_user_id
  RETURNING session_epoch INTO next_epoch;

  IF next_epoch IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  RETURN next_epoch;
END;
$$;

-- Functions in the public schema are executable by PUBLIC unless revoked.
-- Both of these are internal backend RPCs, not client APIs: an anon or
-- authenticated caller invoking a SECURITY DEFINER function would bypass the
-- table RLS below.
REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM anon;
REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION redeem_sms_invitation(text, text) TO service_role;

REVOKE ALL ON FUNCTION bump_sms_user_session_epoch(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION bump_sms_user_session_epoch(bigint) FROM anon;
REVOKE ALL ON FUNCTION bump_sms_user_session_epoch(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION bump_sms_user_session_epoch(bigint) TO service_role;

-- Trigger-only; direct execution is unnecessary.
REVOKE ALL ON FUNCTION touch_sms_users_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_sms_users_updated_at() FROM anon;
REVOKE ALL ON FUNCTION touch_sms_users_updated_at() FROM authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Enabled with no policies: the service role used by the Railway backend
-- bypasses RLS, and every other Postgres role sees zero rows. Password hashes
-- and invitation token hashes must never be reachable from a browser key.

ALTER TABLE sms_roles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_permissions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_role_permissions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_user_permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_invitations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_auth_events            ENABLE ROW LEVEL SECURITY;

-- The view runs with security_invoker, so it already inherits the table RLS
-- above. Revoking anyway keeps the intent explicit.
REVOKE ALL ON sms_effective_permissions FROM PUBLIC;
REVOKE ALL ON sms_effective_permissions FROM anon;
REVOKE ALL ON sms_effective_permissions FROM authenticated;
GRANT SELECT ON sms_effective_permissions TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
