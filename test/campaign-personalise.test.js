'use strict';
/**
 * test/campaign-personalise.test.js — the wiring, not the renderer.
 *
 * test/campaign-personalisation.test.js already covers `renderForRecipients`
 * itself: what a merge field does with a missing name, how the per-recipient
 * copy check behaves. That module was never the problem. It was correct,
 * tested, and called from nowhere but its own tests, while approval copied the
 * raw template to every recipient row.
 *
 * So these tests are about the JOIN: that facts reach the renderer, that a
 * variation SKU resolves to a nameable product, that a code is minted once per
 * person and reused on a retry, and above all that a preview mints nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/** The catalogue, offline. Tests must never depend on vicipeptides.com. */
const OFFLINE_SKUS = new Map([['RT20', 'RT'], ['P-WA10', 'BAC Water'], ['TR30', 'TZ']]);

const {
  COUPON_PREFIX,
  factsForBuyer,
  issueCodes,
  itemsByValue,
  personaliseCampaign
} = require('../lib/campaigns/personalise');

/** A Supabase-shaped stub. Only the calls personalise.js actually makes. */
function stubClient({ contacts = [], orders = [] } = {}) {
  return {
    from(table) {
      const rows = table === 'sms_contacts' ? contacts : table === 'sms_orders' ? orders : [];
      const builder = {
        select() { return builder; },
        in(column, values) {
          const set = new Set(values);
          const key = table === 'sms_contacts' ? 'phone' : 'contact_phone';
          const matched = rows.filter(row => set.has(row[key]));
          // Awaitable AND pageable, because the real client is both. A fake
          // that only resolved could never express a 1000-row page, which is
          // precisely why it never caught readIn truncating.
          return {
            range(from, to) {
              return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
            },
            then(resolve, reject) {
              return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
            }
          };
        }
      };
      return builder;
    }
  };
}

/**
 * Coupon minting, without WooCommerce.
 *
 * ── IT USES THE REAL couponSpec AND THE REAL CALL SHAPE ────────────────────
 *
 * The previous stub took `{ coupons }` and hand-built specs, which is exactly
 * what personalise.js was passing and exactly what the module does NOT accept.
 * Every test passed and approving a campaign failed on the phone with
 * "createCoupons requires an array of coupon specs".
 *
 * A stub that answers whatever shape the caller invented tests nothing about
 * the boundary it is standing in for. So this one takes a POSITIONAL ARRAY,
 * like the real function, and throws the real error when it does not get one.
 * couponSpec is the genuine article, so a wrong field name fails here too.
 */
const { couponSpec: realCouponSpec } = require('../lib/woocommerce-coupons');

function stubCoupons({ failCodes = [], duplicateCodes = [] } = {}) {
  const created = [];
  return {
    calls: created,
    couponSpec: realCouponSpec,
    generateCode: ({ prefix, seed }) =>
      `${prefix}-${require('node:crypto').createHash('sha1').update(seed).digest('hex').slice(0, 10)}`,
    createCoupons: async (specs) => {
      if (!Array.isArray(specs)) {
        throw new Error('createCoupons requires an array of coupon specs.');
      }
      created.push(...specs);
      return {
        created: specs.filter(c => !failCodes.includes(c.code) && !duplicateCodes.includes(c.code)),
        failed: [
          ...failCodes.map(code => ({ code, errorCode: 'rejected', duplicate: false })),
          ...duplicateCodes.map(code => ({ code, errorCode: 'exists', duplicate: true }))
        ]
      };
    }
  };
}

test('itemsByValue names the product somebody came for, not the accessory beside it', () => {
  // Real shape: BAC water leads the array, the actual purchase is behind it.
  const order = {
    items: [
      { sku: 'P-WA10', name: 'BAC Water - 10ml', total: '20.00' },
      { sku: 'RT20', name: 'GLP3-Ret - 20mg', total: '130.50' }
    ]
  };
  assert.equal(itemsByValue(order)[0].sku, 'RT20');
});

