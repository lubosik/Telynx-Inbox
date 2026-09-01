-- ============================================================================
-- scripts/contact-profiles-migration.sql
--
-- Deterministic client profiles. Phase 1 of PROFILES-CONTRACT.md.
--
-- Paste this whole file into the Supabase SQL editor. Every line is SQL or a
-- SQL comment. Safe to run twice. Additive only: nothing is dropped, nothing
-- is rewritten, and every existing row keeps working with these columns at
-- their defaults.
--
-- ── WHY THIS EXTENDS A TABLE INSTEAD OF CREATING ONE ────────────────────────
--
-- `sms_customer_profiles` already exists and already answers "who is this
-- person", badly: eleven columns written by analyseConversation() in
-- intelligence.js as a full-rewrite LLM call. It holds one row, because the
-- configured OpenRouter model 404s in production and has done for months.
--
-- A second profile table would be two tables answering one question, which is
-- this repository's recurring production fault — the one that shipped a 15%
-- coupon on a message promising 20%, a dead send path, and analytics
-- reporting zero opt-outs while ten people had left. So the columns land here.
--
-- ── THE SOLE-WRITER RULE, WHICH IS THE POINT OF THIS FILE ───────────────────
--
--   the eleven existing columns  ->  intelligence.js, unchanged
--   every column added below     ->  lib/profiles/profile-builder.js, only
--   last_checkin_variant         ->  the check-in approval path (Phase 2)
--
-- `last_checkin_variant` is added here because the table needs the column, but
-- the profile builder deliberately never writes it: it records a decision
-- taken at campaign approval, which is not something order and message rows
-- can be re-derived into. The builder omitting it from its upsert payload is
-- what stops a nightly sweep from erasing it.
--
-- ── WHAT "PAID" MEANS, AND WHY has_only_unpaid_orders EXISTS ────────────────
--
-- sms_orders.status holds FULFILMENT states, not WooCommerce states. Live
-- distribution: shipped 642, delivered 608, cancelled 252, failed 83,
-- completed 47. Paid is processing / completed / shipped / delivered.
--
-- 335 rows are cancelled or failed. A contact whose only orders failed must
-- never be counted as a customer who came back, because treating a cancelled
-- order as recent activity withholds outreach from exactly the person who
-- needs it. That is one boolean rather than a rule every caller re-derives.
-- ============================================================================

BEGIN;

-- ── Identity and bookkeeping ────────────────────────────────────────────────
--
-- profile_version is bumped in the builder whenever its arithmetic changes, so
-- that a logic change rebuilds every row even where the underlying orders and
-- messages are untouched. Without it, improving the builder would silently
-- apply only to contacts who happened to buy something afterwards.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS deterministic_built_at timestamptz;

-- Change detection. `count:latest_created_at`, one over the contact's paid
-- orders and one over their sms_messages. A rebuild is two indexed reads and
-- no LLM, so it is cheap — but the nightly sweep must not rewrite 843
-- identical rows every night, and these are what let it skip.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS orders_fingerprint text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS messages_fingerprint text;

-- ── From sms_orders, paid only ──────────────────────────────────────────────
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS order_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS first_order_at timestamptz;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_order_at timestamptz;

-- Denormalised on purpose. It is stale the moment it is written, and it is
-- still what makes "silent buyers who are overdue" a single indexed query
-- instead of a full scan with date arithmetic. The nightly sweep is what keeps
-- it honest; anything needing to-the-hour accuracy computes from last_order_at.
ALTER TABLE public.sms_customer_profiles

-- Cents, not the numeric dollars sms_orders.total carries, because money that
-- is summed and averaged in floating point eventually reports a total ending
-- in .9999999. Integers cannot drift.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS total_spend_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS avg_order_value_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS distinct_skus text[] NOT NULL DEFAULT '{}';

-- Most-ordered first, capped at 5. The cap is the difference between a column
-- a campaign can read at a glance and a second copy of the order table.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS top_skus text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_order_skus text[] NOT NULL DEFAULT '{}';

-- The RAW WooCommerce line-item name, not a label that may be sent to a
-- customer. Whether a product may be named in a message is decided by
-- approvedProductLabel() in merge-fields.js and stays decided there; storing a
-- pre-approved string here would be a second answer to that question, and the
-- approved list changes without the orders changing.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_product_name text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_product_sku text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS has_only_unpaid_orders boolean NOT NULL DEFAULT false;

