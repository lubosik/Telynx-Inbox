'use strict';
/**
 * Offline tests for lib/apns-notify.js.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR A DATABASE. `../db` is replaced in the
 * require cache before lib/apns-notify.js is loaded, so the real Supabase
 * client is never constructed — including the one lib/missed-calls.js captures
 * at module load, which is otherwise reachable from a message push. Every APNs
 * connection is a fake, so no notification can reach a real iPhone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Replace ../db before anything requires it ────────────────────────────────
let activeDB = null;
const databaseModulePath = require.resolve('../db');
require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: {
    supabase: { from: table => activeDB.from(table) },
    verifyConnection: async () => {},
    insertSmsMessage: async () => ({ id: 1 })
  }
};

// ── APNs provider credentials: a throwaway P-256 key, generated in-process ───
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const TEST_P8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.APNS_KEY_ID = 'TESTKEYID1';
process.env.APNS_TEAM_ID = 'TESTTEAMID';
process.env.APNS_KEY_P8_BASE64 = Buffer.from(TEST_P8).toString('base64');

const {
  sendNativeMessagePush,
  sendReleaseNotification,
  loadDevices,
  deliver,
  sendOne,
  apnsHost,
  collapseIdentifier,
  resetProviderTokenCache,
  resetMissingConfigurationLog
} = require('../lib/apns-notify');

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A Supabase stand-in that records every operation. `errors` may hold an Error
 * per table (or a function of the operation) so a missing table can be
 * simulated exactly the way PostgREST reports one.
 */
function makeSupabase({ tables = {}, errors = {}, counts = {} } = {}) {
  const ops = [];

  function from(table) {
    const op = { table, action: 'select', columns: null, filters: [], range: null, values: null };
    const builder = {
      select(columns) { op.action = 'select'; op.columns = columns; return builder; },
      delete() { op.action = 'delete'; return builder; },
      update(values) { op.action = 'update'; op.values = values; return builder; },
      upsert(values) { op.action = 'upsert'; op.values = values; return builder; },
      eq(column, value) { op.filters.push(['eq', column, value]); return builder; },
      neq(column, value) { op.filters.push(['neq', column, value]); return builder; },
      is(column, value) { op.filters.push(['is', column, value]); return builder; },
      like(column, value) { op.filters.push(['like', column, value]); return builder; },
      not(column, operator, value) { op.filters.push(['not', column, operator, value]); return builder; },
      order() { return builder; },
      limit(value) { op.limit = value; return builder; },
      range(from_, to) { op.range = [from_, to]; return builder; },
      then(onFulfilled, onRejected) {
        return Promise.resolve().then(() => {
          ops.push(op);
          const failure = typeof errors[table] === 'function' ? errors[table](op) : errors[table];
          if (failure) return { data: null, error: failure, count: null };
          if (op.action !== 'select') return { data: null, error: null };
          const rows = tables[table] || [];
          const [start, end] = op.range || [0, rows.length - 1];
          return { data: rows.slice(start, end + 1), error: null, count: counts[table] ?? rows.length };
        }).then(onFulfilled, onRejected);
      }
    };
    return builder;
  }

  return { from, ops };
}

/** PostgREST's shape for "this table does not exist". */
function missingTable(name) {
  return { message: `relation "public.${name}" does not exist`, code: '42P01' };
}

function device(overrides = {}) {
  return {
    id: 1,
    device_token: 'a'.repeat(64),
    environment: 'production',
    bundle_id: 'com.vicipeptides.inbox',
    user_id: null,
    app_build: '21',
    user_agent: 'Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0',
    storage: 'dedicated',
    ...overrides
  };
}

/** Records which hosts were connected to and never opens a socket. */
function makeConnector(hosts) {
  return host => {
    hosts.push(host);
    return { on() {}, close() {} };
  };
}

