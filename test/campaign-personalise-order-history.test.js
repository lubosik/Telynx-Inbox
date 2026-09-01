'use strict';
/**
 * test/campaign-personalise-order-history.test.js — gatherFacts stops throwing
 * away the order history it has already read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT CHANGED, AND THE PART THAT MUST NOT HAVE
 *
 *   gatherFacts has always read EVERY sms_orders row for every phone in the
 *   audience. It then kept the newest one, kept a count, and discarded the
 *   rest — so anything wanting a second opinion about a customer (a reorder
 *   rhythm, a spend total, what they buy repeatedly) had to read the same rows
 *   again from somewhere else, and could disagree.
 *
 *   The risk in fixing that is not the new field. It is the six merge fields
 *   that render from the same object. `{{order_count}}` counts EVERY order row
 *   including the 252 cancelled and 83 failed ones, and `{{last_product}}`
 *   resolves from the newest order of ANY status. Both are arguably wrong and
 *   both are LIVE: a campaign approved today renders through them, and a
 *   "while I'm here" correction would silently change the text sent to real
 *   customers without anybody approving the change.
 *
 *   So this file asserts the new list is right AND that the old fields did not
 *   move, including in the cases where the two now disagree on purpose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { gatherFacts } = require('../lib/campaigns/personalise');
const { renderForRecipients } = require('../lib/campaigns/render-recipients');

const SKU_MAP = new Map([['RT20', 'RT'], ['P-WA10', 'BAC Water']]);
const LINK_MAP = new Map();

const NOW = Date.parse('2026-09-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

/** A client answering the three reads gatherFacts makes. */
function fakeClient({ contacts = [], orders = [] } = {}) {
  return {
    from(table) {
      const chain = {
        select() { return chain; },
        in() {
          const data = table === 'sms_contacts' ? contacts : orders;
          // Awaitable AND pageable, because the real client is both.
          return {
            range(from, to) {
              return Promise.resolve({ data: data.slice(from, to + 1), error: null });
            },
            then(resolve, reject) {
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
          };
        }
      };
      return chain;
    }
  };
}

const CONTACT = { phone: '+15551110001', name: 'Chloe Adams', email: 'C@Example.com ' };

async function factsFor(orders) {
  const client = fakeClient({ contacts: [CONTACT], orders });
  const facts = await gatherFacts({
    client, phones: [CONTACT.phone], skuMap: SKU_MAP, linkMap: LINK_MAP
  });
  return facts.get(CONTACT.phone);
}

test('every paid order comes back, newest first, with the fields a profile needs', async () => {
  // The whole point: three orders read, three orders returned. Before this the
  // caller got one and a number.
  const built = await factsFor([
    { contact_phone: CONTACT.phone, status: 'delivered', created_at: daysAgo(90), total: '129.00', items: [{ name: 'RT', sku: 'RT20', total: '129.00' }] },
    { contact_phone: CONTACT.phone, status: 'shipped', created_at: daysAgo(30), total: '99.50', items: [{ name: 'RT', sku: 'RT20', total: '99.50' }] },
    { contact_phone: CONTACT.phone, status: 'processing', created_at: daysAgo(2), total: '45.00', items: [{ name: 'BAC Water', sku: 'P-WA10', total: '45.00' }] }
  ]);

  assert.equal(built.orderHistory.length, 3);
  assert.deepEqual(
    built.orderHistory.map(order => order.created_at),
    [daysAgo(2), daysAgo(30), daysAgo(90)],
    'newest first, so the head of the list is the order the merge fields used'
  );
  // Each entry has to be usable on its own. A history of bare dates would send
  // the caller straight back to the table this exists to avoid re-reading.
  for (const order of built.orderHistory) {
    assert.ok(order.created_at, 'created_at');
    assert.ok(order.status, 'status');
    assert.ok(Array.isArray(order.items), 'items');
    assert.ok(order.total !== undefined, 'total');
  }
});

test('cancelled and failed orders are absent from the history but still counted by {{order_count}}', async () => {
  // The two answers deliberately differ, and both are correct for their own
  // question. 335 live rows are cancelled or failed; a profile that counted
  // them would treat a dead order as a purchase. {{order_count}} has always
  // counted them and is rendered into approved campaign copy, so changing it
  // here would alter messages nobody re-approved.
  const built = await factsFor([
    { contact_phone: CONTACT.phone, status: 'delivered', created_at: daysAgo(90), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] },
    { contact_phone: CONTACT.phone, status: 'cancelled', created_at: daysAgo(40), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] },
    { contact_phone: CONTACT.phone, status: 'failed', created_at: daysAgo(10), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] }
  ]);

  assert.equal(built.orderHistory.length, 1, 'only the delivered order is a purchase');
  assert.equal(built.orderHistory[0].status, 'delivered');
  assert.equal(built.orderCount, 3, '{{order_count}} must render exactly what it rendered before');
});

