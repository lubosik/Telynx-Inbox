'use strict';
/**
 * test/checkin-owner-changes.test.js — the four changes the shop owner asked
 * for after watching a check-in batch go out on 8 September.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HE SAID, AND WHAT THE DATA SAID BACK
 *
 *   "Can we not do this text that just went out. The one that said reply with
 *    yes or no. If they got their order."
 *      → the `arrived_ok` angle is gone. He kept the rest: "the few weeks back
 *        is good".
 *
 *   "if they just ordered bac water let's not send those texts out"
 *      → an order that is nothing but consumables is skipped. 17 of 400 orders
 *        sampled. Bac water bought ALONGSIDE a product is the normal case, 121
 *        of 400, and those people are still checked in on.
 *
 *   "I even saw the GHK and BPC ones failed... maybe if we say GHK or BPC and TB"
 *      → measured before changing anything, on his own batch that day:
 *
 *            long-form name   3 sent   3 failed   100%
 *            short code      60 sent   1 failed     1.7%
 *
 *        Under the short-code rate, three-for-three is roughly a 1-in-200,000
 *        coincidence. Across all outbound history the same split holds more
 *        mildly, 2.8% against 1.0% once payment messages are excluded. He was
 *        right.
 *
 *   "I didn't see the checkin20 text go out but they loved it"
 *      → covered by test/checkin-offer-inbox-visibility.test.js.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ANGLES, VARIANTS, VARIANT_KEYS, selectCheckInVariant } = require('../lib/campaigns/checkin-variants');
const { isAccessoryOnlyOrder, checkInDueAt } = require('../lib/campaigns/check-in');

// ── The yes-or-no question is gone ─────────────────────────────────────────

test('no check-in message asks whether the order arrived', () => {
  // The shop already knows whether a parcel was delivered, from the carrier.
  // Asking the customer spends a message on something we can look up.
  assert.equal(ANGLES.includes('arrived_ok'), false);
  for (const key of VARIANT_KEYS) {
    const template = VARIANTS[key].template;
    assert.doesNotMatch(template, /a yes or no is plenty/i, key);
    assert.doesNotMatch(template, /reached you alright/i, key);
    assert.doesNotMatch(template, /\bdid (it|your order) arrive\b/i, key);
  }
});

test('every current message now asks an open question', () => {
  // The latest owner direction is that every check-in should solicit a real
  // response. No open-door statement is allowed to replace the question.
  for (const key of VARIANT_KEYS) {
    assert.match(VARIANTS[key].template, /\?/, key);
    assert.doesNotMatch(VARIANTS[key].template, /I['’]m right here/i, key);
  }
});

test('a variant key retired from the bank still selects cleanly', () => {
  // `last_checkin_variant` is read straight from the database, and everybody
  // who received the retired angle still has its key stored against them.
  const profile = { order_count: 4, engagement_tier: 'silent', last_product_name: 'GHK-Cu', last_product_sku: 'GHK' };
  const chosen = selectCheckInVariant({ profile, lastVariant: 'named_arrived_ok' });
  assert.ok(VARIANT_KEYS.includes(chosen.key), 'a live variant is still chosen');
  assert.equal(chosen.reason, 'quiet', 'a key that is no longer a candidate excludes nothing');
});

// ── Bac water ──────────────────────────────────────────────────────────────

test('an order that is only bac water gets no check-in', () => {
  // "You picked up Bac Water a few weeks back. How did it go?" is asking
  // somebody how they got on with sterile water.
  const order = { status: 'delivered', created_at: '2026-08-01T00:00:00Z', items: [{ name: 'Bac Water - 10ml' }] };
  assert.equal(isAccessoryOnlyOrder(order), true);
  assert.equal(checkInDueAt(order), null, 'and so it never becomes due');
});

test('bac water bought alongside a product still gets one', () => {
  // The normal way to buy it: 121 of 400 orders sampled. Those people are
  // checked in on about the product they actually bought.
  const order = {
    status: 'delivered', created_at: '2026-08-01T00:00:00Z',
    items: [{ name: 'Bac Water - 10ml' }, { name: 'GHK-Cu - 100mg' }]
  };
  assert.equal(isAccessoryOnlyOrder(order), false);
  assert.ok(checkInDueAt(order), 'and it does become due');
});

test('an order whose items cannot be read is sent, not skipped', () => {
  // An unreadable order is an unknown one. Skipping a real customer because a
  // JSON column would not parse is the worse of the two mistakes.
  for (const items of ['not json at all', null, undefined, [], {}]) {
    assert.equal(isAccessoryOnlyOrder({ items }), false, JSON.stringify(items));
  }
});

test('the match is specific enough not to catch a real product', () => {
  // "BAC" appears inside nothing here, but the guard is cheap and a future
  // product called something like "Bacteriostatic-adjacent" would be caught by
  // a looser pattern.
  for (const name of ['BPC-157 - 10mg', 'GHK-Cu', 'TB-500', 'KLOW', 'Glutathione - 1500mg']) {
    assert.equal(isAccessoryOnlyOrder({ items: [{ name }] }), false, name);
  }
});
