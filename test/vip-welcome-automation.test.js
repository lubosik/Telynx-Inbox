'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { loadCampaignSettings } = require('../lib/campaigns/eligibility');
const {
  WELCOME_MESSAGE,
  dueVIPWelcomes,
  latestVIPWelcomeCampaign,
  runVIPWelcomeSweep
} = require('../lib/campaigns/vip-welcome-automation');
const {
  deliverBatch,
  vipWelcomeConversationFence
} = require('../lib/campaigns/delivery-worker');

const NOW = new Date('2026-09-26T16:00:00.000Z');

function database(tables) {
  return {
    from(table) {
      const filters = [];
      let lower = 0;
      let upper = Infinity;
      let limit = null;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push(row => row[column] === value); return query; },
        is(column, value) { filters.push(row => row[column] === value); return query; },
        in(column, values) { filters.push(row => values.includes(row[column])); return query; },
        lte(column, value) { filters.push(row => String(row[column]) <= String(value)); return query; },
        gte(column, value) { filters.push(row => String(row[column]) >= String(value)); return query; },
        order() { return query; },
        range(from, to) { lower = from; upper = to; return Promise.resolve(result()); },
        limit(value) { limit = value; return query; },
        maybeSingle() {
          const rows = result().data;
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve) { return Promise.resolve(result()).then(resolve); }
      };
      function result() {
        let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        if (limit !== null) rows = rows.slice(0, limit);
        rows = rows.slice(lower, upper === Infinity ? undefined : upper + 1);
        return { data: rows, error: null };
      }
      return query;
    }
  };
}

