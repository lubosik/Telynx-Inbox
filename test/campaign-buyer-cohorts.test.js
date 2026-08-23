'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  COHORTS_NOT_BUILT,
  COHORT_CALIBRATION,
  actionability,
  buildBuyerCohortFacts,
  buyerCohortCatalogue,
  computeBuyerCohortMembers,
  driftReport,
  oneTimeBuyer
} = require('../lib/campaigns/buyer-cohorts');
const {
  SizingError,
  assertNoHeadlineFigure,
  observed,
  observedMoney,
  project,
  quantiles,
  refuse,
  wilsonInterval
} = require('../lib/campaigns/opportunity-sizing');
const { detectOpportunities } = require('../lib/campaigns/opportunity-detector');
const {
  createOpportunityPortfolioService
} = require('../lib/campaigns/opportunity-portfolio');
const {
  BUYER_COHORT_SOURCE,
  SEGMENT_DEFINITION_KEYS,
  computeSegmentMembers,
  segmentDefinition
} = require('../lib/campaigns/segment-definitions');

const DAY_MS = 86400000;
const NOW = new Date('2026-08-23T12:00:00.000Z');

function daysAgo(days) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** One paid order. `items` carry a SKU, as the live rows do. */
function order({ id, phone, days, total, skus = ['BPC-10'] }) {
  return {
    id,
    woo_order_id: id,
    contact_phone: phone,
    status: 'completed',
    total: String(total),
    created_at: daysAgo(days),
    items: JSON.stringify(skus.map(sku => ({ sku, name: sku, quantity: 1 })))
  };
}

/** A catalogue entry the identity resolver can match a SKU against. */
function catalogueEntry(productID, sku) {
  return {
    productID,
    variationID: 0,
    parentName: sku,
    name: sku,
    sku,
    publicationStatus: 'publish',
    purchasable: true,
    inStock: true,
    stockQuantity: 10,
    manageStock: false
  };
}

function sources(orders, extra = {}) {
  const phones = [...new Set(orders.map(row => row.contact_phone))];
  return {
    orders,
    contacts: phones.map((phone, index) => ({ id: index + 1, phone, name: null })),
    inventory: [],
    catalogueInventory: [
      {
        workspace_id: 'vici', product_id: 900, variation_id: 0, name: 'BPC-10',
        stock_status: 'instock', stock_quantity: 10, manage_stock: false,
        purchasable: true, updated_at: NOW.toISOString()
      },
      {
        workspace_id: 'vici', product_id: 901, variation_id: 0, name: 'GHK-20',
        stock_status: 'instock', stock_quantity: 10, manage_stock: false,
        purchasable: true, updated_at: NOW.toISOString()
      }
    ],
    catalogueEntries: [catalogueEntry(900, 'BPC-10'), catalogueEntry(901, 'GHK-20')],
    catalogueAvailable: true,
    ledger: [],
    suppressions: [],
    support: [],
    supportAvailable: false,
    ...extra
  };
}

// ── the cut that matters most: customer level, never customer-product ────────

/**
 * The correction that produced this file. A buyer who bought BPC-157 once and
 * GHK-Cu once is a REPEAT customer with two one-time products. Counting
 * customer-product pairs turns 504 one-time buyers into an imaginary 1,300 and
 * makes the business look worse than it is.
 */
test('somebody who bought two different products on two occasions is not a one-time buyer', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550000001', days: 200, total: 100, skus: ['BPC-10'] }),
    order({ id: 2, phone: '+15550000001', days: 40, total: 120, skus: ['GHK-20'] }),
    order({ id: 3, phone: '+15550000002', days: 200, total: 100, skus: ['BPC-10'] })
  ]), { now: NOW });

  const crossProduct = facts.buyers.find(buyer => buyer.contactPhone === '+15550000001');
  assert.equal(crossProduct.orderCount, 2, 'two paid orders is two orders, whatever was in them');
  assert.equal(oneTimeBuyer(crossProduct), false);
  assert.equal(crossProduct.onlyOrderValue, null, 'a repeat customer has no single order value');
  assert.equal(crossProduct.distinctProductsEverBought, 2);

  for (const key of BUYER_COHORT_KEYS) {
    const members = computeBuyerCohortMembers(key, facts, { now: NOW });
    assert.ok(
      !members.some(member => member.contactPhone === '+15550000001'),
      `${key} must not contain a repeat customer`
    );
  }

  const genuine = computeBuyerCohortMembers('one_time_buyers', facts, { now: NOW });
  assert.deepEqual(genuine.map(member => member.contactPhone), ['+15550000002']);
  assert.equal(genuine[0].inclusionEvidence.countedAt, 'customer');
});

