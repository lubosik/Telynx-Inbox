'use strict';
/**
 * test/campaign-reasoning-trail.test.js — showing the working.
 *
 * The fixtures are REAL production shapes, copied from the live detector and
 * from sms_campaign_segment_members.inclusion_evidence, because the one bug
 * this module has already had was reading a field that does not exist:
 * `baseline.rateSourceDetail` instead of `baseline.rate.sourceDetail`. Nothing
 * threw. The line just silently never appeared, and a trail that quietly omits
 * the number it exists to explain is worse than no trail.
 *
 * So the tests below assert on CONTENT, not on shape. A trail that renders
 * without error and says nothing passes a shape test and fails a person.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { cohortTrail, money, personTrail, plural } = require('../lib/campaigns/reasoning-trail');

/** Straight from sms_campaign_segment_members.inclusion_evidence in production. */
const REAL_PERSON = Object.freeze({
  detector: 'buyer_cohort', cohortKey: 'one_time_buyers', countedAt: 'customer',
  orderCount: 1, segmentKey: 'one_time_buyers', onlyOrderAt: '2026-07-08T20:51:05.000Z',
  ruleVersion: 'segments-2026-08-23',
  tenureBasis: { measuredOn: '2026-08-23', earlyEndsAtDays: 30, lapsedEndsAtDays: 365,
    slippingEndsAtDays: 90, repeatBuyersMeasured: 277 },
  onlyOrderValue: 86.74, additionalMatches: 0,
  cohortRuleVersion: 'buyer-cohorts-2026-08-23', daysSinceOnlyOrder: 53,
  productsInOnlyOrder: 2, productsStillPurchasable: 'all', everCommerciallyContacted: false
});

/** Straight from detectOpportunities().findings for one_time_lapsed. */
const REAL_FINDING = Object.freeze({
  key: 'one_time_lapsed',
  title: 'Bought once, and the usual return time has passed',
  population: 278,
  evidence: {
    people: { people: 278, neverContacted: 278,
      countedFrom: '1351 paid orders across 829 buyers, counted per person and never per product pair.' },
    orderValue: { currency: 'USD', middle: 155.74, lowerQuartile: 106.18, upperQuartile: 214.50 },
    timeSinceOrder: { middleDays: 175.5, earliestDays: 93, latestDays: 223 },
    canStillBuyIt: { everyProductStillOnSale: 239, someProductsGone: 29, everyProductGone: 10,
      countedFrom: 'The live WooCommerce catalogue, read through the shared catalogue cache.' }
  },
  sizing: {
    baseline: {
      claimMeans: 'What this group is expected to do with no message sent. It is a yardstick to '
        + 'judge a campaign against, not revenue a campaign would create.',
      rate: { point: 0.1392, successes: 22, trials: 158,
        sourceDetail: "Measured on this shop's own buyers: of those still on one order at day 90 "
          + 'and old enough to observe to day 180, 22 of 158 placed a second order.' }
    },
    incremental: { reason: 'no_measured_uplift',
      detail: 'There is no measured difference between contacting these customers and leaving '
        + 'them alone, because no promotional campaign has ever been delivered from this system.' }
  }
});

// ── The person ─────────────────────────────────────────────────────────────

test('a real evidence blob becomes sentences a person can read', () => {
  const trail = personTrail(REAL_PERSON);
  const text = trail.join(' ');

  assert.match(text, /ordered once/);
  assert.match(text, /8 July 2026/, 'the date must be written out, not left as an ISO string');
  assert.match(text, /53 days ago/);
  assert.match(text, /\$86\.74/);
  assert.match(text, /2 items/);
  assert.match(text, /Everything they bought is still on sale/);
  assert.match(text, /never been sent a marketing message/);
  assert.match(text, /277 repeat buyers/, 'the rate basis is the shop\'s own, and should say so');

  // No raw JSON, no field names, no ISO timestamps leaking through.
  assert.doesNotMatch(text, /[{}]|onlyOrderAt|cohortKey|ruleVersion|T\d\d:\d\d/);
});

test('nothing recorded produces nothing, rather than an invented reason', () => {
  // "We do not know why this person is here" is a real answer and a useful
  // one. Filling the gap with a plausible sentence would be the worst
  // available behaviour.
  assert.deepEqual(personTrail(null), []);
  assert.deepEqual(personTrail(undefined), []);
  assert.deepEqual(personTrail({}), []);
  assert.deepEqual(personTrail('one_time_buyers'), []);
});