test('a customer whose only orders failed has an empty history and still renders', async () => {
  // This is the shape that must not throw anywhere downstream. An absent list
  // and an empty one are different, and a caller that has to check for the
  // difference eventually forgets to.
  const built = await factsFor([
    { contact_phone: CONTACT.phone, status: 'failed', created_at: daysAgo(10), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] }
  ]);
  assert.deepEqual(built.orderHistory, []);
  assert.equal(built.orderCount, 1);
});

test('somebody with no orders at all gets an empty array, not undefined', async () => {
  const built = await factsFor([]);
  assert.deepEqual(built.orderHistory, []);
  assert.equal(built.lastProductName, null);
});

test('the newest PAID order heads the history even when a later order was cancelled', async () => {
  // The merge fields resolve from the newest order of any status, so here the
  // two intentionally point at different rows. Asserted rather than left
  // implicit, because it is the case a future reader would "fix".
  const built = await factsFor([
    { contact_phone: CONTACT.phone, status: 'delivered', created_at: daysAgo(50), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] },
    { contact_phone: CONTACT.phone, status: 'cancelled', created_at: daysAgo(1), total: '10.00', items: [{ name: 'BAC Water', sku: 'P-WA10' }] }
  ]);
  assert.equal(built.orderHistory[0].created_at, daysAgo(50), 'the history is paid-only');
  assert.equal(built.lastOrderAt, daysAgo(1), 'the merge fields still use the newest row of any status');
});

test('orderHistory can never reach a rendered message', async () => {
  // merge-fields.js substitutes exactly six named fields and refuses every
  // other token, so a list riding alongside the facts is unrenderable by
  // construction. Proven rather than assumed: this is customer purchase data
  // sitting one object away from outbound SMS.
  const built = await factsFor([
    { contact_phone: CONTACT.phone, status: 'delivered', created_at: daysAgo(30), total: '129.00', items: [{ name: 'RT', sku: 'RT20' }] }
  ]);

  // The live 21-day check-in template, verbatim, so this renders through the
  // same compliance checks a real send does rather than through a shape
  // invented for the test.
  const outcome = renderForRecipients({
    template: 'It\'s Vin from Vici. Hi {{first_name}}, you picked up {{last_product}} a few '
      + 'weeks back. How did it go? Reply STOP to opt out.',
    recipients: [{ phone: CONTACT.phone, facts: built }]
  });

  assert.deepEqual(outcome.excluded, []);
  const message = outcome.rendered[0].message;
  assert.equal(
    message,
    'It\'s Vin from Vici. Hi Chloe, you picked up RT a few weeks back. How did it go? Reply STOP to opt out.'
  );
  assert.ok(!/orderHistory|129|delivered/.test(message), 'no order row leaks into the text');
});

test('the email that rides alongside the facts is untouched', async () => {
  // Regression guard on the field that already used this seam. Adding a second
  // non-merge field must not disturb the first.
  const built = await factsFor([]);
  assert.equal(built.email, 'c@example.com');
});