test('two orders of the SAME product is also a repeat customer', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550000003', days: 120, total: 100 }),
    order({ id: 2, phone: '+15550000003', days: 30, total: 100 })
  ]), { now: NOW });
  assert.equal(computeBuyerCohortMembers('one_time_buyers', facts, { now: NOW }).length, 0);
});

// ── the tenure cuts ──────────────────────────────────────────────────────────

test('the three tenure cohorts partition the one-time buyers with no overlap and no gap', () => {
  // One buyer on each side of every boundary, plus the boundaries themselves.
  const tenures = [0, 1, 29, 30, 31, 89, 90, 91, 200, 364, 365];
  const facts = buildBuyerCohortFacts(sources(tenures.map((days, index) =>
    order({ id: index + 1, phone: `+1555000${String(index + 10).padStart(4, '0')}`, days, total: 100 })
  )), { now: NOW });

  const parent = computeBuyerCohortMembers('one_time_buyers', facts, { now: NOW })
    .map(member => member.contactPhone).sort();
  const tenureKeys = ['one_time_first_month', 'one_time_slipping', 'one_time_lapsed'];
  const seen = new Map();
  for (const key of tenureKeys) {
    for (const member of computeBuyerCohortMembers(key, facts, { now: NOW })) {
      assert.ok(!seen.has(member.contactPhone),
        `${member.contactPhone} is in both ${seen.get(member.contactPhone)} and ${key}`);
      seen.set(member.contactPhone, key);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), parent,
    'every one-time buyer inside 365 days lands in exactly one tenure cohort');

  const at = days => {
    const buyer = facts.buyers.find(entry => entry.daysSinceLastOrder === days);
    return seen.get(buyer.contactPhone);
  };
  assert.equal(at(30), 'one_time_first_month', '30 days is still the first month');
  assert.equal(at(31), 'one_time_slipping');
  assert.equal(at(90), 'one_time_slipping', '90 days is still slipping');
  assert.equal(at(91), 'one_time_lapsed');
  assert.equal(at(365), 'one_time_lapsed', 'the lapsed cohort is closed at a year');
});

test('the boundaries are the frozen ones, and the frozen ones match this shop', () => {
  assert.equal(COHORT_CALIBRATION.earlyEndsAtDays, 30);
  assert.equal(COHORT_CALIBRATION.slippingEndsAtDays, 90);
  assert.equal(COHORT_CALIBRATION.lapsedEndsAtDays, 365);
  // The measurements the round boundaries were adopted on the strength of.
  // If these ever disagree with the boundaries by more than a few days, the
  // boundaries stopped being this shop's numbers and became somebody else's.
  assert.ok(Math.abs(COHORT_CALIBRATION.observedHalfReturnedByDays
    - COHORT_CALIBRATION.earlyEndsAtDays) <= 7);
  assert.ok(Math.abs(COHORT_CALIBRATION.observedNineInTenReturnedByDays
    - COHORT_CALIBRATION.slippingEndsAtDays) <= 7);
});

test('a cohort beyond a year is deliberately absent, and says so in code', () => {
  assert.ok(!BUYER_COHORT_KEYS.includes('one_time_dormant_over_a_year'));
  const recorded = COHORTS_NOT_BUILT.map(entry => entry.key);
  for (const key of ['one_time_dormant_over_a_year', 'rfm_grid',
    'propensity_or_lifetime_value_model', 'product_back_in_stock_buyers']) {
    assert.ok(recorded.includes(key), `${key} must be recorded as deliberately not built`);
  }
  for (const entry of COHORTS_NOT_BUILT) {
    assert.ok(entry.reason && entry.detail.length > 80,
      `${entry.key} must say why, at length`);
  }
});

