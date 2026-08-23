'use strict';
/**
 * lib/campaigns/delivery-worker.js — the only thing in this codebase that can
 * send a campaign message.
 *
 * WHAT THIS FILE DOES NOT DECIDE
 *   Almost everything. Eligibility, quiet hours, promotional spacing, the 7-
 *   and 30-day frequency caps, opt-out, DND freshness, positive-consent
 *   evidence, the campaign being approved and scheduled, and both safety flags
 *   are all enforced inside claim_sms_campaign_recipients and
 *   begin_sms_campaign_provider_attempt, in SQL, under row locks. A bug in this
 *   file cannot send to someone the database would refuse, because this file
 *   never asks "may I" — it asks the database for work and is handed only work
 *   that is already lawful.
 *
 *   The env flag check below is therefore redundant, and deliberately so. It
 *   stops the loop before it opens a connection, and it means someone reading
 *   this file can see the brake without reading 600 lines of PL/pgSQL.
 *
 * THE ONE RULE THAT MATTERS: NEVER RETRY AN UNCERTAIN SEND
 *   Three outcomes follow a provider call, and only two are knowable:
 *
 *     accepted   → record it, the recipient moves to `sent`
 *     refused    → the provider rejected it before submission
 *     unknown    → the request timed out, the process died, the network broke
 *
 *   For `unknown` this worker does nothing at all. It does not retry, does not
 *   mark failed, does not guess. The lease expires, and
 *   release_expired_sms_campaign_claims moves the row to
 *   `reconciliation_required`, where a person decides. A duplicate marketing
 *   text is worse than a late one, and a wrongly-failed row is worse than an
 *   unresolved one.
 *
 *   Note the asymmetry in recoverExpiredClaims: a row stuck in `claimed` never
 *   reached the provider, so it safely returns to `pending`. Only `sending` is
 *   ambiguous. That distinction is the whole reason begin() and send() are two
 *   separate steps.
 *
 * IDEMPOTENCY
 *   The key is derived from the recipient id by the database, not generated
 *   here, and a partial unique index on (workspace_id, provider_idempotency_key)
 *   makes a second acceptance for one recipient impossible to record.
 */

const DEFAULT_WORKSPACE = 'vici';

/** A conservative batch. The claim RPC itself refuses anything above 100. */
const DEFAULT_BATCH = 25;

/** Seconds. begin_sms_campaign_provider_attempt refuses anything above 300. */
const DEFAULT_LEASE = 120;

/**
 * The master brake, read as a string comparison so that an unset variable, an
 * empty string, "1", "yes" and "TRUE" are all off. Only the exact string
 * "true" enables sending.
 */
function liveSendEnabled(env = process.env) {
  return env.CAMPAIGNS_LIVE_SEND_ENABLED === 'true';
}

/**
 * Return `claimed` rows nobody is working on to `pending`, and move abandoned
 * `sending` rows to `reconciliation_required`.
 *
 * Safe to call whether or not sending is enabled: it resolves rows that a
 * previous run left behind, and turning the feature off should not strand them.
 */
async function recoverExpiredClaims({ client, workspace = DEFAULT_WORKSPACE }) {
  const { data, error } = await client.rpc('release_expired_sms_campaign_claims', {
    p_workspace_id: workspace
  });
  if (error) {
    throw Object.assign(new Error(error.message), { code: 'CAMPAIGN_CLAIM_RECOVERY_FAILED' });
  }
  return Number(data) || 0;
}

/** PostgREST surfaces a PL/pgSQL RAISE as a message; these are expected, not faults. */
const EXPECTED_FENCE_ERRORS = new Set([
  'campaign_claim_fence_failed',
  'campaign_recipient_no_longer_eligible',
  'campaign_live_send_disabled',
  'campaign_claim_reservation_missing',
  'campaign_recipient_not_found'
]);

function fenceReason(error) {
  const message = String(error?.message || '');
  for (const known of EXPECTED_FENCE_ERRORS) {
    if (message.includes(known)) return known;
  }
  return null;
}

/**
 * Claim a batch and attempt each one.
 *
 * @param {object}   options
 * @param {object}   options.client      Supabase service-role client.
 * @param {Function} options.send        (phone, text) => Promise<{ messageId }>.
 * @param {object}   [options.env]       Injected for tests.
 * @param {Function} [options.now]       Injected for tests.
 * @returns {Promise<object>} a counted summary; never throws for one bad recipient.
 */