/** A stand-in for sendOne. It is the only place a real push could originate. */
function makeSender(results, captured = []) {
  let index = 0;
  return async (_client, row, authorization, payload, extraHeaders) => {
    captured.push({ row, authorization, payload, extraHeaders });
    const result = Array.isArray(results) ? results[index] ?? results.at(-1) : results;
    index += 1;
    return typeof result === 'function' ? result(row) : result;
  };
}

/** Silences and records console output for the duration of `run`. */
async function withConsole(run) {
  const lines = { log: [], warn: [], error: [] };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  try {
    return { value: await run(), lines };
  } finally {
    Object.assign(console, original);
  }
}

test.beforeEach(() => {
  resetProviderTokenCache();
  resetMissingConfigurationLog();
  activeDB = makeSupabase();
  process.env.APNS_KEY_ID = 'TESTKEYID1';
  process.env.APNS_TEAM_ID = 'TESTTEAMID';
  process.env.APNS_KEY_P8_BASE64 = Buffer.from(TEST_P8).toString('base64');
});

// ── Environment selection ────────────────────────────────────────────────────

test('production devices go to the production host and sandbox devices to the sandbox host', async () => {
  assert.equal(apnsHost('production'), PRODUCTION_HOST);
  assert.equal(apnsHost('sandbox'), SANDBOX_HOST);
  // Anything unrecognised must not silently become sandbox: a TestFlight build
  // reports `production`, and guessing wrong means the alert is accepted by a
  // host that has never heard of the token.
  assert.equal(apnsHost(undefined), PRODUCTION_HOST);

  const hosts = [];
  const captured = [];
  const client = makeSupabase();

  await deliver(
    [device({ id: 1, environment: 'production' }), device({ id: 2, environment: 'sandbox' })],
    { aps: {} },
    {},
    { client, connect: makeConnector(hosts), send: makeSender({ status: 200 }, captured), authorization: 't' }
  );

  assert.deepEqual(hosts, [PRODUCTION_HOST, SANDBOX_HOST]);
  assert.equal(captured.length, 2);
});

test('a mixed set opens exactly two connections, not one per device', async () => {
  const hosts = [];
  const devices = [
    device({ id: 1, environment: 'production' }),
    device({ id: 2, environment: 'production' }),
    device({ id: 3, environment: 'sandbox' }),
    device({ id: 4, environment: 'sandbox' }),
    device({ id: 5, environment: 'production' })
  ];

  const { value } = await withConsole(() => deliver(devices, { aps: {} }, {}, {
    client: makeSupabase(),
    connect: makeConnector(hosts),
    send: makeSender({ status: 200 }),
    authorization: 't'
  }));

  assert.equal(hosts.length, 2);
  assert.equal(new Set(hosts).size, 2);
  assert.equal(value.sent, 5);
});

test('a single-environment set opens exactly one connection', async () => {
  const hosts = [];
  await deliver([device({ id: 1 }), device({ id: 2 })], { aps: {} }, {}, {
    client: makeSupabase(),
    connect: makeConnector(hosts),
    send: makeSender({ status: 200 }),
    authorization: 't'
  });
  assert.deepEqual(hosts, [PRODUCTION_HOST]);
});

// ── Storage fallback ─────────────────────────────────────────────────────────

test('falls back to compatibility storage and normalises the jsonb correctly', async () => {
  const client = makeSupabase({
    errors: { ios_push_devices: missingTable('ios_push_devices') },
    tables: {
      push_subscriptions: [{
        id: 77,
        endpoint: `apns://production/${'b'.repeat(64)}`,
        user_agent: 'Vici%20Inbox/20 CFNetwork/3860.700.1 Darwin/25.6.0',
        subscription: {
          type: 'ios-apns',
          deviceToken: 'b'.repeat(64),
          installationId: 'install-1',
          environment: 'production',
          bundleId: 'com.vicipeptides.inbox',
          userId: 42,
          appBuild: '20'
        }
      }]
    }
  });

  const { devices, error } = await loadDevices({ client });

  assert.equal(error, null);
  assert.deepEqual(devices, [{
    id: 77,
    device_token: 'b'.repeat(64),
    environment: 'production',
    bundle_id: 'com.vicipeptides.inbox',
    // A bigint arrives as a number; release targeting compares with === against
    // a string, so an un-normalised value would match nobody.
    user_id: '42',
    app_build: '20',
    user_agent: 'Vici%20Inbox/20 CFNetwork/3860.700.1 Darwin/25.6.0',
    storage: 'compatibility'
  }]);
});

