-- Run once in the Supabase SQL editor before enabling native iOS message push.
-- This table is intentionally separate from browser VAPID subscriptions:
-- APNs device tokens and browser push endpoints have different lifecycles.
CREATE TABLE IF NOT EXISTS ios_push_devices (
  id              bigint generated always as identity primary key,
  device_token    text unique not null,
  installation_id text,
  environment     text not null default 'production'
                  check (environment in ('sandbox', 'production')),
  bundle_id       text not null default 'com.vicipeptides.inbox',
  enabled         boolean not null default true,
  user_agent      text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_ios_push_devices_enabled
  ON ios_push_devices(enabled, environment, updated_at DESC);

ALTER TABLE ios_push_devices DISABLE ROW LEVEL SECURITY;
