'use strict';
/**
 * lib/timezones.js — per-account display time zones.
 *
 * WHAT THIS IS FOR
 *   Two people run this inbox. One is in the United Kingdom, one is in Miami.
 *   Until now every timestamp the clients rendered came out in whatever zone
 *   the device happened to be in, so the same message read 14:05 on one phone
 *   and 09:05 on the other and neither could quote a time to the other without
 *   translating it first. An account now carries its own IANA identifier and
 *   every client formats against that, whatever the device is set to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A DISPLAY PREFERENCE. IT IS NOT THE BUSINESS TIME ZONE.
 *
 *   Campaign quiet hours are enforced in SQL, inside claim_sms_campaign_batch
 *   in scripts/campaigns-migration.sql, against
 *   `sms_campaign_settings.business_timezone` and nothing else:
 *
 *       (now() AT TIME ZONE v_settings.business_timezone)::time
 *
 *   That is a property of the BUSINESS — what hours it is lawful and decent to
 *   text a customer in — and it must never move because a member of staff
 *   changed how their own phone renders a timestamp. If the two were ever
 *   conflated, the Miami partner switching his display to Europe/London would
 *   silently move the quiet-hours window five hours and start texting American
 *   customers at four in the morning. That is a compliance failure, not a
 *   cosmetic one.
 *
 *   So: nothing in this module is read by anything that decides when a customer
 *   is contacted. `sms_users.timezone` and `sms_campaign_settings
 *   .business_timezone` are different columns, in different tables, applied by
 *   different code, and they must stay that way.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY IANA IDENTIFIERS AND NEVER OFFSETS
 *   An offset is correct twice a year and wrong the rest of the time. Storing
 *   "+01:00" for the UK means every timestamp is an hour out from late October
 *   to late March, and no amount of care at the display layer can recover the
 *   information that was thrown away at the storage layer. `Europe/London`
 *   carries the whole DST rule set, including future changes shipped in a
 *   tzdata update, so a stored identifier keeps being right without anybody
 *   touching a row. The offsets this module emits are DERIVED, computed for the
 *   moment they are asked for, and are display sugar only.
 *
 * THE ACCEPTED SET IS THE RUNTIME'S, NOT A LIST IN THIS FILE
 *   `Intl.supportedValuesOf('timeZone')` is the canonical IANA set the running
 *   Node/ICU actually knows about. A hand-written list would start rotting the
 *   day it was written — zones are added, renamed and retired — and would drift
 *   away from the very formatter the clients use, so a value we accepted would
 *   later fail to format. Reading it from the runtime means the set the server
 *   validates against and the set it can render are the same set by
 *   construction.
 *
 *   One consequence worth knowing rather than discovering: on this runtime the
 *   set contains 418 region/city identifiers and does NOT contain the bare
 *   string 'UTC'. Nobody here wants UTC as a display zone (Etc/UTC is not in
 *   the set either), and widening the rule to admit it would mean maintaining
 *   exactly the hand-written exception list this design avoids. If UTC is ever
 *   genuinely wanted, add it deliberately and say so here.
 *
 * CASE IS FORGIVEN, ANYTHING ELSE IS NOT
 *   `europe/london` is unambiguously `Europe/London`, and refusing it would
 *   only ever punish a client that lower-cased a path segment somewhere. A
 *   case-insensitive match resolves to the canonical spelling and that is what
 *   gets stored. It does not widen the accepted set by a single zone: the match
 *   still has to land on a member of it. Aliases (`Asia/Calcutta`) are NOT
 *   resolved — they are not in the canonical set, so they are refused, and a
 *   client picking from the catalogue this module publishes can never send one.
 */

/**
 * The zone reported for an account that has never chosen one.
 *
 * Europe/London, deliberately. The account holder and the workspace's operating
 * base are in the United Kingdom, so it is right for the person most likely to
 * be reading an un-chosen account, and being explicit beats UTC, which would be
 * wrong for everybody and look deliberate.
 *
 * It is a FALLBACK, not a backfill. scripts/user-timezone-migration.sql leaves
 * every existing row NULL rather than asserting that the Miami partner is in
 * London, and the identity payload marks a fallback with `isDefault: true` so a
 * client can prompt for a real choice instead of quietly rendering the wrong
 * time forever.
 *
 * It has no bearing on when anybody is texted. See the header.
 */
const DEFAULT_TIME_ZONE = 'Europe/London';

/**
 * Longest identifier we will look at before rejecting on shape alone.
 * The longest real one is 32 characters; this is slack, not a limit anyone can
 * reach honestly, and it stops a megabyte of text reaching a Set lookup.
 */
const MAX_IDENTIFIER_LENGTH = 64;

/** How long a rendered catalogue stays usable. See `catalogue()`. */
const CATALOGUE_TTL_MS = 15 * 60 * 1000;

