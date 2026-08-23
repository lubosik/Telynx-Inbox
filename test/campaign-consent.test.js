'use strict';
/**
 * test/campaign-consent.test.js — the promotional SMS consent ledger.
 *
 * WHAT IS BEING PROTECTED HERE
 *   `sms_consent_events` is the evidence you produce when somebody asks why you
 *   texted a person. Three properties make it worth having, and each one is a
 *   test in this file:
 *
 *     1. Every opt_in names a source AND an evidence reference. A row that
 *        cannot be traced back to a real event is worse than no row, because it
 *        looks like proof and is not. `recordOptIn` therefore refuses rather
 *        than defaulting.
 *     2. An opt_out is recorded whatever else is missing. Refusing to write a
 *        STOP for want of paperwork is indefensible, so `recordOptOut` demands
 *        only a valid phone number.
 *     3. "Never heard of this number" and "this number opted out" are different
 *        answers. `currentConsent` returns null for the first and an explicit
 *        `optedIn: false` for the second, and nothing may collapse the two.
 *
 *   The duplicate case is the fourth, quieter one: a redelivered webhook must
 *   not turn into a second withdrawal event, and it must not look like a
 *   failure either. Postgres 23505 on the dedupe index is success.
 *
 * Offline: no network and no live database. Every Supabase client below is a
 * fake, and — like the real PostgREST builder — it is a thenable with `then`
 * and nothing else, so any `.catch()` added to a builder chain in the code
 * under test would throw here exactly as it would in production.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_WORKSPACE,
  PURPOSE,
  SOURCE,
  currentConsent,
  normalisePhone,
  recordOptIn,
  recordOptOut
} = require('../lib/campaigns/consent');

const PHONE = '+15551234567';

/**
 * A fake PostgREST builder. Records what was asked of it and resolves whatever
 * `respond` returns for the recorded state.
 *
 * `then` only. No `catch`, no `finally` — see test/no-builder-catch.test.js.
 */
function builder(state, respond) {
  const self = {
    select(columns) { state.select = columns; return self; },
    eq(column, value) { state.filters.push([column, value]); return self; },
    // `cancelScheduledForCustomer()` filters queued flow types with `.in()`, so
    // the fake needs it or the ordinary-inbound path below throws a TypeError
    // into a catch and stops being the path it claims to test.
    in(column, values) { state.filters.push([column, values]); return self; },
    order(column, options) { state.orders.push([column, options]); return self; },
    limit(count) { state.limit = count; return self; },
    maybeSingle() { return Promise.resolve(respond(state)); },
    then(resolve, reject) { return Promise.resolve(respond(state)).then(resolve, reject); }
  };
  return self;
}

function fakeClient(respond = () => ({ data: null, error: null })) {
  const ops = [];
  return {
    ops,
    from(table) {
      const open = verb => payload => {
        const state = { table, verb, filters: [], orders: [], ...payload };
        ops.push(state);
        return builder(state, respond);
      };
      return {
        insert: row => open('insert')({ row }),
        upsert: (row, options) => open('upsert')({ row, options }),
        update: patch => open('update')({ patch }),
        select: columns => open('select')({ select: columns })
      };
    }
  };
}

/** A client that refuses every write with the given PostgREST error. */
function refusingClient(error) {
  return fakeClient(() => ({ data: null, error }));
}

// ── normalisePhone ──────────────────────────────────────────────────────────

