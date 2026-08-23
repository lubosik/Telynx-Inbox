#!/usr/bin/env node
'use strict';

/**
 * scripts/backfill-order-sms-consent.js
 *
 * One-off backfill: record ONE promotional-SMS consent event per phone that
 * has at least one paid WooCommerce order, on the basis of the published
 * checkout notice and privacy policy.
 *
 * READ THIS BEFORE RUNNING IT
 *   The basis is weak and the script says so, everywhere, on purpose. The Vici
 *   privacy policy names marketing and promotional EMAIL; it does not name SMS.
 *   No customer ticked an SMS box. This is a business decision by the owner to
 *   treat purchase + published notice as consent, and every row written here
 *   records that fact verbatim under source
 *   `woocommerce_order_privacy_policy`, with `explicit_sms_opt_in: false` and a
 *   written list of the basis's limitations, so that nobody reading one row a
 *   year from now can mistake it for a real opt-in.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT. Writing requires BOTH `--commit` and
 *     `--basis-acknowledged`. Two flags, deliberately awkward, because this
 *     writes a compliance record across ~900 people.
 *   - It never writes an opt-out, never clears one, and skips anyone with a
 *     withdrawal in ANY of the five places one can live: the consent ledger,
 *     `sms_contacts.opted_out`, the `sms_sent_log` opt-out sentinel, HighLevel
 *     SMS do-not-disturb, and an active campaign suppression.
 *   - Recording consent is not permission to send. Delivery still needs
 *     `CAMPAIGNS_LIVE_SEND_ENABLED`, `provider_approved`, `live_send_enabled`,
 *     fresh DND, quiet hours, and cadence limits. This script touches none of
 *     those and must not be described as enabling a campaign.
 *
 * USAGE
 *   node scripts/backfill-order-sms-consent.js                  # dry run
 *   node scripts/backfill-order-sms-consent.js --show-phones    # dry run, unmasked
 *   node scripts/backfill-order-sms-consent.js --commit --basis-acknowledged
 *
 *   --limit=N   cap how many records are written (staged rollout)
 */

require('dotenv').config();

const { supabase } = require('../db');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { recordOptIn } = require('../lib/campaigns/consent');
const {
  BACKFILL_VERSION,
  WORKSPACE_ID,
  applyConsentBackfill,
  planOrderConsentBackfill
} = require('../lib/campaigns/order-consent-backfill');

const PAGE_SIZE = 1000;
const MAX_ROWS = 200000;

/** Set by SIGINT. Checked between writes so a Ctrl-C stops cleanly, mid-run. */
let interrupted = false;

function parseArgs(argv) {
  const flags = {
    commit: false,
    basisAcknowledged: false,
    showPhones: false,
    limit: null,
    help: false,
    unknown: []
  };
  for (const arg of argv) {
    if (arg === '--commit') flags.commit = true;
    else if (arg === '--basis-acknowledged') flags.basisAcknowledged = true;
    else if (arg === '--show-phones') flags.showPhones = true;
    else if (arg === '--dry-run') flags.commit = false;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      flags.limit = Number.isSafeInteger(value) && value > 0 ? value : NaN;
    } else flags.unknown.push(arg);
  }
  return flags;
}

/** Last four digits only. Full numbers need an explicit `--show-phones`. */
function mask(phone) {
  const text = String(phone || '');
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 6))}${text.slice(-4)}`;
}

/**
 * A filtered, paged read. `fetchAllRows()` covers the unfiltered tables, but
 * the opt-out sentinel lives in `sms_sent_log`, which holds every SMS this
 * system has ever sent; reading all of it to find `flow_type = 'opted-out'`
 * would be wasteful. Same paging discipline, one `.eq()` added. No `.in()`,
 * no unpaged read — the two shapes that took the inbox down.
 */
async function fetchFilteredRows(table, columns, column, value) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq(column, value)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} page at ${from} failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${table} exceeded the ${MAX_ROWS}-row ceiling; refusing to run on partial data.`);
}

