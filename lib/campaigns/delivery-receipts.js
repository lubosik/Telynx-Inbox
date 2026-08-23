'use strict';
/**
 * lib/campaigns/delivery-receipts.js — turn a Telnyx delivery receipt into a
 * campaign recipient outcome.
 *
 * WHY THIS IS NOT INSIDE routes/webhook.js
 *   That handler serves every message the business sends, almost none of which
 *   belong to a campaign. This must be a no-op for an ordinary order
 *   confirmation, must never delay the existing status update, and must never
 *   fail the webhook. Keeping it separate makes all three testable.
 *
 * TRUST
 *   `record_sms_campaign_provider_result` stores a trust source, and campaign
 *   revenue attribution only counts evidence marked `telnyx_ed25519_v2`. An
 *   unsigned or badly-signed webhook still updates the recipient's visible
 *   status — a person should see that a message failed — but it is recorded
 *   untrusted, so it can never become a revenue claim.
 *
 * WHAT THIS DEPENDS ON
 *   `provider_message_id` on the recipient row is the ONLY thing that connects
 *   a Telnyx receipt back to a campaign, and it is written by exactly one
 *   place: record_sms_campaign_provider_acceptance. While that RPC still
 *   re-ran the eligibility check after the send and refused on any change, a
 *   genuinely sent message could end up with no message id at all, and every
 *   receipt for it returned `not_a_campaign_message` — no delivery evidence and
 *   no attribution, forever. scripts/campaign-delivery-fixes-migration.sql
 *   makes that recording unconditional. If a future change reintroduces a
 *   post-send veto there, it silently breaks this file too.
 */

const DEFAULT_WORKSPACE = 'vici';

/** The only trust source campaign attribution will accept as evidence. */
const TRUSTED_SOURCE = 'telnyx_ed25519_v2';

/**
 * The RPC accepts terminal outcomes only. `sent` and `queued` are progress, not
 * results, and the acceptance record already covers them.
 */
function terminalResult(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'delivered') return 'delivered';
  if (value === 'failed' || value === 'undelivered' || value === 'delivery_failed') return 'failed';
  return null;
}

/** Fences that mean "not ours" or "already recorded" — normal, not faults. */
const EXPECTED = [
  'campaign_recipient_not_found',
  'campaign_provider_result_fence_failed',
  'campaign_provider_result_time_invalid',
  'campaign_provider_result_invalid'
];

/**
 * @returns {Promise<{recorded: boolean, reason?: string}>} never throws.
 */
async function recordCampaignDeliveryResult({
  client,
  providerMessageId,
  status,
  occurredAt,
  errorCode = null,
  eventId = null,
  signatureValid = false,
  workspace = DEFAULT_WORKSPACE,
  log = console
} = {}) {
  const result = terminalResult(status);
  if (!result) return { recorded: false, reason: 'not_terminal' };
  if (!providerMessageId) return { recorded: false, reason: 'no_message_id' };

  try {
    // Cheap ownership check first. The overwhelming majority of delivery
    // receipts are not campaign messages, and this avoids calling a
    // service-role RPC once per ordinary order confirmation.
    const { data: owned, error: lookupError } = await client
      .from('sms_campaign_recipients')
      .select('id')
      .eq('workspace_id', workspace)
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();

    if (lookupError) {
      log.warn('[CAMPAIGN DLR] Could not check message ownership:', lookupError.code || 'read_error');
      return { recorded: false, reason: 'lookup_failed' };
    }
    if (!owned) return { recorded: false, reason: 'not_a_campaign_message' };

    const { error } = await client.rpc('record_sms_campaign_provider_result', {
      p_recipient_id: owned.id,
      p_workspace_id: workspace,
      p_provider_message_id: providerMessageId,
      p_provider_event_id: eventId,
      p_result: result,
      p_occurred_at: (occurredAt instanceof Date ? occurredAt : new Date(occurredAt || Date.now())).toISOString(),
      p_error_code: errorCode,
      p_trust_source: signatureValid ? TRUSTED_SOURCE : null
    });

    if (error) {
      const message = String(error.message || '');
      const expected = EXPECTED.find(known => message.includes(known));
      if (expected) return { recorded: false, reason: expected };
      log.warn('[CAMPAIGN DLR] Result not recorded:', error.code || 'write_error');
      return { recorded: false, reason: 'write_failed' };
    }

    return { recorded: true, result, trusted: signatureValid };
  } catch (error) {
    // A delivery receipt must never fail the webhook for the rest of the app.
    log.warn('[CAMPAIGN DLR] Unexpected failure:', error?.code || error?.message || 'unknown');
    return { recorded: false, reason: 'unexpected_error' };
  }
}

module.exports = { TRUSTED_SOURCE, recordCampaignDeliveryResult, terminalResult };
