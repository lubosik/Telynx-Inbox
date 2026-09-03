-- ============================================================================
-- HOW FAST A CAMPAIGN GOES OUT, AS A SETTING
--
-- Paste this whole file into the Supabase SQL editor and run it. Every line is
-- either SQL or a SQL comment. Additive and safe to run twice.
--
-- The pace was 25 every two minutes, hardcoded in server.js. The owner asked
-- for the choice — "are we doing 25 every two minutes, are we doing 10 every
-- five minutes" — and he is right that it is his to make. The correct number
-- depends on things the code cannot see: how many people are on shift to
-- answer replies, how a carrier has been treating the number lately, whether
-- an offer deserves a slow drip or a single push.
--
-- Bounds are enforced in lib/campaigns/delivery-worker.js and repeated here as
-- CHECK constraints, because a setting that can be typed can be mistyped:
--   batch    1 to 100   -- claim_sms_campaign_recipients refuses above 100
--   interval 30s to 1h  -- under 30s is more round trip than sending
--
-- NULL means "use the default", which is what every existing row will hold.
-- ============================================================================

ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS send_batch_size integer;

ALTER TABLE public.sms_campaign_settings
  ADD COLUMN IF NOT EXISTS send_interval_seconds integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_campaign_settings_send_batch_size_range'
  ) THEN
    ALTER TABLE public.sms_campaign_settings
      ADD CONSTRAINT sms_campaign_settings_send_batch_size_range
      CHECK (send_batch_size IS NULL OR (send_batch_size >= 1 AND send_batch_size <= 100));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sms_campaign_settings_send_interval_range'
  ) THEN
    ALTER TABLE public.sms_campaign_settings
      ADD CONSTRAINT sms_campaign_settings_send_interval_range
      CHECK (send_interval_seconds IS NULL OR (send_interval_seconds >= 30 AND send_interval_seconds <= 3600));
  END IF;
END $$;

SELECT column_name, 'YES' AS present
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sms_campaign_settings'
  AND column_name IN ('send_batch_size', 'send_interval_seconds')
ORDER BY column_name;