test('malformed compatibility rows are dropped rather than sent to', async () => {
  const client = makeSupabase({
    errors: { ios_push_devices: missingTable('ios_push_devices') },
    tables: {
      push_subscriptions: [
        { id: 1, subscription: { deviceToken: 'c'.repeat(64), environment: 'production' } },
        { id: 2, subscription: { environment: 'production' } },                                // no token
        { id: 3, subscription: { deviceToken: 'd'.repeat(64), environment: 'staging' } },      // unknown env
        { id: 4, subscription: { deviceToken: 'e'.repeat(64) } },                              // no env
        { id: 5, subscription: null },                                                          // no jsonb at all
        { id: 6, subscription: { deviceToken: 'f'.repeat(64), environment: 'sandbox' } }
      ]
    }
  });

  const { devices } = await loadDevices({ client });

  assert.deepEqual(devices.map(row => row.id), [1, 6]);
  assert.ok(devices.every(row => ['sandbox', 'production'].includes(row.environment)));
});

test('a dedicated table that exists is used, and no fallback query is issued', async () => {
  const client = makeSupabase({
    tables: {
      ios_push_devices: [{
        id: 9, device_token: 'a'.repeat(64), environment: 'production',
        bundle_id: 'com.vicipeptides.inbox', user_id: 7, app_build: '21', user_agent: null
      }]
    }
  });

  const { devices } = await loadDevices({ client });

  assert.equal(devices.length, 1);
  assert.equal(devices[0].storage, 'dedicated');
  assert.equal(devices[0].user_id, '7');
  assert.ok(!client.ops.some(op => op.table === 'push_subscriptions'));
});

test('a device list is read in pages rather than truncated at a fixed limit', async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    id: i + 1, device_token: String(i).padStart(64, '0'), environment: 'production'
  }));
  const client = makeSupabase({ tables: { ios_push_devices: rows } });

  const { devices } = await loadDevices({ client });

  // The old `.limit(100)` returned 100 of these and reported no error at all.
  assert.equal(devices.length, 1200);
  assert.deepEqual(client.ops.map(op => op.range), [[0, 999], [1000, 1999]]);
});

test('a failure in both storages resolves with an error rather than throwing', async () => {
  const client = makeSupabase({
    errors: {
      ios_push_devices: missingTable('ios_push_devices'),
      push_subscriptions: { message: 'connection refused' }
    }
  });

  const { devices, error } = await loadDevices({ client });
  assert.deepEqual(devices, []);
  assert.equal(error.message, 'connection refused');
});

// ── Release payload ──────────────────────────────────────────────────────────

test('the release payload carries no badge and no phone', async () => {
  const captured = [];
  const client = makeSupabase({
    tables: {
      ios_push_devices: [
        { id: 1, device_token: 'a'.repeat(64), environment: 'production', app_build: '20' }
      ]
    }
  });

  const { value } = await withConsole(() => sendReleaseNotification(
    { belowBuild: 21, title: 'Build 21', body: 'Missed calls now sync.' },
    { client, connect: makeConnector([]), send: makeSender({ status: 200 }, captured) }
  ));

  assert.equal(value.sent, 1);
  const { payload, extraHeaders } = captured[0];

  // A release note is not an unread message. A badge here would overwrite the
  // operator's real inbox/missed-call count with a number that means nothing.
  assert.ok(!('badge' in payload.aps), 'aps.badge must be absent from a release payload');
  // The iOS tap handler keys off `phone` and would try to open a conversation.
  assert.ok(!('phone' in payload), 'a release payload must not carry a top-level phone');
  assert.equal(payload.aps['thread-id'], 'vici-release');
  assert.equal(payload.screen, 'analytics');
  assert.deepEqual(payload.aps.alert, { title: 'Build 21', body: 'Missed calls now sync.' });
  // A retry must replace the banner rather than stack a second one.
  assert.equal(extraHeaders['apns-collapse-id'], 'vici-release-21');
});

