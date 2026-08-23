#!/usr/bin/env node
'use strict';

/**
 * scripts/dry-run-campaign-identity.js
 *
 * Aggregate-only, READ-ONLY diagnostic for product identity resolution and the
 * detector populations that depend on it.
 *
 * It reads `sms_orders` and the campaign source tables from the configured
 * Supabase project, and reads the WooCommerce catalogue. It writes NOTHING: no
 * row, no draft, no opportunity, no consent, no message. It calls no messaging
 * provider and touches no send gate.
 *
 * Output contains NO customer identity: no phone number, no name, no email, no
 * order id, no message body. Product names and SKUs ARE printed, because the
 * whole question is which catalogue product a line item is, and a catalogue
 * name is public shop content rather than customer data. Counts of people are
 * printed; people are not.
 *
 * WHY IT EXISTS
 *   The detectors returned zero candidates and the summary said only
 *   `nonExactOrderItems: 2334`, which does not tell you whether the cause is
 *   consent, inventory, cadence or identity. This prints the whole chain at
 *   once, and computes the BEFORE column with the old rule, so a change to the
 *   resolver is measured rather than asserted.
 *
 * Usage:
 *   node scripts/dry-run-campaign-identity.js
 *   node scripts/dry-run-campaign-identity.js --json
 */

require('dotenv').config();

const { supabase } = require('../db');
const { wooGet } = require('../woocommerce');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { buildGenerationInput } = require('../lib/campaigns/generation-service');
const {
  buildCatalogueIndex,
  resolveOrderItemIdentity,
  summariseResolutions
} = require('../lib/campaigns/product-identity');
const { catalogueInventoryRows, productCatalogue } = require('../lib/campaigns/product-catalogue');
const { calculateReorderCadence } = require('../lib/campaigns/reorder-cadence');
const { isDefinitelyAvailable } = require('../lib/campaigns/back-in-stock');
const { segmentCatalogue, segmentDefinition } = require('../lib/campaigns/segment-definitions');

const WORKSPACE_ID = 'vici';
const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);

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

