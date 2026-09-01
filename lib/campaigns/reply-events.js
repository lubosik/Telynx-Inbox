'use strict';
/**
 * lib/campaigns/reply-events.js — connect an inbound message back to the
 * campaign that provoked it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   Campaign analytics reported `replies: 0` and `optOuts: 0` for a send where
 *   ten people had texted STOP and others had replied. The numbers were not
 *   approximately wrong, they were categorically wrong, and they were the
 *   numbers somebody would use to decide whether to run the campaign again.
 *
 *   Nothing was broken in the analytics. It reads sms_campaign_recipient_events
 *   for `customer.replied` and `recipient.opted_out`, and only the provider
 *   ever wrote to that table: 831 rows, every one of them provider.accepted,
 *   provider.delivered or provider.failed. The inbound webhook handled a reply
 *   for the inbox and for suppression and then dropped it, so a campaign could
 *   never learn that anybody had answered.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH CAMPAIGN A REPLY BELONGS TO
 *
 *   The most recent message actually sent to that number, and only if it was
 *   sent within the attribution window. A reply is evidence about the message
 *   that prompted it; attaching one to a campaign from six weeks ago would
 *   invent a response rate rather than measure one.
 *
 *   No guessing beyond that. A reply from somebody who is not a recipient of
 *   any recent campaign is recorded nowhere, which is correct: it is a
 *   conversation, not a campaign metric.
 */

const DEFAULT_WORKSPACE = 'vici';

/**
 * How long after a message a reply can still be attributed to it.
 *
 * Seven days. Long enough for somebody who reads a text on Monday and replies
 * at the weekend, short enough that a reply to a conversation months later is
 * not silently counted as a campaign response.
 */
const ATTRIBUTION_WINDOW_DAYS = 7;

/**
 * What counts as opting out.
 *
 * Deliberately the same shapes the carrier and the inbound webhook already
 * treat as STOP, and nothing looser: this decides a compliance number, and
 * "stop sending me so many of these" is a complaint, not a keyword.
 */
const OPT_OUT_PATTERN = /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|remove me|opt out|optout)\s*[.!]?\s*$/i;

function looksLikeOptOut(body) {
  return OPT_OUT_PATTERN.test(String(body || ''));
}

/**
 * Record that a recipient replied, and that they opted out if they did.
 *
 * Best effort by design and never thrown from. The reply has already been
 * stored in the inbox and the opt-out has already been honoured by the
 * suppression sentinel; this only decides what a chart says. Failing the
 * webhook over it would risk the provider retrying a message whose real work
 * is done.
 *
 * Returns what it wrote, so a caller can log it and a test can assert it.
 */
