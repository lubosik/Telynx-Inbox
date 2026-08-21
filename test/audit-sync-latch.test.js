'use strict';
/**
 * test/audit-sync-latch.test.js — an audit write must never wedge a feature.
 *
 * THE BUG THIS DEFENDS AGAINST
 *   Each of the three sync routes used to read:
 *
 *       syncRunning = true;
 *       await auditSyncStarted(req, 'ghl_contacts');   // no try/catch
 *       res.json({ success: true, ... });
 *       try { ... } finally { syncRunning = false; }
 *
 *   `syncRunning` is module state. If the audit write threw, the throw escaped
 *   before the try was ever entered, so the `finally` never ran and
 *   `syncRunning` stayed true FOR THE LIFE OF THE PROCESS. Every subsequent
 *   sync of any kind — GHL, WooCommerce, order statuses — answered
 *   "Sync already running" until Railway restarted the service. The caller
 *   also got a 500 instead of the acknowledgement, contradicting the docstring
 *   three lines above it.
 *
 *   The audit trail is a secondary record of what the application did. It is
 *   never allowed to be the thing that stops the application doing it.
 *
 * Offline: the sync implementations are stubbed in require.cache before the
 * router is loaded, so nothing here calls GHL, WooCommerce, or Telnyx.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Stub the sync implementations BEFORE routes/sync.js is required ────────

const syncCalls = [];

/** Seed require.cache so the router's `require` resolves to a stub. */
function stubModule(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = {
    id: resolved, filename: resolved, path: path.dirname(resolved), loaded: true, exports, children: [], paths: []
  };
}

stubModule('../sync-ghl', {
  runSync: async () => { syncCalls.push('ghl'); return { contacts: 3 }; }
});
stubModule('../sync-woocommerce', {
  runWooSync: async () => { syncCalls.push('woo'); return { orders: 2 }; },
  syncOrderStatuses: async () => { syncCalls.push('statuses'); return { fixed: 1, skipped: 0 }; }
});

const db = require('../db');
const syncRouter = require('../routes/sync');
const { logAuditSafely, AuditWriteError } = require('../lib/audit/log');

// ── Harness ────────────────────────────────────────────────────────────────

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route?.path === routePath && entry.route?.methods?.[method.toLowerCase()]);
  assert.ok(layer, `no handler for ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Every audit insert fails, as it would with the migration unapplied. */
function withFailingAudit(run) {
  const originalFrom = db.supabase.from;
  const originalError = console.error;
  const originalWarn = console.warn;
  db.supabase.from = () => { throw new Error('audit storage is unavailable'); };
  console.error = () => {};
  console.warn = () => {};
  return Promise.resolve()
    .then(run)
    .finally(() => {
      db.supabase.from = originalFrom;
      console.error = originalError;
      console.warn = originalWarn;
    });
}

function syncStatus() {
  const res = responseRecorder();
  handlerFor(syncRouter, 'GET', '/status')({}, res);
  return res.payload;
}

// ── The latch ──────────────────────────────────────────────────────────────

for (const [routePath, message, expectedCall] of [
  ['/ghl', 'GHL sync started', 'ghl'],
  ['/woocommerce', 'WooCommerce sync started', 'woo'],
  ['/statuses', 'Status sync started', 'statuses']
]) {
  test(`POST ${routePath} still acknowledges and clears the latch when every audit write fails`, async () => {
    syncCalls.length = 0;

    await withFailingAudit(async () => {
      const res = responseRecorder();
      await handlerFor(syncRouter, 'POST', routePath)({ ip: '203.0.113.9' }, res);

      // The caller is told the sync started, not handed a 500.
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.payload, { success: true, message });
    });

    // The work itself still ran.
    assert.deepEqual(syncCalls, [expectedCall]);

    // And the latch is clear, which is the whole point.
    assert.equal(syncStatus().running, false, 'a failed audit must not wedge syncRunning');
  });
}

test('a failed audit does not block the NEXT sync, which is how the wedge showed up in production', async () => {
  syncCalls.length = 0;

  await withFailingAudit(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = responseRecorder();
      await handlerFor(syncRouter, 'POST', '/ghl')({}, res);
      assert.equal(res.payload.success, true, `attempt ${attempt + 1} must not be refused`);
    }
  });

  assert.equal(syncCalls.length, 3, 'all three runs must have executed');
  assert.equal(syncStatus().running, false);
});

// ── The wrapper that makes the above possible ──────────────────────────────

test('logAuditSafely absorbs a programming error that logAudit would throw', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    // An unknown event type is a throw from buildRow, before any insert. That
    // is exactly the class of failure that escaped the old sync routes.
    const unknown = await logAuditSafely({ eventType: 'settings.sync.triggerred', summary: 'typo' });
    assert.deepEqual(unknown, { recorded: false, id: null, reason: 'threw' });

    // A reserved type throws for a different reason and must be absorbed too.
    const reserved = await logAuditSafely({ eventType: 'campaign.launched', summary: 'too early' });
    assert.equal(reserved.recorded, false);
  } finally {
    console.error = originalError;
  }
});

test('logAuditSafely does NOT absorb a consent-bearing failure', async () => {
  const originalFrom = db.supabase.from;
  const originalError = console.error;
  db.supabase.from = () => { throw new Error('audit storage is unavailable'); };
  console.error = () => {};
  try {
    await assert.rejects(
      () => logAuditSafely({ eventType: 'contact.opted_out', contactPhone: '+13055551234' }),
      error => error instanceof AuditWriteError,
      'a consent record that cannot be written must still stop the action'
    );
  } finally {
    db.supabase.from = originalFrom;
    console.error = originalError;
  }
});

// ── The shape, so a future edit cannot reintroduce the ordering ────────────

/**
 * Behavioural tests cannot catch somebody moving the audit call back above
 * res.json, because logAuditSafely no longer throws. This does: it is the
 * ordering itself that is load-bearing, not just the current wrapper.
 */
test('every sync route responds before it audits, and audits inside the try that owns the latch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.js'), 'utf8');

  for (const syncType of ['ghl_contacts', 'woocommerce_backfill', 'order_statuses']) {
    const call = `await auditSyncStarted(req, '${syncType}');`;
    const callIndex = source.indexOf(call);
    assert.ok(callIndex > -1, `${syncType} must still be audited`);

    const before = source.slice(0, callIndex);
    const responseIndex = before.lastIndexOf('res.json({ success: true');
    const tryIndex = before.lastIndexOf('  try {');

    assert.ok(responseIndex > -1, `${syncType} must acknowledge the caller`);
    assert.ok(
      responseIndex < callIndex,
      `${syncType}: res.json must come before the audit write, so an audit failure cannot cost the caller their acknowledgement`
    );
    assert.ok(
      tryIndex > responseIndex,
      `${syncType}: the audit write must sit inside the try whose finally clears syncRunning`
    );
  }

  assert.equal(
    /await logAudit\(/.test(source),
    false,
    'routes/sync.js must use logAuditSafely; a raw logAudit here can wedge syncRunning'
  );
});