/**
 * The canonical set, resolved once per process.
 *
 * `Intl.supportedValuesOf` is a spec function, not a data source that can fail
 * at runtime, but it did not exist before Node 18 and this service pins Node
 * 20. If it is ever missing the module degrades to accepting only the default
 * zone rather than accepting everything, because "validation is unavailable"
 * must never mean "validation passes".
 */
let canonicalSet = null;
let lowerCaseIndex = null;

function loadCanonical() {
  if (canonicalSet) return;
  let values = [];
  try {
    values = typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
  } catch (error) {
    console.warn('[TZ] Intl.supportedValuesOf is unavailable:', error?.message || 'unknown');
    values = [];
  }
  if (!Array.isArray(values) || values.length === 0) {
    // Fail closed, loudly. One zone is accepted so an account can still be
    // read; nothing else is, so a bad runtime cannot become an open field.
    console.error('[TZ] No IANA zones from the runtime. Only the default zone will be accepted.');
    values = [DEFAULT_TIME_ZONE];
  }
  canonicalSet = new Set(values);
  lowerCaseIndex = new Map(values.map(zone => [zone.toLowerCase(), zone]));
}

/**
 * Every canonical identifier this runtime knows, sorted.
 * @returns {string[]}
 */
function supportedTimeZones() {
  loadCanonical();
  return [...canonicalSet].sort();
}

/**
 * Is `value` a zone this server accepts?
 * @param {unknown} value
 * @returns {boolean}
 */
function isSupportedTimeZone(value) {
  return canonicalTimeZone(value) !== null;
}

/**
 * The canonical spelling of `value`, or null when it is not an accepted zone.
 *
 * This is the ONLY gate. Every write path calls it and stores what it returns,
 * so a row can never hold a spelling the formatter would later reject.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalTimeZone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  loadCanonical();
  if (canonicalSet.has(trimmed)) return trimmed;
  return lowerCaseIndex.get(trimmed.toLowerCase()) || null;
}

/**
 * The zone an account is displayed in, and whether that was its own choice.
 *
 * A stored value that is no longer canonical — a zone retired by a tzdata
 * update between the write and the read — resolves to the default rather than
 * to something the formatter would throw on. The row is left alone: rewriting
 * somebody's preference as a side effect of reading it is not this function's
 * business, and the `isDefault` flag already tells the client to ask again.
 *
 * @param {unknown} stored  sms_users.timezone, possibly null
 * @returns {{ id: string, isDefault: boolean }}
 */
function resolveStoredTimeZone(stored) {
  const canonical = canonicalTimeZone(stored);
  return canonical
    ? { id: canonical, isDefault: false }
    : { id: DEFAULT_TIME_ZONE, isDefault: true };
}

/**
 * `Europe/London` -> `Europe`. The grouping key for a picker.
 * @param {string} zone
 */
function regionOf(zone) {
  const slash = String(zone).indexOf('/');
  return slash === -1 ? String(zone) : String(zone).slice(0, slash);
}

/**
 * `America/Argentina/Buenos_Aires` -> `Buenos Aires, Argentina`.
 * `Europe/London` -> `London`.
 *
 * The region is deliberately NOT repeated in the label: it is the group heading
 * the label sits under, and "Europe — Europe/London" reads like a bug.
 *
 * @param {string} zone
 */
function labelOf(zone) {
  const parts = String(zone).split('/');
  const spaced = part => part.replace(/_/g, ' ');
  if (parts.length <= 1) return spaced(parts[0] || String(zone));
  const city = spaced(parts[parts.length - 1]);
  if (parts.length === 2) return city;
  // Three segments: the middle one is a country or state that distinguishes
  // otherwise identical city names (Indiana/Indianapolis, Argentina/Cordoba).
  return `${city}, ${spaced(parts[parts.length - 2])}`;
}

/**
 * One `timeZoneName` part, or null when the zone cannot be formatted.
 *
 * Wrapped because `Intl.DateTimeFormat` THROWS a RangeError on an unknown zone.
 * Every caller here has already been through `canonicalTimeZone`, so this
 * should be unreachable; it is guarded anyway because the alternative is a
 * 500 on an endpoint whose whole job is to render a list.
 */
function timeZoneNamePart(zone, style, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style })
      .formatToParts(at);
    return parts.find(part => part.type === 'timeZoneName')?.value || null;
  } catch (error) {
    return null;
  }
}

/**
 * The zone's offset from UTC at `at`, in minutes.
 *
 * Derived, never stored. Read from the `longOffset` name — `GMT+05:30`,
 * `GMT-04:00`, `GMT` — because that is the formatter's own answer for the
 * instant in question and therefore already accounts for daylight saving,
 * half-hour and three-quarter-hour zones, and any rule change a tzdata update
 * brought with it.
 *
 * @param {string} zone  already canonical
 * @param {Date} at
 * @returns {number|null} minutes east of UTC, or null if it cannot be read
 */