test('the stored VIP welcome is concise and passes the real VIP copy gate', () => {
  const verdict = validateCopy(WELCOME_MESSAGE, { requireOptOut: false });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  // Written to the person, not about them. The earlier wording said "for one of
  // our most loyal researchers", which describes a third party in front of the
  // reader; the owner asked for it to be theirs.
  assert.match(WELCOME_MESSAGE, /You're one of our most loyal customers/i);
  assert.match(WELCOME_MESSAGE, /You've unlocked our VIP service/i);
  assert.doesNotMatch(WELCOME_MESSAGE, /for one of our/i);
  assert.match(WELCOME_MESSAGE, /private code/i);
  assert.match(WELCOME_MESSAGE, /1:1 research support/i);
  assert.match(WELCOME_MESSAGE, /24\/7/);
  assert.match(WELCOME_MESSAGE, /\{\{loyalty_since\}\}/);
  // No unverified competitor pricing comparison in customer-facing copy.
  assert.doesNotMatch(WELCOME_MESSAGE, /thousands a month/i);
  assert.match(WELCOME_MESSAGE, /at no extra cost/i);
  assert.match(WELCOME_MESSAGE, /private code for all orders/i);

  // No coupon may be named or templated here. Dominic chooses the VIP code
  // himself, and {{code}} would require a verified WooCommerce coupon before
  // this could send at all. VICI30 is the separate quiet-VIP win-back offer and
  // must never appear in the welcome.
  assert.doesNotMatch(WELCOME_MESSAGE, /\{\{code\}\}/);
  assert.doesNotMatch(WELCOME_MESSAGE, /VICI\d+|CC\d+/i);

  // Blocked carrier-risk terms, and the opt-out footer VIP traffic omits.
  assert.doesNotMatch(WELCOME_MESSAGE, /\bfree\b|\bsale\b/i);
  assert.doesNotMatch(WELCOME_MESSAGE, /Reply STOP to opt out/i);
});

test('only a named VIP beyond 24 hours, never welcomed and quiet for two hours, is due', async () => {
  const due = '+15550000001';
  const reached = '+15550000002';
  const recent = '+15550000003';
  const future = '+15550000004';
  const noName = '+15550000005';
  const client = database({
    sms_campaign_segments: [{ id: 'vip', workspace_id: 'vici', segment_key: 'best_repeat_customers', archived_at: null }],
    sms_campaign_segment_members: [
      due, reached, recent, noName
    ].map((phone, index) => ({
      workspace_id: 'vici', segment_id: 'vip', contact_phone: phone,
      contact_id: index + 1, contact_name_snapshot: phone === noName ? null : `Person ${index}`,
      first_seen_at: '2026-09-24T12:00:00.000Z', membership_source: 'computed'
    })).concat([{
      workspace_id: 'vici', segment_id: 'vip', contact_phone: future, contact_id: 9,
      contact_name_snapshot: 'Future Person', first_seen_at: '2026-09-26T12:00:00.000Z',
      membership_source: 'computed'
    }]),
    // A welcome that genuinely reached somebody: a live campaign and a recipient
    // carrying sent_at. Only delivery suppresses a repeat, so this fixture has
    // to say so rather than relying on the row merely existing.
    sms_campaigns: [{
      id: 'old', workspace_id: 'vici', workflow_category: 'vip_welcome',
      status: 'completed', archived_at: null
    }],
    sms_campaign_recipients: [{
      workspace_id: 'vici', campaign_id: 'old', contact_phone: reached,
      state: 'sent', sent_at: '2026-09-25T10:00:00.000Z'
    }],
    sms_contacts: [
      { id: 1, phone: due, name: 'Alex Smith', first_name: 'Alex' },
      { id: 2, phone: reached, name: 'Jo Reed', first_name: 'Jo' },
      { id: 3, phone: recent, name: 'Sam West', first_name: 'Sam' },
      { id: 9, phone: future, name: 'Terry Lane', first_name: 'Terry' },
      { id: 5, phone: noName, name: null, first_name: null }
    ],
    sms_messages: [{ contact_phone: recent, created_at: '2026-09-26T15:00:00.000Z' }]
  });

  const result = await dueVIPWelcomes({ client, now: NOW });
  assert.deepEqual(result.due.map(row => row.phone), [due]);
  assert.equal(result.candidates, 4, 'the not-yet-24-hour member is not a candidate yet');
  assert.equal(result.reasons.already_enrolled, 1);
  assert.equal(result.reasons.recent_conversation, 1);
  assert.equal(result.reasons.missing_name, 1);
  assert.equal(result.due[0].reason.first_seen_at, '2026-09-24T12:00:00.000Z');
});

test('the automation is off before migration and whenever standing authorisation is off', async () => {
  const common = { client: {}, service: {}, audit: async () => ({}), readDue: async () => ({ due: [] }) };
  const missing = await runVIPWelcomeSweep({
    ...common, loadSettings: async () => ({ vipWelcomeAutomationAvailable: false })
  });
  assert.equal(missing.reason, 'migration_required');
  const disabled = await runVIPWelcomeSweep({
    ...common, loadSettings: async () => ({ vipWelcomeAutomationAvailable: true, vip_welcome_automation_enabled: false })
  });
  assert.equal(disabled.reason, 'automation_disabled');
});

test('a Railway deploy before the additive migration keeps existing campaign settings readable', async () => {
  const selected = [];
  const client = {
    from() {
      const query = {
        select(columns) { selected.push(columns); query.columns = columns; return query; },
        eq() { return query; },
        maybeSingle() {
          if (query.columns.includes('vip_welcome_automation_enabled')) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST204', message: "Could not find the 'vip_welcome_automation_enabled' column" }
            });
          }
          return Promise.resolve({
            data: { workspace_id: 'vici', checkin_automation_enabled: true, business_timezone: 'America/New_York' },
            error: null
          });
        }
      };
      return query;
    }
  };
  const settings = await loadCampaignSettings(client);
  assert.equal(selected.length, 2);
  assert.equal(settings.checkin_automation_enabled, true, 'the existing automation remains readable');
  assert.equal(settings.vipWelcomeAutomationAvailable, false);
  assert.equal(settings.vip_welcome_automation_enabled, false);
});

