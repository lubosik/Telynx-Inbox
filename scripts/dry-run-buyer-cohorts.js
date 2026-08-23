#!/usr/bin/env node
'use strict';

/**
 * scripts/dry-run-buyer-cohorts.js
 *
 * Aggregate-only, READ-ONLY diagnostic for the BUYER COHORTS and the
 * PORTFOLIO OPPORTUNITY DETECTOR, against live data.
 *
 * It reads `sms_orders`, `sms_contacts`, the campaign source tables and the
 * WooCommerce catalogue from the configured project. It writes NOTHING: no
 * row, no draft, no opportunity, no consent, no message. It calls no messaging
 * provider, it touches no send gate, and it creates and recomputes no saved
 * segment.
 *
 * Output contains NO customer identity: no phone number, no name, no email, no
 * order id, no message body. People are counted; people are not printed.
 * Product names and SKUs are public catalogue content, and this script prints
 * none of them either, because it has no reason to.
 *
 * WHAT IT IS FOR
 *   Three questions, in the order you need them:
 *     1. WHAT SHAPE IS THE CUSTOMER BASE   orders per buyer, one-time against
 *                                          repeat, counted per PERSON.
 *     2. HOW BIG IS EACH COHORT            live populations, order values and
 *                                          how long ago they bought.
 *     3. WHERE IS THE REVENUE              the detector's findings, with every
 *                                          projection's assumption printed and
 *                                          every refusal printed in full.
 *
 *   The refusals are not an appendix. A detector that quietly declines to
 *   answer looks the same as one that had nothing to decline, so they are
 *   printed as loudly as the findings.
 *
 * Usage:
 *   node scripts/dry-run-buyer-cohorts.js
 *   node scripts/dry-run-buyer-cohorts.js --json
 */

require('dotenv').config();

const { supabase } = require('../db');
const { wooGet } = require('../woocommerce');
const {
  readAuthoritativeGenerationSources
} = require('../lib/campaigns/generation-service');
const {
  BUYER_COHORTS,
  BUYER_COHORT_KEYS,
  COHORTS_NOT_BUILT,
  buildBuyerCohortFacts,
  computeBuyerCohortMembers
} = require('../lib/campaigns/buyer-cohorts');
const { detectOpportunities } = require('../lib/campaigns/opportunity-detector');

const WORKSPACE_ID = 'vici';

function money(value, currency) {
  if (value === null || value === undefined) return 'n/a';
  return `${Number(value).toFixed(2)} ${currency}`;
}

function pad(value, width) {
  return String(value).padStart(width);
}

function heading(text) {
  console.log(`\n${text}`);
  console.log('='.repeat(text.length));
}

function printFigure(figure, indent = '    ') {
  if (!figure) return;
  if (figure.kind === 'refusal') {
    console.log(`${indent}REFUSED TO PROJECT: ${figure.label}`);
    console.log(`${indent}  reason: ${figure.reason}`);
    console.log(`${indent}  ${figure.detail}`);
    if (figure.population !== null) console.log(`${indent}  population: ${figure.population}`);
    return;
  }
  if (figure.kind !== 'projection') return;
  console.log(`${indent}PROJECTION (hypothetical): ${figure.label}`);
  console.log(`${indent}  claim: ${figure.claim}`);
  console.log(`${indent}  people: ${figure.peopleRange.low} to ${figure.peopleRange.high} `
    + `of ${figure.population}`);
  console.log(`${indent}  money:  ${money(figure.moneyRange.low, figure.moneyRange.currency)} `
    + `to ${money(figure.moneyRange.high, figure.moneyRange.currency)}`);
  console.log(`${indent}  ${figure.assumption}`);
}

