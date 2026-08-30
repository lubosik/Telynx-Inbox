'use strict';
/**
 * test/campaign-check-in.test.js — the 21-day check-in, both halves.
 *
 * The weekly sweep decides WHO is asked. lib/campaigns/check-in-reply.js
 * decides who gets a code after answering. The second is the part that can
 * actually hurt somebody, so most of these tests are about what it refuses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BATCH_WINDOW_DAYS,
  CHECK_IN_DAYS,
  QUALIFYING_STATUSES,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  checkInDueAt,
  dueInWindow,
  selectDue
} = require('../lib/campaigns/check-in');

const {
  FLOW_TYPE,
  TEMPLATE: REPLY_TEMPLATE,
  handleCheckInReply,
  looksUnhappy
} = require('../lib/campaigns/check-in-reply');

const { fieldsUsed } = require('../lib/campaigns/merge-fields');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-29T12:00:00Z');
const order = (over = {}) => ({
  contact_phone: '+15550000001',
  status: 'delivered',
  created_at: new Date(NOW.getTime() - 21 * DAY).toISOString(),
  items: [{ sku: 'RT20', total: '130.50' }],
  ...over
});

// ── Who is due ─────────────────────────────────────────────────────────────

test('the clock runs from the order date, 21 days', () => {
  assert.equal(CHECK_IN_DAYS, 21);
  assert.equal(
    checkInDueAt({ status: 'delivered', created_at: '2026-08-01T12:00:00Z' }),
    '2026-08-22T12:00:00.000Z'
  );
});

test('only orders that actually went out qualify', () => {
  // The distribution that matters: shipped 642, delivered 608, completed 47.
  // An earlier version qualified on `completed` alone and would have skipped
  // 97% of real orders while looking correct.
  for (const status of ['shipped', 'delivered', 'completed']) {
    assert.ok(QUALIFYING_STATUSES.has(status), status);
    assert.ok(checkInDueAt({ status, created_at: '2026-08-01T00:00:00Z' }), status);
  }
  for (const status of ['processing', 'on-hold', 'cancelled', 'failed', 'refunded', 'trash']) {
    assert.equal(checkInDueAt({ status, created_at: '2026-08-01T00:00:00Z' }), null, status);
  }
});

test('the window is exactly the sweep cadence, and it looks backwards not forwards', () => {
  assert.equal(BATCH_WINDOW_DAYS, 7);
  const at = days => order({ created_at: new Date(NOW.getTime() - days * DAY).toISOString() });
  assert.equal(dueInWindow(at(20), { now: NOW }), false, 'not due yet');
  assert.equal(dueInWindow(at(21), { now: NOW }), true, 'due today');
  assert.equal(dueInWindow(at(27), { now: NOW }), true, 'came due six days ago');
  // Beyond the window they are missed permanently, which is exactly why the
  // sweep must run weekly and why this boundary is pinned.
  assert.equal(dueInWindow(at(29), { now: NOW }), false, 'older than the window');
});

test('somebody who ordered three times that week is asked once', () => {
  const rows = [
    order({ created_at: new Date(NOW.getTime() - 27 * DAY).toISOString() }),
    order({ created_at: new Date(NOW.getTime() - 24 * DAY).toISOString() }),
    order({ created_at: new Date(NOW.getTime() - 22 * DAY).toISOString() })
  ];
  const due = selectDue(rows, { now: NOW });
  assert.equal(due.length, 1, 'three orders must not become three questions');
  // The most recent qualifying order, being the one they are thinking about.
  assert.equal(due[0].order.created_at, rows[2].created_at);
});

test('an order with no phone is skipped rather than crashing the sweep', () => {
  assert.equal(selectDue([order({ contact_phone: null })], { now: NOW }).length, 0);
});

// ── What the messages say ──────────────────────────────────────────────────

test('the check-in carries no code, and the reply does', () => {
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT]) {
    assert.equal(fieldsUsed(template).includes('code'), false,
      'the broadcast half must carry no offer: that is what keeps it customer care');
  }
  assert.ok(fieldsUsed(REPLY_TEMPLATE).includes('code'));
});

test('all three templates are compliant copy at the worst case', () => {
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT, REPLY_TEMPLATE]) {
    const verdict = validateCopy(template, {
      brandName: RULES.brand.defaultName,
      approvedProductCodes: RULES.defaultApprovedProductCodes
    });
    assert.equal(verdict.ok, true,
      `failed: ${JSON.stringify((verdict.failures || []).map(f => f.check))}`);
    assert.match(template, /Reply STOP to opt out/);
  }
});

test('nothing claims the customer is due for anything', () => {
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT, REPLY_TEMPLATE]) {
    const lower = template.toLowerCase();
    for (const phrase of ['you are due', "you're due", 'run out', 'running low', 'time to reorder']) {
      assert.equal(lower.includes(phrase), false, `${phrase} must not appear`);
    }
  }
});

// ── Who gets a code, and who very much does not ────────────────────────────

test('a complaint is recognised, in the shapes people actually write', () => {
  for (const reply of [
    'it arrived broken', 'Honestly not great', 'the vial was leaking',
    'never arrived', 'I want a refund', 'wrong item came',
    'gave me a rash', 'not interested thanks', 'stop sending me this'
  ]) {
    assert.equal(looksUnhappy(reply), true, `should be held: ${reply}`);
  }
  for (const reply of ['all good thanks', 'yeah great cheers', 'perfect', 'yes all fine']) {
    assert.equal(looksUnhappy(reply), false, `should pass: ${reply}`);
  }
});

/** Supabase-shaped stub covering only what the reply handler calls. */
function replyClient({ campaigns = [{ id: 'camp-1', title: 'Check-in' }], recipients = [], contact = {}, sentLog = null } = {}) {
  return {
    from(table) {
      const b = {
        _f: {},
        select() { return b; },
        eq(k, v) { b._f[k] = v; return b; },
        in() { return b; },
        not() { return b; },
        gte() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: recipients, error: null }); },
        maybeSingle() {
          if (table === 'sms_contacts') return Promise.resolve({ data: contact, error: null });
          if (table === 'sms_sent_log') return Promise.resolve({ data: sentLog, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        range() { return Promise.resolve({ data: [], error: null }); },
        insert() { return Promise.resolve({ error: null }); }
      };
      if (table === 'sms_campaigns') {
        b.eq = (k, v) => { b._f[k] = v; return b; };
        b.select = () => ({ eq: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }) });
      }
      return b;
    }
  };
}