async function deliverBatch({
  client,
  send,
  workspace = DEFAULT_WORKSPACE,
  limit = DEFAULT_BATCH,
  leaseSeconds = DEFAULT_LEASE,
  env = process.env,
  now = () => new Date(),
  log = console
} = {}) {
  const summary = {
    enabled: false, recovered: 0, claimed: 0, accepted: 0,
    refused: 0, uncertain: 0, skipped: 0, reasons: {}
  };

  if (!liveSendEnabled(env)) {
    summary.reason = 'live_send_disabled';
    return summary;
  }
  summary.enabled = true;

  summary.recovered = await recoverExpiredClaims({ client, workspace });

  const claim = await client.rpc('claim_sms_campaign_recipients', {
    p_workspace_id: workspace,
    p_limit: limit,
    p_lease_seconds: leaseSeconds
  });
  if (claim.error) {
    throw Object.assign(new Error(claim.error.message), { code: 'CAMPAIGN_CLAIM_FAILED' });
  }

  const recipients = Array.isArray(claim.data) ? claim.data : [];
  summary.claimed = recipients.length;

  for (const recipient of recipients) {
    const note = (reason) => {
      summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
    };

    // Never invent a message. rendered_message is frozen at approval time, so
    // an empty one means the snapshot is wrong and a person should look.
    const text = String(recipient.rendered_message || '').trim();
    if (!text) {
      summary.skipped += 1;
      note('rendered_message_empty');
      log.error(`[CAMPAIGN SEND] Recipient ${recipient.id} has no frozen message; leaving it alone.`);
      continue;
    }

    // 1. Take the row from `claimed` to `sending` behind the final SQL checks.
    let attempt;
    try {
      const begun = await client.rpc('begin_sms_campaign_provider_attempt', {
        p_recipient_id: recipient.id,
        p_workspace_id: workspace,
        p_claim_token: recipient.claim_token,
        p_lease_seconds: leaseSeconds
      });
      if (begun.error) throw new Error(begun.error.message);
      attempt = Array.isArray(begun.data) ? begun.data[0] : begun.data;
      if (!attempt) throw new Error('campaign_recipient_not_found');
    } catch (error) {
      const reason = fenceReason(error);
      summary.skipped += 1;
      note(reason || 'begin_attempt_failed');
      // A fence failure is the system working: something changed between the
      // claim and now — a STOP arrived, consent went stale, the campaign was
      // cancelled. Not an error worth alarming on.
      if (!reason) {
        log.error(`[CAMPAIGN SEND] Could not begin attempt for ${recipient.id}:`, error.message);
      }
      continue;
    }

    // 2. The provider call. Everything after this point is about honesty.
    let providerMessageId;
    try {
      const result = await send(recipient.contact_phone, text);
      providerMessageId = result?.messageId;
      if (!providerMessageId) throw new Error('provider returned no message id');
    } catch (error) {
      // Deliberately no retry and no state change. See the header.
      summary.uncertain += 1;
      note('provider_call_uncertain');
      log.error(
        `[CAMPAIGN SEND] Provider call for recipient ${recipient.id} did not confirm; `
        + 'leaving it for reconciliation rather than retrying:', error.message
      );
      continue;
    }

    // 3. Record acceptance. If this fails the message is already gone, so the
    //    row must still not be retried — the lease will expire into
    //    reconciliation_required, which is the correct description of reality.
    const accepted = await client.rpc('record_sms_campaign_provider_acceptance', {
      p_recipient_id: recipient.id,
      p_workspace_id: workspace,
      p_claim_token: recipient.claim_token,
      p_provider_idempotency_key: attempt.provider_idempotency_key,
      p_provider_message_id: providerMessageId,
      p_accepted_at: now().toISOString()
    });
    if (accepted.error) {
      summary.uncertain += 1;
      note('acceptance_not_recorded');
      log.error(
        `[CAMPAIGN SEND] Message ${providerMessageId} was accepted by the provider but could `
        + `not be recorded against recipient ${recipient.id}:`, accepted.error.message
      );
      continue;
    }

    summary.accepted += 1;
  }

  return summary;
}

module.exports = {
  DEFAULT_BATCH,
  DEFAULT_LEASE,
  DEFAULT_WORKSPACE,
  deliverBatch,
  liveSendEnabled,
  recoverExpiredClaims
};
