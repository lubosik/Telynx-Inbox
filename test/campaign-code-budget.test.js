'use strict';
/**
 * test/campaign-code-budget.test.js — one code per person, and none for
 * regulars.
 *
 * Two paths mint codes and neither knew about the other, so a customer could
 * take a win-back code in September, answer a check-in in October and receive
 * a second one. This is the gate both must now pass. The owner's rule, in
 * their words: "we can only send one code, we can't be sending a code every
 * single time".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODE_WINDOW_DAYS,
  REGULAR_ORDER_COUNT,
  filterEligibleForCode,
  mayIssueCode
} = require('../lib/campaigns/code-budget');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (d) => new Date(NOW.getTime() - d * DAY).toISOString();

/**
 * Supabase-shaped stub covering the three reads the gate makes: the order
 * count, campaign-issued codes, and reply-issued codes.
 */
function stubClient({
  orders = [],
  campaignCodes = [],
  replyCodes = [],
  campaignError = null,
  replyError = null,
  orderError = null
} = {}) {
  return {
    from(table) {
      if (table === 'sms_orders') {
        const b = { select: () => b, eq: () => Promise.resolve({ data: orders, error: orderError }) };
        return b;
      }
      if (table === 'sms_campaign_recipients') {
        const b = {
          select: () => b, eq: () => b, not: () => b, gte: () => b,
          limit: () => Promise.resolve({ data: campaignCodes, error: campaignError })
        };
        return b;
      }
      const b = {
        select: () => b, eq: () => b, gte: () => b,
        limit: () => Promise.resolve({ data: replyCodes, error: replyError })
      };
      return b;
    }
  };
}

const paid = (n) => Array.from({ length: n }, () => ({ status: 'delivered' }));

test('somebody with no code and few orders may have one', async () => {
  const verdict = await mayIssueCode({ client: stubClient({ orders: paid(1) }), phone: '+15550000001', now: NOW });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.orderCount, 1);
});