test('drift is reported and never applied', () => {
  const report = driftReport(COHORT_CALIBRATION, {
    halfReturnedByDays: 61,
    nineInTenReturnedByDays: 94.3,
    typicalOneTimeOrderValue: 169.24,
    oneTimeBuyersObserved: 504,
    repeatBuyersObserved: 277
  });
  assert.equal(report.anyDrifted, true);
  assert.deepEqual(report.driftedNames, ['observedHalfReturnedByDays']);
  assert.match(report.action, /re-freeze/i);
  // The cuts themselves did not move.
  assert.equal(COHORT_CALIBRATION.earlyEndsAtDays, 30);
});

// ── the value and product cuts ───────────────────────────────────────────────

test('the spend cut is a single binary split, above or below the usual amount', () => {
  const above = COHORT_CALIBRATION.typicalOneTimeOrderValue + 1;
  const below = COHORT_CALIBRATION.typicalOneTimeOrderValue - 1;
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550001001', days: 50, total: above }),
    order({ id: 2, phone: '+15550001002', days: 50, total: below }),
    order({ id: 3, phone: '+15550001003', days: 50, total: COHORT_CALIBRATION.typicalOneTimeOrderValue })
  ]), { now: NOW });
  const members = computeBuyerCohortMembers('one_time_above_typical_spend', facts, { now: NOW });
  assert.deepEqual(members.map(member => member.contactPhone), ['+15550001001'],
    'strictly above; the usual amount itself is not above it');
  assert.equal(members[0].inclusionEvidence.spendBasis.aboveThisAmount,
    COHORT_CALIBRATION.typicalOneTimeOrderValue);
});

test('the product cut resolves identity from the catalogue, not from the line item fields', () => {
  // Neither line item carries product_id or variation_id, which is true of
  // 2,334 of the 2,346 paid line items on the live database.
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550002001', days: 50, total: 100, skus: ['BPC-10', 'GHK-20'] }),
    order({ id: 2, phone: '+15550002002', days: 50, total: 100, skus: ['BPC-10'] })
  ]), { now: NOW });
  assert.equal(facts.coverage.productIdentity.resolved, 3);
  assert.equal(facts.coverage.productIdentity.unresolved, 0);

  const members = computeBuyerCohortMembers('one_time_multi_product', facts, { now: NOW });
  assert.deepEqual(members.map(member => member.contactPhone), ['+15550002001']);
  assert.equal(members[0].inclusionEvidence.productsInOnlyOrder, 2);
  assert.equal(members[0].inclusionEvidence.productsStillPurchasable, 'all');
});

test('an unreadable catalogue reports stock as unknown rather than as gone', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550003001', days: 50, total: 100 })
  ], { catalogueAvailable: false, catalogueEntries: [], catalogueInventory: [] }), { now: NOW });
  const buyer = facts.buyers.find(entry => entry.contactPhone === '+15550003001');
  assert.equal(buyer.onlyOrderAvailability, 'unknown');
});

// ── membership is behaviour, never permission ────────────────────────────────

test('a cohort reads no consent, and carries no clearance of its own', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550004001', days: 50, total: 100 })
  ], {
    supportAvailable: true,
    support: [{ contact_phone: '+15550004001', observed_at: daysAgo(1), state: 'blocked' }],
    suppressions: [{
      contact_phone: '+15550004001', active: true, effective_at: daysAgo(2), expires_at: null
    }]
  }), { now: NOW });
  const members = computeBuyerCohortMembers('one_time_buyers', facts, { now: NOW });
  assert.equal(members.length, 1, 'a suppressed person still matches the pattern');
  assert.equal(members[0].commercialClearance, null);
  const evidence = JSON.stringify(members[0].inclusionEvidence);
  for (const word of ['consent', 'suppress', 'blocked', 'dnd', 'quietHours']) {
    assert.ok(!new RegExp(word, 'i').test(evidence),
      `inclusion evidence must not mention ${word}`);
  }
});

