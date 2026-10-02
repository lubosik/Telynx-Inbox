'use strict';
/**
 * One-time, conflict-checked link repair for the verified 2026-10-01 cohort.
 * Default is read-only. --apply --expect N updates only existing identity rows
 * whose phone is NULL. It never creates contacts, consent, campaigns or sends.
 * Standard output is aggregate-only; no customer PII is printed.
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { csvRows, cohortRows, readWordPress, evidenceStatus } = require('./audit-vici-registration-consent');

const SOURCE = '/Users/ghost/Desktop/Vici_Registration_Omnisend_Woo_Verified_2026-10-01.csv';
const WORKSPACE = 'vici';

function classifyRepair({ source, wordpress, identity, contact, otherIdentities }) {
  if (evidenceStatus(source, wordpress) !== 'wordpress_checkbox_verified') return 'not_verified';
  if (!identity) return 'identity_missing';
  if (identity.contact_phone === source.phone && identity.luko_contact_linked === true) return 'already_linked';
  if (identity.contact_phone) return 'identity_phone_conflict';
  if (!contact) return 'contact_missing';
  if (String(contact.woo_customer_id || '') !== String(source.id)) return 'contact_customer_conflict';
  const email = String(source.email || '').trim().toLowerCase();
  if (!email || String(contact.email || '').trim().toLowerCase() !== email ||
      String(identity.customer_email || '').trim().toLowerCase() !== email) return 'email_mismatch';
  if ((otherIdentities || []).some(row => row.id !== identity.id && row.wordpress_user_id !== String(source.id))) {
    return 'shared_phone_identity_conflict';
  }
  return 'safe_repair';
}

async function inspectOne(client, source, wordpress) {
  if (evidenceStatus(source, wordpress) !== 'wordpress_checkbox_verified') return { reason: 'not_verified' };
  const [identity, contact, other] = await Promise.all([
    client.from('luko_customer_identities').select('id,wordpress_user_id,customer_email,contact_phone,luko_contact_linked')
      .eq('workspace_id', WORKSPACE).eq('wordpress_user_id', String(source.id)).maybeSingle(),
    client.from('sms_contacts').select('id,phone,email,woo_customer_id').eq('phone', source.phone).maybeSingle(),
    client.from('luko_customer_identities').select('id,wordpress_user_id').eq('workspace_id', WORKSPACE)
      .eq('contact_phone', source.phone).limit(10),
  ]);
  if (identity.error || contact.error || other.error) throw new Error('Identity preflight read failed.');
  return { reason: classifyRepair({ source, wordpress, identity: identity.data,
    contact: contact.data, otherIdentities: other.data || [] }), identity: identity.data };
}

async function run({ apply = false, expect = null, sourcePath = SOURCE, env = process.env } = {}) {
  if (apply && (!Number.isSafeInteger(expect) || expect < 1)) throw new Error('--apply requires --expect N.');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error('Supabase service credentials are required.');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const cohort = cohortRows(csvRows(fs.readFileSync(sourcePath, 'utf8')));
  const wordpress = await readWordPress(cohort, env);
  const reviewed = [];
  for (const source of cohort) {
    const review = await inspectOne(client, source, wordpress.get(source.id));
    reviewed.push({ source, wordpress: wordpress.get(source.id), ...review });
  }
  const counts = Object.fromEntries([...new Set(reviewed.map(row => row.reason))].sort()
    .map(reason => [reason, reviewed.filter(row => row.reason === reason).length]));
  const safe = reviewed.filter(row => row.reason === 'safe_repair');
  if (apply && safe.length !== expect) throw new Error(`Expected ${expect} safe repairs but found ${safe.length}; no changes applied.`);
  let updated = 0;
  if (apply) {
    for (const row of safe) {
      // Re-read immediately before the write; a changed contact/identity is
      // quarantined instead of trusted from the first scan.
      const fresh = await inspectOne(client, row.source, row.wordpress);
      if (fresh.reason !== 'safe_repair' || fresh.identity.id !== row.identity.id) {
        throw new Error(`Preflight changed after ${updated} repairs; stopped safely.`);
      }
      const { data, error } = await client.from('luko_customer_identities').update({
        contact_phone: row.source.phone, luko_contact_linked: true,
        resolved_by: 'wordpress_user_id', updated_at: new Date().toISOString()
      }).eq('id', row.identity.id).eq('workspace_id', WORKSPACE)
        .eq('wordpress_user_id', String(row.source.id)).is('contact_phone', null).select('id');
      if (error || data?.length !== 1) throw new Error(`Conditional identity repair stopped after ${updated} rows.`);
      updated++;
    }
  }
  return { mode: apply ? 'applied' : 'dry_run', cohortCount: reviewed.length,
    verifiedCount: reviewed.filter(row => row.reason !== 'not_verified').length,
    reasons: counts, updated, consentOrContactRowsChanged: 0, messagesSent: 0 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const expectAt = args.indexOf('--expect');
  const expect = expectAt < 0 ? null : Number(args[expectAt + 1]);
  run({ apply, expect }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`Identity repair stopped: ${error.message}`); process.exitCode = 1; });
}

module.exports = { classifyRepair, run };
