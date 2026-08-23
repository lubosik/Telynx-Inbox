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
 *   `refused` is a real outcome, not a synonym for `unknown`. telnyx.js
 *   distinguishes an HTTP 4xx with a parsed Telnyx error body — the provider
 *   rejecting the request before submission, so nothing reached a carrier —
 *   from a timeout, an abort, a 5xx or a broken socket. Only the first is
 *   refused. Without that split, one bad phone number in an audience of 900
 *   became a line in a human reconciliation queue.
 *
 * IDEMPOTENCY
 *   The key is derived from the recipient id by the database, not generated
 *   here, and a partial unique index on (workspace_id, provider_idempotency_key)
 *   makes a second acceptance for one recipient impossible to record.
 *
 * RECORDING IS UNCONDITIONAL
 *   record_sms_campaign_provider_acceptance used to re-run the whole
 *   eligibility check AFTER the send and refuse to record if anything had
 *   changed. Refusing to record cannot un-send; all it did was delete the
 *   evidence, and a message with no ledger row counts against no frequency cap
 *   and can never be matched to its delivery receipt. See
 *   scripts/campaign-delivery-fixes-migration.sql. This worker relies on that:
 *   an acceptance RPC that errors now means a transport failure, not a verdict.
 */

const DEFAULT_WORKSPACE = 'vici';

/**
 * Seconds. begin_sms_campaign_provider_attempt refuses anything above 300, and
 * claim_sms_campaign_recipients refuses anything above 900, so 300 is the
 * ceiling the worker can actually use for both.
 */
const DEFAULT_LEASE = 300;

/**
 * Seconds. Mirrors PROVIDER_TIMEOUT_MS in telnyx.js. Duplicated as a number
 * rather than imported so this file still has no dependency on the provider
 * client — the worker is handed a `send` function and never builds one.
 */
const PROVIDER_TIMEOUT_SECONDS = 20;

/**
 * Fraction of the lease reserved for provider calls. The rest pays for the two
 * or three PostgREST round trips each recipient costs.
 */
const LEASE_PROVIDER_SHARE = 0.8;

/**
 * The largest batch whose slowest possible tail still finishes inside the lease.
 *
 * This is the whole reason the batch shrank from 25. claim_sms_campaign_recipients
 * stamps ONE claim_expires_at across the entire batch at claim time, and the
 * worker then sends sequentially. At 25 recipients on a 120-second lease,
 * anything past ~4.8 seconds of average provider latency pushed the tail of
 * every batch past its own lease, and begin_sms_campaign_provider_attempt
 * fenced it out as `campaign_claim_fence_failed` — the same error a STOP
 * produces, logged deliberately silently. Throughput collapsed without a word.
 *
 * heartbeat_sms_campaign_provider_attempt cannot fix this. It requires
 * state = 'sending', and the fenced rows are still in `claimed`: they have not
 * reached begin_ yet, so there is nothing to heartbeat. The only real fixes are
 * a shorter batch or a longer lease, and this takes both.
 *
 * At the defaults: 10 x 20s = 200s of worst-case provider time inside a
 * 300-second lease, leaving 100s for round trips. The tail cannot time out.
 */
function maxBatchForLease(leaseSeconds) {
  return Math.max(1, Math.floor((leaseSeconds * LEASE_PROVIDER_SHARE) / PROVIDER_TIMEOUT_SECONDS));
}

/** A conservative batch. The claim RPC itself refuses anything above 100. */
const DEFAULT_BATCH = 10;

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
 * The contract telnyx.js advertises on a thrown send error: the provider
 * rejected the request outright and nothing reached a carrier.
 *
 * Read as a property rather than by importing telnyx.js, because `send` is
 * injected and this worker must stay usable with any provider client — and
 * because a missing property must fail towards `uncertain`, never towards
 * `refused`. An abort, a timeout, a 5xx and a socket error all land here as
 * null, which is the point.
 *
 * @returns {string|null} the provider error code, or null if not a refusal.
 */
