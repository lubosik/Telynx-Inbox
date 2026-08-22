'use strict';

const { rangeForPeriod, zonedDateTimeToUTC } = require('./date-ranges');
const { PAYMENT_REMINDER_FLOWS } = require('./attribution');
const { isInternalSIPLog } = require('../call-status');
const { excludeAnalyticsSource } = require('./exclusions');
const {
  CAMPAIGN_CATEGORIES,
  campaignAttributionRows,
  campaignFinancialMetrics,
  campaignOperationalMetrics
} = require('../campaigns/analytics');
const { campaignAttributionGenerationReady } = require('../campaigns/attribution-generator');

const WORKSPACE_ID = 'vici';
const PAGE_SIZE = 1000;
const MAX_SOURCE_ROWS = 50000;
const CONFIDENCE_LEVELS = ['direct', 'strong', 'influenced', 'unattributed'];
const CONFIDENCE_LABELS = Object.freeze({
  direct: '100% Direct',
  strong: '90% Strong',
  influenced: '60% Influenced',
  unattributed: 'Unattributed'
});
const CONFIDENCE_SCORES = Object.freeze({
  direct: '1.00',
  strong: '0.90',
  influenced: '0.60',
  unattributed: '0.00'
});
const SOURCE_RELIABLE_FROM = Object.freeze({
  messaging: process.env.ANALYTICS_MESSAGING_RELIABLE_FROM || '2026-04-29',
  paymentRecovery: process.env.ANALYTICS_RECOVERY_RELIABLE_FROM || '2026-05-27',
  calls: process.env.ANALYTICS_CALLS_RELIABLE_FROM || '2026-06-11'
});

function sourceCoverage(range, reliableFrom = SOURCE_RELIABLE_FROM) {
  const availability = {};
  const warnings = [];
  for (const [sourceName, floor] of Object.entries(reliableFrom)) {
    const floorTime = Date.parse(`${floor}T00:00:00.000Z`);
    const label = sourceName === 'paymentRecovery'
      ? 'Payment-recovery'
      : sourceName[0].toUpperCase() + sourceName.slice(1);
    if (!Number.isFinite(floorTime)) {
      availability[sourceName] = false;
      warnings.push({
        code: `UNKNOWN_${sourceName.replace(/([A-Z])/g, '_$1').toUpperCase()}_HISTORY`,
        message: `${label} history has no valid reliability start date and is not presented as complete.`
      });
      continue;
    }
    availability[sourceName] = range.end.getTime() > floorTime;
    if (range.start.getTime() >= floorTime) continue;
    const unavailable = range.end.getTime() <= floorTime;
    warnings.push({
      code: `${unavailable ? 'NO' : 'PARTIAL'}_${sourceName.replace(/([A-Z])/g, '_$1').toUpperCase()}_HISTORY`,
      message: unavailable
        ? `No reliable ${label.toLowerCase()} history exists for this selected range; reliable tracking starts ${floor}.`
        : `${label} history is reliable from ${floor}; earlier activity is not presented as complete.`
    });
  }
  return { availability, warnings };
}

class AnalyticsNotReadyError extends Error {
  constructor(message = 'Analytics storage is not ready.') {
    super(message);
    this.name = 'AnalyticsNotReadyError';
    this.code = 'ANALYTICS_NOT_READY';
    this.status = 503;
  }
}

class CampaignAnalyticsNotReadyError extends Error {
  constructor(message = 'Campaign analytics storage is not ready.') {
    super(message);
    this.name = 'CampaignAnalyticsNotReadyError';
    this.code = 'CAMPAIGNS_NOT_READY';
    this.status = 503;
  }
}

class CampaignAnalyticsNotFoundError extends Error {
  constructor() {
    super('Campaign not found.');
    this.name = 'CampaignAnalyticsNotFoundError';
    this.code = 'CAMPAIGN_NOT_FOUND';
    this.status = 404;
  }
}

function isMissingAnalyticsSchema(error) {
  if (['42P01', 'PGRST202', 'PGRST205', 'PGRST204'].includes(error?.code)) return true;
  const message = String(error?.message || '');
  const missing = /does not exist|could not find|schema cache/i;
  const analyticsTable = /analytics_|revenue_attributions|message_sentiment/i;
  return missing.test(message) && analyticsTable.test(message);
}

function validTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clampNumber(value, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : minimum;
}

function decimalToCents(value) {
  const text = String(value ?? '0').trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return 0n;
  const fraction = (match[3] || '').padEnd(3, '0');
  let cents = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2) || '0');
  if (Number(fraction[2] || 0) >= 5) cents += 1n;
  return match[1] ? -cents : cents;
}

