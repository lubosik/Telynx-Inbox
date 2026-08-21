-- Vici Activity Center — append-only audit trail (`sms_audit_log`).
--
-- WHAT THIS IS FOR
--   One Admin must be able to see what another Admin did: which automation was
--   cancelled, by whom, when, and what the row looked like before and after.
--   Every other reader of this table is secondary to that question.
--
-- SAFETY
--   * Additive. Creates one new table, its indexes, and two guard triggers.
--     No existing row, column, policy, or grant elsewhere is modified.
--   * RLS is enabled with no policies, matching scripts/analytics-migration.sql:
--     the Railway backend service role is the only application path.
--   * Apply this file once, before deploying the matching backend code. The
--     writer (lib/audit/log.js) fails open when the table is absent, so an
--     out-of-order deploy degrades to "no audit rows" rather than to a broken
--     send, call, or cancel.
--
-- HONEST LIMITS OF THE IMMUTABILITY CONTROLS BELOW
--   The load-bearing control is the trigger, NOT the grants. The backend holds
--   the service-role key, so any grant given to service_role is a grant given
--   to anything that can read the Railway environment. The trigger refuses the
--   statement regardless of who issued it, which is why it exists as well.
--
--   Neither control stops a Postgres superuser with Supabase SQL-editor access
--   — which is us. A superuser can ALTER TABLE ... DISABLE TRIGGER, drop the
--   trigger, or drop the table.
--
--   So this table delivers tamper-RESISTANCE, not tamper-EVIDENCE. Nothing here
--   proves to a third party that a row was never removed. Genuine
--   tamper-evidence needs periodic export (or hash-chain anchoring) to a
--   location this application and this database cannot write to. That is a
--   conscious deferral, recorded here so the next reader does not mistake
--   "append-only" for "provably complete".
--
-- WHY THERE IS NO MESSAGE BODY COLUMN
--   The body of an SMS is never stored here. `metadata.message_length` and a
--   sha256 `metadata.message_digest` are stored instead, alongside the id of
--   the source row.
--     * The body already lives durably in sms_scheduled / sms_sent_log /
--       sms_messages, so nothing is lost.
--     * A customer erasure request can be honoured against those tables. It
--       CANNOT be honoured against a table with REVOKE DELETE and an
--       immutability trigger, so copying customer content in here would turn a
--       routine deletion request into an incident.
--     * A truncated body would be the worst of both: still personal data, no
--       longer usable as evidence.
--     * A digest proves whether the text sitting in sms_scheduled today is
--       byte-identical to the text that was there at cancel time. A stored copy
--       proves nothing of the sort.
--
-- WHY PHONE NUMBERS ARE STORED IN FULL
--   `contact_phone` holds the complete E.164 number, deliberately breaking this
--   codebase's `...slice(-4)` logging habit. A per-contact audit export is
--   unbuildable from the last four digits, and the same number already sits in
--   sms_contacts, so this adds no new class of data to the database.
--
-- WHY THERE IS NO RETENTION JOB
--   There is none, on purpose. A delete job with a filter is a delete job that
--   somebody eventually gets wrong — by adding a consent-bearing event type and
--   forgetting to add it to the exclusion list. At roughly 500 events a month
--   this table grows a few MB a year; storage is not the constraint here.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_audit_log (
  -- The id IS the pagination cursor, so it must be orderable. A uuid would
  -- force offset pagination, which duplicates and skips rows on a feed that
  -- grows at the head, and silently truncates at PostgREST's 1000-row cap.
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id        text NOT NULL DEFAULT 'vici',
  occurred_at         timestamptz NOT NULL DEFAULT now(),

  actor_type          text NOT NULL CHECK (actor_type IN ('user', 'system', 'integration', 'contact', 'anonymous')),
  -- Deliberately NO foreign key. An audit row must survive deletion of every
  -- record it references, including the user account that performed the action.
  actor_user_id       bigint,
  -- Denormalised at write time. The read path therefore needs no join and
  -- cannot regress into the large `.in()` lookup that took the inbox down on
  -- 20 August 2026. It also preserves who the actor was called at the time.
  actor_display_name  text NOT NULL,
  actor_role          text,

  event_type          text NOT NULL,
  category            text NOT NULL CHECK (category IN ('messages', 'calls', 'automations', 'campaigns', 'contacts', 'team', 'settings', 'security')),
  visibility          text NOT NULL DEFAULT 'feed' CHECK (visibility IN ('feed', 'detail', 'audit')),
  severity            text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'notice', 'warning')),

  entity_type         text NOT NULL,
  entity_id           text,
  contact_phone       text,

  -- Rendered once, at write time, by the code that had the full context. A
  -- summary rebuilt later from ids would drift as the referenced rows change.
  summary             text NOT NULL,

  previous_state      jsonb,
  new_state           jsonb,
  changed_fields      text[],
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  ip                  inet,
  user_agent          text,
  request_id          text,
  -- Optional idempotency key. Webhook retries re-run handlers, and an audit
  -- trail that double-counts a single opt-out is a misleading audit trail.
  fingerprint         text
);