/**
 * Every source is mandatory. If a withdrawal source cannot be read, the run
 * aborts. Proceeding on a partial view of who has said no is the single worst
 * thing this script could do.
 */
async function readSources() {
  // `throwOnCeiling: true` on every one of them.
  //
  // `fetchAllRows()` defaults to warning and returning a TRUNCATED array at the
  // ceiling, which is right for a screen and catastrophic here: a partial read
  // of `sms_consent_events` or `sms_contacts` means withdrawals past row
  // 200,000 are invisible, and this script reads absence as permission. It
  // would then write a fresh opt-in for people who had said no, with the
  // warning scrolled off above the plan. `fetchFilteredRows()` below has always
  // thrown at its ceiling; this makes the shared helper behave the same way for
  // this caller, and only for this caller.
  const paged = (table, columns, orderBy, ascending = true) =>
    fetchAllRows(supabase, table, columns,
      { orderBy, ascending, maxRows: MAX_ROWS, throwOnCeiling: true });

  const [orders, consentEvents, contacts, suppressions, optOutSentinels] = await Promise.all([
    paged('sms_orders',
      'id,woo_order_id,contact_phone,status,created_at', 'created_at'),
    paged('sms_consent_events',
      'id,workspace_id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,occurred_at', 'id'),
    // ghl_dnd / ghl_sms_dnd_status are the fifth withdrawal source. Without
    // them the plan would assert positive promotional consent for somebody the
    // CRM has on a do-not-disturb list.
    paged('sms_contacts', 'phone,opted_out,ghl_dnd,ghl_sms_dnd_status', 'id'),
    paged('sms_campaign_suppressions',
      'id,workspace_id,contact_phone,reason_code,active,effective_at,expires_at', 'created_at'),
    fetchFilteredRows('sms_sent_log', 'id,phone,flow_type', 'flow_type', 'opted-out')
  ]);
  return { orders, consentEvents, contacts, suppressions, optOutSentinels };
}

