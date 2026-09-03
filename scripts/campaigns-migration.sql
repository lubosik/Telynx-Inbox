-- Vici Inbox — Campaign review, consent, durable-recipient queue and product events.
--
-- ADDITIVE / REPEATABLE
--   This migration creates campaign-owned tables, indexes and backend-only
--   RPCs. It neither sends an SMS nor changes an existing message workflow.
--   Live campaign eligibility is inserted OFF and has to be enabled explicitly
--   in both this table and the backend environment after provider approval.
--
-- DEPLOY ORDER
--   Apply after scripts/rbac-migration.sql and scripts/audit-migration.sql,
--   before deploying routes/campaigns.js. The application validates policy
--   permission keys at startup.

BEGIN;

-- Campaign permissions. Support Agents can review campaign state; only
-- Owner/Admin/legacy can create, approve, schedule or cancel campaigns.
INSERT INTO sms_permissions (key, resource, action, description, is_destructive) VALUES
  ('campaigns.read',      'campaign', 'read',      'Read campaigns, review counts and recipient previews.', false),
  ('campaigns.manage',    'campaign', 'manage',    'Create and edit campaign drafts and submit them for review.', true),
  ('campaigns.approve',   'campaign', 'approve',   'Approve or reject a frozen campaign revision.', true),
  ('campaigns.launch',    'campaign', 'launch',    'Schedule an approved campaign for durable delivery.', true),
  ('campaigns.cancel',    'campaign', 'cancel',    'Cancel a campaign and every recipient that has not started sending.', true),
  ('campaigns.configure', 'campaign', 'configure', 'Change provider approval and live-send eligibility.', true)
ON CONFLICT (key) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  description = EXCLUDED.description,
  is_destructive = EXCLUDED.is_destructive;

INSERT INTO sms_role_permissions (role_key, permission_key)
SELECT role_key, permission_key
FROM (VALUES
  ('owner', 'campaigns.read'), ('owner', 'campaigns.manage'),
  ('owner', 'campaigns.approve'), ('owner', 'campaigns.launch'),
  ('owner', 'campaigns.cancel'), ('owner', 'campaigns.configure'),
  ('admin', 'campaigns.read'), ('admin', 'campaigns.manage'),
  ('admin', 'campaigns.approve'), ('admin', 'campaigns.launch'),
  ('admin', 'campaigns.cancel'),
  ('legacy', 'campaigns.read'), ('legacy', 'campaigns.manage'),
  ('legacy', 'campaigns.approve'), ('legacy', 'campaigns.launch'),
  ('legacy', 'campaigns.cancel'),
  ('agent', 'campaigns.read')
) AS grants(role_key, permission_key)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sms_campaign_settings (
  workspace_id               text PRIMARY KEY,
  drafts_enabled             boolean NOT NULL DEFAULT true,
  provider_approved          boolean NOT NULL DEFAULT false,
  live_send_enabled          boolean NOT NULL DEFAULT false,
  consent_evidence_required  boolean NOT NULL DEFAULT true,
  business_timezone          text NOT NULL DEFAULT 'America/New_York',
  quiet_hours_start          time NOT NULL DEFAULT '20:00',
  quiet_hours_end            time NOT NULL DEFAULT '09:00',
  minimum_promotional_spacing_hours integer NOT NULL DEFAULT 24 CHECK (minimum_promotional_spacing_hours BETWEEN 0 AND 720),
  max_promotional_per_7_days integer NOT NULL DEFAULT 2 CHECK (max_promotional_per_7_days BETWEEN 1 AND 100),
  max_recipients_per_campaign integer NOT NULL DEFAULT 10000 CHECK (max_recipients_per_campaign BETWEEN 1 AND 100000),
  max_promotional_per_30_days integer NOT NULL DEFAULT 4 CHECK (max_promotional_per_30_days BETWEEN 1 AND 100),
  dnd_status_max_age_hours    integer NOT NULL DEFAULT 24,
  provider_approval_reference text,
  provider_approved_at       timestamptz,
  provider_approved_by       bigint REFERENCES sms_users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaign_dnd_age_check CHECK (dnd_status_max_age_hours BETWEEN 1 AND 168),
  CONSTRAINT sms_campaign_live_requires_provider_approval
    CHECK (NOT live_send_enabled OR provider_approved),
  CONSTRAINT sms_campaign_provider_approval_has_evidence CHECK (
    NOT provider_approved OR (
      char_length(trim(coalesce(provider_approval_reference, ''))) > 0
      AND provider_approved_at IS NOT NULL
      AND provider_approved_by IS NOT NULL
    )
  )
);

INSERT INTO sms_campaign_settings (workspace_id)
VALUES ('vici')
ON CONFLICT (workspace_id) DO NOTHING;

-- Some installations predate scripts/add-optout-column.sql. Campaign claim
-- safety must not depend on that optional migration having been run.
ALTER TABLE sms_contacts ADD COLUMN IF NOT EXISTS opted_out boolean DEFAULT false;
ALTER TABLE sms_contacts
  ADD COLUMN IF NOT EXISTS ghl_dnd boolean,
  ADD COLUMN IF NOT EXISTS ghl_sms_dnd_status text,
  ADD COLUMN IF NOT EXISTS ghl_dnd_synced_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_contacts'::regclass
      AND conname = 'sms_contacts_ghl_sms_dnd_status_check'
  ) THEN
    ALTER TABLE public.sms_contacts
      ADD CONSTRAINT sms_contacts_ghl_sms_dnd_status_check
      CHECK (ghl_sms_dnd_status IS NULL OR ghl_sms_dnd_status IN ('active', 'inactive', 'permanent'));
  END IF;
END
$$;

