#!/usr/bin/env node
'use strict';

/**
 * scripts/send-sms-optin-invites.js
 *
 * Mint promotional-SMS opt-in invitations and RENDER the emails that carry
 * them. It does not send anything.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A MAILER
 *   Until this script existed, `issueOptInInvite()` and `smsOptInInviteEmail()`
 *   had no caller anywhere outside the tests. No route, no cron, no script
 *   opened an invitation, so `POST /sms-optin/confirm` could only ever answer
 *   404 and the entire opt-in capability was unreachable code that looked
 *   finished. This is the missing half.
 *
 *   The other half stays missing ON PURPOSE. Vici's email is handled by a
 *   separate agency with its own sending domain, suppression list and
 *   deliverability reputation, so this backend must not acquire a second,
 *   competing sender for marketing mail. This script therefore produces a file
 *   the agency can merge and send, and stops.
 *
 * THIS IS A STAGED CAPABILITY
 *   Nothing here is scheduled and nothing calls it. A run has to be a decision
 *   somebody makes, on a day, with two flags. Read
 *   docs/campaigns/SMS-OPTIN-INVITE.md before the first one.
 *
 * WHAT A RUN ACTUALLY DOES
 *   DRY RUN (the default) reads the recipient sources, applies every exclusion,
 *   prints the counts and ONE fully rendered sample email with a placeholder
 *   token, and writes nothing. No invitation is opened, so no link exists and
 *   nobody can answer anything.
 *
 *   COMMIT opens one invitation per surviving recipient, which supersedes any
 *   unanswered invitation that number already had, and writes the rendered
 *   emails to `--out`. It still writes NOTHING to `sms_consent_events`: an
 *   invitation is a question, and until somebody presses a button on the page
 *   the number is exactly as suppressed as it was.
 *
 * WHO IS EXCLUDED, AND WHY THE LIST IS LONG
 *   - no email address on file, because there is nothing to send to;
 *   - no valid E.164 phone, because there is nothing to ask about;
 *   - an active withdrawal in ANY of the four places one can live. This is
 *     enforced twice: once here so the recipient never appears in the file, and
 *     again inside `issueOptInInvite()` so a race cannot slip one through.
 *     Emailing a marketing permission request to somebody who has texted STOP
 *     is itself the violation, not merely the click that might follow it;
 *   - a positive consent record already on file, because asking again is noise;
 *   - an unanswered invitation from THIS campaign_ref, so a re-run after a
 *     partial send does not mail the same person a second link;
 *   - an answered invitation from this campaign_ref, because they replied.
 *
 * THE TOKENS ARE THE PRODUCT, SO THEY ARE TREATED AS CREDENTIALS
 *   Each rendered email contains a live 256-bit token in a URL. Pressing that
 *   link is what creates a consent record, so the output file is exactly as
 *   sensitive as a batch of password-reset links.
 *
 *     * COMMIT REFUSES TO PRINT BODIES TO STDOUT. `--out=<path>` is mandatory,
 *       the file is created with mode 0600, and stdout gets counts and a path.
 *       A terminal scrollback, a CI log and a pasted "here is what it did" are
 *       all places a live consent token must never reach.
 *     * The dry run renders with the literal placeholder token
 *       'DRY-RUN-NO-TOKEN-WAS-MINTED', because a dry run mints nothing.
 *     * Write the file somewhere untracked, hand it over, then delete it. The
 *       invitations survive in the database; the file does not need to.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT. Writing requires BOTH `--commit` and
 *     `--mailing-approved`. Two flags, deliberately awkward, matching
 *     scripts/backfill-order-sms-consent.js.
 *   - It never writes a consent event, never clears one, and never sends.
 *   - SIGINT stops it between recipients. Re-running is safe: anybody already
 *     invited under this campaign_ref is skipped, and a re-mint would only
 *     supersede the previous link rather than duplicate it.
 *   - Requires scripts/sms-optin-migration.sql to have been applied.
 *
 * USAGE
 *   node scripts/send-sms-optin-invites.js --campaign-ref=sms_optin_invite_2026_08
 *   node scripts/send-sms-optin-invites.js --campaign-ref=... --show-phones
 *   node scripts/send-sms-optin-invites.js --campaign-ref=... \
 *     --commit --mailing-approved --out=/private/tmp/invites.json
 *
 *   --limit=N        cap how many invitations are minted (staged rollout)
 *   --out=<path>     required by --commit. JSON array, mode 0600.
 *   --show-phones    dry run only. Unmasked numbers in the printed plan.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { supabase } = require('../db');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { appUrl } = require('../lib/email');
const { smsOptInInviteEmail } = require('../lib/email-templates');
const { normalisePhone } = require('../lib/campaigns/consent');
const { activeSuppressionReason } = require('../lib/campaigns/eligibility');
const {
  EXPIRY_DAYS,
  createSmsOptInInviteStore,
  issueOptInInvite,
  phoneEnding
} = require('../lib/campaigns/sms-optin-invite');

const WORKSPACE_ID = 'vici';
const PAGE_SIZE = 1000;
const MAX_ROWS = 200000;

/** Rendered into the dry run in place of a token, because none is minted. */
const PLACEHOLDER_TOKEN = 'DRY-RUN-NO-TOKEN-WAS-MINTED';

