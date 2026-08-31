'use strict';
/**
 * test/check-in-automation.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAKE SERVICE ENFORCES THE REAL STATE MACHINE, ON PURPOSE
 *
 *   The recurring way tests in this repo have been wrong is a stub written to
 *   agree with its CALLER rather than with the real CALLEE. A fake `approve`
 *   that accepts any status would have passed the first version of this
 *   automation, which called approve on a fresh draft — and the real
 *   prepareApproval throws CAMPAIGN_NOT_REVIEWABLE for anything that is not
 *   `review_required`, so every sweep would have failed forever, silently,
 *   in production only.
 *
 *   So the fake below refuses the transitions the real service refuses, and
 *   the last test in this file reads lib/campaigns/service.js to check that
 *   the statuses it refuses are still the statuses the real one refuses. If
 *   somebody widens the real precondition, that test goes red rather than the
 *   fake quietly drifting away from it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MINIMUM_LEAD_HOURS,
  SEND_HOUR_LOCAL,
  nextSendTime,
  partsInZone,
  runCheckInSweep,
  sweptRecently
} = require('../lib/campaigns/check-in-automation');

const ZONE = 'America/New_York';

// ── The fake campaign service ────────────────────────────────────────────

class FakeService {
  constructor({ failOn = null } = {}) {
    this.statuses = new Map();
    this.calls = [];
    this.failOn = failOn;
  }
  register(id) { this.statuses.set(id, 'draft'); }
  _record(name, id) { this.calls.push(`${name}:${id}`); }

  async submitReview(id) {
    this._record('submitReview', id);
    const status = this.statuses.get(id);
    // The real one accepts draft or rejected only.
    if (!['draft', 'rejected'].includes(status)) {
      throw Object.assign(new Error('Campaign is not ready to submit.'), { code: 'CAMPAIGN_NOT_SUBMITTABLE' });
    }
    this.statuses.set(id, 'review_required');
    return { campaign: { id, status: 'review_required' }, recipientCount: 3 };
  }

  async approve(id) {
    this._record('approve', id);
    if (this.failOn === id) throw Object.assign(new Error('boom'), { code: 'CAMPAIGN_PERSONALISATION_INCOMPLETE' });
    const status = this.statuses.get(id);
    // The real one accepts review_required or approval_pending only. THIS is
    // the assertion that catches an automation which skips the submit.
    if (!['review_required', 'approval_pending'].includes(status)) {
      throw Object.assign(new Error('Campaign is not awaiting approval.'), { code: 'CAMPAIGN_NOT_REVIEWABLE' });
    }
    this.statuses.set(id, 'approval_pending');
    return {
      campaign: { id, revision: 1, title: `Campaign ${id}`, final_message: 'hello' },
      recipientCount: 3, audienceHash: 'aud', messageHash: 'msg'
    };
  }

  async finalizeApproval(id, revision, proof) {
    this._record('finalizeApproval', id);
    assert.ok(proof && proof.fingerprint, 'finalizeApproval must be given audit proof');
    if (this.statuses.get(id) !== 'approval_pending') {
      throw Object.assign(new Error('not pending'), { code: 'CAMPAIGN_NOT_PENDING' });
    }
    this.statuses.set(id, 'approved');
    return { id, status: 'approved' };
  }

  async schedule(id, when) {
    this._record('schedule', id);
    if (this.statuses.get(id) !== 'approved') {
      throw Object.assign(new Error('not approved'), { code: 'CAMPAIGN_NOT_APPROVABLE' });
    }
    this.statuses.set(id, 'scheduled');
    return { id, status: 'scheduled', scheduled_for: when };
  }
}

/** A Supabase-shaped client good enough for the three reads the sweep makes. */
function fakeClient({ settings, history = [], historyError = null }) {
  return {
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; }, eq() { return chain; }, neq() { return chain; },
        gte() { return chain; }, order() { return chain; },
        limit() { return Promise.resolve({ data: history, error: historyError }); },
        maybeSingle() { return Promise.resolve({ data: settings, error: null }); },
        single() { return Promise.resolve({ data: settings, error: null }); }
      };
      return chain;
    }
  };
}