-- Idempotency for retried handlers. Partial, because most events have no
-- natural key and must never collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS sms_audit_log_fingerprint_idx
  ON sms_audit_log (workspace_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

-- The default feed: newest first, keyset-paginated on id.
CREATE INDEX IF NOT EXISTS sms_audit_log_workspace_id_desc_idx
  ON sms_audit_log (workspace_id, id DESC);

-- The same feed with `visibility = 'audit'` rows hidden, which is the default
-- for every screen. Partial so the common read never touches the noisy rows.
CREATE INDEX IF NOT EXISTS sms_audit_log_visible_feed_idx
  ON sms_audit_log (workspace_id, id DESC)
  WHERE visibility <> 'audit';

-- Category is a stored column so a tab filters with .eq(), never with an
-- .in() over a list of event types. That list would grow without limit and
-- serialise into the request URL.
CREATE INDEX IF NOT EXISTS sms_audit_log_category_idx
  ON sms_audit_log (workspace_id, category, id DESC);

CREATE INDEX IF NOT EXISTS sms_audit_log_actor_idx
  ON sms_audit_log (workspace_id, actor_user_id, id DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_audit_log_entity_idx
  ON sms_audit_log (workspace_id, entity_type, entity_id, id DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_audit_log_contact_idx
  ON sms_audit_log (workspace_id, contact_phone, id DESC)
  WHERE contact_phone IS NOT NULL;

-- Date-range filtering reports on when the action happened, which is not
-- always the order rows were inserted.
CREATE INDEX IF NOT EXISTS sms_audit_log_occurred_at_idx
  ON sms_audit_log (workspace_id, occurred_at DESC);

-- ── Immutability ──────────────────────────────────────────────────────────
-- Two triggers, because they cover different statements. A FOR EACH ROW
-- trigger does not fire on TRUNCATE: without the statement-level trigger this
-- table is one `TRUNCATE sms_audit_log;` away from empty, and the row trigger
-- would not have been consulted.

CREATE OR REPLACE FUNCTION sms_audit_log_block_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'sms_audit_log is append-only: % is not permitted on audit rows.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION sms_audit_log_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'sms_audit_log is append-only: TRUNCATE is not permitted.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS sms_audit_log_no_update_delete ON sms_audit_log;
CREATE TRIGGER sms_audit_log_no_update_delete
BEFORE UPDATE OR DELETE ON sms_audit_log
FOR EACH ROW EXECUTE FUNCTION sms_audit_log_block_row_change();

DROP TRIGGER IF EXISTS sms_audit_log_no_truncate ON sms_audit_log;
CREATE TRIGGER sms_audit_log_no_truncate
BEFORE TRUNCATE ON sms_audit_log
FOR EACH STATEMENT EXECUTE FUNCTION sms_audit_log_block_truncate();

-- Trigger-only functions; direct execution is never needed.
REVOKE ALL ON FUNCTION sms_audit_log_block_row_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION sms_audit_log_block_row_change() FROM anon;
REVOKE ALL ON FUNCTION sms_audit_log_block_row_change() FROM authenticated;
REVOKE ALL ON FUNCTION sms_audit_log_block_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION sms_audit_log_block_truncate() FROM anon;
REVOKE ALL ON FUNCTION sms_audit_log_block_truncate() FROM authenticated;

-- ── Privileges ────────────────────────────────────────────────────────────
-- Second line of defence only. See the honest-limits note in the header.
REVOKE ALL ON TABLE sms_audit_log FROM PUBLIC;
REVOKE ALL ON TABLE sms_audit_log FROM anon;
REVOKE ALL ON TABLE sms_audit_log FROM authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE sms_audit_log FROM service_role;
GRANT INSERT, SELECT ON TABLE sms_audit_log TO service_role;

ALTER TABLE sms_audit_log ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
