-- Vici Inbox — an invitee should not be forced to change the password they
-- just chose.
--
-- Run this ONCE in the Supabase SQL editor. It replaces one function and
-- touches no data. Safe to re-run.
--
-- WHY
--   redeem_sms_invitation created the account with must_change_password = true.
--   That flag exists for a real reason — an admin who sets someone's initial
--   password has seen it, so it must be rotated on first use. But an invitee
--   types their OWN password into the accept-invite page. Nobody else ever saw
--   it. Forcing an immediate second change protects nothing and makes joining
--   the workspace a two-step chore, in a flow where every extra step is a place
--   to get stuck.
--
--   The admin-set path is unaffected: POST /api/users and
--   POST /api/users/:id/reset-password set the flag in application code, not
--   here, and they still do.
--
-- The function body below is identical to the one in rbac-migration.sql apart
-- from that single literal. Keep the two in step if either changes.

BEGIN;

CREATE OR REPLACE FUNCTION redeem_sms_invitation(
  p_token_hash    text,
  p_password_hash text
) RETURNS bigint
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
    -- false: the invitee chose this password themselves, seconds ago.
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

REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM anon;
REVOKE ALL ON FUNCTION redeem_sms_invitation(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION redeem_sms_invitation(text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
