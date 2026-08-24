'use strict';
/**
 * lib/notifications/preferences.js — which alerts an account has asked not to
 * receive, and the one place that answer is applied before a push goes out.
 *
 * A TOGGLE THAT DOES NOT STOP THE PUSH IS WORSE THAN NO TOGGLE
 *   That is the whole design constraint. Every category below is consulted in
 *   lib/apns-notify.js at DELIVERY, immediately before the device list is
 *   handed to Apple, rather than at the call sites that decide to notify. There
 *   are six such call sites and there will be more; filtering at the last
 *   boundary means a future sender cannot forget.
 *
 * SIX CATEGORIES, CLOSED
 *   `NOTIFICATION_CATEGORIES` is the closed list and is exported so the API,
 *   the iOS client and the tests all read the same names. Adding one means
 *   adding a column in scripts/notification-preferences-migration.sql, a case
 *   in `CATEGORY_FAILURE_MODE` below, and a row on the Settings screen.
 *
 * DEFAULT TRUE, AND THAT IS NOT PERMISSION
 *   An account with no row has expressed no preference and every category
 *   resolves to true. That keeps the alerts that already reach a phone reaching
 *   it. It is never AUTHORISATION: each category is additionally held shut by
 *   its own feature flag, and this module is a veto, not a grant. Nothing here
 *   can cause a push that was not already going to be sent.
 *
 * WHAT HAPPENS WHEN THE READ FAILS, AND WHY IT IS NOT ONE ANSWER
 *   A missing table (the migration is not applied yet) and a wobbling database
 *   are the same thing from here: the preference is UNKNOWN. That is a
 *   different question from "the person said no", and the two must not get the
 *   same answer.
 *
 *   A ROW THAT EXISTS AND SAYS FALSE IS HONOURED IN EVERY CASE, always. Nothing
 *   below can override a given answer. What follows is only about an ABSENT
 *   one.
 *
 *   The split is by WHETHER THE ALERT ALREADY EXISTED:
 *
 *     ALREADY SHIPPED — `new_customer_messages`, `missed_calls`,
 *       `campaign_proposals`, `new_releases`. These reached phones before this
 *       table did. They FAIL OPEN, loudly logged. Failing them closed would
 *       mean that deploying this code before running the migration silently
 *       switches off four working features, with no error anywhere and the only
 *       symptom being that notifications stopped. That is the worst kind of
 *       regression: invisible, and indistinguishable from the provider being
 *       down. For the two operational ones it is worse still, because a
 *       customer is waiting at the other end of an unanswered message and this
 *       code runs inside Telnyx webhook processing. It is the same judgement
 *       `withoutDeactivatedOwners()` already makes on the same path.
 *
 *     NEW WITH THIS TABLE — `daily_digest` and `referrals`. They FAIL CLOSED.
 *       They ship with their migration, so an unreadable preference means the deploy is half done,
 *       and there is nothing to regress because it has never sent anything. If
 *       the server cannot establish that a person wants a summary of segment
 *       movement, it does not wake them for it.
 *
 *   The window this trades against is short and it ends: once the migration is
 *   applied the read succeeds and every toggle does exactly what it says.
 *
 * SUPABASE RULES THIS FILE OBEYS, ALL THREE OF WHICH HAVE CAUSED AN OUTAGE HERE
 *   1. A query builder is a thenable with `then` only. No `.catch()` on one:
 *      try/catch around the await, then check `error`.
 *   2. No unbounded `.in()`. The one below is over a slice capped at
 *      IN_CHUNK_SIZE.
 *   3. An unpaged read caps silently at 1000 rows. This one is bounded by the
 *      caller's id list, which is chunked, so there is no unpaged full scan.
 */

const { IN_CHUNK_SIZE } = require('../fetch-all-rows');

const TABLE = 'sms_user_notification_preferences';

/**
 * The closed list. Order is the order the Settings screen shows them in, most
 * interrupting first.
 */
