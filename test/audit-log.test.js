'use strict';
/**
 * test/audit-log.test.js — the writer, and the flagship call site.
 *
 * The requirement that matters is that one Admin can see which automation
 * another Admin cancelled, with before/after state. These tests exercise the
 * real DELETE /api/activity/queue/:id handler against a fake Supabase client,
 * rather than asserting on a hand-built row, so a change to the route that
 * quietly stops auditing fails here.
 *
 * Offline: no network, no live database.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const db = require('../db');
const { logAudit, AuditWriteError, diffFields, resetMissingSchemaWarning } = require('../lib/audit/log');

// ── Fake Supabase ──────────────────────────────────────────────────────────

/** A chainable stand-in for a PostgREST query builder. */
function chain(resolve) {
  const self = {
    select: () => self,
    eq: () => self,
    neq: () => self,
    lt: () => self,
    gte: () => self,
    lte: () => self,
    order: () => self,
    limit: () => self,
    insert: () => self,
    upsert: () => self,
    update: () => self,
    maybeSingle: async () => resolve(),
    then: (onFulfilled, onRejected) => Promise.resolve().then(resolve).then(onFulfilled, onRejected)
  };
  return self;
}

/**
 * @param {object} options
 * @param {object|null} options.scheduledRow  row returned by the pre-update SELECT
 * @param {object[]} options.auditRows        sink for every sms_audit_log insert
 * @param {object|null} options.auditError    error the audit insert should return
 */
