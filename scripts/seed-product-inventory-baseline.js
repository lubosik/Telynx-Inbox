#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-product-inventory-baseline.js
 *
 * Write one CURRENT-STOCK row per purchasable catalogue unit into
 * `sms_product_inventory`, so the WooCommerce product webhook has a `previous`
 * snapshot to compare against.
 *
 * WHY IT IS NEEDED
 *   `sms_product_inventory` is empty in production. `isRestockTransition()`
 *   answers false when there is no previous snapshot, deliberately, because a
 *   first sighting of "in stock" is not evidence that anything came back. With
 *   an empty table every product's FIRST webhook is therefore swallowed: a
 *   product that goes out of stock and comes back needs two webhooks before a
 *   restock can ever be recognised. Seeding the baseline costs that swallowed
 *   first observation once, up front, instead of at the moment it matters.
 *
 * WHAT IT DOES NOT DO
 *   It writes no `sms_commerce_product_events` row and creates no restock. A
 *   seeded row IS the first sighting; it is the thing a later transition is
 *   measured against, never the transition itself. Adding an event write here
 *   would text every prior buyer of every product at once, and
 *   test/campaign-product-catalogue.test.js has a guard against exactly that.
 *
 * SAFETY
 *   Read-only by default. Persistence requires BOTH `--persist` and
 *   `PRODUCT_INVENTORY_SEED_APPROVED=YES`. It only ever inserts a row that is
 *   absent: an existing row is left alone, because overwriting it would
 *   destroy the previous state a pending transition depends on.
 *
 * Usage:
 *   node scripts/seed-product-inventory-baseline.js
 *   PRODUCT_INVENTORY_SEED_APPROVED=YES node scripts/seed-product-inventory-baseline.js --persist
 */

require('dotenv').config();

/**
 * The database client is resolved lazily, not at module load.
 *
 * `../db` builds a Supabase client the moment it is required and throws
 * "supabaseUrl is required" when the environment is absent. CI has no `.env`,
 * so importing this file to unit-test `parseArgs`, `persistenceAllowed` and
 * `rowsToInsert` took the whole test file down at the require, reported only
 * as "test failed" with nothing naming the real cause. It passed locally,
 * where `.env` exists, which is the worst version of this failure: green on
 * the machine that wrote it, red on the machine that gates it.
 *
 * The house pattern is the one `scripts/backfill-order-sms-consent.js` uses:
 * pure logic importable with no database, and the client resolved only on the
 * path that actually talks to one.
 */
function defaultClient() {
  return require('../db').supabase;
}
const { wooGet } = require('../woocommerce');
const { catalogueInventoryRows, productCatalogue } = require('../lib/campaigns/product-catalogue');

const WORKSPACE_ID = 'vici';

function parseArgs(argv) {
  return { persist: argv.includes('--persist'), json: argv.includes('--json') };
}

function persistenceAllowed(args, env = process.env) {
  return args.persist === true && env.PRODUCT_INVENTORY_SEED_APPROVED === 'YES';
}

/**
 * Only the rows that do not already exist. An existing row is the previous
 * state of a product and must never be overwritten by a baseline seed.
 */
function rowsToInsert(catalogueRows, existingRows) {
  const existing = new Set((existingRows || []).map(row =>
    `${row.workspace_id}:${Number(row.product_id)}:${Number(row.variation_id || 0)}`));
  return catalogueRows.filter(row =>
    !existing.has(`${row.workspace_id}:${row.product_id}:${row.variation_id}`));
}

async function run(args, client = null) {
  const db = client || defaultClient();
  const now = new Date();
  const catalogue = await productCatalogue({ wooGet, now, forceRefresh: true });
  if (!catalogue.available) throw new Error(`WooCommerce catalogue unavailable: ${catalogue.error}`);

  const catalogueRows = catalogueInventoryRows(catalogue, { workspaceID: WORKSPACE_ID, now });

  const { data: existing, error } = await db.from('sms_product_inventory')
    .select('workspace_id,product_id,variation_id').eq('workspace_id', WORKSPACE_ID);
  if (error) throw new Error(`sms_product_inventory could not be read: ${error.message}`);

  const pending = rowsToInsert(catalogueRows, existing);
  const byStatus = {};
  for (const row of pending) {
    const key = row.stock_status || 'unknown';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const result = {
    mode: args.persist ? 'persist' : 'dry_run',
    generatedAt: now.toISOString(),
    catalogueUnits: catalogueRows.length,
    alreadyPresent: (existing || []).length,
    wouldInsert: pending.length,
    byStockStatus: byStatus,
    restockEventsCreated: 0,
    note: 'A seeded row is a first sighting. It creates no restock and no opportunity.'
  };

  if (!args.persist) return result;

  // Insert only. `onConflict ... ignoreDuplicates` means a concurrent webhook
  // write during the seed keeps its own, more authoritative row.
  const { error: insertError } = await db.from('sms_product_inventory')
    .upsert(pending, { onConflict: 'workspace_id,product_id,variation_id', ignoreDuplicates: true });
  if (insertError) throw new Error(`baseline insert failed: ${insertError.message}`);
  result.inserted = pending.length;
  return result;
}

function report(result) {
  console.log('');
  console.log('PRODUCT INVENTORY BASELINE');
  console.log(`  mode                  ${result.mode}`);
  console.log(`  catalogue units       ${result.catalogueUnits}`);
  console.log(`  already present       ${result.alreadyPresent}`);
  console.log(`  ${result.mode === 'persist' ? 'inserted            ' : 'would insert        '}  ${result.wouldInsert}`);
  console.log(`  restock events made   ${result.restockEventsCreated}`);
  for (const [status, count] of Object.entries(result.byStockStatus)) {
    console.log(`    ${String(count).padStart(4)}  ${status}`);
  }
  console.log(`  ${result.note}`);
  if (result.mode === 'dry_run') {
    console.log('  Nothing was written. Re-run with --persist and');
    console.log('  PRODUCT_INVENTORY_SEED_APPROVED=YES after review.');
  }
  console.log('');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.persist && !persistenceAllowed(args)) {
    console.error('Persistence refused: pass --persist AND set PRODUCT_INVENTORY_SEED_APPROVED=YES after review.');
    process.exit(1);
  }
  run(args)
    .then(result => {
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else report(result);
      process.exit(0);
    })
    .catch(error => {
      console.error('baseline seed failed:', error.message);
      process.exit(1);
    });
}

module.exports = { parseArgs, persistenceAllowed, rowsToInsert, run };