test('ever-contacted is recorded as information and filters nobody out', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550005001', days: 50, total: 100 })
  ], { ledger: [{ contact_phone: '+15550005001', workflow_category: 'winback', accepted_at: daysAgo(3) }] }),
  { now: NOW });
  const members = computeBuyerCohortMembers('one_time_buyers', facts, { now: NOW });
  assert.equal(members.length, 1);
  assert.equal(members[0].inclusionEvidence.everCommerciallyContacted, true);
  assert.equal(facts.baseline.neverContacted, false);
});

// ── the catalogue and the copy ───────────────────────────────────────────────

test('every cohort is a first-class automatic segment in the shared catalogue', () => {
  for (const key of BUYER_COHORT_KEYS) {
    const definition = segmentDefinition(key);
    assert.ok(definition, `${key} must be in the segment catalogue`);
    assert.equal(definition.source, BUYER_COHORT_SOURCE);
    assert.equal(definition.detector, 'buyer_cohort');
    assert.equal(definition.name, BUYER_COHORTS[key].name);
    assert.ok(SEGMENT_DEFINITION_KEYS.includes(key));
  }
});

test('a cohort computed through the shared catalogue produces the same people', () => {
  const facts = buildBuyerCohortFacts(sources([
    order({ id: 1, phone: '+15550006001', days: 10, total: 100 }),
    order({ id: 2, phone: '+15550006002', days: 200, total: 100 })
  ]), { now: NOW });
  const direct = computeBuyerCohortMembers('one_time_lapsed', facts, { now: NOW });
  const throughCatalogue = computeSegmentMembers(
    'one_time_lapsed', { buyerCohorts: facts }, { now: NOW });
  assert.deepEqual(
    throughCatalogue.map(member => member.contactPhone),
    direct.map(member => member.contactPhone)
  );
  // The shared wrapper owns `ruleVersion`; the cohort keeps its own under a
  // distinct key so the two meanings never collide.
  assert.ok(throughCatalogue[0].inclusionEvidence.ruleVersion);
  assert.match(throughCatalogue[0].inclusionEvidence.cohortRuleVersion, /^buyer-cohorts-/);
});

test('cohort copy is readable by a person who has never read the source', () => {
  const statistics = [
    'mad', 'median', 'interval', 'intervals', 'cadence', 'confidence', 'outlier',
    'outliers', 'outlying', 'variance', 'deviation', 'percentile', 'coefficient',
    'quantile', 'threshold', 'multiplier', 'qualifies', 'qualified', 'eligible',
    'cohort', 'quartile'
  ];
  const clinical = [
    'dose', 'doses', 'dosage', 'treatment', 'therapy', 'therapeutic', 'cure',
    'cures', 'heal', 'heals', 'healing', 'symptom', 'symptoms', 'patient',
    'patients', 'diagnose', 'prescribe', 'prescription', 'clinical'
  ];
  for (const entry of buyerCohortCatalogue()) {
    const copy = `${entry.name} ${entry.description}`;
    assert.ok(!/[–—]/.test(copy), `${entry.key} must not use a dash for a sentence break`);
    for (const word of [...statistics, ...clinical]) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(copy),
        `${entry.key} copy must not say "${word}"`);
    }
    assert.ok(entry.description.length >= 120 && entry.description.length <= 1000);
    assert.ok(entry.name.length <= 160);
  }
});

// ── sizing: the part that stops the system lying to its owner ────────────────