function fakeClient({ scheduledRow = null, cancelledRows = null, auditRows = [], auditError = null } = {}) {
  return {
    auditRows,
    from(table) {
      if (table === 'sms_audit_log') {
        return {
          insert(row) {
            if (!auditError) auditRows.push(row);
            return chain(() => (auditError
              ? { data: null, error: auditError }
              : { data: { id: auditRows.length }, error: null }));
          }
        };
      }
      if (table === 'sms_scheduled') {
        return {
          select: () => chain(() => ({ data: scheduledRow, error: null })),
          update: () => chain(() => ({ data: cancelledRows, error: null }))
        };
      }
      return chain(() => ({ data: null, error: null }));
    }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function routeHandler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route?.methods?.[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/**
 * routes/activity.js and lib/audit/log.js both use the shared singleton client
 * from db.js, so swapping `from` on that one object redirects both.
 */
async function withFakeDatabase(client, run) {
  const originalFrom = db.supabase.from;
  db.supabase.from = client.from.bind(client);
  try { return await run(); }
  finally { db.supabase.from = originalFrom; }
}

const QUEUED_ROW = Object.freeze({
  id: 4821,
  order_id: '90210',
  phone: '+13055551234',
  flow_type: 'hold-msg2',
  message_body: 'Your order is still on hold, reply YES to release it.',
  send_at: '2026-08-22T14:00:00.000Z'
});

// ── The flagship ───────────────────────────────────────────────────────────

test('cancelling a queued automation writes exactly one audit row with actor, timing, before/after and changed fields', async () => {
  const auditRows = [];
  const client = fakeClient({ scheduledRow: { ...QUEUED_ROW }, auditRows });
  const broadcasts = [];
  require('../lib/broadcaster').setBroadcast(event => broadcasts.push(event));

  const before = Date.now();
  await withFakeDatabase(client, async () => {
    const router = require('../routes/activity');
    const res = responseRecorder();
    await routeHandler(router, 'delete', '/queue/:id')({
      params: { id: '4821' },
      actor: { id: 7, displayName: 'Dominic', role: 'admin' },
      ip: '203.0.113.9',
      get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
  });
  const after = Date.now();

  assert.equal(auditRows.length, 1, 'one cancel must produce exactly one audit row');
  const row = auditRows[0];

  assert.equal(row.event_type, 'automation.queue_item.cancelled');
  assert.equal(row.category, 'automations');
  assert.equal(row.visibility, 'feed');
  assert.equal(row.severity, 'notice');
  assert.equal(row.entity_type, 'scheduled_message');
  assert.equal(row.entity_id, '4821');

  // Actor, taken from req.actor and denormalised onto the row.
  assert.equal(row.actor_type, 'user');
  assert.equal(row.actor_user_id, 7);
  assert.equal(row.actor_display_name, 'Dominic');
  assert.equal(row.actor_role, 'admin');
  assert.equal(row.ip, '203.0.113.9');
  assert.equal(row.user_agent, 'ViciInbox/1.4 (iPhone)');

  // Timing.
  const occurred = Date.parse(row.occurred_at);
  assert.ok(occurred >= before && occurred <= after, 'occurred_at must be the moment of the action');

  // Before/after.
  assert.equal(row.previous_state.status, 'pending');
  assert.equal(row.new_state.status, 'cancelled');
  assert.equal(row.previous_state.flow_type, 'hold-msg2');
  assert.equal(row.previous_state.order_id, '90210');
  assert.deepEqual(row.changed_fields, ['status']);

  // Full phone, deliberately not the last four digits.
  assert.equal(row.contact_phone, '+13055551234');

  // The message body is referenced, never copied.
  assert.equal(row.metadata.message_length, QUEUED_ROW.message_body.length);
  assert.equal(
    row.metadata.message_digest,
    crypto.createHash('sha256').update(QUEUED_ROW.message_body, 'utf8').digest('hex')
  );
  assert.equal(row.metadata.reason, 'manual');
  assert.equal(row.metadata.scheduled_id, 4821);

  const auditBroadcast = broadcasts.filter(event => event.type === 'audit_changed');
  assert.equal(auditBroadcast.length, 1);
  assert.equal(auditBroadcast[0].category, 'automations');
  assert.equal(typeof auditBroadcast[0].id, 'number');
  // Never reuse the analytics event: an open Analytics tab would refetch the
  // whole revenue overview every time somebody cancelled a queued SMS.
  assert.equal(broadcasts.some(event => event.type === 'analytics_changed'), false);

  require('../lib/broadcaster').setBroadcast(null);
});

test('no message body reaches the audit row, asserted on the serialised JSON', async () => {
  const auditRows = [];
  const client = fakeClient({ scheduledRow: { ...QUEUED_ROW }, auditRows });
  await withFakeDatabase(client, async () => {
    const router = require('../routes/activity');
    await routeHandler(router, 'delete', '/queue/:id')({ params: { id: '4821' } }, responseRecorder());
  });

  const serialised = JSON.stringify(auditRows[0]);
  assert.equal(serialised.includes(QUEUED_ROW.message_body), false, 'the body must never be stored');
  assert.equal(serialised.includes('still on hold'), false);
  assert.equal(serialised.includes('message_body'), false);
});

test('a cancel still succeeds when the audit table is missing', async () => {
  resetMissingSchemaWarning();
  const client = fakeClient({
    scheduledRow: { ...QUEUED_ROW },
    auditError: { code: '42P01', message: 'relation "sms_audit_log" does not exist' }
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    await withFakeDatabase(client, async () => {
      const router = require('../routes/activity');
      const res = responseRecorder();
      await routeHandler(router, 'delete', '/queue/:id')({ params: { id: '4821' } }, res);
      assert.equal(res.statusCode, 200, 'audit failure must not break the cancel');
      // Second cancel: the missing-schema warning must not repeat.
      await routeHandler(router, 'delete', '/queue/:id')({ params: { id: '4821' } }, responseRecorder());
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'the missing-table warning is emitted exactly once');
});

test('an absent req.actor falls back to the legacy team actor rather than blocking the write', async () => {
  const auditRows = [];
  const client = fakeClient({ scheduledRow: { ...QUEUED_ROW }, auditRows });
  await withFakeDatabase(client, async () => {
    const router = require('../routes/activity');
    await routeHandler(router, 'delete', '/queue/:id')({ params: { id: '4821' } }, responseRecorder());
  });
  assert.equal(auditRows[0].actor_display_name, 'Team');
  assert.equal(auditRows[0].actor_role, 'legacy');
  assert.equal(auditRows[0].actor_user_id, null);
});

// ── Writer rules ───────────────────────────────────────────────────────────

test('campaign.launched remains reserved until a real delivery worker exists', async () => {
  const auditRows = [];
  const client = fakeClient({ auditRows });
  await assert.rejects(
    () => logAudit({ eventType: 'campaign.launched', summary: 'x' }, { client, broadcast: () => {} }),
    error => error instanceof AuditWriteError && /reserved/i.test(error.message)
  );
  assert.equal(auditRows.length, 0);
});

test('an unknown event type throws rather than silently writing nothing', async () => {
  const client = fakeClient({});
  await assert.rejects(
    () => logAudit({ eventType: 'automation.queue_item.canceled', summary: 'typo' }, { client, broadcast: () => {} }),
    error => error instanceof AuditWriteError && /Unknown audit event type/.test(error.message)
  );
});

test('a consent-bearing write failure propagates while an ordinary one is swallowed', async () => {
  const auditError = { code: 'XX000', message: 'connection reset' };

  await assert.rejects(
    () => logAudit({
      eventType: 'contact.opted_out',
      actorType: 'system',
      contactPhone: '+13055551234',
      summary: 'Customer replied STOP'
    }, { client: fakeClient({ auditError }), broadcast: () => {} }),
    error => error instanceof AuditWriteError && error.code === 'AUDIT_WRITE_FAILED'
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await logAudit({
      eventType: 'automation.queue_item.scheduled',
      actorType: 'system',
      entityId: 1,
      summary: 'Queued'
    }, { client: fakeClient({ auditError }), broadcast: () => {} });
    assert.deepEqual(result, { recorded: false, id: null, reason: 'write_failed' });
  } finally {
    console.error = originalError;
  }
});

test('a fingerprint collision is treated as already recorded, not as a consent failure', async () => {
  const result = await logAudit({
    eventType: 'contact.opted_out',
    actorType: 'system',
    contactPhone: '+13055551234',
    fingerprint: 'contact.opted_out:+13055551234',
    summary: 'Customer replied STOP'
  }, {
    client: fakeClient({ auditError: { code: '23505', message: 'duplicate key value' } }),
    broadcast: () => {}
  });
  assert.deepEqual(result, { recorded: false, id: null, reason: 'duplicate' });
});

test('the system actor is used for webhook and cron call sites', async () => {
  const auditRows = [];
  await logAudit({
    eventType: 'automation.queue_item.scheduled',
    actorType: 'system',
    entityId: 12,
    summary: 'Queued a hold reminder'
  }, { client: fakeClient({ auditRows }), broadcast: () => {} });
  assert.equal(auditRows[0].actor_type, 'system');
  assert.equal(auditRows[0].actor_display_name, 'Automation');
  assert.equal(auditRows[0].visibility, 'detail');
});

test('diffFields reports only the fields that actually changed', () => {
  assert.deepEqual(
    diffFields({ status: 'pending', flow_type: 'hold-msg2' }, { status: 'cancelled', flow_type: 'hold-msg2' }),
    ['status']
  );
  assert.deepEqual(diffFields({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffFields({ a: 1 }, { a: 1, b: 2 }), ['b']);
});

// ── Bulk cancels ───────────────────────────────────────────────────────────

test('a bulk cancel produces ONE summary row, not one row per cancelled message', async () => {
  const cancelledRows = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    phone: '+13055551234',
    flow_type: index % 2 ? 'hold-msg1' : 'failed-msg2'
  }));
  const auditRows = [];
  const client = fakeClient({ cancelledRows, auditRows });

  const originalLog = console.log;
  console.log = () => {};
  let count;
  try {
    await withFakeDatabase(client, async () => {
      const { cancelScheduledForCustomer } = require('../flows/utils');
      count = await cancelScheduledForCustomer('+13055551234');
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(count, 12);
  assert.equal(auditRows.length, 1, 'twelve cancelled messages must not become twelve feed rows');

  const row = auditRows[0];
  assert.equal(row.event_type, 'automation.queue_item.bulk_cancelled');
  assert.equal(row.entity_type, 'scheduled_message_set');
  assert.equal(row.actor_type, 'system');
  assert.equal(row.actor_display_name, 'Automation');
  assert.equal(row.contact_phone, '+13055551234');
  assert.equal(row.metadata.cancelled_count, 12);
  assert.equal(row.metadata.scheduled_ids.length, 12);
  assert.equal(row.metadata.scheduled_ids_truncated, false);
  assert.deepEqual(row.metadata.flow_types.sort(), ['failed-msg2', 'hold-msg1']);
  assert.deepEqual(row.changed_fields, ['status']);
});

test('a very large bulk cancel caps its id list at 200 and says so', async () => {
  const cancelledRows = Array.from({ length: 640 }, (_, index) => ({
    id: index + 1,
    phone: '+13055551234',
    flow_type: 'hold-msg1'
  }));
  const auditRows = [];
  const client = fakeClient({ cancelledRows, auditRows });

  const originalLog = console.log;
  console.log = () => {};
  try {
    await withFakeDatabase(client, async () => {
      const { cancelScheduled } = require('../flows/utils');
      await cancelScheduled('90210');
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(auditRows.length, 1);
  const row = auditRows[0];
  assert.equal(row.metadata.cancelled_count, 640);
  assert.equal(row.metadata.scheduled_ids.length, 200);
  assert.equal(row.metadata.scheduled_ids_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(row.metadata), 'utf8') <= 8 * 1024);
  assert.equal(row.entity_id, '90210');
});

test('a bulk cancel that touches several customers records no single contact', async () => {
  const cancelledRows = [
    { id: 1, phone: '+13055551234', flow_type: 'hold-msg1' },
    { id: 2, phone: '+13055559999', flow_type: 'hold-msg1' }
  ];
  const auditRows = [];
  const client = fakeClient({ cancelledRows, auditRows });

  const originalLog = console.log;
  console.log = () => {};
  try {
    await withFakeDatabase(client, async () => {
      const { cancelScheduled } = require('../flows/utils');
      await cancelScheduled('90211');
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(auditRows[0].contact_phone, null);
});

test('nothing cancelled means nothing audited', async () => {
  const auditRows = [];
  const client = fakeClient({ cancelledRows: [], auditRows });
  await withFakeDatabase(client, async () => {
    const { cancelScheduled } = require('../flows/utils');
    await cancelScheduled('90212');
  });
  assert.equal(auditRows.length, 0);
});

test('an opt-out is consent-bearing: it is fingerprinted, and a failed write stops the flow', async () => {
  const auditRows = [];
  const { markOptedOut } = require('../flows/utils');

  await withFakeDatabase(fakeClient({ auditRows }), () => markOptedOut('+13055551234'));
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].event_type, 'contact.opted_out');
  assert.equal(auditRows[0].fingerprint, 'contact.opted_out:+13055551234');
  assert.equal(auditRows[0].contact_phone, '+13055551234');
  assert.equal(auditRows[0].previous_state.sms_opted_out, false);
  assert.equal(auditRows[0].new_state.sms_opted_out, true);

  const failing = fakeClient({ auditError: { code: 'XX000', message: 'connection reset' } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      () => withFakeDatabase(failing, () => markOptedOut('+13055551234')),
      error => error instanceof AuditWriteError
    );
  } finally {
    console.error = originalError;
  }
});

// ── The `inet` column ──────────────────────────────────────────────────────

/**
 * `ip` is a Postgres `inet`. Anything malformed is rejected with 22P02, and
 * because the column is on the same INSERT as everything else, that does not
 * degrade to "a row with a null ip" — it loses the entire audit row.
 *
 * The previous check was /^[0-9a-fA-F:.]+$/, which is a character class, not a
 * validator. Every value below satisfies it and every one of them is refused
 * by Postgres. node:net.isIP() is the actual parser.
 */
test('a malformed client IP is dropped rather than sent to an inet column', async () => {
  const { buildRow } = require('../lib/audit/log');

  const malformed = [
    'aaaa',           // passes a hex character class, is not an address
    '1.2.3.4.5.6',    // five octets too many
    '::::',           // not a valid IPv6 form
    '....',           // punctuation only
    'ffff',           // bare hex, no separators
    '256.256.256.256',// in range for the character class, out of range for IPv4
    '1.2.3',          // truncated
    ':',
    '.',
    ''
  ];
  for (const candidate of malformed) {
    const { row } = buildRow({ eventType: 'contact.created', ip: candidate });
    assert.equal(row.ip, null, `${JSON.stringify(candidate)} must not reach an inet column`);
  }

  // And the addresses that ARE valid must still be recorded, including the
  // IPv4-mapped IPv6 form Express hands over behind a proxy.
  const valid = ['203.0.113.9', '::1', '2001:db8::8a2e:370:7334', '::ffff:127.0.0.1', '0.0.0.0'];
  for (const candidate of valid) {
    const { row } = buildRow({ eventType: 'contact.created', ip: candidate });
    assert.equal(row.ip, candidate, `${candidate} is a valid address and must be kept`);
  }

  // Surrounding whitespace is trimmed, not treated as a rejection.
  assert.equal(buildRow({ eventType: 'contact.created', ip: '  203.0.113.9  ' }).row.ip, '203.0.113.9');
});

// ── State snapshots get the hard rules too ─────────────────────────────────

/**
 * previous_state and new_state are returned verbatim by GET /api/audit and
 * land in a table with REVOKE DELETE and an immutability trigger. The
 * allowlist cannot cover them — a snapshot's keys are the source row's columns
 * — but the three unconditional screens must still apply, or the first call
 * site that snapshots a recording URL or a SIP password burns it in forever.
 */
test('a signed recording URL never reaches a state snapshot', () => {
  const { sanitiseState } = require('../lib/audit/log');

  const state = sanitiseState({
    call_log_id: 42,
    recording_url: 'https://project.supabase.co/storage/v1/object/sign/call-recordings/x.mp3?token=eyJhbGciOi',
    provider_url: 'https://media.telnyx.com/abc123.mp3',
    s3_url: 'https://bucket.s3.amazonaws.com/x.mp3?X-Amz-Signature=deadbeef',
    recording_archived: true
  });

  assert.deepEqual(Object.keys(state).sort(), ['call_log_id', 'recording_archived']);
  const serialised = JSON.stringify(state);
  assert.equal(serialised.includes('token='), false);
  assert.equal(serialised.includes('media.telnyx.com'), false);
  assert.equal(serialised.includes('X-Amz-Signature'), false);
});

test('a live configured secret never reaches a state snapshot, under any key name', () => {
  const { sanitiseState } = require('../lib/audit/log');
  const env = { TELNYX_IOS_SIP_PASSWORD: 'sip-Pa55word-not-for-the-audit-log' };

  const state = sanitiseState({
    login: 'vici_ios_agent',
    // Innocuous key name, secret value. Only the value screen can catch this.
    note: `rotated to ${env.TELNYX_IOS_SIP_PASSWORD}`,
    // Nested one level down, which is where it is most likely to hide.
    credential_snapshot: { detail: env.TELNYX_IOS_SIP_PASSWORD },
    dedicated_ios_pair: true
  }, { env });

  assert.deepEqual(Object.keys(state).sort(), ['dedicated_ios_pair', 'login']);
  assert.equal(JSON.stringify(state).includes(env.TELNYX_IOS_SIP_PASSWORD), false);
});

test('a secret-shaped key is dropped from a state snapshot even when its value is harmless', () => {
  const { sanitiseState } = require('../lib/audit/log');

  const state = sanitiseState({
    role: 'admin',
    password_hash: 'scrypt$1$abc$def',
    api_key: 'not-actually-configured',
    session_epoch: 4,
    must_change_password: true,
    is_active: false
  });

  assert.deepEqual(Object.keys(state).sort(), ['is_active', 'role']);
  assert.equal(JSON.stringify(state).includes('scrypt$1$abc$def'), false);
});

test('the state screen leaves ordinary snapshots completely alone', () => {
  const { sanitiseState } = require('../lib/audit/log');

  const before = { id: 4821, order_id: '90210', flow_type: 'hold-msg2', status: 'pending', attempts: 0 };
  assert.deepEqual(sanitiseState(before), before);
  assert.deepEqual(sanitiseState({ sms_opted_out: false }), { sms_opted_out: false });
  assert.deepEqual(sanitiseState({ role: 'agent' }), { role: 'agent' });
});

test('a screened state value is dropped before changed_fields is computed, so it cannot leak by name either', () => {
  const { buildRow } = require('../lib/audit/log');
  const env = { INBOX_PASSWORD: 'the-shared-inbox-password' };

  const { row } = buildRow({
    eventType: 'contact.updated',
    env,
    previousState: { source: 'ghl', note: env.INBOX_PASSWORD },
    newState: { source: 'manual', note: 'changed' }
  });

  assert.deepEqual(row.previous_state, { source: 'ghl' });
  assert.deepEqual(row.new_state, { source: 'manual', note: 'changed' });
  assert.equal(JSON.stringify(row).includes(env.INBOX_PASSWORD), false);
});

test('a table that exists and refuses the write still hard-fails a consent event', async () => {
  // The classifier used to be `code in MISSING_SCHEMA_CODES || /sms_audit_log/i`.
  // Postgres names the relation in RLS, permission and constraint errors too, so
  // every one of those read as "migration not applied": the consent-bearing hard
  // failure was disarmed in exactly the cases it exists for, and the operator was
  // told to apply a migration that was already applied.
  //
  // The previous positive control here used `connection reset`, a message that
  // happens not to name the table — so it passed either way and proved nothing.
  const { markOptedOut } = require('../flows/utils');
  const refusals = [
    { code: '42501', message: 'new row violates row-level security policy for table "sms_audit_log"' },
    { code: '42501', message: 'permission denied for table sms_audit_log' },
    { code: '23514', message: 'new row for relation "sms_audit_log" violates check constraint' },
    { code: '23502', message: 'null value in column "summary" of relation "sms_audit_log"' }
  ];

  for (const error of refusals) {
    resetMissingSchemaWarning();
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        () => withFakeDatabase(fakeClient({ auditError: error }),
                               () => markOptedOut('+15550001111')),
        err => err instanceof AuditWriteError,
        `${error.code} names the table but is a refusal, not an absence: it must not fail open`
      );
    } finally {
      console.error = originalError;
    }
  }
});

test('a genuinely absent table fails open so an out-of-order deploy cannot break a STOP', async () => {
  const { markOptedOut } = require('../flows/utils');
  for (const error of [
    { code: '42P01', message: 'relation "sms_audit_log" does not exist' },
    { code: 'PGRST205', message: 'Could not find the table public.sms_audit_log in the schema cache' }
  ]) {
    resetMissingSchemaWarning();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // Must NOT throw: an unapplied migration is an operator sequencing
      // problem, and throwing here kills the inbound STOP branch.
      await withFakeDatabase(fakeClient({ auditError: error }),
                             () => markOptedOut('+15550001111'));
    } finally {
      console.warn = originalWarn;
    }
  }
});