-- Positive consent is evidence, not an assumption. No existing contact is
-- backfilled as opted in by this migration. A latest opt-out always wins.
CREATE TABLE IF NOT EXISTS sms_consent_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    text NOT NULL DEFAULT 'vici',
  contact_phone   text NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('opt_in', 'opt_out')),
  purpose         text NOT NULL DEFAULT 'promotional_sms' CHECK (purpose = 'promotional_sms'),
  brand_id        text NOT NULL DEFAULT 'vici',
  source          text NOT NULL,
  evidence_ref    text,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by     bigint REFERENCES sms_users(id),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  CONSTRAINT sms_consent_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT sms_consent_source_present CHECK (char_length(trim(source)) > 0),
  CONSTRAINT sms_promotional_opt_in_has_evidence CHECK (
    event_type <> 'opt_in' OR char_length(trim(coalesce(evidence_ref, ''))) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_consent_events_dedupe_idx
  ON sms_consent_events (workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_consent_events_contact_time_idx
  ON sms_consent_events (workspace_id, contact_phone, occurred_at DESC, id DESC);

-- Authoritative delivery suppressions. Internal/test identities belong here,
-- not in application environment variables: every claimant and provider
-- boundary reads the same durable source of truth. This migration deliberately
-- seeds no phone numbers.
CREATE TABLE IF NOT EXISTS sms_campaign_suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    text NOT NULL DEFAULT 'vici',
  contact_phone   text NOT NULL,
  reason_code     text NOT NULL CHECK (reason_code IN (
    'internal_identity', 'test_identity', 'manual_block', 'compliance_hold'
  )),
  source          text NOT NULL,
  evidence_ref    text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  effective_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  created_by      bigint REFERENCES sms_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaign_suppression_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT sms_campaign_suppression_source_present CHECK (char_length(trim(source)) > 0),
  CONSTRAINT sms_campaign_suppression_evidence_present CHECK (char_length(trim(evidence_ref)) > 0),
  CONSTRAINT sms_campaign_suppression_window_valid CHECK (expires_at IS NULL OR expires_at > effective_at),
  UNIQUE (workspace_id, contact_phone, reason_code, evidence_ref)
);

CREATE INDEX IF NOT EXISTS sms_campaign_suppressions_active_phone_idx
  ON sms_campaign_suppressions (workspace_id, contact_phone, effective_at, expires_at)
  WHERE active = true;

-- Explicit, fresh commercial-support state used by opportunity detection.
-- Absence is unknown (and therefore detector-suppressing), never inferred as
-- "clear" from a quiet inbox. A trusted CRM/support synchronizer must provide
-- both source and evidence before a promotional detector can use the row.
CREATE TABLE IF NOT EXISTS sms_customer_commercial_eligibility (
  workspace_id  text NOT NULL DEFAULT 'vici',
  contact_phone text NOT NULL,
  status        text NOT NULL CHECK (status IN (
    'clear', 'unresolved_problem', 'refund_open', 'negative_support_review'
  )),
  source        text NOT NULL,
  evidence_ref  text NOT NULL,
  observed_at   timestamptz NOT NULL,
  expires_at    timestamptz,
  updated_by    bigint REFERENCES sms_users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, contact_phone),
  CONSTRAINT sms_customer_commercial_eligibility_phone_e164
    CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT sms_customer_commercial_eligibility_source_present
    CHECK (char_length(trim(source)) > 0),
  CONSTRAINT sms_customer_commercial_eligibility_evidence_present
    CHECK (char_length(trim(evidence_ref)) > 0),
  CONSTRAINT sms_customer_commercial_eligibility_window_valid
    CHECK (expires_at IS NULL OR expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS sms_customer_commercial_eligibility_status_idx
  ON sms_customer_commercial_eligibility (workspace_id, status, observed_at DESC);

CREATE TABLE IF NOT EXISTS sms_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          text NOT NULL DEFAULT 'vici',
  campaign_type         text NOT NULL DEFAULT 'manual',
  workflow_category     text NOT NULL DEFAULT 'manual',
  title                 text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'review_required', 'approval_pending', 'approved', 'scheduled',
    'sending', 'completed', 'rejected', 'cancelled', 'failed'
  )),
  audience_definition   jsonb NOT NULL DEFAULT '{}'::jsonb,
  preparation_key       text,
  proposed_message      text NOT NULL CHECK (char_length(proposed_message) BETWEEN 1 AND 1600),
  final_message         text,
  revision              integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by            bigint REFERENCES sms_users(id),
  updated_by            bigint REFERENCES sms_users(id),
  submitted_for_review_at timestamptz,
  submitted_by          bigint REFERENCES sms_users(id),
  approved_at           timestamptz,
  approved_by           bigint REFERENCES sms_users(id),
  approval_audit_recorded_at timestamptz,
  rejected_at           timestamptz,
  rejected_by           bigint REFERENCES sms_users(id),
  rejection_reason      text,
  scheduled_for         timestamptz,
  scheduled_by          bigint REFERENCES sms_users(id),
  cancelled_at          timestamptz,
  cancelled_by          bigint REFERENCES sms_users(id),
  cancellation_reason   text,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_campaigns_workspace_id_key UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS sms_campaigns_workspace_status_time_idx
  ON sms_campaigns (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_campaigns_review_queue_idx
  ON sms_campaigns (workspace_id, submitted_for_review_at)
  WHERE status IN ('review_required', 'approval_pending');
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaigns_preparation_key_idx
  ON sms_campaigns (workspace_id, preparation_key)
  WHERE preparation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_campaign_recipients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id           uuid NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
  workspace_id          text NOT NULL DEFAULT 'vici',
  contact_id            bigint,
  contact_phone         text NOT NULL,
  contact_name_snapshot text,
  selected              boolean NOT NULL DEFAULT true,
  inclusion_reason      jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                 text NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'pending', 'deferred', 'claimed', 'sending', 'sent', 'delivered',
    'failed', 'suppressed', 'cancelled', 'reconciliation_required'
  )),
  approved_in_audience  boolean NOT NULL DEFAULT false,
  approval_revision     integer,
  rendered_message      text,
  planned_send_at       timestamptz,
  claim_token           uuid,
  claimed_at            timestamptz,
  claim_expires_at      timestamptz,
  provider_attempt_started_at timestamptz,
  provider_attempt_heartbeat_at timestamptz,
  provider_idempotency_key text,
  reconciliation_required_at timestamptz,
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz,
  suppression_reason    text,
  provider_message_id   text,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  provider_status       text,
  provider_error_code   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_phone),
  CONSTRAINT sms_campaign_recipients_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT sms_campaign_recipients_workspace_id_campaign_key UNIQUE (workspace_id, id, campaign_id),
  CONSTRAINT sms_campaign_recipients_workspace_campaign_fk
    FOREIGN KEY (workspace_id, campaign_id) REFERENCES sms_campaigns(workspace_id, id),
  CONSTRAINT sms_campaign_recipient_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE INDEX IF NOT EXISTS sms_campaign_recipients_campaign_state_idx
  ON sms_campaign_recipients (campaign_id, state, created_at);
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_claim_idx
  ON sms_campaign_recipients (workspace_id, state, planned_send_at, next_attempt_at)
  WHERE state IN ('pending', 'deferred');
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_provider_message_idx
  ON sms_campaign_recipients (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_provider_idempotency_idx
  ON sms_campaign_recipients (workspace_id, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_campaign_approvals (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id       text NOT NULL DEFAULT 'vici',
  campaign_id        uuid NOT NULL REFERENCES sms_campaigns(id),
  revision           integer NOT NULL,
  actor_user_id      bigint REFERENCES sms_users(id),
  decision           text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decision_reason    text,
  audience_hash      text NOT NULL,
  message_hash       text NOT NULL,
  recipient_count    integer NOT NULL CHECK (recipient_count >= 0),
  audit_log_id       bigint REFERENCES sms_audit_log(id),
  audit_fingerprint  text,
  decided_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, revision, decision),
  CONSTRAINT sms_campaign_approvals_workspace_campaign_fk
    FOREIGN KEY (workspace_id, campaign_id) REFERENCES sms_campaigns(workspace_id, id),
  CONSTRAINT sms_campaign_approval_audit_proof_pair CHECK (
    (audit_log_id IS NULL AND audit_fingerprint IS NULL)
    OR (audit_log_id IS NOT NULL AND char_length(trim(audit_fingerprint)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS sms_campaign_approvals_campaign_idx
  ON sms_campaign_approvals (campaign_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS sms_campaign_recipient_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id    uuid NOT NULL REFERENCES sms_campaign_recipients(id),
  campaign_id     uuid NOT NULL REFERENCES sms_campaigns(id),
  workspace_id    text NOT NULL DEFAULT 'vici',
  event_type      text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   bigint REFERENCES sms_users(id),
  reason_code     text,
  provider        text,
  provider_event_id text,
  provider_message_id text,
  trusted         boolean NOT NULL DEFAULT false,
  trust_source    text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  CONSTRAINT sms_campaign_events_workspace_campaign_fk
    FOREIGN KEY (workspace_id, campaign_id) REFERENCES sms_campaigns(workspace_id, id),
  CONSTRAINT sms_campaign_events_workspace_recipient_fk
    FOREIGN KEY (workspace_id, recipient_id, campaign_id)
    REFERENCES sms_campaign_recipients(workspace_id, id, campaign_id),
  CONSTRAINT sms_campaign_provider_event_shape CHECK (
    event_type NOT LIKE 'provider.%' OR (
      char_length(trim(coalesce(provider, ''))) > 0
      AND char_length(trim(coalesce(provider_message_id, ''))) > 0
    )
  ),
  CONSTRAINT sms_campaign_terminal_event_trust CHECK (
    event_type NOT IN ('provider.delivered', 'provider.failed') OR (
      provider = 'telnyx' AND char_length(trim(coalesce(provider_event_id, ''))) > 0
      AND trusted = true AND trust_source = 'telnyx_ed25519_v2'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_events_dedupe_idx
  ON sms_campaign_recipient_events (workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_campaign_recipient_events_campaign_idx
  ON sms_campaign_recipient_events (campaign_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_events_provider_idx
  ON sms_campaign_recipient_events (workspace_id, provider, provider_event_id)
  WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL;

-- Shared durable commercial-contact ledger. This spans Campaigns and existing
-- transactional flows so cadence cannot be bypassed by moving a customer from
-- one workflow to another. A provider-accepted promotional attempt counts once
-- even if it later fails; idempotency/provider unique indexes enforce that.
CREATE TABLE IF NOT EXISTS sms_commercial_contact_ledger (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id         text NOT NULL DEFAULT 'vici',
  contact_phone        text NOT NULL,
  campaign_id          uuid REFERENCES sms_campaigns(id),
  recipient_id         uuid REFERENCES sms_campaign_recipients(id),
  classification       text NOT NULL CHECK (classification IN ('promotional', 'transactional')),
  workflow_category    text,
  topic                text,
  product_id           bigint,
  variation_id         bigint,
  idempotency_key      text NOT NULL,
  provider_message_id  text,
  reserved_at          timestamptz,
  reservation_expires_at timestamptz,
  accepted_at          timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  failed_at            timestamptz,
  reply_message_id     bigint,
  order_id             text,
  opt_out_event_id     bigint REFERENCES sms_consent_events(id),
  suppression_reason   text,
  suppressed_at        timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT sms_commercial_ledger_recipient_requires_campaign CHECK (
    recipient_id IS NULL OR campaign_id IS NOT NULL
  ),
  CONSTRAINT sms_commercial_ledger_workspace_campaign_fk
    FOREIGN KEY (workspace_id, campaign_id) REFERENCES sms_campaigns(workspace_id, id),
  CONSTRAINT sms_commercial_ledger_workspace_recipient_fk
    FOREIGN KEY (workspace_id, recipient_id, campaign_id)
    REFERENCES sms_campaign_recipients(workspace_id, id, campaign_id),
  CONSTRAINT sms_commercial_contact_phone_e164 CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_commercial_contact_provider_message_idx
  ON sms_commercial_contact_ledger (workspace_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_commercial_contact_phone_accepted_idx
  ON sms_commercial_contact_ledger (workspace_id, contact_phone, accepted_at DESC)
  WHERE classification = 'promotional' AND accepted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_commercial_contact_phone_reservation_idx
  ON sms_commercial_contact_ledger (workspace_id, contact_phone, reservation_expires_at DESC)
  WHERE classification = 'promotional' AND accepted_at IS NULL AND reserved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_commercial_contact_campaign_idx
  ON sms_commercial_contact_ledger (campaign_id, recipient_id, created_at DESC)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_commercial_contact_order_idx
  ON sms_commercial_contact_ledger (workspace_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_product_inventory (
  workspace_id    text NOT NULL DEFAULT 'vici',
  product_id      bigint NOT NULL,
  variation_id    bigint NOT NULL DEFAULT 0,
  sku             text,
  name            text,
  stock_status    text,
  stock_quantity  numeric,
  source_updated_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, product_id, variation_id)
);

CREATE TABLE IF NOT EXISTS sms_commerce_product_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id          text NOT NULL DEFAULT 'vici',
  provider              text NOT NULL DEFAULT 'woocommerce',
  delivery_id           text,
  topic                 text NOT NULL,
  product_id            bigint NOT NULL,
  variation_id          bigint NOT NULL DEFAULT 0,
  sku                   text,
  name                  text,
  previous_stock_status text,
  current_stock_status  text,
  previous_quantity     numeric,
  current_quantity      numeric,
  is_restock_candidate  boolean NOT NULL DEFAULT false,
  signature_valid       boolean NOT NULL,
  source_updated_at     timestamptz,
  received_at           timestamptz NOT NULL DEFAULT now(),
  payload_digest        text NOT NULL,
  dedupe_key            text NOT NULL,
  UNIQUE (workspace_id, provider, dedupe_key)
);

CREATE INDEX IF NOT EXISTS sms_commerce_product_restock_idx
  ON sms_commerce_product_events (workspace_id, received_at DESC)
  WHERE is_restock_candidate = true AND signature_valid = true;

CREATE TABLE IF NOT EXISTS sms_campaign_opportunities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        text NOT NULL DEFAULT 'vici',
  opportunity_type    text NOT NULL,
  source_type         text NOT NULL,
  source_id           text,
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'converted_to_draft', 'expired')),
  structured_context  jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation         text,
  expires_at          timestamptz,
  created_campaign_id uuid REFERENCES sms_campaigns(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key),
  CONSTRAINT sms_campaign_opportunity_workspace_campaign_fk
    FOREIGN KEY (workspace_id, created_campaign_id) REFERENCES sms_campaigns(workspace_id, id)
);

-- Converge installations that previously applied an earlier additive draft of
-- this migration. CREATE TABLE IF NOT EXISTS alone does not add later columns
-- or integrity constraints to an existing relation.
ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS dnd_status_max_age_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS provider_approval_reference text,
  ADD COLUMN IF NOT EXISTS provider_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_approved_by bigint REFERENCES public.sms_users(id);
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS preparation_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaigns_preparation_key_idx
  ON public.sms_campaigns (workspace_id, preparation_key)
  WHERE preparation_key IS NOT NULL;
-- A partially applied predecessor may have enabled the provider flag without
-- recording evidence. Converge fail-closed before attaching the stronger CHECK.
UPDATE public.sms_campaign_settings
SET live_send_enabled = false, provider_approved = false, updated_at = now()
WHERE provider_approved = true AND (
  char_length(trim(coalesce(provider_approval_reference, ''))) = 0
  OR provider_approved_at IS NULL OR provider_approved_by IS NULL
);
ALTER TABLE public.sms_campaign_approvals
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS audit_log_id bigint REFERENCES public.sms_audit_log(id),
  ADD COLUMN IF NOT EXISTS audit_fingerprint text;
UPDATE public.sms_campaign_approvals a
SET workspace_id = c.workspace_id
FROM public.sms_campaigns c
WHERE c.id = a.campaign_id AND a.workspace_id IS DISTINCT FROM c.workspace_id;
ALTER TABLE public.sms_campaign_approvals
  ALTER COLUMN workspace_id SET DEFAULT 'vici',
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.sms_commercial_contact_ledger
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;
ALTER TABLE public.sms_campaign_recipients
  ADD COLUMN IF NOT EXISTS provider_attempt_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_attempt_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key text,
  ADD COLUMN IF NOT EXISTS reconciliation_required_at timestamptz;
ALTER TABLE public.sms_campaign_recipient_events
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trust_source text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

-- The earlier draft did not include the reconciliation state. Replacing this
-- CHECK is a metadata-only expansion and does not rewrite recipient rows.
ALTER TABLE public.sms_campaign_recipients
  DROP CONSTRAINT IF EXISTS sms_campaign_recipients_state_check;
ALTER TABLE public.sms_campaign_recipients
  ADD CONSTRAINT sms_campaign_recipients_state_check CHECK (state IN (
    'draft', 'pending', 'deferred', 'claimed', 'sending', 'sent', 'delivered',
    'failed', 'suppressed', 'cancelled', 'reconciliation_required'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_provider_idempotency_idx
  ON public.sms_campaign_recipients (workspace_id, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipient_events_provider_idx
  ON public.sms_campaign_recipient_events (workspace_id, provider, provider_event_id)
  WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_settings'::regclass AND conname = 'sms_campaign_dnd_age_check') THEN
    ALTER TABLE public.sms_campaign_settings ADD CONSTRAINT sms_campaign_dnd_age_check
      CHECK (dnd_status_max_age_hours BETWEEN 1 AND 168);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_settings'::regclass AND conname = 'sms_campaign_provider_approval_has_evidence') THEN
    ALTER TABLE public.sms_campaign_settings ADD CONSTRAINT sms_campaign_provider_approval_has_evidence CHECK (
      NOT provider_approved OR (
        char_length(trim(coalesce(provider_approval_reference, ''))) > 0
        AND provider_approved_at IS NOT NULL AND provider_approved_by IS NOT NULL
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaigns'::regclass AND conname = 'sms_campaigns_workspace_id_key') THEN
    ALTER TABLE public.sms_campaigns ADD CONSTRAINT sms_campaigns_workspace_id_key UNIQUE (workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipients'::regclass AND conname = 'sms_campaign_recipients_workspace_id_key') THEN
    ALTER TABLE public.sms_campaign_recipients ADD CONSTRAINT sms_campaign_recipients_workspace_id_key UNIQUE (workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipients'::regclass AND conname = 'sms_campaign_recipients_workspace_id_campaign_key') THEN
    ALTER TABLE public.sms_campaign_recipients ADD CONSTRAINT sms_campaign_recipients_workspace_id_campaign_key UNIQUE (workspace_id, id, campaign_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipients'::regclass AND conname = 'sms_campaign_recipients_workspace_campaign_fk') THEN
    ALTER TABLE public.sms_campaign_recipients ADD CONSTRAINT sms_campaign_recipients_workspace_campaign_fk
      FOREIGN KEY (workspace_id, campaign_id) REFERENCES public.sms_campaigns(workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_approvals'::regclass AND conname = 'sms_campaign_approvals_workspace_campaign_fk') THEN
    ALTER TABLE public.sms_campaign_approvals ADD CONSTRAINT sms_campaign_approvals_workspace_campaign_fk
      FOREIGN KEY (workspace_id, campaign_id) REFERENCES public.sms_campaigns(workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_approvals'::regclass AND conname = 'sms_campaign_approval_audit_proof_pair') THEN
    ALTER TABLE public.sms_campaign_approvals ADD CONSTRAINT sms_campaign_approval_audit_proof_pair CHECK (
      (audit_log_id IS NULL AND audit_fingerprint IS NULL)
      OR (audit_log_id IS NOT NULL AND char_length(trim(audit_fingerprint)) > 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipient_events'::regclass AND conname = 'sms_campaign_events_workspace_campaign_fk') THEN
    ALTER TABLE public.sms_campaign_recipient_events ADD CONSTRAINT sms_campaign_events_workspace_campaign_fk
      FOREIGN KEY (workspace_id, campaign_id) REFERENCES public.sms_campaigns(workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipient_events'::regclass AND conname = 'sms_campaign_events_workspace_recipient_fk') THEN
    ALTER TABLE public.sms_campaign_recipient_events ADD CONSTRAINT sms_campaign_events_workspace_recipient_fk
      FOREIGN KEY (workspace_id, recipient_id, campaign_id)
      REFERENCES public.sms_campaign_recipients(workspace_id, id, campaign_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipient_events'::regclass AND conname = 'sms_campaign_provider_event_shape') THEN
    ALTER TABLE public.sms_campaign_recipient_events ADD CONSTRAINT sms_campaign_provider_event_shape CHECK (
      event_type NOT LIKE 'provider.%' OR (
        char_length(trim(coalesce(provider, ''))) > 0
        AND char_length(trim(coalesce(provider_message_id, ''))) > 0
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_recipient_events'::regclass AND conname = 'sms_campaign_terminal_event_trust') THEN
    ALTER TABLE public.sms_campaign_recipient_events ADD CONSTRAINT sms_campaign_terminal_event_trust CHECK (
      event_type NOT IN ('provider.delivered', 'provider.failed') OR (
        provider = 'telnyx' AND char_length(trim(coalesce(provider_event_id, ''))) > 0
        AND trusted = true AND trust_source = 'telnyx_ed25519_v2'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_commercial_contact_ledger'::regclass AND conname = 'sms_commercial_ledger_recipient_requires_campaign') THEN
    ALTER TABLE public.sms_commercial_contact_ledger ADD CONSTRAINT sms_commercial_ledger_recipient_requires_campaign
      CHECK (recipient_id IS NULL OR campaign_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_commercial_contact_ledger'::regclass AND conname = 'sms_commercial_ledger_workspace_campaign_fk') THEN
    ALTER TABLE public.sms_commercial_contact_ledger ADD CONSTRAINT sms_commercial_ledger_workspace_campaign_fk
      FOREIGN KEY (workspace_id, campaign_id) REFERENCES public.sms_campaigns(workspace_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_commercial_contact_ledger'::regclass AND conname = 'sms_commercial_ledger_workspace_recipient_fk') THEN
    ALTER TABLE public.sms_commercial_contact_ledger ADD CONSTRAINT sms_commercial_ledger_workspace_recipient_fk
      FOREIGN KEY (workspace_id, recipient_id, campaign_id)
      REFERENCES public.sms_campaign_recipients(workspace_id, id, campaign_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sms_campaign_opportunities'::regclass AND conname = 'sms_campaign_opportunity_workspace_campaign_fk') THEN
    ALTER TABLE public.sms_campaign_opportunities ADD CONSTRAINT sms_campaign_opportunity_workspace_campaign_fk
      FOREIGN KEY (workspace_id, created_campaign_id) REFERENCES public.sms_campaigns(workspace_id, id);
  END IF;
END
$$;

-- RLS is fail-closed. There are intentionally no anon/authenticated policies;
-- the Railway backend service role remains the only application access path.
ALTER TABLE sms_campaign_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_customer_commercial_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_recipient_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_commercial_contact_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_product_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_commerce_product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_campaign_opportunities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sms_campaign_settings, sms_consent_events, sms_campaign_suppressions,
  sms_customer_commercial_eligibility, sms_campaigns,
  sms_campaign_recipients, sms_campaign_approvals,
  sms_campaign_recipient_events, sms_commercial_contact_ledger, sms_product_inventory,
  sms_commerce_product_events, sms_campaign_opportunities
FROM anon, authenticated;

-- Existing operational ledgers receive nullable links only; no historical row
-- is guessed or rewritten. Future provider reconciliation can therefore trace
-- campaign -> recipient -> message, and Analytics can select one attribution
-- winner without parsing message text.
ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES sms_campaigns(id),
  ADD COLUMN IF NOT EXISTS campaign_recipient_id uuid REFERENCES sms_campaign_recipients(id);
CREATE INDEX IF NOT EXISTS sms_messages_campaign_recipient_idx
  ON sms_messages (campaign_id, campaign_recipient_id)
  WHERE campaign_id IS NOT NULL;

ALTER TABLE sms_sent_log
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES sms_campaigns(id),
  ADD COLUMN IF NOT EXISTS campaign_recipient_id uuid REFERENCES sms_campaign_recipients(id);
CREATE INDEX IF NOT EXISTS sms_sent_log_campaign_recipient_idx
  ON sms_sent_log (campaign_id, campaign_recipient_id)
  WHERE campaign_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.revenue_attributions') IS NOT NULL THEN
    ALTER TABLE public.revenue_attributions
      ADD COLUMN IF NOT EXISTS campaign_id uuid,
      ADD COLUMN IF NOT EXISTS campaign_recipient_id uuid;
    CREATE INDEX IF NOT EXISTS revenue_attributions_campaign_recipient_idx
      ON public.revenue_attributions (campaign_id, campaign_recipient_id)
      WHERE campaign_id IS NOT NULL;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.revenue_attributions'::regclass
        AND conname = 'revenue_attributions_campaign_fk'
        AND pg_get_constraintdef(oid) NOT LIKE 'FOREIGN KEY (workspace_id, campaign_id)%'
    ) THEN
      ALTER TABLE public.revenue_attributions DROP CONSTRAINT revenue_attributions_campaign_fk;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.revenue_attributions'::regclass
        AND conname = 'revenue_attributions_campaign_fk'
    ) THEN
      ALTER TABLE public.revenue_attributions
        ADD CONSTRAINT revenue_attributions_campaign_fk
        FOREIGN KEY (workspace_id, campaign_id)
        REFERENCES public.sms_campaigns(workspace_id, id) NOT VALID;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.revenue_attributions'::regclass
        AND conname = 'revenue_attributions_campaign_recipient_fk'
        AND pg_get_constraintdef(oid) NOT LIKE 'FOREIGN KEY (workspace_id, campaign_recipient_id)%'
    ) THEN
      ALTER TABLE public.revenue_attributions DROP CONSTRAINT revenue_attributions_campaign_recipient_fk;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.revenue_attributions'::regclass
        AND conname = 'revenue_attributions_campaign_recipient_fk'
    ) THEN
      ALTER TABLE public.revenue_attributions
        ADD CONSTRAINT revenue_attributions_campaign_recipient_fk
        FOREIGN KEY (workspace_id, campaign_recipient_id)
        REFERENCES public.sms_campaign_recipients(workspace_id, id) NOT VALID;
    END IF;
  END IF;
END;
$$;

-- Draft creation and audience replacement are atomic. The API normalises
-- phones first; these functions make sure a recipient failure cannot leave a
-- half-written audience behind.
-- Remove pre-workspace-aware overloads from an earlier draft so PostgREST can
-- never resolve a call to the weaker lifecycle contract.
DROP FUNCTION IF EXISTS public.prepare_sms_campaign_approval(uuid,bigint,integer,text,text);
DROP FUNCTION IF EXISTS public.finalize_sms_campaign_approval(uuid,integer);
DROP FUNCTION IF EXISTS public.schedule_sms_campaign(uuid,bigint,timestamptz);
DROP FUNCTION IF EXISTS public.cancel_sms_campaign(uuid,bigint,text);
DROP FUNCTION IF EXISTS public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,timestamptz);
DROP FUNCTION IF EXISTS public.record_sms_campaign_provider_result(uuid,text,text,text,timestamptz,text);

-- One transaction persists a server-detected opportunity bundle, its draft
-- campaigns and every exact recipient evidence row. The browser never calls
-- this RPC directly and never supplies candidate evidence: the service-role
-- generation adapter owns the JSON contract. Stable preparation/opportunity
-- keys make a retry return the same drafts rather than duplicate them.
CREATE OR REPLACE FUNCTION public.persist_sms_opportunity_draft_bundle(
  p_workspace_id text,
  p_actor_user_id bigint,
  p_rule_version text,
  p_opportunities jsonb,
  p_drafts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opportunity jsonb;
  v_draft jsonb;
  v_recipient jsonb;
  v_key text;
  v_preparation_key text;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_expected integer;
  v_available integer;
  v_inserted integer := 0;
  v_reused integer := 0;
  v_campaigns jsonb := '[]'::jsonb;
BEGIN
  IF char_length(trim(coalesce(p_workspace_id, ''))) = 0
     OR char_length(trim(coalesce(p_rule_version, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_generation_identity_required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_opportunities) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_drafts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'campaign_generation_arrays_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_settings FROM public.sms_campaign_settings s
  WHERE s.workspace_id = p_workspace_id FOR SHARE;
  IF NOT FOUND OR v_settings.drafts_enabled <> true THEN
    RAISE EXCEPTION 'campaign_drafting_disabled' USING ERRCODE = 'P0001';
  END IF;
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.sms_users u
    JOIN public.sms_effective_permissions ep ON ep.user_id = u.id
    WHERE u.id = p_actor_user_id AND u.is_active = true
      AND ep.permission_key = 'campaigns.manage'
  ) THEN
    RAISE EXCEPTION 'campaign_generation_actor_forbidden' USING ERRCODE = 'P0001';
  END IF;

  FOR v_opportunity IN SELECT value FROM jsonb_array_elements(p_opportunities)
  LOOP
    IF v_opportunity->>'workspaceID' IS DISTINCT FROM p_workspace_id
       OR coalesce(v_opportunity->>'status', '') <> 'open'
       OR coalesce(v_opportunity->>'dedupeKey', '') = ''
       OR coalesce(v_opportunity->>'opportunityType', '') = ''
       OR coalesce(v_opportunity->>'sourceType', '') = ''
       OR v_opportunity#>>'{structuredContext,ruleVersion}' IS DISTINCT FROM p_rule_version
       OR coalesce(v_opportunity#>>'{structuredContext,contactPhone}', '') !~ '^\+[1-9][0-9]{7,14}$'
       OR (
         v_opportunity#>'{structuredContext,wooCustomerID}' IS NOT NULL
         AND jsonb_typeof(v_opportunity#>'{structuredContext,wooCustomerID}') <> 'null'
         AND coalesce(v_opportunity#>>'{structuredContext,wooCustomerID}', '') !~ '^[1-9][0-9]*$'
       )
       OR coalesce(v_opportunity#>>'{structuredContext,productID}', '') !~ '^[1-9][0-9]*$'
       OR (
         v_opportunity#>'{structuredContext,variationID}' IS NOT NULL
         AND jsonb_typeof(v_opportunity#>'{structuredContext,variationID}') <> 'null'
         AND coalesce(v_opportunity#>>'{structuredContext,variationID}', '') !~ '^(0|[1-9][0-9]*)$'
       ) THEN
      RAISE EXCEPTION 'campaign_opportunity_evidence_invalid' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.sms_campaign_opportunities
      (workspace_id, opportunity_type, source_type, source_id, dedupe_key,
       status, structured_context, explanation, expires_at)
    VALUES
      (p_workspace_id, left(v_opportunity->>'opportunityType', 100),
       left(v_opportunity->>'sourceType', 100), nullif(v_opportunity->>'sourceID', ''),
       v_opportunity->>'dedupeKey', 'open', v_opportunity->'structuredContext',
       left(v_opportunity->>'explanation', 1000),
       nullif(v_opportunity->>'expiresAt', '')::timestamptz)
    ON CONFLICT (workspace_id, dedupe_key) DO NOTHING;
  END LOOP;

  IF (
    SELECT count(DISTINCT value->>'dedupeKey') FROM jsonb_array_elements(p_opportunities)
  ) <> jsonb_array_length(p_opportunities)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_opportunities) opportunity(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(p_drafts) draft(value)
         CROSS JOIN LATERAL jsonb_array_elements_text(
           draft.value#>'{audienceDefinition,opportunityDedupeKeys}'
         ) draft_key(value)
         WHERE draft_key.value = opportunity.value->>'dedupeKey'
       )
     ) OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_drafts) draft(value)
       CROSS JOIN LATERAL jsonb_array_elements_text(
         draft.value#>'{audienceDefinition,opportunityDedupeKeys}'
       ) draft_key(value)
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_opportunities) opportunity(value)
         WHERE opportunity.value->>'dedupeKey' = draft_key.value
       )
     ) THEN
    RAISE EXCEPTION 'campaign_opportunity_bundle_set_invalid' USING ERRCODE = 'P0001';
  END IF;

  FOR v_draft IN SELECT value FROM jsonb_array_elements(p_drafts)
  LOOP
    v_preparation_key := nullif(trim(v_draft->>'preparationID'), '');
    IF v_preparation_key IS NULL
       OR v_draft->>'workspaceID' IS DISTINCT FROM p_workspace_id
       OR v_draft->>'status' IS DISTINCT FROM 'draft'
       OR v_draft#>>'{audienceDefinition,ruleVersion}' IS DISTINCT FROM p_rule_version
       OR char_length(trim(coalesce(v_draft->>'campaignType', ''))) NOT BETWEEN 1 AND 100
       OR coalesce(v_draft->>'workflowCategory', '') NOT IN ('back_in_stock', 'reorder', 'winback')
       OR char_length(trim(coalesce(v_draft->>'title', ''))) NOT BETWEEN 1 AND 160
       OR char_length(trim(coalesce(v_draft->>'proposedMessage', ''))) NOT BETWEEN 1 AND 1600
       OR jsonb_typeof(v_draft->'recipients') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_draft->'recipients') < 1
       OR jsonb_array_length(v_draft->'recipients') > v_settings.max_recipients_per_campaign
       OR jsonb_typeof(v_draft#>'{audienceDefinition,opportunityDedupeKeys}') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_draft#>'{audienceDefinition,opportunityDedupeKeys}') < 1 THEN
      RAISE EXCEPTION 'campaign_generated_draft_invalid' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_preparation_key, 0));
    SELECT * INTO v_campaign FROM public.sms_campaigns
    WHERE workspace_id = p_workspace_id AND preparation_key = v_preparation_key;
    IF FOUND THEN
      v_reused := v_reused + 1;
      v_campaigns := v_campaigns || jsonb_build_array(to_jsonb(v_campaign));
      CONTINUE;
    END IF;

    -- Lock every referenced opportunity before checking linkage so two
    -- different generation runs cannot attach one opportunity twice.
    FOR v_key IN
      SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      ORDER BY value
    LOOP
      PERFORM 1 FROM public.sms_campaign_opportunities o
      WHERE o.workspace_id = p_workspace_id AND o.dedupe_key = v_key
      FOR UPDATE;
    END LOOP;
    v_expected := jsonb_array_length(v_draft#>'{audienceDefinition,opportunityDedupeKeys}');
    IF jsonb_array_length(v_draft->'recipients') <> v_expected
       OR (
         SELECT count(DISTINCT value)
         FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
       ) <> v_expected
       OR (
         SELECT count(DISTINCT value->'inclusionReason'->>'opportunityDedupeKey')
         FROM jsonb_array_elements(v_draft->'recipients')
       ) <> v_expected THEN
      RAISE EXCEPTION 'campaign_generated_audience_set_invalid' USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO v_available
    FROM public.sms_campaign_opportunities o
    WHERE o.workspace_id = p_workspace_id
      AND o.dedupe_key IN (
        SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      )
      AND o.status = 'open' AND o.created_campaign_id IS NULL;
    IF v_available <> v_expected THEN
      RAISE EXCEPTION 'campaign_opportunity_bundle_conflict' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.sms_campaigns
      (workspace_id, campaign_type, workflow_category, title, status,
       audience_definition, preparation_key, proposed_message, created_by, updated_by)
    VALUES
      (p_workspace_id, left(v_draft->>'campaignType', 100),
       v_draft->>'workflowCategory', trim(v_draft->>'title'), 'draft',
       (v_draft->'audienceDefinition') || jsonb_build_object(
         'preparationID', v_preparation_key, 'ruleVersion', p_rule_version
       ),
       v_preparation_key, trim(v_draft->>'proposedMessage'), p_actor_user_id, p_actor_user_id)
    RETURNING * INTO v_campaign;

    FOR v_recipient IN SELECT value FROM jsonb_array_elements(v_draft->'recipients')
    LOOP
      IF coalesce(v_recipient->>'contactPhone', '') !~ '^\+[1-9][0-9]{7,14}$'
         OR (
           v_recipient->'contactID' IS NOT NULL
           AND jsonb_typeof(v_recipient->'contactID') <> 'null'
           AND coalesce(v_recipient->>'contactID', '') !~ '^[1-9][0-9]*$'
         )
         OR coalesce(v_recipient#>>'{inclusionReason,opportunityDedupeKey}', '') = ''
         OR v_recipient#>>'{inclusionReason,ruleVersion}' IS DISTINCT FROM p_rule_version
         OR (
           v_recipient#>'{inclusionReason,wooCustomerID}' IS NOT NULL
           AND jsonb_typeof(v_recipient#>'{inclusionReason,wooCustomerID}') <> 'null'
           AND coalesce(v_recipient#>>'{inclusionReason,wooCustomerID}', '') !~ '^[1-9][0-9]*$'
         )
         OR coalesce(v_recipient#>>'{inclusionReason,productID}', '') !~ '^[1-9][0-9]*$'
         OR (
           v_recipient#>'{inclusionReason,variationID}' IS NOT NULL
           AND jsonb_typeof(v_recipient#>'{inclusionReason,variationID}') <> 'null'
           AND coalesce(v_recipient#>>'{inclusionReason,variationID}', '') !~ '^(0|[1-9][0-9]*)$'
         ) OR NOT EXISTS (
           SELECT 1 FROM public.sms_campaign_opportunities o
           WHERE o.workspace_id = p_workspace_id
             AND o.dedupe_key = v_recipient#>>'{inclusionReason,opportunityDedupeKey}'
             AND o.dedupe_key IN (
               SELECT value FROM jsonb_array_elements_text(
                 v_draft#>'{audienceDefinition,opportunityDedupeKeys}'
               )
             )
             AND o.structured_context->>'contactPhone' = v_recipient->>'contactPhone'
             AND coalesce(o.structured_context->>'wooCustomerID', '') =
                 coalesce(v_recipient#>>'{inclusionReason,wooCustomerID}', '')
             AND o.structured_context->>'productID' = v_recipient#>>'{inclusionReason,productID}'
             AND coalesce(o.structured_context->>'variationID', '') =
                 coalesce(v_recipient#>>'{inclusionReason,variationID}', '')
         ) THEN
        RAISE EXCEPTION 'campaign_generated_recipient_evidence_invalid' USING ERRCODE = 'P0001';
      END IF;

      INSERT INTO public.sms_campaign_recipients
        (campaign_id, workspace_id, contact_id, contact_phone, inclusion_reason, state)
      VALUES
        (v_campaign.id, p_workspace_id, nullif(v_recipient->>'contactID', '')::bigint,
         v_recipient->>'contactPhone', v_recipient->'inclusionReason', 'draft');
    END LOOP;

    UPDATE public.sms_campaign_opportunities o
    SET status = 'converted_to_draft', created_campaign_id = v_campaign.id, updated_at = now()
    WHERE o.workspace_id = p_workspace_id
      AND o.dedupe_key IN (
        SELECT value FROM jsonb_array_elements_text(v_draft#>'{audienceDefinition,opportunityDedupeKeys}')
      )
      AND o.status = 'open' AND o.created_campaign_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_opportunity_link_failed' USING ERRCODE = 'P0001';
    END IF;

    v_inserted := v_inserted + 1;
    v_campaigns := v_campaigns || jsonb_build_array(to_jsonb(v_campaign));
  END LOOP;

  RETURN jsonb_build_object(
    'campaigns', v_campaigns,
    'insertedCampaigns', v_inserted,
    'reusedCampaigns', v_reused
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_sms_campaign_draft(
  p_workspace_id text,
  p_campaign_type text,
  p_workflow_category text,
  p_title text,
  p_message text,
  p_audience_definition jsonb,
  p_recipients jsonb,
  p_actor_user_id bigint
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_count integer := jsonb_array_length(coalesce(p_recipients, '[]'::jsonb));
  v_limit integer;
BEGIN
  SELECT max_recipients_per_campaign INTO v_limit
  FROM public.sms_campaign_settings WHERE workspace_id = p_workspace_id AND drafts_enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_drafting_disabled' USING ERRCODE = 'P0001'; END IF;
  IF v_count < 1 OR v_count > v_limit THEN RAISE EXCEPTION 'invalid_campaign_audience_size' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.sms_campaigns
    (workspace_id, campaign_type, workflow_category, title, proposed_message,
     audience_definition, created_by, updated_by)
  VALUES
    (p_workspace_id, p_campaign_type, p_workflow_category, p_title, p_message,
     p_audience_definition, p_actor_user_id, p_actor_user_id)
  RETURNING * INTO v_campaign;

  INSERT INTO public.sms_campaign_recipients
    (campaign_id, workspace_id, contact_id, contact_phone,
     contact_name_snapshot, inclusion_reason)
  SELECT v_campaign.id, p_workspace_id,
    NULLIF(entry->>'contact_id', '')::bigint,
    entry->>'contact_phone',
    NULLIF(entry->>'contact_name_snapshot', ''),
    coalesce(entry->'inclusion_reason', '{}'::jsonb)
  FROM jsonb_array_elements(p_recipients) entry;

  RETURN v_campaign;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_sms_campaign_draft(
  p_campaign_id uuid,
  p_workspace_id text,
  p_expected_revision integer,
  p_title text,
  p_message text,
  p_recipients jsonb,
  p_actor_user_id bigint
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_count integer;
  v_limit integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sms_campaign_settings
    WHERE workspace_id = p_workspace_id AND drafts_enabled = true
  ) THEN
    RAISE EXCEPTION 'campaign_drafting_disabled' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status NOT IN ('draft', 'rejected') OR v_campaign.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'campaign_not_editable_or_revision_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF p_recipients IS NOT NULL THEN
    v_count := jsonb_array_length(p_recipients);
    SELECT max_recipients_per_campaign INTO v_limit
    FROM public.sms_campaign_settings WHERE workspace_id = p_workspace_id AND drafts_enabled = true;
    IF v_count < 1 OR v_count > v_limit THEN RAISE EXCEPTION 'invalid_campaign_audience_size' USING ERRCODE = 'P0001'; END IF;
    DELETE FROM public.sms_campaign_recipients WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id;
    INSERT INTO public.sms_campaign_recipients
      (campaign_id, workspace_id, contact_id, contact_phone,
       contact_name_snapshot, inclusion_reason)
    SELECT p_campaign_id, p_workspace_id,
      NULLIF(entry->>'contact_id', '')::bigint,
      entry->>'contact_phone',
      NULLIF(entry->>'contact_name_snapshot', ''),
      coalesce(entry->'inclusion_reason', '{}'::jsonb)
    FROM jsonb_array_elements(p_recipients) entry;
  END IF;

  UPDATE public.sms_campaigns
  SET title = coalesce(p_title, title), proposed_message = coalesce(p_message, proposed_message),
      status = 'draft', revision = revision + 1, updated_by = p_actor_user_id,
      approved_at = NULL, approved_by = NULL, approval_audit_recorded_at = NULL,
      rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL, updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_campaign;
  RETURN v_campaign;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_sms_campaign(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_revision integer,
  p_reason text,
  p_audience_hash text,
  p_message_hash text
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status NOT IN ('review_required', 'approval_pending') OR v_campaign.revision <> p_revision THEN
    RAISE EXCEPTION 'campaign_revision_not_reviewable' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(trim(coalesce(p_reason, ''))) = 0
     OR char_length(trim(coalesce(p_audience_hash, ''))) = 0
     OR char_length(trim(coalesce(p_message_hash, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_rejection_evidence_incomplete' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_count FROM public.sms_campaign_recipients
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id AND selected = true;

  INSERT INTO public.sms_campaign_approvals
    (workspace_id, campaign_id, revision, actor_user_id, decision, decision_reason,
     audience_hash, message_hash, recipient_count)
  VALUES
    (p_workspace_id, p_campaign_id, p_revision, p_actor_user_id, 'rejected', left(trim(p_reason), 500),
     p_audience_hash, p_message_hash, v_count)
  ON CONFLICT (campaign_id, revision, decision) DO NOTHING;

  UPDATE public.sms_campaigns
  SET status = 'rejected', rejected_at = now(), rejected_by = p_actor_user_id,
      rejection_reason = left(trim(p_reason), 500), updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_campaign;
  RETURN v_campaign;
END;
$$;

-- Approval is deliberately two-phase. A revision remains approval_pending
-- until the API has durably written campaign.approved to sms_audit_log.
CREATE OR REPLACE FUNCTION public.prepare_sms_campaign_approval(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_revision integer,
  p_audience_hash text,
  p_message_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_count integer;
  v_approval_id bigint;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'review_required' OR v_campaign.revision <> p_revision THEN
    RAISE EXCEPTION 'campaign_revision_not_reviewable' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(trim(coalesce(v_campaign.final_message, ''))) = 0
     OR char_length(trim(coalesce(p_audience_hash, ''))) = 0
     OR char_length(trim(coalesce(p_message_hash, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_approval_evidence_incomplete' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_count FROM public.sms_campaign_recipients
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id AND selected = true;
  IF v_count = 0 THEN RAISE EXCEPTION 'campaign_audience_empty' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.sms_campaign_recipients
  SET approved_in_audience = selected,
      approval_revision = p_revision,
      rendered_message = v_campaign.final_message,
      updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id;

  INSERT INTO public.sms_campaign_approvals
    (workspace_id, campaign_id, revision, actor_user_id, decision, audience_hash, message_hash, recipient_count)
  VALUES
    (p_workspace_id, p_campaign_id, p_revision, p_actor_user_id, 'approved', p_audience_hash, p_message_hash, v_count)
  ON CONFLICT (campaign_id, revision, decision) DO UPDATE
    SET actor_user_id = public.sms_campaign_approvals.actor_user_id
    WHERE public.sms_campaign_approvals.workspace_id = EXCLUDED.workspace_id
      AND public.sms_campaign_approvals.audience_hash = EXCLUDED.audience_hash
      AND public.sms_campaign_approvals.message_hash = EXCLUDED.message_hash
      AND public.sms_campaign_approvals.recipient_count = EXCLUDED.recipient_count
  RETURNING id INTO v_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_approval_record_mismatch' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaigns
  SET status = 'approval_pending', approved_by = p_actor_user_id,
      approved_at = now(), approval_audit_recorded_at = NULL, updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object('campaign_id', p_campaign_id, 'revision', p_revision, 'recipient_count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_sms_campaign_approval(
  p_campaign_id uuid,
  p_workspace_id text,
  p_revision integer,
  p_audit_log_id bigint,
  p_audit_fingerprint text
)
RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_audit_id bigint;
BEGIN
  IF char_length(trim(coalesce(p_audit_fingerprint, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign_approval_audit_proof_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.id INTO v_audit_id
  FROM public.sms_audit_log a
  WHERE a.workspace_id = p_workspace_id
    AND a.event_type = 'campaign.approved'
    AND a.entity_id = p_campaign_id::text
    AND a.fingerprint = p_audit_fingerprint
    AND (p_audit_log_id IS NULL OR a.id = p_audit_log_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_approval_audit_proof_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaign_approvals
  SET audit_log_id = v_audit_id, audit_fingerprint = p_audit_fingerprint
  WHERE workspace_id = p_workspace_id AND campaign_id = p_campaign_id
    AND revision = p_revision AND decision = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_approval_record_not_found' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.sms_campaigns
  SET status = 'approved', approval_audit_recorded_at = now(), updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id
    AND revision = p_revision AND status = 'approval_pending'
  RETURNING * INTO v_campaign;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_approval_not_pending' USING ERRCODE = 'P0001'; END IF;
  RETURN v_campaign;
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_sms_campaign(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_scheduled_for timestamptz
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign public.sms_campaigns%ROWTYPE;
  v_transitioned integer;
BEGIN
  IF p_scheduled_for IS NULL OR p_scheduled_for < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'campaign_schedule_time_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status <> 'approved' OR v_campaign.approval_audit_recorded_at IS NULL THEN
    RAISE EXCEPTION 'campaign_not_audited_and_approved' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sms_campaign_settings
    WHERE workspace_id = p_workspace_id AND provider_approved = true AND live_send_enabled = true
  ) THEN
    RAISE EXCEPTION 'campaign_live_send_disabled' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'pending', planned_send_at = p_scheduled_for,
      next_attempt_at = p_scheduled_for, updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
    AND selected = true AND approved_in_audience = true
    AND approval_revision = v_campaign.revision AND state = 'draft';
  GET DIAGNOSTICS v_transitioned = ROW_COUNT;
  IF v_transitioned = 0 THEN
    RAISE EXCEPTION 'campaign_has_no_pending_recipients' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaigns
  SET status = 'scheduled', scheduled_for = p_scheduled_for,
      scheduled_by = p_actor_user_id, updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id RETURNING * INTO v_campaign;
  RETURN v_campaign;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_sms_campaign(
  p_campaign_id uuid,
  p_workspace_id text,
  p_actor_user_id bigint,
  p_reason text
) RETURNS public.sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_campaign public.sms_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'campaign_not_cancellable' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'cancelled', claim_token = NULL, claimed_at = NULL,
      claim_expires_at = NULL, updated_at = now()
  WHERE campaign_id = p_campaign_id AND workspace_id = p_workspace_id
    AND state IN ('draft', 'pending', 'deferred', 'claimed');

  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND campaign_id = p_campaign_id
    AND accepted_at IS NULL AND reservation_expires_at > now();

  UPDATE public.sms_campaigns
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_user_id,
      cancellation_reason = left(nullif(trim(p_reason), ''), 500), updated_at = now()
  WHERE id = p_campaign_id AND workspace_id = p_workspace_id RETURNING * INTO v_campaign;
  RETURN v_campaign;
END;
$$;

-- Atomically claim due recipients. It performs suppression at SEND time, not
-- only when the audience was drafted. The dual DB gates are necessary but not
-- sufficient: the future worker must also require CAMPAIGNS_LIVE_SEND_ENABLED.
CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients(
  p_workspace_id text,
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 120
) RETURNS SETOF public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim uuid := gen_random_uuid();
  v_candidate public.sms_campaign_recipients%ROWTYPE;
  v_claimed public.sms_campaign_recipients%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_reserved_id bigint;
  v_claimed_count integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid_claim_limit'; END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 900 THEN RAISE EXCEPTION 'invalid_claim_lease'; END IF;

  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id FOR SHARE;
  IF NOT FOUND OR v_settings.provider_approved <> true OR v_settings.live_send_enabled <> true THEN
    RETURN;
  END IF;

  -- Fail-closed suppression. Missing consent is suppressing evidence whenever
  -- the workspace requires positive evidence. STOP sentinels always win.
  UPDATE public.sms_campaign_recipients r
  SET state = 'suppressed',
      suppression_reason = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.sms_campaign_suppressions x
          WHERE x.workspace_id = c.workspace_id AND x.contact_phone = r.contact_phone
            AND x.active = true AND x.effective_at <= now()
            AND (x.expires_at IS NULL OR x.expires_at > now())
        ) THEN 'internal_or_authoritative_suppression'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_sent_log l
          WHERE l.phone = r.contact_phone AND l.flow_type = 'opted-out'
        ) THEN 'opted_out'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_contacts c
          WHERE c.phone = r.contact_phone AND coalesce(c.opted_out, false) = true
        ) THEN 'opted_out'
        WHEN EXISTS (
          SELECT 1 FROM public.sms_contacts d
          WHERE d.phone = r.contact_phone
            AND (d.ghl_dnd = true OR d.ghl_sms_dnd_status IN ('active', 'permanent'))
        ) THEN 'dnd'
        WHEN NOT EXISTS (
          SELECT 1 FROM public.sms_contacts d
          WHERE d.phone = r.contact_phone
            AND d.ghl_dnd = false AND d.ghl_sms_dnd_status = 'inactive'
            AND d.ghl_dnd_synced_at >= now() - make_interval(hours => s.dnd_status_max_age_hours)
            AND d.ghl_dnd_synced_at <= now()
        ) THEN 'dnd_unknown'
        ELSE 'consent_not_recorded'
      END,
      updated_at = now()
  FROM public.sms_campaigns c, public.sms_campaign_settings s
  WHERE r.campaign_id = c.id AND s.workspace_id = c.workspace_id
    AND c.workspace_id = p_workspace_id AND c.status IN ('scheduled', 'sending')
    AND r.state IN ('pending', 'deferred')
    AND coalesce(r.next_attempt_at, r.planned_send_at, now()) <= now()
    AND (
      EXISTS (
        SELECT 1 FROM public.sms_campaign_suppressions x
        WHERE x.workspace_id = c.workspace_id AND x.contact_phone = r.contact_phone
          AND x.active = true AND x.effective_at <= now()
          AND (x.expires_at IS NULL OR x.expires_at > now())
      )
      OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = r.contact_phone AND l.flow_type = 'opted-out')
      OR EXISTS (SELECT 1 FROM public.sms_contacts sc WHERE sc.phone = r.contact_phone AND coalesce(sc.opted_out, false) = true)
      OR EXISTS (
        SELECT 1 FROM public.sms_contacts d WHERE d.phone = r.contact_phone
          AND (d.ghl_dnd = true OR d.ghl_sms_dnd_status IN ('active', 'permanent'))
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.sms_contacts d WHERE d.phone = r.contact_phone
          AND d.ghl_dnd = false AND d.ghl_sms_dnd_status = 'inactive'
          AND d.ghl_dnd_synced_at >= now() - make_interval(hours => s.dnd_status_max_age_hours)
          AND d.ghl_dnd_synced_at <= now()
      )
      OR (s.consent_evidence_required AND NOT EXISTS (
        SELECT 1 FROM public.sms_consent_events ce
        WHERE ce.workspace_id = c.workspace_id AND ce.contact_phone = r.contact_phone
          AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms'
          AND ce.brand_id = c.workspace_id
          AND char_length(trim(ce.source)) > 0
          AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
          AND NOT EXISTS (
            SELECT 1 FROM public.sms_consent_events later
            WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
              AND later.event_type = 'opt_out'
              AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
          )
      ))
    );

  -- One row is processed at a time so the advisory lock is acquired in a
  -- separate SQL statement before cadence is re-read under READ COMMITTED.
  -- The reservation insert then makes the frequency decision durable before a
  -- worker can receive the claimed row. At most one campaign per phone can be
  -- reserved by concurrent claimers.
  FOR v_candidate IN
    SELECT r.*
    FROM public.sms_campaign_recipients r
    JOIN public.sms_campaigns c ON c.id = r.campaign_id
    WHERE c.workspace_id = p_workspace_id
      AND c.status IN ('scheduled', 'sending')
      AND r.workspace_id = p_workspace_id
      AND r.state IN ('pending', 'deferred')
      AND coalesce(r.next_attempt_at, r.planned_send_at, now()) <= now()
      AND NOT (
        (v_settings.quiet_hours_start > v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time >= v_settings.quiet_hours_start)
        OR (v_settings.quiet_hours_start > v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time < v_settings.quiet_hours_end)
        OR (v_settings.quiet_hours_start < v_settings.quiet_hours_end AND
          (now() AT TIME ZONE v_settings.business_timezone)::time >= v_settings.quiet_hours_start AND
          (now() AT TIME ZONE v_settings.business_timezone)::time < v_settings.quiet_hours_end)
      )
    ORDER BY coalesce(r.next_attempt_at, r.planned_send_at), r.created_at
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    EXIT WHEN v_claimed_count >= p_limit;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_candidate.contact_phone, 0));

    -- Repeat every mutable suppression after the per-phone lock. Unknown or
    -- stale GHL DND state is ineligible; absence is never interpreted as false.
    IF EXISTS (
         SELECT 1 FROM public.sms_campaign_suppressions x
         WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_candidate.contact_phone
           AND x.active = true AND x.effective_at <= now()
           AND (x.expires_at IS NULL OR x.expires_at > now())
       )
       OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = v_candidate.contact_phone AND l.flow_type = 'opted-out')
       OR EXISTS (SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_candidate.contact_phone AND coalesce(c.opted_out, false) = true)
       OR NOT EXISTS (
         SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_candidate.contact_phone
           AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
           AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
           AND c.ghl_dnd_synced_at <= now()
       )
       OR (v_settings.consent_evidence_required AND NOT EXISTS (
         SELECT 1 FROM public.sms_consent_events ce
         WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_candidate.contact_phone
           AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms'
           AND ce.brand_id = p_workspace_id
           AND char_length(trim(ce.source)) > 0
           AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
           AND NOT EXISTS (
             SELECT 1 FROM public.sms_consent_events later
             WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
               AND later.event_type = 'opt_out'
               AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
           )
       )) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) >
          now() - make_interval(hours => v_settings.minimum_promotional_spacing_hours)
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
    ) OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '7 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
    ) >= v_settings.max_promotional_per_7_days OR (
      SELECT count(*) FROM public.sms_commercial_contact_ledger ledger
      WHERE ledger.workspace_id = p_workspace_id
        AND ledger.contact_phone = v_candidate.contact_phone
        AND ledger.classification = 'promotional'
        AND coalesce(ledger.accepted_at, ledger.reserved_at) > now() - interval '30 days'
        AND (ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())
    ) >= v_settings.max_promotional_per_30_days THEN
      CONTINUE;
    END IF;

    INSERT INTO public.sms_commercial_contact_ledger
      (workspace_id, contact_phone, campaign_id, recipient_id, classification,
       workflow_category, idempotency_key, reserved_at, reservation_expires_at)
    SELECT p_workspace_id, v_candidate.contact_phone, c.id, v_candidate.id, 'promotional',
      c.workflow_category, 'campaign-recipient:' || v_candidate.id::text,
      now(), now() + make_interval(secs => p_lease_seconds)
    FROM public.sms_campaigns c
    WHERE c.id = v_candidate.campaign_id AND c.workspace_id = p_workspace_id AND c.status IN ('scheduled', 'sending')
    ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
      SET reserved_at = EXCLUDED.reserved_at,
          reservation_expires_at = EXCLUDED.reservation_expires_at,
          updated_at = now()
      WHERE public.sms_commercial_contact_ledger.accepted_at IS NULL
        AND public.sms_commercial_contact_ledger.reservation_expires_at <= now()
    RETURNING id INTO v_reserved_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.sms_campaign_recipients r
    SET state = 'claimed', claim_token = v_claim, claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = r.attempt_count + 1, updated_at = now()
    WHERE r.id = v_candidate.id AND r.workspace_id = p_workspace_id
      AND r.state IN ('pending', 'deferred')
    RETURNING r.* INTO v_claimed;
    IF FOUND THEN
      v_claimed_count := v_claimed_count + 1;
      RETURN NEXT v_claimed;
    ELSE
      UPDATE public.sms_commercial_contact_ledger
      SET reservation_expires_at = now(), updated_at = now()
      WHERE id = v_reserved_id AND accepted_at IS NULL;
    END IF;
  END LOOP;
  RETURN;
END;
$$;

-- A future worker must cross this fence immediately before provider I/O. Once
-- state becomes `sending`, lease expiry can only move it to
-- `reconciliation_required`; it can never be automatically retried. The
-- returned provider_idempotency_key must be sent unchanged to the provider.
CREATE OR REPLACE FUNCTION public.begin_sms_campaign_provider_attempt(
  p_recipient_id uuid,
  p_workspace_id text,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_campaign_id uuid;
  v_idempotency_key text := 'campaign-recipient:' || p_recipient_id::text;
BEGIN
  IF p_claim_token IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'campaign_provider_attempt_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT campaign_id INTO v_campaign_id FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = v_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND campaign_id = v_campaign.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_campaign.status NOT IN ('scheduled', 'sending') OR v_recipient.state <> 'claimed'
     OR v_recipient.claim_token <> p_claim_token
     OR v_recipient.claim_expires_at IS NULL OR v_recipient.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'campaign_claim_fence_failed' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id AND provider_approved = true AND live_send_enabled = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_live_send_disabled' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_recipient.contact_phone, 0));

  -- Last pre-provider safety check. Unknown/future/stale DND, authoritative
  -- suppressions, STOP and missing positive consent all fail closed.
  IF EXISTS (
       SELECT 1 FROM public.sms_campaign_suppressions x
       WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_recipient.contact_phone
         AND x.active = true AND x.effective_at <= now()
         AND (x.expires_at IS NULL OR x.expires_at > now())
     )
     OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = v_recipient.contact_phone AND l.flow_type = 'opted-out')
     OR EXISTS (SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone AND coalesce(c.opted_out, false) = true)
     OR NOT EXISTS (
       SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone
         AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
         AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
         AND c.ghl_dnd_synced_at <= now()
     )
     OR (v_settings.consent_evidence_required AND NOT EXISTS (
       SELECT 1 FROM public.sms_consent_events ce
       WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_recipient.contact_phone
         AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms' AND ce.brand_id = p_workspace_id
         AND char_length(trim(ce.source)) > 0 AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.sms_consent_events later
           WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
             AND later.event_type = 'opt_out'
             AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
         )
     )) THEN
    RAISE EXCEPTION 'campaign_recipient_no_longer_eligible' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = v_idempotency_key AND accepted_at IS NULL
    AND reservation_expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_claim_reservation_missing' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'sending', provider_idempotency_key = v_idempotency_key,
      provider_attempt_started_at = now(), provider_attempt_heartbeat_at = now(),
      claim_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;
  RETURN v_recipient;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_sms_campaign_provider_attempt(
  p_recipient_id uuid,
  p_workspace_id text,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_recipient public.sms_campaign_recipients%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'campaign_provider_heartbeat_invalid' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.sms_campaign_recipients
  SET provider_attempt_heartbeat_at = now(),
      claim_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND state = 'sending' AND claim_token = p_claim_token
    AND claim_expires_at > now()
  RETURNING * INTO v_recipient;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_provider_heartbeat_fence_failed' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = v_recipient.claim_expires_at, updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = v_recipient.provider_idempotency_key AND accepted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_claim_reservation_missing' USING ERRCODE = 'P0001'; END IF;
  RETURN v_recipient;
END;
$$;

-- This is the only boundary allowed to turn an in-flight provider attempt into
-- an accepted contact. Late acknowledgement is allowed after an attempt has
-- entered reconciliation, but it must carry the exact claim and idempotency
-- identity. There is no worker or provider call in this migration.
CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_acceptance(
  p_recipient_id uuid,
  p_workspace_id text,
  p_claim_token uuid,
  p_provider_idempotency_key text,
  p_provider_message_id text,
  p_accepted_at timestamptz
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_campaign public.sms_campaigns%ROWTYPE;
  v_settings public.sms_campaign_settings%ROWTYPE;
  v_campaign_id uuid;
BEGIN
  IF p_claim_token IS NULL OR char_length(trim(coalesce(p_provider_idempotency_key, ''))) = 0
     OR char_length(trim(coalesce(p_provider_message_id, ''))) = 0
     OR p_accepted_at IS NULL OR p_accepted_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'campaign_provider_acceptance_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT campaign_id INTO v_campaign_id FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  -- Campaign-first locking matches cancellation/scheduling and avoids stale
  -- workers crossing a completed cancellation.
  SELECT * INTO v_campaign FROM public.sms_campaigns
  WHERE id = v_campaign_id AND workspace_id = p_workspace_id FOR UPDATE;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
    AND campaign_id = v_campaign.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_recipient.state IN ('sent', 'delivered', 'failed')
     AND v_recipient.provider_message_id = p_provider_message_id
     AND v_recipient.claim_token = p_claim_token
     AND v_recipient.provider_idempotency_key = p_provider_idempotency_key THEN
    RETURN v_recipient;
  END IF;
  IF v_campaign.status NOT IN ('scheduled', 'cancelled')
     OR v_recipient.state NOT IN ('sending', 'reconciliation_required')
     OR v_recipient.claim_token <> p_claim_token
     OR v_recipient.provider_idempotency_key <> p_provider_idempotency_key THEN
    RAISE EXCEPTION 'campaign_claim_fence_failed' USING ERRCODE = 'P0001';
  END IF;
  IF p_accepted_at < v_recipient.provider_attempt_started_at THEN
    RAISE EXCEPTION 'campaign_provider_acceptance_before_claim' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_settings FROM public.sms_campaign_settings
  WHERE workspace_id = p_workspace_id AND provider_approved = true AND live_send_enabled = true FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_live_send_disabled' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || chr(31) || v_recipient.contact_phone, 0));

  IF EXISTS (
       SELECT 1 FROM public.sms_campaign_suppressions x
       WHERE x.workspace_id = p_workspace_id AND x.contact_phone = v_recipient.contact_phone
         AND x.active = true AND x.effective_at <= now()
         AND (x.expires_at IS NULL OR x.expires_at > now())
     )
     OR EXISTS (SELECT 1 FROM public.sms_sent_log l WHERE l.phone = v_recipient.contact_phone AND l.flow_type = 'opted-out')
     OR EXISTS (SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone AND coalesce(c.opted_out, false) = true)
     OR NOT EXISTS (
       SELECT 1 FROM public.sms_contacts c WHERE c.phone = v_recipient.contact_phone
         AND c.ghl_dnd = false AND c.ghl_sms_dnd_status = 'inactive'
         AND c.ghl_dnd_synced_at >= now() - make_interval(hours => v_settings.dnd_status_max_age_hours)
         AND c.ghl_dnd_synced_at <= now()
     )
     OR (v_settings.consent_evidence_required AND NOT EXISTS (
       SELECT 1 FROM public.sms_consent_events ce
       WHERE ce.workspace_id = p_workspace_id AND ce.contact_phone = v_recipient.contact_phone
         AND ce.event_type = 'opt_in' AND ce.purpose = 'promotional_sms' AND ce.brand_id = p_workspace_id
         AND char_length(trim(ce.source)) > 0 AND char_length(trim(coalesce(ce.evidence_ref, ''))) > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.sms_consent_events later
           WHERE later.workspace_id = ce.workspace_id AND later.contact_phone = ce.contact_phone
             AND later.event_type = 'opt_out'
             AND (later.occurred_at, later.id) > (ce.occurred_at, ce.id)
         )
     )) THEN
    RAISE EXCEPTION 'campaign_recipient_no_longer_eligible' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sms_commercial_contact_ledger
  SET provider_message_id = p_provider_message_id, accepted_at = p_accepted_at,
      sent_at = p_accepted_at, reservation_expires_at = NULL, updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND idempotency_key = p_provider_idempotency_key
    AND accepted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_claim_reservation_missing' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.sms_campaign_recipients
  SET state = 'sent', provider_message_id = p_provider_message_id,
      provider_status = 'accepted', sent_at = p_accepted_at,
      claim_expires_at = NULL, reconciliation_required_at = NULL, updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;

  INSERT INTO public.sms_campaign_recipient_events
    (recipient_id, campaign_id, workspace_id, event_type, occurred_at,
     provider, provider_message_id, trusted, trust_source, metadata, dedupe_key)
  VALUES
    (p_recipient_id, v_campaign.id, p_workspace_id, 'provider.accepted', p_accepted_at,
     'telnyx', p_provider_message_id, true, 'provider_api_response', '{"trusted":true}'::jsonb,
     'provider-accepted:' || p_provider_message_id)
  ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  RETURN v_recipient;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_result(
  p_recipient_id uuid,
  p_workspace_id text,
  p_provider_message_id text,
  p_provider_event_id text,
  p_result text,
  p_occurred_at timestamptz,
  p_error_code text DEFAULT NULL,
  p_trust_source text DEFAULT NULL
) RETURNS public.sms_campaign_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient public.sms_campaign_recipients%ROWTYPE;
  v_event_id bigint;
  v_winner record;
BEGIN
  IF p_result NOT IN ('delivered', 'failed') OR p_occurred_at IS NULL
     OR char_length(trim(coalesce(p_provider_message_id, ''))) = 0
     OR char_length(trim(coalesce(p_provider_event_id, ''))) = 0
     OR p_trust_source IS DISTINCT FROM 'telnyx_ed25519_v2' THEN
    RAISE EXCEPTION 'campaign_provider_result_invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_recipient FROM public.sms_campaign_recipients
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_recipient_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_recipient.provider_message_id <> p_provider_message_id OR v_recipient.state NOT IN ('sent', 'delivered', 'failed') THEN
    RAISE EXCEPTION 'campaign_provider_result_fence_failed' USING ERRCODE = 'P0001';
  END IF;
  IF v_recipient.sent_at IS NULL OR p_occurred_at < v_recipient.sent_at
     OR p_occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'campaign_provider_result_time_invalid' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.sms_campaign_recipient_events
    (recipient_id, campaign_id, workspace_id, event_type, occurred_at, reason_code,
     provider, provider_event_id, provider_message_id, trusted, trust_source, metadata, dedupe_key)
  VALUES
    (p_recipient_id, v_recipient.campaign_id, p_workspace_id, 'provider.' || p_result,
     p_occurred_at, left(p_error_code, 200), 'telnyx', p_provider_event_id,
     p_provider_message_id, true, p_trust_source, '{"trusted":true}'::jsonb,
     'telnyx-event:' || p_provider_event_id)
  ON CONFLICT (workspace_id, provider, provider_event_id)
    WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_event_id;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.sms_campaign_recipient_events e
    WHERE e.workspace_id = p_workspace_id AND e.provider = 'telnyx'
      AND e.provider_event_id = p_provider_event_id AND e.recipient_id = p_recipient_id
      AND e.provider_message_id = p_provider_message_id
      AND e.event_type = 'provider.' || p_result AND e.occurred_at = p_occurred_at
      AND e.trusted = true AND e.trust_source = p_trust_source
  ) THEN
    RAISE EXCEPTION 'campaign_provider_event_identity_conflict' USING ERRCODE = 'P0001';
  END IF;

  -- Recompute from immutable trusted events by provider occurrence time, not
  -- callback arrival order. At identical timestamps delivery wins so retries
  -- cannot flap a recipient between terminal states.
  SELECT e.event_type, e.occurred_at, e.reason_code INTO v_winner
  FROM public.sms_campaign_recipient_events e
  WHERE e.workspace_id = p_workspace_id AND e.recipient_id = p_recipient_id
    AND e.provider = 'telnyx' AND e.provider_message_id = p_provider_message_id
    AND e.trusted = true AND e.trust_source = 'telnyx_ed25519_v2'
    AND e.event_type IN ('provider.delivered', 'provider.failed')
  ORDER BY e.occurred_at DESC,
    CASE e.event_type WHEN 'provider.delivered' THEN 0 ELSE 1 END,
    e.provider_event_id DESC
  LIMIT 1;

  UPDATE public.sms_campaign_recipients
  SET state = CASE v_winner.event_type WHEN 'provider.delivered' THEN 'delivered' ELSE 'failed' END,
      provider_status = CASE v_winner.event_type WHEN 'provider.delivered' THEN 'delivered' ELSE 'failed' END,
      delivered_at = (
        SELECT max(e.occurred_at) FROM public.sms_campaign_recipient_events e
        WHERE e.workspace_id = p_workspace_id AND e.recipient_id = p_recipient_id
          AND e.provider_message_id = p_provider_message_id AND e.event_type = 'provider.delivered'
          AND e.trusted = true AND e.trust_source = 'telnyx_ed25519_v2'
      ),
      failed_at = (
        SELECT max(e.occurred_at) FROM public.sms_campaign_recipient_events e
        WHERE e.workspace_id = p_workspace_id AND e.recipient_id = p_recipient_id
          AND e.provider_message_id = p_provider_message_id AND e.event_type = 'provider.failed'
          AND e.trusted = true AND e.trust_source = 'telnyx_ed25519_v2'
      ),
      provider_error_code = CASE WHEN v_winner.event_type = 'provider.failed'
        THEN left(v_winner.reason_code, 200) ELSE NULL END,
      updated_at = now()
  WHERE id = p_recipient_id AND workspace_id = p_workspace_id
  RETURNING * INTO v_recipient;

  UPDATE public.sms_commercial_contact_ledger
  SET delivered_at = v_recipient.delivered_at, failed_at = v_recipient.failed_at, updated_at = now()
  WHERE workspace_id = p_workspace_id AND recipient_id = p_recipient_id
    AND provider_message_id = p_provider_message_id;
  RETURN v_recipient;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_expired_sms_campaign_claims(p_workspace_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_reconciliation_count integer;
BEGIN
  UPDATE public.sms_campaign_recipients
  SET state = 'pending', claim_token = NULL, claimed_at = NULL,
      claim_expires_at = NULL, next_attempt_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND state = 'claimed' AND claim_expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.sms_campaign_recipients
  SET state = 'reconciliation_required', reconciliation_required_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND state = 'sending' AND claim_expires_at < now();
  GET DIAGNOSTICS v_reconciliation_count = ROW_COUNT;
  UPDATE public.sms_commercial_contact_ledger
  SET reservation_expires_at = now(), updated_at = now()
  WHERE workspace_id = p_workspace_id AND accepted_at IS NULL
    AND reservation_expires_at < now()
    AND NOT EXISTS (
      SELECT 1 FROM public.sms_campaign_recipients r
      WHERE r.workspace_id = p_workspace_id
        AND r.id = public.sms_commercial_contact_ledger.recipient_id
        AND r.state IN ('sending', 'reconciliation_required')
    );
  RETURN v_count + v_reconciliation_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_sms_campaign_approval(uuid,text,bigint,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_sms_campaign(uuid,text,bigint,integer,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_sms_opportunity_draft_bundle(text,bigint,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_sms_campaign_draft(text,text,text,text,text,jsonb,jsonb,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_sms_campaign_draft(uuid,text,integer,text,text,jsonb,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_sms_campaign_approval(uuid,text,integer,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_sms_campaign(uuid,text,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_sms_campaign(uuid,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sms_campaign_recipients(text,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_sms_campaign_provider_attempt(uuid,text,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_sms_campaign_provider_attempt(uuid,text,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_sms_campaign_provider_result(uuid,text,text,text,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_expired_sms_campaign_claims(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_sms_campaign_approval(uuid,text,bigint,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_sms_campaign(uuid,text,bigint,integer,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_sms_opportunity_draft_bundle(text,bigint,text,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_sms_campaign_draft(text,text,text,text,text,jsonb,jsonb,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_sms_campaign_draft(uuid,text,integer,text,text,jsonb,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_sms_campaign_approval(uuid,text,integer,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.schedule_sms_campaign(uuid,text,bigint,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_sms_campaign(uuid,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sms_campaign_recipients(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_sms_campaign_provider_attempt(uuid,text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_sms_campaign_provider_attempt(uuid,text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sms_campaign_provider_result(uuid,text,text,text,text,timestamptz,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expired_sms_campaign_claims(text) TO service_role;

REVOKE ALL ON TABLE public.sms_campaign_settings, public.sms_consent_events,
  public.sms_campaign_suppressions, public.sms_customer_commercial_eligibility,
  public.sms_campaigns, public.sms_campaign_recipients, public.sms_campaign_approvals,
  public.sms_campaign_recipient_events, public.sms_commercial_contact_ledger,
  public.sms_product_inventory, public.sms_commerce_product_events,
  public.sms_campaign_opportunities FROM PUBLIC;

-- Application reads are explicit rather than relying on Supabase project
-- default privileges. Mutations stay behind SECURITY DEFINER RPCs except for
-- the existing campaign review transition and signed Woo inventory ingester.
GRANT SELECT ON TABLE public.sms_campaign_settings, public.sms_consent_events,
  public.sms_campaign_suppressions, public.sms_customer_commercial_eligibility,
  public.sms_campaigns, public.sms_campaign_recipients, public.sms_campaign_approvals,
  public.sms_campaign_recipient_events, public.sms_commercial_contact_ledger,
  public.sms_product_inventory, public.sms_commerce_product_events,
  public.sms_campaign_opportunities TO service_role;
GRANT UPDATE ON TABLE public.sms_campaigns TO service_role;
GRANT INSERT, UPDATE ON TABLE public.sms_product_inventory TO service_role;
GRANT INSERT ON TABLE public.sms_commerce_product_events TO service_role;
DO $$
DECLARE v_sequence text;
BEGIN
  FOREACH v_sequence IN ARRAY ARRAY[
    'sms_consent_events_id_seq', 'sms_campaign_approvals_id_seq',
    'sms_campaign_recipient_events_id_seq', 'sms_commercial_contact_ledger_id_seq',
    'sms_commerce_product_events_id_seq'
  ] LOOP
    IF to_regclass('public.' || v_sequence) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', v_sequence);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', v_sequence);
    END IF;
  END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
