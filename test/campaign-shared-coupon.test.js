'use strict';
/**
 * test/campaign-shared-coupon.test.js — one code for a campaign.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE DESIGN CHANGED
 *
 *   The original minted one single-use coupon per recipient. 221 people, 221
 *   coupons. The owner's business partner asked why, and he was right to:
 *
 *     - the store's coupon table grows by the size of every audience, and ten
 *       campaigns of that size is two thousand coupons used zero or one times
 *     - the WooCommerce admin shows no campaign-level number at all
 *     - and, least obvious and most important, per-person codes carry NO email
 *       restriction, so each one works for whoever types it first. A code
 *       posted publicly is spent by a stranger and the customer it was meant
 *       for finds it dead.
 *
 *   One code restricted to the audience is simpler AND safer. These tests hold
 *   the safety half in place, because that is the half that is easy to lose.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { issueSharedCode } = require('../lib/campaigns/personalise');
const { couponSpec, CouponRequestError } = require('../lib/woocommerce-coupons');

/** Facts as gatherFacts builds them, carrying the email beside the merge fields. */
function factsFor(entries) {
  return new Map(entries.map(([phone, email]) => [phone, { contactName: 'A', email }]));
}

function stubCoupons(onSpec) {
  return {
    generateCode: ({ prefix }) => `${prefix}-shared01`,
    createCoupons: async specs => { onSpec?.(specs[0]); return { created: specs, failed: [] }; }
  };
}

