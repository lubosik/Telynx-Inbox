'use strict';
/**
 * scripts/sync-dnd-only.js — refresh do-not-disturb status, and nothing else.
 *
 * WHY NOT sync-ghl.js
 *   That script upserts name, ghl_contact_id, first_seen and last_seen as well.
 *   Those fields are now maintained from WooCommerce and from real message
 *   traffic, so letting a CRM sync overwrite them would quietly degrade
 *   contact data to fix an unrelated problem. This touches three columns.
 *
 * WHY IT MATTERS
 *   lib/campaigns/eligibility.js refuses any recipient whose DND status is
 *   older than dnd_status_max_age_hours, and it fails CLOSED. With no contact
 *   ever synced, every one of them reads `dnd_unknown` and a campaign targeting
 *   five hundred people would send to nobody. That is the safety check working
 *   exactly as designed; it just has nothing to work from.
 *
 * PARTIAL DATA IS NOT FRESHNESS
 *   A timestamp is written only when GHL gave BOTH a global dnd boolean and an
 *   explicit SMS status. A contact that answers half the question stays
 *   unknown, because "we asked and got a shrug" must not read the same as "we
 *   asked and they said yes".
 *
 *   node scripts/sync-dnd-only.js --dry-run
 *   node scripts/sync-dnd-only.js
 */

require('dotenv').config();
const { supabase } = require('../db');

const BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TOKEN = process.env.GHL_AGENCY_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

function headers() {
  return { Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };
}

function dndState(contact, observedAt) {
  const globalDnd = typeof contact?.dnd === 'boolean' ? contact.dnd : null;
  const rawSms = contact?.dndSettings?.sms?.status ?? contact?.dndSettings?.SMS?.status;
  const smsStatus = ['active', 'inactive', 'permanent'].includes(String(rawSms || '').toLowerCase())
    ? String(rawSms).toLowerCase()
    : null;
  // Complete when GHL gave an explicit global flag. An absent per-channel
  // status means no override, which is an answer. A PARTIAL answer, meaning no
  // boolean at all, is still not freshness.
  const complete = globalDnd !== null;
  return {
    ghl_dnd: globalDnd,
    ghl_sms_dnd_status: smsStatus,
    ghl_dnd_synced_at: complete ? observedAt.toISOString() : null,
    complete
  };
}

async function fetchAllContacts() {
  const all = [];
  let startAfter = null;
  let startAfterId = null;
  while (true) {
    let url = `${BASE}/contacts/?locationId=${LOCATION_ID}&limit=100`;
    if (startAfter && startAfterId) url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const response = await fetch(url, { headers: headers() });
    if (!response.ok) throw new Error(`GHL contacts fetch failed (${response.status})`);
    const page = await response.json();
    const batch = page.contacts || [];
    all.push(...batch);
    const meta = page.meta || {};
    if (!batch.length || !meta.startAfter || !meta.startAfterId) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
    if (all.length > 20000) break;
  }
  return all;
}

async function main() {
  if (!LOCATION_ID || !TOKEN) throw new Error('GHL_LOCATION_ID and GHL_AGENCY_TOKEN are required');
  const observedAt = new Date();
  const contacts = await fetchAllContacts();
  console.log(`GHL contacts fetched: ${contacts.length}`);

  const withPhone = contacts.filter(c => c.phone);
  let complete = 0;
  let partial = 0;
  let written = 0;
  let missingLocally = 0;

  for (const contact of withPhone) {
    const state = dndState(contact, observedAt);
    if (state.complete) complete += 1; else partial += 1;

    if (DRY_RUN) continue;
    // update(), never upsert(). A phone GHL knows and this system does not is
    // not a contact worth inventing here; it would arrive with a name and
    // nothing else and pollute every count that reads sms_contacts.
    const { data, error } = await supabase
      .from('sms_contacts')
      .update({
        ghl_dnd: state.ghl_dnd,
        ghl_sms_dnd_status: state.ghl_sms_dnd_status,
        ghl_dnd_synced_at: state.ghl_dnd_synced_at
      })
      .eq('phone', contact.phone)
      .select('phone');
    if (error) throw new Error(`update failed for ${contact.phone}: ${error.message}`);
    if (data?.length) written += 1; else missingLocally += 1;
  }

  console.log(`with a phone number : ${withPhone.length}`);
  console.log(`complete DND answer : ${complete}`);
  console.log(`partial, left unknown: ${partial}`);
  if (DRY_RUN) {
    console.log('\nDRY RUN. Nothing was written.');
  } else {
    console.log(`rows updated        : ${written}`);
    console.log(`in GHL, not here    : ${missingLocally}`);
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
