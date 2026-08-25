-- Vici Inbox: assistant chat threads.
--
-- Named, resumable conversations with the assistant, and the messages inside
-- them. Until now a conversation lived for six turns inside one iPhone process
-- and then ceased to exist, so the operator could not come back to something
-- they were part way through, and could not see what the assistant had been
-- told earlier.
--
-- ADDITIVE / REPEATABLE
--   Creates two tables, their indexes and one updated_at trigger. It writes no
--   historical row, changes no existing table, sends nothing, and adds no
--   permission key: every thread route reuses `assistant.use`, which
--   scripts/rbac-migration.sql already seeds.
--
-- DEPLOY ORDER
--   Apply after scripts/rbac-migration.sql, and BEFORE deploying the thread
--   routes in routes/assistant.js. The application validates every route-policy
--   permission key at startup, and PostgREST answers PGRST205 for a table it
--   has not noticed, so the wrong order shows up as a failing route rather than
--   as silent data loss.
--
-- A THREAD BELONGS TO EXACTLY ONE PERSON, AND THAT IS THE WHOLE ACCESS MODEL
--   These rows contain business figures and one operator's working notes: what
--   they were worried about, which customers they looked at, what they were
--   thinking of drafting. There is no sharing column, no team_id, no
--   visibility enum. The absence is deliberate. A thread is reachable only
--   through `user_id`, every route filters on the calling actor's own id, and
--   the only way to widen that later is a schema change somebody has to write
--   on purpose.
--
--   `user_id` is NOT NULL for the same reason. A nullable owner would make an
--   orphan thread readable by whichever query forgot the filter.
--
-- WHAT THE SUMMARY IS, AND THE COLUMN THAT KEEPS IT HONEST
--   A long thread is compacted: the older half is summarised into `summary`
--   and the full messages stay in `messages` untouched. `summarised_message_count`
--   records HOW MANY of the oldest messages that summary already covers.
--   Without it the next compaction cannot tell which turns it has already
--   folded in, so it would either re-summarise a summary or send the same
--   turns twice. The count is the boundary, and it only ever moves forward.
--
--   Nothing deletes an individual message. Deleting a thread cascades to all
--   of them together, which is what keeps the count meaningful.

BEGIN;

-- ── Threads ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_assistant_threads (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              text NOT NULL DEFAULT 'vici',

  -- The owner. NOT NULL, and the only path to a row. See the note above.
  user_id                   bigint NOT NULL REFERENCES sms_users(id) ON DELETE CASCADE,

  -- NULL means "not named yet". The first question in a thread names it, and
  -- once a title exists nothing overwrites it automatically, so an operator
  -- rename is never undone by the next thing they ask.
  title                     text CHECK (title IS NULL OR char_length(trim(title)) BETWEEN 1 AND 120),

  -- The compaction summary, and how much of the thread it accounts for.
  summary                   text CHECK (summary IS NULL OR char_length(summary) <= 4000),
  summarised_message_count  integer NOT NULL DEFAULT 0 CHECK (summarised_message_count >= 0),

  -- Sorting key for the list. Distinct from updated_at, which also moves on a
  -- rename. A thread renamed this morning should not jump above one that was
  -- actually being used, so the list orders on this and not on updated_at.
  last_message_at           timestamptz,

  -- Reserved for an archive action that does not exist yet. No route writes
  -- it. It is here because the list query already excludes archived rows, so
  -- adding archiving later is one route rather than a migration plus a route
  -- plus a re-read of every query that lists threads.
  archived_at               timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- A summary with nothing behind it would be a claim about turns that were
  -- never folded in, and a count with no summary would hide turns from the
  -- model with nothing standing in for them. Neither is recoverable by
  -- inspection afterwards, so the database refuses both.
  CONSTRAINT sms_assistant_thread_summary_has_extent CHECK (
    (summary IS NULL AND summarised_message_count = 0)
    OR (summary IS NOT NULL AND summarised_message_count > 0)
  )
);

