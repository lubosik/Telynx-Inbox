'use strict';
/**
 * test/campaign-shared-code-attribution.test.js — a shared coupon still has to
 * be attributable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO BUGS, ONE SYMPTOM: $0 ON A CAMPAIGN THAT MADE $626.10
 *
 *   The owner was told by his partner that the win-back had already produced
 *   an order. The campaign screen said zero attributed revenue. Both were
 *   right: two people had redeemed SMS20 for $626.10 and neither reached the
 *   figure.
 *
 *   A revenue number reading zero is not obviously broken. It reads as a
 *   campaign that did not work, which is the most expensive kind of wrong: the
 *   conclusion is "stop doing this" rather than "check the code".
 *
 *   BUG 1 — CASE. The recipient row stores the code as written, because a
 *   message has to read "SMS20" and not "sms20". WooCommerce lowercases every
 *   code on storage, so the order carries ["sms20"], and Postgres array
 *   overlap is case-SENSITIVE. overlaps(['SMS20']) matched nothing.
 *
 *   This was introduced by the same change that made codes memorable: case was
 *   preserved so the message would read properly, WooCommerce's lookup was
 *   verified case-insensitive, and this path — an exact array match, not a
 *   lookup — was never checked.
 *
 *   BUG 2 — IDENTITY. `byCode` was a Map of code -> recipient, correct when
 *   everybody has their own `vin-xxxxxxxx`. A shared code collapses all 376
 *   recipients to one entry, and the "used more than once" guard then discards
 *   every redemption after the first as a WooCommerce fault. That guard is
 *   right for a single-use per-person code. For a shared code a second use by
 *   a DIFFERENT person is the entire point.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { campaignCouponRedemptions } = require('../lib/campaigns/coupon-attribution');

const ALICE = '+15551110001';
const BEN = '+15551110002';
const CARA = '+15551110003';

/** Recipients all holding one shared code, and the orders they placed. */
function fakeClient({ recipients = [], orders = [] } = {}) {
  return {
    from(table) {
      const rows = table === 'sms_campaign_recipients' ? recipients : orders;
      // Every method returns the chain and the chain is thenable, because the
      // real client is both: the recipients read awaits `.range()` directly,
      // while fetchAllRows calls `.range().overlaps().order()` and awaits that.
      // A fake that resolved at `.range()` could not express the second shape.
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        overlaps: () => chain,
        order: () => chain,
        range: () => chain,
        then: (resolve, reject) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      };
      return chain;
    }
  };
}

const recipient = (phone, code = 'SMS20') => ({
  id: `rec-${phone.slice(-4)}`,
  contact_phone: phone,
  issued_coupon_code: code,
  sent_at: '2026-09-01T18:00:00Z',
  delivered_at: '2026-09-01T18:03:00Z'
});

const order = (id, phone, total, codes = ['sms20'], status = 'shipped') => ({
  woo_order_id: id,
  contact_phone: phone,
  status,
  total: String(total),
  created_at: '2026-09-01T18:30:00Z',
  coupon_codes: codes
});

test('a code stored uppercase matches an order storing it lowercase', () => {
  // The exact live shape: recipient row "SMS20", order ["sms20"].
  const client = fakeClient({
    recipients: [recipient(ALICE)],
    orders: [order(5457, ALICE, 218.85)]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 1, 'case must not decide whether a sale counts');
    assert.equal(result.revenue, 218.85);
  });
});

test('two people redeeming one shared code is two sales, not a duplicate', () => {
  // The measured case: $626.10 across two orders reported as one sale of
  // $407.25, because the dedupe was keyed on the code.
  const client = fakeClient({
    recipients: [recipient(ALICE), recipient(BEN), recipient(CARA)],
    orders: [order(5457, ALICE, 218.85), order(5460, BEN, 407.25)]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 2);
    assert.equal(result.revenue, 626.10);
    assert.deepEqual(result.anomalies, [], 'neither is an anomaly');
  });
});

test('the same person redeeming twice IS an anomaly', () => {
  // One use per person is what the coupon promises. A second order from the
  // same buyer on the same code is a WooCommerce fault worth surfacing, and
  // the fix for shared codes must not lose that.
  const client = fakeClient({
    recipients: [recipient(ALICE)],
    orders: [order(5457, ALICE, 218.85), order(5470, ALICE, 100.00)]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 1, 'one person, one sale');
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].reason, 'code_used_more_than_once');
  });
});

test('somebody who was never sent the campaign cannot be claimed as its revenue', () => {
  // A public code travels. Somebody forwarding SMS20 to a friend is real
  // revenue and it is not revenue this campaign produced, and a campaign that
  // counts it would report a conversion rate nobody could reproduce.
  const client = fakeClient({
    recipients: [recipient(ALICE), recipient(BEN)],
    orders: [order(5480, '+15559999999', 500.00)]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 0, 'the revenue is refused');
    assert.equal(result.revenue, 0);
    // ...but not reported as a fault. Two campaigns issued SMS20, so every
    // sale the 376-person win-back makes would otherwise appear as an anomaly
    // on the 9-person one, for ever. A list that fills with expected events
    // teaches its reader to ignore it.
    assert.deepEqual(result.anomalies, [], 'expected, so not alarming');
  });
});

test('a PER-PERSON code counts by code alone, whatever phone the order carries', () => {
  // The quiet treatment above is only right because a shared code is meant to
  // travel. A vin-xxxxxxxx is known to one person AND restricted by email in
  // WooCommerce, so whoever placed the order, this campaign caused it: a
  // spouse's account, a second number. Matching by code is sufficient and
  // always was.
  const client = fakeClient({
    recipients: [recipient(ALICE, 'vin-aaaaaaaaaa')],
    orders: [order(5480, '+15559999999', 500.00, ['vin-aaaaaaaaaa'])]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 1, 'nobody else could have known the code');
    assert.equal(result.revenue, 500);
    assert.deepEqual(result.anomalies, [], 'and the email restriction makes a leak impossible');
  });
});

test('a cancelled order is not revenue, however the code was used', () => {
  const client = fakeClient({
    recipients: [recipient(ALICE)],
    orders: [order(5457, ALICE, 218.85, ['sms20'], 'cancelled')]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 0);
    assert.equal(result.anomalies[0].reason, 'order_cancelled');
  });
});

test('per-person codes still work exactly as before', () => {
  // The shared-code fix must not regress the design it was built for: one
  // code, one holder, and matching by code alone is sufficient.
  const client = fakeClient({
    recipients: [recipient(ALICE, 'vin-aaaaaaaaaa'), recipient(BEN, 'vin-bbbbbbbbbb')],
    orders: [
      order(5457, ALICE, 100.00, ['vin-aaaaaaaaaa']),
      order(5460, BEN, 200.00, ['vin-bbbbbbbbbb'])
    ]
  });
  return campaignCouponRedemptions({ client, campaignID: 'c1' }).then(result => {
    assert.equal(result.redeemed, 2);
    assert.equal(result.revenue, 300);
  });
});