const SETTINGS = {
  workspace_id: 'vici', checkin_automation_enabled: true,
  business_timezone: ZONE, drafts_enabled: true
};

const auditOK = async ({ campaign }) => ({
  recorded: true, id: 1, fingerprint: `campaign-approved:${campaign.id}:${campaign.revision}`
});

/** A buildFromRecipe that returns a fixed result instead of reading orders. */
const build = result => async () => result;

// ── The gate ─────────────────────────────────────────────────────────────

test('the automation does nothing until it is switched on', async () => {
  const service = new FakeService();
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: { ...SETTINGS, checkin_automation_enabled: false } }),
    service, audit: auditOK
  });
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'automation_disabled');
  assert.deepEqual(service.calls, [], 'a disabled automation must not touch a campaign');
});

test('a missing settings row stops it, rather than defaulting to on', async () => {
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: null }), service: new FakeService(), audit: auditOK
  });
  assert.equal(summary.ran, false);
  assert.equal(summary.reason, 'settings_unavailable');
});

// ── Not twice ────────────────────────────────────────────────────────────

test('a second sweep in the same window does nothing', async () => {
  const service = new FakeService();
  const summary = await runCheckInSweep({
    client: fakeClient({
      settings: SETTINGS,
      history: [{ id: 'c1', title: 'Check in', status: 'scheduled', created_at: new Date().toISOString() }]
    }),
    service, audit: auditOK
  });
  assert.equal(summary.reason, 'already_swept');
  assert.equal(summary.campaignID, 'c1');
  assert.deepEqual(service.calls, []);
});

test('a check-in built by hand this week also stops the automation', async () => {
  // The sweep reads the campaigns rather than a private ledger precisely so a
  // manual build counts. A separate ledger would have let the automation add a
  // second check-in on top of one somebody had just sent.
  const found = await sweptRecently({
    client: fakeClient({
      settings: SETTINGS,
      history: [{ id: 'manual-1', status: 'sent', created_at: new Date().toISOString() }]
    }),
    workspaceID: 'vici', now: new Date()
  });
  assert.equal(found.id, 'manual-1');
});

test('an unreadable history fails closed', async () => {
  await assert.rejects(
    sweptRecently({
      client: fakeClient({ settings: SETTINGS, historyError: { message: 'connection reset' } }),
      workspaceID: 'vici', now: new Date()
    }),
    error => {
      assert.equal(error.code, 'CHECKIN_HISTORY_READ_FAILED');
      return true;
    }
  );
});

// ── The state machine ────────────────────────────────────────────────────

const ONE_DRAFT = { candidates: 40, suppressedAsDuplicate: 2, created: [{ id: 'draft-a', title: 'Check in, by product' }] };

test('the sweep walks submit, approve, audit, finalize, schedule in that order', async () => {
  const service = new FakeService();
  service.register('draft-a');
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: SETTINGS }), service, audit: auditOK, build: build(ONE_DRAFT)
  });

  assert.deepEqual(service.calls, [
    'submitReview:draft-a', 'approve:draft-a', 'finalizeApproval:draft-a', 'schedule:draft-a'
  ]);
  assert.equal(summary.reason, 'scheduled');
  assert.equal(summary.scheduled.length, 1);
  assert.equal(service.statuses.get('draft-a'), 'scheduled');
});

test('nobody due is a result, not an error', async () => {
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: SETTINGS }), service: new FakeService(), audit: auditOK,
    build: build({ candidates: 0, suppressedAsDuplicate: 0, created: [] })
  });
  assert.equal(summary.ran, true);
  assert.equal(summary.reason, 'nobody_due');
});

