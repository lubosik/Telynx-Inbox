#!/usr/bin/env node
'use strict';
/**
 * scripts/backfill-contact-profiles.js — give every buyer a deterministic
 * profile.
 *
 * Run this ONCE after scripts/contact-profiles-migration.sql has been applied.
 * After that the WooCommerce order webhook, the inbound-SMS handler and the
 * nightly drift sweep keep the rows current, and this script only exists for
 * the first fill and for the day somebody wants to force one by hand.
 *
 * Safe to run twice, and safe to interrupt. Every profile carries a
 * fingerprint of the rows it was built from, so a second run finds every
 * contact unchanged and writes nothing at all. A run stopped halfway leaves
 * the contacts it already built, and the next run skips them.
 *
 *   node scripts/backfill-contact-profiles.js --dry-run
 *   node scripts/backfill-contact-profiles.js
 *
 * --dry-run reports how many contacts WOULD be considered and writes nothing.
 * Ctrl-C stops cleanly between batches rather than mid-write.
 *
 * No message is sent, no coupon is minted and no customer is contacted by any
 * of this. It reads orders, messages and campaign recipients, and writes one
 * table.
 */

const path = require('node:path');

function usage() {
  return [
    'Usage: node scripts/backfill-contact-profiles.js [--dry-run] [--batch-size N]',
    '',
    '  --dry-run       count the contacts that would be built; write nothing',
    '  --batch-size N  contacts per pass (default 200)',
    '  --help          this text'
  ].join('\n');
}

function parseArgs(argv) {
  const args = { dryRun: false, batchSize: 200, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--batch-size') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 1) throw new Error('--batch-size needs a positive number');
      args.batchSize = Math.trunc(value);
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const { supabase } = require('../db');
  const { backfillProfiles, profileablePhones } = require('../lib/profiles/profile-builder');

  // Stop between batches, not inside one. A half-written batch is fine — the
  // fingerprints make it resumable — but exiting mid-request loses the summary
  // and leaves the operator guessing how far it got.
  let stopRequested = false;
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log('\n[PROFILE BACKFILL] Stopping after this batch. Ctrl-C again to exit now.');
  });

  const phones = await profileablePhones({ client: supabase });
  console.log(`[PROFILE BACKFILL] ${phones.length} contacts with a paid order or an existing profile.`);

  if (args.dryRun) {
    console.log(JSON.stringify({ mode: 'dry_run', contacts: phones.length, written: 0 }, null, 2));
    return;
  }

  const summary = await backfillProfiles({
    client: supabase,
    phones,
    batchSize: args.batchSize,
    shouldStop: () => stopRequested,
    onProgress: progress => console.log(
      `[PROFILE BACKFILL] ${progress.considered}/${progress.contacts}`
      + ` written=${progress.written} unchanged=${progress.skipped} failed=${progress.failed}`
    )
  });

  console.log(JSON.stringify({
    mode: 'persist',
    contacts: summary.contacts,
    considered: summary.considered,
    written: summary.written,
    unchanged: summary.skipped,
    failed: summary.failed.length,
    stopped_early: summary.stopped
  }, null, 2));

  // Print the reasons, not just the count. A backfill that reports "12 failed"
  // and nothing else is a backfill nobody can fix.
  for (const failure of summary.failed.slice(0, 20)) {
    console.error(`[PROFILE BACKFILL] ...${String(failure.phone).slice(-4)}: ${failure.error}`);
  }
  if (summary.failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[PROFILE BACKFILL] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, usage };
