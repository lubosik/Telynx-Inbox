-- Additive inbox-only cleanup. No messages or delivery history are deleted.
BEGIN;
ALTER TABLE public.sms_messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
CREATE OR REPLACE FUNCTION public.hide_failed_inbox_message(p_id bigint, p_phone text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_message public.sms_messages%ROWTYPE;
BEGIN
  SELECT * INTO v_message FROM public.sms_messages
  WHERE id = p_id AND contact_phone = p_phone FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_message.direction <> 'outbound' OR lower(coalesce(v_message.status,''))
      NOT IN ('failed','sending_failed','delivery_failed') THEN
    RAISE EXCEPTION 'message_not_failed' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.sms_messages SET hidden_at = coalesce(hidden_at,now()) WHERE id = p_id;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.hide_failed_inbox_message(bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hide_failed_inbox_message(bigint,text) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