test('normalisePhone accepts only the E.164 shape the CHECK constraint accepts', () => {
  // Mirrors sms_consent_phone_e164: ^\+[1-9][0-9]{7,14}$. If these two ever
  // disagree, the application starts sending rows the database will reject.
  assert.equal(normalisePhone('+15551234567'), '+15551234567');
  assert.equal(normalisePhone('  +15551234567  '), '+15551234567', 'surrounding space is trimmed');
  assert.equal(normalisePhone('+441234567890'), '+441234567890');

  for (const bad of [
    '15551234567',        // no plus
    '+05551234567',       // leading zero after the plus
    '+1555123',           // too short
    '+1555123456789012',  // too long
    '+1 555 123 4567',    // internal spaces
    '(555) 123-4567',
    '+1555123456a',
    '',
    '   ',
    null,
    undefined,
    0
  ]) {
    assert.equal(normalisePhone(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

// ── recordOptIn: attribution is not optional ────────────────────────────────

test('recordOptIn refuses a missing or blank source, and writes nothing', async () => {
  for (const source of [undefined, null, '', '   ', '\t\n']) {
    const client = fakeClient();
    const result = await recordOptIn({
      client,
      phone: PHONE,
      source,
      evidenceRef: 'woo_order:12345'
    });

    assert.deepEqual(result, { recorded: false, reason: 'source_required' },
      `source ${JSON.stringify(source)} must be refused, not defaulted`);
    assert.equal(client.ops.length, 0, 'and the refusal happens before any write');
  }
});

test('recordOptIn refuses a missing or blank evidenceRef, and writes nothing', async () => {
  // The whole point of the ledger is attributable records. A consent row whose
  // basis is not written down proves nothing in the only situation where it
  // matters, so this must be a refusal rather than a nullable column.
  for (const evidenceRef of [undefined, null, '', '   ', '\t\n']) {
    const client = fakeClient();
    const result = await recordOptIn({
      client,
      phone: PHONE,
      source: SOURCE.CHECKOUT_OPT_IN,
      evidenceRef
    });

    assert.deepEqual(result, { recorded: false, reason: 'evidence_required' },
      `evidenceRef ${JSON.stringify(evidenceRef)} must be refused`);
    assert.equal(client.ops.length, 0, 'and the refusal happens before any write');
  }
});

test('recordOptIn rejects a phone that is not E.164, and writes nothing', async () => {
  for (const phone of ['5551234567', '+0123456789', '+1 555 123 4567', '', null, undefined]) {
    const client = fakeClient();
    const result = await recordOptIn({
      client,
      phone,
      source: SOURCE.CHECKOUT_OPT_IN,
      evidenceRef: 'woo_order:12345'
    });

    assert.deepEqual(result, { recorded: false, reason: 'invalid_phone' },
      `phone ${JSON.stringify(phone)} must be refused`);
    assert.equal(client.ops.length, 0);
  }
});

test('a valid opt_in writes one fully attributed append-only row', async () => {
  const client = fakeClient();
  const result = await recordOptIn({
    client,
    phone: `  ${PHONE}  `,
    source: `  ${SOURCE.CHECKOUT_OPT_IN}  `,
    evidenceRef: '  woo_order:12345  ',
    occurredAt: '2026-08-22T10:00:00.000Z',
    metadata: { checkout_field: 'sms_optin' },
    dedupeKey: 'woo_order:12345:sms_optin',
    recordedBy: 7
  });

  assert.deepEqual(result, { recorded: true, duplicate: false });
  assert.equal(client.ops.length, 1, 'exactly one write');

  const [op] = client.ops;
  assert.equal(op.table, 'sms_consent_events');
  assert.equal(op.verb, 'insert', 'append-only: never an update or an upsert');
  assert.deepEqual(op.row, {
    workspace_id: DEFAULT_WORKSPACE,
    contact_phone: PHONE,
    event_type: 'opt_in',
    purpose: PURPOSE,
    brand_id: DEFAULT_WORKSPACE,
    source: SOURCE.CHECKOUT_OPT_IN,
    evidence_ref: 'woo_order:12345',
    occurred_at: '2026-08-22T10:00:00.000Z',
    recorded_by: 7,
    metadata: { checkout_field: 'sms_optin' },
    dedupe_key: 'woo_order:12345:sms_optin'
  });
});

test('an unparseable occurredAt falls back to now rather than writing garbage', async () => {
  // occurred_at is NOT NULL in the schema, so a bad input must not become null
  // and must not become "Invalid Date".
  const client = fakeClient();
  const before = Date.now();
  const result = await recordOptIn({
    client,
    phone: PHONE,
    source: SOURCE.MANUAL,
    evidenceRef: 'ticket:88',
    occurredAt: 'not a date'
  });
  const after = Date.now();

  assert.equal(result.recorded, true);
  const written = Date.parse(client.ops[0].row.occurred_at);
  assert.ok(Number.isFinite(written), 'a real timestamp was written');
  assert.ok(written >= before && written <= after, 'and it is now');
});

// ── The duplicate is success, not failure ───────────────────────────────────

test('a duplicate dedupe_key is recorded:true, duplicate:true — never an error', async () => {
  // A redelivered webhook or a replayed backfill must not look like a failure,
  // because a caller that treats it as one will retry forever or, worse, alarm
  // on correct behaviour.
  const byCode = refusingClient({ code: '23505', message: 'duplicate key value violates unique constraint' });
  assert.deepEqual(
    await recordOptIn({
      client: byCode, phone: PHONE, source: SOURCE.CHECKOUT_OPT_IN, evidenceRef: 'woo_order:1'
    }),
    { recorded: true, duplicate: true }
  );

  // Some PostgREST responses arrive without the code but name the index.
  const byIndexName = refusingClient({
    message: 'duplicate key value violates unique constraint "sms_consent_events_dedupe_idx"'
  });
  assert.deepEqual(
    await recordOptOut({ client: byIndexName, phone: PHONE, dedupeKey: 'inbound_stop:abc' }),
    { recorded: true, duplicate: true }
  );
});

test('a genuine write error throws with code CONSENT_WRITE_FAILED', async () => {
  // Anything that is not a duplicate is a real failure and must be loud. A
  // silently swallowed consent write is how you end up believing you have
  // evidence you do not have.
  const client = refusingClient({ code: '42501', message: 'permission denied for table sms_consent_events' });

  await assert.rejects(
    () => recordOptIn({
      client, phone: PHONE, source: SOURCE.CHECKOUT_OPT_IN, evidenceRef: 'woo_order:1'
    }),
    error => {
      assert.equal(error.code, 'CONSENT_WRITE_FAILED');
      assert.equal(error.message, 'permission denied for table sms_consent_events');
      assert.equal(error.phone, PHONE, 'the phone travels with the error for triage');
      assert.equal(error.workspace, DEFAULT_WORKSPACE);
      return true;
    }
  );

  await assert.rejects(
    () => recordOptOut({ client, phone: PHONE }),
    error => error.code === 'CONSENT_WRITE_FAILED'
  );
});

// ── recordOptOut: fewer requirements, deliberately ──────────────────────────

test('recordOptOut succeeds with no evidenceRef at all', async () => {
  // This asymmetry with recordOptIn is the point, not an oversight. We will
  // never refuse to record a STOP because we cannot say where it came from.
  const client = fakeClient();
  const result = await recordOptOut({ client, phone: PHONE });

  assert.deepEqual(result, { recorded: true, duplicate: false });
  assert.equal(client.ops.length, 1);

  const { row } = client.ops[0];
  assert.equal(row.event_type, 'opt_out');
  assert.equal(row.evidence_ref, null, 'null, not the empty string the CHECK would reject');
  assert.equal(row.source, SOURCE.INBOUND_STOP, 'and the source defaults to the inbound STOP');
  assert.equal(row.purpose, PURPOSE);
  assert.equal(row.contact_phone, PHONE);
  assert.ok(Number.isFinite(Date.parse(row.occurred_at)));
});

test('recordOptOut keeps a usable source even when the caller supplies rubbish', async () => {
  // `source` is NOT NULL with a non-empty CHECK, so a blank from a caller must
  // become the default rather than a row the database will bounce.
  for (const source of [undefined, null, '', '    ']) {
    const client = fakeClient();
    const result = await recordOptOut({ client, phone: PHONE, source });
    assert.equal(result.recorded, true);
    assert.equal(client.ops[0].row.source, SOURCE.INBOUND_STOP, `source ${JSON.stringify(source)}`);
  }
});

test('recordOptOut still refuses a phone the database could not store', async () => {
  const client = fakeClient();
  assert.deepEqual(
    await recordOptOut({ client, phone: 'not-a-number' }),
    { recorded: false, reason: 'invalid_phone' }
  );
  assert.equal(client.ops.length, 0);
});

// ── currentConsent: absence is not refusal ──────────────────────────────────

test('currentConsent returns null for a number the ledger has never seen', async () => {
  const client = fakeClient(() => ({ data: [], error: null }));
  assert.equal(await currentConsent({ client, phone: PHONE }), null);
});

test('unknown and opted-out are different answers and must never be conflated', async () => {
  // A caller that treats null as "opted out" blocks people who never said
  // anything; a caller that treats null as "opted in" texts people who did.
  // The two results must be structurally distinguishable.
  const unknown = await currentConsent({
    client: fakeClient(() => ({ data: [], error: null })),
    phone: PHONE
  });

  const optedOut = await currentConsent({
    client: fakeClient(() => ({
      data: [{
        id: 9,
        event_type: 'opt_out',
        source: SOURCE.INBOUND_STOP,
        evidence_ref: null,
        occurred_at: '2026-08-22T12:00:00.000Z'
      }],
      error: null
    })),
    phone: PHONE
  });

  assert.equal(unknown, null, 'never heard of them');
  assert.deepEqual(optedOut, {
    optedIn: false,
    source: SOURCE.INBOUND_STOP,
    evidenceRef: null,
    occurredAt: '2026-08-22T12:00:00.000Z'
  }, 'they said stop');
  assert.notDeepEqual(unknown, optedOut);
});

test('currentConsent reports a live opt_in with the basis it was granted on', async () => {
  const client = fakeClient(() => ({
    data: [{
      id: 4,
      event_type: 'opt_in',
      source: SOURCE.CHECKOUT_OPT_IN,
      evidence_ref: 'woo_order:12345',
      occurred_at: '2026-08-20T09:00:00.000Z'
    }],
    error: null
  }));

  assert.deepEqual(await currentConsent({ client, phone: PHONE }), {
    optedIn: true,
    source: SOURCE.CHECKOUT_OPT_IN,
    evidenceRef: 'woo_order:12345',
    occurredAt: '2026-08-20T09:00:00.000Z'
  });
});

test('currentConsent orders by occurred_at DESC then id DESC, and takes one row', async () => {
  // The tiebreak is not decoration. Two events can share a timestamp — a
  // backfill and a live write, or a STOP and a START in the same second — and
  // sms_consent_events_contact_time_idx is (workspace, phone, occurred_at DESC,
  // id DESC). If this ordering drifts from the SQL eligibility checks, the
  // application and the database will disagree about who is subscribed.
  const client = fakeClient(() => ({
    data: [{
      id: 2,
      event_type: 'opt_out',
      source: SOURCE.INBOUND_STOP,
      evidence_ref: null,
      occurred_at: '2026-08-22T12:00:00.000Z'
    }],
    error: null
  }));

  const result = await currentConsent({ client, phone: PHONE, workspace: 'vici' });
  assert.equal(result.optedIn, false);

  const [op] = client.ops;
  assert.equal(op.table, 'sms_consent_events');
  assert.equal(op.verb, 'select');
  assert.deepEqual(op.orders, [
    ['occurred_at', { ascending: false }],
    ['id', { ascending: false }]
  ], 'newest first, and a tie is broken by id descending');
  assert.deepEqual(op.filters, [
    ['workspace_id', 'vici'],
    ['contact_phone', PHONE]
  ], 'scoped to one workspace and one number');
  assert.equal(op.limit, 1, 'only the newest event is needed');
  assert.ok(/\bid\b/.test(op.select), 'id is selected, otherwise the tiebreak cannot be verified');
});

test('currentConsent returns null for an invalid phone without querying', async () => {
  const client = fakeClient(() => ({ data: [{ id: 1, event_type: 'opt_in' }], error: null }));
  assert.equal(await currentConsent({ client, phone: '5551234567' }), null);
  assert.equal(client.ops.length, 0, 'a number the ledger cannot hold is never looked up');
});

test('a failed read throws CONSENT_READ_FAILED rather than reporting "unknown"', async () => {
  // Degrading a read failure to null would silently reclassify every customer
  // as never-heard-of, which some callers will read as "safe to ask".
  const client = fakeClient(() => ({ data: null, error: { message: 'statement timeout' } }));
  await assert.rejects(
    () => currentConsent({ client, phone: PHONE }),
    error => error.code === 'CONSENT_READ_FAILED' && error.message === 'statement timeout'
  );
});

test('a non-default workspace is honoured on both the write and the read', async () => {
  const writer = fakeClient();
  await recordOptOut({ client: writer, phone: PHONE, workspace: 'shore' });
  assert.equal(writer.ops[0].row.workspace_id, 'shore');
  assert.equal(writer.ops[0].row.brand_id, 'shore');

  const reader = fakeClient(() => ({ data: [], error: null }));
  await currentConsent({ client: reader, phone: PHONE, workspace: 'shore' });
  assert.deepEqual(reader.ops[0].filters[0], ['workspace_id', 'shore']);
});

// ── The inbound STOP branch of routes/webhook.js ────────────────────────────
//
// There is no other behavioural test for routes/webhook.js, so the STOP branch
// is exercised here alongside the ledger it now writes to.
//
// Loading that module for real is the point: the STOP path is where two
// separate production regressions have already lived (a `.catch()` on a query
// builder, and a consent-bearing audit throw), and both were invisible to a
// unit test of the pieces. Everything it touches is reached through `db.js`, so
// one stub in the require cache makes the whole branch offline.

const crypto = require('node:crypto');
const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY ||= vapid.publicKey;
process.env.VAPID_PRIVATE_KEY ||= vapid.privateKey;

/** Swapped per test; the stub below always forwards to whatever is current. */
let activeDB = fakeClient();

/** Replace a module in the require cache. Must run BEFORE the router loads. */
function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stubModule('../db', {
  supabase: {
    from: table => activeDB.from(table),
    // The inbound path bumps two counters through RPCs inside `try {} catch {}`.
    // Leaving `rpc` undefined would make them throw and be swallowed, which is
    // indistinguishable from the path not running at all.
    rpc: async () => ({ data: null, error: null })
  },
  insertSmsMessage: async row => ({ data: row, error: null, id: 'inserted-row' }),
  verifyConnection: async () => {}
});

// The ordinary-inbound path — as opposed to the STOP branch — reaches HighLevel,
// web push, APNs and the conversation analyser. All four are network calls and
// none of them is what these tests are about, so they are replaced with
// recording stubs. Nothing else in this file's require graph consumes them.
const outbound = { ghlUpserts: 0, ghlMessages: 0, webPushes: 0, apnsPushes: 0, analyses: 0 };
stubModule('../ghl', {
  upsertContact: async () => { outbound.ghlUpserts += 1; return { contactId: 'ghl-1' }; },
  addInboundMessage: async () => { outbound.ghlMessages += 1; }
});
stubModule('../push-notify', {
  sendPushToAll: async () => { outbound.webPushes += 1; }
});
stubModule('../lib/apns-notify', {
  sendNativeMessagePush: async () => { outbound.apnsPushes += 1; }
});
stubModule('../intelligence', {
  analyseConversation: async () => { outbound.analyses += 1; }
});

const webhookRouter = require('../routes/webhook');

/** The single POST /telnyx handler, pulled straight off the Express router. */
function telnyxHandler(broadcastSSE) {
  const router = webhookRouter(broadcastSSE);
  const layer = router.stack.find(entry => entry.route && entry.route.path === '/telnyx');
  assert.ok(layer, 'routes/webhook.js still mounts POST /telnyx');
  return layer.route.stack[0].handle;
}

function inboundStop({ messageId = 'msg-stop-1', from = PHONE, text = 'STOP' } = {}) {
  return Buffer.from(JSON.stringify({
    data: {
      id: 'evt-1',
      event_type: 'message.received',
      occurred_at: '2026-08-22T12:00:00.000Z',
      payload: {
        id: messageId,
        from: { phone_number: from },
        text,
        received_at: '2026-08-22T12:00:00.000Z'
      }
    }
  }));
}

/**
 * A real Telnyx v2 Ed25519 signature over a real body.
 *
 * `routes/webhook.js` decides how much of an inbound message it is willing to
 * treat as fact from this alone, so the difference between "signed" and
 * "unsigned" has to be produced honestly rather than by patching the verifier.
 */
const telnyxKeys = crypto.generateKeyPairSync('ed25519');
/** Raw 32-byte key: strip the 12-byte RFC 8410 SPKI prefix, as telnyx.js expects. */
const TELNYX_TEST_PUBLIC_KEY = telnyxKeys.publicKey
  .export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

function signedHeaders(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), rawBody]);
  return {
    'telnyx-signature-ed25519': crypto.sign(null, signed, telnyxKeys.privateKey).toString('base64'),
    'telnyx-timestamp': timestamp
  };
}

/** Run `body` with TELNYX_PUBLIC_KEY set, then put the environment back. */
async function withTelnyxPublicKey(run) {
  const previous = process.env.TELNYX_PUBLIC_KEY;
  process.env.TELNYX_PUBLIC_KEY = TELNYX_TEST_PUBLIC_KEY;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = previous;
  }
}

/**
 * The ordinary-inbound path ends with `setTimeout(analyseConversation, 5000)`,
 * which the handler does not await. Left alone it keeps the event loop alive
 * for five seconds after the test has finished. Collect and cancel it instead
 * of shortening the suite by pretending the call is not made.
 */
async function withoutTrailingTimers(run) {
  const realSetTimeout = global.setTimeout;
  const pending = [];
  global.setTimeout = (...args) => {
    const handle = realSetTimeout(...args);
    pending.push(handle);
    return handle;
  };
  try {
    return await run();
  } finally {
    global.setTimeout = realSetTimeout;
    for (const handle of pending) clearTimeout(handle);
  }
}

/**
 * The STOP branch is deliberately chatty on failure. Capture the noise so a
 * deliberate failure case does not look like a broken test run.
 */
async function quietly(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await run(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * A db stub covering every table the STOP branch touches. `consentRespond` is
 * the seam each test varies.
 */
function stopBranchDB(consentRespond = () => ({ data: null, error: null })) {
  return fakeClient(state => {
    switch (state.table) {
      // The inbound-duplicate check: this message has not been seen before.
      case 'sms_messages':
        return state.verb === 'select' ? { data: null, error: null } : { data: null, error: null };
      // markOptedOut's suppression sentinel — the row isOptedOut() reads.
      case 'sms_sent_log': return { data: null, error: null };
      // The consent-bearing audit row markOptedOut writes after the sentinel.
      case 'sms_audit_log': return { data: { id: 1 }, error: null };
      case 'sms_scheduled': return { data: [], error: null };
      case 'sms_consent_events': return consentRespond(state);
      default: return { data: null, error: null };
    }
  });
}

const opsOn = (client, table) => client.ops.filter(op => op.table === table);

test('an inbound STOP appends an opt_out to the consent ledger', async () => {
  activeDB = stopBranchDB();
  const broadcasts = [];
  const handler = telnyxHandler(event => broadcasts.push(event));

  await quietly(() => handler(
    { body: inboundStop(), headers: {} },
    { sendStatus() {} }
  ));

  const consentWrites = opsOn(activeDB, 'sms_consent_events');
  assert.equal(consentWrites.length, 1, 'exactly one ledger row for one STOP');

  const { verb, row } = consentWrites[0];
  assert.equal(verb, 'insert');
  assert.equal(row.event_type, 'opt_out');
  assert.equal(row.contact_phone, PHONE);
  assert.equal(row.purpose, PURPOSE);
  assert.equal(row.source, SOURCE.INBOUND_STOP);
  assert.equal(row.dedupe_key, 'inbound_stop:msg-stop-1',
    'derived from the Telnyx message id, so a replay collides');

  // This body carried no signature, so the provider's claimed `received_at` is
  // an unverified assertion and must not become the ledger's `occurred_at` —
  // that column is what the "later opt-out wins" comparison orders on. See the
  // provenance test below for the full argument and the signed counterpart.
  assert.equal(row.metadata.signature_verified, false);
  assert.equal(row.metadata.occurred_at_source, 'server_clock');
  assert.notEqual(row.occurred_at, '2026-08-22T12:00:00.000Z');
  assert.equal(row.metadata.provider_reported_received_at, '2026-08-22T12:00:00.000Z',
    'what the caller claimed is kept, it is just not treated as fact');

  // The pre-existing work is untouched.
  assert.equal(opsOn(activeDB, 'sms_sent_log').length, 1, 'the suppression sentinel was still written');
  assert.deepEqual(broadcasts, [{ type: 'opt_out', phone: PHONE }]);
});

test('a replayed STOP webhook cannot double-write a withdrawal', async () => {
  // Telnyx redelivers, and routes/webhook.js answers 200 before it processes,
  // so the same message id can arrive more than once. The unique dedupe index
  // is what stops that becoming two events; here it reports 23505 and the
  // branch must treat it as ordinary success.
  activeDB = stopBranchDB(() => ({
    data: null,
    error: { code: '23505', message: 'duplicate key value violates unique constraint "sms_consent_events_dedupe_idx"' }
  }));
  const broadcasts = [];
  const handler = telnyxHandler(event => broadcasts.push(event));

  const { lines } = await quietly(() => handler(
    { body: inboundStop(), headers: {} },
    { sendStatus() {} }
  ));

  assert.deepEqual(broadcasts, [{ type: 'opt_out', phone: PHONE }], 'the STOP was still honoured');
  assert.equal(lines.some(line => line.includes('Consent ledger')), false,
    'a duplicate is success and must not be reported as a ledger failure');
});

test('a failing consent ledger cannot stop the STOP being honoured', async () => {
  // Same standard as the audit row above it in this branch: an unrecorded
  // suppression is a bookkeeping problem, an unhonoured STOP is a regulatory
  // one. The ledger write must not throw into the handler and must not skip
  // any of the work that follows it.
  activeDB = stopBranchDB(() => ({
    data: null,
    error: { code: '42501', message: 'permission denied for table sms_consent_events' }
  }));
  const broadcasts = [];
  const handler = telnyxHandler(event => broadcasts.push(event));

  const { lines } = await quietly(() => handler(
    { body: inboundStop(), headers: {} },
    { sendStatus() {} }
  ));

  assert.equal(opsOn(activeDB, 'sms_sent_log').length, 1, 'the suppression sentinel was written');
  assert.equal(opsOn(activeDB, 'sms_scheduled').length, 1, 'queued messages were still cancelled');
  assert.equal(opsOn(activeDB, 'sms_messages').filter(op => op.verb === 'insert').length, 1,
    'the STOP message was still recorded');
  assert.deepEqual(broadcasts, [{ type: 'opt_out', phone: PHONE }], 'and the inbox was still told');

  assert.ok(
    lines.some(line => line.includes('[OPT-OUT]') && line.includes('CONSENT_WRITE_FAILED')),
    'the failure is loud, not silent'
  );
});

test('the consent ledger write never delays the suppression work', async () => {
  // Started before the suppression and settled after the broadcast. If a future
  // edit awaits it in front of markOptedOut, the sentinel never gets written,
  // this promise never resolves, and the guard below fails the test rather than
  // hanging the run.
  let releaseLedger;
  const sentinelWritten = new Promise(resolve => { releaseLedger = resolve; });

  activeDB = fakeClient(state => {
    switch (state.table) {
      case 'sms_sent_log':
        releaseLedger();
        return { data: null, error: null };
      case 'sms_audit_log': return { data: { id: 1 }, error: null };
      case 'sms_scheduled': return { data: [], error: null };
      // Resolves only once the suppression sentinel has been written.
      case 'sms_consent_events': return sentinelWritten.then(() => ({ data: null, error: null }));
      default: return { data: null, error: null };
    }
  });

  const handler = telnyxHandler(() => {});

  // Deliberately not `quietly`: if the handler deadlocks, its promise never
  // settles, and a restore tied to it would leave console patched for the rest
  // of the file. Save and restore around the race instead.
  const originalLog = console.log;
  console.log = () => {};
  let timer = null;
  try {
    const finished = handler({ body: inboundStop(), headers: {} }, { sendStatus() {} });
    finished.then(() => {}, () => {});   // the orphan case must not go unhandled
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('the handler waited on the consent ledger before suppressing')),
        2000
      );
    });
    await Promise.race([finished, timeout]);
  } finally {
    clearTimeout(timer);
    console.log = originalLog;
  }

  const started = activeDB.ops.map(op => op.table);
  assert.ok(
    started.indexOf('sms_consent_events') < started.indexOf('sms_sent_log'),
    'the ledger write is started first and runs alongside, rather than after, the suppression'
  );
});