test('a partial blob says only what it knows', () => {
  const trail = personTrail({ orderCount: 3, everCommerciallyContacted: true });
  assert.equal(trail.length, 2);
  assert.match(trail.join(' '), /ordered 3 times/);
  assert.match(trail.join(' '), /have been sent a marketing message before/i);
});

test('a broken date does not produce "Invalid Date" on somebody\'s screen', () => {
  const trail = personTrail({ orderCount: 1, onlyOrderAt: 'not-a-date', daysSinceOnlyOrder: 4 });
  assert.doesNotMatch(trail.join(' '), /Invalid|NaN|null|undefined/);
});

test('nothing here predicts the future or implies surveillance', () => {
  // The same standard copy-rules.js holds customer copy to. If the owner's
  // screen says "they are due" or "we have been tracking them", that is the
  // tone that ends up in a message.
  const text = personTrail(REAL_PERSON).join(' ').toLowerCase();
  for (const banned of ['due', 'should reorder', 'tracking', 'monitoring', 'will buy',
    'likely to', 'expected to', 'needs to']) {
    assert.ok(!text.includes(banned), `person trail must not say "${banned}"`);
  }
});

test('singular and plural are both right', () => {
  assert.match(personTrail({ orderCount: 1, daysSinceOnlyOrder: 1, onlyOrderAt: '2026-07-08T00:00:00Z' }).join(' '), /1 day ago/);
  assert.match(personTrail({ orderCount: 1, daysSinceOnlyOrder: 2, onlyOrderAt: '2026-07-08T00:00:00Z' }).join(' '), /2 days ago/);
  assert.match(personTrail({ orderCount: 1, productsInOnlyOrder: 1 }).join(' '), /1 item in it/);
  assert.equal(plural(1, 'day', 'days'), 'day');
});

// ── The group ──────────────────────────────────────────────────────────────

test('the cohort trail explains where every number came from', () => {
  const trail = cohortTrail(REAL_FINDING, { currency: 'USD' });
  const text = trail.join(' ');

  assert.match(text, /Bought once, and the usual return time has passed/);
  assert.match(text, /278/);
  assert.match(text, /1351 paid orders across 829 buyers/, 'the detector\'s own countedFrom must be quoted');
  assert.match(text, /\$155\.74/);
  assert.match(text, /239 yes, 29 partly, 10 no/);
  assert.match(text, /live WooCommerce catalogue/);
});

test('the rate detail appears, because it is the number the trail exists to explain', () => {
  // THE REGRESSION GUARD. The first version read `baseline.rateSourceDetail`.
  // The real field is `baseline.rate.sourceDetail`. Nothing threw; the line
  // simply never rendered, and the trail looked complete without it.
  const text = cohortTrail(REAL_FINDING).join(' ');
  assert.match(text, /22 of 158 placed a second order/,
    'the measured second-order rate must reach the screen');
  assert.match(text, /What normally happens:/);
});

test('the refusal to estimate uplift is stated, not left as an absence', () => {
  // opportunity-sizing.js deliberately refuses an incremental figure until an
  // uplift has been measured. An owner who sees a baseline and no caveat will
  // read the baseline as a forecast, so the caveat has to be louder than the
  // number rather than quieter.
  const text = cohortTrail(REAL_FINDING).join(' ');
  assert.match(text, /not estimated/);
  assert.match(text, /no promotional campaign has ever been delivered/);
  assert.match(text, /yardstick to judge a campaign against, not revenue a campaign would create/);
});

test('a cohort trail never presents the baseline as money a campaign would make', () => {
  const text = cohortTrail(REAL_FINDING).join(' ').toLowerCase();
  for (const claim of ['you will make', 'projected revenue', 'expected revenue',
    'this campaign will', 'guaranteed']) {
    assert.ok(!text.includes(claim), `cohort trail must not say "${claim}"`);
  }
});

test('a finding with blockers says what is in the way', () => {
  const trail = cohortTrail({
    key: 'x', title: 'Something', blockers: [{ detail: 'Nobody in this group has consent on file.' }]
  });
  assert.match(trail.join(' '), /In the way: Nobody in this group has consent on file\./);
});

test('an empty or malformed finding produces nothing rather than throwing', () => {
  assert.deepEqual(cohortTrail(null), []);
  assert.deepEqual(cohortTrail({}), []);
  assert.doesNotThrow(() => cohortTrail({ evidence: { people: {} }, sizing: { baseline: {} } }));
});

test('money formats as money, and refuses what is not', () => {
  assert.equal(money(86.7, 'USD'), '$86.70');
  assert.equal(money(5, 'GBP'), '£5.00');
  assert.equal(money(null), null);
  assert.equal(money('abc'), null);
});