test('a projection cannot exist without its rate, that rate sample and a named source', () => {
  const base = {
    label: 'test', claim: 'no_action_baseline', population: 100,
    rateSuccesses: 10, rateTrials: 100, rateSource: 'internal_observed_cohort',
    rateSourceDetail: 'measured here', valueLow: 1, valueMid: 2, valueHigh: 3, currency: 'USD'
  };
  assert.ok(project(base).kind === 'projection');
  assert.throws(() => project({ ...base, claim: 'definitely_happening' }), SizingError);
  assert.throws(() => project({ ...base, rateSource: 'a_blog_i_read' }), SizingError);
  assert.throws(() => project({ ...base, rateSourceDetail: '' }), SizingError);
  assert.throws(() => project({ ...base, valueLow: 9 }), SizingError, 'values must be ordered');
});

test('a projection is a range and carries no bare headline number', () => {
  const figure = project({
    label: 'baseline', claim: 'no_action_baseline', population: 240,
    rateSuccesses: 18, rateTrials: 140, rateSource: 'internal_observed_cohort',
    rateSourceDetail: 'this shop, uncontacted', valueLow: 100, valueMid: 150, valueHigh: 220,
    currency: 'USD'
  });
  for (const banned of ['value', 'total', 'amount', 'revenue', 'estimate', 'headline']) {
    assert.ok(!(banned in figure), `a projection must not carry "${banned}"`);
  }
  assert.ok(figure.peopleRange.low < figure.peopleRange.high);
  assert.ok(figure.moneyRange.low < figure.moneyRange.high);
  assert.equal(figure.rate.trials, 140);
  assert.equal(figure.rate.successes, 18);
  assert.equal(figure.hypothetical, true);
  assert.match(figure.assumption, /12\.86%/);
  assert.match(figure.assumption, /18 of 140/);
  assert.match(figure.assumption, /has to beat/);
  assert.doesNotThrow(() => assertNoHeadlineFigure(figure));
});

