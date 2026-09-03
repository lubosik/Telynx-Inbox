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

/**
 * How fast a campaign is allowed to go out, and who decides.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SETTING AND NOT A CONSTANT
 *
 *   The pace was 25 every two minutes, hardcoded in server.js, and the owner
 *   asked for the choice: "are we doing 25 every two minutes, are we doing 10
 *   every five minutes". It is his shop, his carrier reputation and his
 *   customers, and the right number depends on things this code cannot see —
 *   how many people are on shift to answer replies, how a carrier has been
 *   treating the number lately, whether an offer is worth a slow drip or a
 *   single push.
 *
 *   Read from the campaign settings row, so it can be changed without a
 *   deploy, and clamped: a batch above 100 is refused by the claim RPC itself,
 *   and an interval under 30 seconds spends more time in round trips than in
 *   sending.
 */
const SEND_PACE = Object.freeze({
  minBatch: 1,
  maxBatch: 100,
  minIntervalSeconds: 30,
  maxIntervalSeconds: 60 * 60,
  defaultBatch: 25,
  defaultIntervalSeconds: 120
});

/**
 * The pace for this workspace: how many per batch and how long between them.
 *
 * Falls back to the default on anything unusable rather than refusing to send.
 * A settings row somebody typed a zero into must not stop a campaign; it must
 * send at the pace that has always worked.
 */
function sendPaceFrom(settings = null) {
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max
      ? Math.floor(number)
      : fallback;
  };
  return {
    batchSize: clamp(settings?.send_batch_size,
      SEND_PACE.minBatch, SEND_PACE.maxBatch, SEND_PACE.defaultBatch),
    intervalSeconds: clamp(settings?.send_interval_seconds,
      SEND_PACE.minIntervalSeconds, SEND_PACE.maxIntervalSeconds, SEND_PACE.defaultIntervalSeconds)
  };
}

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

    // 4. Put it in the inbox.
    //
    // ── WHY THIS IS NOT OPTIONAL ─────────────────────────────────────────
    //
    // Campaign messages went out through the provider and were never written
    // to sms_messages, so the inbox showed the REPLIES and not the messages
    // that caused them. Somebody answering "stop" appeared as a person texting
    // the business out of nowhere. Half a conversation is worse than none,
    // because it reads as a complete one.
    //
    // campaign_id and campaign_recipient_id have been on this table all along.
    // Nothing ever filled them in: 0 rows carried a campaign id.
    //
    // ── WHY A FAILURE HERE IS SWALLOWED ──────────────────────────────────
    //
    // The message is already gone. Its acceptance is already recorded against
    // the recipient, which is the row that decides whether anybody gets texted
    // twice. This write only affects what a person SEES. Throwing would
    // abandon the rest of the batch and change nothing about what was sent, so
    // it is logged loudly and the loop continues.
    try {
      const sentAt = now().toISOString();
      const { error: inboxError } = await client.from('sms_messages').insert({
        telnyx_message_id: providerMessageId,
        contact_phone: recipient.contact_phone,
        direction: 'outbound',
        body: text,
        status: 'sent',
        created_at: sentAt,
        campaign_id: recipient.campaign_id,
        campaign_recipient_id: recipient.id
      });
      if (inboxError) throw new Error(inboxError.message);

      // Sorts the thread to the top of the inbox, the same as every other
      // outbound message does. Without it a campaign the owner just sent sits
      // wherever the contact last happened to talk to them.
      await client.from('sms_contacts')
        .update({ last_seen: sentAt })
        .eq('phone', recipient.contact_phone);
    } catch (error) {
      summary.reasons.inbox_write_failed = (summary.reasons.inbox_write_failed || 0) + 1;
      log.error(
        `[CAMPAIGN SEND] Message ${providerMessageId} was sent and recorded, but did not reach `
        + `the inbox for ${recipient.contact_phone}. The reply will look unprompted:`, error.message
      );
    }
  }

  return summary;
}

/**
 * Move a campaign's status to match what has actually happened to its
 * recipients.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   `sending` and `completed` have been legal statuses since the first
 *   migration, and nothing ever set either one. A campaign was marked
 *   `scheduled` at approval and stayed `scheduled` forever — through the send,
 *   after the last message, indefinitely.
 *
 *   The owner watched 412 messages go out and replies arrive while the app
 *   showed four campaigns still waiting to start. He had to ask whether they
 *   had sent, because the only honest answer available to him was a guess.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE
 *
 *   The recipients are the truth and the status is a summary of them, derived
 *   every cycle rather than written once and trusted. A status set at the
 *   moment of an action is a claim about the future; this one is a report
 *   about the past.
 *
 *     nothing sent yet, work outstanding   → scheduled   (it has not begun)
 *     something sent, work outstanding     → sending     (it is live now)
 *     no work outstanding                  → completed   (it is finished)
 *
 *   `outstanding` counts only pending and claimed: the states a message can
 *   still leave on its own. A row awaiting reconciliation needs a person, and
 *   holding the whole campaign at `sending` for one ambiguous row would
 *   misdescribe 375 delivered messages. The count is surfaced separately
 *   instead, where it can be acted on.
 *
 *   A campaign with no recipients at all is left alone. That is a different
 *   problem from a finished one and should not be dressed up as success.
 */
async function reconcileCampaignStatuses({
  client,
  workspace = DEFAULT_WORKSPACE,
  now = () => new Date(),
  log = console
} = {}) {
  const changed = { sending: 0, completed: 0 };

  const { data: campaigns, error } = await client
    .from('sms_campaigns')
    .select('id,status')
    .eq('workspace_id', workspace)
    .in('status', ['scheduled', 'sending']);
  if (error) throw Object.assign(new Error(error.message), { code: 'CAMPAIGN_STATUS_READ_FAILED' });
  if (!campaigns?.length) return changed;

  for (const campaign of campaigns) {
    const { data: rows, error: rowsError } = await client
      .from('sms_campaign_recipients')
      .select('state')
      .eq('campaign_id', campaign.id);
    if (rowsError) {
      log.error(`[CAMPAIGN STATUS] Could not read recipients for ${campaign.id}:`, rowsError.message);
      continue;
    }
    if (!rows?.length) continue;

    const outstanding = rows.filter(r => r.state === 'pending' || r.state === 'claimed').length;
    const delivered = rows.filter(r => r.state === 'sent' || r.state === 'delivered').length;

    let next = null;
    if (outstanding === 0) next = 'completed';
    else if (delivered > 0) next = 'sending';
    if (!next || next === campaign.status) continue;

    const stamp = now().toISOString();
    const patch = { status: next, updated_at: stamp };
    // completed_at is what the app shows as "finished at" and what analytics
    // measures a send window against, so it is set once, when it becomes true.
    if (next === 'completed') patch.completed_at = stamp;

    const { error: writeError } = await client
      .from('sms_campaigns')
      .update(patch)
      .eq('id', campaign.id)
      .eq('workspace_id', workspace)
      .eq('status', campaign.status);   // no clobbering a concurrent change
    if (writeError) {
      log.error(`[CAMPAIGN STATUS] Could not move ${campaign.id} to ${next}:`, writeError.message);
      continue;
    }
    changed[next] += 1;
    log.log?.(`[CAMPAIGN STATUS] ${campaign.id}: ${campaign.status} -> ${next}`);
  }

  return changed;
}

module.exports = {
  DEFAULT_BATCH,
  SEND_PACE,
  sendPaceFrom,
  DEFAULT_LEASE,
  DEFAULT_WORKSPACE,
  deliverBatch,
  liveSendEnabled,
  recoverExpiredClaims,
  reconcileCampaignStatuses
};
