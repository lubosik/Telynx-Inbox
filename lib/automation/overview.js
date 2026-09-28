'use strict';

const { rangeForPeriod, DEFAULT_TIME_ZONE } = require('../analytics/date-ranges');
const { parseAudience } = require('../inbox-audience');

// Each row in these sources is one outbound action. Do not count a cart
// journey itself as a message: its SMS, push and voice stages are independent.
const CAMPAIGN_CATEGORIES = [
  ['vipWelcome', 'vip_welcome'],
  ['checkIns', 'checkin_21d']
];

function emptyCounts() {
  return { pending: 0, sentToday: 0, failedToday: 0, cancelledToday: 0 };
}

function checked(result, source) {
  if (result.error) throw new Error(`${source}: ${result.error.message}`);
  if (!Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error(`${source}: count unavailable`);
  }
  return result.count;
}

async function count(query, source) {
  return checked(await query, source);
}

function campaignQuery(client, campaignID) {
  // One campaign ID per count avoids both an unbounded `.in()` URL and the
  // composite-FK PostgREST join that failed on the live database.
  return client.from('sms_campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', 'vici')
    .eq('selected', true)
    .eq('campaign_id', campaignID);
}

async function campaignCountsForID(client, campaign, category, start, end) {
  const [pending, sentToday, failedToday, cancelledToday] = await Promise.all([
    ['scheduled', 'sending'].includes(campaign.status)
      ? count(campaignQuery(client, campaign.id)
        .in('state', ['pending', 'deferred']), `${category} pending`)
      : 0,
    count(campaignQuery(client, campaign.id)
      .gte('sent_at', start).lt('sent_at', end), `${category} sent`),
    count(campaignQuery(client, campaign.id)
      .eq('state', 'failed').gte('failed_at', start).lt('failed_at', end), `${category} failed`),
    count(campaignQuery(client, campaign.id)
      .eq('state', 'cancelled').gte('updated_at', start).lt('updated_at', end), `${category} cancelled`)
  ]);
  return { pending, sentToday, failedToday, cancelledToday };
}

async function campaignCounts(client, category, start, end) {
  const campaigns = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await client.from('sms_campaigns')
      .select('id,status').eq('workspace_id', 'vici')
      .eq('workflow_category', category)
      .order('id', { ascending: true }).range(from, from + 499);
    if (error) throw new Error(`${category} campaigns: ${error.message}`);
    campaigns.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  const totals = emptyCounts();
  // Bound concurrency even if years of automatic batches have accumulated.
  for (let offset = 0; offset < campaigns.length; offset += 4) {
    const counts = await Promise.all(campaigns.slice(offset, offset + 4)
      .map(campaign => campaignCountsForID(client, campaign, category, start, end)));
    for (const row of counts) {
      for (const key of Object.keys(totals)) totals[key] += row[key];
    }
  }
  return totals;
}

async function paymentCounts(client, start, end) {
  const [pending, sentToday, failedToday, cancelledToday] = await Promise.all([
    count(client.from('sms_scheduled').select('id', { count: 'exact', head: true })
      .eq('status', 'pending'), 'payment pending'),
    // Backfills write SKIPPED/DEDUP and opt-out sentinel rows to this table.
    // Only a provider-accepted message with a Telnyx ID is a real send.
    count(client.from('sms_sent_log').select('id', { count: 'exact', head: true })
      .not('telnyx_message_id', 'is', null)
      .gte('sent_at', start).lt('sent_at', end), 'payment sent'),
    count(client.from('sms_scheduled').select('id', { count: 'exact', head: true })
      .eq('status', 'failed').gte('send_at', start).lt('send_at', end), 'payment failed'),
    // sms_scheduled has no status-change timestamp. As with the legacy stats,
    // created_at is the only safe available proxy for a cancellation today.
    count(client.from('sms_scheduled').select('id', { count: 'exact', head: true })
      .eq('status', 'cancelled').gte('created_at', start).lt('created_at', end), 'payment cancelled')
  ]);
  return { pending, sentToday, failedToday, cancelledToday };
}

function cartQuery(client) {
  return client.from('luko_cart_recoveries')
    .select('id', { count: 'exact', head: true }).eq('workspace_id', 'vici');
}