test('a variation SKU resolves to its parent product name', () => {
  // The bug this covers: order lines carry RT20, the approved list holds
  // P-RT10, so matching the line item directly renders nothing and silently
  // drops every RT buyer from a campaign that names the product.
  const skuMap = new Map([['RT20', 'RT'], ['P-WA10', 'BAC Water']]);
  const facts = factsForBuyer({
    contact: { name: 'Kenzie Brown', orderCount: 1 },
    order: {
      items: [
        { sku: 'P-WA10', total: '20.00' },
        { sku: 'RT20', total: '130.50' }
      ],
      created_at: '2026-02-19T13:35:49.000Z'
    },
    skuMap
  });
  assert.equal(facts.lastProductName, 'RT');
  assert.equal(facts.lastOrderAt, '2026-02-19T13:35:49.000Z');
});

test('a top line with no approved code falls through to the next item', () => {
  const skuMap = new Map([['RT20', 'RT']]);
  const facts = factsForBuyer({
    contact: { name: 'A B' },
    order: { items: [{ sku: 'UNKNOWN99', total: '500.00' }, { sku: 'RT20', total: '10.00' }] },
    skuMap
  });
  assert.equal(facts.lastProductName, 'RT');
});

test('codes are deterministic per campaign and person, so a retry reuses them', async () => {
  const first = await issueCodes({
    campaignID: 'camp-1', phones: ['+15550000001', '+15550000002'],
    percentOff: 15, coupons: stubCoupons()
  });
  const second = await issueCodes({
    campaignID: 'camp-1', phones: ['+15550000001', '+15550000002'],
    percentOff: 15, coupons: stubCoupons()
  });
  assert.deepEqual([...first.byPhone.entries()], [...second.byPhone.entries()]);
  // Different campaign, different code for the same person.
  const other = await issueCodes({
    campaignID: 'camp-2', phones: ['+15550000001'], percentOff: 15, coupons: stubCoupons()
  });
  assert.notEqual(other.byPhone.get('+15550000001'), first.byPhone.get('+15550000001'));
});

test('a duplicate coupon counts as issued, because it is this campaign\'s own earlier attempt', async () => {
  const coupons = stubCoupons();
  const code = coupons.generateCode({ prefix: COUPON_PREFIX, seed: 'camp-1:+15550000001' });
  const withDuplicate = stubCoupons({ duplicateCodes: [code] });
  const result = await issueCodes({
    campaignID: 'camp-1', phones: ['+15550000001'], percentOff: 15, coupons: withDuplicate
  });
  assert.equal(result.byPhone.get('+15550000001'), code);
  assert.equal(result.failed.size, 0);
});

test('a genuinely failed coupon leaves that person without a code', async () => {
  const probe = stubCoupons();
  const code = probe.generateCode({ prefix: COUPON_PREFIX, seed: 'camp-1:+15550000001' });
  const result = await issueCodes({
    campaignID: 'camp-1', phones: ['+15550000001'], percentOff: 15,
    coupons: stubCoupons({ failCodes: [code] })
  });
  assert.equal(result.byPhone.has('+15550000001'), false);
  assert.equal(result.failed.size, 1);
});

test('issueCodes refuses a discount that is not a percentage', async () => {
  for (const bad of [0, 100, -5, 'fifteen', null]) {
    await assert.rejects(
      () => issueCodes({ campaignID: 'c', phones: ['+1'], percentOff: bad, coupons: stubCoupons() }),
      /percentOff must be between 1 and 99/
    );
  }
});

test('a preview mints nothing and still reports honest counts', async () => {
  const coupons = stubCoupons();
  const client = stubClient({
    contacts: [{ phone: '+15550000001', name: 'Kenzie Brown' }],
    orders: [{ contact_phone: '+15550000001', items: [{ sku: 'RT20', total: '130.50' }], created_at: '2026-02-19T00:00:00Z' }]
  });
  const result = await personaliseCampaign({
    client,
    campaignID: 'camp-preview',
    template: 'Vin from Vici. Hi {{first_name}}, use {{code}} for 15% off. Reply STOP to opt out.',
    phones: ['+15550000001'],
    percentOff: 15,
    dryRun: true,
    coupons,
    skuMap: OFFLINE_SKUS
  });
  // The single most important assertion in this file. A preview that mints
  // real coupons would issue 376 live discount codes every time somebody
  // opened the review screen.
  assert.equal(coupons.calls.length, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.rendered.length, 1);
  assert.match(result.rendered[0].message, /^Vin from Vici\. Hi Kenzie, use vin-/);
});

