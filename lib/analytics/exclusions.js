'use strict';

const { normalisePhone } = require('../phone');

function csvSet(value, normalise = item => item) {
  return new Set(String(value || '')
    .split(',')
    .map(item => normalise(item.trim()))
    .filter(Boolean));
}

function analyticsExclusions(env = process.env) {
  return {
    phones: csvSet(env.ANALYTICS_EXCLUDED_PHONES, normalisePhone),
    orderIDs: csvSet(env.ANALYTICS_EXCLUDED_ORDER_IDS, String)
  };
}

function isExcludedIdentity({ phone, orderID } = {}, exclusions = analyticsExclusions()) {
  const normalisedPhone = normalisePhone(phone);
  return Boolean(
    (normalisedPhone && exclusions.phones.has(normalisedPhone)) ||
    (orderID !== null && orderID !== undefined && exclusions.orderIDs.has(String(orderID)))
  );
}

function excludeAnalyticsSource(source, exclusions = analyticsExclusions()) {
  const included = (phone, orderID) => !isExcludedIdentity({ phone, orderID }, exclusions);
  const messages = (source.messages || []).filter(row => included(row.contact_phone));
  const messageIDs = new Set(messages.map(row => String(row.id)).filter(Boolean));
  return {
    ...source,
    messages,
    reminders: (source.reminders || []).filter(row => included(row.phone, row.order_id)),
    calls: (source.calls || []).filter(row => included(row.contact_phone)),
    attributions: (source.attributions || []).filter(row => included(row.contact_phone, row.order_id)),
    recoveryAttributions: (source.recoveryAttributions || []).filter(row => included(row.contact_phone, row.order_id)),
    sentiments: (source.sentiments || []).filter(row => messageIDs.has(String(row.message_id)))
  };
}

module.exports = { analyticsExclusions, excludeAnalyticsSource, isExcludedIdentity };