const NOTIFICATION_CATEGORIES = Object.freeze([
  Object.freeze({
    key: 'new_customer_messages',
    label: 'New customer messages',
    detail: 'A banner when somebody texts the business number.'
  }),
  Object.freeze({
    key: 'missed_calls',
    label: 'Missed calls',
    // Said plainly because the alternative is a switch that appears to silence
    // a ringing phone and does not. CallKit presents the call; we only own the
    // badge.
    detail: 'Count missed calls towards the app badge. Calls still ring through the iPhone calling system.'
  }),
  Object.freeze({
    key: 'daily_digest',
    label: 'Daily summary',
    detail: 'Once a day, only when a segment moved enough to matter.'
  }),
  Object.freeze({
    key: 'campaign_proposals',
    label: 'Campaigns ready to review',
    detail: 'When a draft or a proposal is waiting for a decision.'
  }),
  Object.freeze({
    key: 'referrals',
    label: 'Conversation referrals',
    detail: 'When a teammate assigns you a customer conversation or returns one to you.'
  }),
  Object.freeze({
    key: 'new_releases',
    label: 'New releases',
    detail: 'When a new build of this app is available.'
  })
]);

const CATEGORY_KEYS = Object.freeze(NOTIFICATION_CATEGORIES.map(entry => entry.key));

/**
 * What an UNKNOWN answer means, per category. See the header.
 * `open` = deliver anyway. `closed` = hold it.
 */
const CATEGORY_FAILURE_MODE = Object.freeze({
  new_customer_messages: 'open',
  missed_calls: 'open',
  // These categories shipped with their preference gates. Nothing to regress.
  daily_digest: 'closed',
  campaign_proposals: 'open',
  referrals: 'closed',
  new_releases: 'open'
});

/** Every category on, which is what an account with no row means. */
function defaultPreferences() {
  const out = {};
  for (const key of CATEGORY_KEYS) out[key] = true;
  return out;
}

function isCategory(value) {
  return CATEGORY_KEYS.includes(String(value || ''));
}

/**
 * Postgres hands a bigint back as a number and callers pass strings. Every
 * comparison in this module is on the string form, for the same reason
 * `normaliseUserID` exists in lib/apns-notify.js: a `===` between 7 and '7'
 * silently matches nobody and the symptom is "the toggle does nothing".
 */