function centsToDecimal(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function moneyToCents(value) {
  const cents = decimalToCents(value);
  return cents < 0n ? 0n : cents;
}

function percentage(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function percentChange(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function dateRangeContains(row, column, range) {
  const timestamp = validTime(row?.[column]);
  return timestamp !== null && timestamp >= range.start.getTime() && timestamp < range.end.getTime();
}

function deduplicate(rows, keyForRow) {
  const seen = new Set();
  return rows.filter(row => {
    const key = keyForRow(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confidenceBreakdown(attributions) {
  const breakdown = Object.fromEntries(CONFIDENCE_LEVELS.map(level => [level, {
    label: CONFIDENCE_LABELS[level],
    confidenceScore: CONFIDENCE_SCORES[level],
    netRevenueCents: 0n,
    grossRevenueCents: 0n,
    refundedRevenueCents: 0n,
    orderCount: 0
  }]));

  for (const row of deduplicate(attributions, row => String(row.order_id || row.id || ''))) {
    const level = CONFIDENCE_LEVELS.includes(row.confidence_level) ? row.confidence_level : 'unattributed';
    const bucket = breakdown[level];
    if (row.invalidated_at) {
      // A full refund invalidates net revenue but remains a real financial
      // adjustment. Preserve gross/refunded transparency without counting the
      // order as currently attributed. Other invalidations contribute nothing.
      if (row.is_refunded && level !== 'unattributed') {
        bucket.grossRevenueCents += moneyToCents(row.gross_amount);
        bucket.refundedRevenueCents += moneyToCents(row.refunded_amount);
      }
      continue;
    }
    bucket.orderCount += 1;
    bucket.netRevenueCents += moneyToCents(row.net_amount);
    bucket.grossRevenueCents += moneyToCents(row.gross_amount);
    bucket.refundedRevenueCents += moneyToCents(row.refunded_amount);
  }
  return breakdown;
}

function publicBreakdown(breakdown) {
  return Object.fromEntries(CONFIDENCE_LEVELS.map(level => [level, {
    label: breakdown[level].label,
    confidenceScore: breakdown[level].confidenceScore,
    netRevenue: centsToDecimal(breakdown[level].netRevenueCents),
    orderCount: breakdown[level].orderCount
  }]));
}

function aggregateRevenue(attributions) {
  const breakdown = confidenceBreakdown(attributions);
  const direct = breakdown.direct.netRevenueCents;
  const strong = breakdown.strong.netRevenueCents;
  const influenced = breakdown.influenced.netRevenueCents;
  const attributed = direct + strong;
  const recovered = deduplicate(attributions, row => String(row.order_id || row.id || ''))
    .filter(row => !row.invalidated_at && row.category === 'payment_recovery')
    .filter(row => row.confidence_level === 'direct' || row.confidence_level === 'strong')
    .reduce((sum, row) => sum + moneyToCents(row.net_amount), 0n);
  const gross = breakdown.direct.grossRevenueCents + breakdown.strong.grossRevenueCents + breakdown.influenced.grossRevenueCents;
  const refunded = breakdown.direct.refundedRevenueCents + breakdown.strong.refundedRevenueCents + breakdown.influenced.refundedRevenueCents;
  const weighted = direct + (strong * 90n / 100n) + (influenced * 60n / 100n);
  return {
    recoveredRevenue: centsToDecimal(recovered),
    attributedRevenue: centsToDecimal(attributed),
    influencedRevenue: centsToDecimal(influenced),
    totalRevenueImpact: centsToDecimal(attributed + influenced),
    weightedAttributedValue: centsToDecimal(weighted),
    unattributedRevenue: centsToDecimal(breakdown.unattributed.netRevenueCents),
    grossAttributedRevenue: centsToDecimal(gross),
    refundedAttributedRevenue: centsToDecimal(refunded),
    breakdown: publicBreakdown(breakdown)
  };
}

const REVENUE_DRIVER_META = Object.freeze({
  payment_recovery: Object.freeze({ key: 'paymentRecovery', label: 'Payment Recovery' }),
  campaign: Object.freeze({ key: 'campaigns', label: 'Campaigns' }),
  reorder: Object.freeze({ key: 'reorders', label: 'Reorders' }),
  back_in_stock: Object.freeze({ key: 'backInStock', label: 'Back In Stock' }),
  winback: Object.freeze({ key: 'winbacks', label: 'Win-backs' })
});

function revenueDriverFor(row) {
  const category = String(row?.category || row?.workflow || '').toLowerCase();
  if (category === 'payment_recovery') return REVENUE_DRIVER_META.payment_recovery;
  if (category.startsWith('back_in_stock')) return REVENUE_DRIVER_META.back_in_stock;
  if (category.startsWith('reorder')) return REVENUE_DRIVER_META.reorder;
  if (category === 'winback' || category.startsWith('winback_')) return REVENUE_DRIVER_META.winback;
  const evidence = row?.supporting_evidence;
  const explicitlyCampaign = evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
    Boolean(evidence.campaignID || evidence.campaign_id);
  if (CAMPAIGN_CATEGORIES.has(category) || explicitlyCampaign) return REVENUE_DRIVER_META.campaign;
  return null;
}

function aggregateRevenueDrivers(attributions) {
  const groups = new Map();
  for (const row of deduplicate(attributions, item => String(item.order_id || item.id || ''))) {
    const driver = revenueDriverFor(row);
    if (!driver) continue;
    if (!groups.has(driver.key)) groups.set(driver.key, { driver, rows: [] });
    groups.get(driver.key).rows.push(row);
  }
  const displayOrder = ['paymentRecovery', 'campaigns', 'reorders', 'backInStock', 'winbacks'];
  return displayOrder.filter(key => groups.has(key)).map(key => {
    const { driver, rows } = groups.get(key);
    const revenue = aggregateRevenue(rows);
    const directOrders = revenue.breakdown.direct.orderCount;
    const strongOrders = revenue.breakdown.strong.orderCount;
    const influencedOrders = revenue.breakdown.influenced.orderCount;
    return {
      key: driver.key,
      label: driver.label,
      attributedRevenue: revenue.attributedRevenue,
      influencedRevenue: revenue.influencedRevenue,
      totalRevenueImpact: revenue.totalRevenueImpact,
      grossRevenue: revenue.grossAttributedRevenue,
      refundedRevenue: revenue.refundedAttributedRevenue,
      attributedOrders: directOrders + strongOrders,
      influencedOrders,
      breakdown: revenue.breakdown
    };
  });
}

function deliveredAutomationReminders(reminders, messages) {
  const statusByProviderID = new Map();
  for (const message of messages) {
    // GHL mirrors are not authoritative carrier delivery evidence.
    if (!message.ghl_message_id && message.telnyx_message_id) {
      statusByProviderID.set(message.telnyx_message_id, message.status);
    }
  }
  return deduplicate(reminders, row => String(row.telnyx_message_id || row.id || ''))
    .filter(row => PAYMENT_REMINDER_FLOWS.has(row.flow_type))
    .filter(row => row.telnyx_message_id && statusByProviderID.get(row.telnyx_message_id) === 'delivered')
    .filter(row => !String(row.message_body || '').startsWith('BACKFILL '));
}

function aggregatePaymentRecovery(attributions, reminders, messages) {
  const attempts = deduplicate(reminders, row => String(row.telnyx_message_id || row.id || ''))
    .filter(row => PAYMENT_REMINDER_FLOWS.has(row.flow_type))
    .filter(row => row.telnyx_message_id)
    .filter(row => !String(row.message_body || '').startsWith('BACKFILL '));
  const delivered = deliveredAutomationReminders(reminders, messages);
  const reminderOrders = new Set(delivered.map(row => String(row.order_id || '')).filter(Boolean));
  const recovered = deduplicate(attributions, row => String(row.order_id || row.id || ''))
    .filter(row => !row.invalidated_at && row.category === 'payment_recovery')
    .filter(row => row.confidence_level === 'direct' || row.confidence_level === 'strong');
  const recoveredCents = recovered.reduce((sum, row) => sum + moneyToCents(row.net_amount), 0n);
  const elapsed = recovered.map(row => clampNumber(row.attribution_window_seconds)).filter(value => value >= 0);
  return {
    cohort: 'reminder_action',
    remindersSent: attempts.length,
    remindersDelivered: delivered.length,
    uniqueCustomersReminded: new Set(attempts.map(row => row.phone).filter(Boolean)).size,
    ordersRecovered: recovered.length,
    recoveredRevenue: centsToDecimal(recoveredCents),
    recoveryRate: percentage(recovered.length, reminderOrders.size),
    medianRecoverySeconds: median(elapsed),
    directRecoveries: recovered.filter(row => row.confidence_level === 'direct').length,
    strongRecoveries: recovered.filter(row => row.confidence_level === 'strong').length
  };
}

function aggregateResponseEpisodes(messages, automationMessageIDs = new Set()) {
  const eligible = deduplicate(messages, row => String(row.telnyx_message_id || row.ghl_message_id || row.id || ''))
    .filter(row => !row.reply_to_message_id)
    .filter(row => row.contact_phone && validTime(row.created_at) !== null)
    .sort((a, b) => validTime(a.created_at) - validTime(b.created_at));
  const byPhone = new Map();
  for (const row of eligible) {
    if (!byPhone.has(row.contact_phone)) byPhone.set(row.contact_phone, []);
    byPhone.get(row.contact_phone).push(row);
  }

  const responseSeconds = [];
  let answered = 0;
  let unanswered = 0;
  for (const rows of byPhone.values()) {
    let waitingSince = null;
    for (const row of rows) {
      const timestamp = validTime(row.created_at);
      if (row.direction === 'inbound') {
        if (waitingSince === null) waitingSince = timestamp;
        continue;
      }
      if (row.direction !== 'outbound' || waitingSince === null) continue;
      // The CRM payload does not reliably distinguish a human reply from a
      // workflow send. Excluding GHL-originated outbound rows is conservative:
      // it avoids claiming an automation as staff response performance.
      if (row.ghl_message_id || automationMessageIDs.has(row.telnyx_message_id)) continue;
      responseSeconds.push(Math.max(0, Math.floor((timestamp - waitingSince) / 1000)));
      answered += 1;
      waitingSince = null;
    }
    if (waitingSince !== null) unanswered += 1;
  }

  const total = responseSeconds.reduce((sum, value) => sum + value, 0);
  return {
    medianFirstResponseSeconds: median(responseSeconds),
    averageFirstResponseSeconds: responseSeconds.length ? Math.round(total / responseSeconds.length) : null,
    under5MinutesPercent: percentage(responseSeconds.filter(value => value <= 300).length, responseSeconds.length),
    under15MinutesPercent: percentage(responseSeconds.filter(value => value <= 900).length, responseSeconds.length),
    answeredConversations: answered,
    unansweredConversations: unanswered
  };
}

function deduplicateMessages(messages) {
  const providerUnique = deduplicate(messages, row => String(row.telnyx_message_id || row.ghl_message_id || row.id || ''));
  // GHL can mirror a Telnyx message under a different provider id. Prefer the
  // Telnyx-native row when the immutable message facts match inside five
  // seconds. This prevents CRM mirroring from inflating usage while retaining
  // genuine GHL-only conversations.
  const nativeRows = providerUnique.filter(row => !row.ghl_message_id);
  const nativeTimes = new Map();
  for (const native of nativeRows) {
    const timestamp = validTime(native.created_at);
    if (timestamp === null) continue;
    const key = `${native.contact_phone || ''}\u0000${native.direction || ''}\u0000${native.body || ''}`;
    if (!nativeTimes.has(key)) nativeTimes.set(key, []);
    nativeTimes.get(key).push(timestamp);
  }
  return providerUnique.filter(row => {
    if (!row.ghl_message_id) return true;
    const rowTime = validTime(row.created_at);
    if (rowTime === null) return true;
    const key = `${row.contact_phone || ''}\u0000${row.direction || ''}\u0000${row.body || ''}`;
    return !(nativeTimes.get(key) || []).some(timestamp => Math.abs(timestamp - rowTime) <= 5000);
  });
}

function aggregateMessaging(messages, reminders) {
  const unique = deduplicateMessages(messages);
  const inbound = unique.filter(row => row.direction === 'inbound');
  const outbound = unique.filter(row => row.direction === 'outbound');
  // Carrier delivery metrics only include Telnyx-native rows. GHL imports are
  // marked delivered by the CRM integration and cannot prove carrier receipt.
  const telnyxOutbound = outbound.filter(row => row.telnyx_message_id && !row.ghl_message_id);
  const statuses = status => telnyxOutbound.filter(row => row.status === status).length;
  const contacted = new Set(outbound.map(row => row.contact_phone).filter(Boolean));
  const firstOutboundByPhone = new Map();
  for (const row of outbound) {
    const timestamp = validTime(row.created_at);
    if (!row.contact_phone || timestamp === null) continue;
    const existing = firstOutboundByPhone.get(row.contact_phone);
    if (existing === undefined || timestamp < existing) firstOutboundByPhone.set(row.contact_phone, timestamp);
  }
  const repliedCustomers = new Set();
  for (const row of inbound) {
    const timestamp = validTime(row.created_at);
    const outboundAt = firstOutboundByPhone.get(row.contact_phone);
    if (timestamp !== null && outboundAt !== undefined && timestamp > outboundAt) repliedCustomers.add(row.contact_phone);
  }
  const automationIDs = new Set(reminders.map(row => row.telnyx_message_id).filter(Boolean));
  return {
    metrics: {
      outbound: outbound.length,
      inbound: inbound.length,
      total: unique.length,
      conversations: new Set(unique.map(row => row.contact_phone).filter(Boolean)).size,
      uniqueCustomersContacted: contacted.size,
      repliesReceived: inbound.length,
      replyRate: percentage(repliedCustomers.size, contacted.size),
      delivered: statuses('delivered'),
      sent: statuses('sent'),
      queued: statuses('queued'),
      failed: statuses('failed'),
      optOuts: inbound.filter(row => /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[\s-]?out)$/i.test(String(row.body || '').trim())).length
    },
    responsePerformance: aggregateResponseEpisodes(unique, automationIDs)
  };
}

function aggregateCalls(calls) {
  const unique = deduplicate(calls, row => String(row.call_control_id || row.id || ''))
    .filter(row => !isInternalSIPLog(row));
  const completed = unique.filter(row => row.status === 'completed');
  const answered = unique.filter(row => row.answered_at || (row.status === 'completed' && clampNumber(row.duration_seconds) > 0));
  const totalTalk = completed.reduce((sum, row) => sum + Math.floor(clampNumber(row.duration_seconds)), 0);
  return {
    total: unique.length,
    inbound: unique.filter(row => row.direction === 'inbound').length,
    outbound: unique.filter(row => row.direction === 'outbound').length,
    answered: answered.length,
    missed: unique.filter(row => row.status === 'missed' || row.status === 'declined').length,
    completed: completed.length,
    totalTalkSeconds: totalTalk,
    averageDurationSeconds: completed.length ? Math.round(totalTalk / completed.length) : null,
    uniqueCustomers: new Set(unique.map(row => row.contact_phone).filter(Boolean)).size,
    answerRate: percentage(answered.length, unique.length)
  };
}

function sentimentLabel(score) {
  if (score === null) return null;
  if (score <= -1.5) return 'Very Upset';
  if (score < -0.25) return 'Upset';
  if (score <= 0.25) return 'Neutral';
  if (score < 1.5) return 'Happy';
  return 'Extremely Happy';
}

function aggregateSentiment(sentiments, inboundCount) {
  const newestFirst = [...sentiments].sort((a, b) => (validTime(b.created_at) || 0) - (validTime(a.created_at) || 0));
  const unique = deduplicate(newestFirst, row => String(row.message_id || row.id || ''))
    .map(row => Number(row.score)).filter(score => Number.isInteger(score) && score >= -2 && score <= 2);
  const averageScore = unique.length
    ? Number((unique.reduce((sum, value) => sum + value, 0) / unique.length).toFixed(2))
    : null;
  return {
    label: sentimentLabel(averageScore),
    averageScore,
    changeFromPrevious: null,
    positivePercentage: percentage(unique.filter(score => score > 0).length, unique.length),
    neutralPercentage: percentage(unique.filter(score => score === 0).length, unique.length),
    negativePercentage: percentage(unique.filter(score => score < 0).length, unique.length),
    messagesAnalyzed: unique.length,
    coveragePercentage: percentage(unique.length, inboundCount)
  };
}

function activityGranularity(range) {
  const hours = Math.max(1, (range.end.getTime() - range.start.getTime()) / 3600000);
  if (hours <= 48) return 'hour';
  if (hours <= 45 * 24) return 'day';
  if (hours <= 180 * 24) return 'week';
  return 'month';
}

function activityDateParts(value, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour
  };
}

function activityBucket(value, granularity, timeZone) {
  const parts = activityDateParts(value, timeZone);
  let start = { ...parts, minute: 0, second: 0 };
  if (granularity === 'day') start.hour = 0;
  if (granularity === 'week') {
    const civil = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekday = civil.getUTCDay();
    civil.setUTCDate(civil.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
    start = {
      year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1,
      day: civil.getUTCDate(), hour: 0, minute: 0, second: 0
    };
  }
  if (granularity === 'month') {
    start = { year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0 };
  }
  const localDate = `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`;
  const key = granularity === 'hour'
    ? `${localDate}T${String(start.hour).padStart(2, '0')}`
    : granularity === 'month'
      ? localDate.slice(0, 7)
      : localDate;
  return { key, bucketStart: zonedDateTimeToUTC(start, timeZone).toISOString() };
}

function nextActivityBucketStart(value, granularity, timeZone) {
  if (granularity === 'hour') return new Date(new Date(value).getTime() + 3600000);
  const parts = activityDateParts(value, timeZone);
  if (granularity === 'month') {
    const next = new Date(Date.UTC(parts.year, parts.month, 1));
    return zonedDateTimeToUTC({
      year: next.getUTCFullYear(), month: next.getUTCMonth() + 1,
      day: 1, hour: 0, minute: 0, second: 0
    }, timeZone);
  }
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  next.setUTCDate(next.getUTCDate() + (granularity === 'week' ? 7 : 1));
  return zonedDateTimeToUTC({
    year: next.getUTCFullYear(), month: next.getUTCMonth() + 1,
    day: next.getUTCDate(), hour: 0, minute: 0, second: 0
  }, timeZone);
}

function activitySeries({ range, timeZone, messages, calls, attributions, sentiments }) {
  const granularity = activityGranularity(range);
  const dayMap = new Map();
  const ensure = date => {
    const bucket = activityBucket(date, granularity, timeZone);
    const key = bucket.key;
    if (!dayMap.has(key)) dayMap.set(key, {
      date: key,
      bucketStart: bucket.bucketStart,
      outboundMessages: 0,
      inboundMessages: 0,
      completedCalls: 0,
      recoveredRevenueCents: 0n,
      influencedRevenueCents: 0n,
      sentimentScores: []
    });
    return dayMap.get(key);
  };

  // Complete buckets keep the chart stable on quiet periods and let the iOS
  // client choose a small, explicit label set instead of asking Swift Charts
  // to render every categorical date. Advance at the selected granularity in
  // local civil time, so a year view does twelve iterations rather than 8,760
  // and daylight-saving boundaries do not lose a day.
  let cursor = new Date(activityBucket(range.start, granularity, timeZone).bucketStart);
  while (cursor < range.end) {
    ensure(cursor);
    cursor = nextActivityBucketStart(cursor, granularity, timeZone);
  }

  for (const row of deduplicateMessages(messages)) {
    if (!dateRangeContains(row, 'created_at', range)) continue;
    const day = ensure(row.created_at);
    if (row.direction === 'outbound') day.outboundMessages += 1;
    if (row.direction === 'inbound') day.inboundMessages += 1;
  }
  for (const row of deduplicate(calls, item => String(item.call_control_id || item.id || '')).filter(item => !isInternalSIPLog(item))) {
    if (row.status === 'completed' && dateRangeContains(row, 'started_at', range)) ensure(row.started_at).completedCalls += 1;
  }
  for (const row of deduplicate(attributions, item => String(item.order_id || item.id || ''))) {
    if (row.invalidated_at || !dateRangeContains(row, 'conversion_at', range)) continue;
    const day = ensure(row.conversion_at);
    if (row.confidence_level === 'direct' || row.confidence_level === 'strong') day.recoveredRevenueCents += moneyToCents(row.net_amount);
    if (row.confidence_level === 'influenced') day.influencedRevenueCents += moneyToCents(row.net_amount);
  }
  const currentSentiments = [...sentiments].sort((a, b) => (validTime(b.created_at) || 0) - (validTime(a.created_at) || 0));
  for (const row of deduplicate(currentSentiments, item => String(item.message_id || item.id || ''))) {
    if (!dateRangeContains(row, 'occurred_at', range)) continue;
    const score = Number(row.score);
    if (Number.isInteger(score) && score >= -2 && score <= 2) ensure(row.occurred_at).sentimentScores.push(score);
  }

  const points = [...dayMap.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).map(day => ({
    date: day.date,
    bucketStart: day.bucketStart,
    outboundMessages: day.outboundMessages,
    inboundMessages: day.inboundMessages,
    completedCalls: day.completedCalls,
    recoveredRevenue: centsToDecimal(day.recoveredRevenueCents),
    influencedRevenue: centsToDecimal(day.influencedRevenueCents),
    sentimentAverage: day.sentimentScores.length
      ? Number((day.sentimentScores.reduce((sum, value) => sum + value, 0) / day.sentimentScores.length).toFixed(2))
      : null
  }));
  return { granularity, points };
}

function aggregatePeriod(source, range, timeZone) {
  const messages = source.messages.filter(row => dateRangeContains(row, 'created_at', range));
  const reminders = source.reminders.filter(row => dateRangeContains(row, 'sent_at', range));
  const calls = source.calls.filter(row => dateRangeContains(row, 'started_at', range));
  const attributions = source.attributions.filter(row => dateRangeContains(row, 'conversion_at', range));
  // Recovery rates use a reminder-action cohort. This avoids dividing
  // payments completed in the period by unrelated reminders sent in it.
  const recoveryAttributions = (source.recoveryAttributions || source.attributions)
    .filter(row => dateRangeContains(row, 'action_at', range));
  const sentiments = source.sentiments.filter(row => dateRangeContains(row, 'occurred_at', range));
  const revenue = aggregateRevenue(attributions);
  const messagingResult = aggregateMessaging(messages, reminders);
  const sentiment = aggregateSentiment(sentiments, messagingResult.metrics.inbound);
  const activity = activitySeries({ range, timeZone, messages, calls, attributions, sentiments });
  return {
    revenue,
    revenueDrivers: aggregateRevenueDrivers(attributions),
    paymentRecovery: aggregatePaymentRecovery(recoveryAttributions, reminders, messages),
    messaging: messagingResult.metrics,
    responsePerformance: messagingResult.responsePerformance,
    calls: aggregateCalls(calls),
    sentiment,
    activityGranularity: activity.granularity,
    activitySeries: activity.points
  };
}

function trendMetrics(current, previous) {
  if (!previous) return {
    attributedRevenuePercent: null,
    recoveredRevenuePercent: null,
    messagesOutboundPercent: null,
    medianResponseSecondsPercent: null,
    completedCallsPercent: null,
    sentimentScoreChange: null
  };
  return {
    attributedRevenuePercent: percentChange(Number(current.revenue.attributedRevenue), Number(previous.revenue.attributedRevenue)),
    recoveredRevenuePercent: percentChange(Number(current.revenue.recoveredRevenue), Number(previous.revenue.recoveredRevenue)),
    messagesOutboundPercent: percentChange(current.messaging.outbound, previous.messaging.outbound),
    medianResponseSecondsPercent: percentChange(current.responsePerformance.medianFirstResponseSeconds, previous.responsePerformance.medianFirstResponseSeconds),
    completedCallsPercent: percentChange(current.calls.completed, previous.calls.completed),
    sentimentScoreChange: current.sentiment.averageScore === null || previous.sentiment.averageScore === null
      ? null
      : Number((current.sentiment.averageScore - previous.sentiment.averageScore).toFixed(2))
  };
}

function sentimentChange(current, previous) {
  const currentScore = current?.sentiment?.averageScore;
  const previousScore = previous?.sentiment?.averageScore;
  if (currentScore === null || currentScore === undefined || previousScore === null || previousScore === undefined) {
    return null;
  }
  return Number((currentScore - previousScore).toFixed(2));
}

async function fetchPaged(client, { table, columns, timeColumn, start, end, filters = [], maxRows = MAX_SOURCE_ROWS }) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    let query = client.from(table).select(columns)
      .gte(timeColumn, start.toISOString()).lt(timeColumn, end.toISOString())
      .order(timeColumn, { ascending: true })
      .range(from, Math.min(from + PAGE_SIZE - 1, maxRows - 1));
    for (const filter of filters) query = filter(query);
    const { data, error } = await query;
    if (error) {
      if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function fetchCampaignPaged(client, {
  table, columns, campaignID, timeColumn, workspaceID = WORKSPACE_ID, maxRows = MAX_SOURCE_ROWS
}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await client.from(table).select(columns)
      .eq('workspace_id', workspaceID).eq('campaign_id', campaignID)
      .order(timeColumn, { ascending: true })
      .range(from, Math.min(from + PAGE_SIZE - 1, maxRows - 1));
    if (error) {
      if (isMissingAnalyticsSchema(error) || /sms_campaign/i.test(String(error.message || ''))) {
        throw new CampaignAnalyticsNotReadyError();
      }
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

// Deliberately omit contact/customer fields: the campaign analytics join needs
// only order/action identifiers and already-classified evidence. This keeps
// phone, name, raw message content, and customer PII out of this read path.
const CAMPAIGN_ATTRIBUTION_COLUMNS = 'id,order_id,campaign_id,campaign_recipient_id,currency,gross_amount,refunded_amount,net_amount,category,workflow,originating_action_type,originating_action_id,action_at,conversion_at,attribution_window_seconds,confidence_level,confidence_score,reason,supporting_evidence,is_refunded,invalidated_at,updated_at';

async function fetchCampaignAttributions(client, campaignID, recipients, workspaceID = WORKSPACE_ID, maxRows = MAX_SOURCE_ROWS) {
  const actionIDs = [...new Set((recipients || []).flatMap(row => [row.provider_message_id, row.id])
    .map(value => String(value || '')).filter(Boolean))];
  const rows = [];
  const seen = new Set();
  let truncated = false;
  let scanned = 0;
  const chunkSize = 200;

  const append = data => {
    for (const row of data || []) {
      const id = String(row.id || `${row.order_id}:${row.originating_action_id}`);
      if (!seen.has(id)) { seen.add(id); rows.push(row); }
    }
  };
  const campaignMissing = error => ['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code) ||
    /campaign_id|campaign_recipient_id|sms_campaign/i.test(String(error?.message || ''));

  // New rows are joined by the additive, indexed campaign_id column. This is
  // authoritative and also finds a campaign attribution whose action ID was
  // replaced, corrected, or is intentionally not a provider message ID.
  for (let from = 0; scanned < maxRows; from += PAGE_SIZE) {
    const pageSize = Math.min(PAGE_SIZE, maxRows - scanned);
    const { data, error } = await client.from('revenue_attributions')
      .select(CAMPAIGN_ATTRIBUTION_COLUMNS)
      .eq('workspace_id', workspaceID)
      .eq('campaign_id', campaignID)
      .order('conversion_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) {
      if (campaignMissing(error)) throw new CampaignAnalyticsNotReadyError();
      if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
      throw error;
    }
    scanned += (data || []).length;
    append(data);
    if (!data || data.length < pageSize) break;
    if (scanned >= maxRows) truncated = true;
  }

  // Compatibility only: pre-wiring rows may have no campaign_id but retain an
  // exact recipient/provider action ID. Lists remain URL-safe in 200-ID chunks.
  for (let offset = 0; offset < actionIDs.length && scanned < maxRows; offset += chunkSize) {
    const chunk = actionIDs.slice(offset, offset + chunkSize);
    for (let from = 0; scanned < maxRows; from += PAGE_SIZE) {
      const pageSize = Math.min(PAGE_SIZE, maxRows - scanned);
      // bounded: action ids are chunked to 200 before entering the URL.
      const { data, error } = await client.from('revenue_attributions')
        .select(CAMPAIGN_ATTRIBUTION_COLUMNS)
        .eq('workspace_id', workspaceID)
        .is('campaign_id', null)
        .in('originating_action_id', chunk) // bounded: chunk contains at most 200 action IDs.
        .order('conversion_at', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        if (campaignMissing(error)) throw new CampaignAnalyticsNotReadyError();
        if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
        throw error;
      }
      scanned += (data || []).length;
      append(data);
      if (!data || data.length < pageSize) break;
      if (scanned >= maxRows) truncated = true;
    }
  }
  if (scanned >= maxRows || actionIDs.length > Math.ceil(maxRows / chunkSize) * chunkSize) truncated = true;
  return { rows, truncated };
}

async function loadCampaignAnalyticsSource(client, campaignID, workspaceID = WORKSPACE_ID) {
  const { data: campaign, error } = await client.from('sms_campaigns').select(
    'id,title,status,campaign_type,workflow_category,revision,created_at,scheduled_for,completed_at'
  ).eq('workspace_id', workspaceID).eq('id', campaignID).maybeSingle();
  if (error) {
    if (['42P01', 'PGRST204', 'PGRST205'].includes(error.code) || /sms_campaign/i.test(String(error.message || ''))) {
      throw new CampaignAnalyticsNotReadyError();
    }
    throw error;
  }
  if (!campaign) throw new CampaignAnalyticsNotFoundError();
  const [recipientResult, eventResult] = await Promise.all([
    fetchCampaignPaged(client, {
      table: 'sms_campaign_recipients',
      columns: 'id,selected,state,provider_message_id,sent_at',
      campaignID, timeColumn: 'created_at', workspaceID
    }),
    fetchCampaignPaged(client, {
      table: 'sms_campaign_recipient_events',
      columns: 'id,recipient_id,event_type,occurred_at,reason_code,metadata,dedupe_key',
      campaignID, timeColumn: 'occurred_at', workspaceID
    })
  ]);
  const attributionResult = await fetchCampaignAttributions(client, campaignID, recipientResult.rows, workspaceID);
  const warnings = [];
  if (recipientResult.truncated) warnings.push({ code: 'CAMPAIGN_RECIPIENTS_TRUNCATED', message: 'Campaign recipients reached the analytics safety ceiling.' });
  if (eventResult.truncated) warnings.push({ code: 'CAMPAIGN_EVENTS_TRUNCATED', message: 'Campaign events reached the analytics safety ceiling.' });
  if (attributionResult.truncated) warnings.push({ code: 'CAMPAIGN_ATTRIBUTIONS_TRUNCATED', message: 'Campaign attributions reached the analytics safety ceiling.' });
  return {
    campaign,
    recipients: recipientResult.rows,
    events: eventResult.rows,
    attributions: attributionResult.rows,
    warnings
  };
}

async function loadAnalyticsSource(client, range) {
  const combinedStart = range.previous?.start || range.start;
  const combinedEnd = range.end;
  const queries = await Promise.all([
    fetchPaged(client, {
      table: 'revenue_attributions',
      columns: 'id,order_id,customer_id,contact_phone,currency,gross_amount,refunded_amount,net_amount,category,workflow,originating_action_type,originating_action_id,action_at,conversion_at,attribution_window_seconds,confidence_level,confidence_score,reason,supporting_evidence,is_refunded,invalidated_at,updated_at',
      timeColumn: 'conversion_at', start: combinedStart, end: combinedEnd,
      filters: [query => query.eq('workspace_id', WORKSPACE_ID)]
    }),
    fetchPaged(client, {
      table: 'revenue_attributions',
      columns: 'id,order_id,customer_id,contact_phone,currency,gross_amount,refunded_amount,net_amount,category,workflow,originating_action_type,originating_action_id,action_at,conversion_at,attribution_window_seconds,confidence_level,confidence_score,reason,supporting_evidence,is_refunded,invalidated_at,updated_at',
      timeColumn: 'action_at', start: combinedStart, end: combinedEnd,
      filters: [query => query.eq('workspace_id', WORKSPACE_ID).eq('category', 'payment_recovery')]
    }),
    fetchPaged(client, {
      table: 'sms_sent_log',
      columns: 'id,order_id,flow_type,phone,message_body,telnyx_message_id,sent_at',
      timeColumn: 'sent_at', start: combinedStart, end: combinedEnd
    }),
    fetchPaged(client, {
      table: 'sms_messages',
      columns: 'id,telnyx_message_id,ghl_message_id,ghl_conversation_id,contact_phone,direction,body,status,reply_to_message_id,created_at',
      timeColumn: 'created_at', start: combinedStart, end: combinedEnd
    }),
    fetchPaged(client, {
      table: 'call_logs',
      columns: 'id,call_control_id,call_session_id,direction,contact_phone,from_number,to_number,status,duration_seconds,started_at,answered_at,ended_at',
      timeColumn: 'started_at', start: combinedStart, end: combinedEnd
    }),
    fetchPaged(client, {
      table: 'message_sentiment',
      columns: 'id,message_id,occurred_at,score,label,classifier_version,created_at',
      timeColumn: 'occurred_at', start: combinedStart, end: combinedEnd,
      filters: [query => query.eq('workspace_id', WORKSPACE_ID)]
    })
  ]);

  const names = ['attributions', 'recoveryAttributions', 'reminders', 'messages', 'calls', 'sentiments'];
  const source = {};
  const warnings = [];
  queries.forEach((result, index) => {
    source[names[index]] = result.rows;
    if (result.truncated) warnings.push({
      code: 'SOURCE_TRUNCATED',
      message: `${names[index]} reached the ${MAX_SOURCE_ROWS}-row safety ceiling for this range.`
    });
  });
  const coverage = sourceCoverage(range);
  warnings.push(...coverage.warnings);
  return { source, warnings, coverage: coverage.availability };
}

async function loadRulesAndState(client) {
  const [rulesResult, stateResult] = await Promise.all([
    client.from('analytics_attribution_rules')
      .select('business_timezone,currency,methodology_version')
      .eq('workspace_id', WORKSPACE_ID).maybeSingle(),
    client.from('analytics_state')
      .select('version,updated_at')
      .eq('workspace_id', WORKSPACE_ID).maybeSingle()
  ]);
  const error = rulesResult.error || stateResult.error;
  if (error) {
    if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
    throw error;
  }
  if (!rulesResult.data || !stateResult.data) throw new AnalyticsNotReadyError();
  return { rules: rulesResult.data, state: stateResult.data };
}

function publicRange(range) {
  return {
    period: range.period,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    timeZone: range.timeZone,
    previous: range.previous ? {
      start: range.previous.start.toISOString(),
      end: range.previous.end.toISOString()
    } : null
  };
}

function applyAttributionFilters(query, params = {}) {
  if (!params.includeInvalidated) query = query.is('invalidated_at', null);
  if (params.confidence) return query.eq('confidence_level', params.confidence);
  if ((params.scope || 'attributed') === 'attributed') {
    return query.in('confidence_level', ['direct', 'strong']); // bounded: fixed confidence taxonomy
  }
  if (params.scope === 'influenced') return query.eq('confidence_level', 'influenced');
  if (params.scope === 'unattributed') return query.eq('confidence_level', 'unattributed');
  return query;
}

function availabilityFor(source, current, backfillComplete, coverage) {
  return {
    // A handful of live rows must never make a broad historical total look
    // complete. Revenue-facing cards unlock only after one complete staged run
    // has been atomically promoted.
    revenueAttribution: Boolean(backfillComplete),
    paymentRecovery: Boolean(backfillComplete && coverage.paymentRecovery),
    messaging: Boolean(coverage.messaging),
    responsePerformance: Boolean(coverage.messaging),
    calls: Boolean(coverage.calls),
    sentiment: Boolean(coverage.messaging && current.sentiment.messagesAnalyzed > 0),
    historicalBackfill: Boolean(backfillComplete)
  };
}

async function historicalBackfillComplete(client) {
  const { count, error } = await client.from('analytics_backfill_runs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', WORKSPACE_ID).eq('mode', 'persist').eq('status', 'completed');
  if (error) {
    if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
    throw error;
  }
  return (count || 0) > 0;
}

function publicCampaign(campaign) {
  return {
    id: String(campaign.id),
    title: campaign.title,
    status: campaign.status,
    campaignType: campaign.campaign_type,
    workflowCategory: campaign.workflow_category,
    revision: campaign.revision,
    createdAt: campaign.created_at,
    scheduledFor: campaign.scheduled_for || null,
    completedAt: campaign.completed_at || null
  };
}

function filterCampaignAttributions(rows, params = {}) {
  return (rows || []).filter(row => {
    if (!params.includeInvalidated && row.invalidated_at) return false;
    if (params.confidence) return row.confidence_level === params.confidence;
    const scope = params.scope || 'attributed';
    if (scope === 'attributed') return row.confidence_level === 'direct' || row.confidence_level === 'strong';
    if (scope === 'influenced') return row.confidence_level === 'influenced';
    if (scope === 'unattributed') return row.confidence_level === 'unattributed';
    return true;
  });
}

function createAnalyticsService({ client, now = () => new Date(), reliableFrom = process.env.ANALYTICS_RELIABLE_FROM || '2026-01-16' }) {
  if (!client) throw new TypeError('Analytics client is required.');
  return {
    async overview(params = {}) {
      const { rules, state } = await loadRulesAndState(client);
      const range = rangeForPeriod({
        period: params.period || 'month',
        customStart: params.start,
        customEnd: params.end,
        now: now(),
        timeZone: rules.business_timezone,
        reliableFrom
      });
      const [{ source, warnings, coverage }, backfillComplete] = await Promise.all([
        loadAnalyticsSource(client, range),
        historicalBackfillComplete(client)
      ]);
      if (!backfillComplete) {
        warnings.unshift({
          code: 'HISTORICAL_BACKFILL_INCOMPLETE',
          message: 'Historical revenue review has not been promoted yet. Revenue totals may include live tracking only and must not be presented as complete history.'
        });
      }
      const eligibleSource = excludeAnalyticsSource(source);
      const current = aggregatePeriod(eligibleSource, range, rules.business_timezone);
      const previous = range.previous ? aggregatePeriod(eligibleSource, range.previous, rules.business_timezone) : null;
      current.sentiment.changeFromPrevious = sentimentChange(current, previous);
      const result = {
        generatedAt: now().toISOString(),
        version: Number(state.version),
        currency: rules.currency || 'USD',
        range: publicRange(range),
        revenue: { ...current.revenue },
        revenueDrivers: current.revenueDrivers,
        paymentRecovery: current.paymentRecovery,
        messaging: current.messaging,
        responsePerformance: current.responsePerformance,
        calls: current.calls,
        sentiment: current.sentiment,
        trends: trendMetrics(current, previous),
        activityGranularity: current.activityGranularity,
        activitySeries: current.activitySeries,
        availability: availabilityFor(eligibleSource, current, backfillComplete, coverage),
        warnings
      };
      return result;
    },

    async attributions(params = {}) {
      const { rules } = await loadRulesAndState(client);
      const range = rangeForPeriod({
        period: params.period || 'month',
        customStart: params.start,
        customEnd: params.end,
        now: now(),
        timeZone: rules.business_timezone,
        reliableFrom
      });
      const page = Math.max(1, Math.floor(Number(params.page) || 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.pageSize) || 25)));
      let query = client.from('revenue_attributions')
        .select('id,order_id,customer_id,currency,gross_amount,refunded_amount,net_amount,category,workflow,originating_action_type,originating_action_id,action_at,conversion_at,attribution_window_seconds,confidence_level,confidence_score,reason,supporting_evidence,is_refunded,invalidated_at', { count: 'exact' })
        .eq('workspace_id', WORKSPACE_ID)
        .gte('conversion_at', range.start.toISOString()).lt('conversion_at', range.end.toISOString())
        .order('conversion_at', { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
      query = applyAttributionFilters(query, params);
      if (params.category) query = query.eq('category', params.category);
      const { data, count, error } = await query;
      if (error) {
        if (isMissingAnalyticsSchema(error)) throw new AnalyticsNotReadyError();
        throw error;
      }
      const items = (data || []).map(publicAttribution);
      return {
        generatedAt: now().toISOString(),
        currency: rules.currency || 'USD',
        range: publicRange(range),
        scope: params.confidence || params.scope || 'attributed',
        items,
        pagination: { page, pageSize, total: count || 0, hasMore: page * pageSize < (count || 0) },
        warnings: []
      };
    },

    async campaignOverview(campaignID) {
      const [{ rules }, source, generationReady] = await Promise.all([
        loadRulesAndState(client),
        loadCampaignAnalyticsSource(client, campaignID),
        campaignAttributionGenerationReady(client, WORKSPACE_ID)
      ]);
      const operational = campaignOperationalMetrics(source.recipients, source.events);
      const financial = campaignFinancialMetrics({
        campaignID,
        workspaceID: WORKSPACE_ID,
        recipients: source.recipients,
        events: source.events,
        attributions: source.attributions
      });
      const warnings = [...source.warnings];
      if (!generationReady) warnings.unshift({
        code: 'CAMPAIGN_ATTRIBUTION_GENERATION_UNAVAILABLE',
        message: 'Campaign revenue attribution tracking is not enabled yet. Operational delivery and reply metrics remain available.'
      });
      return {
        generatedAt: now().toISOString(),
        currency: rules.currency || 'USD',
        campaign: publicCampaign(source.campaign),
        operational,
        orders: {
          revenueImpact: financial.revenueImpactOrders,
          attributed: financial.attributedOrders,
          influenced: financial.influencedOrders,
          byConfidence: financial.ordersByConfidence
        },
        conversion: {
          recipients: financial.convertedRecipients,
          rate: financial.conversionRate,
          basis: financial.conversionRateBasis
        },
        revenue: financial.revenue,
        availability: {
          operational: true,
          revenueAttribution: generationReady
        },
        warnings
      };
    },

    async campaignAttributions(campaignID, params = {}) {
      const [{ rules }, source] = await Promise.all([
        loadRulesAndState(client),
        loadCampaignAnalyticsSource(client, campaignID)
      ]);
      const campaignRows = campaignAttributionRows({
        campaignID, workspaceID: WORKSPACE_ID,
        recipients: source.recipients, attributions: source.attributions
      });
      const filtered = filterCampaignAttributions(campaignRows, params)
        .sort((left, right) => (validTime(right.conversion_at) || 0) - (validTime(left.conversion_at) || 0));
      const page = Math.max(1, Math.floor(Number(params.page) || 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.pageSize) || 25)));
      const start = (page - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize)
        .map(row => publicCampaignAttribution(row, campaignID));
      return {
        generatedAt: now().toISOString(),
        currency: rules.currency || 'USD',
        campaign: publicCampaign(source.campaign),
        scope: params.confidence || params.scope || 'attributed',
        items,
        pagination: {
          page, pageSize, total: filtered.length,
          hasMore: start + pageSize < filtered.length
        },
        warnings: source.warnings
      };
    }
  };
}

function evidenceCodes(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const codes = [];
  if (evidence.authoritativePayment) codes.push('authoritative_payment');
  if (evidence.exactOrderMatch) codes.push('exact_order_match');
  if (evidence.reminderFlow || evidence.reminderLogID) codes.push('payment_reminder');
  if (evidence.paymentConfirmationMessageID) codes.push('payment_confirmation');
  const safeCampaignCodes = new Set([
    'trusted_provider_delivery', 'exact_recipient_customer_id', 'exact_recipient_phone',
    'inside_attribution_window', 'exact_target_product', 'verified_recipient_order_link',
    'verified_unique_recipient_coupon', 'trusted_rule_based_purchase_confirmation',
    'outside_attribution_window', 'target_product_not_in_order', 'target_product_evidence_missing',
    'recipient_identity_not_exact', 'customer_id_conflict', 'contradictory_evidence'
  ]);
  for (const code of Array.isArray(evidence.codes) ? evidence.codes : []) {
    if (safeCampaignCodes.has(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Customer-facing attribution copy must never come from the free-text database
 * reason. That field is useful for internal reconciliation and may contain
 * imported provider/customer detail. Public explanations are deterministic
 * and use only the fixed confidence taxonomy plus allowlisted evidence codes.
 */
function publicAttributionExplanation(level, codes = [], invalidatedAt = null) {
  const evidence = new Set(codes);
  if (invalidatedAt) {
    return 'Later authoritative evidence invalidated this attribution, so it is excluded from active totals.';
  }
  if (level === 'direct') {
    if (evidence.has('payment_confirmation') && evidence.has('authoritative_payment')) {
      return 'An app interaction and authoritative payment confirmation directly link this order.';
    }
    if (evidence.has('trusted_provider_delivery') && evidence.has('exact_target_product')) {
      return 'Trusted campaign delivery and an exact matching product conversion directly link this order.';
    }
    return 'Structured communication and order evidence directly link this conversion to the app.';
  }
  if (level === 'strong') {
    return 'The exact customer or order match and conversion timing strongly link this revenue to the app.';
  }
  if (level === 'influenced') {
    return 'The app interaction occurred before the purchase, but the available evidence cannot prove it caused the order.';
  }
  if (evidence.has('outside_attribution_window')) {
    return 'The order occurred outside the approved attribution window and remains Unattributed.';
  }
  if (evidence.has('target_product_not_in_order') || evidence.has('target_product_evidence_missing')) {
    return 'The available product evidence does not match the campaign closely enough to attribute this order.';
  }
  if (evidence.has('recipient_identity_not_exact') || evidence.has('customer_id_conflict') ||
      evidence.has('contradictory_evidence')) {
    return 'Customer or order evidence is incomplete or contradictory, so this revenue remains Unattributed.';
  }
  return 'There is not enough verified evidence to fairly attribute this order to the app.';
}

function publicAttribution(row) {
  const level = CONFIDENCE_LEVELS.includes(row.confidence_level) ? row.confidence_level : 'unattributed';
  const safeEvidence = evidenceCodes(row.supporting_evidence);
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    customerId: row.customer_id ? String(row.customer_id) : null,
    category: row.category || null,
    workflow: row.workflow || null,
    grossAmount: centsToDecimal(moneyToCents(row.gross_amount)),
    refundedAmount: centsToDecimal(moneyToCents(row.refunded_amount)),
    netAmount: centsToDecimal(moneyToCents(row.net_amount)),
    confidenceLevel: level,
    confidenceScore: CONFIDENCE_SCORES[level],
    confidenceLabel: CONFIDENCE_LABELS[level],
    originatingActionType: row.originating_action_type || null,
    originatingActionId: row.originating_action_id || null,
    actionAt: row.action_at || null,
    conversionAt: row.conversion_at || null,
    attributionWindowSeconds: row.attribution_window_seconds === null ? null : clampNumber(row.attribution_window_seconds),
    reason: publicAttributionExplanation(level, safeEvidence, row.invalidated_at),
    supportingEvidence: safeEvidence,
    isRefunded: Boolean(row.is_refunded),
    invalidatedAt: row.invalidated_at || null
  };
}

function publicCampaignAttribution(row, campaignID) {
  const item = publicAttribution(row);
  // A campaign drill-down is order/evidence based. Customer and recipient IDs
  // are unnecessary for that explanation and are therefore not serialized.
  delete item.customerId;
  return { ...item, campaignId: String(campaignID) };
}

module.exports = {
  AnalyticsNotReadyError,
  CampaignAnalyticsNotFoundError,
  CampaignAnalyticsNotReadyError,
  MAX_SOURCE_ROWS,
  aggregateCalls,
  activityGranularity,
  activitySeries,
  applyAttributionFilters,
  aggregateMessaging,
  aggregatePaymentRecovery,
  aggregatePeriod,
  aggregateResponseEpisodes,
  aggregateRevenue,
  aggregateRevenueDrivers,
  aggregateSentiment,
  availabilityFor,
  centsToDecimal,
  createAnalyticsService,
  decimalToCents,
  evidenceCodes,
  fetchCampaignAttributions,
  fetchPaged,
  filterCampaignAttributions,
  isMissingAnalyticsSchema,
  publicAttribution,
  publicAttributionExplanation,
  publicCampaignAttribution,
  sentimentChange,
  sourceCoverage
};