/** Set by SIGINT. Checked between mints so a Ctrl-C stops cleanly, mid-run. */
let interrupted = false;

function parseArgs(argv) {
  const flags = {
    commit: false,
    mailingApproved: false,
    showPhones: false,
    campaignRef: null,
    out: null,
    limit: null,
    help: false,
    unknown: []
  };
  for (const arg of argv) {
    if (arg === '--commit') flags.commit = true;
    else if (arg === '--mailing-approved') flags.mailingApproved = true;
    else if (arg === '--show-phones') flags.showPhones = true;
    else if (arg === '--dry-run') flags.commit = false;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--campaign-ref=')) flags.campaignRef = arg.slice('--campaign-ref='.length).trim();
    else if (arg.startsWith('--out=')) flags.out = arg.slice('--out='.length).trim();
    else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      flags.limit = Number.isSafeInteger(value) && value > 0 ? value : NaN;
    } else flags.unknown.push(arg);
  }
  return flags;
}

/**
 * Turn the parsed flags into the one decision that matters: does this run write?
 *
 * Extracted from main() and exported so it can be tested for every flag
 * combination without a database. It used to live inline, where the only thing
 * a test could check was that the guard's SOURCE TEXT appeared above the code it
 * guards. A shape assertion cannot tell `if (!willWrite)` from
 * `if (willWrite === 'never')`, and the second one mints invitations on a dry
 * run. That mutation survived, which is how this function came to exist.
 *
 * @param {ReturnType<typeof parseArgs>} flags
 * @returns {{willWrite: boolean, error: string|null}}
 */
function resolveRunMode(flags) {
  if (!flags.campaignRef) {
    return { willWrite: false, error: 'campaign_ref_required' };
  }
  // Both flags or neither. One alone is a mistake, not a shorthand.
  if (flags.commit !== flags.mailingApproved) {
    return { willWrite: false, error: 'both_flags_required' };
  }
  if (!flags.commit) {
    return { willWrite: false, error: null };
  }
  // Every rendered email holds a live consent token, so a commit with nowhere
  // private to put them is refused rather than downgraded to stdout.
  if (!flags.out) {
    return { willWrite: false, error: 'out_path_required' };
  }
  return { willWrite: true, error: null };
}

