-- LUKO / Vici abandoned-cart Growth Sales Engine.
-- Additive and rerunnable. Apply after scripts/cart-recovery-migration.sql.
-- This migration changes the first-touch delay to 45 minutes, but does not
-- enable live SMS or customer push delivery.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.luko_cart_recoveries') IS NULL THEN
    RAISE EXCEPTION 'scripts/cart-recovery-migration.sql must be applied first';
  END IF;
  IF to_regclass('public.sms_users') IS NULL THEN
    RAISE EXCEPTION 'scripts/rbac-migration.sql must be applied first';
  END IF;
END
$$;

ALTER TABLE public.luko_cart_recoveries
  ADD COLUMN IF NOT EXISTS customer_identity_id uuid,
  ADD COLUMN IF NOT EXISTS identity_resolution_ambiguous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_email text,
  ADD COLUMN IF NOT EXISTS customer_first_name text,
  ADD COLUMN IF NOT EXISTS customer_market text NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS primary_product_name text,
  ADD COLUMN IF NOT EXISTS item_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cart_applied_coupons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS journey_status text NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS sms_status text NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS reply_status text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS objection_category text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS objection_secondary_category text,
  ADD COLUMN IF NOT EXISTS objection_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS objection_summary text,
  ADD COLUMN IF NOT EXISTS push_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_status text NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS push_destination_type text,
  ADD COLUMN IF NOT EXISTS push_destination_url text,
  ADD COLUMN IF NOT EXISTS push_title text,
  ADD COLUMN IF NOT EXISTS push_body text,
  ADD COLUMN IF NOT EXISTS push_discount_code text,
  ADD COLUMN IF NOT EXISTS push_discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS push_coupon_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_coupon_block_reason text,
  ADD COLUMN IF NOT EXISTS customer_push_destination_id text,
  ADD COLUMN IF NOT EXISTS customer_push_permission boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS push_claim_token uuid,
  ADD COLUMN IF NOT EXISTS push_claim_until timestamptz,
  ADD COLUMN IF NOT EXISTS push_proposed_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_provider_message_id text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS automated_sms_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS automated_push_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_item_count_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_item_count_check
      CHECK (item_count >= 0 AND item_count <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_applied_coupons_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_applied_coupons_check
      CHECK (jsonb_typeof(cart_applied_coupons)='array' AND jsonb_array_length(cart_applied_coupons)<=20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_customer_market_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_customer_market_check
      CHECK (customer_market ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_journey_status_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_journey_status_check CHECK (journey_status IN (
      'QUEUED','ELIGIBLE','BLOCKED','SENT','DELIVERED','CLICKED','REPLIED',
      'CANCELLED_PURCHASED','CANCELLED_CART_CHANGED','CANCELLED_UNSUBSCRIBED','FAILED','CONVERTED'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_sms_status_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_sms_status_check CHECK (sms_status IN (
      'QUEUED','ELIGIBLE','BLOCKED','DRY_RUN','SENDING','SENT','DELIVERED','CLICKED','REPLIED',
      'CANCELLED_PURCHASED','CANCELLED_CART_CHANGED','CANCELLED_UNSUBSCRIBED','FAILED','RECONCILIATION_REQUIRED'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_reply_status_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_reply_status_check CHECK (reply_status IN (
      'NONE','RECEIVED','CLASSIFIED','DRAFT_READY','APPROVED','SENT','DISCARDED','ESCALATED','FAILED'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_push_status_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_push_status_check CHECK (push_status IN (
      'QUEUED','ELIGIBLE','BLOCKED','DRY_RUN','SENDING','SENT','DELIVERED','CLICKED',
      'CANCELLED_PURCHASED','CANCELLED_CART_CHANGED','CANCELLED_UNSUBSCRIBED','FAILED','RECONCILIATION_REQUIRED'
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_objection_confidence_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_objection_confidence_check
      CHECK (objection_confidence IS NULL OR objection_confidence BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_automated_sms_count_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_automated_sms_count_check
      CHECK (automated_sms_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_automated_push_count_check') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_automated_push_count_check
      CHECK (automated_push_count >= 0);
  END IF;
END
$$;

-- One identity row per Woo/WordPress customer. A phone is a contact channel,
-- not the customer key, and consent is deliberately absent from this table.
-- This lets an old Woo account link to an existing LUKO phone contact without
-- creating a second contact or treating a stored billing number as opt-in.
CREATE TABLE IF NOT EXISTS public.luko_customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  wordpress_user_id text,
  customer_email text,
  email_sha256 text,
  contact_phone text,
  luko_contact_linked boolean NOT NULL DEFAULT false,
  resolved_by text NOT NULL CHECK (resolved_by IN ('wordpress_user_id','external_mapping','email','normalized_phone','new_mapping')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (wordpress_user_id IS NULL OR wordpress_user_id ~ '^[0-9]{1,24}$'),
  CHECK (customer_email IS NULL OR length(customer_email) <= 320),
  CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  UNIQUE (workspace_id,wordpress_user_id)
);

CREATE INDEX IF NOT EXISTS luko_customer_identities_email_idx
  ON public.luko_customer_identities (workspace_id,lower(customer_email)) WHERE customer_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS luko_customer_identities_phone_idx
  ON public.luko_customer_identities (workspace_id,contact_phone) WHERE contact_phone IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='luko_cart_recoveries_customer_identity_fk') THEN
    ALTER TABLE public.luko_cart_recoveries ADD CONSTRAINT luko_cart_recoveries_customer_identity_fk
      FOREIGN KEY (customer_identity_id) REFERENCES public.luko_customer_identities(id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.resolve_luko_cart_customer_identity(
  p_workspace text,p_wordpress_user_id text,p_email text,p_phone text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v public.luko_customer_identities%ROWTYPE; v_id uuid; v_candidate_id uuid;
  v_method text; v_phone text; v_input_phone text; v_email text;
  v_count integer:=0; v_other_customer boolean:=false; v_ambiguous boolean:=false;
BEGIN
  IF nullif(p_wordpress_user_id,'') IS NOT NULL AND p_wordpress_user_id !~ '^[0-9]{1,24}$' THEN
    RAISE EXCEPTION 'invalid_wordpress_customer_id' USING ERRCODE='22023';
  END IF;
  v_email:=nullif(lower(trim(coalesce(p_email,''))),'');
  v_input_phone:=nullif(trim(coalesce(p_phone,'')),'');
  v_phone:=v_input_phone;
  IF v_email IS NOT NULL AND (length(v_email)>320 OR position('@' IN v_email)<2) THEN
    RAISE EXCEPTION 'invalid_customer_email' USING ERRCODE='22023';
  END IF;
  IF v_input_phone IS NOT NULL AND v_input_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'invalid_customer_phone' USING ERRCODE='22023';
  END IF;

  IF nullif(p_wordpress_user_id,'') IS NOT NULL THEN
    SELECT * INTO v FROM public.luko_customer_identities
    WHERE workspace_id=p_workspace AND wordpress_user_id=p_wordpress_user_id LIMIT 1 FOR UPDATE;
    IF v.id IS NOT NULL THEN
      UPDATE public.luko_customer_identities SET
        customer_email=coalesce(v_email,customer_email),
        email_sha256=CASE WHEN v_email IS NULL THEN email_sha256 ELSE encode(digest(v_email,'sha256'),'hex') END,
        luko_contact_linked=EXISTS(SELECT 1 FROM public.sms_contacts c WHERE c.phone=v.contact_phone),
        resolved_by='wordpress_user_id',updated_at=now() WHERE id=v.id;
      SELECT * INTO v FROM public.luko_customer_identities WHERE id=v.id;
      RETURN jsonb_build_object('identity_id',v.id,'contact_phone',v.contact_phone,
        'luko_contact_linked',v.luko_contact_linked,'resolved_by','wordpress_user_id','ambiguous',false);
    END IF;
  END IF;

  -- Existing sms_contacts.woo_customer_id is the pre-Growth LUKO external
  -- customer mapping and therefore wins before email or phone matching. More
  -- than one distinct result is quarantined instead of picked arbitrarily.
  IF nullif(p_wordpress_user_id,'') IS NOT NULL THEN
    SELECT count(DISTINCT c.phone),min(c.phone) INTO v_count,v_phone
    FROM public.sms_contacts c WHERE c.woo_customer_id::text=p_wordpress_user_id AND c.phone IS NOT NULL;
    IF v_count=1 THEN v_method:='external_mapping';
    ELSIF v_count>1 THEN v_ambiguous:=true; END IF;
  END IF;

  IF v_method IS NULL AND NOT v_ambiguous AND v_email IS NOT NULL THEN
    SELECT count(*),(array_agg(i.id ORDER BY i.updated_at DESC,i.id))[1],
      coalesce(bool_or(i.wordpress_user_id IS NOT NULL AND i.wordpress_user_id<>p_wordpress_user_id),false)
    INTO v_count,v_candidate_id,v_other_customer
    FROM public.luko_customer_identities i
    WHERE i.workspace_id=p_workspace AND lower(i.customer_email)=v_email;
    IF v_count=1 AND NOT v_other_customer THEN
      SELECT * INTO v FROM public.luko_customer_identities WHERE id=v_candidate_id FOR UPDATE;
      IF v.wordpress_user_id IS NOT NULL AND v.wordpress_user_id<>p_wordpress_user_id THEN
        v_ambiguous:=true;
      ELSE
        v_id:=v.id; v_phone:=coalesce(v.contact_phone,v_input_phone); v_method:='email';
      END IF;
    ELSIF v_count>0 THEN
      v_ambiguous:=true;
    END IF;
  END IF;

  IF v_method IS NULL AND NOT v_ambiguous AND v_email IS NOT NULL THEN
    SELECT count(DISTINCT c.phone),min(c.phone),
      coalesce(bool_or(c.woo_customer_id IS NOT NULL AND c.woo_customer_id::text<>p_wordpress_user_id),false)
    INTO v_count,v_phone,v_other_customer
    FROM public.sms_contacts c WHERE lower(c.email)=v_email AND c.phone IS NOT NULL;
    IF v_count=1 AND NOT v_other_customer THEN v_method:='email';
    ELSIF v_count>0 THEN v_ambiguous:=true; END IF;
  END IF;

  IF v_method IS NULL AND NOT v_ambiguous AND v_input_phone IS NOT NULL THEN
    SELECT count(*),(array_agg(i.id ORDER BY i.updated_at DESC,i.id))[1],
      coalesce(bool_or(i.wordpress_user_id IS NOT NULL AND i.wordpress_user_id<>p_wordpress_user_id),false)
    INTO v_count,v_candidate_id,v_other_customer
    FROM public.luko_customer_identities i
    WHERE i.workspace_id=p_workspace AND i.contact_phone=v_input_phone;
    IF v_count=1 AND NOT v_other_customer THEN
      SELECT * INTO v FROM public.luko_customer_identities WHERE id=v_candidate_id FOR UPDATE;
      IF v.wordpress_user_id IS NOT NULL AND v.wordpress_user_id<>p_wordpress_user_id THEN
        v_ambiguous:=true;
      ELSE
        v_id:=v.id; v_phone:=v_input_phone; v_method:='normalized_phone';
      END IF;
    ELSIF v_count>0 THEN
      v_ambiguous:=true;
    END IF;
  END IF;

  IF v_method IS NULL AND NOT v_ambiguous AND v_input_phone IS NOT NULL THEN
    SELECT count(*),coalesce(bool_or(c.woo_customer_id IS NOT NULL AND c.woo_customer_id::text<>p_wordpress_user_id),false)
    INTO v_count,v_other_customer FROM public.sms_contacts c WHERE c.phone=v_input_phone;
    IF v_count=1 AND NOT v_other_customer THEN v_phone:=v_input_phone; v_method:='normalized_phone';
    ELSIF v_count>0 THEN v_ambiguous:=true; END IF;
  END IF;

  IF v_ambiguous THEN
    -- Keep the Woo identity and observed email, but do not bind the contested
    -- phone to a LUKO contact. The cart remains visible and SMS is blocked.
    v_phone:=NULL; v_method:='new_mapping'; v_id:=NULL;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.luko_customer_identities(workspace_id,wordpress_user_id,customer_email,email_sha256,
      contact_phone,luko_contact_linked,resolved_by)
    VALUES(p_workspace,nullif(p_wordpress_user_id,''),v_email,
      CASE WHEN v_email IS NULL THEN NULL ELSE encode(digest(v_email,'sha256'),'hex') END,
      v_phone,NOT v_ambiguous AND EXISTS(SELECT 1 FROM public.sms_contacts WHERE phone=v_phone),coalesce(v_method,'new_mapping'))
    ON CONFLICT (workspace_id,wordpress_user_id) DO UPDATE SET
      customer_email=coalesce(EXCLUDED.customer_email,public.luko_customer_identities.customer_email),
      email_sha256=coalesce(EXCLUDED.email_sha256,public.luko_customer_identities.email_sha256),
      contact_phone=coalesce(public.luko_customer_identities.contact_phone,EXCLUDED.contact_phone),
      luko_contact_linked=public.luko_customer_identities.luko_contact_linked OR EXCLUDED.luko_contact_linked,
      resolved_by='wordpress_user_id',updated_at=now()
    RETURNING id INTO v_id;
    v_method:=coalesce(v_method,'new_mapping');
  ELSE
    UPDATE public.luko_customer_identities SET
      wordpress_user_id=CASE WHEN wordpress_user_id IS NULL THEN nullif(p_wordpress_user_id,'') ELSE wordpress_user_id END,
      customer_email=coalesce(v_email,customer_email),
      email_sha256=CASE WHEN v_email IS NULL THEN email_sha256 ELSE encode(digest(v_email,'sha256'),'hex') END,
      contact_phone=coalesce(v_phone,contact_phone),
      luko_contact_linked=EXISTS(SELECT 1 FROM public.sms_contacts WHERE phone=coalesce(v_phone,contact_phone)),
      resolved_by=v_method,updated_at=now() WHERE id=v_id;
  END IF;
  SELECT * INTO v FROM public.luko_customer_identities WHERE id=v_id;
  RETURN jsonb_build_object('identity_id',v.id,'contact_phone',v.contact_phone,
    'luko_contact_linked',v.luko_contact_linked,'resolved_by',v_method,'ambiguous',v_ambiguous);
END;
$$;

-- Seed the mapping from already-observed recovery rows. This never creates an
-- SMS contact and never creates consent; it only records that the Woo customer
-- and an existing normalized contact phone refer to the same identity.
INSERT INTO public.luko_customer_identities(workspace_id,wordpress_user_id,customer_email,email_sha256,
  contact_phone,luko_contact_linked,resolved_by,created_at,updated_at)
SELECT DISTINCT ON (r.workspace_id,r.wordpress_user_id)
  r.workspace_id,r.wordpress_user_id,lower(r.customer_email),
  CASE WHEN r.customer_email IS NULL THEN NULL ELSE encode(digest(lower(r.customer_email),'sha256'),'hex') END,
  r.contact_phone,EXISTS(SELECT 1 FROM public.sms_contacts c WHERE c.phone=r.contact_phone),
  'external_mapping',r.created_at,now()
FROM public.luko_cart_recoveries r
WHERE r.wordpress_user_id IS NOT NULL
ORDER BY r.workspace_id,r.wordpress_user_id,r.updated_at DESC
ON CONFLICT (workspace_id,wordpress_user_id) DO UPDATE SET
  customer_email=coalesce(EXCLUDED.customer_email,public.luko_customer_identities.customer_email),
  email_sha256=coalesce(EXCLUDED.email_sha256,public.luko_customer_identities.email_sha256),
  contact_phone=coalesce(EXCLUDED.contact_phone,public.luko_customer_identities.contact_phone),
  luko_contact_linked=EXCLUDED.luko_contact_linked,updated_at=now();

UPDATE public.luko_cart_recoveries r SET customer_identity_id=i.id
FROM public.luko_customer_identities i
WHERE r.customer_identity_id IS NULL AND i.workspace_id=r.workspace_id
  AND i.wordpress_user_id=r.wordpress_user_id;

-- Reconcile rows created by v1. Only a still-pending first touch moves from
-- the old 30-minute default to 45 minutes; sent history is never rewritten.
UPDATE public.luko_cart_recoveries SET
  item_count=jsonb_array_length(cart_items),
  primary_product_name=coalesce(primary_product_name,nullif(coalesce(cart_items#>>'{0,product_name}',cart_items#>>'{0,name}'),'')),
  due_at=CASE WHEN status='active' THEN last_activity_at+interval '45 minutes' ELSE due_at END,
  push_due_at=coalesce(push_due_at,last_activity_at+interval '48 hours'),
  journey_status=CASE WHEN journey_status<>'QUEUED' OR status='active' THEN journey_status ELSE CASE
    WHEN status='recovered' THEN 'CONVERTED'
    WHEN status IN ('ordered','paid') THEN 'CANCELLED_PURCHASED'
    WHEN status='emptied' THEN 'CANCELLED_CART_CHANGED'
    WHEN status='suppressed' THEN 'BLOCKED'
    WHEN clicked_at IS NOT NULL THEN 'CLICKED'
    WHEN delivered_at IS NOT NULL THEN 'DELIVERED'
    WHEN sent_at IS NOT NULL THEN 'SENT'
    WHEN status='failed' THEN 'FAILED'
    WHEN status='dry_run' THEN 'ELIGIBLE'
    ELSE 'QUEUED' END END,
  sms_status=CASE WHEN sms_status<>'QUEUED' OR status='active' THEN sms_status ELSE CASE
    WHEN status IN ('ordered','paid','recovered') AND sent_at IS NULL THEN 'CANCELLED_PURCHASED'
    WHEN status='emptied' AND sent_at IS NULL THEN 'CANCELLED_CART_CHANGED'
    WHEN status='suppressed' AND sent_at IS NULL THEN 'BLOCKED'
    WHEN clicked_at IS NOT NULL THEN 'CLICKED'
    WHEN delivered_at IS NOT NULL THEN 'DELIVERED'
    WHEN sent_at IS NOT NULL THEN 'SENT'
    WHEN status='failed' THEN 'FAILED'
    WHEN status='reconciliation_required' THEN 'RECONCILIATION_REQUIRED'
    WHEN status='dry_run' THEN 'DRY_RUN'
    ELSE 'QUEUED' END END,
  push_status=CASE WHEN push_status<>'QUEUED' THEN push_status ELSE CASE
    WHEN status IN ('ordered','paid','recovered') AND push_sent_at IS NULL THEN 'CANCELLED_PURCHASED'
    WHEN status='emptied' AND push_sent_at IS NULL THEN 'CANCELLED_CART_CHANGED'
    WHEN status='suppressed' AND push_sent_at IS NULL THEN 'BLOCKED'
    ELSE push_status END END,
  automated_sms_count=CASE WHEN sent_at IS NOT NULL THEN greatest(automated_sms_count,1) ELSE automated_sms_count END,
  automated_push_count=CASE WHEN push_sent_at IS NOT NULL THEN greatest(automated_push_count,1) ELSE automated_push_count END,
  updated_at=now()
WHERE item_count<>jsonb_array_length(cart_items)
   OR (primary_product_name IS NULL AND jsonb_array_length(cart_items)>0)
   OR push_due_at IS NULL
   OR (status='active' AND due_at=last_activity_at+interval '30 minutes')
   OR (journey_status='QUEUED' AND status<>'active')
   OR (sms_status='QUEUED' AND status<>'active')
   OR (push_status='QUEUED' AND status IN ('ordered','paid','recovered','emptied','suppressed'))
   OR (sent_at IS NOT NULL AND automated_sms_count=0)
   OR (push_sent_at IS NOT NULL AND automated_push_count=0);

CREATE INDEX IF NOT EXISTS luko_cart_push_due_idx
  ON public.luko_cart_recoveries (workspace_id,push_due_at,id)
  WHERE push_status='QUEUED';
CREATE INDEX IF NOT EXISTS luko_cart_recoveries_phone_recent_idx
  ON public.luko_cart_recoveries (workspace_id,contact_phone,last_activity_at DESC)
  WHERE contact_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.luko_cart_recovery_settings (
  workspace_id text PRIMARY KEY DEFAULT 'vici',
  enabled boolean NOT NULL DEFAULT false,
  first_sms_delay_minutes integer NOT NULL DEFAULT 45 CHECK (first_sms_delay_minutes BETWEEN 15 AND 1440),
  first_sms_template text NOT NULL DEFAULT '{{first_name}}, it''s Vin from Vici. Saw you tried to order {{product_name}} but didn''t quite finish checking out. Did anything come up at checkout that I can help you with? I''ve kept it for you here: {{recovery_url}} Reply STOP to opt out.',
  first_sms_template_locked boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT false,
  push_delay_hours integer NOT NULL DEFAULT 48 CHECK (push_delay_hours BETWEEN 1 AND 720),
  push_title_template text NOT NULL DEFAULT 'Still thinking about {{product_name}}?',
  push_body_template text NOT NULL DEFAULT 'Vin here. I managed to get you 15% off if you still want to go ahead. Use code {{discount_code}}.',
  discount_code text NOT NULL DEFAULT 'VICI15',
  discount_percent numeric(5,2) NOT NULL DEFAULT 15 CHECK (discount_percent=15),
  single_product_destination text NOT NULL DEFAULT 'exact_product' CHECK (single_product_destination='exact_product'),
  multi_product_destination text NOT NULL DEFAULT 'shop' CHECK (multi_product_destination='shop'),
  low_stock_enabled boolean NOT NULL DEFAULT false,
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold BETWEEN 1 AND 1000),
  ai_classification_enabled boolean NOT NULL DEFAULT true,
  ai_draft_replies_enabled boolean NOT NULL DEFAULT true,
  automatic_ai_sending boolean NOT NULL DEFAULT false CHECK (automatic_ai_sending=false),
  market_policy jsonb NOT NULL DEFAULT '{"US":{"max_automated_cart_sms_per_event":1}}'::jsonb CHECK (jsonb_typeof(market_policy)='object'),
  updated_by bigint REFERENCES public.sms_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.luko_cart_recovery_settings (workspace_id)
VALUES ('vici') ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.luko_cart_recovery_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'vici',
  recovery_id uuid NOT NULL REFERENCES public.luko_cart_recoveries(id) ON DELETE CASCADE,
  inbound_message_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  primary_category text NOT NULL DEFAULT 'UNKNOWN',
  secondary_category text,
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  short_summary text,
  medical_escalation boolean NOT NULL DEFAULT false,
  draft_ciphertext text,
  draft_status text NOT NULL DEFAULT 'RECEIVED' CHECK (draft_status IN (
    'RECEIVED','CLASSIFIED','DRAFT_READY','EDITED','SENDING','APPROVED_DRY_RUN','SENT',
    'DISCARDED','ESCALATED','FAILED','RECONCILIATION_REQUIRED'
  )),
  automatic_send boolean NOT NULL DEFAULT false CHECK (automatic_send=false),
  edited_by bigint REFERENCES public.sms_users(id),
  approved_by bigint REFERENCES public.sms_users(id),
  approved_at timestamptz,
  outbound_message_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,inbound_message_id),
  CHECK (draft_status NOT IN ('SENDING','APPROVED_DRY_RUN','SENT') OR approved_at IS NOT NULL),
  CHECK (draft_status NOT IN ('SENDING','APPROVED_DRY_RUN','SENT') OR approved_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS luko_cart_recovery_replies_recovery_idx
  ON public.luko_cart_recovery_replies (recovery_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS public.luko_cart_recovery_timeline (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'vici',
  recovery_id uuid NOT NULL REFERENCES public.luko_cart_recoveries(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id bigint REFERENCES public.sms_users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS luko_cart_recovery_timeline_recovery_idx
  ON public.luko_cart_recovery_timeline (recovery_id,occurred_at,id);

CREATE OR REPLACE FUNCTION public.prevent_luko_cart_timeline_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'luko_cart_recovery_timeline is append-only';
END;
$$;

DROP TRIGGER IF EXISTS luko_cart_timeline_no_update ON public.luko_cart_recovery_timeline;
CREATE TRIGGER luko_cart_timeline_no_update BEFORE UPDATE OR DELETE ON public.luko_cart_recovery_timeline
FOR EACH ROW EXECUTE FUNCTION public.prevent_luko_cart_timeline_mutation();

CREATE OR REPLACE FUNCTION public.append_luko_cart_recovery_timeline(
  p_recovery_id uuid,p_event_type text,p_occurred_at timestamptz DEFAULT now(),
  p_metadata jsonb DEFAULT '{}'::jsonb,p_actor_user_id bigint DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_workspace text; v_id bigint;
BEGIN
  IF p_event_type IS NULL OR p_event_type !~ '^[A-Z][A-Z0-9_]{1,79}$'
     OR coalesce(jsonb_typeof(p_metadata),'null') <> 'object' THEN
    RAISE EXCEPTION 'invalid_cart_timeline_event' USING ERRCODE='22023';
  END IF;
  SELECT workspace_id INTO v_workspace FROM public.luko_cart_recoveries WHERE id=p_recovery_id;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'cart_recovery_not_found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.luko_cart_recovery_timeline(workspace_id,recovery_id,event_type,occurred_at,actor_user_id,metadata)
  VALUES(v_workspace,p_recovery_id,p_event_type,coalesce(p_occurred_at,now()),p_actor_user_id,p_metadata) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.luko_cart_objection_valid(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
  SELECT p_value IN ('PAYMENT_PROBLEM','SHIPPING_COST','SHIPPING_QUESTION','CHECKOUT_TECHNICAL_PROBLEM',
    'DISCOUNT_OR_PRICE','PRODUCT_QUESTION','STOCK_OR_AVAILABILITY','DELIVERY_TIMING','WEBSITE_PROBLEM',
    'CHANGED_MIND','NEEDS_HELP','OTHER','UNKNOWN');
$$;

CREATE OR REPLACE FUNCTION public.attach_luko_cart_recovery_reply(
  p_workspace text,p_phone text,p_message_id text,p_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_recovery public.luko_cart_recoveries%ROWTYPE; v_reply uuid;
BEGIN
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' OR nullif(p_message_id,'') IS NULL THEN
    RAISE EXCEPTION 'invalid_cart_reply' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_recovery FROM public.luko_cart_recoveries
  WHERE workspace_id=p_workspace AND contact_phone=p_phone
    AND sent_at IS NOT NULL
    AND sent_at <= coalesce(p_occurred_at,now())
    AND sent_at >= coalesce(p_occurred_at,now())-interval '7 days'
    AND journey_status IN ('SENT','DELIVERED','CLICKED','REPLIED')
  ORDER BY sent_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF v_recovery.id IS NULL THEN RETURN jsonb_build_object('attached',false,'reason','no_recent_cart_recovery'); END IF;
  INSERT INTO public.luko_cart_recovery_replies(workspace_id,recovery_id,inbound_message_id,occurred_at)
  VALUES(p_workspace,v_recovery.id,p_message_id,coalesce(p_occurred_at,now()))
  ON CONFLICT (workspace_id,inbound_message_id) DO UPDATE SET inbound_message_id=EXCLUDED.inbound_message_id
  RETURNING id INTO v_reply;
  UPDATE public.luko_cart_recoveries SET journey_status='REPLIED',sms_status='REPLIED',reply_status='RECEIVED',updated_at=now()
  WHERE id=v_recovery.id;
  IF NOT EXISTS (SELECT 1 FROM public.luko_cart_recovery_timeline WHERE recovery_id=v_recovery.id AND event_type='CUSTOMER_REPLIED' AND metadata->>'inbound_message_id'=p_message_id) THEN
    PERFORM public.append_luko_cart_recovery_timeline(v_recovery.id,'CUSTOMER_REPLIED',p_occurred_at,
      jsonb_build_object('inbound_message_id',p_message_id),NULL);
  END IF;
  RETURN jsonb_build_object('attached',true,'recovery_id',v_recovery.id,'reply_id',v_reply);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_luko_cart_reply_analysis(
  p_reply_id uuid,p_primary_category text,p_secondary_category text,p_confidence numeric,
  p_summary text,p_medical_escalation boolean,p_draft_ciphertext text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_recovery uuid; v_status text;
BEGIN
  IF NOT public.luko_cart_objection_valid(p_primary_category)
     OR (p_secondary_category IS NOT NULL AND NOT public.luko_cart_objection_valid(p_secondary_category))
     OR p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR length(coalesce(p_summary,''))>500 THEN
    RAISE EXCEPTION 'invalid_cart_reply_analysis' USING ERRCODE='22023';
  END IF;
  v_status := CASE WHEN p_medical_escalation THEN 'ESCALATED' WHEN p_draft_ciphertext IS NOT NULL THEN 'DRAFT_READY' ELSE 'CLASSIFIED' END;
  UPDATE public.luko_cart_recovery_replies SET primary_category=p_primary_category,
    secondary_category=p_secondary_category,confidence=p_confidence,short_summary=nullif(p_summary,''),
    medical_escalation=coalesce(p_medical_escalation,false),draft_ciphertext=p_draft_ciphertext,
    draft_status=v_status,updated_at=now() WHERE id=p_reply_id RETURNING recovery_id INTO v_recovery;
  IF v_recovery IS NULL THEN RETURN false; END IF;
  UPDATE public.luko_cart_recoveries SET objection_category=p_primary_category,
    objection_secondary_category=p_secondary_category,objection_confidence=p_confidence,
    objection_summary=nullif(p_summary,''),reply_status=CASE WHEN p_medical_escalation THEN 'ESCALATED' WHEN p_draft_ciphertext IS NOT NULL THEN 'DRAFT_READY' ELSE 'CLASSIFIED' END,
    updated_at=now() WHERE id=v_recovery;
  PERFORM public.append_luko_cart_recovery_timeline(v_recovery,
    CASE WHEN p_medical_escalation THEN 'REPLY_ESCALATED' ELSE 'REPLY_CLASSIFIED' END,now(),
    jsonb_strip_nulls(jsonb_build_object('reply_id',p_reply_id,'primary_category',p_primary_category,
      'secondary_category',p_secondary_category,'confidence',p_confidence,'draft_generated',p_draft_ciphertext IS NOT NULL)),NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_luko_cart_reply_draft(p_reply_id uuid,p_draft_ciphertext text,p_actor_user_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_recovery uuid;
BEGIN
  IF nullif(p_draft_ciphertext,'') IS NULL OR p_actor_user_id IS NULL THEN RAISE EXCEPTION 'invalid_draft_edit' USING ERRCODE='22023'; END IF;
  UPDATE public.luko_cart_recovery_replies SET draft_ciphertext=p_draft_ciphertext,draft_status='EDITED',edited_by=p_actor_user_id,updated_at=now()
  WHERE id=p_reply_id AND draft_status IN ('DRAFT_READY','EDITED') RETURNING recovery_id INTO v_recovery;
  IF v_recovery IS NULL THEN RETURN false; END IF;
  PERFORM public.append_luko_cart_recovery_timeline(v_recovery,'AI_DRAFT_EDITED',now(),jsonb_build_object('reply_id',p_reply_id),p_actor_user_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_luko_cart_reply_send(p_reply_id uuid,p_actor_user_id bigint,p_dry_run boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reply public.luko_cart_recovery_replies%ROWTYPE; v_phone text;
BEGIN
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'human_approval_required' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_reply FROM public.luko_cart_recovery_replies WHERE id=p_reply_id FOR UPDATE;
  IF v_reply.id IS NULL OR v_reply.draft_status NOT IN ('DRAFT_READY','EDITED') OR v_reply.draft_ciphertext IS NULL OR v_reply.medical_escalation THEN
    RETURN jsonb_build_object('allowed',false,'reason','draft_not_sendable');
  END IF;
  SELECT contact_phone INTO v_phone FROM public.luko_cart_recoveries WHERE id=v_reply.recovery_id;
  UPDATE public.luko_cart_recovery_replies SET approved_by=p_actor_user_id,approved_at=now(),
    draft_status=CASE WHEN p_dry_run THEN draft_status ELSE 'SENDING' END,updated_at=now() WHERE id=p_reply_id;
  UPDATE public.luko_cart_recoveries SET reply_status=CASE WHEN p_dry_run THEN reply_status ELSE 'APPROVED' END,updated_at=now() WHERE id=v_reply.recovery_id;
  PERFORM public.append_luko_cart_recovery_timeline(v_reply.recovery_id,
    CASE WHEN p_dry_run THEN 'REPLY_APPROVED_DRY_RUN' ELSE 'REPLY_APPROVED' END,now(),jsonb_build_object('reply_id',p_reply_id),p_actor_user_id);
  RETURN jsonb_build_object('allowed',true,'dry_run',p_dry_run,'recovery_id',v_reply.recovery_id,
    'phone',v_phone,'draft_ciphertext',v_reply.draft_ciphertext);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_luko_cart_reply_send(p_reply_id uuid,p_message_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_recovery uuid;
BEGIN
  UPDATE public.luko_cart_recovery_replies SET draft_status='SENT',outbound_message_id=p_message_id,sent_at=now(),updated_at=now()
  WHERE id=p_reply_id AND draft_status='SENDING' AND nullif(p_message_id,'') IS NOT NULL RETURNING recovery_id INTO v_recovery;
  IF v_recovery IS NULL THEN RETURN false; END IF;
  UPDATE public.luko_cart_recoveries SET reply_status='SENT',updated_at=now() WHERE id=v_recovery;
  PERFORM public.append_luko_cart_recovery_timeline(v_recovery,'HUMAN_REPLY_SENT',now(),jsonb_build_object('reply_id',p_reply_id,'message_id',p_message_id),NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_reply_send_uncertain(p_reply_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  UPDATE public.luko_cart_recovery_replies SET draft_status='RECONCILIATION_REQUIRED',updated_at=now()
  WHERE id=p_reply_id AND draft_status='SENDING' RETURNING true;
$$;

CREATE OR REPLACE FUNCTION public.discard_luko_cart_reply_draft(p_reply_id uuid,p_actor_user_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_recovery uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'human_actor_required' USING ERRCODE='22023'; END IF;
  UPDATE public.luko_cart_recovery_replies SET draft_status='DISCARDED',edited_by=p_actor_user_id,updated_at=now()
  WHERE id=p_reply_id AND draft_status IN ('DRAFT_READY','EDITED') RETURNING recovery_id INTO v_recovery;
  IF v_recovery IS NULL THEN RETURN false; END IF;
  UPDATE public.luko_cart_recoveries SET reply_status='DISCARDED',updated_at=now() WHERE id=v_recovery;
  PERFORM public.append_luko_cart_recovery_timeline(v_recovery,'AI_DRAFT_DISCARDED',now(),jsonb_build_object('reply_id',p_reply_id),p_actor_user_id);
  RETURN true;
END;
$$;

-- STOP/consent withdrawal is phone-scoped, not episode-scoped. Cancel every
-- future SMS atomically while retaining the journey. Customer push permission
-- is a separate grant and is deliberately left unchanged.
CREATE OR REPLACE FUNCTION public.cancel_luko_cart_recoveries_for_phone(
  p_workspace text,p_phone text,p_reason text,p_occurred_at timestamptz DEFAULT now()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row record; v_count integer:=0; v_reason text;
BEGIN
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'invalid_cart_recovery_phone' USING ERRCODE='22023';
  END IF;
  v_reason:=left(coalesce(nullif(p_reason,''),'consent_revoked'),80);
  FOR v_row IN
    UPDATE public.luko_cart_recoveries SET consent_granted=false,
      status=CASE WHEN status IN ('active','clicked','dry_run') THEN 'suppressed' ELSE status END,
      journey_status='BLOCKED',
      sms_status=CASE WHEN sent_at IS NULL THEN 'CANCELLED_UNSUBSCRIBED' ELSE sms_status END,
      cancellation_reason=v_reason,claim_token=NULL,claim_until=NULL,updated_at=now()
    WHERE workspace_id=p_workspace AND contact_phone=p_phone
      AND journey_status NOT IN ('CANCELLED_PURCHASED','CONVERTED')
    RETURNING id
  LOOP
    v_count:=v_count+1;
    PERFORM public.append_luko_cart_recovery_timeline(v_row.id,'SMS_CONSENT_REVOKED',
      coalesce(p_occurred_at,now()),jsonb_build_object('reason',v_reason),NULL);
  END LOOP;
  RETURN v_count;
END;
$$;

-- Claim intended customer pushes. The claimant must still call begin_luko_cart_push,
-- which fails closed when no real customer destination/permission exists.
CREATE OR REPLACE FUNCTION public.claim_luko_cart_pushes(p_workspace text,p_limit integer DEFAULT 20)
RETURNS SETOF public.luko_cart_recoveries LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT r.id FROM public.luko_cart_recoveries r
    JOIN public.luko_cart_recovery_settings s ON s.workspace_id=r.workspace_id
    WHERE r.workspace_id=p_workspace AND s.enabled AND s.push_enabled AND r.push_status='QUEUED'
      AND r.automated_push_count<1
      AND r.push_due_at<=now() AND r.order_id IS NULL
      AND r.journey_status NOT LIKE 'CANCELLED_%'
      AND (r.push_claim_until IS NULL OR r.push_claim_until<now())
    ORDER BY r.push_due_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT least(greatest(p_limit,1),100)
  ) UPDATE public.luko_cart_recoveries r SET push_claim_token=gen_random_uuid(),
    push_claim_until=now()+interval '2 minutes',updated_at=now() FROM due WHERE r.id=due.id RETURNING r.*;
END;
$$;

DROP FUNCTION IF EXISTS public.begin_luko_cart_push(uuid,uuid,boolean,text,text,text,text);
CREATE OR REPLACE FUNCTION public.begin_luko_cart_push(
  p_id uuid,p_claim uuid,p_dry_run boolean,p_discount_verified boolean,p_destination_type text,p_destination_url text,p_title text,p_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE; v_reason text; v_code text; v_percent numeric(5,2);
BEGIN
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL OR v.push_claim_token<>p_claim OR v.push_status<>'QUEUED' OR v.order_id IS NOT NULL THEN
    RETURN jsonb_build_object('allowed',false,'reason','state_changed');
  END IF;
  SELECT discount_code,discount_percent INTO v_code,v_percent
  FROM public.luko_cart_recovery_settings WHERE workspace_id=v.workspace_id;
  v_reason := CASE
    WHEN NOT coalesce(p_discount_verified,false) THEN 'coupon_not_verified'
    WHEN NOT p_dry_run AND (NOT v.customer_push_permission OR nullif(v.customer_push_destination_id,'') IS NULL) THEN 'customer_push_channel_unavailable'
    WHEN p_destination_type NOT IN ('exact_product','shop') OR p_destination_url !~ '^(https://|vici://)' THEN 'push_destination_unavailable'
    WHEN nullif(p_title,'') IS NULL OR nullif(p_body,'') IS NULL THEN 'push_copy_unavailable'
    ELSE NULL END;
  IF v_reason IS NOT NULL THEN
    UPDATE public.luko_cart_recoveries SET push_status='BLOCKED',push_coupon_block_reason=v_reason,
      push_destination_type=p_destination_type,push_destination_url=p_destination_url,push_title=p_title,push_body=p_body,
      push_claim_token=NULL,push_claim_until=NULL,push_proposed_at=now(),updated_at=now() WHERE id=p_id;
    PERFORM public.append_luko_cart_recovery_timeline(p_id,'PUSH_BLOCKED',now(),jsonb_build_object('reason',v_reason),NULL);
    RETURN jsonb_build_object('allowed',false,'reason',v_reason);
  END IF;
  UPDATE public.luko_cart_recoveries SET push_status='SENDING',push_destination_type=p_destination_type,
    push_destination_url=p_destination_url,push_title=p_title,push_body=p_body,push_discount_code=v_code,
    push_discount_percent=v_percent,push_coupon_verified_at=now(),push_coupon_block_reason=NULL,push_proposed_at=now(),updated_at=now()
  WHERE id=p_id;
  RETURN jsonb_build_object('allowed',true,'customer_push_destination_id',v.customer_push_destination_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_luko_cart_push_send(p_id uuid,p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL OR v.push_claim_token<>p_claim OR v.push_status<>'SENDING'
    OR v.order_id IS NOT NULL OR v.automated_push_count>=1
    OR v.journey_status IN ('CANCELLED_PURCHASED','CONVERTED') THEN
    RETURN jsonb_build_object('allowed',false,'reason','state_changed');
  END IF;
  IF NOT v.customer_push_permission OR nullif(v.customer_push_destination_id,'') IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'reason','customer_push_channel_unavailable');
  END IF;
  RETURN jsonb_build_object('allowed',true,'customer_push_destination_id',v.customer_push_destination_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_luko_cart_push(p_id uuid,p_claim uuid,p_provider_message_id text,p_dry_run boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean;
BEGIN
  UPDATE public.luko_cart_recoveries SET push_status=CASE WHEN p_dry_run THEN 'DRY_RUN' ELSE 'SENT' END,
    push_provider_message_id=CASE WHEN p_dry_run THEN NULL ELSE p_provider_message_id END,
    push_sent_at=CASE WHEN p_dry_run THEN NULL ELSE now() END,
    automated_push_count=automated_push_count+CASE WHEN p_dry_run THEN 0 ELSE 1 END,
    push_claim_token=NULL,push_claim_until=NULL,updated_at=now()
  WHERE id=p_id AND push_claim_token=p_claim AND push_status='SENDING'
    AND (p_dry_run OR nullif(p_provider_message_id,'') IS NOT NULL) RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) THEN PERFORM public.append_luko_cart_recovery_timeline(p_id,
    CASE WHEN p_dry_run THEN 'PUSH_DRY_RUN' ELSE 'PUSH_SENT' END,now(),'{}'::jsonb,NULL); END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_push_blocked(p_id uuid,p_claim uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean; v_reason text;
BEGIN
  v_reason:=CASE WHEN p_reason IN ('wordpress_preflight_failed','customer_push_channel_unavailable',
    'final_wordpress_preflight_failed','coupon_not_verified','coupon_not_applicable','coupon_unavailable',
    'coupon_code_mismatch','coupon_terms_mismatch','coupon_expired','coupon_minimum_not_met','coupon_maximum_exceeded',
    'coupon_usage_exhausted','coupon_email_restricted','coupon_customer_email_missing','coupon_customer_usage_unverified',
    'coupon_customer_identity_missing','coupon_customer_usage_exhausted','coupon_conflicts_with_cart','cart_product_excluded',
    'cart_category_excluded','cart_product_not_included','cart_category_not_included','sale_item_excluded','cart_items_missing',
    'product_unavailable','push_destination_unavailable','push_tracking_unavailable','push_copy_unavailable',
    'notifications_disabled','customer_push_sender_unavailable','state_changed') THEN p_reason ELSE 'eligibility_failed' END;
  UPDATE public.luko_cart_recoveries SET push_status='BLOCKED',push_coupon_block_reason=v_reason,
    push_claim_token=NULL,push_claim_until=NULL,push_proposed_at=coalesce(push_proposed_at,now()),updated_at=now()
  WHERE id=p_id AND push_claim_token=p_claim AND push_status IN ('QUEUED','SENDING') RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) THEN PERFORM public.append_luko_cart_recovery_timeline(
    p_id,'PUSH_BLOCKED',now(),jsonb_build_object('reason',v_reason),NULL); END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_push_send_uncertain(p_id uuid,p_claim uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean;
BEGIN
  UPDATE public.luko_cart_recoveries SET push_status='RECONCILIATION_REQUIRED',
    push_coupon_block_reason='provider_result_uncertain',push_claim_token=NULL,push_claim_until=NULL,updated_at=now()
  WHERE id=p_id AND push_claim_token=p_claim AND push_status='SENDING' AND push_provider_message_id IS NULL
  RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) THEN PERFORM public.append_luko_cart_recovery_timeline(
    p_id,'PUSH_RECONCILIATION_REQUIRED',now(),jsonb_build_object('reason','provider_result_uncertain'),NULL); END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_push_delivery(p_provider_message_id text,p_status text,p_occurred_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_event text;
BEGIN
  IF p_status NOT IN ('delivered','clicked','failed') THEN RETURN false; END IF;
  UPDATE public.luko_cart_recoveries SET push_status=upper(p_status),
    push_delivered_at=CASE WHEN p_status='delivered' THEN coalesce(push_delivered_at,p_occurred_at) ELSE push_delivered_at END,
    push_clicked_at=CASE WHEN p_status='clicked' THEN coalesce(push_clicked_at,p_occurred_at) ELSE push_clicked_at END,
    updated_at=now() WHERE push_provider_message_id=p_provider_message_id AND push_status IN ('SENT','DELIVERED') RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  v_event := 'PUSH_'||upper(p_status);
  PERFORM public.append_luko_cart_recovery_timeline(v_id,v_event,p_occurred_at,'{}'::jsonb,NULL);
  RETURN true;
END;
$$;

-- Replace the event reducer to preserve the v1 semantics while adding Growth
-- state, richer customer/product context, a 45-minute delay, and cancellation.
CREATE OR REPLACE FUNCTION public.apply_luko_cart_event(p_event jsonb,p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_workspace text:=p_event->>'workspace_id'; v_event_id text:=p_event->>'event_id';
  v_type text:=p_event->>'event_type'; v_cart text:=nullif(p_event->>'external_cart_id','');
  v_existing_digest text; v_phone text:=nullif(p_event->>'phone',''); v_customer text:=nullif(p_event->>'customer_id','');
  v_email text:=nullif(p_event->>'customer_email',''); v_first_name text:=nullif(p_event->>'customer_first_name','');
  v_market text:=upper(coalesce(nullif(p_event->>'customer_market',''),'US'));
  v_push_permission boolean:=coalesce((p_event->>'push_permission')::boolean,false);
  v_sms_delay integer:=45; v_push_delay integer:=48;
  v_occurred timestamptz:=(p_event->>'occurred_at')::timestamptz;
  v_version bigint:=coalesce((p_event->>'version')::bigint,0);
  v_granted boolean:=coalesce((p_event#>>'{consent,granted}')::boolean,false);
  v_identity uuid:=nullif(p_event->>'customer_identity_id','')::uuid;
  v_identity_ambiguous boolean:=coalesce((p_event->>'identity_resolution_ambiguous')::boolean,false);
  v_recovery_id uuid; v_primary text; v_count integer;
BEGIN
  SELECT first_sms_delay_minutes,push_delay_hours INTO v_sms_delay,v_push_delay
  FROM public.luko_cart_recovery_settings WHERE workspace_id=v_workspace;
  v_sms_delay:=coalesce(v_sms_delay,45); v_push_delay:=coalesce(v_push_delay,48);
  INSERT INTO public.luko_cart_connector_events(workspace_id,event_id,event_type,external_cart_id,body_digest,occurred_at)
  VALUES(v_workspace,v_event_id,v_type,v_cart,p_digest,v_occurred) ON CONFLICT(workspace_id,event_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT body_digest INTO v_existing_digest FROM public.luko_cart_connector_events WHERE workspace_id=v_workspace AND event_id=v_event_id;
    IF v_existing_digest<>p_digest THEN RAISE EXCEPTION 'connector_event_id_reused' USING ERRCODE='P0001'; END IF;
    RETURN jsonb_build_object('accepted',true,'duplicate',true);
  END IF;

  IF v_type='consent.updated' THEN
    IF v_phone IS NOT NULL THEN
      INSERT INTO public.sms_consent_events(workspace_id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,occurred_at,metadata,dedupe_key)
      VALUES(v_workspace,v_phone,CASE WHEN v_granted THEN 'opt_in' ELSE 'opt_out' END,'promotional_sms',v_workspace,
        coalesce(nullif(p_event#>>'{consent,source}',''),'vici_registration'),CASE WHEN v_granted THEN 'wordpress-event:'||v_event_id ELSE NULL END,
        coalesce((p_event#>>'{consent,occurred_at}')::timestamptz,v_occurred),jsonb_build_object(
          'disclosure_version',p_event#>>'{consent,version}','source_url',p_event#>>'{consent,source_url}',
          'privacy_url',p_event#>>'{consent,privacy_url}','terms_url',p_event#>>'{consent,terms_url}',
          'ip_hash',p_event#>>'{consent,ip_hash}','user_agent_hash',p_event#>>'{consent,user_agent_hash}',
          'disclosure_sha256',encode(digest(coalesce(p_event#>>'{consent,disclosure}',''),'sha256'),'hex')),'wordpress:'||v_event_id)
      ON CONFLICT(workspace_id,dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      UPDATE public.luko_cart_recoveries SET consent_granted=v_granted,
        consent_occurred_at=coalesce((p_event#>>'{consent,occurred_at}')::timestamptz,v_occurred),
        status=CASE WHEN NOT v_granted AND status IN ('active','clicked') THEN 'suppressed'
          WHEN v_granted AND status='suppressed' AND order_id IS NULL AND recovery_expires_at>now() THEN 'active' ELSE status END,
        journey_status=CASE WHEN NOT v_granted AND order_id IS NULL THEN 'BLOCKED'
          WHEN v_granted AND journey_status='BLOCKED' AND order_id IS NULL AND recovery_expires_at>now() THEN 'QUEUED'
          ELSE journey_status END,
        sms_status=CASE WHEN NOT v_granted AND sent_at IS NULL THEN 'CANCELLED_UNSUBSCRIBED'
          WHEN v_granted AND sms_status IN ('BLOCKED','CANCELLED_UNSUBSCRIBED') AND sent_at IS NULL AND order_id IS NULL AND recovery_expires_at>now() THEN 'QUEUED'
          ELSE sms_status END,
        cancellation_reason=CASE WHEN NOT v_granted THEN 'sms_consent_revoked' ELSE cancellation_reason END,updated_at=now()
      WHERE workspace_id=v_workspace AND wordpress_user_id=v_customer AND status NOT IN ('ordered','paid','recovered');
    END IF;
    RETURN jsonb_build_object('accepted',true,'duplicate',false,'event_type',v_type);
  END IF;

  SELECT nullif(coalesce(p_event#>>'{items,0,product_name}',p_event#>>'{items,0,name}'),'') INTO v_primary;
  v_count:=coalesce(jsonb_array_length(coalesce(p_event->'items','[]'::jsonb)),0);
  IF v_type='cart.updated' THEN
    INSERT INTO public.luko_cart_recoveries(workspace_id,external_cart_id,customer_identity_id,identity_resolution_ambiguous,wordpress_user_id,contact_phone,customer_email,customer_first_name,customer_market,
      consent_granted,consent_occurred_at,event_version,cart_items,cart_applied_coupons,primary_product_name,item_count,currency,cart_total,recovery_ciphertext,
      recovery_expires_at,status,last_activity_at,due_at,dry_run,journey_status,sms_status,push_due_at,push_status,customer_push_permission)
    VALUES(v_workspace,v_cart,v_identity,v_identity_ambiguous,v_customer,v_phone,v_email,v_first_name,v_market,v_granted,nullif(p_event#>>'{consent,occurred_at}','')::timestamptz,
      v_version,coalesce(p_event->'items','[]'::jsonb),coalesce(p_event->'applied_coupons','[]'::jsonb),v_primary,v_count,p_event->>'currency',(p_event->>'total')::numeric,
      p_event->>'recovery_ciphertext',(p_event->>'expires_at')::timestamptz,CASE WHEN v_granted THEN 'active' ELSE 'suppressed' END,
      (p_event->>'last_activity_at')::timestamptz,(p_event->>'last_activity_at')::timestamptz+make_interval(mins=>v_sms_delay),true,
      CASE WHEN v_granted THEN 'QUEUED' ELSE 'BLOCKED' END,CASE WHEN v_granted THEN 'QUEUED' ELSE 'BLOCKED' END,
      (p_event->>'last_activity_at')::timestamptz+make_interval(hours=>v_push_delay),'QUEUED',v_push_permission)
    ON CONFLICT(workspace_id,external_cart_id) DO UPDATE SET customer_identity_id=EXCLUDED.customer_identity_id,
      identity_resolution_ambiguous=EXCLUDED.identity_resolution_ambiguous,wordpress_user_id=EXCLUDED.wordpress_user_id,
      contact_phone=EXCLUDED.contact_phone,customer_email=EXCLUDED.customer_email,customer_first_name=EXCLUDED.customer_first_name,
      customer_market=EXCLUDED.customer_market,
      consent_granted=EXCLUDED.consent_granted,consent_occurred_at=EXCLUDED.consent_occurred_at,event_version=EXCLUDED.event_version,
      cart_items=EXCLUDED.cart_items,cart_applied_coupons=EXCLUDED.cart_applied_coupons,primary_product_name=EXCLUDED.primary_product_name,item_count=EXCLUDED.item_count,
      currency=EXCLUDED.currency,cart_total=EXCLUDED.cart_total,recovery_ciphertext=EXCLUDED.recovery_ciphertext,
      recovery_expires_at=EXCLUDED.recovery_expires_at,status=EXCLUDED.status,last_activity_at=EXCLUDED.last_activity_at,due_at=EXCLUDED.due_at,
      journey_status=EXCLUDED.journey_status,sms_status=EXCLUDED.sms_status,
      push_due_at=CASE WHEN public.luko_cart_recoveries.automated_push_count=0 THEN EXCLUDED.push_due_at ELSE public.luko_cart_recoveries.push_due_at END,
      push_status=CASE WHEN public.luko_cart_recoveries.automated_push_count=0 THEN 'QUEUED' ELSE public.luko_cart_recoveries.push_status END,
      customer_push_permission=EXCLUDED.customer_push_permission,
      push_claim_token=NULL,push_claim_until=NULL,
      push_coupon_block_reason=CASE WHEN public.luko_cart_recoveries.automated_push_count=0 THEN NULL ELSE public.luko_cart_recoveries.push_coupon_block_reason END,
      cancellation_reason=NULL,
      claim_token=NULL,claim_until=NULL,proposed_at=NULL,send_started_at=NULL,message_ciphertext=NULL,dry_run=true,last_failure_code=NULL,updated_at=now()
    WHERE EXCLUDED.event_version>public.luko_cart_recoveries.event_version
      AND public.luko_cart_recoveries.status NOT IN ('ordered','paid','recovered','sending','sent','delivered','failed','reconciliation_required')
    RETURNING id INTO v_recovery_id;
    IF v_recovery_id IS NOT NULL THEN PERFORM public.append_luko_cart_recovery_timeline(v_recovery_id,'CART_UPDATED',v_occurred,
      jsonb_build_object('item_count',v_count,'currency',p_event->>'currency','cart_total',p_event->>'total'),NULL); END IF;
  ELSIF v_type IN ('cart.emptied','cart.clicked') THEN
    UPDATE public.luko_cart_recoveries SET event_version=greatest(event_version,v_version),
      status=CASE WHEN v_type='cart.emptied' THEN 'emptied' WHEN status IN ('active','sent','delivered') THEN 'clicked' ELSE status END,
      clicked_at=CASE WHEN v_type='cart.clicked' AND coalesce(p_event->>'click_channel','sms')<>'push' THEN coalesce(clicked_at,v_occurred) ELSE clicked_at END,
      push_clicked_at=CASE WHEN v_type='cart.clicked' AND p_event->>'click_channel'='push' THEN coalesce(push_clicked_at,v_occurred) ELSE push_clicked_at END,
      journey_status=CASE WHEN v_type='cart.emptied' THEN 'CANCELLED_CART_CHANGED' ELSE 'CLICKED' END,
      sms_status=CASE WHEN v_type='cart.emptied' AND sent_at IS NULL THEN 'CANCELLED_CART_CHANGED'
        WHEN v_type='cart.clicked' AND coalesce(p_event->>'click_channel','sms')<>'push' THEN 'CLICKED' ELSE sms_status END,
      push_status=CASE WHEN v_type='cart.emptied' AND push_sent_at IS NULL THEN 'CANCELLED_CART_CHANGED'
        WHEN v_type='cart.clicked' AND p_event->>'click_channel'='push' THEN 'CLICKED' ELSE push_status END,
      cancellation_reason=CASE WHEN v_type='cart.emptied' THEN 'cart_emptied' ELSE cancellation_reason END,
      claim_token=NULL,claim_until=NULL,push_claim_token=NULL,push_claim_until=NULL,updated_at=now()
    WHERE workspace_id=v_workspace AND external_cart_id=v_cart AND v_version>=event_version AND status NOT IN ('ordered','paid','recovered') RETURNING id INTO v_recovery_id;
    IF v_recovery_id IS NOT NULL THEN PERFORM public.append_luko_cart_recovery_timeline(v_recovery_id,
      CASE WHEN v_type='cart.emptied' THEN 'CART_EMPTIED' ELSE 'RECOVERY_LINK_CLICKED' END,v_occurred,
      jsonb_build_object('channel',coalesce(p_event->>'click_channel','sms')),NULL); END IF;
  ELSIF v_type='order.created' THEN
    INSERT INTO public.luko_cart_recoveries(workspace_id,external_cart_id,wordpress_user_id,event_version,status,last_activity_at,due_at,
      order_id,order_status,order_total,order_currency,order_created_at,attribution_valid,journey_status,sms_status,push_status,cancellation_reason)
    VALUES(v_workspace,v_cart,v_customer,v_version,'ordered',v_occurred,v_occurred,p_event#>>'{order,order_id}',p_event#>>'{order,status}',
      (p_event#>>'{order,total}')::numeric,p_event#>>'{order,currency}',v_occurred,coalesce((p_event#>>'{order,attribution_valid}')::boolean,false),
      'CANCELLED_PURCHASED','CANCELLED_PURCHASED','CANCELLED_PURCHASED','order_created')
    ON CONFLICT(workspace_id,external_cart_id) DO UPDATE SET status='ordered',order_id=EXCLUDED.order_id,order_status=EXCLUDED.order_status,
      order_total=EXCLUDED.order_total,order_currency=EXCLUDED.order_currency,
      order_created_at=least(coalesce(public.luko_cart_recoveries.order_created_at,EXCLUDED.order_created_at),EXCLUDED.order_created_at),
      attribution_valid=EXCLUDED.attribution_valid,journey_status='CANCELLED_PURCHASED',
      sms_status=CASE WHEN public.luko_cart_recoveries.sent_at IS NULL THEN 'CANCELLED_PURCHASED' ELSE public.luko_cart_recoveries.sms_status END,
      push_status=CASE WHEN public.luko_cart_recoveries.push_sent_at IS NULL THEN 'CANCELLED_PURCHASED' ELSE public.luko_cart_recoveries.push_status END,
      cancellation_reason='order_created',claim_token=NULL,claim_until=NULL,push_claim_token=NULL,push_claim_until=NULL,updated_at=now()
    RETURNING id INTO v_recovery_id;
    PERFORM public.append_luko_cart_recovery_timeline(v_recovery_id,'ORDER_CREATED',v_occurred,jsonb_build_object('order_id',p_event#>>'{order,order_id}'),NULL);
  ELSIF v_type='order.paid' THEN
    UPDATE public.luko_cart_recoveries SET status=CASE WHEN coalesce((p_event#>>'{order,attribution_valid}')::boolean,false) AND (
      (dry_run=false AND delivered_at IS NOT NULL AND clicked_at IS NOT NULL
        AND (p_event#>>'{order,paid_at}')::timestamptz BETWEEN clicked_at AND clicked_at+interval '24 hours')
      OR (push_sent_at IS NOT NULL AND push_clicked_at IS NOT NULL
        AND (p_event#>>'{order,paid_at}')::timestamptz BETWEEN push_clicked_at AND push_clicked_at+interval '24 hours'))
      THEN 'recovered' ELSE 'paid' END,order_id=p_event#>>'{order,order_id}',order_status=p_event#>>'{order,status}',
      order_total=(p_event#>>'{order,total}')::numeric,order_currency=p_event#>>'{order,currency}',order_paid_at=(p_event#>>'{order,paid_at}')::timestamptz,
      attribution_valid=coalesce((p_event#>>'{order,attribution_valid}')::boolean,false),
      journey_status=CASE WHEN coalesce((p_event#>>'{order,attribution_valid}')::boolean,false) AND (
        (dry_run=false AND delivered_at IS NOT NULL AND clicked_at IS NOT NULL
          AND (p_event#>>'{order,paid_at}')::timestamptz BETWEEN clicked_at AND clicked_at+interval '24 hours')
        OR (push_sent_at IS NOT NULL AND push_clicked_at IS NOT NULL
          AND (p_event#>>'{order,paid_at}')::timestamptz BETWEEN push_clicked_at AND push_clicked_at+interval '24 hours'))
        THEN 'CONVERTED' ELSE 'CANCELLED_PURCHASED' END,
      push_status=CASE WHEN push_sent_at IS NULL THEN 'CANCELLED_PURCHASED' ELSE push_status END,cancellation_reason='order_paid',
      claim_token=NULL,claim_until=NULL,push_claim_token=NULL,push_claim_until=NULL,updated_at=now()
    WHERE workspace_id=v_workspace AND external_cart_id=v_cart RETURNING id INTO v_recovery_id;
    IF v_recovery_id IS NOT NULL THEN PERFORM public.append_luko_cart_recovery_timeline(v_recovery_id,'PAYMENT_COMPLETED',
      (p_event#>>'{order,paid_at}')::timestamptz,jsonb_build_object('order_id',p_event#>>'{order,order_id}',
        'currency',p_event#>>'{order,currency}','order_total',p_event#>>'{order,total}'),NULL); END IF;
  END IF;
  RETURN jsonb_build_object('accepted',true,'duplicate',false,'event_type',v_type,'external_cart_id',v_cart);
END;
$$;

-- Permanent eligibility failures are visible BLOCKED journeys, not an
-- invisible five-minute retry loop. Transient WordPress/preflight failures
-- retain the bounded retry behavior from v1.
CREATE OR REPLACE FUNCTION public.defer_luko_cart_recovery(p_id uuid,p_claim uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_block boolean; v_ok boolean;
BEGIN
  v_block:=p_reason IN ('invalid_phone','consent_not_recorded','opted_out','dnd','dnd_unknown',
    'internal_or_test_identity','authoritative_suppression','customer_contact_missing');
  UPDATE public.luko_cart_recoveries SET
    status=CASE WHEN v_block THEN 'suppressed' ELSE status END,
    journey_status=CASE WHEN v_block THEN 'BLOCKED' ELSE journey_status END,
    sms_status=CASE WHEN v_block THEN 'BLOCKED' ELSE sms_status END,
    claim_token=NULL,claim_until=NULL,
    due_at=CASE WHEN v_block THEN due_at ELSE greatest(due_at,now()+interval '5 minutes') END,
    last_failure_code=left(coalesce(p_reason,'eligibility_failed'),80),updated_at=now()
  WHERE id=p_id AND claim_token=p_claim AND status='active' RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) AND v_block THEN
    PERFORM public.append_luko_cart_recovery_timeline(p_id,'SMS_BLOCKED',now(),
      jsonb_build_object('reason',coalesce(p_reason,'eligibility_failed')),NULL);
  END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

-- Keep legacy status and Growth status in sync at the provider boundary.
CREATE OR REPLACE FUNCTION public.begin_luko_cart_recovery(
  p_id uuid,p_claim uuid,p_version bigint,p_dry_run boolean,p_live_allowed boolean,p_message_ciphertext text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.luko_cart_recoveries%ROWTYPE; v_policy jsonb; v_policy_value text; v_max_sms integer:=1;
BEGIN
  SELECT * INTO v FROM public.luko_cart_recoveries WHERE id=p_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','state_changed'); END IF;
  SELECT market_policy INTO v_policy FROM public.luko_cart_recovery_settings WHERE workspace_id=v.workspace_id;
  v_policy_value:=v_policy#>>ARRAY[v.customer_market,'max_automated_cart_sms_per_event'];
  IF coalesce(v_policy_value,'') ~ '^[0-9]+$' THEN v_max_sms:=greatest(v_policy_value::integer,0); END IF;
  IF v.claim_token<>p_claim OR v.event_version<>p_version OR v.status<>'active' OR NOT v.consent_granted
     OR v.order_id IS NOT NULL OR v.recovery_expires_at<=now() OR v.automated_sms_count>=v_max_sms THEN
    RETURN jsonb_build_object('allowed',false,'reason','state_changed');
  END IF;
  IF p_dry_run OR NOT p_live_allowed THEN
    UPDATE public.luko_cart_recoveries SET status='dry_run',sms_status='DRY_RUN',journey_status='ELIGIBLE',dry_run=true,
      proposed_at=now(),message_ciphertext=p_message_ciphertext,claim_token=NULL,claim_until=NULL,updated_at=now() WHERE id=p_id;
    PERFORM public.append_luko_cart_recovery_timeline(p_id,'SMS_DRY_RUN',now(),'{}'::jsonb,NULL);
    RETURN jsonb_build_object('allowed',true,'dry_run',true);
  END IF;
  UPDATE public.luko_cart_recoveries SET status='sending',sms_status='SENDING',journey_status='ELIGIBLE',dry_run=false,
    proposed_at=now(),send_started_at=now(),send_attempts=send_attempts+1,message_ciphertext=p_message_ciphertext,updated_at=now() WHERE id=p_id;
  RETURN jsonb_build_object('allowed',true,'dry_run',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_luko_cart_recovery(p_id uuid,p_claim uuid,p_message_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ok boolean;
BEGIN
  UPDATE public.luko_cart_recoveries SET status=CASE WHEN status='sending' THEN 'sent' ELSE status END,
    sms_status=CASE WHEN status IN ('ordered','paid','recovered') THEN sms_status ELSE 'SENT' END,
    journey_status=CASE WHEN status='recovered' THEN 'CONVERTED' WHEN status IN ('ordered','paid') THEN 'CANCELLED_PURCHASED' ELSE 'SENT' END,
    telnyx_message_id=p_message_id,sent_at=now(),automated_sms_count=automated_sms_count+1,
    claim_token=NULL,claim_until=NULL,updated_at=now() WHERE id=p_id AND send_started_at IS NOT NULL AND telnyx_message_id IS NULL
    AND ((status='sending' AND claim_token=p_claim) OR status IN ('ordered','paid')) RETURNING true INTO v_ok;
  IF coalesce(v_ok,false) THEN PERFORM public.append_luko_cart_recovery_timeline(p_id,'SMS_SENT',now(),jsonb_build_object('message_id',p_message_id),NULL); END IF;
  RETURN coalesce(v_ok,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_luko_cart_delivery(p_message_id text,p_status text,p_occurred_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_sms text;
BEGIN
  UPDATE public.luko_cart_recoveries SET status=CASE
      WHEN p_status='delivered' AND status IN ('paid','ordered') AND clicked_at IS NOT NULL AND attribution_valid AND order_paid_at IS NOT NULL AND order_paid_at<=clicked_at+interval '24 hours' THEN 'recovered'
      WHEN p_status='delivered' AND status IN ('sent','sending') THEN 'delivered'
      WHEN p_status='failed' AND status IN ('sent','sending') THEN 'failed' ELSE status END,
    sms_status=CASE WHEN p_status='delivered' THEN 'DELIVERED' WHEN p_status='failed' THEN 'FAILED' ELSE sms_status END,
    journey_status=CASE
      WHEN status IN ('ordered','paid') AND p_status='delivered' AND clicked_at IS NOT NULL AND attribution_valid
        AND order_paid_at IS NOT NULL AND order_paid_at<=clicked_at+interval '24 hours' THEN 'CONVERTED'
      WHEN status IN ('ordered','paid','recovered') THEN journey_status
      WHEN p_status='delivered' THEN 'DELIVERED' WHEN p_status='failed' THEN 'FAILED' ELSE journey_status END,
    delivered_at=CASE WHEN p_status='delivered' THEN coalesce(delivered_at,p_occurred_at) ELSE delivered_at END,
    last_failure_code=CASE WHEN p_status='failed' THEN 'provider_failed' ELSE last_failure_code END,updated_at=now()
  WHERE telnyx_message_id=p_message_id AND dry_run=false RETURNING id,sms_status INTO v_id,v_sms;
  IF v_id IS NULL THEN RETURN false; END IF;
  PERFORM public.append_luko_cart_recovery_timeline(v_id,CASE WHEN p_status='delivered' THEN 'SMS_DELIVERED' ELSE 'SMS_FAILED' END,
    p_occurred_at,jsonb_build_object('message_id',p_message_id),NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.luko_cart_recovery_metrics(p_workspace text DEFAULT 'vici')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'abandoned_carts_identified',count(*) FILTER(WHERE due_at<=now() AND status NOT IN('emptied','expired')),
    'sms_eligible',count(*) FILTER(WHERE consent_granted),'sms_scheduled',count(*) FILTER(WHERE status='active'),
    'dry_run_proposals',count(*) FILTER(WHERE status='dry_run'),'sms_sent',count(*) FILTER(WHERE dry_run=false AND sent_at IS NOT NULL),
    'sms_delivered',count(*) FILTER(WHERE dry_run=false AND delivered_at IS NOT NULL),'sms_clicked',count(*) FILTER(WHERE dry_run=false AND clicked_at IS NOT NULL),
    'customer_replies',count(*) FILTER(WHERE reply_status<>'NONE'),'ai_drafts',count(*) FILTER(WHERE reply_status IN('DRAFT_READY','APPROVED','SENT')),
    'push_scheduled',count(*) FILTER(WHERE push_status='QUEUED'),'push_blocked',count(*) FILTER(WHERE push_status='BLOCKED'),
    'push_sent',count(*) FILTER(WHERE push_sent_at IS NOT NULL),'push_clicked',count(*) FILTER(WHERE push_clicked_at IS NOT NULL),
    'recovered_orders',count(*) FILTER(WHERE status='recovered'),'recovered_revenue',coalesce(sum(order_total) FILTER(WHERE status='recovered'),0),
    'currency',coalesce(min(order_currency) FILTER(WHERE status='recovered'),'USD'),
    'top_abandonment_reasons',coalesce((SELECT jsonb_agg(x ORDER BY (x->>'count')::int DESC) FROM (
      SELECT jsonb_build_object('category',objection_category,'count',count(*)) x FROM public.luko_cart_recoveries r2
      WHERE r2.workspace_id=p_workspace AND objection_category<>'UNKNOWN' GROUP BY objection_category LIMIT 12) q),'[]'::jsonb)
  ) FROM public.luko_cart_recoveries WHERE workspace_id=p_workspace;
$$;

CREATE OR REPLACE VIEW public.luko_cart_recovery_journey_list WITH (security_invoker=true) AS
SELECT r.id,r.workspace_id,r.external_cart_id,r.wordpress_user_id,r.customer_email,r.customer_first_name,r.contact_phone,
  r.identity_resolution_ambiguous,
  r.consent_granted,r.customer_push_permission,
  r.primary_product_name,r.item_count,r.cart_items,r.currency,r.cart_total,r.last_activity_at,r.due_at,r.journey_status,
  r.sms_status,r.reply_status,r.objection_category,r.objection_secondary_category,r.objection_confidence,r.objection_summary,
  r.push_due_at,r.push_status,r.push_destination_type,r.push_destination_url,r.push_coupon_verified_at,r.push_coupon_block_reason,
  r.order_id,r.order_status,r.order_total,r.order_currency,r.status AS attribution_status,r.created_at,r.updated_at
FROM public.luko_cart_recoveries r;

ALTER TABLE public.luko_cart_recovery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_cart_recovery_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_cart_recovery_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luko_customer_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luko_cart_recovery_settings,public.luko_cart_recovery_replies,public.luko_cart_recovery_timeline FROM public,anon,authenticated;
REVOKE ALL ON public.luko_customer_identities FROM public,anon,authenticated;
REVOKE ALL ON public.luko_cart_recovery_journey_list FROM public,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.luko_cart_recovery_settings,public.luko_cart_recovery_replies TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.luko_customer_identities TO service_role;
GRANT SELECT,INSERT ON public.luko_cart_recovery_timeline TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.luko_cart_recovery_timeline_id_seq TO service_role;
GRANT SELECT ON public.luko_cart_recovery_journey_list TO service_role;

REVOKE ALL ON FUNCTION public.append_luko_cart_recovery_timeline(uuid,text,timestamptz,jsonb,bigint),
  public.resolve_luko_cart_customer_identity(text,text,text,text),
  public.prevent_luko_cart_timeline_mutation(),public.luko_cart_objection_valid(text),public.attach_luko_cart_recovery_reply(text,text,text,timestamptz),
  public.set_luko_cart_reply_analysis(uuid,text,text,numeric,text,boolean,text),public.edit_luko_cart_reply_draft(uuid,text,bigint),
  public.begin_luko_cart_reply_send(uuid,bigint,boolean),public.finish_luko_cart_reply_send(uuid,text),
  public.mark_luko_cart_reply_send_uncertain(uuid),public.discard_luko_cart_reply_draft(uuid,bigint),
  public.cancel_luko_cart_recoveries_for_phone(text,text,text,timestamptz),
  public.claim_luko_cart_pushes(text,integer),public.begin_luko_cart_push(uuid,uuid,boolean,boolean,text,text,text,text),
  public.confirm_luko_cart_push_send(uuid,uuid),
  public.finish_luko_cart_push(uuid,uuid,text,boolean),public.mark_luko_cart_push_blocked(uuid,uuid,text),
  public.mark_luko_cart_push_send_uncertain(uuid,uuid),
  public.mark_luko_cart_push_delivery(text,text,timestamptz)
FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.append_luko_cart_recovery_timeline(uuid,text,timestamptz,jsonb,bigint),
  public.resolve_luko_cart_customer_identity(text,text,text,text),
  public.luko_cart_objection_valid(text),public.attach_luko_cart_recovery_reply(text,text,text,timestamptz),
  public.set_luko_cart_reply_analysis(uuid,text,text,numeric,text,boolean,text),public.edit_luko_cart_reply_draft(uuid,text,bigint),
  public.begin_luko_cart_reply_send(uuid,bigint,boolean),public.finish_luko_cart_reply_send(uuid,text),
  public.mark_luko_cart_reply_send_uncertain(uuid),public.discard_luko_cart_reply_draft(uuid,bigint),
  public.cancel_luko_cart_recoveries_for_phone(text,text,text,timestamptz),
  public.claim_luko_cart_pushes(text,integer),public.begin_luko_cart_push(uuid,uuid,boolean,boolean,text,text,text,text),
  public.confirm_luko_cart_push_send(uuid,uuid),
  public.finish_luko_cart_push(uuid,uuid,text,boolean),public.mark_luko_cart_push_blocked(uuid,uuid,text),
  public.mark_luko_cart_push_send_uncertain(uuid,uuid),
  public.mark_luko_cart_push_delivery(text,text,timestamptz)
TO service_role;

NOTIFY pgrst,'reload schema';

COMMIT;