function normaliseUserID(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

/** A stored row -> the wire shape. A NULL column resolves to the default. */
function shapePreferences(row) {
  const out = defaultPreferences();
  if (!row) return out;
  for (const key of CATEGORY_KEYS) {
    if (typeof row[key] === 'boolean') out[key] = row[key];
  }
  return out;
}

/**
 * Only a false is a decision. Anything else — absent row, absent column, a
 * value that is not a boolean — is "no preference expressed", which resolves to
 * the default of true.
 */
function optedOut(preferences, category) {
  return preferences?.[category] === false;
}

function missingRelation(error) {
  if (!error) return false;
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return true;
  return /does not exist|could not find|schema cache/i.test(String(error.message || ''));
}

/**
 * Preferences for a bounded set of accounts.
 *
 * Never throws. It reports `available: false` and an empty map when the answer
 * could not be read, and the CALLER decides what unknown means for the category
 * it is about to send. Throwing would put a preferences read on the failure
 * path of an inbound customer message, which is exactly backwards.
 *
 * @param {object} options
 * @param {object} options.client   Supabase client
 * @param {Array}  options.userIDs
 * @returns {Promise<{available: boolean, byUser: Map<string, object>,
 *                    reason: string|null}>}
 */
async function readPreferences({ client, userIDs = [] } = {}) {
  const ids = [...new Set((userIDs || []).map(normaliseUserID).filter(Boolean))];
  if (!ids.length) return { available: true, byUser: new Map(), reason: null };
  if (!client) return { available: false, byUser: new Map(), reason: 'no_client' };

  const byUser = new Map();
  for (let index = 0; index < ids.length; index += IN_CHUNK_SIZE) {
    // Bounded: the slice is capped at IN_CHUNK_SIZE (200), far below the URL
    // limit that took the inbox down at 907 values.
    const chunk = ids.slice(index, index + IN_CHUNK_SIZE);
    let data;
    let error;
    try {
      ({ data, error } = await client
        .from(TABLE)
        .select(`user_id, ${CATEGORY_KEYS.join(', ')}`)
        // bounded: `chunk` is a slice capped at IN_CHUNK_SIZE (200).
        .in('user_id', chunk));
    } catch (thrown) {
      return { available: false, byUser: new Map(), reason: thrown?.code || 'read_threw' };
    }
    if (error) {
      const reason = missingRelation(error) ? 'table_missing' : (error.code || 'read_failed');
      return { available: false, byUser: new Map(), reason };
    }
    for (const row of data || []) {
      const id = normaliseUserID(row.user_id);
      if (id) byUser.set(id, shapePreferences(row));
    }
  }
  return { available: true, byUser, reason: null };
}

/**
 * May this device be sent this category?
 *
 * A device with NO owner is kept. Ownership only started being recorded
 * recently and most live compatibility rows predate it; refusing them would
 * turn a preference feature into "nobody is notified at all", which is the same
 * trap `withoutDeactivatedOwners()` documents. The permission-sensitive senders
 * (campaign review, segment change, the digest) already require an owner for
 * their own reasons, so an unowned device never reaches them anyway.
 *
 * @param {object} device      a normalised row from loadDevices()
 * @param {string} category
 * @param {{available: boolean, byUser: Map}} preferences
 * @returns {boolean}
 */
function deviceAccepts(device, category, preferences) {
  const owner = normaliseUserID(device?.user_id);
  if (!owner) return true;
  if (!preferences?.available) return CATEGORY_FAILURE_MODE[category] === 'open';
  const stored = preferences.byUser.get(owner);
  // No row for a real account is "no preference expressed", not "unknown". The
  // read succeeded; the person simply never touched the screen.
  if (!stored) return true;
  return !optedOut(stored, category);
}

/**
 * Split a device list on one category.
 *
 * Returns both halves rather than only the survivors, because the message push
 * needs the excluded half too: a device whose owner turned `missed_calls` off
 * still receives the alert, with a badge that omits the missed-call count. A
 * filter that only returned the kept rows would have made that impossible to
 * express and the toggle would have had to become decorative.
 *
 * @returns {{accepted: Array, declined: Array}}
 */
function partitionDevices(devices, category, preferences) {
  const accepted = [];
  const declined = [];
  for (const device of devices || []) {
    if (deviceAccepts(device, category, preferences)) accepted.push(device);
    else declined.push(device);
  }
  return { accepted, declined };
}

/**
 * Validate a partial update from a client.
 *
 * Refuses an unknown key rather than ignoring it: a client that sends
 * `dailyDigest` instead of `daily_digest` must be told, not silently answered
 * 200 with nothing changed. Refuses a non-boolean for the same reason — "false"
 * as a string is a bug in the caller and coercing it hides the bug.
 *
 * @param {unknown} input
 * @returns {{ok: true, patch: object}|{ok: false, code: string, message: string}}
 */
function validatePreferencePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      code: 'NOTIFICATION_PREFERENCES_INVALID',
      message: 'Send an object of category names to true or false.'
    };
  }
  const keys = Object.keys(input);
  if (!keys.length) {
    return {
      ok: false,
      code: 'NOTIFICATION_PREFERENCES_EMPTY',
      message: 'Send at least one category to change.'
    };
  }
  const unknown = keys.filter(key => !isCategory(key));
  if (unknown.length) {
    return {
      ok: false,
      code: 'NOTIFICATION_PREFERENCES_UNKNOWN_CATEGORY',
      message: `Unknown notification category: ${unknown.join(', ')}. Known categories: ${CATEGORY_KEYS.join(', ')}.`
    };
  }
  const wrongType = keys.filter(key => typeof input[key] !== 'boolean');
  if (wrongType.length) {
    return {
      ok: false,
      code: 'NOTIFICATION_PREFERENCES_INVALID',
      message: `Each category must be true or false: ${wrongType.join(', ')}.`
    };
  }
  const patch = {};
  for (const key of keys) patch[key] = input[key];
  return { ok: true, patch };
}

module.exports = {
  CATEGORY_FAILURE_MODE,
  CATEGORY_KEYS,
  NOTIFICATION_CATEGORIES,
  TABLE,
  defaultPreferences,
  deviceAccepts,
  isCategory,
  missingRelation,
  normaliseUserID,
  optedOut,
  partitionDevices,
  readPreferences,
  shapePreferences,
  validatePreferencePatch
};