function itemsFor(order) {
  if (Array.isArray(order?.items)) return order.items;
  if (typeof order?.items !== 'string') return [];
  try {
    const parsed = JSON.parse(order.items);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** The rule in force before this change: Woo IDs on the line item, or nothing. */
function previousRuleResolves(item) {
  const productID = Number(item?.product_id);
  const variationID = Number(item?.variation_id || 0);
  return Number.isSafeInteger(productID) && productID > 0 &&
    Number.isSafeInteger(variationID) && variationID >= 0;
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

/**
 * The purchasable units of the catalogue: every published variation, plus a
 * simple product that has no variations at all.
 *
 * A variable parent's own `stock_status` is a derived field and it goes stale.
 * On the live catalogue right now BPC-157, BPC-157 + TB-500, GHK-Cu + BPC-157 +
 * TB-500 and Ipamorelin all report `outofstock` on the parent while a
 * published, purchasable variation of each still has quantity. Counting those
 * parents as unavailable would claim four back-in-stock audiences that do not
 * exist, so the parent record is skipped whenever the product has variations.
 */
function purchasableUnits(entries) {
  const withVariations = new Set(entries.filter(row => row.variationID).map(row => row.productID));
  return entries.filter(entry => entry.publicationStatus === 'publish' &&
    (entry.variationID ? true : !withVariations.has(entry.productID)));
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
  const catalogueIndex = buildCatalogueIndex(catalogue.entries);
  const catalogueInventory = catalogue.available
    ? catalogueInventoryRows(catalogue, { workspaceID: WORKSPACE_ID, now })
    : [];

  // ---- identity, item by item -------------------------------------------
  const paidOrders = orderResult.rows.filter(order =>
    PAID_STATUSES.has(String(order.status || '').toLowerCase()));

  const resolutions = [];
  let previousRuleResolved = 0;
  const unresolvedExamples = new Map();
  // Prior buyers per purchasable unit, built here from the resolved items
  // rather than from detector output. Detector output is already filtered by
  // current availability, which is exactly the wrong population for the
  // question "who would we reach if this unavailable item came back". Phone
  // numbers are used to count distinct people and are never printed.
  const buyersByKey = new Map();
  for (const order of paidOrders) {
    for (const item of itemsFor(order)) {
      if (previousRuleResolves(item)) previousRuleResolved += 1;
      const resolution = resolveOrderItemIdentity(item, catalogueIndex, {
        catalogueAvailable: catalogue.available
      });
      resolutions.push(resolution);
      if (resolution.resolved && order.contact_phone) {
        for (const key of [`${resolution.productID}:0`,
          resolution.variationID ? `${resolution.productID}:${resolution.variationID}` : null]) {
          if (!key) continue;
          if (!buyersByKey.has(key)) buyersByKey.set(key, new Set());
          buyersByKey.get(key).add(order.contact_phone);
        }
      }
      if (!resolution.resolved) {
        // Catalogue-facing detail only: the SKU and printed name of a shop
        // product, so a human can see WHICH product is unreachable and why.
        const key = `${item?.sku || '<no sku>'} :: ${item?.name || '<no name>'} :: ${resolution.reasons.join(',')}`;
        unresolvedExamples.set(key, (unresolvedExamples.get(key) || 0) + 1);
      }
    }
  }
  const identity = summariseResolutions(resolutions);

  // ---- the detectors, before and after ----------------------------------
  const commonSources = {
    orders: orderResult.rows,
    contacts: contactResult.rows,
    inventory: inventoryResult.rows,
    restockEvents: restockResult.rows,
    opportunities: opportunityResult.rows,
    ledger: ledgerResult.rows,
    suppressions: suppressionResult.rows,
    support: supportResult.rows,
    supportAvailable: supportResult.available,
    notificationUsers: []
  };

  // BEFORE: no catalogue at all. That is exactly the old behaviour, because the
  // old rule read Woo IDs off the line item and consulted nothing else.
  const before = buildGenerationInput({
    ...commonSources, catalogueEntries: [], catalogueInventory: [], catalogueAvailable: true
  }, { now, workspaceID: WORKSPACE_ID });

  const after = buildGenerationInput({
    ...commonSources,
    catalogueEntries: catalogue.entries,
    catalogueInventory,
    catalogueAvailable: catalogue.available,
    catalogueStale: catalogue.stale,
    catalogueFetchedAt: catalogue.fetchedAt
  }, { now, workspaceID: WORKSPACE_ID });

  // COUNTERFACTUAL, diagnostic only. `sms_customer_commercial_eligibility` is
  // empty in production, so `authoritativeSupportState()` answers "unknown" for
  // every phone and the engine fails closed before it ever looks at cadence.
  // That gate is correct and is left alone. To show whether PRODUCT IDENTITY is
  // fixed we have to look behind it, so this pass supplies a synthetic current
  // "clear" observation for every phone in the order history and reruns the
  // same untouched engine. It measures reach, not permission: nobody is
  // contactable on the strength of it, and it exists only in this script.
  const supportClearAt = new Date(now.getTime() - 60000).toISOString();
  const syntheticSupport = [...new Set(orderResult.rows
    .map(order => order.contact_phone).filter(Boolean))]
    .map(contact_phone => ({
      contact_phone, status: 'clear', source: 'dry_run_counterfactual',
      evidence_ref: 'dry-run:not-evidence', observed_at: supportClearAt, expires_at: null
    }));
  const reach = buildGenerationInput({
    ...commonSources,
    support: syntheticSupport,
    supportAvailable: true,
    catalogueEntries: catalogue.entries,
    catalogueInventory,
    catalogueAvailable: catalogue.available,
    catalogueStale: catalogue.stale,
    catalogueFetchedAt: catalogue.fetchedAt
  }, { now, workspaceID: WORKSPACE_ID });

  const reachBefore = buildGenerationInput({
    ...commonSources,
    support: syntheticSupport,
    supportAvailable: true,
    catalogueEntries: [], catalogueInventory: [], catalogueAvailable: true
  }, { now, workspaceID: WORKSPACE_ID });

  // ---- cadence detail on the new candidates ------------------------------
  const cadenceStates = {};
  const cadenceReasons = {};
  const confidences = {};
  for (const candidate of reach.reorderCandidates) {
    const result = calculateReorderCadence({
      purchases: candidate.purchases,
      productCadence: candidate.productCadence,
      now,
      productAvailable: candidate.productAvailable !== false,
      alreadyContactedForLastPurchase: candidate.alreadyContactedForLastPurchase === true
    });
    cadenceStates[result.state] = (cadenceStates[result.state] || 0) + 1;
    cadenceReasons[result.reason] = (cadenceReasons[result.reason] || 0) + 1;
    if (result.cadence?.reliable) {
      confidences[result.cadence.confidence] = (confidences[result.cadence.confidence] || 0) + 1;
    }
  }

  // ---- segments ----------------------------------------------------------
  // Live, and behind the counterfactual support clearance, side by side.
  const segments = {};
  for (const entry of segmentCatalogue()) {
    const definition = segmentDefinition(entry.key);
    segments[entry.key] = {
      live: new Set(definition.compute(after, now).map(row => row.contactPhone)).size,
      behindSupportGate: new Set(definition.compute(reach, now).map(row => row.contactPhone)).size
    };
  }

  // ---- back in stock -----------------------------------------------------
  // A candidate needs a signature-verified restock EVENT. Separately, report
  // the population a future restock would reach: that proves the buyer index
  // works while the event table is still empty. It is a what-if, labelled as
  // one. It is not a queue and nobody becomes contactable by it.
  const units = purchasableUnits(catalogue.entries || []);
  const unavailableEntries = units.filter(entry => !isDefinitelyAvailable({
    stock_status: entry.stockStatus,
    stock_quantity: entry.stockQuantity,
    manage_stock: entry.manageStock,
    purchasable: entry.purchasable,
    status: entry.publicationStatus
  }));

  const reachable = [];
  for (const entry of unavailableEntries) {
    const key = `${entry.productID}:${entry.variationID || 0}`;
    const buyers = (buyersByKey.get(key) || new Set()).size;
    reachable.push({
      product: entry.parentName || entry.name,
      dose: entry.dose || 'no dose variants',
      sku: entry.sku,
      buyers
    });
  }

  return {
    generatedAt: now.toISOString(),
    mode: 'read_only_aggregate_dry_run',
    catalogue: {
      available: catalogue.available,
      stale: catalogue.stale,
      fetchedAt: catalogue.fetchedAt,
      error: catalogue.error,
      publishedProducts: catalogue.productCount,
      variations: catalogue.variationCount,
      indexedEntries: catalogueIndex.size
    },
    source: {
      ordersRead: orderResult.rows.length,
      paidOrders: paidOrders.length,
      contacts: contactResult.rows.length,
      inventoryRowsInDatabase: inventoryResult.rows.length,
      inventoryRowsFromCatalogue: catalogueInventory.length,
      restockEventsInDatabase: restockResult.rows.length,
      supportStateAvailable: supportResult.available
    },
    identity: {
      lineItems: identity.items,
      resolvedBefore: previousRuleResolved,
      resolvedAfter: identity.resolved,
      unresolvedBefore: identity.items - previousRuleResolved,
      unresolvedAfter: identity.unresolved,
      doseResolved: identity.doseResolved,
      byMethod: identity.byMethod,
      unresolvedReasons: identity.unresolvedReasons,
      resolvedWithNotes: identity.resolvedWithNotes,
      unresolvedProducts: [...unresolvedExamples.entries()]
        .sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ item: key, lineItems: count }))
    },
    detectors: {
      before: {
        reorderCandidates: before.reorderCandidates.length,
        winbackCandidates: before.winbackCandidates.length,
        backInStockCandidates: before.backInStockCandidates.length,
        nonExactOrderItems: before.sourceCoverage.nonExactOrderItems
      },
      after: {
        reorderCandidates: after.reorderCandidates.length,
        reorderPeople: new Set(after.reorderCandidates.map(row => row.phone)).size,
        winbackCandidates: after.winbackCandidates.length,
        winbackPeople: new Set(after.winbackCandidates.map(row => row.phone)).size,
        backInStockCandidates: after.backInStockCandidates.length,
        nonExactOrderItems: after.sourceCoverage.nonExactOrderItems
      },
      behindSupportGateBefore: {
        reorderCandidates: reachBefore.reorderCandidates.length,
        reorderPeople: new Set(reachBefore.reorderCandidates.map(row => row.phone)).size,
        winbackCandidates: reachBefore.winbackCandidates.length,
        winbackPeople: new Set(reachBefore.winbackCandidates.map(row => row.phone)).size
      },
      behindSupportGateAfter: {
        reorderCandidates: reach.reorderCandidates.length,
        reorderPeople: new Set(reach.reorderCandidates.map(row => row.phone)).size,
        winbackCandidates: reach.winbackCandidates.length,
        winbackPeople: new Set(reach.winbackCandidates.map(row => row.phone)).size,
        distinctProducts: new Set(reach.reorderCandidates.map(row => row.productID)).size
      },
      reachSuppressionReasons: reach.sourceSuppressions.reduce((acc, row) => {
        for (const reason of row.reasons || []) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
      cadenceStates,
      cadenceReasons,
      cadenceConfidence: confidences,
      suppressionReasons: after.sourceSuppressions.reduce((acc, row) => {
        for (const reason of row.reasons || []) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {})
    },
    segments,
    backInStock: {
      verifiedRestockEventsInWindow: restockResult.rows.length,
      candidates: after.backInStockCandidates.length,
      purchasableUnits: units.length,
      currentlyUnavailableUnits: unavailableEntries.length,
      note: 'A candidate requires a signature-verified restock EVENT. Reading current ' +
        'stock is a first sighting, not a transition, and never creates one.',
      whatIfCurrentlyUnavailableCameBack: reachable.sort((a, b) => b.buyers - a.buyers)
    }
  };
}

function report(result) {
  console.log('');
  console.log('CAMPAIGN PRODUCT IDENTITY DRY RUN');
  console.log(`  generated at        ${result.generatedAt}`);
  console.log(`  mode                ${result.mode}`);
  console.log('');
  console.log('CATALOGUE');
  console.log(`  available           ${result.catalogue.available}`);
  console.log(`  stale               ${result.catalogue.stale}`);
  console.log(`  fetched at          ${result.catalogue.fetchedAt}`);
  console.log(`  published products  ${result.catalogue.publishedProducts}`);
  console.log(`  variations          ${result.catalogue.variations}`);
  console.log(`  indexed entries     ${result.catalogue.indexedEntries}`);
  if (result.catalogue.error) console.log(`  error               ${result.catalogue.error}`);
  console.log('');
  console.log('SOURCES');
  for (const [key, value] of Object.entries(result.source)) {
    console.log(`  ${key.padEnd(28)}${value}`);
  }
  console.log('');
  console.log('PRODUCT IDENTITY');
  console.log(`  paid line items     ${result.identity.lineItems}`);
  console.log(`  resolved BEFORE     ${result.identity.resolvedBefore}`);
  console.log(`  resolved AFTER      ${result.identity.resolvedAfter}`);
  console.log(`  unresolved BEFORE   ${result.identity.unresolvedBefore}`);
  console.log(`  unresolved AFTER    ${result.identity.unresolvedAfter}`);
  console.log(`  exact dose pinned   ${result.identity.doseResolved}`);
  printCounts('resolution method', result.identity.byMethod);
  printCounts('notes on resolved items', result.identity.resolvedWithNotes);
  printCounts('unresolved reasons', result.identity.unresolvedReasons);
  if (result.identity.unresolvedProducts.length) {
    console.log('  unresolved catalogue items (shop products, no customer data):');
    for (const row of result.identity.unresolvedProducts) {
      console.log(`    ${String(row.lineItems).padStart(6)}  ${row.item}`);
    }
  }
  console.log('');
  console.log('DETECTORS');
  console.log('  before:');
  for (const [key, value] of Object.entries(result.detectors.before)) {
    console.log(`    ${key.padEnd(26)}${value}`);
  }
  console.log('  after:');
  for (const [key, value] of Object.entries(result.detectors.after)) {
    console.log(`    ${key.padEnd(26)}${value}`);
  }
  console.log('  COUNTERFACTUAL, support clearance current for everyone.');
  console.log('  Reach, not permission. Nothing here is contactable.');
  console.log('    with the OLD identity rule:');
  for (const [key, value] of Object.entries(result.detectors.behindSupportGateBefore)) {
    console.log(`      ${key.padEnd(24)}${value}`);
  }
  console.log('    with the NEW resolver:');
  for (const [key, value] of Object.entries(result.detectors.behindSupportGateAfter)) {
    console.log(`      ${key.padEnd(24)}${value}`);
  }
  printCounts('counterfactual suppressions', result.detectors.reachSuppressionReasons);
  printCounts('cadence state', result.detectors.cadenceStates);
  printCounts('cadence reason', result.detectors.cadenceReasons);
  printCounts('cadence confidence', result.detectors.cadenceConfidence);
  printCounts('source suppressions', result.detectors.suppressionReasons);
  console.log('');
  console.log('SEGMENTS (distinct people)');
  console.log(`  ${'definition'.padEnd(34)}${'live'.padStart(6)}${'behind support gate'.padStart(22)}`);
  for (const [key, value] of Object.entries(result.segments)) {
    console.log(`  ${key.padEnd(34)}${String(value.live).padStart(6)}${String(value.behindSupportGate).padStart(22)}`);
  }
  console.log('');
  console.log('BACK IN STOCK');
  console.log(`  verified restock events   ${result.backInStock.verifiedRestockEventsInWindow}`);
  console.log(`  candidates                ${result.backInStock.candidates}`);
  console.log(`  purchasable units         ${result.backInStock.purchasableUnits}`);
  console.log(`  currently unavailable     ${result.backInStock.currentlyUnavailableUnits}`);
  console.log(`  ${result.backInStock.note}`);
  if (result.backInStock.whatIfCurrentlyUnavailableCameBack.length) {
    console.log('  WHAT-IF, not a queue: prior buyers reachable if each currently');
    console.log('  unavailable item came back with a verified event:');
    for (const row of result.backInStock.whatIfCurrentlyUnavailableCameBack) {
      console.log(`    ${String(row.buyers).padStart(4)}  ${row.product} (${row.dose}, sku ${row.sku})`);
    }
  } else {
    console.log('  Every purchasable unit is currently available.');
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
