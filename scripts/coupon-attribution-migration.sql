-- ============================================================================
-- scripts/coupon-attribution-migration.sql
--
-- Connect a redeemed coupon back to the campaign that sent it.
--
-- Paste this whole file into the Supabase SQL editor. Every line is SQL or a
-- SQL comment. Safe to run twice. Additive only: nothing is dropped, nothing
-- is rewritten, and every existing row keeps working with these columns NULL.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
--
-- lib/campaigns/attribution-policy.js already scores a redeemed per-person
-- coupon as `verified_unique_recipient_coupon`, weight 650. That is the
-- HIGHEST confidence signal in the whole attribution model, above a clicked
-- link at 640, because a code minted for one person and usable once is proof
-- that this exact customer acted on this exact message.
--
-- It has never fired. attribution-generator.js line 246 passes
-- `couponEvidence: []`, hardcoded, and nothing anywhere reads coupon usage
-- back from WooCommerce. So the strongest evidence the system knows how to
-- weigh is evidence it never receives.
--
-- The practical effect: send 376 codes, and afterwards the campaign screen can
-- tell you how many messages were delivered and how many people replied, and
-- nothing at all about money. The codes get redeemed in WooCommerce and the
-- orders appear, and no join exists between them.
--
-- Two columns close it, because both ends of the join were missing:
--
--   sms_campaign_recipients.issued_coupon_code
--     Which code this person was given. Written at approval, when the code is
--     minted. Without it the only way to identify a code is to re-derive it
--     from the campaign id and phone number, which works (codes are
--     deterministic) but makes every report depend on reimplementing the hash.
--
--   sms_orders.coupon_codes
--     Which codes an order actually used. WooCommerce has always returned this
--     as `coupon_lines` on every order and this codebase has never read it.
--     Verified against live orders: #5194 used welcome20, #5192 used reece10.
--
-- With both, attribution is a join and revenue per campaign is a sum.
-- ============================================================================

BEGIN;

-- ── Which code this person was sent ─────────────────────────────────────────
--
-- NULL for every campaign that offers nothing, which is most of them, and for
-- every recipient approved before this migration. Not unique-constrained:
-- codes ARE unique per (campaign, person) by construction, but a UNIQUE index
-- here would turn a WooCommerce duplicate-code collision into a failed
-- approval rather than a reported one, and the mint path already reports
-- duplicates deliberately.
ALTER TABLE public.sms_campaign_recipients
  ADD COLUMN IF NOT EXISTS issued_coupon_code text;

-- Partial: the overwhelming majority of rows are NULL and are never looked up
-- by code. This index exists to answer "who was given the code on this order",
-- which is the attribution direction.
CREATE INDEX IF NOT EXISTS sms_campaign_recipients_issued_coupon_code_idx
  ON public.sms_campaign_recipients (issued_coupon_code)
  WHERE issued_coupon_code IS NOT NULL;

-- ── Which codes an order used ───────────────────────────────────────────────
--
-- An array because WooCommerce permits several coupons on one order. Our own
-- codes are minted `individual_use`, so one of ours excludes the others, but
-- an order can still carry one of ours beside a manual adjustment and the
-- shape has to allow it.
ALTER TABLE public.sms_orders
  ADD COLUMN IF NOT EXISTS coupon_codes text[];

-- GIN, because the query is "does this order contain any of these codes",
-- which is an array-containment search rather than an equality one.
CREATE INDEX IF NOT EXISTS sms_orders_coupon_codes_idx
  ON public.sms_orders USING gin (coupon_codes)
  WHERE coupon_codes IS NOT NULL;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Both rows should come back, and both should say YES.
SELECT 'sms_campaign_recipients.issued_coupon_code' AS column,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sms_campaign_recipients'
           AND column_name = 'issued_coupon_code'
       ) THEN 'YES' ELSE 'NO' END AS present
UNION ALL
SELECT 'sms_orders.coupon_codes',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sms_orders'
           AND column_name = 'coupon_codes'
       ) THEN 'YES' ELSE 'NO' END;
