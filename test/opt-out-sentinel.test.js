'use strict';
/**
 * test/opt-out-sentinel.test.js — the last hole in the inbound STOP branch.
 *
 * WHY THIS FILE EXISTS
 *   `flows/utils.js` stores suppression as a sentinel row in `sms_sent_log`
 *   (`order_id = 'OPTOUT_<digits>'`, `flow_type = 'opted-out'`). `isOptedOut()`
 *   reads that exact row and nothing else, and `sendAndLog()` calls
 *   `isOptedOut()` before every send. So the sentinel IS the opt-out.
 *
 *   `markOptedOut` used to log one `console.error` and return when the write
 *   failed. Three things made that a permanent, silent regulatory failure
 *   rather than a transient blip:
 *
 *     1. No retry. One transient PostgREST/network error lost the record.
 *     2. `routes/webhook.js` answers Telnyx with `res.sendStatus(200)` BEFORE
 *        processing, so the provider never redelivers the STOP.
 *     3. The failure looked exactly like the dozen ordinary `console.error`
 *        lines around it, so nothing could alarm on it.
 *
 *   The caller then cancels the currently-queued messages, which makes it look
 *   handled — but every FUTURE flow reads `isOptedOut()`, gets false, and sends
 *   to a customer who said STOP.
 *
 * Offline: no network, no live database. The Supabase client, the audit writer
 * and the alert sink are all injected.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALERT_OPT_OUT_NOT_SUPPRESSED,
  OPERATIONAL_ALERT_PREFIX,
  SENTINEL_WRITE_ATTEMPTS,
  emitOperationalAlert,
  markOptedOut
} = require('../flows/utils');

const PHONE = '+15551234567';

/**
 * A fake Supabase client whose `sms_sent_log.upsert` resolves whatever the
 * caller queued. `results` is consumed one entry per attempt.
 */
function fakeClient(results) {
  const upserts = [];
  return {
    upserts,
    from(table) {
      assert.equal(table, 'sms_sent_log', 'the sentinel lives in sms_sent_log');
      return {
        upsert(row, options) {
          upserts.push({ row, options });
          const next = results.shift();
          if (next instanceof Error) return Promise.reject(next);
          return Promise.resolve(next ?? { error: null });
        }
      };
    }
  };
}

function collectAlerts() {
  const alerts = [];
  return { alerts, alert: (code, fields) => alerts.push({ code, fields }) };
}

/** Swallow the per-attempt console.error noise these tests deliberately cause. */
async function quietly(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

test('a first-attempt success writes the sentinel once and audits it', async () => {
  const client = fakeClient([{ error: null }]);
  const audited = [];
  const { alerts, alert } = collectAlerts();

  const outcome = await markOptedOut(PHONE, {
    client,
    audit: async input => { audited.push(input); },
    alert,
    retryDelayMS: 0
  });

  assert.deepEqual(outcome, { suppressed: true, audited: true, reason: null });
  assert.equal(client.upserts.length, 1, 'no retry when the first write succeeds');
  assert.equal(client.upserts[0].row.order_id, 'OPTOUT_15551234567');
  assert.equal(client.upserts[0].row.flow_type, 'opted-out');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].eventType, 'contact.opted_out');
  assert.equal(alerts.length, 0, 'a working opt-out must not page anybody');
});

test('a transient sentinel failure is retried, and the retry is what suppresses', async () => {
  // The whole point of the retry: this customer IS opted out afterwards, and
  // nobody is woken up for a blip that healed itself.
  const client = fakeClient([
    { error: { message: 'fetch failed', code: 'ECONNRESET' } },
    { error: null }
  ]);
  const audited = [];
  const { alerts, alert } = collectAlerts();

  const { result: outcome } = await quietly(() => markOptedOut(PHONE, {
    client,
    audit: async input => { audited.push(input); },
    alert,
    retryDelayMS: 0
  }));

  assert.deepEqual(outcome, { suppressed: true, audited: true, reason: null });
  assert.equal(client.upserts.length, 2, 'the write must be retried exactly once');
  assert.equal(audited.length, 1, 'and the consent record is written after the retry');
  assert.equal(alerts.length, 0, 'a recovered write is not an alert');
});

test('a thrown rejection counts as a failed attempt and is also retried', async () => {
  // supabase-js normally reports failures in `error`, but a transport-level
  // throw must not skip the retry.
  const client = fakeClient([new Error('socket hang up'), { error: null }]);
  const { alerts, alert } = collectAlerts();

  const { result: outcome } = await quietly(() => markOptedOut(PHONE, {
    client, audit: async () => {}, alert, retryDelayMS: 0
  }));

  assert.equal(outcome.suppressed, true);
  assert.equal(client.upserts.length, 2);
  assert.equal(alerts.length, 0);
});