test('a regular gets no code, however long since the last one', async () => {
  // The owner's rule: past three orders it is "just a check-in, without any
  // coupon codes". They have the habit the discount exists to create, so a
  // code is margin given to somebody who was buying anyway.
  const verdict = await mayIssueCode({
    client: stubClient({ orders: paid(REGULAR_ORDER_COUNT) }), phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'regular_customer');
  assert.equal(verdict.orderCount, 3);
});

test('unpaid orders do not make somebody a regular', async () => {
  const orders = [
    { status: 'delivered' },
    { status: 'cancelled' }, { status: 'refunded' }, { status: 'failed' }, { status: 'trash' }
  ];
  const verdict = await mayIssueCode({ client: stubClient({ orders }), phone: '+15550000001', now: NOW });
  assert.equal(verdict.allowed, true, 'four cancelled orders are not four orders');
  assert.equal(verdict.orderCount, 1);
});

test('a campaign code inside the window blocks a second one', async () => {
  const verdict = await mayIssueCode({
    client: stubClient({
      orders: paid(1),
      campaignCodes: [{ issued_coupon_code: 'vin-aaaa111111', sent_at: ago(30) }]
    }),
    phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'already_had_a_code');
});

test('a reply code inside the window blocks a second one', async () => {
  // The case that used to slip through entirely: the reply handler never
  // consulted anything before minting.
  const verdict = await mayIssueCode({
    client: stubClient({ orders: paid(1), replyCodes: [{ created_at: ago(10) }] }),
    phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'already_had_a_code');
});

test('a code minted for a campaign that never sent does not block a real one', async () => {
  // The stub returns nothing because the query filters on sent_at NOT NULL. If
  // that filter is ever dropped, a cancelled campaign's unused codes would
  // lock those customers out of every future offer for six months.
  const verdict = await mayIssueCode({
    client: stubClient({ orders: paid(1), campaignCodes: [] }), phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, true);
});

test('the window is six months and matches the win-back dedupe', async () => {
  assert.equal(CODE_WINDOW_DAYS, 180);
  const { RECIPES } = require('../lib/campaigns/recipes');
  // Becoming eligible for a second win-back and becoming eligible for a second
  // code should be the same moment, not two rules that drift apart.
  assert.equal(RECIPES.winback_one_time.dedupeDays, CODE_WINDOW_DAYS);
});

test('it fails CLOSED when a read errors', async () => {
  // A missed discount costs one order's uplift. A duplicate costs margin and
  // teaches the customer to wait for the next one. Those are not comparable,
  // so doubt resolves to "no".
  const verdict = await mayIssueCode({
    client: stubClient({ orderError: { message: 'connection reset' } }),
    phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'budget_check_failed');
});

test('a missing coupon-attribution migration is not treated as an error', async () => {
  // 42703 means the column does not exist yet, so there are no recorded
  // campaign codes to find. That is true, not broken, and must not lock
  // everybody out of codes until the migration is applied.
  const verdict = await mayIssueCode({
    client: stubClient({ orders: paid(1), campaignError: { code: '42703', message: 'column does not exist' } }),
    phone: '+15550000001', now: NOW
  });
  assert.equal(verdict.allowed, true);
});

/**
 * The batched path reads whole tables by `.in()`, so it needs rows tagged with
 * the phone they belong to rather than the single-person stub's shape.
 */
function batchClient({ orders = [], recipients = [], sentLog = [], fail = null } = {}) {
  return {
    from(table) {
      const rows = table === 'sms_orders' ? orders
        : table === 'sms_campaign_recipients' ? recipients
        : sentLog;
      const b = {
        select: () => b,
        in: () => fail
          ? Promise.resolve({ data: null, error: { message: fail } })
          : Promise.resolve({ data: rows, error: null })
      };
      return b;
    }
  };
}

test('filtering an audience reports who was refused and why', async () => {
  const result = await filterEligibleForCode({
    client: batchClient({
      orders: [
        ...paid(4).map(o => ({ ...o, contact_phone: '+15550000001' })),
        { status: 'delivered', contact_phone: '+15550000002' }
      ]
    }),
    phones: ['+15550000001', '+15550000002'],
    now: NOW
  });
  assert.deepEqual(result.allowed, ['+15550000002']);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].reason, 'regular_customer');
});

test('the batched path gives the same answer as the per-person one', async () => {
  // Two implementations of one rule is exactly how a rule quietly stops being
  // one, so the batched path exists only because looping the single-person
  // check took 283 SECONDS on the real 376-person audience. It has to agree.
  const cases = [
    { label: 'clean', orders: 1, campaignCode: false, replyCode: false, expect: true },
    { label: 'regular', orders: 3, campaignCode: false, replyCode: false, expect: false },
    { label: 'has campaign code', orders: 1, campaignCode: true, replyCode: false, expect: false },
    { label: 'has reply code', orders: 1, campaignCode: false, replyCode: true, expect: false }
  ];
  for (const c of cases) {
    const phone = '+15550000001';
    const single = await mayIssueCode({
      client: stubClient({
        orders: paid(c.orders),
        campaignCodes: c.campaignCode ? [{ issued_coupon_code: 'vin-x', sent_at: ago(30) }] : [],
        replyCodes: c.replyCode ? [{ sent_at: ago(30) }] : []
      }),
      phone, now: NOW
    });
    const batched = await filterEligibleForCode({
      client: batchClient({
        orders: paid(c.orders).map(o => ({ ...o, contact_phone: phone })),
        recipients: c.campaignCode ? [{ contact_phone: phone, issued_coupon_code: 'vin-x', sent_at: ago(30) }] : [],
        sentLog: c.replyCode ? [{ phone, flow_type: 'checkin-reply-code', sent_at: ago(30) }] : []
      }),
      phones: [phone], now: NOW
    });
    assert.equal(single.allowed, c.expect, `${c.label}: single-person path`);
    assert.equal(batched.allowed.length === 1, c.expect, `${c.label}: batched path`);
    if (!c.expect) {
      assert.equal(single.reason, batched.refused[0].reason, `${c.label}: reasons must match`);
    }
  }
});

test('the batched path also fails closed', async () => {
  const result = await filterEligibleForCode({
    client: batchClient({ fail: 'connection reset' }),
    phones: ['+15550000001', '+15550000002'], now: NOW
  });
  assert.equal(result.allowed.length, 0);
  assert.equal(result.refused.length, 2);
  assert.ok(result.refused.every(r => r.reason === 'budget_check_failed'));
});

test('an unsent campaign code does not count in the batched path either', async () => {
  const result = await filterEligibleForCode({
    client: batchClient({
      orders: [{ status: 'delivered', contact_phone: '+15550000001' }],
      // Minted at approval, campaign then cancelled, so sent_at is null.
      recipients: [{ contact_phone: '+15550000001', issued_coupon_code: 'vin-x', sent_at: null }]
    }),
    phones: ['+15550000001'], now: NOW
  });
  assert.deepEqual(result.allowed, ['+15550000001']);
});

test('an invalid phone is refused rather than allowed by default', async () => {
  const verdict = await mayIssueCode({ client: stubClient(), phone: 'not a phone', now: NOW });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'invalid_phone');
});

test('the send log is read by its real column name', () => {
  // This shipped broken. The gate asked sms_sent_log for `created_at`, which
  // does not exist; the read errored, the gate failed closed, and every single
  // customer was locked out of every code. Measured against the live database:
  // 376 of 376 refused with budget_check_failed. Unit tests could not catch it
  // because the stub answered whatever column was asked for.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'campaigns', 'code-budget.js'), 'utf8'
  );
  const sentLogBlock = source.slice(source.indexOf("from('sms_sent_log')"));
  assert.match(sentLogBlock.slice(0, 400), /select\('sent_at'\)/,
    'sms_sent_log has sent_at, not created_at');
  assert.doesNotMatch(sentLogBlock.slice(0, 400), /created_at/,
    'sms_sent_log has no created_at column');
});

test('both minting paths consult the gate', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'campaigns', f), 'utf8');
  // A rule enforced in only one of the two places is not a rule.
  //
  // The reply handler now asks mayOfferCheckInCode instead of mayIssueCode.
  // The gate did not go away, it got a better question: order COUNT is not
  // what makes an offer wasteful, sending one to somebody who just ordered is.
  // See checkin-offer-policy.js.
  assert.match(read('check-in-reply.js'), /mayOfferCheckInCode\(/,
    'the reply handler must check eligibility before minting');
  assert.match(read('service.js'), /filterEligibleForCode\(/,
    'campaign approval must check the budget before minting');
});