test('a rate from somebody else says so in its own assumption sentence', () => {
  const figure = project({
    label: 'borrowed', claim: 'no_action_baseline', population: 100,
    rateSuccesses: 25, rateTrials: 100, rateSource: 'external_published',
    rateSourceDetail: 'A messaging vendor blog post, 2025.',
    valueLow: 10, valueMid: 20, valueHigh: 30, currency: 'USD'
  });
  assert.equal(figure.rate.fromThisShopsOwnData, false);
  assert.match(figure.assumption, /NOT from this shop's data/);
  assert.match(figure.assumption, /vendor blog post/);
});

test('incremental revenue from contact refuses by construction', () => {
  const refusal = project({
    label: 'extra orders a message would create', claim: 'incremental_from_contact',
    population: 504, rateSuccesses: 179, rateTrials: 454,
    rateSource: 'internal_observed_cohort', rateSourceDetail: 'organic return rate',
    valueLow: 100, valueMid: 150, valueHigh: 220, currency: 'USD'
  });
  assert.equal(refusal.kind, 'refusal');
  assert.equal(refusal.reason, 'no_measured_uplift');
  assert.equal(refusal.population, 504);
  assert.match(refusal.detail, /no promotional campaign has ever been delivered/i);
  assert.ok(!('moneyRange' in refusal), 'a refusal carries no money at all');
});

test('a measured uplift is the only thing that turns that refusal into a projection', () => {
  const figure = project({
    label: 'extra orders', claim: 'incremental_from_contact', population: 500,
    rateSuccesses: 0, rateTrials: 0, rateSource: 'internal_observed_cohort',
    rateSourceDetail: 'Holdout run in a later release.',
    valueLow: 100, valueMid: 150, valueHigh: 220, currency: 'USD',
    measuredUplift: { successes: 20, trials: 400 }
  });
  assert.equal(figure.kind, 'projection');
  assert.equal(figure.rate.trials, 400);
  assert.equal(figure.claim, 'incremental_from_contact');
});

test('a refusal reports the population and the observed values instead of a guess', () => {
  const values = quantiles([100, 150, 200, 400]);
  const refusal = refuse({
    label: 'what these people are worth',
    reason: 'no_observed_order_value',
    detail: 'They have never paid for anything here, so there is nothing to project from.',
    population: 150,
    observedInstead: values
  });
  assert.equal(refusal.kind, 'refusal');
  assert.equal(refusal.population, 150);
  assert.equal(refusal.observedInstead.middle, 175);
});

test('an observed figure cannot be dressed up as a headline', () => {
  assert.throws(() => observed({
    label: 'x', countedFrom: 'y', total: 5300
  }), SizingError);
  const figure = observedMoney({
    label: 'already paid', countedFrom: '504 single orders', currency: 'USD',
    amount: 95393.21, orders: 504, people: 504
  });
  assert.equal(figure.hypothetical, false);
  assert.equal(figure.alreadyTaken, 95393.21);
});

test('the interval on a rate widens as the sample shrinks', () => {
  const big = wilsonInterval(100, 1000);
  const small = wilsonInterval(10, 100);
  assert.equal(big.point, small.point);
  assert.ok((small.high - small.low) > (big.high - big.low) * 2);
  assert.deepEqual(wilsonInterval(0, 0), { point: null, low: null, high: null, successes: 0, trials: 0, z: 1.96 });
  assert.throws(() => wilsonInterval(5, 1), SizingError);
});

test('a group under the actionable floor is flagged rather than hidden', () => {
  const small = actionability(40);
  assert.equal(small.belowFloor, true);
  assert.match(small.note, /wide range of true rates/);
  assert.equal(actionability(400).belowFloor, false);
});

// ── the detector ─────────────────────────────────────────────────────────────

function detectorFixture() {
  const orders = [];
  let id = 1;
  // 12 one-time buyers spread across all three tenure cohorts.
  // Values straddle the spend cut and half the orders carry two products, so
  // every cohort in the catalogue has members rather than silently reading
  // zero and making an assertion about it pass for the wrong reason.
  for (const days of [5, 10, 20, 35, 50, 70, 100, 150, 200, 210, 15, 45]) {
    orders.push(order({
      id,
      phone: `+1555010${String(id).padStart(4, '0')}`,
      days,
      total: 120 + id * 12,
      skus: id % 2 === 0 ? ['BPC-10', 'GHK-20'] : ['BPC-10']
    }));
    id += 1;
  }
  // 4 repeat buyers, all cross-product, so the same-product engine sees none.
  for (let index = 0; index < 4; index += 1) {
    const phone = `+1555020${String(index).padStart(4, '0')}`;
    orders.push(order({ id: id++, phone, days: 180 - index * 10, total: 200, skus: ['BPC-10'] }));
    orders.push(order({ id: id++, phone, days: 150 - index * 10, total: 220, skus: ['GHK-20'] }));
  }
  return buildBuyerCohortFacts(sources(orders, {
    contacts: [{ id: 999, phone: '+15559990000', name: null }]
  }), { now: NOW });
}

test('the detector reports every cohort plus the structural findings', () => {
  const facts = detectorFixture();
  const portfolio = detectOpportunities(facts, { env: {} });
  const keys = portfolio.findings.map(finding => finding.key);
  for (const key of BUYER_COHORT_KEYS) assert.ok(keys.includes(key), `${key} missing`);
  for (const key of ['repeat_behaviour_is_cross_product', 'contacts_with_no_paid_order',
    'one_time_buyers_whose_product_is_gone']) {
    assert.ok(keys.includes(key), `${key} missing`);
  }
  // Biggest population first: the question is where the revenue is.
  const populations = portfolio.findings.map(finding => finding.population);
  assert.deepEqual(populations, [...populations].sort((a, b) => b - a));
});

test('the whole payload survives the no-headline check, findings and all', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  assert.doesNotThrow(() => assertNoHeadlineFigure(portfolio, 'opportunities'));
  for (const finding of portfolio.findings) {
    assert.ok(finding.evidence, `${finding.key} has no evidence`);
    assert.ok(finding.sizing, `${finding.key} has no sizing`);
    for (const figure of Object.values(finding.sizing)) {
      assert.ok(['projection', 'refusal'].includes(figure.kind),
        `${finding.key} produced a figure that is neither a projection nor a refusal`);
      if (figure.kind === 'projection') {
        assert.equal(figure.claim, 'no_action_baseline',
          `${finding.key} projected something other than the do-nothing baseline`);
        assert.ok(figure.rate.trials > 0);
      }
    }
  }
});

