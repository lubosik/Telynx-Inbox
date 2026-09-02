-- ============================================================================
-- WHAT THEY TRIED TO BUY
--
-- Paste this whole file into the Supabase SQL editor and run it. Every line is
-- either SQL or a SQL comment. Additive and safe to run twice.
--
-- WHY THIS IS NOT last_product_name
--
--   last_product_name resolves from the newest PAID order, and that is
--   deliberate: it is what somebody actually bought, and a message naming a
--   product they never received is a lie a customer can catch. Twelve people
--   in the win-back were told "saw you ordered RT in May" about a cancelled
--   May order, which is exactly the mistake that column now refuses to make.
--
--   But 125 contacts have no paid order at all. $25,009.88 of orders that
--   never completed, 71 of them for RT, every one of those people still
--   reachable. A campaign to them cannot say the most useful thing it could
--   say, because the only column describing a product is empty by design.
--
--   So: a SECOND column, named for what it is. attempted_product_name is what
--   they put in the basket and did not complete. It never stands in for a
--   purchase and nothing that means "bought" reads from it. Two questions, two
--   answers, both labelled.
--
-- WHY IT IS ONLY SET WHEN THERE IS NO PAID ORDER
--
--   For anybody who has bought something, the interesting product is the one
--   they bought. Populating this for them as well would create a second answer
--   to "what should this message name", and the emptiest or stalest answer
--   winning is the fault this codebase keeps repeating.
-- ============================================================================

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS attempted_product_name text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS attempted_product_sku text;

ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS attempted_order_at timestamptz;

-- The value of what never completed, in cents. Integers, because money summed
-- in floating point eventually reports a total ending in .9999999.
ALTER TABLE public.sms_customer_profiles
  ADD COLUMN IF NOT EXISTS attempted_value_cents bigint NOT NULL DEFAULT 0;

-- Finding the segment is a single indexed query rather than a scan.
CREATE INDEX IF NOT EXISTS sms_customer_profiles_attempted_product_idx
  ON public.sms_customer_profiles (attempted_product_sku)
  WHERE attempted_product_sku IS NOT NULL;

SELECT column_name,
       CASE WHEN column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS present
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'sms_customer_profiles'
  AND column_name IN ('attempted_product_name', 'attempted_product_sku',
                      'attempted_order_at', 'attempted_value_cents')
ORDER BY column_name;
