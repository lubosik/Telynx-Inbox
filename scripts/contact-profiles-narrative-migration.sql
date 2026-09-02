-- ============================================================================
-- scripts/contact-profiles-narrative-migration.sql
--
-- The narrative layer of a client profile. Phase 3 of PROFILES-PLAN.md.
--
-- Paste this whole file into the Supabase SQL editor. Every line is SQL or a
-- SQL comment. Safe to run twice. Additive only: nothing is dropped, nothing
-- is rewritten, and every existing row keeps working with these columns at
-- their defaults (NULL, meaning "never assessed").
--
-- Run scripts/contact-profiles-migration.sql first. This file assumes the
-- deterministic columns exist — in particular inbound_message_count,
-- messages_fingerprint and deterministic_built_at, which the partial index at
-- the bottom is built on.
--
-- ── THE SOLE-WRITER RULE, EXTENDED BY EXACTLY ONE OWNER ─────────────────────
--
--   the eleven original columns  ->  intelligence.js, unchanged
--   the deterministic columns    ->  lib/profiles/profile-builder.js, only
--   last_checkin_variant         ->  the check-in approval path
--   the six columns below        ->  lib/profiles/narrative-writer.js, only
--
-- The narrative writer UPDATEs; it never upserts. An upsert on a contact with
-- no profile row would invent one carrying nothing but narrative fields and
-- the NOT NULL defaults of every deterministic column — zero orders, zero
-- inbound, engagement_tier 'silent' — which is indistinguishable from a real
-- silent customer and is served by exactly the index somebody would use to
-- find one.
--
-- ── WHAT THESE COLUMNS MAY AND MAY NOT CONTAIN ─────────────────────────────
--
-- narrative_summary may contain NOTHING a query could already return. No order
-- count, no spend, no product list, no dates, no cadence — all of those are
-- columns in this same row, computed exactly. It exists for the part only
-- prose holds: what the customer asked about, what was left unresolved, how
-- they write.
--
-- Two things are asserted in code before any write, and both THROW rather than
-- store:
--
--   1. No identifier shapes — phone, email, street address, order number, or
--      any run of four or more digits. This text is persisted and is meant to
--      be re-fed into later prompts, so a leaked identifier compounds every
--      time the profile is read.
--
--   2. No customer-stated health outcome, in either direction. This shop sells
--      research peptides. A stored sentence saying somebody lost weight is a
--      health claim sitting in a database waiting for somebody to paste it
--      into a message, and lib/campaigns/copy-rules.js bans that exact
--      sentence on the way out. The marker list is BODILY_EFFECT_MARKERS from
--      lib/campaigns/reply-triage.js, shared rather than duplicated.
--
-- These are code assertions, not CHECK constraints, on purpose: a CHECK that
-- rejected a row would surface as an opaque database error at write time, and
-- the writer needs to record WHICH check failed for which contact without ever
-- writing the offending text anywhere.
--
-- ── WHO GETS ONE ───────────────────────────────────────────────────────────
--
-- Measured on production: of 809 contacts with any SMS at all, 559 have NEVER
-- sent an inbound message, 102 have sent exactly one, 89 have sent two to four
-- and 59 have sent five or more.
--
-- For the 559 the only text a model could read is our own outbound templates,
-- and it would summarise them into a confident account of a conversation that
-- did not happen. At one or two inbounds the content is "ok" / "thanks" /
-- "how much", which has_replied_ever and engagement_tier already capture
-- exactly. So a narrative is written only at inbound_message_count >= 3
-- (PROFILE_NARRATIVE_MIN_INBOUND) AND only when at least one of those inbound
-- messages is a sentence rather than an acknowledgement.
--
-- Order history alone never earns a narrative. An order row is entirely
-- queryable — SKUs, dates, totals, cadence are all columns already — so a
-- narrative built only from orders could contain nothing permitted by the rule
-- above, which means it would contain nothing.
-- ============================================================================

BEGIN;

-- Prose, at most 400 characters, enforced in code before the write.
--
-- NULL is meaningful and is not the same as "not built yet": a contact with
-- narrative_built_at set and narrative_summary NULL was assessed and found to
-- have nothing a column does not already hold. narrative_confidence = 'none'
-- says so explicitly. Storing that outcome is what stops the next sweep
-- re-reading and re-prompting the same contact forever at full price.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_summary text;