test('an ordinary inbound message writes nothing to the consent ledger', async () => {
  // The ledger is for withdrawals and evidenced grants. A support question is
  // neither, and promotional consent must never be inferred from an inbound.
  //
  // WHY THE SETUP LOOKS LIKE THIS
  //   The earlier version of this test made the `sms_messages` select return a
  //   row, so the handler returned at the "Duplicate message, skipping" guard
  //   and never reached `isOptOutRequest()` at all. It asserted nothing about
  //   the path in its own name: mutating the branch to
  //   `if (true || isOptOutRequest(...))` — every inbound message writing a
  //   withdrawal — left it green.
  //
  //   So the message goes all the way through. `stopBranchDB()` already answers
  //   the duplicate check with no row, and the assertions below prove the whole
  //   ordinary path really ran rather than exiting early somewhere new.
  activeDB = stopBranchDB();
  const broadcasts = [];
  const handler = telnyxHandler(event => broadcasts.push(event));

  await withoutTrailingTimers(() => quietly(() => handler(
    { body: inboundStop({ text: 'when will my order ship?' }), headers: {} },
    { sendStatus() {} }
  )));

  assert.equal(opsOn(activeDB, 'sms_consent_events').length, 0,
    'an ordinary inbound must not touch the consent ledger');

  // Proof that it was processed as an ordinary inbound and not skipped.
  assert.deepEqual(broadcasts.map(event => event.type), ['new_message'],
    'the inbox was told about a message, and nothing was broadcast as an opt_out');
  assert.equal(broadcasts[0].body, 'when will my order ship?');
  assert.equal(opsOn(activeDB, 'sms_contacts').some(op => op.verb === 'upsert'), true,
    'the contact was touched, so the handler got past the duplicate guard');

  // And proof that the suppression work did NOT run. The queue IS touched on an
  // ordinary reply, but only to cancel the hold/failed nudges, so the two are
  // told apart by the bounded flow_type filter the STOP path does not send.
  assert.equal(opsOn(activeDB, 'sms_sent_log').length, 0, 'no opt-out sentinel was written');
  const queueOps = opsOn(activeDB, 'sms_scheduled');
  assert.equal(queueOps.length, 1);
  assert.ok(queueOps[0].filters.some(([column]) => column === 'flow_type'),
    'a reply cancels the hold/failed nudges only, not the customer\'s whole queue');
});