-- Converge an installation that applied an earlier draft of this file.
-- CREATE TABLE IF NOT EXISTS adds neither later columns nor later constraints.
ALTER TABLE public.sms_assistant_threads
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS summarised_message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sms_assistant_threads'::regclass
      AND conname = 'sms_assistant_thread_summary_has_extent'
  ) THEN
    ALTER TABLE public.sms_assistant_threads
      ADD CONSTRAINT sms_assistant_thread_summary_has_extent CHECK (
        (summary IS NULL AND summarised_message_count = 0)
        OR (summary IS NOT NULL AND summarised_message_count > 0)
      );
  END IF;
END
$$;

-- The list query, exactly: one person's own live threads, newest activity
-- first. user_id leads because it is the equality filter and because every
-- read is scoped to one account.
CREATE INDEX IF NOT EXISTS sms_assistant_threads_owner_idx
  ON sms_assistant_threads (workspace_id, user_id, last_message_at DESC NULLS LAST)
  WHERE archived_at IS NULL;

-- ── Messages ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_assistant_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE is the point. Deleting a thread must take its messages
  -- with it in the same statement: a delete that left the content behind would
  -- tell the operator their conversation was gone while it was still readable
  -- by anything that queried this table directly.
  thread_id    uuid NOT NULL REFERENCES sms_assistant_threads(id) ON DELETE CASCADE,

  role         text NOT NULL CHECK (role IN ('user', 'assistant')),

  -- Generous, and bounded. The question is capped at 600 characters by the
  -- route and a reply at 700 tokens by the model, so 8000 cannot be reached by
  -- normal use. It is here so that a malformed upstream response cannot write
  -- an unbounded row, and it is not tight enough to ever lose a real answer
  -- the operator has already been shown.
  content      text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),

  -- Which verified lookups produced an assistant turn. An empty array means
  -- the model answered from the conversation itself, which is legitimate for a
  -- follow-up. Kept so that a figure read back weeks later can still be traced
  -- to the tool that produced it.
  tools_used   jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sms_assistant_messages
  ADD COLUMN IF NOT EXISTS tools_used jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Reading one thread in order. `id` is in the index because it is the
-- tiebreak: two rows written in the same microsecond would otherwise come back
-- in an arbitrary order, and the compaction boundary is a COUNT of the oldest
-- messages, so an unstable order would move that boundary across turns it had
-- already summarised.
CREATE INDEX IF NOT EXISTS sms_assistant_messages_thread_idx
  ON sms_assistant_messages (thread_id, created_at, id);

-- ── updated_at ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.touch_sms_assistant_thread()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_assistant_threads_touch ON public.sms_assistant_threads;
CREATE TRIGGER sms_assistant_threads_touch
  BEFORE UPDATE ON public.sms_assistant_threads
  FOR EACH ROW EXECUTE FUNCTION public.touch_sms_assistant_thread();

-- ── Access ──────────────────────────────────────────────────────────────────
-- RLS is fail-closed with no anon/authenticated policies, exactly as every
-- other table in this schema does it. The Railway backend service role is the
-- only application access path, and per-user scoping is applied by every query
-- in lib/assistant/threads.js.
--
-- These two tables get INSERT, UPDATE and DELETE as well as SELECT, unlike the
-- append-only audit log next door. A person must be able to rename and delete
-- their own conversation. That is the difference between a working note and a
-- compliance record, and it is why this content is not in sms_audit_log.

ALTER TABLE sms_assistant_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_assistant_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_assistant_threads  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sms_assistant_messages FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_assistant_threads  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_assistant_messages TO service_role;

REVOKE ALL ON FUNCTION public.touch_sms_assistant_thread() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── Verification ────────────────────────────────────────────────────────────
-- Paste this after the migration. Three rows, all `true`, means it is applied.
-- Anything else means it is not, whatever the editor said about the statements
-- above succeeding.
--
--   SELECT 'threads table'   AS check, to_regclass('public.sms_assistant_threads')  IS NOT NULL AS ok
--   UNION ALL
--   SELECT 'messages table',        to_regclass('public.sms_assistant_messages') IS NOT NULL
--   UNION ALL
--   SELECT 'summary extent check',  EXISTS (
--     SELECT 1 FROM pg_constraint
--     WHERE conrelid = 'public.sms_assistant_threads'::regclass
--       AND conname  = 'sms_assistant_thread_summary_has_extent'
--   );
