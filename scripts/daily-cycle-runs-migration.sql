-- Vici Inbox — the ledger that makes the daily segmentation cycle idempotent.
-- Additive schema.
--
-- WHY THIS TABLE EXISTS
--   Twelve segments are live and populated. The opportunity detector refreshes
--   every six hours. Nothing recomputed segment membership on a schedule: new
--   orders arrived and nobody moved between groups until a person opened the
--   app and pressed a button. The daily cycle in lib/daily-cycle.js closes
--   that, and this table is the thing that stops it running twice.
--
-- THE IDEMPOTENCY GUARD IS THE UNIQUE CONSTRAINT, NOT A COMMENT
--   `sms_daily_cycle_runs_claim` on (workspace_id, scope, scope_key, local_day)
--   is what makes a second run impossible. The scheduler does not check a
--   timestamp and then decide; it INSERTs a claim, and a 23505 unique violation
--   IS the answer "today is already done". That is the only ordering with no
--   window between the check and the act, which matters because Railway can
--   have two instances of the process alive during a rolling deploy and both
--   will tick.
--
-- WHY THE KEY IS A LOCAL DAY AND NOT A TIMESTAMP
--   The cycle is a once-per-day event and "which day" has to be decided in a
--   named zone or it is not decided at all. `local_day` is the calendar date in
--   `time_zone` at the moment the claim was made. Two consequences worth
--   knowing rather than discovering:
--     * A redeploy cannot move the fire time. The scheduler ticks every few
--       minutes and asks the same question each time, so restarting the process
--       at 06:03 changes nothing: the tick at 06:05 sees no claim for today and
--       runs, and every tick after that sees the claim and does not.
--     * A daylight-saving transition cannot skip or duplicate a day, because a
--       calendar date exists exactly once regardless of how many hours it had.
--
--   `time_zone` is stored alongside so a row can be read years later without
--   guessing which zone decided it, and so that changing the configured anchor
--   zone is visible in the ledger rather than silent.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE ZONE IN THIS TABLE IS NOT THE BUSINESS TIME ZONE.
--   For a `cycle` row it is the operational anchor from DAILY_CYCLE_TIMEZONE,
--   which decides when a RECOMPUTE runs. For a `digest` row it is one person's
--   own display zone from `sms_users.timezone`, which decides when THEIR
--   summary push is delivered. Neither has anything to do with when a CUSTOMER
--   may be texted. Campaign quiet hours are enforced in SQL inside
--   claim_sms_campaign_batch against `sms_campaign_settings.business_timezone`
--   and nothing in this table is read by that predicate, by the delivery
--   worker, or by any send gate.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- TWO SCOPES IN ONE TABLE
--   scope = 'cycle'   scope_key = 'workspace'. The recompute-and-detect pass.
--                     Once per workspace per local day in the anchor zone.
--   scope = 'digest'  scope_key = the account id as text. One person's summary
--                     push, once per THEIR local day. Two people five hours
--                     apart get two rows on the same UTC day and that is the
--                     point of the feature.
--
--   One table rather than two because the claim/complete/recover behaviour is
--   identical and a second table would be a second place for that logic to
--   drift.
--
-- STALE CLAIMS
--   A process that dies mid-cycle leaves `status = 'running'` and would
--   otherwise kill the whole day. The scheduler may take over a `running` claim
--   whose `started_at` is older than DAILY_CYCLE_STALE_CLAIM_MS through a
--   conditional UPDATE matched on both the status and the age, which is a
--   compare-and-swap and cannot hand the same row to two takers.
--
-- WHAT IS DELIBERATELY NOT HERE
--   No segment membership, no customer phone, no name, no message body. The
--   `summary` jsonb holds counts, segment keys and error CODES only. A ledger
--   of what a job did is not a copy of the data the job touched, and
--   test/daily-cycle.test.js asserts the shape that is written.
--
-- SAFETY
--   * One CREATE TABLE IF NOT EXISTS plus two indexes. Nothing existing is
--     altered, nobody's access changes, and no permission key is added, so this
--     cannot fail the startup permission check and crash-loop the deploy.
--   * Transaction-wrapped and re-runnable.
--   * RLS enabled with no policies, matching every other table added here.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS sms_daily_cycle_runs;
--   The scheduler treats a missing table as "not ready", logs once and does
--   nothing, exactly as it does before this migration is applied. Dropping it
--   loses the run history and cannot affect sign-in, messaging, calls, or
--   campaign delivery.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_daily_cycle_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text        NOT NULL DEFAULT 'vici',
  scope        text        NOT NULL,
  scope_key    text        NOT NULL,
  local_day    date        NOT NULL,
  time_zone    text        NOT NULL,
  status       text        NOT NULL DEFAULT 'running',
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  CONSTRAINT sms_daily_cycle_runs_scope
    CHECK (scope IN ('cycle', 'digest')),
  CONSTRAINT sms_daily_cycle_runs_status
    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  -- THE GUARD. One claim per scope, per key, per local day.
  CONSTRAINT sms_daily_cycle_runs_claim
    UNIQUE (workspace_id, scope, scope_key, local_day)
);

COMMENT ON TABLE sms_daily_cycle_runs IS
  'Idempotency ledger for the daily segmentation cycle and the per-account '
  'digest push. The UNIQUE constraint on (workspace_id, scope, scope_key, '
  'local_day) is what stops a redeploy, a double tick or a manual run '
  'producing a second notification. Counts and error codes only: no customer '
  'identity ever goes in `summary`.';

COMMENT ON COLUMN sms_daily_cycle_runs.time_zone IS
  'The zone that decided `local_day`. For scope=cycle the operational anchor '
  'DAILY_CYCLE_TIMEZONE; for scope=digest that account''s own display zone. '
  'Never the business time zone: campaign quiet hours read '
  'sms_campaign_settings.business_timezone and never this column.';

-- "What happened today?" and "is there a stale claim to take over?" are the
-- only two questions asked of this table, and both are answered by these.
CREATE INDEX IF NOT EXISTS sms_daily_cycle_runs_recent_idx
  ON sms_daily_cycle_runs (workspace_id, scope, local_day DESC);

CREATE INDEX IF NOT EXISTS sms_daily_cycle_runs_running_idx
  ON sms_daily_cycle_runs (status, started_at)
  WHERE status = 'running';

ALTER TABLE sms_daily_cycle_runs ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
