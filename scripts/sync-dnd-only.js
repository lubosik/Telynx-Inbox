#!/usr/bin/env node
'use strict';
/**
 * scripts/sync-dnd-only.js — refresh do-not-disturb status by hand.
 *
 * The work lives in lib/ghl-dnd-sync.js and runs on a six-hourly schedule in
 * server.js. This is the manual trigger, for when you want it now rather than
 * within six hours, and for --dry-run.
 *
 * It is a thin wrapper on purpose: the previous version held its own copy of
 * the logic, and a script and a scheduled job that each implement the same
 * sync are two answers to one question waiting to disagree.
 *
 *   node scripts/sync-dnd-only.js --dry-run
 *   node scripts/sync-dnd-only.js
 */

require('dotenv').config();
const { syncDoNotDisturb } = require('../lib/ghl-dnd-sync');

const dryRun = process.argv.includes('--dry-run');

syncDoNotDisturb({ dryRun })
  .then(result => {
    console.log(`GHL contacts fetched: ${result.fetched}`);
    console.log(`with a phone number : ${result.withPhone}`);
    console.log(`complete DND answer : ${result.complete}`);
    console.log(`partial, left unknown: ${result.partial}`);
    if (result.dryRun) {
      console.log('\nDRY RUN. Nothing was written.');
      return;
    }
    console.log(`rows updated        : ${result.written}`);
    console.log(`in GHL, not here    : ${result.missingLocally}`);
    if (result.failed) console.log(`failed to write     : ${result.failed}`);
  })
  .catch(error => { console.error(error.message); process.exit(1); });
