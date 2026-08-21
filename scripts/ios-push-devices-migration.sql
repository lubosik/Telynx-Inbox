-- Run once in the Supabase SQL editor before enabling native iOS message push.
-- This table is intentionally separate from browser VAPID subscriptions:
-- APNs device tokens and browser push endpoints have different lifecycles.
--
-- NOT YET APPLIED IN PRODUCTION. Until it is, routes/mobile-push.js writes to
-- push_subscriptions instead (endpoint = 'apns://{environment}/{token}', with
-- the same fields inside the jsonb `subscription` column), and
-- lib/apns-notify.js reads from whichever storage answers. This file is
-- therefore amended in place rather than followed by a second migration.
--
-- SAFETY
--   * Wrapped in BEGIN/COMMIT, matching scripts/audit-migration.sql and
--     scripts/rbac-migration.sql. Every statement below is transactional in
--     Postgres, so a failure part-way through rolls the whole file back rather
--     than leaving the table created but unindexed and, worse, unprotected.
--   * Re-runnable: every statement is IF NOT EXISTS or an idempotent ALTER.
--   * RLS is ENABLED with no policies, matching every other table in this
--     release. See the note above the ALTER at the foot of this file.
--
-- KNOWN GAP, RECORDED DELIBERATELY
--   `push_subscriptions` — the live compatibility storage that currently holds
--   the real APNs device tokens, and which now also carries a `userId` inside
--   its jsonb `subscription` column — does NOT have RLS enabled. That is not
--   fixed here on purpose. push_subscriptions is a live table serving browser
--   web push and the iOS compatibility path simultaneously; enabling RLS on it
--   is a separate, deliberate migration that needs its own review of every
--   reader, not a side effect of a file about a table that does not exist yet.
--   Do not quietly fold it into this one.

BEGIN;

CREATE TABLE IF NOT EXISTS ios_push_devices (
  id              bigint generated always as identity primary key,
  device_token    text unique not null,
  installation_id text,
  environment     text not null default 'production'
                  check (environment in ('sandbox', 'production')),
  bundle_id       text not null default 'com.vicipeptides.inbox',
  enabled         boolean not null default true,
  -- Who this iPhone belongs to, taken from the authenticated session at
  -- registration and never from the request body. Nullable because a device
  -- registered before this column existed has no known owner, and because a
  -- send filtered by owner must skip an unowned device rather than guess.
  --
  -- bigint to match the users table's identity primary key. If user ids turn
  -- out to be uuids, change this column to `uuid` (or `text`) BEFORE running
  -- this migration; lib/apns-notify.js already normalises the value to a string
  -- on read, so nothing in the application code has to change with it.
  user_id         bigint,
  -- The app build the device last registered from, e.g. '21'. Text because it
  -- is an opaque identifier that is only ever compared numerically after an
  -- explicit digits check, and because CFBundleVersion is a string.
  app_build       text,
  user_agent      text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Additive columns for a table that was created before targeting existed.
-- Harmless on a fresh CREATE above, and the reason this file stays re-runnable.
ALTER TABLE ios_push_devices ADD COLUMN IF NOT EXISTS user_id   bigint;
ALTER TABLE ios_push_devices ADD COLUMN IF NOT EXISTS app_build text;

-- Message push reads every enabled device; a release notification reads the
-- same set and then narrows by owner and build, so both are covered by one
-- index with enabled/environment leading.
CREATE INDEX IF NOT EXISTS idx_ios_push_devices_enabled
  ON ios_push_devices(enabled, environment, updated_at DESC);

-- Owner-scoped sends ("notify this person's iPhones") filter on user_id alone.
CREATE INDEX IF NOT EXISTS idx_ios_push_devices_user
  ON ios_push_devices(user_id, enabled)
  WHERE user_id IS NOT NULL;

-- Token rotation deletes prior rows for the same app install on every register.
CREATE INDEX IF NOT EXISTS idx_ios_push_devices_installation
  ON ios_push_devices(installation_id)
  WHERE installation_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Enabled with no policies, exactly as scripts/audit-migration.sql and
-- scripts/rbac-migration.sql do it: the Railway backend uses the service role,
-- which bypasses RLS, and every other Postgres role sees zero rows.
--
-- This previously read DISABLE. That left a table holding APNs device tokens —
-- and, since the user_id column above, a map of which human owns which iPhone
-- — readable by anon and authenticated through the Supabase REST endpoint with
-- nothing but the publishable key. A device token is a push-delivery
-- credential, so the default has to be closed.
--
-- If a browser or a signed-in Supabase user ever needs to read this table
-- directly, add an explicit policy in its own migration. Nothing does today:
-- routes/mobile-push.js and lib/apns-notify.js both go through the backend.
ALTER TABLE ios_push_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ios_push_devices FROM PUBLIC;
REVOKE ALL ON TABLE ios_push_devices FROM anon;
REVOKE ALL ON TABLE ios_push_devices FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ios_push_devices TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
