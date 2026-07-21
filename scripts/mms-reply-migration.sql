-- MMS + reply threading + reactions migration
-- Run in Supabase SQL editor (project cckzshsvchhsfsnbycoj) before deploying.
--
-- media_urls:          JSONB array of { url, content_type } — inbound media re-hosted
--                      in the public mms-media storage bucket; outbound media uploaded
--                      by the operator via /api/upload.
-- reply_to_message_id: BIGINT id of the sms_messages row this message replies to
--                      (in-app threading; also set on inbound tapback rows to point
--                      at the message the reaction targets).
-- reactions:           JSONB array of { type, at, source } tapback reactions applied
--                      TO this message (e.g. [{"type":"loved","at":"...","source":"customer"}]).

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS media_urls JSONB;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS reactions JSONB;

CREATE INDEX IF NOT EXISTS idx_sms_messages_phone_created
  ON sms_messages(contact_phone, created_at DESC);