/**
 * Uses the REAL couponSpec and the real positional-array call shape.
 *
 * The previous version took `{ coupons }`, which is what this file was
 * passing and is not what the module accepts. Every test passed and the send
 * failed with "createCoupons requires an array of coupon specs". A stub that
 * agrees with the caller instead of the callee tests nothing about the
 * boundary it stands in for.
 */
const { couponSpec: realCouponSpec } = require('../lib/woocommerce-coupons');

const stubCoupons = () => ({
  minted: [],
  couponSpec: realCouponSpec,
  generateCode: ({ prefix, seed }) =>
    `${prefix}-${require('node:crypto').createHash('sha1').update(seed).digest('hex').slice(0, 10)}`,
  createCoupons: async function (specs) {
    if (!Array.isArray(specs)) throw new Error('createCoupons requires an array of coupon specs.');
    this.minted.push(...specs);
    return { created: specs, failed: [] };
  }
});

test('somebody who never received a check-in gets nothing, whatever they say', async () => {
  const coupons = stubCoupons();
  const sends = [];
  const result = await handleCheckInReply({
    client: replyClient({ recipients: [] }),
    phone: '+15550000001', text: 'all good thanks',
    sendSMS: async (...a) => { sends.push(a); return { messageId: 'm1' }; },
    coupons
  });
  // Without this, every inbound message in the inbox is a discount trigger,
  // including "where is my order".
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no_recent_check_in');
  assert.equal(coupons.minted.length, 0);
  assert.equal(sends.length, 0);
});

test('an unhappy reply gets a person, never a coupon', async () => {
  const coupons = stubCoupons();
  const sends = [];
  const result = await handleCheckInReply({
    client: replyClient({ recipients: [{ campaign_id: 'camp-1', contact_phone: '+15550000001', sent_at: NOW.toISOString() }] }),
    phone: '+15550000001', text: 'it arrived broken and leaking',
    now: NOW,
    sendSMS: async (...a) => { sends.push(a); return { messageId: 'm1' }; },
    coupons
  });
  // The worst thing this feature could do is answer "it arrived broken" with
  // "here's 15% off your next one", and the check-in explicitly invites
  // problems, so it is the most likely bad outcome rather than a rare one.
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'reply_needs_a_human');
  assert.equal(coupons.minted.length, 0, 'no coupon may be minted for a complaint');
  assert.equal(sends.length, 0, 'nothing may be sent over a complaint');
});

test('somebody who opted out since the check-in gets nothing', async () => {
  const coupons = stubCoupons();
  const result = await handleCheckInReply({
    client: replyClient({
      recipients: [{ campaign_id: 'camp-1', contact_phone: '+15550000001', sent_at: NOW.toISOString() }],
      contact: { opted_out: true }
    }),
    phone: '+15550000001', text: 'all good thanks', now: NOW,
    sendSMS: async () => ({ messageId: 'm1' }), coupons,
    // Stubbed happy, so the test reaches the opt-out branch rather than
    // stopping at triage.
    triage: async () => ({ intent: 'happy', confidence: 1, autoSendCode: true, needsHuman: false })
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'opted_out');
  assert.equal(coupons.minted.length, 0);
});

test('a second reply does not earn a second code', async () => {
  const coupons = stubCoupons();
  const result = await handleCheckInReply({
    client: replyClient({
      recipients: [{ campaign_id: 'camp-1', contact_phone: '+15550000001', sent_at: NOW.toISOString() }],
      sentLog: { id: 1 }
    }),
    phone: '+15550000001', text: 'thanks again', now: NOW,
    sendSMS: async () => ({ messageId: 'm1' }), coupons,
    triage: async () => ({ intent: 'happy', confidence: 1, autoSendCode: true, needsHuman: false })
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'code_already_sent');
  // Checked BEFORE minting, so a chatty customer cannot generate coupons.
  assert.equal(coupons.minted.length, 0);
});

test('the handler never throws, whatever the database does', async () => {
  const exploding = { from() { throw new Error('connection reset'); } };
  const result = await handleCheckInReply({
    client: exploding, phone: '+15550000001', text: 'all good',
    sendSMS: async () => ({ messageId: 'm1' })
  });
  // It runs inside the Telnyx inbound webhook. A failed discount must never
  // become a retried webhook or a lost customer message.
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'handler_failed');
});

test('the inbound webhook is wired to the handler, after the STOP branch', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'webhook.js'), 'utf8'
  );
  assert.match(source, /handleCheckInReply\(/, 'the webhook must call the handler');
  // STOP is honoured by an earlier branch that returns. If the handler were
  // ever called above it, a customer texting STOP would be sent a coupon.
  assert.ok(
    source.indexOf('isOptOutRequest(') < source.indexOf('handleCheckInReply('),
    'the opt-out branch must come before the check-in reply handler'
  );
  assert.equal(FLOW_TYPE, 'checkin-reply-code');
});