test('AI-suggested copy is validated before it can be sent', () => {
  // routes/intelligence.js sends `suggested_message`, which is written by the
  // model in intelligence.js. That model's system prompt lists the compounds
  // by name ("Semaglutide, Tirzepatide") and asks it for a "ready to send
  // SMS". The route checked live-send, recipient eligibility and opt-out, and
  // then sent whatever came back.
  //
  // So the single place a compound name could reach a carrier was the only
  // place the compound-name ban was not enforced.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'intelligence.js'), 'utf8'
  );
  const sendBlock = source.slice(0, source.indexOf('await sendSMS(suggestion.contact_phone'));
  assert.match(sendBlock, /validateCopy\(suggestion\.suggested_message/,
    'the suggested message must be validated before sendSMS');

  // And prove the rule actually bites on the text this model is primed to write.
  const { validateCopy } = require('../lib/campaigns/copy-validator');
  const { RULES } = require('../lib/campaigns/copy-rules');
  const options = {
    brandName: RULES.brand.defaultName,
    approvedProductCodes: RULES.defaultApprovedProductCodes
  };
  assert.equal(
    validateCopy('Vin from Vici. Your Tirzepatide is back in stock. Reply STOP to opt out.', options).ok,
    false
  );
  assert.equal(
    validateCopy('Vin from Vici. Your TZ is back in stock. Reply STOP to opt out.', options).ok,
    true
  );
});
