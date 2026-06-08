-- Run this in Supabase SQL editor before deploying

-- call_logs table
CREATE TABLE IF NOT EXISTS call_logs (
  id BIGSERIAL PRIMARY KEY,
  call_control_id TEXT UNIQUE,
  call_leg_id TEXT,
  call_session_id TEXT,
  direction TEXT CHECK(direction IN ('inbound','outbound')),
  contact_phone TEXT NOT NULL,
  from_number TEXT,
  to_number TEXT,
  status TEXT DEFAULT 'initiated'
    CHECK(status IN ('initiated','ringing','answered','completed','missed','failed','declined')),
  duration_seconds INTEGER DEFAULT 0,
  recording_id TEXT,
  recording_url_mp3 TEXT,
  recording_url_wav TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_call_logs_phone ON call_logs(contact_phone);
CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs(started_at DESC);
ALTER TABLE call_logs DISABLE ROW LEVEL SECURITY;

-- unread_count on sms_contacts (safe if already exists)
ALTER TABLE sms_contacts
  ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;

-- RPC to atomically increment unread count
CREATE OR REPLACE FUNCTION increment_unread(p_phone TEXT)
RETURNS VOID AS $$
  UPDATE sms_contacts
  SET unread_count = COALESCE(unread_count, 0) + 1
  WHERE phone = p_phone;
$$ LANGUAGE SQL;
