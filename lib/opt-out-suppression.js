'use strict';
/**
 * lib/opt-out-suppression.js — a STOP lands on the do-not-contact list.
 *
 * WHAT WAS ALREADY TRUE
 *   `markOptedOut` writes an opt-out sentinel into sms_sent_log, and campaign
 *   eligibility refuses anybody holding one. A STOP has therefore always been
 *   honoured. Nothing here is fixing a customer being messaged after saying
 *   stop.
 *
 * WHAT WAS MISSING, AND WHY IT MATTERS ANYWAY
 *   The sentinel is invisible. It lives in a send log under a synthetic order
 *   id, so the operator's do-not-contact screen showed two people while the
 *   real answer was two plus everybody who had ever texted STOP. A list of
 *   who cannot be contacted that is not the list of who cannot be contacted
 *   is worse than no list: somebody reads it, sees a name missing, and adds
 *   them back to a campaign by hand.
 *
 *   It is also a single bar. Consent withdrawal was recorded in the audit log
 *   but never as an `opt_out` row in sms_consent_events, so the consent trail
 *   for a person who opted out showed only their opt-in. That is the wrong way
 *   round for the one record anybody would ever be asked to produce.
 *
 * SO THIS ADDS TWO MORE BARS, INDEPENDENTLY
 *   A suppression row, which the operator can see and which the send path
 *   checks first of all, and an `opt_out` consent event, which outranks any
 *   opt-in because eligibility checks the event type before it checks anything
 *   about evidence.
 *
 * IT NEVER THROWS
 *   The caller has already honoured the STOP by the time this runs. Failing
 *   here must not undo that, and must not stop the rest of the webhook. Every
 *   failure is logged loudly and swallowed, for the same reason the sentinel
 *   write is retried rather than fatal: an unrecorded suppression is a
 *   bookkeeping problem, an unhonoured STOP is a regulatory one.
 */

const WORKSPACE_ID = 'vici';

/**
 * Put somebody who texted STOP onto the do-not-contact list, and record the
 * withdrawal of consent.
 *
 * @param {string} phone   E.164.
 * @param {object} [deps]
 * @returns {Promise<{suppressed: boolean, consentRecorded: boolean}>}
 */
async function suppressOptOut(phone, { client, now = () => new Date() } = {}) {
  const outcome = { suppressed: false, consentRecorded: false };
  if (!phone || !/^\+[1-9][0-9]{7,14}$/.test(phone)) return outcome;
  const db = client || require('../db').supabase;
  const occurredAt = now().toISOString();
  const tail = `...${phone.slice(-4)}`;

  // 1. The visible list. Checked first so a second STOP from the same person
  //    is silent rather than a duplicate row: they meant the same thing twice.
  try {
    const { data: existing, error: readError } = await db
      .from('sms_campaign_suppressions')
      .select('id')
      .eq('workspace_id', WORKSPACE_ID)
      .eq('contact_phone', phone)
      .eq('active', true)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) {
      outcome.suppressed = true;
    } else {
      const { error } = await db.from('sms_campaign_suppressions').insert({
        workspace_id: WORKSPACE_ID,
        contact_phone: phone,
        // The table's own vocabulary. 'manual_block' would be a lie: nobody
        // manually blocked this person, they asked to be left alone, and the
        // difference is the entire justification for the row.
        reason_code: 'compliance_hold',
        source: 'sms_stop',
        evidence_ref: `Texted STOP on ${occurredAt}`,
        active: true
      });
      if (error) throw error;
      outcome.suppressed = true;
    }
  } catch (error) {
    console.error(`[OPT-OUT] Could not add ${tail} to the do-not-contact list: ${error.message || error.code || 'unknown'}`);
  }

  // 2. The consent trail. An opt_out needs no purpose, brand or evidence match
  //    to count, by design: withdrawal is always easier to prove than consent.
  try {
    const { error } = await db.from('sms_consent_events').insert({
      workspace_id: WORKSPACE_ID,
      contact_phone: phone,
      event_type: 'opt_out',
      purpose: 'promotional_sms',
      brand_id: WORKSPACE_ID,
      source: 'sms_stop',
      evidence_ref: 'Inbound STOP message',
      occurred_at: occurredAt,
      // Once per phone per day. A retried webhook must not write a second row,
      // and somebody texting STOP twice in a week legitimately produces two.
      dedupe_key: `optout:${phone}:${occurredAt.slice(0, 10)}`
    });
    // 23505 is the dedupe index doing its job, which is a success.
    if (error && error.code !== '23505') throw error;
    outcome.consentRecorded = true;
  } catch (error) {
    console.error(`[OPT-OUT] Could not record consent withdrawal for ${tail}: ${error.message || error.code || 'unknown'}`);
  }

  return outcome;
}

module.exports = { suppressOptOut, WORKSPACE_ID };