function providerRefusalCode(error) {
  if (error?.providerRefused !== true) return null;
  const code = String(error.providerErrorCode || '').trim();
  return code || 'provider_refused';
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

  // Never ask for more work than the lease can pay for. A batch whose tail
  // cannot finish inside its own claim is not throughput, it is a silent
  // fence-out queue. See maxBatchForLease.
  const safeLimit = Math.min(limit, maxBatchForLease(leaseSeconds));
  summary.limit = safeLimit;
  if (safeLimit < limit) {
    log.warn(
      `[CAMPAIGN SEND] Batch of ${limit} does not fit a ${leaseSeconds}s lease; `
      + `claiming ${safeLimit} instead.`
    );
  }

  const claim = await client.rpc('claim_sms_campaign_recipients', {
    p_workspace_id: workspace,
    p_limit: safeLimit,
    p_lease_seconds: leaseSeconds
  });
  if (claim.error) {
    throw Object.assign(new Error(claim.error.message), { code: 'CAMPAIGN_CLAIM_FAILED' });
  }

  // The database stamped one claim_expires_at across the whole batch just
  // before this returned, so this is the deadline every row in it shares.
  // Reading it after the RPC keeps the estimate on the late side, which makes
  // the "lease expired" diagnosis below conservative rather than eager.
  const claimedAt = now().getTime();
  const claimDeadline = claimedAt + leaseSeconds * 1000;

  const recipients = Array.isArray(claim.data) ? claim.data : [];
  summary.claimed = recipients.length;

  let position = 0;
  for (const recipient of recipients) {
    position += 1;
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

      // A fence failure has two completely different causes and used to be
      // logged as neither. Either something changed between the claim and now
      // — a STOP arrived, consent went stale, the campaign was cancelled, which
      // is the system working — or this batch simply ran out of lease before it
      // reached this row, which is a throughput fault that silently ate the
      // tail of every batch. Tell them apart, and say which.
      const fencedAt = now().getTime();
      const elapsedMs = fencedAt - claimedAt;
      const leaseExpired = reason === 'campaign_claim_fence_failed' && fencedAt >= claimDeadline;

      if (leaseExpired) {
        note('campaign_claim_fence_failed_lease_expired');
        log.warn(
          `[CAMPAIGN SEND] Recipient ${recipient.id} (${position}/${recipients.length}) was `
          + `fenced out after ${elapsedMs}ms, past its ${leaseSeconds}s claim lease. This is `
          + 'the batch being too slow, not the recipient becoming ineligible; reduce the batch '
          + 'or raise the lease.'
        );
      } else if (reason) {
        note(reason);
      } else {
        note('begin_attempt_failed');
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
      const refusalCode = providerRefusalCode(error);

      // 2a. A refusal is knowable: the provider rejected the request before
      //     submission, so nothing is on the wire. Marking it failed is honest
      //     and keeps ordinary bad numbers out of the human queue. There is
      //     still no retry — a refused message is finished, not deferred.
      if (refusalCode) {
        summary.refused += 1;
        note('provider_refused');
        const marked = await client.rpc('record_sms_campaign_provider_refusal', {
          p_recipient_id: recipient.id,
          p_workspace_id: workspace,
          p_claim_token: recipient.claim_token,
          p_provider_idempotency_key: attempt.provider_idempotency_key,
          p_error_code: refusalCode,
          p_refused_at: now().toISOString()
        });
        if (marked.error) {
          // Nothing was sent, so this is only a bookkeeping loss. The row will
          // reach reconciliation_required, which overstates the doubt but never
          // duplicates a message.
          note('refusal_not_recorded');
          log.error(
            `[CAMPAIGN SEND] Provider refused recipient ${recipient.id} (${refusalCode}) but the `
            + 'refusal could not be recorded:', marked.error.message
          );
        }
        continue;
      }

      // 2b. Everything else is unknown. Deliberately no retry and no state
      //     change. See the header.
      summary.uncertain += 1;
      note('provider_call_uncertain');
      log.error(
        `[CAMPAIGN SEND] Provider call for recipient ${recipient.id} did not confirm; `
        + 'leaving it for reconciliation rather than retrying:', error.message
      );
      continue;
    }

    // 3. Record acceptance. Since scripts/campaign-delivery-fixes-migration.sql
    //    this RPC records unconditionally: it cannot refuse a send that already
    //    happened, so an error here is a transport failure and nothing else.
    //    The message is already gone, so the row must still not be retried. The
    //    lease expires into reconciliation_required, and the ledger row keeps
    //    counting against the frequency caps the whole time it sits there,
    //    which is what stops a lost acceptance from becoming a cap breach.
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
  PROVIDER_TIMEOUT_SECONDS,
  deliverBatch,
  liveSendEnabled,
  maxBatchForLease,
  providerRefusalCode,
  recoverExpiredClaims
};