async function recordCampaignReplyEvents({
  client,
  phone,
  body,
  occurredAt = new Date().toISOString(),
  workspace = DEFAULT_WORKSPACE,
  windowDays = ATTRIBUTION_WINDOW_DAYS,
  log = console
} = {}) {
  const result = { matched: false, replied: false, optedOut: false };
  if (!client || !phone) return result;

  try {
    const since = new Date(Date.parse(occurredAt) - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // The most recent message actually sent to this number. sent_at is set
    // only once the provider accepted it, so a queued or suppressed row can
    // never claim a reply it did not cause.
    const { data: rows, error } = await client
      .from('sms_campaign_recipients')
      .select('id,campaign_id,sent_at')
      .eq('workspace_id', workspace)
      .eq('contact_phone', phone)
      .not('sent_at', 'is', null)
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const recipient = (rows || [])[0];
    if (!recipient) return result;          // not a recent campaign recipient
    result.matched = true;

    const events = [{
      recipient_id: recipient.id,
      campaign_id: recipient.campaign_id,
      workspace_id: workspace,
      event_type: 'customer.replied',
      occurred_at: occurredAt,
      trusted: true,
      // Not a provider webhook: this is our own inbound record, which
      // eventTrusted() accepts for non-provider events.
      trust_source: 'inbound_message',
      metadata: { trusted: true },
      // One reply per recipient per second. A duplicate webhook delivery must
      // not become a second reply in the numbers.
      dedupe_key: `reply:${recipient.id}:${String(occurredAt).slice(0, 19)}`
    }];

    if (looksLikeOptOut(body)) {
      events.push({
        recipient_id: recipient.id,
        campaign_id: recipient.campaign_id,
        workspace_id: workspace,
        event_type: 'recipient.opted_out',
        occurred_at: occurredAt,
        trusted: true,
        trust_source: 'inbound_message',
        reason_code: 'stop_keyword',
        metadata: { trusted: true },
        // One opt-out per recipient, ever. Somebody texting STOP three times
        // is one person leaving, and counting three would overstate the cost
        // of the campaign.
        dedupe_key: `optout:${recipient.id}`
      });
    }

    const { error: writeError } = await client
      .from('sms_campaign_recipient_events')
      .upsert(events, { onConflict: 'dedupe_key', ignoreDuplicates: true });
    if (writeError) throw new Error(writeError.message);

    result.replied = true;
    result.optedOut = events.length > 1;
    return result;
  } catch (error) {
    log.error?.(
      `[CAMPAIGN REPLY] Could not attribute an inbound message from ${phone} to a campaign. `
      + 'The reply is still in the inbox and any opt-out is still honoured; only the '
      + 'campaign numbers are affected:', error.message
    );
    return result;
  }
}

/**
 * Attribute any inbound message the webhook did not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SWEEP EXISTS AT ALL
 *
 *   The webhook is the fast path and it is not a guarantee. It answers Telnyx
 *   with 200 before it does this work, so nothing retries a miss: a restart
 *   mid-request, a database blip, a deploy landing between the reply and the
 *   write, and that reply is never counted. Today's numbers had to be
 *   backfilled by hand precisely because the code to record them did not exist
 *   while the replies were arriving.
 *
 *   A number that silently under-reports is worse than one that is missing,
 *   because nobody goes looking for it. So the sweep runs on a timer and asks
 *   the only question that matters: is there an inbound message with no
 *   campaign event beside it?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT IS SAFE TO RUN REPEATEDLY
 *
 *   Every write is keyed. A reply dedupes on recipient and second, an opt-out
 *   on the recipient alone, so re-attributing the same message produces the
 *   same rows and changes nothing. The sweep is therefore free to overlap the
 *   webhook, and does — the webhook is simply usually first.
 *
 *   It looks back over a window rather than all of history, because an inbound
 *   message older than the attribution window can no longer belong to any
 *   campaign and re-reading it every hour forever would cost more each week.
 */
async function sweepUnattributedReplies({
  client,
  workspace = DEFAULT_WORKSPACE,
  windowDays = ATTRIBUTION_WINDOW_DAYS,
  now = () => new Date(),
  log = console
} = {}) {
  const summary = { scanned: 0, matched: 0, replied: 0, optedOut: 0 };

  const since = new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: inbound, error } = await client
    .from('sms_messages')
    .select('contact_phone,body,created_at')
    .eq('direction', 'inbound')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw Object.assign(new Error(error.message), { code: 'REPLY_SWEEP_READ_FAILED' });

  summary.scanned = (inbound || []).length;
  for (const message of inbound || []) {
    const outcome = await recordCampaignReplyEvents({
      client,
      phone: message.contact_phone,
      body: message.body,
      occurredAt: message.created_at,
      workspace,
      windowDays,
      log
    });
    if (outcome.matched) summary.matched += 1;
    if (outcome.replied) summary.replied += 1;
    if (outcome.optedOut) summary.optedOut += 1;
  }
  return summary;
}

module.exports = {
  ATTRIBUTION_WINDOW_DAYS,
  OPT_OUT_PATTERN,
  looksLikeOptOut,
  recordCampaignReplyEvents,
  sweepUnattributedReplies
};