test('the ledger records whether the STOP that produced it was authenticated', async () => {
  // routes/webhook.js processes unsigned and badly-signed bodies on purpose,
  // and that is correct: a forged STOP only ever suppresses, while a dropped
  // real one is a regulatory failure. The exposure is not the suppression, it
  // is the ROW. Anyone can POST a `message.received` with any `from` number and
  // any `received_at`, and before this the ledger stored that instant as
  // `occurred_at` with no hint that nobody had authenticated it — putting an
  // attacker-chosen timestamp straight into the column the "later opt-out wins"
  // tuple comparison orders on.
  //
  // A verified body may keep the provider's timestamp. An unverified one gets
  // server time, because the only thing we actually witnessed is its arrival.
  const body = inboundStop({ messageId: 'msg-stop-signed' });

  activeDB = stopBranchDB();
  await withTelnyxPublicKey(() => quietly(() => telnyxHandler(() => {})(
    { body, headers: signedHeaders(body) }, { sendStatus() {} }
  )));

  const [signed] = opsOn(activeDB, 'sms_consent_events');
  assert.ok(signed, 'the signed STOP was recorded');
  assert.equal(signed.row.metadata.signature_verified, true);
  assert.equal(signed.row.occurred_at, '2026-08-22T12:00:00.000Z',
    'a verified body may keep the instant the provider reported');
  assert.equal(signed.row.metadata.occurred_at_source, 'provider_reported');

  // Same body, same claimed timestamp, no signature.
  activeDB = stopBranchDB();
  const before = Date.now();
  await quietly(() => telnyxHandler(() => {})({ body, headers: {} }, { sendStatus() {} }));
  const after = Date.now();

  const [unsigned] = opsOn(activeDB, 'sms_consent_events');
  assert.ok(unsigned, 'the unsigned STOP is still recorded — a STOP is always honoured');
  assert.equal(unsigned.row.metadata.signature_verified, false);
  assert.equal(unsigned.row.metadata.occurred_at_source, 'server_clock');
  assert.equal(unsigned.row.metadata.provider_reported_received_at, '2026-08-22T12:00:00.000Z',
    'the unverified claim is retained as metadata, not promoted to fact');

  const stamped = Date.parse(unsigned.row.occurred_at);
  assert.ok(stamped >= before && stamped <= after,
    `occurred_at must be server time, got ${unsigned.row.occurred_at}`);
});

test('an unsigned STOP is still fully honoured', async () => {
  // The provenance fix above must not have become a reason to do less work for
  // an unauthenticated STOP. Suppression is unconditional.
  activeDB = stopBranchDB();
  const broadcasts = [];

  await quietly(() => telnyxHandler(event => broadcasts.push(event))(
    { body: inboundStop(), headers: {} }, { sendStatus() {} }
  ));

  assert.equal(opsOn(activeDB, 'sms_sent_log').length, 1, 'the suppression sentinel was written');
  assert.equal(opsOn(activeDB, 'sms_scheduled').length, 1, 'queued messages were cancelled');
  assert.equal(opsOn(activeDB, 'sms_consent_events').length, 1, 'the withdrawal was recorded');
  assert.deepEqual(broadcasts, [{ type: 'opt_out', phone: PHONE }]);
});