function offsetMinutesAt(zone, at) {
  const name = timeZoneNamePart(zone, 'longOffset', at);
  if (!name) return null;
  if (/^(GMT|UTC)$/i.test(name.trim())) return 0;
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(name.trim());
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * `-240` -> `UTC-04:00`. Rendered here rather than on each client so a UK phone
 * and a Miami phone cannot disagree about how the same zone is written.
 * @param {number|null} minutes
 */
function offsetLabelFrom(minutes) {
  if (!Number.isFinite(minutes)) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const total = Math.abs(minutes);
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${rest}`;
}

/**
 * The wire shape for one zone. Identical in the identity payload and in the
 * picker catalogue, so a client needs one decoder rather than two.
 *
 * @param {string} zone  already canonical
 * @param {Date} [at]    the instant the offset is computed for
 * @returns {{id: string, label: string, region: string, offsetMinutes: number,
 *            offsetLabel: string, abbreviation: string}}
 */
function describeTimeZone(zone, at = new Date()) {
  const offsetMinutes = offsetMinutesAt(zone, at);
  return {
    id: zone,
    label: labelOf(zone),
    region: regionOf(zone),
    // 0 rather than null when the runtime cannot answer: the field is typed as
    // a number on the client and a null would be a decode failure over what is
    // cosmetic information.
    offsetMinutes: Number.isFinite(offsetMinutes) ? offsetMinutes : 0,
    offsetLabel: offsetLabelFrom(offsetMinutes),
    // `EDT`, or `GMT+5:30` in a zone with no letter abbreviation. Falls back to
    // the offset label so the field is never empty.
    abbreviation: timeZoneNamePart(zone, 'short', at) || offsetLabelFrom(offsetMinutes)
  };
}

/**
 * The identity-payload shape: a descriptor plus whether it is the account's own
 * choice or this module's fallback.
 *
 * @param {unknown} stored  sms_users.timezone, possibly null or missing
 * @param {Date} [at]
 */
function describeStoredTimeZone(stored, at = new Date()) {
  const { id, isDefault } = resolveStoredTimeZone(stored);
  return { ...describeTimeZone(id, at), isDefault };
}

/**
 * Cached rendering of the whole catalogue.
 *
 * Building it costs about 200ms of Intl work for 418 zones, which is far too
 * much to repeat per request for a list that changes twice a year. The cache
 * key is the 15-minute bucket the request falls in, so a DST transition is
 * reflected within a quarter of an hour of happening and no zone can sit at a
 * stale offset for longer than that. Bucketing rather than a plain TTL also
 * means every request inside a bucket gets byte-identical output.
 */
let cachedCatalogue = null;

/**
 * The full grouped catalogue, computed server-side so both clients agree.
 *
 * @param {Date} [at]
 * @returns {{generatedAt: string, count: number, default: string,
 *            groups: Array<{region: string, zones: object[]}>}}
 */
function catalogue(at = new Date()) {
  const bucket = Math.floor(at.getTime() / CATALOGUE_TTL_MS);
  if (cachedCatalogue && cachedCatalogue.bucket === bucket) return cachedCatalogue.payload;

  const byRegion = new Map();
  for (const zone of supportedTimeZones()) {
    const described = describeTimeZone(zone, at);
    if (!byRegion.has(described.region)) byRegion.set(described.region, []);
    byRegion.get(described.region).push(described);
  }

  const groups = [...byRegion.keys()].sort().map(region => ({
    region,
    zones: byRegion.get(region).sort((a, b) => a.label.localeCompare(b.label, 'en'))
  }));

  const payload = {
    // Bucketed, not `at`: two requests in the same bucket must produce the same
    // document, or a client caching on the body would churn every request.
    generatedAt: new Date(bucket * CATALOGUE_TTL_MS).toISOString(),
    count: groups.reduce((total, group) => total + group.zones.length, 0),
    default: DEFAULT_TIME_ZONE,
    groups
  };
  cachedCatalogue = { bucket, payload };
  return payload;
}

/** Test hook. The cache is keyed on wall-clock buckets, which a test moves. */
function resetCatalogueCache() {
  cachedCatalogue = null;
}

module.exports = {
  CATALOGUE_TTL_MS,
  DEFAULT_TIME_ZONE,
  MAX_IDENTIFIER_LENGTH,
  canonicalTimeZone,
  catalogue,
  describeStoredTimeZone,
  describeTimeZone,
  isSupportedTimeZone,
  labelOf,
  offsetLabelFrom,
  offsetMinutesAt,
  regionOf,
  resetCatalogueCache,
  resolveStoredTimeZone,
  supportedTimeZones
};
