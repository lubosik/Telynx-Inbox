'use strict';
/**
 * The baseline seed is the only thing in this change that can write, so its
 * guards are the only thing worth testing here: it must refuse without
 * explicit approval, it must never overwrite an existing row, and it must
 * never produce a restock event.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, persistenceAllowed, rowsToInsert } = require('../scripts/seed-product-inventory-baseline');

test('persistence needs the flag AND the approval variable', () => {
  assert.equal(persistenceAllowed(parseArgs([]), { PRODUCT_INVENTORY_SEED_APPROVED: 'YES' }), false);
  assert.equal(persistenceAllowed(parseArgs(['--persist']), {}), false);
  assert.equal(persistenceAllowed(parseArgs(['--persist']), { PRODUCT_INVENTORY_SEED_APPROVED: 'yes' }), false);
  assert.equal(persistenceAllowed(parseArgs(['--persist']), { PRODUCT_INVENTORY_SEED_APPROVED: 'YES' }), true);
});

test('an existing row is never overwritten by a baseline seed', () => {
  // Overwriting would destroy the previous state that a pending out-to-in
  // transition is measured against, which is the whole reason the row exists.
  const catalogueRows = [
    { workspace_id: 'vici', product_id: 551, variation_id: 566, stock_status: 'instock' },
    { workspace_id: 'vici', product_id: 551, variation_id: 567, stock_status: 'instock' },
    { workspace_id: 'vici', product_id: 577, variation_id: 0, stock_status: 'outofstock' }
  ];
  const existing = [{ workspace_id: 'vici', product_id: 551, variation_id: 566 }];
  const pending = rowsToInsert(catalogueRows, existing);
  assert.equal(pending.length, 2);
  assert.equal(pending.some(row => row.variation_id === 566), false);
});

test('an empty inventory table seeds everything, and a full one seeds nothing', () => {
  const rows = [{ workspace_id: 'vici', product_id: 1, variation_id: 0, stock_status: 'instock' }];
  assert.equal(rowsToInsert(rows, []).length, 1);
  assert.equal(rowsToInsert(rows, null).length, 1);
  assert.equal(rowsToInsert(rows, [{ workspace_id: 'vici', product_id: 1, variation_id: 0 }]).length, 0);
});

test('GUARD: the seed script cannot touch the product event table', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'seed-product-inventory-baseline.js'), 'utf8'
  );
  const code = source.split('\n').filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  assert.equal(/sms_commerce_product_events/.test(code), false,
    'a seeded row is a first sighting, never a transition');
});