-- A CLOSED vocabulary of conversation subjects, not free text and not product
-- names. Free-text topics become a taxonomy nobody owns, with downstream code
-- branching on strings the model invented; a closed list also means a topic
-- cannot leak an identifier, which is why the safety assertions only have to
-- police the prose. Which products somebody bought is top_skus, exactly.
--
-- Current list (lib/profiles/narrative-writer.js is authoritative):
--   shipping, delivery_problem, order_status, payment_problem, pricing,
--   discount, product_choice, usage_question, stock_availability,
--   reorder_intent, account_details, complaint, praise, wants_to_stop, other
--
-- Deliberately NOT a Postgres enum type: the list changes with the prompt, and
-- an ALTER TYPE for a vocabulary is a migration for something that should be a
-- code review. The writer drops anything outside the list before storing.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_topics text[] NOT NULL DEFAULT '{}';

-- How they WRITE, not how they feel:
--   brief | warm | transactional | impatient | chatty | unclear
-- NULL where no narrative was stored.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_tone text;

-- 'high' | 'low' | 'none'.
--
-- 'none' means assessed with nothing to store. 'high' is capped in code by the
-- evidence rather than taken from the model: one sentence is not enough to be
-- sure how somebody communicates, whatever the model claims, and an overclaimed
-- narrative is exactly what gets believed over a column.
--
-- Same vocabulary as cadence_confidence on purpose. Two confidence scales in
-- one row, reading high/low/none and high/medium/low, is how a caller ends up
-- comparing one against the other.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_confidence text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_built_at timestamptz;

-- `n<version>:<the messages_fingerprint this was assessed against>`.
--
-- The fingerprint VALUE has one owner: profile-builder.js, which recomputes
-- messages_fingerprint on every order webhook and every inbound SMS. This
-- column records WHICH of those snapshots the narrative was built from, rather
-- than computing a second answer to "have this contact's messages changed" —
-- two answers to that question is how a narrative ends up either permanently
-- stale or permanently rebuilding.
--
-- The `n<version>` prefix does the job profile_version does for the
-- deterministic half, without a seventh column: bump it in code and every
-- fingerprint stops matching, so every contact is reassessed under the new
-- prompt or the new threshold.
--
-- A rebuild needs all three: the fingerprint differs, the inbound threshold is
-- met, AND the last narrative is older than PROFILE_NARRATIVE_COOLDOWN_DAYS
-- (default 7). The cooldown is the cost ceiling. It does not apply to a
-- contact who has never had one — waiting a week to say anything about
-- somebody who has been talking to us is not thrift, it is lateness.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS narrative_source_fingerprint text;

COMMIT;

-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- Outside the transaction above, for the same reason as the deterministic
-- migration: an index that fails to build must not roll back the columns.

-- "Who needs a narrative, oldest first."
--
-- NULLS FIRST is the point of the ordering: a contact who has never had one
-- sorts ahead of one built three weeks ago, so a run stopped by its call
-- budget spends that budget on people with no narrative at all rather than on
-- refreshing existing ones.
--
-- The predicate hardcodes 3 while PROFILE_NARRATIVE_MIN_INBOUND is
-- configurable, and that is a deliberate, stated trade: raising the env var
-- keeps the index valid as a superset, and lowering it below 3 makes the
-- planner fall back to a sequential scan of a table with fewer than a thousand
-- rows, which costs nothing worth a second migration.
--
-- deterministic_built_at IS NOT NULL keeps the ghost rows out —
-- analyseConversation() upserts on contact_phone and creates rows the profile
-- builder has never touched, which read as real silent customers with zero
-- orders. Same discriminator the engagement_tier index uses.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_narrative_candidates_idx
  ON public.sms_customer_profiles (narrative_built_at NULLS FIRST)
  WHERE inbound_message_count >= 3 AND deterministic_built_at IS NOT NULL;

-- "Everyone who actually has a narrative", for the inbox panel and for any
-- audit of what is stored. Partial, because most rows are and will remain
-- NULL: fewer than 150 of 969 profiles qualify.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_narrative_built_at_idx
  ON public.sms_customer_profiles (narrative_built_at)
  WHERE narrative_summary IS NOT NULL;

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
  ('narrative_summary'), ('narrative_topics'), ('narrative_tone'),
  ('narrative_confidence'), ('narrative_built_at'),
  ('narrative_source_fingerprint')
) AS c(name);

-- Both indexes should be listed. An empty result means the CREATE INDEX
-- statements above did not run — they are after COMMIT, so a session that
-- stopped at the transaction boundary will have the columns and neither index.
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'sms_customer_profiles'
  AND indexname LIKE 'sms_customer_profiles_narrative%'
ORDER BY indexname;
