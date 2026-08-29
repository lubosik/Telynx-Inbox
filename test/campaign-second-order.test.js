'use strict';
/**
 * test/campaign-second-order.test.js — the two-order blind spot.
 *
 * These people were in no cohort at all: the one-time lists exclude them for
 * having ordered twice, and reorder and win-back exclude them for not having
 * ordered three times. 161 of them, worth $61,553.
 *
 * The risk this file guards is the opposite of the usual one. It is not that
 * the segment misses people, it is that it CLAIMS TOO MUCH: two orders give
 * one interval, and one interval passes every consistency test that exists
 * because there is nothing for it to disagree with.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OBSERVED,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  expectedGapDays,
  paidOrderTimes,
  qualifySecondOrder,
  selectDue
} = require('../lib/campaigns/second-order');

const { fieldsUsed } = require('../lib/campaigns/merge-fields');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const ord = (days, over = {}) => ({ contact_phone: '+15550000001', status: 'delivered', created_at: ago(days), ...over });

test('exactly two paid orders, never one and never three', () => {
  assert.equal(qualifySecondOrder({ orders: [ord(100)], now: NOW }).reason, 'fewer_than_two_orders');
  assert.equal(
    qualifySecondOrder({ orders: [ord(100), ord(60), ord(20)], now: NOW }).reason,
    'three_or_more_orders'
  );
  // Three orders belong to reorder_due, which can state a real rhythm. Taking
  // them here would put one interval's worth of confidence against a customer
  // the system can actually describe.
  assert.equal(qualifySecondOrder({ orders: [ord(100), ord(60)], now: NOW }).qualifies, true);
});

test('a cancelled or refunded order does not count toward the two', () => {
  for (const status of ['cancelled', 'refunded', 'failed', 'trash', 'pending']) {
    const verdict = qualifySecondOrder({ orders: [ord(100), ord(60), ord(20, { status })], now: NOW });
    assert.equal(verdict.qualifies, true, `${status} should not make this a three-order customer`);
  }
});

test('their own gap is used when it is plausible', () => {
  // Ordered 100 days ago and again 70 days ago: a 30-day gap, inside the
  // 16-to-64 band, so it is their rhythm rather than the shop's average.
  const verdict = qualifySecondOrder({ orders: [ord(100), ord(70)], now: NOW });
  assert.equal(verdict.qualifies, true);
  assert.equal(verdict.basis, 'personal_gap');
  assert.equal(verdict.expectedGapDays, 30);
});

test('an implausible gap falls back to what this shop actually does', () => {
  // Two orders three days apart is one shopping trip, not a fortnightly habit.
  const burst = qualifySecondOrder({ orders: [ord(100), ord(97)], now: NOW });
  assert.equal(burst.basis, 'observed_median');
  assert.equal(burst.expectedGapDays, OBSERVED.medianFirstToSecondDays);

  // And a gap of most of a year says nothing about when a third is due.
  const distant = qualifySecondOrder({ orders: [ord(300), ord(100)], now: NOW });
  assert.equal(distant.basis, 'observed_median');
});

test('somebody still inside their own gap is not due yet', () => {
  // Second order 10 days ago, their gap is 30 days. Twenty days early.
  const verdict = qualifySecondOrder({ orders: [ord(40), ord(10)], now: NOW });
  assert.equal(verdict.qualifies, false);
  assert.equal(verdict.reason, 'not_yet_due');
  assert.ok(verdict.dueAt > NOW.toISOString());
});

test('the fallback numbers are the measured ones, not round numbers somebody liked', () => {
  assert.equal(OBSERVED.medianFirstToSecondDays, 34);
  assert.equal(OBSERVED.plausibleMinimumDays, 16);
  assert.equal(OBSERVED.plausibleMaximumDays, 64);
  assert.equal(OBSERVED.repeatBuyersMeasured, 284);
  assert.ok(OBSERVED.measuredOn, 'an observation with no date cannot be re-derived');
});

test('the evidence never calls one interval a cadence', () => {
  const verdict = qualifySecondOrder({ orders: [ord(100), ord(70)], now: NOW });
  // The distinction that keeps this honest: reorder_due tells a customer the
  // business knows their pattern. On one observation, this must not.
  assert.match(verdict.evidence.note, /prior and not a cadence/);
  assert.equal(verdict.evidence.orderCount, 2);
});

test('one entry per person, however many orders they have', () => {
  const orders = [
    ord(100), ord(70),
    ord(90, { contact_phone: '+15550000002' }), ord(50, { contact_phone: '+15550000002' }),
    // Three orders: belongs elsewhere.
    ord(90, { contact_phone: '+15550000003' }), ord(60, { contact_phone: '+15550000003' }), ord(30, { contact_phone: '+15550000003' })
  ];
  const due = selectDue(orders, { now: NOW });
  assert.equal(due.length, 2);
  assert.equal(new Set(due.map(d => d.phone)).size, 2);
});

test('the copy offers nothing and claims nothing', () => {
  for (const template of [TEMPLATE, TEMPLATE_NO_PRODUCT]) {
    const verdict = validateCopy(template, {
      brandName: RULES.brand.defaultName,
      approvedProductCodes: RULES.defaultApprovedProductCodes
    });
    assert.equal(verdict.ok, true,
      `failed: ${JSON.stringify((verdict.failures || []).map(f => f.check))}`);
    // No code: they came back once without being paid to, so a discount here
    // spends margin on the people least likely to need it.
    assert.equal(fieldsUsed(template).includes('code'), false);
    // And no claim about their consumption, which one interval cannot support.
    const lower = template.toLowerCase();
    for (const phrase of ['you are due', "you're due", 'running low', 'run out', 'time to reorder', 'usually order']) {
      assert.equal(lower.includes(phrase), false, `${phrase} must not appear`);
    }
    assert.match(template, /Reply STOP to opt out/);
  }
});

test('paidOrderTimes deduplicates and sorts', () => {
  const times = paidOrderTimes([ord(70), ord(100), ord(70)]);
  assert.equal(times.length, 2);
  assert.ok(times[0] < times[1]);
});

test('expectedGapDays refuses fewer than two orders rather than inventing one', () => {
  assert.equal(expectedGapDays([]), null);
  assert.equal(expectedGapDays([Date.now()]), null);
});
