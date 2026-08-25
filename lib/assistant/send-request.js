'use strict';
/**
 * lib/assistant/send-request.js — the assistant asks; a face answers.
 *
 * WHAT CHANGED, AND WHY THE OLD RULE IS NOT SIMPLY GONE
 *
 * This assistant used to have no route to a customer at all. Not a disabled
 * send tool: no send tool. That was the right shape while nothing had ever
 * been sent, because the cheapest way to be certain a model cannot message
 * eight hundred people is to never write the function.
 *
 * The business now needs the reorder check-in, which is the revenue activity,
 * and refusing to build it forever is not caution, it is just refusing to
 * ship. So the capability arrives in the only form that keeps the old
 * guarantee intact:
 *
 *   THE ASSISTANT PREPARES A SEND. IT CANNOT PERFORM ONE.
 *
 * This module reads. It calls no write, holds no Telnyx client, and touches
 * no delivery path. What it returns is a QUESTION for the operator, carrying
 * the true numbers, which the app puts behind Face ID. The bytes that actually
 * reach a phone still leave through POST /api/campaigns/:id/approve and
 * /schedule, unchanged, with their own permissions, their own consent audit
 * and their own two-phase commit.
 *
 * So the property is no longer "the function does not exist". It is:
 *
 *   every path from this assistant to a customer passes through a human
 *   being's face, and through routes this module cannot call.
 *
 * That is weaker than absence and stronger than a confirmation dialog, which
 * is one mis-tap from a send. test/assistant-send-request.test.js holds the
 * line by asserting this file performs no write and names no transport.
 *
 * IT REPORTS THE BAD NEWS FIRST
 *
 * The confirmation carries suppressed counts and their reasons, not just the
 * eligible number. A person approving a send to 41 of 900 people needs to see
 * the 859 and why, because that gap is usually a bug in the audience rather
 * than a fact about the customers. An optimistic confirmation screen is how
 * somebody sends to the wrong list twice.
 */

/** Statuses from which a send may legitimately be requested. */
const REQUESTABLE = new Set(['draft', 'in_review', 'awaiting_approval', 'approved']);

/**
 * Both halves of sending are separate permissions, and a person can hold one.
 * Asking somebody to confirm a thing their role will refuse to finish is a
 * worse experience than being told plainly up front, so both are checked here
 * rather than one being discovered at the moment of the Face ID prompt.
 */
const REQUIRED_TO_FINISH = ['campaigns.approve', 'campaigns.launch'];

function heldPermissions(actor) {
  if (actor?.permissions instanceof Set) return actor.permissions;
  return new Set(Array.isArray(actor?.permissions) ? actor.permissions : []);
}

/**
 * Suppression reasons, ordered by how many people each removed, so the top of
 * the list is the one worth reading. Reason keys are the eligibility module's
 * own vocabulary and are passed through untranslated: a paraphrase here would
 * be a second, looser account of why somebody was not messaged.
 */
function rankedReasons(reasons = {}) {
  return Object.entries(reasons)
    .filter(([reason]) => reason && reason !== 'eligible')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Build the confirmation the operator will be shown.
 *
 * @param {object}   options
 * @param {string}   options.campaignId
 * @param {object}   options.campaigns  the campaign service (read + dryRun only)
 * @param {object}   options.actor
 * @returns {Promise<object>} `{ ok: true, confirmSend }` or a refusal
 */
async function buildSendConfirmation({ campaignId, campaigns, actor }) {
  const id = String(campaignId || '').trim();
  if (!id) return { ok: false, reason: 'campaign_id_required' };

  const held = heldPermissions(actor);
  const missing = REQUIRED_TO_FINISH.filter(permission => !held.has(permission));
  if (missing.length) {
    return {
      ok: false,
      reason: 'cannot_finish_send',
      detail: 'This account can prepare a send but not complete one.',
      missingPermissions: missing
    };
  }

  const campaign = await campaigns.read(id);
  if (!campaign) return { ok: false, reason: 'campaign_not_found' };

  const status = String(campaign.status || '').toLowerCase();
  if (status === 'sent' || status === 'sending') {
    // Not an error worth dressing up. The second send is the one that gets
    // somebody unsubscribed, and it is an easy thing to ask for twice by voice.
    return { ok: false, reason: 'already_sent', detail: `That campaign is ${status}.` };
  }
  if (status === 'scheduled') {
    return {
      ok: false,
      reason: 'already_scheduled',
      detail: 'That campaign already has a time to go out.',
      scheduledFor: campaign.scheduled_for || null
    };
  }
  if (!REQUESTABLE.has(status)) {
    return { ok: false, reason: 'not_sendable', detail: `A ${status || 'unknown'} campaign cannot be sent.` };
  }

  // The same evaluation the send itself will perform: consent, do-not-contact,
  // opt-out sentinels, DND freshness, cadence. Running it now means the number
  // on the confirmation is the number that will actually be messaged, not an
  // audience size that shrinks silently after the person has already agreed.
  const dry = await campaigns.dryRun(id);
  const eligible = Number(dry?.eligible) || 0;
  const suppressed = Number(dry?.suppressed) || 0;

  if (eligible === 0) {
    return {
      ok: false,
      reason: 'nobody_eligible',
      detail: 'Nobody in that audience can be messaged right now.',
      suppressed,
      topReasons: rankedReasons(dry?.reasons)
    };
  }

  return {
    ok: true,
    confirmSend: {
      campaignId: campaign.id,
      // The revision the operator is agreeing to. The approve route rejects a
      // stale one, so if the copy is edited between the question and the Face
      // ID, the send fails closed instead of sending text nobody confirmed.
      revision: campaign.revision ?? dry?.revision ?? null,
      name: campaign.name || null,
      message: campaign.message || campaign.body || null,
      audience: campaign.segment_name || campaign.audience_name || null,
      recipients: eligible,
      suppressed,
      topReasons: rankedReasons(dry?.reasons),
      // Whether the master brake is off. Shown rather than hidden: an operator
      // who confirms a send and sees nothing happen should have been told why
      // before their face was scanned, not after.
      liveSendEnabled: dry?.liveEligibility?.enabled === true,
      requiresBiometricConfirmation: true
    }
  };
}

module.exports = { buildSendConfirmation, rankedReasons, REQUESTABLE, REQUIRED_TO_FINISH };