async function cartCounts(client, start, end) {
  const [smsPending, pushPending, voicePending, smsSent, pushSent, voiceSent,
    smsFailed, pushFailed, voiceFailed, smsCancelled, pushCancelled, voiceCancelled] = await Promise.all([
    count(cartQuery(client).in('status', ['active', 'sending']).is('order_id', null)
      .eq('consent_granted', true).in('sms_status', ['QUEUED', 'ELIGIBLE', 'SENDING']), 'cart SMS pending'),
    count(cartQuery(client).is('order_id', null).eq('customer_push_permission', true)
      .not('push_due_at', 'is', null).in('push_status', ['QUEUED', 'ELIGIBLE', 'SENDING']), 'cart push pending'),
    count(cartQuery(client).is('order_id', null).eq('voice_marketing_consent', true)
      .eq('ai_voice_consent', true).not('voice_due_at', 'is', null)
      .in('voice_status', ['QUEUED', 'DEFERRED_CALLING_WINDOW', 'CLAIMED']), 'cart voice pending'),
    count(cartQuery(client).eq('dry_run', false)
      .gte('sent_at', start).lt('sent_at', end), 'cart SMS sent'),
    count(cartQuery(client).gte('push_sent_at', start).lt('push_sent_at', end), 'cart push sent'),
    count(client.from('luko_cart_voice_attempts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', 'vici').eq('dry_run', false)
      .gte('initiated_at', start).lt('initiated_at', end), 'cart voice started'),
    count(cartQuery(client).eq('sms_status', 'FAILED')
      .gte('updated_at', start).lt('updated_at', end), 'cart SMS failed'),
    count(cartQuery(client).eq('push_status', 'FAILED')
      .gte('updated_at', start).lt('updated_at', end), 'cart push failed'),
    count(cartQuery(client).eq('voice_status', 'FAILED')
      .gte('updated_at', start).lt('updated_at', end), 'cart voice failed'),
    count(cartQuery(client).in('sms_status', ['CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED', 'CANCELLED_UNSUBSCRIBED'])
      .gte('updated_at', start).lt('updated_at', end), 'cart SMS cancelled'),
    count(cartQuery(client).in('push_status', ['CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED', 'CANCELLED_UNSUBSCRIBED'])
      .gte('updated_at', start).lt('updated_at', end), 'cart push cancelled'),
    count(cartQuery(client).in('voice_status', ['CANCELLED_ACTIVE_CONVERSATION', 'CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED'])
      .gte('updated_at', start).lt('updated_at', end), 'cart voice cancelled')
  ]);
  return {
    pending: smsPending + pushPending + voicePending,
    sentToday: smsSent + pushSent + voiceSent,
    failedToday: smsFailed + pushFailed + voiceFailed,
    cancelledToday: smsCancelled + pushCancelled + voiceCancelled,
    channels: {
      sms: { pending: smsPending, sentToday: smsSent, failedToday: smsFailed, cancelledToday: smsCancelled },
      push: { pending: pushPending, sentToday: pushSent, failedToday: pushFailed, cancelledToday: pushCancelled },
      voice: { pending: voicePending, sentToday: voiceSent, failedToday: voiceFailed, cancelledToday: voiceCancelled }
    }
  };
}

async function automationOverview({ client, now = new Date(), timeZone = DEFAULT_TIME_ZONE, audience } = {}) {
  if (parseAudience(audience) !== 'all') {
    return require('./inbox-overview').inboxAutomationOverview({ client, now, timeZone, audience });
  }
  const range = rangeForPeriod({ period: 'today', now, timeZone });
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  const [paymentAndOrders, vipWelcome, checkIns, abandonedCart] = await Promise.all([
    paymentCounts(client, start, end),
    campaignCounts(client, CAMPAIGN_CATEGORIES[0][1], start, end),
    campaignCounts(client, CAMPAIGN_CATEGORIES[1][1], start, end),
    cartCounts(client, start, end)
  ]);
  const breakdown = { paymentAndOrders, vipWelcome, checkIns, abandonedCart };
  const totals = emptyCounts();
  for (const counts of Object.values(breakdown)) {
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return { ...totals, breakdown, timeZone, updatedAt: now.toISOString() };
}

module.exports = { automationOverview, campaignCounts, paymentCounts, cartCounts };
