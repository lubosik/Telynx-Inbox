-- Vici Inbox — per-account display time zone. Additive schema.
--
-- WHY THIS COLUMN EXISTS
--   Two people run this inbox and they are five hours apart. Every timestamp
--   the clients rendered came out in whatever zone the DEVICE was set to, so
--   the same message read 14:05 on one phone and 09:05 on the other and neither
--   person could quote a time to the other without translating it first. An
--   account now carries its own zone and every client formats against that,
--   whatever the device says.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THIS IS A DISPLAY PREFERENCE. IT IS NOT THE BUSINESS TIME ZONE.
--
--   Campaign quiet hours are enforced in SQL, inside claim_sms_campaign_batch
--   in scripts/campaigns-migration.sql, against
--   `sms_campaign_settings.business_timezone` and nothing else:
--
--       (now() AT TIME ZONE v_settings.business_timezone)::time
--
--   That is a property of the BUSINESS — the hours in which it is lawful and
--   decent to text a customer — and it must not move because a member of staff
--   changed how their own phone renders a timestamp. Conflating the two would
--   mean the Miami partner switching his display to Europe/London silently
--   shifted the quiet-hours window five hours and started texting American
--   customers at four in the morning. That is a compliance failure, not a
--   cosmetic one.
--
--   Nothing that decides WHEN a customer is contacted reads this column. Do not
--   join it into a delivery predicate, a scheduler, or a cadence rule.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SAFETY
--   * One ADD COLUMN IF NOT EXISTS on sms_users plus one CHECK. No existing row
--     is rewritten, no existing column is altered, no default is backfilled and
--     nobody's access changes. The column is nullable, so the constraint is
--     satisfied by every row that already exists.
--   * Transaction-wrapped and re-runnable.
--   * RLS on sms_users is unchanged. This adds no policy and no grant.
--
-- AN IANA IDENTIFIER, NEVER AN OFFSET
--   `Europe/London`, not `+01:00`. An offset is correct twice a year: store one
--   for the UK and every timestamp is an hour out from late October to late
--   March, and the information needed to fix it was thrown away at write time.
--   An identifier carries the whole daylight-saving rule set, including future
--   changes that arrive in a tzdata update, so a stored row keeps being right
--   without anybody touching it. Offsets are computed at display time in
--   lib/timezones.js and are never persisted.
--
-- WHERE VALIDATION ACTUALLY HAPPENS
--   In the application, against `Intl.supportedValuesOf('timeZone')` — the
--   canonical IANA set the running Node/ICU actually knows about, which is by
--   construction the same set its formatter can render. See lib/timezones.js.
--
--   The CHECK below is a SHAPE check and nothing more: region/city, sensible
--   characters, sensible length. It is deliberately NOT a lookup against
--   pg_timezone_names, for two reasons. First, a CHECK constraint may not read
--   a table, so that would have to be a trigger. Second, Postgres's tzdata and
--   Node's ICU set are not the same list — pg_timezone_names carries POSIX
--   names and aliases that Node rejects, and the two can disagree across an
--   upgrade of either. A row that the application can write but the database
--   refuses is an outage; a row the database allows and the application never
--   writes is nothing at all. So the database enforces the shape and the
--   application enforces the membership.
--
-- WHY EXISTING ROWS ARE LEFT NULL RATHER THAN BACKFILLED
--   NULL means "this person has never chosen", which is the truth. Writing
--   'Europe/London' into every row would assert that the Miami partner is in
--   London, and nothing downstream could tell that claim apart from a real
--   choice. The application resolves NULL to a documented default and marks it
--   `isDefault: true` in the identity payload, so a client can prompt for a
--   real answer instead of silently rendering the wrong time forever. The
--   default is DEFAULT_TIME_ZONE in lib/timezones.js and is Europe/London.
--
-- ROLLBACK
--   The column is additive and nothing else references it:
--     ALTER TABLE sms_users DROP CONSTRAINT IF EXISTS sms_users_timezone_shape;
--     ALTER TABLE sms_users DROP COLUMN IF EXISTS timezone;
--   Dropping it loses stored preferences and returns every client to the
--   pre-change behaviour of formatting in the device's own zone. It cannot
--   affect sign-in, permissions, messaging, or campaign delivery.

BEGIN;

ALTER TABLE sms_users
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN sms_users.timezone IS
  'IANA identifier for how THIS PERSON sees timestamps, for example Europe/London. '
  'NULL means never chosen; the application falls back to DEFAULT_TIME_ZONE in '
  'lib/timezones.js. Display only. Campaign quiet hours use '
  'sms_campaign_settings.business_timezone and must never read this column.';

-- Shape only; membership is enforced in lib/timezones.js. See the header.
--
--   * NULL passes, so every existing row is already valid.
--   * Region/City, or Region/Country/City for the handful of three-segment
--     identifiers such as America/Argentina/Buenos_Aires.
--   * The longest real identifier is 32 characters. 64 is slack, not a target.
--   * A bare offset such as '+01:00' or 'GMT+1' cannot match, which is the one
--     value this constraint genuinely exists to keep out.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sms_users_timezone_shape'
      AND conrelid = 'public.sms_users'::regclass
  ) THEN
    ALTER TABLE sms_users
      ADD CONSTRAINT sms_users_timezone_shape CHECK (
        timezone IS NULL
        OR (
          length(timezone) BETWEEN 3 AND 64
          AND timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'
        )
      );
  END IF;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