function printPlan(plan, flags) {
  const { counts } = plan;
  const show = phone => (flags.showPhones ? phone : mask(phone));

  console.log('');
  console.log('  Output below contains order references and masked phone numbers.');
  console.log('  Keep it private; do not paste it into a public log or ticket.');
  console.log('');
  console.log('  BASIS RECORDED BY THIS RUN');
  console.log('  source              woocommerce_order_privacy_policy');
  console.log('  explicit SMS opt-in NO. Derived from a paid order plus the published');
  console.log('                      checkout notice and privacy policy, as an owner decision.');
  console.log('  policy names        EMAIL marketing. It does not name SMS.');
  console.log('');
  console.log('  SOURCES READ');
  console.log(`  sms_orders rows                 ${counts.ordersRead}`);
  console.log(`  distinct orders                 ${counts.distinctOrders}`);
  console.log(`  unusable orders (no id/date)    ${counts.unusableOrders}`);
  console.log(`  paid orders considered          ${counts.paidOrdersConsidered}`);
  console.log(`  distinct phones with paid order ${counts.distinctPhones}`);
  console.log('');
  console.log('  OUTCOME');
  console.log(`  eligible for a consent record   ${counts.eligible}`);
  console.log(`  skipped                         ${counts.skipped}`);
  for (const [reason, total] of Object.entries(counts.skippedByReason).sort()) {
    console.log(`    ${reason.padEnd(28)}  ${total}`);
  }

  if (plan.candidates.length) {
    console.log('');
    console.log('  EXACT METADATA THAT WOULD BE WRITTEN (first candidate)');
    console.log(JSON.stringify(plan.candidates[0].metadata, null, 2)
      .split('\n').map(line => `    ${line}`).join('\n'));
    console.log('');
    console.log('  FIRST 10 CANDIDATES');
    for (const candidate of plan.candidates.slice(0, 10)) {
      console.log(`    ${show(candidate.phone).padEnd(16)}  ${candidate.evidenceRef.padEnd(44)}` +
        `  ${candidate.occurredAt}  orders=${candidate.qualifyingOrders}`);
    }
    if (plan.candidates.length > 10) {
      console.log(`    ... and ${plan.candidates.length - 10} more`);
    }
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
    return 0;
  }
  if (flags.unknown.length) {
    console.error(`Unrecognised argument(s): ${flags.unknown.join(', ')}`);
    return 1;
  }
  if (Number.isNaN(flags.limit)) {
    console.error('--limit must be a positive integer.');
    return 1;
  }
  if (flags.commit !== flags.basisAcknowledged) {
    console.error('');
    console.error('  Refusing to run. Writing requires BOTH flags:');
    console.error('');
    console.error('    --commit               you intend to write to sms_consent_events');
    console.error('    --basis-acknowledged   you have read docs/campaigns/CONSENT-BACKFILL.md');
    console.error('                           and accept that this records a policy-derived');
    console.error('                           determination, NOT an explicit SMS opt-in');
    console.error('');
    return 1;
  }

  const willWrite = flags.commit && flags.basisAcknowledged;
  const runID = require('crypto').randomUUID();

  console.log('');
  console.log('══ Promotional SMS consent backfill from paid orders ══');
  console.log(`   mode       ${willWrite ? 'COMMIT — this run WILL write' : 'DRY RUN — nothing will be written'}`);
  console.log(`   workspace  ${WORKSPACE_ID}`);
  console.log(`   version    ${BACKFILL_VERSION}`);
  console.log(`   run id     ${runID}`);

  const sources = await readSources();
  const plan = planOrderConsentBackfill({ ...sources, workspaceID: WORKSPACE_ID, runID });

  printPlan(plan, flags);

  if (!willWrite) {
    console.log('');
    console.log('  DRY RUN. Nothing was written.');
    console.log('  To commit, re-run with: --commit --basis-acknowledged');
    console.log('');
    return 0;
  }

  const capped = flags.limit ? plan.candidates.slice(0, flags.limit) : plan.candidates;
  if (flags.limit) {
    console.log('');
    console.log(`  --limit=${flags.limit} — writing ${capped.length} of ${plan.candidates.length} candidates.`);
  }

  console.log('');
  console.log('  Writing...');

  const summary = await applyConsentBackfill({
    client: supabase,
    plan: { candidates: capped },
    commit: true,
    basisAcknowledged: true,
    recordOptIn,
    workspace: WORKSPACE_ID,
    shouldStop: () => interrupted
  });

  console.log('');
  console.log('  RESULT');
  console.log(`  attempted   ${summary.attempted}`);
  console.log(`  written     ${summary.written}`);
  console.log(`  duplicates  ${summary.duplicates}   (already backfilled; re-running is safe)`);
  console.log(`  rejected    ${summary.rejected}`);
  console.log(`  failed      ${summary.failed}`);
  if (summary.stoppedEarly) {
    console.log(`  STOPPED EARLY on SIGINT — ${capped.length - summary.attempted} candidate(s) not attempted.`);
    console.log('  Re-running is safe: the dedupe key is stable per phone.');
  }
  // A CODE, never provider error text. A PostgREST message quotes the offending
  // row, so printing it here would undo the masking on the same line.
  for (const failure of summary.failures.slice(0, 20)) {
    console.log(`    ${mask(failure.phone)}  ${failure.code}`);
  }
  console.log('');
  console.log('  Consent is now recorded. It is NOT permission to send: delivery still');
  console.log('  requires CAMPAIGNS_LIVE_SEND_ENABLED, provider approval, workspace');
  console.log('  live send, fresh DND, quiet hours and cadence limits.');
  console.log('');

  return summary.failed > 0 || summary.rejected > 0 ? 1 : 0;
}

if (require.main === module) {
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n  SIGINT received. Stopping after the current record.');
  });

  (async () => {
    try {
      process.exitCode = await main();
    } catch (error) {
      console.error(`\n  Backfill aborted: ${error.message}\n`);
      process.exitCode = 1;
    }
  })();
}

module.exports = { fetchFilteredRows, mask, parseArgs, readSources };