test('an enabled sweep uses the audited campaign state machine in order', async () => {
  const calls = [];
  const service = {
    async create(input) { calls.push(['create', input]); return { campaign: { id: 'welcome-1' } }; },
    async submitReview(id) { calls.push(['submit', id]); },
    async approve(id) {
      calls.push(['approve', id]);
      return { campaign: { id, revision: 1, title: 'VIP welcome', final_message: WELCOME_MESSAGE }, recipientCount: 1, audienceHash: 'a', messageHash: 'm' };
    },
    async finalizeApproval(id, revision, proof) { calls.push(['finalize', id, revision, proof.fingerprint]); },
    async schedule(id, at) { calls.push(['schedule', id, at]); return { scheduled_for: at }; }
  };
  const result = await runVIPWelcomeSweep({
    client: {}, service, now: NOW,
    loadSettings: async () => ({
      vipWelcomeAutomationAvailable: true,
      vip_welcome_automation_enabled: true,
      vip_welcome_message_template: WELCOME_MESSAGE
    }),
    readDue: async () => ({ candidates: 1, reasons: {}, due: [{ phone: '+15550000001', name: 'Alex' }] }),
    audit: async () => { calls.push(['audit']); return { fingerprint: 'proof' }; }
  });
  assert.equal(result.reason, 'scheduled');
  assert.deepEqual(calls.map(row => row[0]), ['create', 'submit', 'approve', 'audit', 'finalize', 'schedule']);
  assert.equal(calls[0][1].workflowCategory, 'vip_welcome');
  assert.equal(calls[0][1].message, WELCOME_MESSAGE);
  // 6 PM in the store zone, not a minute from now. NOW is 12:00 in New York, so
  // the next 18:00 there is the same afternoon: 22:00 UTC.
  assert.equal(calls.at(-1)[2], '2026-09-26T22:00:00.000Z');
});

// ── SWITCHING IT ON MUST NOT FIRE IMMEDIATELY ────────────────────────────
//
// The owner switches this on from the UK, where it can easily be past midnight
// while New York is still the previous evening. Scheduling `now + 60s` would
// have queued every welcome for the middle of the store's night and left the
// quiet-hours fence to argue with each recipient, while the Automations screen
// showed a time nobody chose.
test('a sweep after the store hour waits for the next 6 PM, not the middle of the night', async () => {
  const scheduled = [];
  const service = {
    async create() { return { campaign: { id: 'w' } }; },
    async submitReview() {},
    async approve(id) {
      return { campaign: { id, revision: 1 }, recipientCount: 1, audienceHash: 'a', messageHash: 'm' };
    },
    async finalizeApproval() {},
    async schedule(id, at) { scheduled.push(at); return { scheduled_for: at }; }
  };
  const settings = {
    vipWelcomeAutomationAvailable: true,
    vip_welcome_automation_enabled: true,
    vip_welcome_message_template: WELCOME_MESSAGE,
    business_timezone: 'America/New_York'
  };
  const sweep = when => runVIPWelcomeSweep({
    client: {}, service, now: new Date(when),
    loadSettings: async () => settings,
    readDue: async () => ({ candidates: 1, reasons: {}, due: [{ phone: '+15550000001', name: 'Alex' }] }),
    audit: async () => ({ fingerprint: 'proof' })
  });

  // 00:34 UTC on the 27th is 20:34 on the 26th in New York, past that day's
  // 18:00, so the welcome belongs to the next evening.
  await sweep('2026-09-27T00:34:00.000Z');
  assert.equal(scheduled.at(-1), '2026-09-27T22:00:00.000Z');

  // 17:30 in New York is inside the two-hour lead, so it also rolls forward
  // rather than firing half an hour later.
  await sweep('2026-09-27T21:30:00.000Z');
  assert.equal(scheduled.at(-1), '2026-09-28T22:00:00.000Z');

  // Comfortably before the hour on the same day stays on that day.
  await sweep('2026-09-27T13:00:00.000Z');
  assert.equal(scheduled.at(-1), '2026-09-27T22:00:00.000Z');
});

