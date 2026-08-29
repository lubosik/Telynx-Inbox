'use strict';
/**
 * test/campaign-coupon-attribution.test.js — the join that turns a redeemed
 * code into campaign revenue.
 *
 * The thing under test is a money number that will be read as fact, so most of
 * these cover the ways it could be WRONG rather than the way it is right: an
 * unpaid order counted, one code counted twice, someone else's code counted as
 * ours, or a failed query quietly reading as zero.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { UNPAID_STATUSES, campaignCouponRedemptions } = require('../lib/campaigns/coupon-attribution');

/**
 * Supabase-shaped stub. `sms_orders` is read through fetchAllRows, which pages
 * with .range() and applies .order(), so the stub has to answer both and then
 * return nothing on the second page or it loops.
 */
function stubClient({ recipients = [], orders = [], recipientError = null } = {}) {
  return {
    from(table) {
      if (table === 'sms_campaign_recipients') {
        const b = {
          select: () => b, eq: () => b, not: () => b,
          range: (from) => Promise.resolve({
            data: from === 0 ? recipients : [],
            error: recipientError
          })
        };
        return b;
      }
      // A real Supabase builder is BOTH chainable and thenable, and
      // fetchAllRows relies on that: it calls .range() first, then applies the
      // filter to the result, then .order(). A stub whose .range() returns a
      // bare Promise makes filter(query) fail on `query.overlaps`.
      let page = 0;
      const b = {
        select: () => b,
        overlaps: () => b,
        order: () => b,
        range: (from) => { page = from; return b; },
        then: (resolve, reject) =>
          Promise.resolve({ data: page === 0 ? orders : [], error: null }).then(resolve, reject)
      };
      return b;
    }
  };
}

const recipient = (code, over = {}) => ({
  id: `r-${code}`, contact_phone: '+1555000' + code.slice(-4),
  issued_coupon_code: code, sent_at: '2026-09-01T12:00:00Z',
  delivered_at: '2026-09-01T12:00:05Z', ...over
});
const order = (codes, over = {}) => ({
  woo_order_id: 900, contact_phone: '+15550000001', status: 'processing',
  total: '169.24', created_at: '2026-09-03T09:00:00Z', coupon_codes: codes, ...over
});

test('a redeemed code becomes revenue for the campaign that issued it', async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({
      recipients: [recipient('vin-aaaa111111'), recipient('vin-bbbb222222')],
      orders: [order(['vin-aaaa111111'], { woo_order_id: 901, total: '169.24' })]
    }),
    campaignID: 'camp-1'
  });
  assert.equal(result.available, true);
  assert.equal(result.issued, 2);
  assert.equal(result.redeemed, 1);
  assert.equal(result.revenue, 169.24);
  assert.equal(result.redemptionRate, 0.5);
  assert.equal(result.redemptions[0].wooOrderID, 901);
  // Proof the message landed before the order, which is what makes this
  // attribution rather than a coincidence in the same week.
  assert.equal(result.redemptions[0].deliveredAt, '2026-09-01T12:00:05Z');
});

test('an unpaid order is not revenue, however the code got there', async () => {
  for (const status of UNPAID_STATUSES) {
    const result = await campaignCouponRedemptions({
      client: stubClient({
        recipients: [recipient('vin-aaaa111111')],
        orders: [order(['vin-aaaa111111'], { status, total: '500.00' })]
      }),
      campaignID: 'camp-1'
    });
    // Counting a refund would make a campaign look most successful exactly
    // when it attracted the buyer who sent the goods back.
    assert.equal(result.redeemed, 0, status);
    assert.equal(result.revenue, 0, status);
    assert.equal(result.anomalies[0].reason, `order_${status}`);
  }
});

test('one single-use code on two paid orders is counted once and flagged', async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({
      recipients: [recipient('vin-aaaa111111')],
      orders: [
        order(['vin-aaaa111111'], { woo_order_id: 901, total: '100.00' }),
        order(['vin-aaaa111111'], { woo_order_id: 902, total: '250.00' })
      ]
    }),
    campaignID: 'camp-1'
  });
  assert.equal(result.redeemed, 1);
  assert.equal(result.revenue, 100);
  // A single-use code appearing twice is a WooCommerce problem, not a second
  // sale, so it is surfaced for a human rather than added to the total.
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].reason, 'code_used_more_than_once');
});

test("somebody else's coupon on an order is not our revenue", async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({
      recipients: [recipient('vin-aaaa111111')],
      // welcome20 and reece10 are real codes on this store, and neither
      // belongs to any campaign.
      orders: [order(['welcome20'], { total: '400.00' })]
    }),
    campaignID: 'camp-1'
  });
  assert.equal(result.redeemed, 0);
  assert.equal(result.revenue, 0);
  assert.equal(result.anomalies.length, 0, 'an unrelated coupon is not an anomaly, it is just not ours');
});

test('an order carrying our code beside another still counts once', async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({
      recipients: [recipient('vin-aaaa111111')],
      orders: [order(['welcome20', 'vin-aaaa111111'], { total: '200.00' })]
    }),
    campaignID: 'camp-1'
  });
  assert.equal(result.redeemed, 1);
  assert.equal(result.revenue, 200);
});

test('a campaign that issued no codes reports zero rather than dividing by it', async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({ recipients: [], orders: [] }), campaignID: 'camp-1'
  });
  assert.equal(result.available, true);
  assert.equal(result.issued, 0);
  assert.equal(result.redeemed, 0);
  assert.equal(result.revenue, 0);
  assert.ok(!Number.isNaN(result.redemptionRate ?? 0));
});

test('a missing migration reports unavailable, never zero revenue', async () => {
  const result = await campaignCouponRedemptions({
    client: stubClient({ recipientError: { code: '42703', message: 'column does not exist' } }),
    campaignID: 'camp-1'
  });
  // The distinction that matters on screen: "we cannot tell you yet" and
  // "this campaign earned nothing" must never look the same.
  assert.equal(result.available, false);
  assert.equal(result.reason, 'coupon_attribution_migration_missing');
  assert.equal(result.revenue, undefined);
});

test('a real database error throws rather than reading as no revenue', async () => {
  await assert.rejects(
    () => campaignCouponRedemptions({
      client: stubClient({ recipientError: { code: '08006', message: 'connection failure' } }),
      campaignID: 'camp-1'
    }),
    /Reading issued codes failed/
  );
});

test('the order sync captures coupon_lines on both write paths', () => {
  // WooCommerce has always returned coupon_lines on every order and this
  // codebase never read them, which is why a redeemed campaign code could not
  // be joined back to its campaign. Both paths matter: the create path handles
  // new orders, and the status-refresh path is the only one that revisits an
  // order whose row already exists.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'sync-woocommerce.js'), 'utf8'
  );
  const writes = source.match(/coupon_codes/g) || [];
  assert.ok(writes.length >= 2, `expected both write paths to set coupon_codes, found ${writes.length}`);
  assert.match(source, /coupon_lines/, 'coupon_lines must be read from the WooCommerce order');
  assert.match(source, /toLowerCase\(\)/, 'codes are minted lowercase and must be stored that way');
});