test('one failing variant does not strand the other', async () => {
  // The check-in splits into a named and a plain draft. The plain one going
  // out while the named one is stuck beats neither going out.
  const service = new FakeService({ failOn: 'draft-named' });
  service.register('draft-named');
  service.register('draft-plain');
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: SETTINGS }), service, audit: auditOK,
    logger: { error: () => {} },
    build: build({ candidates: 40, created: [{ id: 'draft-named', title: 'named' }, { id: 'draft-plain', title: 'plain' }] })
  });
  assert.equal(summary.scheduled.length, 1);
  assert.equal(summary.scheduled[0].id, 'draft-plain');
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].id, 'draft-named');
});

test('a refused audit stops that campaign rather than scheduling it unapproved', async () => {
  const service = new FakeService();
  service.register('draft-a');
  const summary = await runCheckInSweep({
    client: fakeClient({ settings: SETTINGS }), service,
    audit: async () => { throw new Error('audit unavailable'); },
    logger: { error: () => {} },
    build: build(ONE_DRAFT)
  });
  assert.equal(summary.scheduled.length, 0);
  assert.equal(summary.failures.length, 1);
  assert.notEqual(service.statuses.get('draft-a'), 'scheduled');
});

// ── When it sends ────────────────────────────────────────────────────────

test('the send time is noon in the business zone, never inside quiet hours', async () => {
  // Quiet hours are 20:00–09:00 New York. Sweep from a spread of instants and
  // check every answer lands at noon local.
  for (const iso of [
    '2026-01-15T03:00:00Z', '2026-01-15T14:00:00Z', '2026-01-15T23:30:00Z',
    '2026-06-15T04:00:00Z', '2026-06-15T16:45:00Z'
  ]) {
    const when = nextSendTime(new Date(iso), ZONE);
    const local = partsInZone(when, ZONE);
    assert.equal(local.hour, SEND_HOUR_LOCAL, `${iso} produced ${when.toISOString()} = ${local.hour}:00 local`);
    assert.ok(local.hour >= 9 && local.hour < 20, 'must be outside quiet hours');
  }
});

test('there is always time to cancel before it goes', async () => {
  for (const iso of ['2026-01-15T03:00:00Z', '2026-03-08T06:30:00Z', '2026-11-01T05:30:00Z']) {
    const now = new Date(iso);
    const gapHours = (nextSendTime(now, ZONE).getTime() - now.getTime()) / 3600000;
    assert.ok(gapHours >= MINIMUM_LEAD_HOURS, `${iso} left only ${gapHours.toFixed(1)}h`);
  }
});

test('noon is still noon across both daylight-saving boundaries', async () => {
  // 8 March 2026 clocks go forward, 1 November they go back. An offset baked in
  // at boot would put these an hour out, and an hour out at the edge of quiet
  // hours is the difference between legal and not.
  for (const iso of [
    '2026-03-07T12:00:00Z', '2026-03-08T12:00:00Z', '2026-03-09T12:00:00Z',
    '2026-10-31T12:00:00Z', '2026-11-01T12:00:00Z', '2026-11-02T12:00:00Z'
  ]) {
    const when = nextSendTime(new Date(iso), ZONE);
    assert.equal(partsInZone(when, ZONE).hour, SEND_HOUR_LOCAL, `broke around ${iso}`);
    assert.equal(partsInZone(when, ZONE).minute, 0);
  }
});

test('a different business zone is honoured, not assumed', async () => {
  for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata']) {
    const when = nextSendTime(new Date('2026-05-20T08:00:00Z'), zone);
    assert.equal(partsInZone(when, zone).hour, SEND_HOUR_LOCAL, `wrong hour in ${zone}`);
  }
});

// ── The fake has to keep matching the real thing ─────────────────────────

