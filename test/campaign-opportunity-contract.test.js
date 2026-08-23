'use strict';
/**
 * The opportunity contract: the assumed boundary between the cohort detector
 * and the proposal layer, and the only place a number may enter a proposal.
 *
 * THE PROPERTY THAT MATTERS MOST HERE
 *   "If a proposal carries a number, that number must state its assumption and
 *   where the assumption came from. Never present a projection as revenue."
 *   These tests prove all three halves of that: no number without a basis, no
 *   scenario without a resolvable assumption, and no figure at all under a
 *   label containing the word revenue.
 *
 * AND THE ONE THAT CATCHES THE OBVIOUS SHORTCUT
 *   Nothing in the contract computes. There is no default conversion rate, no
 *   fallback figure and no arithmetic on a missing value. A scenario that
 *   arrives without a figure is dropped with a reason rather than filled in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OPPORTUNITY_KINDS,
  OpportunityContractError,
  assertNoRevenueClaim,
  buildProjections,
  normaliseOpportunity,
  promptFactsFor
} = require('../lib/campaigns/opportunity-contract');

/** The opportunity the owner actually described, in the assumed shape. */
function opportunity(overrides = {}) {
  return {
    id: 'one_time_buyers_no_second_order',
    kind: 'repeat_purchase',
    title: 'Most buyers have ordered once and not come back',
    cohort: {
      key: 'one_time_buyers',
      label: 'One-time buyers',
      size: 700,
      sizeBasis: 'Customers with exactly one paid order, counted from sms_orders on the date shown.',
      segmentKey: null
    },
    facts: [{
      id: 'single_purchase_groups',
      label: 'Customer and product groups with exactly one purchase',
      value: 1318,
      unit: 'groups',
      basis: 'Measured from the order history, grouped by customer and product.'
    }],
    sizing: {
      reachable: 412,
      reachableBasis: 'Cohort members with a phone number and no STOP on record.',
      confidence: 'low',
      assumptions: [{
        id: 'second_purchase_rate',
        statement: 'One in twenty of the reachable cohort places a second order within ninety days',
        source: 'Assumed for illustration; no measured second-purchase rate exists for this list.'
      }],
      scenarios: [{
        id: 'second_orders_at_assumed_rate',
        label: 'Second orders at the stated rate',
        assumptionId: 'second_purchase_rate',
        value: 20,
        unit: 'orders'
      }]
    },
    detectedAt: '2026-08-23T09:00:00.000Z',
    detectorVersion: 'cohorts-2026-08-23',
    ...overrides
  };
}

test('a well-formed opportunity normalises and keeps every basis', () => {
  const normalised = normaliseOpportunity(opportunity());
  assert.equal(normalised.kind, 'repeat_purchase');
  assert.equal(normalised.cohort.size, 700);
  assert.match(normalised.cohort.sizeBasis, /exactly one paid order/);
  assert.equal(normalised.sizing.scenarios[0].assumptionId, 'second_purchase_rate');
  assert.equal(Object.isFrozen(normalised), true);
});

test('an unknown opportunity kind is refused rather than handled generically', () => {
  assert.throws(
    () => normaliseOpportunity(opportunity({ kind: 'vibes' })),
    error => error instanceof OpportunityContractError && error.code === 'OPPORTUNITY_KIND_UNSUPPORTED'
  );
});

test('an unexpected field is refused, because customer evidence never travels here', () => {
  assert.throws(
    () => normaliseOpportunity({ ...opportunity(), recipients: ['+15550001111'] }),
    /Unexpected opportunity field: recipients/
  );
});

// ── No customer, ever ───────────────────────────────────────────────────────

for (const [field, value] of [
  ['title', 'Sarah at sarah@example.com has not come back'],
  ['title', 'Call them on +1 555 000 1111'],
  ['title', 'Buyers from 42 Ocean Road']
]) {
  test(`an opportunity carrying customer identity in ${field} is refused: ${value.slice(0, 24)}`, () => {
    assert.throws(
      () => normaliseOpportunity(opportunity({ [field]: value })),
      error => error instanceof OpportunityContractError
    );
  });
}

test('a digit in a field that reaches a prompt is refused at the boundary', () => {
  assert.throws(
    () => normaliseOpportunity(opportunity({ title: '700 buyers have never come back' })),
    error => error.code === 'OPPORTUNITY_PROMPT_NUMBER_REJECTED'
  );
  assert.throws(
    () => normaliseOpportunity({
      ...opportunity(),
      cohort: { ...opportunity().cohort, label: '700 one-time buyers' }
    }),
    error => error.code === 'OPPORTUNITY_PROMPT_NUMBER_REJECTED'
  );
});

test('what reaches the model has no digits in it at all', () => {
  const facts = promptFactsFor(normaliseOpportunity(opportunity()));
  for (const [field, text] of Object.entries(facts)) {
    assert.equal(/\d/.test(text), false, `${field} carried a digit into the prompt: ${text}`);
  }
  assert.equal(facts.narrative, OPPORTUNITY_KINDS.repeat_purchase.narrative);
});

test('every kind narrative is number-free, because all of them reach a prompt', () => {
  for (const kind of Object.values(OPPORTUNITY_KINDS)) {
    assert.equal(/\d/.test(kind.narrative), false, `${kind.id} narrative carries a digit`);
    assert.equal(/\d/.test(kind.label), false, `${kind.id} label carries a digit`);
  }
});