test('every finding asks the incremental question and every answer is a refusal', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  const cohortFindings = portfolio.findings.filter(finding => BUYER_COHORT_KEYS.includes(finding.key));
  assert.ok(cohortFindings.length > 0);
  for (const finding of cohortFindings) {
    assert.equal(finding.sizing.incremental.kind, 'refusal');
    assert.equal(finding.sizing.incremental.reason, 'no_measured_uplift');
  }
  const refusedKeys = portfolio.refusals.map(entry => `${entry.finding}:${entry.question}`);
  for (const finding of cohortFindings) {
    assert.ok(refusedKeys.includes(`${finding.key}:incremental`),
      'a refusal buried in a finding is a refusal somebody scrolls past');
  }
});

test('contacts who never paid are reported and explicitly refused a value', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  const finding = portfolio.findings.find(entry => entry.key === 'contacts_with_no_paid_order');
  assert.equal(finding.population, 1);
  assert.equal(finding.sizing.baseline.kind, 'refusal');
  assert.equal(finding.sizing.baseline.reason, 'no_observed_order_value');
});

test('money already taken is separated from money hypothesised', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  assert.equal(portfolio.portfolio.moneyAlreadyTaken.hypothetical, false);
  assert.ok(portfolio.portfolio.moneyAlreadyTaken.alreadyTaken > 0);
  const parent = portfolio.findings.find(entry => entry.key === 'one_time_buyers');
  assert.equal(parent.observed.moneyAlreadyTaken.hypothetical, false);
  const lapsed = portfolio.findings.find(entry => entry.key === 'one_time_lapsed');
  assert.equal(lapsed.sizing.baseline.hypothetical, true);
  assert.equal(lapsed.observed.moneyAlreadyTaken.hypothetical, false);
});

/**
 * The survivorship trap the conditional rates exist to avoid, and which the
 * first version of the detector walked straight into.
 *
 * A rate measured from day zero is dominated by people who came back inside a
 * week. Not one of those people is still in a one-time-buyer cohort. Quoting
 * that rate at a group that contains six-month-old buyers overstates it badly,
 * and quoting any single rate at a group spanning every tenure is the same
 * error wearing a different hat.
 */
test('a cohort spanning every tenure refuses a single rate rather than averaging one', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  for (const key of ['one_time_buyers', 'one_time_above_typical_spend', 'one_time_multi_product']) {
    const finding = portfolio.findings.find(entry => entry.key === key);
    assert.equal(finding.sizing.baseline.kind, 'refusal', `${key} must not quote one rate`);
    assert.equal(finding.sizing.baseline.reason, 'mixed_tenure_population');
    assert.ok(finding.sizing.baseline.observedInstead.middle > 0,
      'a refusal still reports what these people actually spent');
  }
  // The three groups that DO sit at one point in a customer life keep theirs.
  for (const key of ['one_time_first_month', 'one_time_slipping', 'one_time_lapsed']) {
    const finding = portfolio.findings.find(entry => entry.key === key);
    assert.equal(finding.sizing.baseline.kind, 'projection', `${key} should have a rate`);
  }
});

test('a tenure baseline says which way it is wrong', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  const lapsed = portfolio.findings.find(entry => entry.key === 'one_time_lapsed');
  assert.match(lapsed.sizing.baseline.assumption, /at or below this range/);
  assert.match(lapsed.sizing.baseline.assumption, /still on one order at day 90/);
});

/**
 * The rate a lapsed group is quoted must be lower than the rate a fresh group
 * is quoted. If it is not, the conditional measurement is not conditional.
 */
test('the further gone a group is, the lower the rate it is quoted', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  const rateOf = key => portfolio.findings
    .find(entry => entry.key === key).sizing.baseline.rate.point;
  assert.ok(rateOf('one_time_first_month') > rateOf('one_time_lapsed'),
    'a customer six months gone cannot be quoted the same chance as one from last week');
});

