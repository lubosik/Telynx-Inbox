-- Private call-recording storage and lifecycle metadata.
-- Safe to re-run. No existing recording or call-log row is deleted.
--
-- Rollout order:
--   1. Run this migration.
--   2. Deploy the backend.
--   3. Run the existing recording backfill from the authenticated admin UI.
--      It copies legacy Telnyx recordings into this private bucket and clears
--      temporary provider URLs only after each upload succeeds.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_storage_path text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_content_type text;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_archived_at timestamptz;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_expires_at timestamptz;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS call_logs_recording_expiry_idx
  ON call_logs (recording_expires_at)
  WHERE recording_expires_at IS NOT NULL AND recording_deleted_at IS NULL;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  false,
  104857600,
  ARRAY['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