async function run() {
  const now = new Date();
  const asJson = process.argv.includes('--json');

  // The single authoritative read. Same function the generator and the segment
  // service use, so nothing here can disagree with what the product shows.
  const sources = await readAuthoritativeGenerationSources({
    client: supabase, now, workspaceID: WORKSPACE_ID, wooGet
  });
  const facts = buildBuyerCohortFacts(sources, { now });
  const portfolio = detectOpportunities(facts, { env: process.env });

  const cohorts = BUYER_COHORT_KEYS.map(key => {
    const members = computeBuyerCohortMembers(key, facts, { now });
    const phones = new Set(members.map(member => member.contactPhone));
    const buyers = facts.buyers.filter(buyer => phones.has(buyer.contactPhone));
    const values = buyers.map(buyer => buyer.onlyOrderValue).filter(value => value > 0);
    const availability = { all: 0, some: 0, none: 0, unknown: 0 };
    for (const buyer of buyers) {
      availability[buyer.onlyOrderAvailability] = (availability[buyer.onlyOrderAvailability] || 0) + 1;
    }
    return {
      key,
      name: BUYER_COHORTS[key].name,
      people: buyers.length,
      neverContacted: buyers.filter(buyer => !buyer.everCommerciallyContacted).length,
      orderValueSum: Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100,
      availability
    };
  });

  if (asJson) {
    console.log(JSON.stringify({
      computedAt: portfolio.computedAt,
      currency: portfolio.currency,
      coverage: facts.coverage,
      calibration: facts.calibration,
      baseline: portfolio.baseline,
      cohorts,
      findings: portfolio.findings,
      refusals: portfolio.refusals,
      notBuilt: portfolio.notBuilt,
      blockers: portfolio.blockers
    }, null, 2));
    return;
  }

  const currency = portfolio.currency;

  heading('1. WHAT SHAPE IS THE CUSTOMER BASE');
  const coverage = facts.coverage;
  console.log(`  known contacts                 ${pad(coverage.customers, 6)}`);
  console.log(`  of those, buyers               ${pad(coverage.buyers, 6)}`);
  console.log(`  contacts with no paid order    ${pad(coverage.contactsWithNoPaidOrder, 6)}`);
  console.log(`  paid orders considered         ${pad(coverage.ordersConsidered, 6)}`);
  console.log('\n  orders per buyer, counted PER PERSON:');
  for (const [orders, buyers] of Object.entries(coverage.ordersPerBuyer)
    .sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`    ${pad(orders, 4)} order(s)  ${pad(buyers, 6)} buyers`);
  }
  const oneTime = coverage.ordersPerBuyer['1'] || 0;
  console.log(`\n  one-time buyers  ${oneTime} of ${coverage.buyers}`
    + ` (${(100 * oneTime / Math.max(1, coverage.buyers)).toFixed(1)}%)`);
  console.log(`  repeat buyers    ${coverage.buyers - oneTime}`);
  console.log(`\n  order line identity: ${coverage.productIdentity.resolved} of `
    + `${coverage.productIdentity.items} resolved to a catalogue product`);

  heading('2. THE COHORTS, LIVE');
  console.log(`  ${'key'.padEnd(30)} ${pad('people', 7)} ${pad('never contacted', 16)} `
    + `${pad('already paid', 16)}`);
  for (const cohort of cohorts) {
    console.log(`  ${cohort.key.padEnd(30)} ${pad(cohort.people, 7)} `
      + `${pad(cohort.neverContacted, 16)} ${pad(money(cohort.orderValueSum, currency), 16)}`);
  }
  console.log('\n  can they still buy what they bought:');
  for (const cohort of cohorts) {
    console.log(`    ${cohort.key.padEnd(30)} all ${pad(cohort.availability.all, 5)}  `
      + `some ${pad(cohort.availability.some, 5)}  none ${pad(cohort.availability.none, 5)}  `
      + `unknown ${pad(cohort.availability.unknown, 5)}`);
  }

  heading('3. THE CUTS, AND WHETHER THEY STILL MATCH THE DATA');
  const drift = facts.calibration.drift;
  for (const entry of drift.entries) {
    const state = entry.observed === null ? 'not measurable' : (entry.drifted ? 'DRIFTED' : 'holds');
    console.log(`  ${entry.name.padEnd(34)} frozen ${pad(entry.frozen, 8)}  `
      + `live ${pad(entry.observed === null ? 'n/a' : entry.observed, 8)}  ${state}`);
  }
  console.log(`  ${drift.action}`);

  heading('4. WHAT CUSTOMERS DO WITH NO MESSAGE SENT');
  console.log('  This is the ORGANIC baseline. Every rate below happened with no contact at all.');
  console.log(`  Commercial contacts ever recorded: ${portfolio.baseline.commercialContactsRecorded}`);
  console.log('\n  placed a second order within N days of the first:');
  for (const row of portfolio.baseline.returnWithin) {
    const rate = row.cohortSize ? (100 * row.returned / row.cohortSize).toFixed(1) : 'n/a';
    console.log(`    within ${pad(row.horizonDays, 4)} days  ${pad(row.returned, 5)} of `
      + `${pad(row.cohortSize, 5)}  ${pad(rate, 6)}%`);
  }
  console.log('\n  of those STILL on one order at day A, returned by day B:');
  for (const row of portfolio.baseline.returnAfterPassing) {
    const rate = row.cohortSize ? (100 * row.returned / row.cohortSize).toFixed(1) : 'n/a';
    console.log(`    still one order at ${pad(row.stillOneTimeAtDays, 4)}d, by `
      + `${pad(row.byDays, 4)}d  ${pad(row.returned, 5)} of ${pad(row.cohortSize, 5)}  `
      + `${pad(rate, 6)}%`);
  }
  const second = portfolio.baseline.secondOrderValue;
  console.log(`\n  what a second order was actually worth: `
    + `lower quarter ${money(second.lowerQuartile, currency)}, `
    + `middle ${money(second.middle, currency)}, `
    + `upper quarter ${money(second.upperQuartile, currency)} (${second.count} observed)`);

  heading('5. WHERE THE REVENUE IS');
  console.log(`  Money already taken across the whole history read: `
    + `${money(portfolio.portfolio.moneyAlreadyTaken.alreadyTaken, currency)} `
    + `over ${portfolio.portfolio.moneyAlreadyTaken.orders} orders. `
    + 'Banked, not an opportunity.\n');
  for (const finding of portfolio.findings) {
    console.log(`  ${finding.title}  [${finding.key}]`);
    console.log(`    people: ${finding.population}`
      + (finding.actionability.belowFloor ? '   BELOW THE ACTIONABLE FLOOR' : ''));
    if (finding.observed?.moneyAlreadyTaken) {
      console.log(`    already paid: `
        + `${money(finding.observed.moneyAlreadyTaken.alreadyTaken, currency)}`);
    }
    if (finding.evidence?.orderValue) {
      const value = finding.evidence.orderValue;
      console.log(`    single order worth: lower quarter ${money(value.lowerQuartile, currency)}, `
        + `middle ${money(value.middle, currency)}, `
        + `upper quarter ${money(value.upperQuartile, currency)}`);
    }
    for (const figure of Object.values(finding.sizing || {})) printFigure(figure);
    console.log('');
  }

  heading('6. EVERYTHING THIS REFUSED TO PUT A NUMBER ON');
  for (const refusal of portfolio.refusals) {
    console.log(`  ${refusal.finding} / ${refusal.question}: ${refusal.reason}`);
    console.log(`    ${refusal.detail}`);
  }

  heading('7. COHORTS CONSIDERED AND DELIBERATELY NOT BUILT');
  for (const entry of COHORTS_NOT_BUILT) {
    console.log(`  ${entry.key}: ${entry.reason}`);
    console.log(`    ${entry.detail}`);
  }

  heading('8. WHAT STANDS BETWEEN THIS AND ANY ACTION');
  for (const blocker of portfolio.blockers) {
    console.log(`  [${blocker.severity}] ${blocker.key}`);
    console.log(`    ${blocker.detail}`);
  }

  console.log('\nThis script wrote nothing and sent nothing.');
}

run().catch(error => {
  console.error('Dry run failed:', error?.code || error?.message || error);
  process.exitCode = 1;
});