-- ── Reorder rhythm ──────────────────────────────────────────────────────────
--
-- NULL only when there is no paid order to measure from. With one order and no
-- personal rhythm the shop median stands in, exactly as
-- lib/campaigns/checkin-offer-policy.js already does when it decides whether
-- somebody is lapsed — 786 of 843 customers have no measurable personal
-- cadence, so a column that were NULL for all of them would be decorative.
-- reorder_interval_source says which of the two answered.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS reorder_interval_days integer;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS reorder_interval_source text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS reorder_due_at timestamptz;

-- 'high' | 'low' | 'none'. 'none' means the shop median was used, so the date
-- above is a shop-wide expectation rather than anything this person has done.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS cadence_confidence text;

-- ── From sms_messages ───────────────────────────────────────────────────────
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS inbound_message_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS outbound_message_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS has_replied_ever boolean NOT NULL DEFAULT false;

-- silent 0 inbound / flicker 1 / talker 2-4 / regular 5+.
--
-- Measured against the live distribution, not invented: of the 809 contacts
-- with any message at all, 559 have never sent one, 102 have sent exactly one,
-- 89 have sent two to four and 59 have sent five or more. The names exist so a
-- campaign can say "silent buyers who are overdue" without four places
-- re-deriving the same thresholds and eventually disagreeing.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS engagement_tier text NOT NULL DEFAULT 'silent';

-- ── From campaign history ───────────────────────────────────────────────────
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS campaigns_received_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_checkin_at timestamptz;

-- Written by the check-in approval path in Phase 2, never by the profile
-- builder. See the sole-writer note at the top of this file.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS last_checkin_variant text;

-- ── updated_at must not be able to fail an insert ───────────────────────────
--
-- The builder deliberately does NOT write updated_at: that column belongs to
-- intelligence.js under the sole-writer rule. If it were NOT NULL with no
-- default, the builder's very first insert for a contact would fail. Setting
-- the default is idempotent and is a no-op where one already exists.
ALTER TABLE public.sms_customer_profiles
  ALTER COLUMN updated_at SET DEFAULT now();

COMMIT;

-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- Outside the transaction above so that a duplicate contact_phone, which would
-- fail the unique index, does not roll back the columns as well. Column
-- addition and de-duplication are separate problems and the operator should be
-- able to fix the second without redoing the first.

-- The upsert key. intelligence.js has always upserted ON CONFLICT
-- (contact_phone) and the profile builder does the same, so PostgreSQL needs a
-- unique index to conflict against — and the table has ONE row, which means
-- that upsert has effectively never run and its precondition has never been
-- proven. Created only when no unique index already covers the column, so a
-- differently named existing constraint is left alone rather than duplicated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public'
      AND t.relname = 'sms_customer_profiles'
      AND i.indisunique
      AND i.indnatts = 1
      AND a.attname = 'contact_phone'
  ) THEN
    CREATE UNIQUE INDEX sms_customer_profiles_contact_phone_key
      ON public.sms_customer_profiles (contact_phone);
  END IF;
END
$$;

-- "Who is due back", the query the reorder campaigns exist to ask. Partial,
-- because a contact with no paid order has no due date and there is no point
-- carrying them in the index.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_reorder_due_at_idx
  ON public.sms_customer_profiles (reorder_due_at)
  WHERE reorder_due_at IS NOT NULL;

-- "Everyone who has never replied", which is 559 of 809 and is the single
-- largest segment in the database.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_engagement_tier_idx
  ON public.sms_customer_profiles (engagement_tier);

-- "Who was checked in on recently", read by the check-in sweep's no-repeat
-- rule. Partial for the same reason as reorder_due_at: most rows are NULL.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_last_checkin_at_idx
  ON public.sms_customer_profiles (last_checkin_at)
  WHERE last_checkin_at IS NOT NULL;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every row should say YES. Anything saying NO means this file did not finish.
SELECT c.name AS column,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema = 'public'
           AND ic.table_name = 'sms_customer_profiles'
           AND ic.column_name = c.name
       ) THEN 'YES' ELSE 'NO' END AS present
FROM (VALUES
  ('profile_version'), ('deterministic_built_at'), ('orders_fingerprint'),
  ('messages_fingerprint'), ('order_count'), ('first_order_at'),
  ('last_order_at'), ('total_spend_cents'),
  ('avg_order_value_cents'), ('distinct_skus'), ('top_skus'),
  ('last_order_skus'), ('last_product_name'), ('last_product_sku'),
  ('has_only_unpaid_orders'), ('reorder_interval_days'),
  ('reorder_interval_source'), ('reorder_due_at'), ('cadence_confidence'),
  ('inbound_message_count'), ('outbound_message_count'), ('last_inbound_at'),
  ('has_replied_ever'), ('engagement_tier'), ('campaigns_received_count'),
  ('last_checkin_at'), ('last_checkin_variant')
) AS c(name);
