'use strict';

const { readAllInboxRows, readInboxAudience } = require('../inbox-audience');
const { rangeForPeriod, DEFAULT_TIME_ZONE } = require('../analytics/date-ranges');

const empty = () => ({ pending: 0, sentToday: 0, failedToday: 0, cancelledToday: 0 });
function add(target, source) { for (const key of Object.keys(empty())) target[key] += source[key]; }
function within(value, start, end) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= start && time < end;
}

// Same definitions and event dates as automation/overview.js; only the current
// customer population changes. This function cannot mutate or send anything.
function aggregateInboxOverview({ scheduled = [], sent = [], campaigns = [], recipients = [],
  carts = [], voiceAttempts = [] }, context, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const range = rangeForPeriod({ period: 'today', now, timeZone });
  const start = range.start.getTime();
  const end = range.end.getTime();
  const breakdown = { paymentAndOrders: empty(), vipWelcome: empty(), checkIns: empty(),
    abandonedCart: { ...empty(), channels: { sms: empty(), push: empty(), voice: empty() } } };
  for (const row of context.filter(scheduled, 'phone')) {
    if (row.status === 'pending') breakdown.paymentAndOrders.pending++;
    if (row.status === 'failed' && within(row.send_at, start, end)) breakdown.paymentAndOrders.failedToday++;
    if (row.status === 'cancelled' && within(row.created_at, start, end)) breakdown.paymentAndOrders.cancelledToday++;
  }
  for (const row of context.filter(sent, 'phone')) {
    if (row.telnyx_message_id != null && within(row.sent_at, start, end)) breakdown.paymentAndOrders.sentToday++;
  }
  const byCampaign = new Map(campaigns.map(row => [String(row.id), row]));
  for (const row of context.filter(recipients)) {
    if (row.selected !== true) continue;
    const campaign = byCampaign.get(String(row.campaign_id));
    const key = campaign?.workflow_category === 'vip_welcome' ? 'vipWelcome'
      : campaign?.workflow_category === 'checkin_21d' ? 'checkIns' : null;
    if (!key) continue;
    const counts = breakdown[key];
    if (['scheduled', 'sending'].includes(campaign.status) && ['pending', 'deferred'].includes(row.state)) counts.pending++;
    if (within(row.sent_at, start, end)) counts.sentToday++;
    if (row.state === 'failed' && within(row.failed_at, start, end)) counts.failedToday++;
    if (row.state === 'cancelled' && within(row.updated_at, start, end)) counts.cancelledToday++;
  }
  const channels = breakdown.abandonedCart.channels;
  const scopedCarts = context.filter(carts);
  const cartIDs = new Set(scopedCarts.map(row => String(row.id)));
  for (const row of scopedCarts) {
    if (['active', 'sending'].includes(row.status) && row.order_id == null && row.consent_granted === true
      && ['QUEUED', 'ELIGIBLE', 'SENDING'].includes(row.sms_status)) channels.sms.pending++;
    if (row.order_id == null && row.customer_push_permission === true && row.push_due_at != null
      && ['QUEUED', 'ELIGIBLE', 'SENDING'].includes(row.push_status)) channels.push.pending++;
    if (row.order_id == null && row.voice_marketing_consent === true && row.ai_voice_consent === true
      && row.voice_due_at != null && ['QUEUED', 'DEFERRED_CALLING_WINDOW', 'CLAIMED'].includes(row.voice_status)) channels.voice.pending++;
    if (row.dry_run === false && within(row.sent_at, start, end)) channels.sms.sentToday++;
    if (within(row.push_sent_at, start, end)) channels.push.sentToday++;
    for (const channel of ['sms', 'push', 'voice']) {
      if (row[`${channel}_status`] === 'FAILED' && within(row.updated_at, start, end)) channels[channel].failedToday++;
    }
    for (const channel of ['sms', 'push']) {
      if (['CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED', 'CANCELLED_UNSUBSCRIBED'].includes(row[`${channel}_status`])
        && within(row.updated_at, start, end)) channels[channel].cancelledToday++;
    }
    if (['CANCELLED_ACTIVE_CONVERSATION', 'CANCELLED_PURCHASED', 'CANCELLED_CART_CHANGED'].includes(row.voice_status)
      && within(row.updated_at, start, end)) channels.voice.cancelledToday++;
  }
  for (const row of voiceAttempts) {
    if (cartIDs.has(String(row.recovery_id)) && row.dry_run === false && within(row.initiated_at, start, end)) channels.voice.sentToday++;
  }
  for (const counts of Object.values(channels)) add(breakdown.abandonedCart, counts);
  const totals = empty();
  for (const counts of Object.values(breakdown)) add(totals, counts);
  return { ...totals, breakdown, audience: context.audience, timeZone, updatedAt: now.toISOString() };
}

async function inboxAutomationOverview({ client, audience, now = new Date(), timeZone = DEFAULT_TIME_ZONE }) {
  const context = await readInboxAudience(client, audience);
  const workspace = query => query.eq('workspace_id', 'vici');
  const [scheduled, sent, campaigns, recipients, carts, voiceAttempts] = await Promise.all([
    readAllInboxRows(client, 'sms_scheduled', 'id,phone,status,send_at,created_at', { orderBy: 'id', ascending: true }),
    readAllInboxRows(client, 'sms_sent_log', 'id,phone,telnyx_message_id,sent_at', { orderBy: 'id', ascending: true }),
    readAllInboxRows(client, 'sms_campaigns', 'id,status,workflow_category', { orderBy: 'id', ascending: true, filter: workspace }),
    readAllInboxRows(client, 'sms_campaign_recipients', 'id,campaign_id,contact_phone,selected,state,sent_at,failed_at,updated_at', { orderBy: 'id', ascending: true, filter: workspace }),
    readAllInboxRows(client, 'luko_cart_recoveries', 'id,contact_phone,status,order_id,consent_granted,sms_status,customer_push_permission,push_due_at,push_status,voice_marketing_consent,ai_voice_consent,voice_due_at,voice_status,dry_run,sent_at,push_sent_at,updated_at', { orderBy: 'id', ascending: true, filter: workspace }),
    readAllInboxRows(client, 'luko_cart_voice_attempts', 'id,recovery_id,dry_run,initiated_at', { orderBy: 'id', ascending: true, filter: workspace })
  ]);
  return aggregateInboxOverview({ scheduled, sent, campaigns, recipients, carts, voiceAttempts }, context, { now, timeZone });
}

module.exports = { aggregateInboxOverview, inboxAutomationOverview };