test('a brace or a template marker in a detector string is refused, not stripped', () => {
  assert.throws(
    () => normaliseOpportunity(opportunity({ title: 'Buyers of {{product}} who never returned' })),
    /plain words/
  );
});

// ── Numbers, assumptions and the word revenue ───────────────────────────────

test('a scenario naming an assumption nobody declared is refused', () => {
  const broken = opportunity();
  broken.sizing.scenarios[0].assumptionId = 'a_rate_somebody_felt_was_right';
  assert.throws(
    () => normaliseOpportunity(broken),
    error => error.code === 'OPPORTUNITY_ASSUMPTION_MISSING'
  );
});

test('every projection carries its basis, and the scenario carries its assumption', () => {
  const { projections } = buildProjections(normaliseOpportunity(opportunity()));
  for (const projection of projections) {
    assert.ok(projection.basis, `${projection.id} has no basis`);
  }
  const scenario = projections.find(item => item.status === 'scenario');
  assert.equal(scenario.assumption.id, 'second_purchase_rate');
  assert.match(scenario.basis, /Holds only if/);
  assert.match(scenario.basis, /no measured second-purchase rate exists/);
});

test('a count is never marked as a forecast, and a scenario always is', () => {
  const { projections } = buildProjections(normaliseOpportunity(opportunity()));
  const count = projections.find(item => item.id === 'cohort_size');
  assert.equal(count.isForecast, false);
  assert.equal(count.status, 'stated_count');
  assert.equal(projections.find(item => item.status === 'scenario').isForecast, true);
});

test('insufficient_data sizing produces the label and NO point estimate', () => {
  const raw = opportunity();
  raw.sizing.confidence = 'insufficient_data';
  const { projections } = buildProjections(normaliseOpportunity(raw));
  const scenario = projections.find(item => item.id === 'second_orders_at_assumed_rate');
  assert.equal(scenario.status, 'insufficient_data');
  assert.equal(scenario.value, null);
  assert.match(scenario.basis, /insufficient data/i);
});

test('a scenario with no figure is dropped with a reason; nothing computes one', () => {
  const raw = opportunity();
  raw.sizing.scenarios[0].value = null;
  const { projections, dropped } = buildProjections(normaliseOpportunity(raw));
  assert.equal(projections.some(item => item.id === 'second_orders_at_assumed_rate'), false);
  assert.match(dropped.find(item => item.id === 'second_orders_at_assumed_rate').reason, /nothing here computes one/);
});

test('a reachable count with no basis is dropped rather than shown', () => {
  const raw = opportunity();
  delete raw.sizing.reachableBasis;
  const { projections, dropped } = buildProjections(normaliseOpportunity(raw));
  assert.equal(projections.some(item => item.id === 'reachable'), false);
  assert.match(dropped.find(item => item.id === 'reachable').reason, /without a basis/);
});

test('an opportunity with no sizing still produces the count, and says only that', () => {
  const raw = opportunity();
  delete raw.sizing;
  const { projections, dropped } = buildProjections(normaliseOpportunity(raw));
  assert.deepEqual(projections.map(item => item.id), ['cohort_size']);
  assert.match(dropped[0].reason, /a count and nothing else/);
});

test('MUTATION: a projection labelled revenue is refused, including projected revenue', () => {
  for (const label of ['Projected revenue', 'Revenue at the stated rate', 'Extra profit']) {
    assert.throws(
      () => assertNoRevenueClaim([{
        id: 'x', label, unit: 'usd', status: 'scenario', value: 1, assumption: { id: 'a' }
      }]),
      error => error.code === 'OPPORTUNITY_REVENUE_CLAIM_REJECTED',
      `"${label}" must be refused`
    );
  }
});

test('MUTATION: a point estimate smuggled onto an insufficient_data projection is refused', () => {
  assert.throws(
    () => assertNoRevenueClaim([{
      id: 'x', label: 'Second orders', unit: 'orders', status: 'insufficient_data', value: 35, assumption: null
    }]),
    error => error.code === 'OPPORTUNITY_POINT_ESTIMATE_REJECTED'
  );
});

test('MUTATION: a scenario with its assumption stripped off is refused', () => {
  assert.throws(
    () => assertNoRevenueClaim([{
      id: 'x', label: 'Second orders', unit: 'orders', status: 'scenario', value: 20, assumption: null
    }]),
    error => error.code === 'OPPORTUNITY_ASSUMPTION_MISSING'
  );
});

test('MUTATION: a projection status outside the closed list is refused', () => {
  assert.throws(
    () => assertNoRevenueClaim([{
      id: 'x', label: 'Second orders', unit: 'orders', status: 'estimate', value: 20, assumption: { id: 'a' }
    }]),
    error => error.code === 'OPPORTUNITY_PROJECTION_STATUS_UNKNOWN'
  );
});

test('no projection this layer builds is ever labelled revenue', () => {
  const { projections } = buildProjections(normaliseOpportunity(opportunity()));
  for (const projection of projections) {
    assert.equal(/revenue/i.test(`${projection.label} ${projection.unit}`), false);
  }
});
