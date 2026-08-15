#!/usr/bin/env node
'use strict';
/**
 * Backfill call recordings from Telnyx Recordings API into call_logs.
 *
 * Usage:  node scripts/backfill-recordings.js
 * Or via: POST /admin/backfill-recordings (from the dashboard)
 *
 * Pulls all recordings from Telnyx, matches them to call_logs by
 * call_leg_id / call_session_id / call_control_id, and fills in
 * private Supabase Storage metadata. Provider URLs are never retained.
 */

require('dotenv').config();
const { supabase } = require('../db');
const { archiveCallRecording } = require('../lib/private-recordings');

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

async function fetchAllRecordings() {
  const recordings = [];
  let page = 1;
  const perPage = 250;

  while (true) {
    const url = `https://api.telnyx.com/v2/recordings?page[size]=${perPage}&page[number]=${page}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}` }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Telnyx recordings API ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const batch = json.data || [];
    recordings.push(...batch);
    console.log(`[BACKFILL] Page ${page}: ${batch.length} recordings`);

    if (batch.length < perPage) break;
    page++;
  }

  return recordings;
}

async function backfillRecordings() {
  console.log('[BACKFILL] Fetching recordings from Telnyx...');
  const recordings = await fetchAllRecordings();
  console.log(`[BACKFILL] Total recordings from Telnyx: ${recordings.length}`);

  if (recordings.length === 0) {
    console.log('[BACKFILL] No recordings found on Telnyx.');
    return { total: 0, matched: 0, updated: 0 };
  }

  // Fetch all call_logs that are not privately archived yet.
  const { data: logs, error } = await supabase
    .from('call_logs')
    .select('id, call_control_id, call_leg_id, call_session_id')
    .is('recording_storage_path', null);

  if (error) throw new Error('DB fetch error: ' + error.message);
  console.log(`[BACKFILL] Call logs missing recordings: ${logs?.length || 0}`);

  if (!logs || logs.length === 0) {
    console.log('[BACKFILL] All call logs already have recordings (or no logs exist).');
    return { total: recordings.length, matched: 0, updated: 0 };
  }

  // Build lookup maps for matching
  const byControlId = {};
  const byLegId = {};
  const bySessionId = {};
  for (const log of logs) {
    if (log.call_control_id) byControlId[log.call_control_id] = log;
    if (log.call_leg_id) byLegId[log.call_leg_id] = log;
    if (log.call_session_id) bySessionId[log.call_session_id] = log;
  }

  let updated = 0;
  let matched = 0;

  for (const rec of recordings) {
    if (!rec.id || (!rec.download_urls?.mp3 && !rec.download_urls?.wav && !rec.recording_urls?.mp3 && !rec.recording_urls?.wav)) continue;

    // Try to match by call_leg_id first (most precise), then session, then control id
    const log = byLegId[rec.call_leg_id]
      || bySessionId[rec.call_session_id]
      || byControlId[rec.call_control_id]
      || null;

    if (!log) continue;
    matched++;

    try {
      const archived = await archiveCallRecording(rec.id, { recording: rec });
      const { error: updateErr } = await supabase
        .from('call_logs')
        .update({ recording_id: rec.id, ...archived })
        .eq('id', log.id);
      if (updateErr) throw new Error(updateErr.message);
      updated++;
      console.log(`[BACKFILL] Privately archived log #${log.id} (cid=...${log.call_control_id?.slice(-6) || '?'})`);
    } catch (archiveError) {
      console.error(`[BACKFILL] Private archive failed for log ${log.id}: ${archiveError.message}`);
    }
  }

  console.log(`[BACKFILL] Done. ${recordings.length} Telnyx recordings, ${matched} matched, ${updated} updated.`);
  return { total: recordings.length, matched, updated };
}

// Run directly or export for use from server route
if (require.main === module) {
  backfillRecordings()
    .then(r => { console.log('[BACKFILL] Result:', r); process.exit(0); })
    .catch(e => { console.error('[BACKFILL] Fatal:', e.message); process.exit(1); });
}

module.exports = { backfillRecordings };
