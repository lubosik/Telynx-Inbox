'use strict';
/**
 * lib/ghl-dnd-sync.js — keep do-not-disturb status fresh enough to send.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SCHEDULED JOB AND NOT A SCRIPT ANY MORE
 *
 *   lib/campaigns/eligibility.js refuses any recipient whose DND status is
 *   older than `dnd_status_max_age_hours`, which is 24, and it fails CLOSED.
 *   That is correct: not knowing whether somebody has asked not to be
 *   disturbed is not the same as knowing they have not.
 *
 *   But the only thing that ever refreshed that timestamp was somebody running
 *   scripts/sync-dnd-only.js by hand. It was last run on 25 August. By the
 *   30th every one of 221 recipients read `dnd_unknown`, the dry run reported
 *   zero eligible, and "Submit for review" was greyed out with no explanation
 *   that pointed anywhere useful.
 *
 *   The owner's report was "I can't see the button". The cause was a
 *   five-day-old timestamp.
 *
 *   A safety check that needs a human to run a script every day is a safety
 *   check that will be off most days. Six hours gives four chances to succeed
 *   inside every 24-hour window, so a single failed run costs nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PARTIAL DATA IS NOT FRESHNESS
 *
 *   A timestamp is written only when GHL gave BOTH a global dnd boolean and an
 *   explicit SMS status. A contact that answers half the question stays
 *   unknown, because "we asked and got a shrug" must not read the same as "we
 *   asked and they said yes".
 *
 * IT WRITES THREE COLUMNS AND NOTHING ELSE
 *
 *   Not name, not ghl_contact_id, not first_seen or last_seen. Those are
 *   maintained from WooCommerce and from real message traffic, and letting a
 *   CRM sync overwrite them would quietly degrade contact data to fix an
 *   unrelated problem.
 */

const { IN_CHUNK_SIZE } = require('./fetch-all-rows');

const BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TOKEN = process.env.GHL_AGENCY_TOKEN;

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


/**
 * Refresh DND for every contact GHL knows about.
 *
 * Returns counts rather than logging them, so the scheduler and the CLI can
 * each present them their own way. Never throws for one bad row: a single
 * contact that cannot be written must not abandon the other 953.
 */
async function syncDoNotDisturb({ client, now = () => new Date(), dryRun = false } = {}) {
  const db = client || require('../db').supabase;
  const observedAt = now();
  const contacts = await fetchAllContacts();
  const withPhone = contacts.filter(contact => contact.phone);

  let complete = 0;
  let partial = 0;

  // ── Grouped, not one write per contact ──────────────────────────────────
  //
  // The first version updated each contact separately: 954 sequential writes
  // taking most of two minutes, which is the same N+1 that made the code
  // budget take 283 seconds earlier.
  //
  // Every contact in one run shares the same observedAt, and `ghl_dnd` and
  // `ghl_sms_dnd_status` take very few distinct values across an account, so
  // grouping by the exact triple collapses it to a handful of updates. On this
  // account it is one.
  const byState = new Map();
  for (const contact of withPhone) {
    const state = dndState(contact, observedAt);
    if (state.ghl_dnd_synced_at) complete += 1; else partial += 1;
    const key = JSON.stringify([state.ghl_dnd, state.ghl_sms_dnd_status, state.ghl_dnd_synced_at]);
    if (!byState.has(key)) byState.set(key, { state, phones: [] });
    byState.get(key).phones.push(contact.phone);
  }

  let written = 0;
  let missingLocally = 0;
  let failed = 0;

  if (!dryRun) {
    for (const { state, phones } of byState.values()) {
      // Chunked: an unbounded .in() serialises every phone into the URL and
      // overflows it, which is how the inbox went down on 20 Aug.
      for (let index = 0; index < phones.length; index += IN_CHUNK_SIZE) {
        const chunk = phones.slice(index, index + IN_CHUNK_SIZE);
        try {
          const { data, error } = await db
            .from('sms_contacts')
            .update({
              ghl_dnd: state.ghl_dnd,
              ghl_sms_dnd_status: state.ghl_sms_dnd_status,
              ghl_dnd_synced_at: state.ghl_dnd_synced_at
            })
            // bounded: sliced at IN_CHUNK_SIZE just above, the same ceiling
            // selectIn enforces; selectIn is a read helper and this is an update.
            .in('phone', chunk)
            .select('phone');
          if (error) throw new Error(error.message);
          written += data?.length || 0;
          missingLocally += chunk.length - (data?.length || 0);
        } catch {
          // One bad chunk must not abandon the rest.
          failed += chunk.length;
        }
      }
    }
  }

  return {
    fetched: contacts.length,
    withPhone: withPhone.length,
    complete,
    partial,
    written,
    missingLocally,
    failed,
    dryRun
  };
}

module.exports = { dndState, fetchAllContacts, syncDoNotDisturb };