test('the portfolio states that sending is off and that nobody has been contacted', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: {} });
  const keys = portfolio.blockers.map(blocker => blocker.key);
  assert.ok(keys.includes('live_sending_is_off'));
  assert.ok(keys.includes('no_campaign_has_ever_been_sent'));
  assert.match(portfolio.baseline.whatThisMeasures, /has to beat/);
});

test('the reporting currency is configurable and never a symbol', () => {
  const portfolio = detectOpportunities(detectorFixture(), { env: { CAMPAIGN_REPORTING_CURRENCY: 'gbp' } });
  assert.equal(portfolio.currency, 'GBP');
  assert.ok(!/[$£€]/.test(JSON.stringify(portfolio)), 'no currency symbol may be emitted');
});

// ── refresh ──────────────────────────────────────────────────────────────────

test('the portfolio is cached, refreshed on demand and debounced', async () => {
  let reads = 0;
  const orders = [order({ id: 1, phone: '+15550007001', days: 50, total: 100 })];
  const service = createOpportunityPortfolioService({
    env: { CAMPAIGN_OPPORTUNITY_TTL_MS: '3600000', CAMPAIGN_OPPORTUNITY_MIN_REFRESH_MS: '300000' },
    sourceReader: async () => { reads += 1; return sources(orders); }
  });

  const first = await service.current({ now: NOW });
  assert.equal(reads, 1);
  assert.equal(first.freshness.stale, false);

  await service.current({ now: new Date(NOW.getTime() + 1000) });
  assert.equal(reads, 1, 'inside the time to live, the cache answers');

  const debounced = await service.current({ refresh: true, now: new Date(NOW.getTime() + 2000) });
  assert.equal(reads, 1, 'a forced refresh inside the debounce window does not read again');
  assert.equal(debounced.freshness.refreshDebounced, true);

  await service.current({ refresh: true, now: new Date(NOW.getTime() + 400000) });
  assert.equal(reads, 2, 'past the debounce window, a forced refresh reads');

  await service.current({ now: new Date(NOW.getTime() + 4000000) });
  assert.equal(reads, 3, 'past the time to live, an ordinary read refreshes');
});

test('a failed refresh serves the previous picture and says it is stale', async () => {
  let fail = false;
  const service = createOpportunityPortfolioService({
    env: { CAMPAIGN_OPPORTUNITY_TTL_MS: '1000' },
    sourceReader: async () => {
      if (fail) throw Object.assign(new Error('woo down'), { code: 'WOO_UNAVAILABLE' });
      return sources([order({ id: 1, phone: '+15550008001', days: 50, total: 100 })]);
    }
  });
  await service.current({ now: NOW });
  fail = true;
  const served = await service.current({ now: new Date(NOW.getTime() + 5000) });
  assert.equal(served.freshness.stale, true);
  assert.equal(served.freshness.lastRefreshFailure.code, 'WOO_UNAVAILABLE');
  assert.ok(served.findings.length > 0, 'a stale answer beats no answer');
});

test('a first read that fails with nothing cached is an error, not an empty screen', async () => {
  const service = createOpportunityPortfolioService({
    sourceReader: async () => { throw Object.assign(new Error('down'), { code: 'SOURCE_DOWN' }); }
  });
  await assert.rejects(() => service.current({ now: NOW }), /down/);
  assert.equal(service.cacheState({ now: NOW }).hasPayload, false);
  assert.equal(service.cacheState({ now: NOW }).lastRefreshFailure.code, 'SOURCE_DOWN');
});

test('concurrent refreshes share one read of the sources', async () => {
  let reads = 0;
  const service = createOpportunityPortfolioService({
    sourceReader: async () => {
      reads += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return sources([order({ id: 1, phone: '+15550009001', days: 50, total: 100 })]);
    }
  });
  await Promise.all([
    service.current({ now: NOW }), service.current({ now: NOW }), service.current({ now: NOW })
  ]);
  assert.equal(reads, 1);
});