test('a template with no {{code}} never touches WooCommerce even for a real run', async () => {
  const coupons = stubCoupons();
  const client = stubClient({
    contacts: [{ phone: '+15550000001', name: 'Kenzie Brown' }],
    orders: [{ contact_phone: '+15550000001', items: [{ sku: 'RT20', total: '1' }], created_at: '2026-02-19T00:00:00Z' }]
  });
  await personaliseCampaign({
    client, campaignID: 'c', template: 'Vin from Vici. Hi {{first_name}}, checking in. Reply STOP to opt out.',
    phones: ['+15550000001'], dryRun: false, coupons, skuMap: OFFLINE_SKUS
  });
  assert.equal(coupons.calls.length, 0);
});

test('somebody with no nameable product is excluded rather than sent a gap', async () => {
  const client = stubClient({
    contacts: [
      { phone: '+15550000001', name: 'Kenzie Brown' },
      { phone: '+15550000002', name: 'Sam Reid' }
    ],
    orders: [
      { contact_phone: '+15550000001', items: [{ sku: 'RT20', total: '1' }], created_at: '2026-02-19T00:00:00Z' },
      { contact_phone: '+15550000002', items: [{ sku: 'NOTACODE', total: '1' }], created_at: '2026-02-19T00:00:00Z' }
    ]
  });
  const result = await personaliseCampaign({
    client, campaignID: 'c',
    template: 'Vin from Vici. Hi {{first_name}}, you took {{last_product}}. Reply STOP to opt out.',
    phones: ['+15550000001', '+15550000002'], dryRun: true, skuMap: OFFLINE_SKUS
  });
  assert.equal(result.rendered.length, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].phone, '+15550000002');
  assert.equal(result.excluded[0].reason, 'personalisation_unavailable');
});

test('an empty audience is refused rather than quietly succeeding', async () => {
  await assert.rejects(
    () => personaliseCampaign({ client: stubClient(), campaignID: 'c', template: 'hi', phones: [] }),
    /Cannot personalise an empty audience/
  );
});

test('the rendered month is a name and never a calendar date', async () => {
  const client = stubClient({
    contacts: [{ phone: '+15550000001', name: 'Kenzie Brown' }],
    orders: [{ contact_phone: '+15550000001', items: [{ sku: 'RT20', total: '1' }], created_at: '2026-02-19T13:35:49.000Z' }]
  });
  const result = await personaliseCampaign({
    client, campaignID: 'c',
    template: 'Vin from Vici. Hi {{first_name}}, it has been since {{last_order_date}}. Reply STOP to opt out.',
    phones: ['+15550000001'], dryRun: true, skuMap: OFFLINE_SKUS
  });
  assert.match(result.rendered[0].message, /since February\./);
  assert.doesNotMatch(result.rendered[0].message, /19|2026|-/);
});

test('the minted spec is what WooCommerce actually accepts', async () => {
  // This is the test that would have caught the failure on the phone. It
  // asserts the SHAPE at the boundary rather than trusting a stub to agree
  // with the caller.
  const coupons = stubCoupons();
  await issueCodes({
    campaignID: 'camp-1', phones: ['+15550000001'], percentOff: 15, coupons
  });
  assert.equal(coupons.calls.length, 1);
  const spec = coupons.calls[0];
  // Field names are the module's, not the caller's guess. `percentOff` was
  // what personalise.js sent; the module wants `percent` and turns it into a
  // string `amount`.
  assert.equal(spec.discount_type, 'percent');
  assert.equal(spec.amount, '15');
  assert.equal(typeof spec.amount, 'string', 'WooCommerce rejects a numeric amount on some versions');
  assert.equal(spec.individual_use, true);
  assert.equal(spec.usage_limit, 1);
  assert.equal(spec.usage_limit_per_user, 1);
  // ISO8601 with NO timezone designator. A bare date fails the module's own
  // check, and a trailing Z is read in the wrong timezone by the store.
  assert.match(spec.date_expires, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('the real createCoupons refuses the object shape this once sent', async () => {
  // Pinned against the actual export, so the two cannot drift again.
  const { createCoupons } = require('../lib/woocommerce-coupons');
  await assert.rejects(
    () => createCoupons({ coupons: [] }),
    /requires an array of coupon specs/
  );
});
