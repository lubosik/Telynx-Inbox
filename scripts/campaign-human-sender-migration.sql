-- Attribute future one-to-one SMS to the authenticated human who wrote them.
-- Historical messages are intentionally left NULL: the old rows do not prove
-- whether Dominic, another teammate, or an automation sent them.
ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS sender_user_id bigint REFERENCES public.sms_users(id);

CREATE INDEX IF NOT EXISTS sms_messages_human_sender_recent_idx
  ON public.sms_messages (sender_user_id, created_at DESC)
  WHERE sender_user_id IS NOT NULL AND direction = 'outbound';