test('sendReleaseNotification never computes the unread badge', async () => {
  const client = makeSupabase({
    tables: {
      ios_push_devices: [{ id: 1, device_token: 'a'.repeat(64), environment: 'production' }],
      sms_contacts: [{ unread_count: 9 }],
      call_logs: []
    }
  });

  await withConsole(() => sendReleaseNotification(
    { title: 'Build 21', body: 'Notes' },
    { client, connect: makeConnector([]), send: makeSender({ status: 200 }) }
  ));

  // Assert the query never happened, not merely that the field is absent: a
  // future edit could compute the badge and then forget to drop it.
  const touched = client.ops.map(op => op.table);
  assert.ok(!touched.includes('sms_contacts'), 'the unread count must not be queried for a release note');
  assert.ok(!touched.includes('call_logs'), 'the missed-call count must not be queried for a release note');
});

test('a message push still carries both the badge and the phone', async () => {
  const captured = [];
  activeDB = makeSupabase({ tables: { call_logs: [] }, counts: { call_logs: 2 } });
  const client = makeSupabase({
    tables: {
      ios_push_devices: [{ id: 1, device_token: 'a'.repeat(64), environment: 'production' }],
      sms_contacts: [{ unread_count: 3 }, { unread_count: 1 }]
    }
  });

  const { value } = await withConsole(() => sendNativeMessagePush(
    { title: 'Jane', body: 'Where is my order?', phone: '+15555550100' },
    { client, connect: makeConnector([]), send: makeSender({ status: 200 }, captured) }
  ));

  assert.equal(value.sent, 1);
  assert.equal(captured[0].payload.aps.badge, 6);          // 3 + 1 unread + 2 unseen missed calls
  assert.equal(captured[0].payload.phone, '+15555550100');
  assert.equal(captured[0].payload.aps['thread-id'], '+15555550100');
  assert.equal(captured[0].extraHeaders['apns-collapse-id'], undefined);
});

test('collapse ids stay inside the 64-byte APNs limit', () => {
  assert.equal(collapseIdentifier(undefined, 21), 'vici-release-21');
  assert.equal(collapseIdentifier(undefined, null), 'vici-release-note');
  assert.equal(collapseIdentifier('  custom-id  ', 5), 'custom-id');
  assert.equal(collapseIdentifier('x'.repeat(200), 5).length, 64);
});

test('sendOne sets the extra headers without letting them rewrite the request', async () => {
  const capture = {};
  const client = {
    request(headers) {
      capture.headers = headers;
      const listeners = {};
      const request = {
        setEncoding() {},
        setTimeout() {},
        on(event, handler) { listeners[event] = handler; return request; },
        end(payload) {
          capture.payload = payload;
          setImmediate(() => {
            listeners.response?.({ ':status': 200 });
            listeners.data?.('{}');
            listeners.end?.();
          });
        }
      };
      return request;
    }
  };

  const result = await sendOne(
    client,
    device({ device_token: 'abc123' }),
    'provider-token',
    { aps: {} },
    { 'apns-collapse-id': 'vici-release-21', ':path': '/3/device/hijacked', authorization: 'bearer evil' }
  );

  assert.equal(result.status, 200);
  assert.equal(capture.headers['apns-collapse-id'], 'vici-release-21');
  assert.equal(capture.headers[':path'], '/3/device/abc123');
  assert.equal(capture.headers.authorization, 'bearer provider-token');
});

// ── Targeting ────────────────────────────────────────────────────────────────

