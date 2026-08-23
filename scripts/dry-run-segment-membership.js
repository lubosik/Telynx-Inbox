#!/usr/bin/env node
'use strict';

/**
 * scripts/dry-run-segment-membership.js
 *
 * Aggregate-only, READ-ONLY diagnostic for SEGMENT MEMBERSHIP on live data,
 * with no counterfactual anywhere in it.
 *
 * It reads `sms_orders`, the campaign source tables and the WooCommerce
 * catalogue from the configured project. It writes NOTHING: no row, no draft,
 * no opportunity, no consent, no message. It calls no messaging provider, it
 * touches no send gate, and it creates and recomputes no saved segment.
 *
 * Output contains NO customer identity: no phone number, no name, no email, no
 * order id, no message body. Product names and SKUs are catalogue content and
 * are safe to print. People are counted; people are not printed.
 *
 * WHY IT EXISTS, AND HOW IT DIFFERS FROM THE IDENTITY DRY RUN
 *   scripts/dry-run-campaign-identity.js had to supply synthetic support
 *   clearance to see past a fail-closed gate, and said so loudly. Segment
 *   membership no longer sits behind that gate, so this script needs no such
 *   trick: every number below is the live answer.
 *
 *   It prints three things in the order you need them:
 *     1. WHO MATCHES        per segment, distinct people, live.
 *     2. WHO IS CONTACTABLE the same population, with the permission questions
 *                           applied as INFORMATION and every refusal named.
 *     3. WHY NOT MORE       the funnel from paid order to segment member, so a
 *                           small number is explained rather than asserted.
 *
 * Usage:
 *   node scripts/dry-run-segment-membership.js
 *   node scripts/dry-run-segment-membership.js --json
 */

require('dotenv').config();

const { supabase } = require('../db');
const { wooGet } = require('../woocommerce');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { buildSegmentationInput } = require('../lib/campaigns/generation-service');
const { catalogueInventoryRows, productCatalogue } = require('../lib/campaigns/product-catalogue');
const {
  cadenceFromIntervals,
  calculateReorderCadence,
  intervalDays,
  qualifyingPurchaseTimes
} = require('../lib/campaigns/reorder-cadence');
const { computeSegmentMembers, segmentCatalogue } = require('../lib/campaigns/segment-definitions');
const {
  readSegmentContactability,
  summariseCommercialClearance,
  summariseContactability
} = require('../lib/campaigns/segment-contactability');

const WORKSPACE_ID = 'vici';