test('one code covers the audience, once each', async () => {
  let spec;
  const phones = ['+15551110001', '+15551110002', '+15551110003'];
  const out = await issueSharedCode({
    campaignID: 'c1', phones,
    facts: factsFor([[phones[0], 'a@x.com'], [phones[1], 'b@x.com'], [phones[2], 'c@x.com']]),
    percentOff: 15, coupons: stubCoupons(s => { spec = s; })
  });

  assert.equal(new Set(out.byPhone.values()).size, 1, 'everybody gets the same code');
  assert.equal(out.restrictedTo, 3);
  assert.equal(spec.usage_limit_per_user, 1, 'once each is the rule');
  assert.equal(spec.usage_limit, 3, 'and no more redemptions than there are people');
  assert.equal(spec.individual_use, true, 'never stacks with another offer');
  assert.deepEqual(spec.email_restrictions.sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('a code is never minted without a restriction', async () => {
  // THE ONE THAT MATTERS. An unrestricted campaign-wide coupon is a public
  // discount, which is a different and far more expensive thing than what was
  // asked for. Failing loudly beats minting it.
  await assert.rejects(
    issueSharedCode({
      campaignID: 'c1', phones: ['+15551110001'],
      facts: factsFor([['+15551110001', null]]),
      percentOff: 15, coupons: stubCoupons()
    }),
    error => error.code === 'PERSONALISATION_NO_EMAILS'
  );
});

test('somebody with no email still receives the message, and is reported', async () => {
  // They cannot redeem it, so the caller has to be able to see that rather
  // than discover it from a support ticket.
  const phones = ['+15551110001', '+15551110002'];
  const out = await issueSharedCode({
    campaignID: 'c1', phones,
    facts: factsFor([[phones[0], 'a@x.com'], [phones[1], null]]),
    percentOff: 15, coupons: stubCoupons()
  });
  assert.equal(out.byPhone.get(phones[1]), out.code, 'still gets the message');
  assert.deepEqual(out.withoutEmail, [phones[1]], 'and is named as unable to redeem');
  assert.equal(out.restrictedTo, 1);
});

test('the same campaign mints the same code, so a retry does not make a second offer', async () => {
  const phones = ['+15551110001'];
  const facts = factsFor([[phones[0], 'a@x.com']]);
  const first = await issueSharedCode({ campaignID: 'c1', phones, facts, percentOff: 15, coupons: stubCoupons() });
  const again = await issueSharedCode({ campaignID: 'c1', phones, facts, percentOff: 15, coupons: stubCoupons() });
  assert.equal(first.code, again.code);
});

test('duplicate emails are collapsed, so one household cannot spend two allowances', () => {
  const spec = couponSpec({
    code: 'vin-shared01', percent: 15, usageLimit: 3,
    emailRestrictions: ['Same@X.com', 'same@x.com', 'other@x.com']
  });
  assert.deepEqual(spec.email_restrictions, ['same@x.com', 'other@x.com']);
});

test('a malformed address is refused rather than silently dropped', () => {
  // Dropping it would quietly leave that person unable to redeem, and the
  // campaign would look fine right up until they complained.
  assert.throws(
    () => couponSpec({ code: 'vin-shared01', percent: 15, emailRestrictions: ['a@x.com', 'not-an-email'] }),
    error => error instanceof CouponRequestError && error.code === 'COUPON_EMAIL_INVALID'
  );
});

test('an empty restriction list is refused, not treated as unrestricted', () => {
  assert.throws(
    () => couponSpec({ code: 'vin-shared01', percent: 15, emailRestrictions: [] }),
    error => error.code === 'COUPON_EMAIL_INVALID'
  );
});

test('the single-email form still works, because the reply path uses it', () => {
  // check-in-reply.js sends a code to one person at a time and has no audience
  // list, so per-person codes remain correct there.
  const spec = couponSpec({ code: 'vin-single01', percent: 15, emailRestriction: 'One@X.com' });
  assert.deepEqual(spec.email_restrictions, ['one@x.com']);
});

// ── A public code, chosen deliberately ─────────────────────────────────────

test('a public code carries no email restriction but keeps every other limit', async () => {
  // The owner's call: "it's a coupon code. They order, they punch it in, and
  // they get the discount. Done and dusted."
  //
  // Restricting to billing emails protected a guessable code from leaking, and
  // did so by risking the thing that matters more: a customer checking out
  // with a different address than the shop holds is refused, silently, at the
  // checkout. That failure is invisible and costs a sale. A leak is visible
  // and capped.
  let spec;
  const phones = ['+15551110001', '+15551110002', '+15551110003'];
  const out = await issueSharedCode({
    campaignID: 'c1', phones,
    facts: factsFor([[phones[0], 'a@x.com'], [phones[1], 'b@x.com'], [phones[2], null]]),
    percentOff: 20, publicCode: true, fixedCode: 'SMS20',
    coupons: stubCoupons(s => { spec = s; })
  });

  assert.equal(spec.email_restrictions, undefined, 'nobody is restricted');
  assert.equal(spec.usage_limit_per_user, 1, 'still once each');
  assert.equal(spec.usage_limit, 3, 'and the ceiling is still the audience size');
  assert.ok(spec.date_expires, 'and it still expires');
  assert.equal(spec.individual_use, true, 'and still cannot stack');
  assert.equal(out.code, 'SMS20');
  assert.equal(out.publicCode, true);
});

test('somebody with no email can redeem a public code', async () => {
  // The whole point. Under the restricted design they were sent a code they
  // could not use.
  const phones = ['+15551110001'];
  const out = await issueSharedCode({
    campaignID: 'c1', phones, facts: factsFor([[phones[0], null]]),
    percentOff: 20, publicCode: true, fixedCode: 'SMS20', coupons: stubCoupons()
  });
  assert.equal(out.byPhone.get(phones[0]), 'SMS20');
});

test('an unrestricted code is still refused when nobody ASKED for one', async () => {
  // The loud failure stays for the accidental case: a campaign that meant to
  // restrict and found no emails would otherwise create a public discount in
  // silence, which is a different and far more expensive thing.
  await assert.rejects(
    issueSharedCode({
      campaignID: 'c1', phones: ['+15551110001'],
      facts: factsFor([['+15551110001', null]]),
      percentOff: 20, coupons: stubCoupons()          // publicCode not set
    }),
    error => error.code === 'PERSONALISATION_NO_EMAILS'
  );
});

test('going public clears a restriction the coupon already had', async () => {
  // SMS20 is reused across campaigns. A coupon that was restricted last time
  // must not keep that list, or the people it was made public for are refused
  // anyway.
  let patch;
  await issueSharedCode({
    campaignID: 'c1', phones: ['+15551110001'],
    facts: factsFor([['+15551110001', 'a@x.com']]),
    percentOff: 20, publicCode: true, fixedCode: 'SMS20',
    coupons: {
      generateCode: () => 'SMS20',
      findCouponByCode: async () => ({ id: 7, code: 'sms20' }),
      updateCoupon: async (id, p) => { patch = p; return {}; },
      createCoupons: async () => { throw new Error('should have updated, not created'); }
    }
  });
  assert.deepEqual(patch.email_restrictions, [], 'the old list must be emptied, not left');
  assert.equal(patch.amount, '20');
});