test('a dry run resolves the targets and sends nothing', async () => {
  const captured = [];
  const hosts = [];
  const client = makeSupabase({
    tables: {
      ios_push_devices: [
        { id: 1, device_token: 'a'.repeat(64), environment: 'production', user_id: 42, app_build: '20' },
        { id: 2, device_token: 'b'.repeat(64), environment: 'production', user_id: 43, app_build: '20' }
      ]
    }
  });

  const result = await sendReleaseNotification(
    { userId: '42', belowBuild: 21, title: 'Build 21', body: 'Notes', dryRun: true },
    { client, connect: makeConnector(hosts), send: makeSender({ status: 200 }, captured) }
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.sent, 0);
  assert.equal(result.targeted, 1);
  assert.equal(hosts.length, 0, 'a dry run must not open an APNs connection');
  assert.equal(captured.length, 0, 'a dry run must not send');
  assert.equal(result.targets[0].id, 1);
  // A full device token is a delivery credential; only a suffix leaves the API.
  assert.equal(result.targets[0].device_token_suffix, 'aaaaaaaa');
  assert.equal(result.targets[0].device_token, undefined);
});

test('a dry run still answers when APNs credentials are absent', async () => {
  delete process.env.APNS_KEY_ID;
  const client = makeSupabase({
    tables: { ios_push_devices: [{ id: 1, device_token: 'a'.repeat(64), environment: 'production' }] }
  });

  const result = await sendReleaseNotification({ dryRun: true }, { client });

  assert.equal(result.dryRun, true);
  assert.equal(result.targeted, 1);
  assert.equal(result.apnsConfigured, false);
});

test('a real send matching no device sends nothing and says so', async () => {
  const hosts = [];
  const client = makeSupabase({
    tables: {
      ios_push_devices: [{ id: 1, device_token: 'a'.repeat(64), environment: 'production', app_build: '21' }]
    }
  });

  const { value } = await withConsole(() => sendReleaseNotification(
    { belowBuild: 21, title: 'Build 21', body: 'Notes' },
    { client, connect: makeConnector(hosts), send: makeSender({ status: 200 }) }
  ));

  assert.equal(value.sent, 0);
  assert.equal(value.targeted, 0);
  assert.equal(hosts.length, 0);
});

// ── Missing credentials ──────────────────────────────────────────────────────

test('missing credentials disable sending and are logged at most once', async () => {
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_KEY_P8_BASE64;
  const client = makeSupabase({
    tables: { ios_push_devices: [{ id: 1, device_token: 'a'.repeat(64), environment: 'production' }] }
  });

  const { value, lines } = await withConsole(async () => {
    const first = await sendNativeMessagePush({ title: 'a', body: 'b', phone: '+1' }, { client });
    const second = await sendNativeMessagePush({ title: 'a', body: 'b', phone: '+1' }, { client });
    const third = await sendReleaseNotification({ title: 'a', body: 'b' }, { client });
    return { first, second, third };
  });

  assert.deepEqual(value.first, { sent: 0, disabled: true });
  assert.deepEqual(value.second, { sent: 0, disabled: true });
  assert.deepEqual(value.third, { sent: 0, disabled: true });
  const disabledLines = lines.log.filter(line => line.includes('provider credentials are not configured'));
  assert.equal(disabledLines.length, 1, 'the missing-credential notice must not repeat per message');
  // Nothing was read either: the check happens before any query.
  assert.equal(client.ops.length, 0);
});

// ── Invalid-token cleanup ────────────────────────────────────────────────────

