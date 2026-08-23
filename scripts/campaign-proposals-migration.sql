-- Vici Inbox — Campaign proposals: reviewable drafts generated from a detected
-- portfolio opportunity, and the record of what a human did with each one.
--
-- ADDITIVE / REPEATABLE
--   Creates one table, its indexes and its updated_at trigger. It writes no
--   historical row, changes no existing workflow, sends nothing, and adds no
--   permission key: proposals reuse campaigns.read and campaigns.manage, both
--   already seeded by scripts/campaigns-migration.sql.
--
-- IT IS A NEW FILE ON PURPOSE
--   scripts/campaigns-migration.sql and scripts/campaign-segments-migration.sql
--   are applied in production and must never be edited.
--
-- DEPLOY ORDER
--   Apply after scripts/campaigns-migration.sql and
--   scripts/campaign-segments-migration.sql, and BEFORE deploying
--   routes/campaign-proposals.js. The application validates every policy
--   permission key at startup and exits 1 if one is missing, so the wrong
--   order is a crash loop rather than a warning.
--
-- WHAT THIS TABLE IS, AND IS NOT
--   A proposal is a DRAFT OF AN ARGUMENT. It holds who a campaign would
--   target, by what mechanism, at what cost, with what risk, and what the
--   message would say. It is not a campaign, it has no recipients, it has no
--   schedule, and there is no code path from a row here to a sent message that
--   does not pass through a human acceptance, the existing campaign draft RPC,
--   the existing review and approval path, and the two independent live-send
--   brakes.
--
-- THREE INVARIANTS THE DATABASE ENFORCES, NOT JUST THE APPLICATION
--   1. A dismissed proposal must carry a reason. The reason is the only
--      training signal this loop gets — see the "log the counterfactual" note
--      in docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md — so a dismissal
--      without one is refused by a CHECK rather than by a validator somebody
--      can forget to call.
--   2. An accepted proposal must name the person who accepted it. Nothing
--      accepts a proposal automatically, and the column is NOT NULL for that
--      status precisely so a future background job cannot.
--   3. A campaign id may only be attached to an accepted proposal. A row in
--      any other status pointing at a campaign would mean a campaign was
--      created without an acceptance, which is the thing this whole feature is
--      not allowed to do.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_campaign_proposals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         text NOT NULL DEFAULT 'vici',

  -- Stable identity of the proposal: opportunity id plus mechanism. Rerunning
  -- generation for the same opportunity updates the open row rather than
  -- filling the review queue with duplicates, and it can never resurrect a row
  -- a human already dismissed (the service only upserts rows in 'proposed').
  proposal_key         text NOT NULL,
  opportunity_id       text NOT NULL,
  opportunity_kind     text NOT NULL,
  opportunity_title    text NOT NULL,
  -- Where the cohort figures came from. 'detector' means this server measured
  -- them; 'client_supplied' means an operator typed them in while the cohort
  -- detector was still being built. The two must never look the same on a
  -- screen: a count somebody asserted is not a count anybody measured, and the
  -- difference is exactly the honesty this feature is supposed to have.
  opportunity_source   text NOT NULL DEFAULT 'detector'
                       CHECK (opportunity_source IN ('detector', 'client_supplied')),

  mechanism            text NOT NULL,
  mechanism_label      text NOT NULL,
  distinctness_class   text NOT NULL,
  title                text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),

  -- The audience as rules and, when the cohort has been saved, the segment key
  -- it resolves to. A proposal with no segment_key can be read, saved and
  -- dismissed; it cannot be accepted, because there is no membership to attach
  -- to a campaign draft and nothing is going to invent one at acceptance time.
  audience             jsonb NOT NULL DEFAULT '{}'::jsonb,
  segment_key          text,

  offer                jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The drafted message. It is here only because it PASSED
  -- lib/campaigns/copy-validator.js; a draft that failed is never persisted,
  -- so this column cannot become a place a reviewer finds rejected text.
  copy_text            text NOT NULL CHECK (char_length(copy_text) BETWEEN 1 AND 1000),
  copy_septets         integer NOT NULL CHECK (copy_septets > 0),
  copy_rules_version   text NOT NULL,

  reasoning            jsonb NOT NULL DEFAULT '{}'::jsonb,
  costs                jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Counts and conditional statements, each carrying its basis. Never a
  -- revenue claim: lib/campaigns/opportunity-contract.js refuses the word.
  projections          jsonb NOT NULL DEFAULT '[]'::jsonb,

  schema_version       text NOT NULL,
  catalogue_version    text NOT NULL,
  contract_version     text NOT NULL,
  model               text,

  status               text NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'accepted', 'dismissed')),

  accepted_at          timestamptz,
  accepted_by          bigint REFERENCES sms_users(id),
  created_campaign_id  uuid REFERENCES sms_campaigns(id),

  dismissed_at         timestamptz,
  dismissed_by         bigint REFERENCES sms_users(id),
  dismissed_reason     text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, proposal_key),

  -- Invariant 1. A dismissal says why, or it is not a dismissal.
  CONSTRAINT sms_campaign_proposal_dismissal_has_reason CHECK (
    status <> 'dismissed'
    OR (dismissed_reason IS NOT NULL
        AND char_length(trim(dismissed_reason)) BETWEEN 4 AND 500
        AND dismissed_at IS NOT NULL)
  ),
  -- Invariant 2. An acceptance names a person.
  CONSTRAINT sms_campaign_proposal_acceptance_has_actor CHECK (
    status <> 'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
  ),
  -- Invariant 3. Only an accepted proposal may point at a campaign.
  CONSTRAINT sms_campaign_proposal_campaign_requires_acceptance CHECK (
    created_campaign_id IS NULL OR status = 'accepted'
  ),
  CONSTRAINT sms_campaign_proposal_workspace_campaign_fk
    FOREIGN KEY (workspace_id, created_campaign_id)
    REFERENCES sms_campaigns(workspace_id, id)
);

-- Converge an installation that applied an earlier draft of this file.
-- CREATE TABLE IF NOT EXISTS adds neither later columns nor later constraints.
ALTER TABLE public.sms_campaign_proposals
  ADD COLUMN IF NOT EXISTS segment_key text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS contract_version text,
  ADD COLUMN IF NOT EXISTS opportunity_source text NOT NULL DEFAULT 'detector';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_campaign_proposals'::regclass
      AND conname = 'sms_campaign_proposal_campaign_requires_acceptance'
  ) THEN
    ALTER TABLE public.sms_campaign_proposals
      ADD CONSTRAINT sms_campaign_proposal_campaign_requires_acceptance
      CHECK (created_campaign_id IS NULL OR status = 'accepted');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS sms_campaign_proposals_open_idx
  ON sms_campaign_proposals (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_campaign_proposals_opportunity_idx
  ON sms_campaign_proposals (workspace_id, opportunity_id, status);

CREATE OR REPLACE FUNCTION public.touch_sms_campaign_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_campaign_proposals_touch ON public.sms_campaign_proposals;
CREATE TRIGGER sms_campaign_proposals_touch
  BEFORE UPDATE ON public.sms_campaign_proposals
  FOR EACH ROW EXECUTE FUNCTION public.touch_sms_campaign_proposal();

-- ── Access ──────────────────────────────────────────────────────────────────
-- RLS is fail-closed with no anon/authenticated policies, exactly as every
-- other campaign table does it. The Railway backend service role remains the
-- only application access path.

ALTER TABLE sms_campaign_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_campaign_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sms_campaign_proposals TO service_role;

REVOKE ALL ON FUNCTION public.touch_sms_campaign_proposal() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