/** Last four digits only. Full numbers need an explicit `--show-phones`. */
function mask(phone) {
  const text = String(phone || '');
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}${'*'.repeat(Math.max(0, text.length - 6))}${text.slice(-4)}`;
}

/** An email address is identifying. Same treatment, in the printed plan only. */
function maskEmail(email) {
  const text = String(email || '');
  const at = text.indexOf('@');
  if (at <= 0) return '****';
  const head = text.slice(0, at);
  return `${head.slice(0, 1)}${'*'.repeat(Math.max(1, head.length - 1))}${text.slice(at)}`;
}

/**
 * A filtered, paged read. Same discipline as
 * scripts/backfill-order-sms-consent.js: no `.in()`, no unpaged read, because
 * those are the two shapes that took the inbox down.
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
 * Every source is mandatory, and every one of them is read with
 * `throwOnCeiling: true`.
 *
 * `fetchAllRows()` defaults to warning and returning a TRUNCATED array at its
 * row ceiling, which is right for a screen and catastrophic here. This script
 * reads ABSENCE AS PERMISSION: a phone with no withdrawal row in
 * `sms_consent_events`, no suppression, and no `opted_out` flag on
 * `sms_contacts` is treated as somebody it is acceptable to email a marketing
 * permission request to. A silently truncated read of any of those tables
 * therefore does not produce a smaller mailing, it produces a mailing that
 * includes people who have already said no, with the warning scrolled off above
 * the plan. That is a CTIA problem before anybody even clicks.
 *
 * `sms_optin_invitations` is on the same footing: truncating it means
 * "already_invited_this_campaign" stops firing and the same person is mailed a
 * second link.
 *
 * The reads go through one `paged()` helper rather than four call sites,
 * copying scripts/backfill-order-sms-consent.js, so the flag cannot be
 * forgotten when a fifth source is added. `fetchFilteredRows()` below has always
 * thrown at its own ceiling.
 */
async function readSources() {
  const paged = (table, columns, orderBy, ascending = true) =>
    fetchAllRows(supabase, table, columns,
      { orderBy, ascending, maxRows: MAX_ROWS, throwOnCeiling: true });

  const [contacts, consentEvents, suppressions, optOutSentinels, invitations] = await Promise.all([
    paged('sms_contacts', 'phone,email,name,first_name,opted_out,ghl_dnd,ghl_sms_dnd_status', 'id'),
    paged('sms_consent_events',
      'id,workspace_id,contact_phone,event_type,purpose,brand_id,occurred_at', 'id'),
    paged('sms_campaign_suppressions',
      'id,workspace_id,contact_phone,reason_code,active,effective_at,expires_at', 'created_at'),
    fetchFilteredRows('sms_sent_log', 'id,phone,flow_type', 'flow_type', 'opted-out'),
    paged('sms_optin_invitations',
      'id,workspace_id,contact_phone,campaign_ref,responded_at,cancelled_at', 'created_at')
  ]);
  return { contacts, consentEvents, suppressions, optOutSentinels, invitations };
}

/**
 * Decide who gets asked. Pure, so it is testable without a database and so the
 * exclusion rules can be read in one place rather than inferred from queries.
 *
 * @returns {{recipients: object[], counts: object}}
 */
function planOptInMailing({
  contacts = [],
  consentEvents = [],
  suppressions = [],
  optOutSentinels = [],
  invitations = [],
  campaignRef,
  workspaceID = WORKSPACE_ID,
  now = new Date()
}) {
  const skippedByReason = {};
  const skip = reason => { skippedByReason[reason] = (skippedByReason[reason] || 0) + 1; };

  const sentinelPhones = new Set(
    optOutSentinels.map(row => normalisePhone(row.phone)).filter(Boolean)
  );

  const suppressionsByPhone = new Map();
  for (const row of suppressions) {
    if (row.workspace_id && row.workspace_id !== workspaceID) continue;
    const phone = normalisePhone(row.contact_phone);
    if (!phone) continue;
    if (!suppressionsByPhone.has(phone)) suppressionsByPhone.set(phone, []);
    suppressionsByPhone.get(phone).push(row);
  }

  // The latest promotional event per phone. Ties on occurred_at break by id,
  // matching lib/campaigns/eligibility.js and the SQL checks.
  const latestConsent = new Map();
  for (const row of consentEvents) {
    if (row.workspace_id !== workspaceID) continue;
    if (row.purpose && row.purpose !== 'promotional_sms') continue;
    if (row.brand_id && row.brand_id !== workspaceID) continue;
    const phone = normalisePhone(row.contact_phone);
    if (!phone) continue;
    const current = latestConsent.get(phone);
    const at = Date.parse(row.occurred_at);
    if (!Number.isFinite(at)) continue;
    if (!current || at > current.at || (at === current.at && Number(row.id) > Number(current.id))) {
      latestConsent.set(phone, { at, id: row.id, eventType: row.event_type });
    }
  }

  const invitedThisCampaign = new Set();
  for (const row of invitations) {
    if (row.workspace_id !== workspaceID) continue;
    if (row.campaign_ref !== campaignRef) continue;
    // A cancelled invitation was superseded by a later one, so it is not
    // evidence that this person has already been asked under this reference.
    if (row.cancelled_at) continue;
    const phone = normalisePhone(row.contact_phone);
    if (phone) invitedThisCampaign.add(phone);
  }

  const recipients = [];
  const seen = new Set();

  for (const contact of contacts) {
    const phone = normalisePhone(contact.phone);
    if (!phone) { skip('invalid_phone'); continue; }
    if (seen.has(phone)) { skip('duplicate_contact'); continue; }
    seen.add(phone);

    const email = String(contact.email || '').trim();
    if (!email || !email.includes('@')) { skip('no_email_address'); continue; }

    if (contact.opted_out === true) { skip('contact_opted_out'); continue; }
    if (contact.ghl_dnd === true) { skip('dnd'); continue; }
    if (['active', 'permanent'].includes(String(contact.ghl_sms_dnd_status || '').toLowerCase())) {
      skip('dnd'); continue;
    }
    if (sentinelPhones.has(phone)) { skip('stop_sentinel'); continue; }
    if (activeSuppressionReason(suppressionsByPhone.get(phone) || [], now)) {
      skip('campaign_suppression'); continue;
    }

    const consent = latestConsent.get(phone);
    if (consent?.eventType === 'opt_out') { skip('consent_ledger_opt_out'); continue; }
    if (consent?.eventType === 'opt_in') { skip('already_opted_in'); continue; }

    if (invitedThisCampaign.has(phone)) { skip('already_invited_this_campaign'); continue; }

    recipients.push({
      phone,
      email,
      recipientName: String(contact.first_name || contact.name || '').trim() || null
    });
  }

  return {
    recipients,
    counts: {
      contactsRead: contacts.length,
      eligible: recipients.length,
      skipped: Object.values(skippedByReason).reduce((total, value) => total + value, 0),
      skippedByReason
    }
  };
}

/** One rendered message, ready for the agency to merge and send. */
function renderInvite({ recipient, optInUrl, expiresAt }) {
  const message = smsOptInInviteEmail({
    recipientName: recipient.recipientName,
    optInUrl,
    phoneEnding: phoneEnding(recipient.phone),
    expiresAt,
    expiryDays: EXPIRY_DAYS
  });
  return {
    to: recipient.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
    expires_at: expiresAt
  };
}

function printPlan(plan, flags) {
  const { counts } = plan;
  console.log('');
  console.log('  Output below contains masked contact details. Keep it private.');
  console.log('');
  console.log('  SOURCES READ');
  console.log(`  sms_contacts rows               ${counts.contactsRead}`);
  console.log('');
  console.log('  OUTCOME');
  console.log(`  would be invited                ${counts.eligible}`);
  console.log(`  skipped                         ${counts.skipped}`);
  for (const [reason, total] of Object.entries(counts.skippedByReason).sort()) {
    console.log(`    ${reason.padEnd(30)}  ${total}`);
  }

  if (!plan.recipients.length) return;
  const show = value => (flags.showPhones ? value : mask(value));
  console.log('');
  console.log('  FIRST 10 RECIPIENTS');
  for (const recipient of plan.recipients.slice(0, 10)) {
    const email = flags.showPhones ? recipient.email : maskEmail(recipient.email);
    console.log(`    ${show(recipient.phone).padEnd(16)}  ${email}`);
  }
  if (plan.recipients.length > 10) {
    console.log(`    ... and ${plan.recipients.length - 10} more`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
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
  const mode = resolveRunMode(flags);

  if (mode.error === 'campaign_ref_required') {
    console.error('--campaign-ref=<reference> is required. It names the mailing, e.g.');
    console.error('  --campaign-ref=sms_optin_invite_2026_08');
    console.error('Every invitation carries it, so a whole batch can be traced or explained as one thing.');
    return 1;
  }
  if (mode.error === 'both_flags_required') {
    console.error('');
    console.error('  Refusing to run. Minting invitations requires BOTH flags:');
    console.error('');
    console.error('    --commit             you intend to open invitations in sms_optin_invitations');
    console.error('    --mailing-approved   you have read docs/campaigns/SMS-OPTIN-INVITE.md and the');
    console.error('                         mailing has been agreed with whoever sends the email');
    console.error('');
    return 1;
  }
  if (mode.error === 'out_path_required') {
    console.error('');
    console.error('  Refusing to run. --commit requires --out=<path>.');
    console.error('');
    console.error('  Every rendered email contains a LIVE consent token in a URL. Pressing that');
    console.error('  link creates a consent record, so these are credentials and must not go to');
    console.error('  stdout, a terminal scrollback, or a CI log. The file is written 0600.');
    console.error('');
    return 1;
  }
  if (mode.error) {
    console.error(`Refusing to run: ${mode.error}`);
    return 1;
  }

  const { willWrite } = mode;

  const baseUrl = appUrl();
  if (!baseUrl) {
    console.error('APP_URL is not set, so no invitation link can be built. Nothing to do.');
    return 1;
  }

  console.log('');
  console.log('══ Promotional SMS opt-in invitations ══');
  console.log(`   mode       ${willWrite ? 'COMMIT — this run WILL open invitations' : 'DRY RUN — nothing will be written'}`);
  console.log(`   workspace  ${WORKSPACE_ID}`);
  console.log(`   campaign   ${flags.campaignRef}`);
  console.log(`   link base  ${baseUrl}`);
  console.log(`   expiry     ${EXPIRY_DAYS} days`);
  console.log('');
  console.log('   This script SENDS NOTHING and writes NO consent. It opens questions and');
  console.log('   renders the emails that carry them. Email is sent by the agency.');

  const sources = await readSources();
  const plan = planOptInMailing({ ...sources, campaignRef: flags.campaignRef });
  printPlan(plan, flags);

  if (!willWrite) {
    if (plan.recipients.length) {
      const sample = renderInvite({
        recipient: plan.recipients[0],
        // A dry run mints nothing, so there is no token to render and none is
        // invented. The shape of the URL is still visible.
        optInUrl: `${baseUrl}/sms-optin?token=${PLACEHOLDER_TOKEN}`,
        expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86400000).toISOString()
      });
      console.log('');
      console.log('  SAMPLE RENDERING (placeholder token; nothing was minted)');
      console.log(`  subject  ${sample.subject}`);
      console.log('');
      console.log(sample.text.split('\n').map(line => `    ${line}`).join('\n'));
    }
    console.log('');
    console.log('  DRY RUN. No invitation was opened and no email was rendered for sending.');
    console.log('  To commit, re-run with: --commit --mailing-approved --out=<path>');
    console.log('');
    return 0;
  }

  const capped = flags.limit ? plan.recipients.slice(0, flags.limit) : plan.recipients;
  if (flags.limit) {
    console.log('');
    console.log(`  --limit=${flags.limit} — inviting ${capped.length} of ${plan.recipients.length}.`);
  }

  console.log('');
  console.log('  Opening invitations...');

  const store = createSmsOptInInviteStore();
  const rendered = [];
  const refusals = {};
  let stoppedEarly = false;

  for (const recipient of capped) {
    if (interrupted) { stoppedEarly = true; break; }
    let issued;
    try {
      issued = await issueOptInInvite({
        store,
        consentClient: store.dbClient(),
        phone: recipient.phone,
        email: recipient.email,
        campaignRef: flags.campaignRef,
        baseUrl
      });
    } catch (error) {
      // issueOptInInvite is not documented to reject, so this is a bug rather
      // than a refusal. Neither the token nor the number appears in the log.
      console.error(`  unexpected failure: ${error.message}`);
      issued = { issued: false, reason: 'unexpected_error' };
    }

    if (!issued.issued) {
      const reason = issued.reason === 'withdrawn'
        ? `withdrawn:${issued.withdrawalReason}`
        : issued.reason;
      refusals[reason] = (refusals[reason] || 0) + 1;
      continue;
    }

    rendered.push(renderInvite({
      recipient,
      optInUrl: issued.inviteUrl,
      expiresAt: issued.expiresAt
    }));
  }

  // Written before anything is reported, and with an exclusive create so a
  // careless re-run cannot silently overwrite a handover file that still has
  // live tokens in it.
  const outPath = path.resolve(flags.out);
  fs.writeFileSync(outPath, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

  console.log('');
  console.log('  RESULT');
  console.log(`  attempted   ${capped.length}`);
  console.log(`  invited     ${rendered.length}`);
  for (const [reason, total] of Object.entries(refusals).sort()) {
    console.log(`  refused     ${reason.padEnd(34)}  ${total}`);
  }
  if (stoppedEarly) {
    console.log(`  STOPPED EARLY on SIGINT. Re-running is safe: anybody already invited under`);
    console.log('  this campaign reference is skipped.');
  }
  console.log('');
  console.log(`  Rendered emails written to ${outPath} (mode 0600).`);
  console.log('  THAT FILE CONTAINS LIVE CONSENT TOKENS. Hand it to whoever sends the email,');
  console.log('  then delete it. The invitations themselves live in the database.');
  console.log('');
  console.log('  No consent has been recorded. An invitation is a question, and every one of');
  console.log('  these numbers stays suppressed until somebody presses a button on the page.');
  console.log('');

  return 0;
}

if (require.main === module) {
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n  SIGINT received. Stopping after the current invitation.');
  });

  (async () => {
    try {
      process.exitCode = await main();
    } catch (error) {
      console.error(`\n  Invitation run aborted: ${error.message}\n`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  PLACEHOLDER_TOKEN,
  WORKSPACE_ID,
  fetchFilteredRows,
  mask,
  maskEmail,
  parseArgs,
  planOptInMailing,
  resolveRunMode,
  readSources,
  renderInvite
};