for (const failure of [
  { status: 410, reason: 'Unregistered' },
  { status: 400, reason: 'BadDeviceToken' },
  { status: 410, reason: '' },
  { status: 400, reason: 'DeviceTokenNotForTopic' }
]) {
  test(`a permanently invalid token (${failure.status} ${failure.reason || 'no reason'}) is deleted from the storage it came from`, async () => {
    const dedicated = makeSupabase();
    await withConsole(() => deliver([device({ id: 11, storage: 'dedicated' })], { aps: {} }, {}, {
      client: dedicated, connect: makeConnector([]), send: makeSender(failure), authorization: 't'
    }));
    const dedicatedDelete = dedicated.ops.find(op => op.action === 'delete');
    assert.equal(dedicatedDelete.table, 'ios_push_devices');
    assert.deepEqual(dedicatedDelete.filters, [['eq', 'id', 11]]);

    const compatibility = makeSupabase();
    await withConsole(() => deliver([device({ id: 12, storage: 'compatibility' })], { aps: {} }, {}, {
      client: compatibility, connect: makeConnector([]), send: makeSender(failure), authorization: 't'
    }));
    const compatibilityDelete = compatibility.ops.find(op => op.action === 'delete');
    assert.equal(compatibilityDelete.table, 'push_subscriptions');
    assert.deepEqual(compatibilityDelete.filters, [['eq', 'id', 12]]);
  });
}

for (const transient of [
  { status: 429, reason: 'TooManyRequests' },
  { status: 503, reason: 'ServiceUnavailable' },
  { status: 0, reason: 'RequestTimeout' }
]) {
  test(`a transient failure (${transient.status} ${transient.reason}) never deletes a device`, async () => {
    const dedicated = makeSupabase();
    await withConsole(() => deliver([device({ id: 21, storage: 'dedicated' })], { aps: {} }, {}, {
      client: dedicated, connect: makeConnector([]), send: makeSender(transient), authorization: 't'
    }));
    assert.ok(!dedicated.ops.some(op => op.action === 'delete'), 'a busy provider is not a dead device');
    const noted = dedicated.ops.find(op => op.action === 'update');
    assert.equal(noted.table, 'ios_push_devices');
    assert.ok(noted.values.last_error.includes(transient.reason));

    const compatibility = makeSupabase();
    await withConsole(() => deliver([device({ id: 22, storage: 'compatibility' })], { aps: {} }, {}, {
      client: compatibility, connect: makeConnector([]), send: makeSender(transient), authorization: 't'
    }));
    assert.deepEqual(compatibility.ops, []);
  });
}

test('a partial failure is partial: three devices, one failure, two sent', async () => {
  const client = makeSupabase();
  const devices = [
    device({ id: 1, device_token: 'a'.repeat(64) }),
    device({ id: 2, device_token: 'b'.repeat(64) }),
    device({ id: 3, device_token: 'c'.repeat(64) })
  ];
  const send = makeSender([{ status: 200 }, { status: 503, reason: 'ServiceUnavailable' }, { status: 200 }]);

  const { value } = await withConsole(() => deliver(devices, { aps: {} }, {}, {
    client, connect: makeConnector([]), send, authorization: 't'
  }));

  assert.equal(value.sent, 2);
  assert.equal(value.failed, 1);
  assert.ok(!client.ops.some(op => op.action === 'delete'));
});

test('a connection error resolves rather than throwing, so webhook processing continues', async () => {
  const client = makeSupabase();
  const connect = () => { throw new Error('ECONNREFUSED api.push.apple.com'); };

  const { value, lines } = await withConsole(() => deliver(
    [device({ id: 1 }), device({ id: 2, environment: 'sandbox' })],
    { aps: {} }, {}, { client, connect, send: makeSender({ status: 200 }), authorization: 't' }
  ));

  assert.deepEqual(value, { sent: 0, failed: 2 });
  assert.equal(lines.error.filter(line => line.includes('delivery aborted')).length, 2);
});

test('a device read failure during a message push resolves with an error, never throws', async () => {
  const client = makeSupabase({
    errors: {
      ios_push_devices: missingTable('ios_push_devices'),
      push_subscriptions: { message: 'statement timeout' }
    }
  });

  const { value } = await withConsole(() => sendNativeMessagePush(
    { title: 'a', body: 'b', phone: '+1' },
    { client, connect: makeConnector([]), send: makeSender({ status: 200 }) }
  ));

  assert.deepEqual(value, { sent: 0, error: 'statement timeout' });
});