test('the real service still refuses the statuses this fake refuses', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', 'service.js'), 'utf8');

  const approve = source.slice(source.indexOf('async function prepareApproval'));
  assert.match(
    approve.slice(0, 400),
    /\['review_required', 'approval_pending'\]\.includes\(campaign\.status\)/,
    'prepareApproval no longer gates on review_required/approval_pending; the fake in this file '
    + 'is now lying, and so is every test that uses it'
  );

  const submit = source.slice(source.indexOf('async function submitReview'));
  assert.match(
    submit.slice(0, 900),
    /\.in\('status', \['draft', 'rejected'\]\)/,
    'submitReview no longer gates on draft/rejected; update the fake'
  );
});

test('the automation submits before it approves, in the source itself', () => {
  // Belt and braces for the exact production-only failure: approve() before
  // submitReview() throws CAMPAIGN_NOT_REVIEWABLE on every single sweep.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'campaigns', 'check-in-automation.js'), 'utf8'
  );
  const body = source.slice(source.indexOf('for (const draft of built.created)'));
  assert.ok(
    body.indexOf('service.submitReview(') < body.indexOf('service.approve('),
    'submitReview must be called before approve'
  );
  assert.ok(
    body.indexOf('service.finalizeApproval(') < body.indexOf('service.schedule('),
    'a campaign must be finalised before it is scheduled'
  );
});

// ── The screen has to be able to answer "is it on?" ────────────────────────

test('the route reads the last check-in, rather than querying a null workspace', async () => {
  // sweptRecently had no default workspaceID and routes/campaigns.js called it
  // without one, so the query became `.eq('workspace_id', undefined)`. That
  // matches nothing and REPORTS it as "no check-in has run" rather than
  // failing, so the screen showed no last campaign even while two were
  // scheduled. The sweep itself passed the id, which is why only the screen
  // was wrong and nothing sent twice.
  const now = new Date();
  const row = { id: 'c9', title: 'Check in', status: 'scheduled', created_at: now.toISOString() };
  const seen = {};
  const client = {
    from() {
      const chain = {
        select() { return chain; },
        eq(column, value) { seen[column] = value; return chain; },
        neq() { return chain; }, gte() { return chain; }, order() { return chain; },
        limit() { return Promise.resolve({ data: [row], error: null }); }
      };
      return chain;
    }
  };

  const found = await sweptRecently({ client, now });
  assert.equal(found.id, 'c9', 'a scheduled check-in must be found without naming the workspace');
  assert.equal(seen.workspace_id, 'vici', 'and the query must name a real workspace');
  assert.notEqual(seen.workspace_id, undefined);
});

test('the iOS switch owns its own state, so it moves when tapped', () => {
  // The switch was bound to `Binding(get: { automation.enabled }, ...)` over an
  // immutable snapshot. Tapping started an async request; SwiftUI re-read `get`
  // and got the OLD value, so the switch flicked back under the finger and
  // only settled a round trip later. The owner reported it as not working, and
  // the audit log shows five taps in a row — it had turned on the first time.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'ios', 'ViciInbox', 'UI', 'WorkspaceViews.swift'), 'utf8'
  );
  const whole = source.slice(
    source.indexOf('struct CheckInAutomationSection'),
    source.indexOf('struct AutomationQueueView')
  );
  // COMMENTS STRIPPED BEFORE MATCHING. The first version of this test failed
  // against the doc comment directly above the fix, which quotes the broken
  // binding in order to explain it. A test that reads prose and calls it code
  // has already been written once in this repo; this is the second time.
  const section = whole.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

  assert.match(whole, /@State private var isOn = false/,
    'the switch must read state this view owns, not a snapshot of the server response');
  assert.doesNotMatch(section, /get:\s*\{\s*automation\.enabled\s*\}/,
    'binding the switch straight to the fetched value is the bug');
  assert.ok(section.indexOf('isOn = wanted') < section.indexOf('await commit(wanted)'),
    'the switch must move before the request, not after it');
  assert.match(section, /isOn = !wanted/, 'and move back only if the request fails');
  // And it must say which state it is in, in words.
  assert.match(section, /ON, running every day/);
  assert.match(section, /OFF, nothing is sent/);
});
