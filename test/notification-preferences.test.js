'use strict';
/**
 * Per-account notification preferences: the veto, and what happens when the
 * answer cannot be read.
 *
 * THE ONE PROPERTY THAT MATTERS MOST is that a stored `false` is honoured in
 * every case, on every category, whatever else is going wrong. A toggle that
 * does not actually stop the push is worse than no toggle, and the whole reason
 * the check lives at delivery in lib/apns-notify.js rather than at the five
 * call sites that decide to notify is that a future sender cannot then forget.
 *
 * THE SECOND is that an ABSENT answer is not a `false`. A missing table during
 * the window between a deploy and its migration must not silently switch four
 * working features off, and it must never silence a customer message alert on
 * the inbound webhook path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORY_FAILURE_MODE,
  CATEGORY_KEYS,
  NOTIFICATION_CATEGORIES,
  defaultPreferences,
  deviceAccepts,
  optedOut,
  partitionDevices,
  readPreferences,
  shapePreferences,
  validatePreferencePatch
} = require('../lib/notifications/preferences');

function client({ rows = null, error = null, throws = false } = {}) {
  return {
    from() {
      const state = { ids: [] };
      const builder = {
        select() { return builder; },
        in(_column, values) { state.ids = values; return builder; },
        then(onFulfilled, onRejected) {
          return Promise.resolve().then(() => {
            if (throws) throw Object.assign(new Error('boom'), { code: 'EXPLODED' });
            if (error) return { data: null, error };
            const all = rows || state.ids.map(id => ({ user_id: id, ...defaultPreferences() }));
            return { data: all, error: null };
          }).then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
}

function device(overrides = {}) {
  return { id: 1, user_id: '7', device_token: 'a', environment: 'production', ...overrides };
}

// ── The catalogue ───────────────────────────────────────────────────────────

test('the category list is closed and every entry is explained', () => {
  assert.deepEqual(CATEGORY_KEYS, [
    'new_customer_messages', 'missed_calls', 'daily_digest',
    'campaign_proposals', 'new_releases'
  ]);
  for (const entry of NOTIFICATION_CATEGORIES) {
    assert.ok(entry.label && entry.label.length > 2, `${entry.key} needs a label`);
    assert.ok(entry.detail && entry.detail.length > 20, `${entry.key} needs an explanation`);
    // The house copy rule reaches the settings screen too.
    assert.equal(entry.label.includes('—'), false);
    assert.equal(entry.detail.includes('—'), false);
  }
});

test('the missed calls row says what it actually does and does not overclaim', () => {
  // There is no server-sent missed-call alert to suppress: a call arrives as a
  // VoIP push and CallKit presents it. Saying "turn off missed call
  // notifications" would be a switch that appears to silence a ringing phone
  // and does not.
  const entry = NOTIFICATION_CATEGORIES.find(row => row.key === 'missed_calls');
  assert.match(entry.detail, /badge/i);
  assert.match(entry.detail, /still ring/i);
});

test('every category has a declared failure mode and the new one fails closed', () => {
  for (const key of CATEGORY_KEYS) {
    assert.ok(['open', 'closed'].includes(CATEGORY_FAILURE_MODE[key]), `${key} has no failure mode`);
  }
  // Everything that already reached a phone fails open, so deploying before the
  // migration cannot switch a working feature off with no error anywhere.
  assert.equal(CATEGORY_FAILURE_MODE.new_customer_messages, 'open');
  assert.equal(CATEGORY_FAILURE_MODE.missed_calls, 'open');
  assert.equal(CATEGORY_FAILURE_MODE.campaign_proposals, 'open');
  assert.equal(CATEGORY_FAILURE_MODE.new_releases, 'open');
  // The one that ships with the table has nothing to regress.
  assert.equal(CATEGORY_FAILURE_MODE.daily_digest, 'closed');
});

// ── Resolution ──────────────────────────────────────────────────────────────

test('an absent row means every category is on', () => {
  const resolved = shapePreferences(null);
  for (const key of CATEGORY_KEYS) assert.equal(resolved[key], true);
});

test('only a boolean false is a decision', () => {
  assert.equal(optedOut({ daily_digest: false }, 'daily_digest'), true);
  assert.equal(optedOut({ daily_digest: true }, 'daily_digest'), false);
  assert.equal(optedOut({}, 'daily_digest'), false);
  // A string "false" from a sloppy client is not an opt out. It is a bug, and
  // the endpoint refuses it rather than coercing it here.
  assert.equal(optedOut({ daily_digest: 'false' }, 'daily_digest'), false);
  assert.equal(shapePreferences({ daily_digest: 'false' }).daily_digest, true);
});

// ── The veto ────────────────────────────────────────────────────────────────

test('a stored false stops the push on every category', async () => {
  for (const category of CATEGORY_KEYS) {
    const preferences = await readPreferences({
      client: client({ rows: [{ user_id: '7', ...defaultPreferences(), [category]: false }] }),
      userIDs: ['7']
    });
    assert.equal(preferences.available, true);
    assert.equal(deviceAccepts(device(), category, preferences), false,
      `${category} set to false must stop the push`);
    // And it stops only that one.
    for (const other of CATEGORY_KEYS.filter(key => key !== category)) {
      assert.equal(deviceAccepts(device(), other, preferences), true);
    }
  }
});

test('the owner id is compared as a string, because Postgres returns a bigint', () => {
  // A `===` between 7 and '7' silently matches nobody, and the symptom is "the
  // toggle does nothing", which is the exact failure this feature must not have.
  const preferences = {
    available: true,
    byUser: new Map([['7', { ...defaultPreferences(), daily_digest: false }]])
  };
  assert.equal(deviceAccepts(device({ user_id: 7 }), 'daily_digest', preferences), false);
  assert.equal(deviceAccepts(device({ user_id: '7' }), 'daily_digest', preferences), false);
});

test('a device with no owner is kept, because ownership is only newly recorded', () => {
  const preferences = { available: true, byUser: new Map() };
  for (const key of CATEGORY_KEYS) {
    assert.equal(deviceAccepts(device({ user_id: null }), key, preferences), true);
  }
});

// ── Failure ─────────────────────────────────────────────────────────────────

test('a missing table is reported as not ready and is never a throw', async () => {
  const result = await readPreferences({
    client: client({ error: { code: '42P01', message: 'relation does not exist' } }),
    userIDs: ['7']
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'table_missing');
  assert.equal(result.byUser.size, 0);
});

test('a client that throws is caught, because this runs on the inbound message path', async () => {
  const result = await readPreferences({ client: client({ throws: true }), userIDs: ['7'] });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'EXPLODED');
});

test('an unreadable preference keeps existing alerts flowing and holds the new one', async () => {
  const unavailable = { available: false, byUser: new Map() };
  assert.equal(deviceAccepts(device(), 'new_customer_messages', unavailable), true);
  assert.equal(deviceAccepts(device(), 'missed_calls', unavailable), true);
  assert.equal(deviceAccepts(device(), 'campaign_proposals', unavailable), true);
  assert.equal(deviceAccepts(device(), 'new_releases', unavailable), true);
  assert.equal(deviceAccepts(device(), 'daily_digest', unavailable), false);
});

test('no accounts means no query at all', async () => {
  let queried = false;
  const spy = { from() { queried = true; return { select: () => spy, in: () => spy, then: r => r({ data: [], error: null }) }; } };
  const result = await readPreferences({ client: spy, userIDs: [] });
  assert.equal(result.available, true);
  assert.equal(queried, false, 'the hot path must not pay for an empty list');
});

// ── Partitioning ────────────────────────────────────────────────────────────

test('both halves are returned, because the badge needs the declined half too', () => {
  // Turning `missed_calls` off does not stop the message alert. It changes the
  // badge that alert carries, so the sender needs the people who said no.
  const preferences = {
    available: true,
    byUser: new Map([['8', { ...defaultPreferences(), missed_calls: false }]])
  };
  const split = partitionDevices(
    [device({ id: 1, user_id: '7' }), device({ id: 2, user_id: '8' })],
    'missed_calls', preferences
  );
  assert.deepEqual(split.accepted.map(row => row.id), [1]);
  assert.deepEqual(split.declined.map(row => row.id), [2]);
});

// ── The endpoint's input validation ─────────────────────────────────────────

test('an unknown category is refused rather than ignored', () => {
  const verdict = validatePreferencePatch({ dailyDigest: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOTIFICATION_PREFERENCES_UNKNOWN_CATEGORY');
  // The message names the accepted keys, so a client author can fix it without
  // reading the server source.
  assert.match(verdict.message, /daily_digest/);
});

test('a non boolean is refused rather than coerced', () => {
  const verdict = validatePreferencePatch({ daily_digest: 'false' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOTIFICATION_PREFERENCES_INVALID');
});

test('an empty or malformed body is refused', () => {
  assert.equal(validatePreferencePatch({}).code, 'NOTIFICATION_PREFERENCES_EMPTY');
  assert.equal(validatePreferencePatch(null).code, 'NOTIFICATION_PREFERENCES_INVALID');
  assert.equal(validatePreferencePatch([]).code, 'NOTIFICATION_PREFERENCES_INVALID');
  assert.equal(validatePreferencePatch('daily_digest').code, 'NOTIFICATION_PREFERENCES_INVALID');
});

test('a partial patch is accepted and carries only what was sent', () => {
  const verdict = validatePreferencePatch({ daily_digest: false, new_releases: true });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.patch, { daily_digest: false, new_releases: true });
});