test('two failures raise ONE loud, greppable alert and write no audit row', async () => {
  const client = fakeClient([
    { error: { message: 'timeout', code: '57014' } },
    { error: { message: 'timeout', code: '57014' } }
  ]);
  const audited = [];
  const { alerts, alert } = collectAlerts();

  const { result: outcome } = await quietly(() => markOptedOut(PHONE, {
    client,
    audit: async input => { audited.push(input); },
    alert,
    retryDelayMS: 0
  }));

  assert.equal(client.upserts.length, SENTINEL_WRITE_ATTEMPTS);
  assert.deepEqual(outcome, {
    suppressed: false, audited: false, reason: 'sentinel_write_failed'
  });

  // No audit row. An audit row here would assert a suppression that did not
  // happen, which is worse than no row at all.
  assert.equal(audited.length, 0, 'nothing truthful to audit when the sentinel is missing');

  assert.equal(alerts.length, 1, 'exactly one alert, not one per attempt');
  assert.equal(alerts[0].code, ALERT_OPT_OUT_NOT_SUPPRESSED);
  assert.equal(alerts[0].fields.attempts, SENTINEL_WRITE_ATTEMPTS);
  assert.equal(alerts[0].fields.phone, '...4567', 'only the last four digits');
  assert.match(alerts[0].fields.impact, /NOT-suppressed/);
  assert.ok(alerts[0].fields.action, 'the alert must say what to do about it');
});

test('markOptedOut returns rather than throwing, so the caller still cancels', async () => {
  // routes/webhook.js runs cancelScheduledForCustomer() after this. That
  // cancellation is the one part of the STOP branch that still works when the
  // sentinel write is lost, so nothing here may abort the caller's flow.
  const client = fakeClient([
    { error: { message: 'down' } },
    { error: { message: 'down' } }
  ]);
  let cancelled = false;

  await quietly(async () => {
    const outcome = await markOptedOut(PHONE, {
      client, audit: async () => {}, alert: () => {}, retryDelayMS: 0
    });
    cancelled = true;
    return outcome;
  });

  assert.equal(cancelled, true, 'execution must continue past a failed sentinel write');
});

test('the alert is one line, prefixed, and distinguishable from ordinary console.error', async () => {
  // An operator has to be able to write `grep '[ALERT] SMS_OPT_OUT_NOT_SUPPRESSED'`
  // or a log-drain rule against a stable token. That is the entire difference
  // between this and the console.error it replaced.
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    emitOperationalAlert(ALERT_OPT_OUT_NOT_SUPPRESSED, {
      phone: '...4567', attempts: 2, error: 'timeout', empty: '', missing: null
    });
  } finally {
    console.error = original;
  }

  assert.equal(lines.length, 1, 'one line, so one log event');
  assert.equal(lines[0].includes('\n'), false, 'and it must not be multi-line');
  assert.ok(lines[0].startsWith(`${OPERATIONAL_ALERT_PREFIX} ${ALERT_OPT_OUT_NOT_SUPPRESSED} `));
  assert.match(lines[0], /severity=critical/);
  assert.match(lines[0], /phone=\.\.\.4567/);
  assert.match(lines[0], /attempts=2/);
  assert.equal(lines[0].includes('empty='), false, 'blank fields are omitted');
  assert.equal(lines[0].includes('missing='), false, 'null fields are omitted');
});

test('the alert prefix is unique to operational alerts across the whole repo', () => {
  // If ordinary logging starts using `[ALERT] `, an alarm built on it becomes
  // noise and gets muted. Assert the prefix stays reserved.
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');

  function walk(dir) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) return [];
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules') return [];
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(relative);
      return entry.isFile() && entry.name.endsWith('.js') ? [relative] : [];
    });
  }

  const offenders = [];
  for (const file of ['routes', 'flows', 'lib', 'sync', 'scripts'].flatMap(walk)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!text.includes('[ALERT]')) continue;
    if (file === path.join('flows', 'utils.js')) continue; // the definition site
    offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [],
    `the [ALERT] prefix must stay reserved for operational alerts; also used in: ${offenders.join(', ')}`);
});

test('no phone number is emitted in full by the opt-out failure path', async () => {
  const client = fakeClient([{ error: { message: 'x' } }, { error: { message: 'x' } }]);
  const { lines } = await quietly(() => markOptedOut(PHONE, {
    client, audit: async () => {}, alert: emitOperationalAlert, retryDelayMS: 0
  }));
  const joined = lines.join('\n');
  assert.ok(joined.length > 0, 'the failure must be logged at all');
  assert.equal(joined.includes(PHONE), false, 'never the full E.164 number');
  assert.match(joined, /4567/, 'the last four digits are enough to identify the thread');
});

test('a missing phone is a no-op, not an alert', async () => {
  const { alerts, alert } = collectAlerts();
  const outcome = await markOptedOut('', { client: fakeClient([]), alert, retryDelayMS: 0 });
  assert.deepEqual(outcome, { suppressed: false, audited: false, reason: 'no_phone' });
  assert.equal(alerts.length, 0);
});