function missingRelation(error) {
  return ['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code) ||
    /does not exist|could not find|schema cache/i.test(String(error?.message || ''));
}

/** Read a table, tolerating one the campaign migration has not created. */
async function optionalRows(table, columns, orderBy = 'id') {
  try {
    return { available: true, rows: await fetchAllRows(supabase, table, columns, { orderBy }) };
  } catch (error) {
    if (missingRelation(error)) return { available: false, rows: [] };
    throw error;
  }
}

function sortedCounts(record) {
  return Object.entries(record || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printCounts(label, record, indent = '  ') {
  const rows = sortedCounts(record);
  if (!rows.length) { console.log(`${indent}${label}: none`); return; }
  console.log(`${indent}${label}:`);
  for (const [key, value] of rows) console.log(`${indent}  ${String(value).padStart(6)}  ${key}`);
}

async function run() {
  const now = new Date();

  const [orderResult, contactResult, inventoryResult, restockResult,
    opportunityResult, ledgerResult, suppressionResult, supportResult] = await Promise.all([
    optionalRows('sms_orders', 'id,woo_order_id,contact_phone,status,items,total,created_at', 'created_at'),
    optionalRows('sms_contacts', 'id,phone,name,woo_customer_id', 'id'),
    optionalRows('sms_product_inventory', '*', 'updated_at'),
    optionalRows('sms_commerce_product_events', '*', 'received_at'),
    optionalRows('sms_campaign_opportunities', 'dedupe_key,source_id,status,created_campaign_id', 'created_at'),
    optionalRows('sms_commercial_contact_ledger', 'contact_phone,workflow_category,product_id,variation_id,accepted_at', 'created_at'),
    optionalRows('sms_campaign_suppressions', '*', 'created_at'),
    optionalRows('sms_customer_commercial_eligibility', '*', 'observed_at')
  ]);
  if (!orderResult.available) throw new Error('sms_orders is unavailable.');

  const catalogue = await productCatalogue({ wooGet, now, forceRefresh: true });

  // The live engine input for SEGMENTATION. Commercial clearance is observed
  // and carried, never used to drop a candidate. Nothing here is contactable
  // on the strength of appearing in it.
  const input = buildSegmentationInput({
    orders: orderResult.rows,
    contacts: contactResult.rows,
    inventory: inventoryResult.rows,
    restockEvents: restockResult.rows,
    opportunities: opportunityResult.rows,
    ledger: ledgerResult.rows,
    suppressions: suppressionResult.rows,
    support: supportResult.rows,
    supportAvailable: supportResult.available,
    catalogueEntries: catalogue.entries,
    catalogueInventory: catalogue.available
      ? catalogueInventoryRows(catalogue, { workspaceID: WORKSPACE_ID, now })
      : [],
    catalogueAvailable: catalogue.available,
    catalogueStale: catalogue.stale,
    catalogueFetchedAt: catalogue.fetchedAt,
    notificationUsers: []
  }, { now, workspaceID: WORKSPACE_ID });

  // ---- 1. who matches, live ----------------------------------------------
  const segments = [];
  const everyMemberPhone = new Set();
  for (const entry of segmentCatalogue()) {
    const members = computeSegmentMembers(entry.key, input, { now });
    for (const member of members) everyMemberPhone.add(member.contactPhone);
    segments.push({
      key: entry.key,
      name: entry.name,
      detector: entry.detector,
      people: members.length,
      clearance: summariseCommercialClearance(members),
      phones: members.map(member => member.contactPhone)
    });
  }

  // ---- 2. who is contactable, live ---------------------------------------
  // One bounded read for the union, then a per-segment summary sliced from it.
  const contactability = await readSegmentContactability({
    client: supabase, phones: [...everyMemberPhone], now, workspaceID: WORKSPACE_ID
  });
  for (const segment of segments) {
    segment.contactability = summariseContactability({
      phones: segment.phones,
      byPhone: contactability.byPhone,
      evaluated: contactability.evaluated,
      evaluatedAt: contactability.evaluatedAt,
      notEvaluatedReason: contactability.notEvaluatedReason
    });
    delete segment.phones;
  }

  // ---- 3. why not more ----------------------------------------------------
  // The funnel from candidate group to segment member. A candidate group is one
  // person and one parent product.
  const purchaseHistogram = {};
  const intervalHistogram = {};
  const personalCadence = {};
  const cadenceStates = {};
  const cadenceReasons = {};
  const peopleWithEnoughIntervals = new Set();
  for (const candidate of input.reorderCandidates) {
    const times = qualifyingPurchaseTimes(candidate.purchases);
    const intervals = intervalDays(times);
    const purchaseBucket = times.length >= 6 ? '6 or more' : String(times.length);
    purchaseHistogram[purchaseBucket] = (purchaseHistogram[purchaseBucket] || 0) + 1;
    const intervalBucket = intervals.length >= 5 ? '5 or more' : String(intervals.length);
    intervalHistogram[intervalBucket] = (intervalHistogram[intervalBucket] || 0) + 1;
    if (intervals.length >= 3) peopleWithEnoughIntervals.add(candidate.phone);

    const personal = cadenceFromIntervals(intervals, { minimumIntervals: 3 });
    personalCadence[personal.reason] = (personalCadence[personal.reason] || 0) + 1;

    const result = calculateReorderCadence({
      purchases: candidate.purchases,
      productCadence: candidate.productCadence,
      now,
      productAvailable: candidate.productAvailable !== false,
      alreadyContactedForLastPurchase: candidate.alreadyContactedForLastPurchase === true
    });
    cadenceStates[result.state] = (cadenceStates[result.state] || 0) + 1;
    cadenceReasons[result.reason] = (cadenceReasons[result.reason] || 0) + 1;
  }

  // The product-level fallback, product by product. This is the rule that is
  // supposed to rescue a customer with too little personal history, and
  // whether it fires is the difference between a handful of people and a lot.
  const productCadenceByKey = new Map();
  for (const candidate of input.reorderCandidates) {
    const key = `product:${candidate.productID}`;
    if (!productCadenceByKey.has(key)) {
      productCadenceByKey.set(key, {
        cadence: candidate.productCadence,
        name: candidate.productName || null
      });
    }
  }
  const productFallback = [];
  for (const [key, entry] of productCadenceByKey) {
    const intervals = entry.cadence?.intervals || [];
    const uniqueCustomers = Number(entry.cadence?.uniqueCustomers || 0);
    const aggregate = cadenceFromIntervals(intervals, { minimumIntervals: 20 });
    const meetsVolume = intervals.length >= 20 && uniqueCustomers >= 10;
    productFallback.push({
      key,
      product: entry.name,
      intervals: intervals.length,
      uniqueCustomers,
      meetsVolumeThreshold: meetsVolume,
      usable: aggregate.reliable && meetsVolume,
      reason: aggregate.reliable ? (meetsVolume ? 'usable' : 'too_few_customers') : aggregate.reason,
      medianDays: Number.isFinite(aggregate.medianDays) ? Math.round(aggregate.medianDays * 10) / 10 : null,
      relativeMAD: Number.isFinite(aggregate.relativeMAD) ? Math.round(aggregate.relativeMAD * 100) / 100 : null,
      outlierFraction: Number.isFinite(aggregate.outlierFraction) ? Math.round(aggregate.outlierFraction * 100) / 100 : null
    });
  }
  productFallback.sort((a, b) => b.intervals - a.intervals);

  const suppressionReasons = input.sourceSuppressions.reduce((acc, row) => {
    for (const reason of row.reasons || []) acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: now.toISOString(),
    mode: 'read_only_aggregate_dry_run',
    counterfactual: false,
    clearanceMode: input.clearanceMode,
    segmentationOnly: input.segmentationOnly,
    source: {
      ordersRead: orderResult.rows.length,
      contacts: contactResult.rows.length,
      commercialEligibilityRows: supportResult.rows.length,
      commercialEligibilityTableAvailable: supportResult.available,
      suppressions: suppressionResult.rows.length,
      catalogueAvailable: catalogue.available,
      lineItemsUnresolved: input.sourceCoverage.nonExactOrderItems,
      lineItemsResolved: input.sourceCoverage.productIdentity?.resolved ?? null
    },
    segments,
    funnel: {
      candidateGroups: input.reorderCandidates.length,
      peopleWithACandidateGroup: new Set(input.reorderCandidates.map(row => row.phone)).size,
      peopleWithThreeOrMoreIntervalsOnOneProduct: peopleWithEnoughIntervals.size,
      winbackCandidateGroups: input.winbackCandidates.length,
      purchasesPerCandidateGroup: purchaseHistogram,
      personalIntervalsPerCandidateGroup: intervalHistogram,
      personalCadenceOutcome: personalCadence,
      cadenceState: cadenceStates,
      cadenceReason: cadenceReasons,
      productLevelFallback: productFallback,
      sourceSuppressions: suppressionReasons
    }
  };
}

function report(result) {
  console.log('');
  console.log('SEGMENT MEMBERSHIP DRY RUN, LIVE, NO COUNTERFACTUAL');
  console.log(`  generated at        ${result.generatedAt}`);
  console.log(`  mode                ${result.mode}`);
  console.log(`  clearance           ${result.clearanceMode} (observed, not gated)`);
  console.log('');
  console.log('SOURCES');
  for (const [key, value] of Object.entries(result.source)) {
    console.log(`  ${key.padEnd(38)}${value}`);
  }
  console.log('');
  console.log('1. WHO MATCHES  (distinct people, live, behaviour only)');
  console.log(`  ${'segment'.padEnd(34)}${'match'.padStart(7)}${'contactable'.padStart(13)}`);
  for (const segment of result.segments) {
    const contactable = segment.contactability.evaluated
      ? String(segment.contactability.contactable) : 'not evaluated';
    console.log(`  ${segment.key.padEnd(34)}${String(segment.people).padStart(7)}${contactable.padStart(13)}`);
  }
  console.log('');
  console.log('2. WHY THEY ARE NOT CONTACTABLE  (information, never a filter)');
  for (const segment of result.segments) {
    if (!segment.people) continue;
    console.log(`  ${segment.key}: ${segment.people} match, ${segment.contactability.contactable} contactable`);
    for (const row of segment.contactability.reasons) {
      console.log(`    ${String(row.people).padStart(6)}  ${row.reason}`);
    }
  }
  console.log('');
  console.log('3. WHY NOT MORE  (the funnel, live)');
  console.log(`  candidate groups (person x parent product)   ${result.funnel.candidateGroups}`);
  console.log(`  people with at least one candidate group     ${result.funnel.peopleWithACandidateGroup}`);
  console.log(`  people with 3+ intervals on one product      ${result.funnel.peopleWithThreeOrMoreIntervalsOnOneProduct}`);
  console.log(`  win-back candidate groups                    ${result.funnel.winbackCandidateGroups}`);
  printCounts('qualifying purchases per candidate group', result.funnel.purchasesPerCandidateGroup);
  printCounts('personal intervals per candidate group', result.funnel.personalIntervalsPerCandidateGroup);
  printCounts('personal cadence outcome', result.funnel.personalCadenceOutcome);
  printCounts('cadence state', result.funnel.cadenceState);
  printCounts('cadence reason', result.funnel.cadenceReason);
  printCounts('source suppressions (recorded, not applied to membership)', result.funnel.sourceSuppressions);
  console.log('  product-level cadence fallback, product by product:');
  console.log(`    ${'product'.padEnd(16)}${'intervals'.padStart(10)}${'customers'.padStart(11)}${'relMAD'.padStart(8)}${'outliers'.padStart(10)}  verdict`);
  for (const row of result.funnel.productLevelFallback) {
    console.log(`    ${String(row.key).padEnd(16)}${String(row.intervals).padStart(10)}${String(row.uniqueCustomers).padStart(11)}${String(row.relativeMAD ?? '-').padStart(8)}${String(row.outlierFraction ?? '-').padStart(10)}  ${row.reason}`);
  }
  console.log('');
}

if (require.main === module) {
  run()
    .then(result => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else report(result);
      process.exit(0);
    })
    .catch(error => {
      console.error('dry run failed:', error.message);
      process.exit(1);
    });
}

module.exports = { run };
