'use strict';

/**
 * Read-only Phase 0 audit of the registered/no-paid-order cohort.
 *
 * `node scripts/audit-vici-registration-consent.js --luko-only`
 *   checks the existing LUKO gates without requiring a new WP plugin.
 *
 * `railway run node scripts/audit-vici-registration-consent.js`
 *   additionally checks the signed WordPress /luko/v1/consent-audit endpoint
 *   after connector 0.4.1 is installed. No contact, consent or message write.
 *
 * `--out /absolute/private/path.csv` writes a 0600 per-user review file.
 * Standard output is aggregate-only and contains no phone, email or name.
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { normalisePhone } = require('../lib/phone');
const { signBody } = require('../lib/cart-recovery/security');
const { evaluateSingleRecipient, latestConsent } = require('../lib/campaigns/eligibility');

const DEFAULT_SOURCE = '/Users/ghost/Desktop/Vici_Registration_Omnisend_Woo_Verified_2026-10-01.csv';
const BATCH_SIZE = 100;

function csvRows(input, required = ['wp_user_id', 'phone', 'woo_paid_order_count']) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (quoted) throw new Error('Unclosed quote in cohort CSV.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [headers, ...records] = rows;
  if (!headers || !required.every(key => headers.includes(key))) {
    throw new Error('Cohort CSV does not have the expected columns.');
  }
  return records.map(values => Object.fromEntries(headers.map((key, index) => [key, values[index] || ''])));
}

function cohortRows(records) {
  const byID = new Map();
  for (const row of records) {
    const id = Number(row.wp_user_id);
    const phone = normalisePhone(row.phone);
    if (!Number.isSafeInteger(id) || id < 1 || !phone || !/^\+[1-9][0-9]{7,14}$/.test(phone)) continue;
    if (Number(row.woo_paid_order_count) !== 0) continue;
    if (byID.has(id)) throw new Error('Duplicate WordPress user ID in cohort CSV.');
    byID.set(id, { id, phone, email: String(row.email || '').trim().toLowerCase() });
  }
  return [...byID.values()];
}

function evidenceStatus(source, wordpress) {
  if (!wordpress) return 'wordpress_not_checked';
  if (Number(wordpress.wordpress_user_id) !== source.id) return 'identity_conflict';
  if (normalisePhone(wordpress.phone) !== source.phone) return 'phone_conflict';
  if (wordpress.verified !== true) return String(wordpress.reason || 'not_verified');
  const e = wordpress.evidence || {};
  if (e.source !== 'vici_registration' || !Number.isFinite(Date.parse(e.occurred_at || '')) ||
      !e.version || !e.disclosure || !/^https:\/\//.test(e.privacy_url || '') ||
      !/^https:\/\//.test(e.terms_url || '')) return 'evidence_incomplete';
  return 'wordpress_checkbox_verified';
}

function classify(source, wordpress, luko) {
  const wpStatus = evidenceStatus(source, wordpress);
  const event = luko?.consentEvent;
  const lukoConsent = event?.event_type === 'opt_out' ? 'recorded_opt_out'
    : event?.event_type === 'opt_in' ? 'recorded_opt_in' : 'not_recorded';
  return {
    wpStatus,
    lukoConsent,
    lukoStatus: luko?.eligibility?.reason || 'not_checked',
    consentSynced: wpStatus === 'wordpress_checkbox_verified' && lukoConsent === 'recorded_opt_in' &&
      event?.source === 'vici_registration' &&
      Date.parse(event.occurred_at || '') >= Date.parse(wordpress?.evidence?.occurred_at || ''),
    sendEligible: wpStatus === 'wordpress_checkbox_verified' && luko?.eligibility?.eligible === true,
  };
}

function countBy(rows, key) {
  const tally = {};
  for (const row of rows) tally[row[key]] = (tally[row[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(tally).sort((a, b) => a[0].localeCompare(b[0])));
}

function cell(value) {
  const string = String(value == null ? '' : value);
  return '"' + string.replaceAll('"', '""') + '"';
}

function writePrivateCSV(file, rows) {
  if (!path.isAbsolute(file)) throw new Error('--out must be an absolute path.');
  const headers = ['wp_user_id', 'phone', 'wp_status', 'wp_consent_at', 'wp_consent_version',
    'luko_status', 'luko_consent', 'luko_consent_source', 'luko_consent_at', 'send_eligible'];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push([
    row.id, row.phone, row.audit.wpStatus, row.wordpress?.evidence?.occurred_at || '',
    row.wordpress?.evidence?.version || '', row.audit.lukoStatus, row.audit.lukoConsent,
    row.luko?.consentEvent?.source || '', row.luko?.consentEvent?.occurred_at || '', row.audit.sendEligible,
  ].map(cell).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function readWordPress(rows, env = process.env) {
  if (!env.LUKO_WP_SIGNING_SECRET || !env.LUKO_WP_URL) {
    throw new Error('LUKO_WP_SIGNING_SECRET and LUKO_WP_URL are required for WordPress audit.');
  }
  const endpoint = new URL('/wp-json/luko/v1/consent-audit', env.LUKO_WP_URL);
  if (endpoint.protocol !== 'https:') throw new Error('WordPress audit endpoint must use HTTPS.');
  const found = new Map();
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const chunk = rows.slice(start, start + BATCH_SIZE);
    const body = JSON.stringify({ user_ids: chunk.map(row => row.id) });
    const response = await fetch(endpoint, {
      method: 'POST', body, headers: signBody(body, env.LUKO_WP_SIGNING_SECRET),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`WordPress consent audit failed: HTTP ${response.status}. Connector 0.4.1 must be active.`);
    const payload = await response.json();
    if (!Array.isArray(payload.results)) throw new Error('WordPress consent audit returned an invalid response.');
    const expected = new Set(chunk.map(row => row.id));
    for (const item of payload.results) {
      const id = Number(item.wordpress_user_id);
      if (!expected.has(id) || found.has(id)) throw new Error('WordPress consent audit returned an unexpected or duplicate user.');
      found.set(id, item);
    }
    if (chunk.some(row => !found.has(row.id))) throw new Error('WordPress consent audit omitted a requested user.');
  }
  return found;
}

async function readLuko(rows, env = process.env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error('Supabase read credentials are required.');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const output = new Map();
  for (let start = 0; start < rows.length; start += 5) {
    const batch = rows.slice(start, start + 5);
    const [results, events, contacts, identities] = await Promise.all([
      Promise.all(batch.map(row => evaluateSingleRecipient({ client, phone: row.phone }))),
      // bounded: batch contains at most five audited registrations.
      client.from('sms_consent_events')
        .select('id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,occurred_at')
        .eq('workspace_id', 'vici').in('contact_phone', batch.map(row => row.phone)),
      // bounded: batch contains at most five audited registrations.
      client.from('sms_contacts').select('phone,email,woo_customer_id').in('phone', batch.map(row => row.phone)),
      // bounded: batch contains at most five audited registrations.
      client.from('luko_customer_identities').select('wordpress_user_id,contact_phone,luko_contact_linked,customer_email')
        .eq('workspace_id', 'vici').in('wordpress_user_id', batch.map(row => String(row.id))),
    ]);
    if (events.error) throw new Error('LUKO consent ledger could not be read.');
    if (contacts.error) throw new Error('LUKO contact mapping could not be read.');
    if (identities.error) throw new Error('LUKO customer identity mapping could not be read.');
    const contactByPhone = new Map((contacts.data || []).map(item => [item.phone, item]));
    const identityByUser = new Map((identities.data || []).map(item => [Number(item.wordpress_user_id), item]));
    batch.forEach((row, index) => {
      const contact = contactByPhone.get(row.phone);
      const identity = identityByUser.get(row.id);
      const sameEmail = row.email && contact?.email?.trim().toLowerCase() === row.email &&
        identity?.customer_email?.trim().toLowerCase() === row.email;
      const sameCustomerID = String(contact?.woo_customer_id || '') === String(row.id);
      const contactCustomerConflict = Boolean(contact?.woo_customer_id) && !sameCustomerID;
      output.set(row.id, {
      eligibility: results[index],
      consentEvent: latestConsent((events.data || []).filter(item => item.contact_phone === row.phone)),
      contactLinked: Boolean(contact),
      contactCustomerIDMatches: sameCustomerID,
      contactCustomerIDMissing: Boolean(contact) && !contact.woo_customer_id,
      contactCustomerIDConflicts: contactCustomerConflict,
      identityPresent: Boolean(identity),
      identityPhoneMissing: Boolean(identity) && !identity.contact_phone,
      identityPhoneConflicts: Boolean(identity?.contact_phone) && identity.contact_phone !== row.phone,
      identityPhoneMatches: identity?.contact_phone === row.phone,
      identityLinked: identity?.contact_phone === row.phone && identity.luko_contact_linked === true,
      identityRepairEvidence: Boolean(identity) && !identity.contact_phone && Boolean(contact) &&
        !contactCustomerConflict && (sameEmail || sameCustomerID),
      identityRepairReason: !identity ? 'identity_missing' : identity.contact_phone ? 'already_linked_or_conflict'
        : !contact ? 'contact_missing' : contactCustomerConflict ? 'contact_customer_conflict'
          : sameEmail || sameCustomerID ? 'strong_match' : 'insufficient_identity_match',
      });
    });
  }
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  const lukoOnly = args.includes('--luko-only');
  const inputIndex = args.indexOf('--in');
  const outputIndex = args.indexOf('--out');
  const source = inputIndex < 0 ? DEFAULT_SOURCE : args[inputIndex + 1];
  const output = outputIndex < 0 ? null : args[outputIndex + 1];
  if (!source || (outputIndex >= 0 && !output)) throw new Error('Missing --in or --out path.');
  const cohort = cohortRows(csvRows(fs.readFileSync(source, 'utf8')));
  const wordpress = lukoOnly ? new Map() : await readWordPress(cohort);
  const luko = await readLuko(cohort);
  const reviewed = cohort.map(row => ({ ...row, wordpress: wordpress.get(row.id),
    luko: luko.get(row.id), audit: classify(row, wordpress.get(row.id), luko.get(row.id)) }));
  if (output) writePrivateCSV(output, reviewed);
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), mode: lukoOnly ? 'luko_only' : 'wordpress_and_luko',
    cohortCount: reviewed.length, wordpressEvidence: countBy(reviewed.map(row => row.audit), 'wpStatus'),
    lukoConsent: countBy(reviewed.map(row => row.audit), 'lukoConsent'),
    lukoConsentOrigin: countBy(reviewed.map(row => ({ origin: `${row.audit.lukoConsent}:${row.luko?.consentEvent?.source || 'none'}` })), 'origin'),
    lukoGate: countBy(reviewed.map(row => row.audit), 'lukoStatus'),
    wordpressVerified: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified').length,
    verifiedUniquePhoneCount: new Set(reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified').map(row => row.phone)).size,
    verifiedAndSynced: reviewed.filter(row => row.audit.consentSynced).length,
    verifiedAndCurrentlyEligible: reviewed.filter(row => row.audit.sendEligible).length,
    verifiedAndContactLinked: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.contactLinked).length,
    verifiedContactCustomerIDMatches: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.contactCustomerIDMatches).length,
    verifiedContactCustomerIDMissing: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.contactCustomerIDMissing).length,
    verifiedContactCustomerIDConflicts: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.contactCustomerIDConflicts).length,
    verifiedAndIdentityPresent: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.identityPresent).length,
    verifiedAndIdentityLinked: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.identityLinked).length,
    cohortContactLinked: reviewed.filter(row => row.luko?.contactLinked).length,
    cohortIdentityPresent: reviewed.filter(row => row.luko?.identityPresent).length,
    cohortIdentityPhoneMissing: reviewed.filter(row => row.luko?.identityPhoneMissing).length,
    cohortIdentityPhoneConflicts: reviewed.filter(row => row.luko?.identityPhoneConflicts).length,
    cohortIdentityPhoneMatches: reviewed.filter(row => row.luko?.identityPhoneMatches).length,
    cohortIdentityLinked: reviewed.filter(row => row.luko?.identityLinked).length,
    verifiedWithIdentityRepairEvidence: reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.identityRepairEvidence).length,
    verifiedNullPhoneRepairReasons: countBy(reviewed.filter(row => row.audit.wpStatus === 'wordpress_checkbox_verified' && row.luko?.identityPhoneMissing)
      .map(row => ({ reason: row.luko.identityRepairReason })), 'reason'),
    cohortWithIdentityRepairEvidence: reviewed.filter(row => row.luko?.identityRepairEvidence).length,
    privateReviewFileWritten: Boolean(output) }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(`Consent audit stopped: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { csvRows, cohortRows, evidenceStatus, classify, readWordPress };
