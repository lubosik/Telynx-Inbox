'use strict';
/**
 * test/campaign-checkin-offer-policy.test.js — when a positive check-in reply
 * carries a discount, and when it is just a conversation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS ENCODES, IN THE OWNER'S WORDS
 *
 *   "If we can see that they've ordered and haven't ordered again, but we've
 *    checked in with them, we can give them the code. If they order with the
 *    code, the next check-in will just be from that conversation history. If
 *    they haven't ordered, if it's been past their normal reorder date twice,
 *    then we can offer it to them. Just so we don't spam them with codes."
 *
 *   Both halves are ONE question — is this person lapsed, or simply between
 *   orders? — which is why there is no special case for "they redeemed it".
 *   Redeeming produces a recent order, and a recent order fails the test.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED
 *
 *   mayIssueCode refused anybody with three or more paid orders. Measured on
 *   the day it changed, that silently refused three of the four genuinely
 *   happy replies to a check-in, including the customer who wrote "I love the
 *   Reta! Started it on the 10th and down 6lbs". Order count is not what makes
 *   an offer wasteful; sending one to somebody who just ordered is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_REORDER_DAYS, mayOfferCheckInCode, reorderIntervalFor
} = require('../lib/campaigns/checkin-offer-policy');

const NOW = new Date('2026-09-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

/** A client answering the two reads the policy makes. */
function fakeClient({ orders = [], priorCodes = [], orderError = null } = {}) {
  return {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        in() { return chain; },
        limit() { return Promise.resolve({ data: priorCodes, error: null }); },
        order() {
          if (table === 'sms_orders') return Promise.resolve({ data: orders, error: orderError });
          return chain;
        }
      };
      return chain;
    }
  };
}

test('somebody who ordered once and never came back gets the first offer', async () => {
  // No waiting for a first offer: they ordered, they have not returned, and we
  // are already in a conversation with them. That is the whole case for it.
  const client = fakeClient({ orders: [{ created_at: daysAgo(24), status: 'delivered' }] });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'first_offer');
});

test('order count is not a reason to refuse', async () => {
  // The exact customer the old rule turned away: four paid orders, delighted,
  // refused as a "regular_customer" without anybody seeing it happen.
  const client = fakeClient({
    orders: [15, 60, 120, 200].map(d => ({ created_at: daysAgo(d), status: 'completed' }))
  });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, true, 'four orders must not be a refusal on its own');
  assert.equal(decision.orderCount, 4);
});

test('somebody who redeemed a code gets a conversation, not another discount', async () => {
  // No special case for this. Redeeming produced a recent order, and a recent
  // order is not lapsed.
  const client = fakeClient({
    orders: [{ created_at: daysAgo(5), status: 'processing' },
             { created_at: daysAgo(90), status: 'completed' }],
    priorCodes: [{ sent_at: daysAgo(7) }]
  });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'within_normal_reorder_cycle');
});

test('somebody who ignored a code qualifies again once properly lapsed', async () => {
  // Past their normal reorder date twice. They keep ageing towards this on
  // their own; nothing has to remember to re-offer.
  const client = fakeClient({
    orders: [{ created_at: daysAgo(80), status: 'delivered' }],
    priorCodes: [{ sent_at: daysAgo(60) }]
  });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'lapsed_past_two_intervals');
  assert.equal(decision.lapseAfterDays, DEFAULT_REORDER_DAYS * 2);
});

test('one day short of the threshold is still a refusal', async () => {
  // The boundary matters more than the middle: this is the difference between
  // a considered offer and spamming somebody who is simply mid-cycle.
  const client = fakeClient({
    orders: [{ created_at: daysAgo(69), status: 'delivered' }],
    priorCodes: [{ sent_at: daysAgo(40) }]
  });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, false, '69 days against a 70-day threshold');

  const client2 = fakeClient({
    orders: [{ created_at: daysAgo(70), status: 'delivered' }],
    priorCodes: [{ sent_at: daysAgo(40) }]
  });
  assert.equal((await mayOfferCheckInCode({ client: client2, phone: '+1', now: NOW })).allowed, true);
});

test('a personal rhythm beats the shop median when one actually exists', async () => {
  // Better evidence about this person. Measured on the live database, only 57
  // of 843 customers have enough consistent history to produce one, so the
  // median carries almost all the traffic — but where a personal number
  // exists it should win.
  const steady = [10, 40, 70, 100].map(d => ({ created_at: daysAgo(d), status: 'completed' }));
  const interval = reorderIntervalFor(steady, NOW);
  assert.equal(interval.source, 'personal');
  assert.ok(interval.days > 0 && interval.days < DEFAULT_REORDER_DAYS + 10);

  const sparse = [{ created_at: daysAgo(30), status: 'completed' }];
  assert.deepEqual(reorderIntervalFor(sparse, NOW), {
    days: DEFAULT_REORDER_DAYS, source: 'shop_median'
  });
});

test('unpaid orders do not count as coming back', async () => {
  // A cancelled or failed order is not a purchase, and treating one as recent
  // activity would withhold an offer from exactly the person who needs it.
  const client = fakeClient({
    orders: [{ created_at: daysAgo(2), status: 'cancelled' },
             { created_at: daysAgo(100), status: 'delivered' }],
    priorCodes: [{ sent_at: daysAgo(50) }]
  });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, true, 'the real last order was 100 days ago');
  assert.equal(decision.orderCount, 1);
});

test('an unreadable history refuses rather than guesses', async () => {
  // Fail closed. Not knowing whether somebody is lapsed is not evidence that
  // they are, and a discount sent on a database error cannot be taken back.
  const client = fakeClient({ orderError: { message: 'connection reset' } });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'offer_check_failed');
});

test('somebody with no paid order is refused', async () => {
  // A check-in only goes to somebody who ordered, so this should be
  // unreachable. If it happens something upstream is wrong, and an offer is
  // not the way to discover that.
  const client = fakeClient({ orders: [] });
  const decision = await mayOfferCheckInCode({ client, phone: '+15551110001', now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'never_ordered');
});
