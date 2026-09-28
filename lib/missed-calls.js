'use strict';

const { readAllInboxRows, readInboxAudience } = require('./inbox-audience');

/**
 * Missed inbound calls that nobody has looked at yet.
 *
 * This backs the Home Screen badge, which is a single number for the whole app,
 * so it has to combine with the unread message count. "Seen" is shared across
 * devices rather than per device, matching how sms_contacts.unread_count
 * already behaves for messages in this shared inbox.
 *
 * Every failure here reports zero rather than throwing. The badge is cosmetic;
 * a schema without scripts/missed-calls-seen-migration.sql applied, or a
 * transient Supabase error, must never break a call log request or stop a
 * message notification from being delivered.
 */

let didWarnAboutMissingColumn = false;

// Postgres "undefined column" — i.e. the migration has not been applied.
const UNDEFINED_COLUMN = '42703';

function noteFailure(context, error) {
  const message = error?.message || 'unknown error';
  // Pre-migration this fires on every message push. Say it once.
  if (error?.code === UNDEFINED_COLUMN) {
    if (didWarnAboutMissingColumn) return;
    didWarnAboutMissingColumn = true;
    console.warn(`[CALLS] ${context}: ${message} — run scripts/missed-calls-seen-migration.sql`);
    return;
  }
  console.warn(`[CALLS] ${context}: ${message}`);
}

/**
 * The transfer leg to sip:USERNAME is an implementation detail and is always
 * outbound, so filtering on inbound already excludes it. See
 * lib/call-status.js#isInternalSIPLog.
 */
async function countUnseenMissedCalls({ client = require('../db').supabase, audience = 'all' } = {}) {
  try {
    // `head: true` would be cheaper but PostgREST returns no body on a HEAD, so
    // a failure arrives with an empty message and cannot be diagnosed. Ask for
    // the exact count with a single row instead.
    if (audience !== 'all') {
      const scope = await readInboxAudience(client, audience);
      const rows = await readAllInboxRows(client, 'call_logs', 'id,contact_phone', {
        orderBy: 'id', ascending: true,
        filter: query => query.eq('direction', 'inbound').eq('status', 'missed').is('seen_at', null)
      });
      return scope.filter(rows).length;
    }
    const { count, error } = await client
      .from('call_logs')
      .select('id', { count: 'exact' })
      .eq('direction', 'inbound')
      .eq('status', 'missed')
      .is('seen_at', null)
      .limit(1);
    if (error) {
      noteFailure('unseen missed-call count failed', error);
      return 0;
    }
    return Math.max(0, count || 0);
  } catch (error) {
    noteFailure('unseen missed-call count threw', error);
    // A scoped zero would wrongly imply that the selected inbox is clear
    // when membership could not be read. Keep the legacy global badge fallback.
    if (audience !== 'all') throw error;
    return 0;
  }
}

/**
 * Marks every outstanding missed call as looked at. Called when the operator
 * opens call history — seeing the list is what clears the badge, the same way
 * WhatsApp clears its missed-call count.
 */
async function markMissedCallsSeen({ client = require('../db').supabase, audience = 'all', ids = null } = {}) {
  try {
    if (audience !== 'all' || ids !== null) {
      if (ids !== null && (!Array.isArray(ids) || ids.length > 1000
        || ids.some(id => !/^\d+$/.test(String(id))))) {
        return { marked: 0, ok: false };
      }
      const scope = await readInboxAudience(client, audience);
      const rows = await readAllInboxRows(client, 'call_logs', 'id,contact_phone', {
        orderBy: 'id', ascending: true,
        filter: query => query.eq('direction', 'inbound').eq('status', 'missed').is('seen_at', null)
      });
      const requestedIDs = ids === null ? null : new Set(ids.map(String));
      const targets = scope.filter(rows).filter(row => !requestedIDs || requestedIDs.has(String(row.id)));
      let marked = 0;
      const seenAt = new Date().toISOString();
      // Small bounded chunks, never an unbounded list of customer numbers.
      for (let offset = 0; offset < targets.length; offset += 200) {
        const chunk = targets.slice(offset, offset + 200).map(row => row.id);
        // bounded: each chunk contains at most 200 numeric call-log IDs.
        const { data, error } = await client.from('call_logs').update({ seen_at: seenAt })
          .in('id', chunk).eq('direction', 'inbound').eq('status', 'missed')
          .is('seen_at', null).select('id');
        if (error) { noteFailure('marking scoped missed calls seen failed', error); return { marked, ok: false }; }
        marked += (data || []).length;
      }
      return { marked, ok: true };
    }
    const { data, error } = await client
      .from('call_logs')
      .update({ seen_at: new Date().toISOString() })
      .eq('direction', 'inbound')
      .eq('status', 'missed')
      .is('seen_at', null)
      .select('id');
    if (error) {
      noteFailure('marking missed calls seen failed', error);
      return { marked: 0, ok: false };
    }
    return { marked: (data || []).length, ok: true };
  } catch (error) {
    noteFailure('marking missed calls seen threw', error);
    return { marked: 0, ok: false };
  }
}

module.exports = { countUnseenMissedCalls, markMissedCallsSeen };