test('the delivery fence waits until two hours after the latest conversation', async () => {
  const client = database({
    sms_campaigns: [{ id: 'c1', workspace_id: 'vici', workflow_category: 'vip_welcome' }],
    sms_messages: [{ contact_phone: '+15550000001', created_at: '2026-09-26T15:30:00.000Z' }]
  });
  const result = await vipWelcomeConversationFence({
    client,
    recipient: { campaign_id: 'c1', workspace_id: 'vici', contact_phone: '+15550000001' },
    now: NOW
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'vip_welcome_recent_conversation');
  assert.equal(result.retryAt.toISOString(), '2026-09-26T17:30:00.000Z');
});

test('a fenced claimed welcome is deferred and never reaches the provider', async () => {
  const calls = [];
  const client = {
    async rpc(name) {
      calls.push(name);
      if (name === 'claim_sms_campaign_recipients') return { data: [{
        id: 'r1', campaign_id: 'c1', workspace_id: 'vici', claim_token: 'token',
        contact_phone: '+15550000001', rendered_message: 'Hello'
      }], error: null };
      return { data: 0, error: null };
    }
  };
  let sent = 0;
  let deferred = 0;
  const summary = await deliverBatch({
    client, env: { CAMPAIGNS_LIVE_SEND_ENABLED: 'true' },
    send: async () => { sent += 1; return { messageId: 'bad' }; },
    conversationFence: async () => ({
      allowed: false, reason: 'vip_welcome_recent_conversation', retryAt: new Date(NOW.getTime() + 1000)
    }),
    deferClaim: async () => { deferred += 1; },
    log: { error() {} }
  });
  assert.equal(sent, 0);
  assert.equal(deferred, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.reasons, { vip_welcome_recent_conversation: 1 });
  assert.equal(calls.includes('begin_sms_campaign_provider_attempt'), false);
});

// ── THE RETIRED DRAFT MUST NOT SUPPRESS ANYBODY ──────────────────────────
//
// Found against production on 27 Sep 2026. `priorWelcomePhones` counted every
// recipient row on every vip_welcome campaign regardless of state or archival,
// so the retired 101-person welcome draft (state 'draft', sent_at null, on an
// archived campaign) suppressed the entire VIP population. Enabling the
// automation would have queued nobody while reporting all 101 as already
// enrolled, which reads as a dead feature rather than a bug.
test('an abandoned welcome draft does not suppress a real welcome', async () => {
  const abandoned = '+15550000201';
  const inFlight = '+15550000202';
  const cancelledLive = '+15550000203';
  const trulySent = '+15550000204';
  const phones = [abandoned, inFlight, cancelledLive, trulySent];

  const client = database({
    sms_campaign_settings: [{ workspace_id: 'vici', business_timezone: 'America/New_York' }],
    sms_campaign_segments: [{ id: 'vip', workspace_id: 'vici', segment_key: 'best_repeat_customers', archived_at: null }],
    sms_campaign_segment_members: phones.map((phone, index) => ({
      workspace_id: 'vici', segment_id: 'vip', contact_phone: phone,
      contact_id: index + 1, contact_name_snapshot: `Person ${index}`,
      first_seen_at: '2026-09-24T12:00:00.000Z', membership_source: 'computed'
    })),
    sms_campaigns: [
      // Retired without sending: must hold nobody back.
      { id: 'archived', workspace_id: 'vici', workflow_category: 'vip_welcome', status: 'draft', archived_at: '2026-09-26T23:48:00.000Z' },
      // Live and still going out: must prevent a second welcome racing it.
      { id: 'live', workspace_id: 'vici', workflow_category: 'vip_welcome', status: 'scheduled', archived_at: null },
      // Cancelled before sending: must hold nobody back either.
      { id: 'cancelled', workspace_id: 'vici', workflow_category: 'vip_welcome', status: 'cancelled', archived_at: null },
      // Cancelled, but this one did reach the customer before it stopped.
      { id: 'partial', workspace_id: 'vici', workflow_category: 'vip_welcome', status: 'cancelled', archived_at: null }
    ],
    sms_campaign_recipients: [
      { workspace_id: 'vici', campaign_id: 'archived', contact_phone: abandoned, state: 'draft', sent_at: null },
      { workspace_id: 'vici', campaign_id: 'live', contact_phone: inFlight, state: 'pending', sent_at: null },
      { workspace_id: 'vici', campaign_id: 'cancelled', contact_phone: cancelledLive, state: 'pending', sent_at: null },
      { workspace_id: 'vici', campaign_id: 'partial', contact_phone: trulySent, state: 'sent', sent_at: '2026-09-25T09:00:00.000Z' }
    ],
    sms_contacts: phones.map((phone, index) => ({
      id: index + 1, phone, name: `Person ${index}`, first_name: `Person${index}`
    })),
    sms_messages: []
  });

  const result = await dueVIPWelcomes({ client, now: NOW });
  const due = result.due.map(row => row.phone).sort();

  // Abandoned draft and cancelled-before-sending are both free to be welcomed.
  assert.deepEqual(due, [abandoned, cancelledLive].sort(),
    'only delivery, or an in-flight send on a live campaign, may suppress a welcome');
  assert.ok(!due.includes(inFlight), 'a pending welcome on a live campaign must not be queued twice');
  assert.ok(!due.includes(trulySent), 'a delivered welcome suppresses forever, even if its campaign was cancelled');
  assert.equal(result.reasons.already_enrolled, 2);
});

// ── THE RETIRED DRAFT MUST LEAVE THE SCREEN ──────────────────────────────
//
// The superseded 101-person "Welcome our Vici VIP customers" draft was archived,
// but this read ignored archived_at, so it kept presenting itself as the latest
// VIP welcome. The owner saw a campaign he had already retired, and following it
// showed the old wording instead of the template the automation actually sends.
test('an archived welcome campaign is not reported as the latest run', async () => {
  const retired = {
    id: 'retired', workspace_id: 'vici', workflow_category: 'vip_welcome',
    status: 'draft', created_at: '2026-09-26T00:49:00.000Z',
    archived_at: '2026-09-26T23:48:00.000Z', scheduled_for: null
  };
  const real = {
    id: 'real', workspace_id: 'vici', workflow_category: 'vip_welcome',
    status: 'scheduled', created_at: '2026-09-20T00:00:00.000Z',
    archived_at: null, scheduled_for: '2026-09-27T22:00:00.000Z'
  };

  // Newest first, so the retired draft would win on created_at if it were read.
  const onlyRetired = database({ sms_campaigns: [retired] });
  assert.equal(await latestVIPWelcomeCampaign({ client: onlyRetired }), null,
    'an archived draft is not a run and must not appear');

  const both = database({ sms_campaigns: [retired, real] });
  const latest = await latestVIPWelcomeCampaign({ client: both });
  assert.equal(latest?.id, 'real', 'the newest UNARCHIVED campaign is the latest run');

  // A failed sweep leaves a real draft behind, and that must stay visible.
  const failedRun = database({ sms_campaigns: [{ ...real, id: 'stuck', status: 'draft' }] });
  assert.equal((await latestVIPWelcomeCampaign({ client: failedRun }))?.id, 'stuck',
    'an unarchived draft is a failed run the owner needs to see');
});

// ── ONE COPY, NOT TWO ────────────────────────────────────────────────────
//
// The owner's instruction of 27 Sep 2026: the future welcome message is the
// message every VIP gets. The screen must therefore not be able to show one
// string while the sweep sends another, which is exactly the class of bug that
// produced "it says 20% but the code is for 15%" on the campaign side.
test('the future welcome message is the copy that actually sends', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'lib/campaigns/vip-welcome-automation.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'routes/campaigns.js'), 'utf8');

  // The sweep sends the stored template, falling back to the versioned default.
  assert.match(source, /message: settings\.vip_welcome_message_template \|\| WELCOME_MESSAGE/);
  // The screen shows the same expression, so the two cannot diverge.
  assert.match(route, /messageTemplate: settings\?\.vip_welcome_message_template \|\| WELCOME_MESSAGE/);
});
