#!/usr/bin/env node
'use strict';

/**
 * Aggregate-only, read-only Vici campaign opportunity and cadence dry run.
 *
 * It never creates a campaign, writes consent, changes a contact, or calls a
 * messaging provider. Output intentionally contains no customer name, phone,
 * email, order ID, message body, or product title.
 */

require('dotenv').config();

const { supabase } = require('../db');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { analyticsExclusions, isExcludedIdentity } = require('../lib/analytics/exclusions');
const {
  cadenceFromIntervals,
  calculateReorderCadence,
  intervalDays,
  qualifyingPurchaseTimes
} = require('../lib/campaigns/reorder-cadence');
const { qualifyWinback } = require('../lib/campaigns/winback');
const { resolveOpportunityCollision } = require('../lib/campaigns/opportunity-policy');
const { activeSuppressionReason } = require('../lib/campaigns/eligibility');

const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);
const WORKSPACE_ID = 'vici';

function missingRelation(error) {
  return ['42P01', 'PGRST204', 'PGRST205'].includes(error?.code) ||
    /does not exist|could not find|schema cache/i.test(String(error?.message || ''));
}

async function optionalRows(table, columns, orderBy = 'id') {
  try {
    return { available: true, rows: await fetchAllRows(supabase, table, columns, { orderBy }) };
  } catch (error) {
    if (missingRelation(error)) return { available: false, rows: [] };
    throw error;
  }
}

function itemsFor(order) {
  if (Array.isArray(order.items)) return order.items;
  if (typeof order.items === 'string') {
    try {
      const parsed = JSON.parse(order.items);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function productKey(item) {
  const variation = Number(item?.variation_id);
  const product = Number(item?.product_id);
  if (Number.isSafeInteger(variation) && variation > 0) return { key: `variation:${variation}`, quality: 'exact_id' };
  if (Number.isSafeInteger(product) && product > 0) return { key: `product:${product}`, quality: 'exact_id' };
  const sku = String(item?.sku || '').trim().toLowerCase();
  if (sku) return { key: `sku:${sku}`, quality: 'sku' };
  const name = String(item?.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return name ? { key: `legacy-name:${name}`, quality: 'legacy_name' } : null;
}

function validConsent(event) {
  return event?.event_type === 'opt_in' && event?.purpose === 'promotional_sms' &&
    event?.brand_id === 'vici' && typeof event?.source === 'string' && event.source.trim() &&
    typeof event?.evidence_ref === 'string' && event.evidence_ref.trim() &&
    Number.isFinite(Date.parse(event?.occurred_at));
}

function currentConsentByPhone(events) {
  const grouped = new Map();
  for (const event of events) {
    const phone = String(event.contact_phone || '');
    if (!phone) continue;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(event);
  }
  const active = new Set();
  for (const [phone, rows] of grouped) {
    const latest = rows.filter(row => Number.isFinite(Date.parse(row.occurred_at)))
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || Number(b.id || 0) - Number(a.id || 0))[0];
    if (validConsent(latest)) active.add(phone);
  }
  return active;
}

function groupByPhone(rows, field = 'phone') {
  const grouped = new Map();
  for (const row of rows || []) {
    const phone = String(row?.[field] || '');
    if (!phone) continue;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(row);
  }
  return grouped;
}

function rowsForWorkspace(rows, workspaceID = WORKSPACE_ID) {
  return (rows || []).filter(row => row?.workspace_id === workspaceID);
}

function acceptedPromotionalTimes(rows = [], now = new Date()) {
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const seen = new Set();
  const times = [];
  for (const row of rows || []) {
    if (row?.classification !== 'promotional') continue;
    const key = String(row?.idempotency_key || row?.provider_message_id || row?.id || '');
    const time = Date.parse(row?.accepted_at);
    if (!key || seen.has(key) || !Number.isFinite(time) || time > nowTime) continue;
    seen.add(key);
    times.push(time);
  }
  return times.sort((a, b) => a - b);
}

function currentDndReason(contact, now = new Date(), maxAgeHours = 24) {
  if (!contact) return 'dnd_unknown';
  if (contact.opted_out === true) return 'opted_out';
  if (contact.ghl_dnd === true || ['active', 'permanent'].includes(contact.ghl_sms_dnd_status)) return 'dnd';
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const observed = Date.parse(contact.ghl_dnd_synced_at);
  if (contact.ghl_dnd !== false || contact.ghl_sms_dnd_status !== 'inactive' ||
      !Number.isFinite(observed) || observed > nowTime ||
      observed < nowTime - maxAgeHours * 60 * 60 * 1000) return 'dnd_unknown';
  return null;
}

function evaluateCadenceScenarios({
  selected = [], consented = new Set(), optedOut = new Set(), contacts = [],
  suppressions = [], ledger = [], now = new Date(), monthlyLimits = [2, 4, 6],
  dndAvailable = true, suppressionsAvailable = true, ledgerAvailable = true
} = {}) {
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error('now must be a valid date.');
  const contactByPhone = new Map((contacts || []).map(row => [String(row.phone || ''), row]));
  const suppressionsByPhone = groupByPhone(suppressions, 'contact_phone');
  const ledgerByPhone = groupByPhone(ledger, 'contact_phone');

  return monthlyLimits.map(monthlyLimit => {
    const reasons = {};
    let allowed = 0;
    for (const row of selected) {
      const phone = String(row.phone || '');
      let reason = null;
      if (!consented.has(phone)) reason = 'unknown_or_insufficient_consent';
      else if (optedOut.has(phone)) reason = 'opted_out';
      else if (!suppressionsAvailable) reason = 'authoritative_suppression_unknown';
      else if (activeSuppressionReason(suppressionsByPhone.get(phone) || [], now)) reason = 'authoritative_suppression';
      else if (!dndAvailable) reason = 'dnd_unknown';
      else reason = currentDndReason(contactByPhone.get(phone), now);
      if (!reason) {
        if (!ledgerAvailable) reason = 'cadence_ledger_unavailable';
        const contactsAt = reason ? [] : acceptedPromotionalTimes(ledgerByPhone.get(phone) || [], now);
        if (contactsAt.some(time => time > nowTime - 24 * 60 * 60 * 1000)) reason = 'minimum_spacing';
        else if (contactsAt.filter(time => time > nowTime - 7 * 86400000).length >= 2) reason = 'rolling_week_cap';
        else if (contactsAt.filter(time => time > nowTime - 30 * 86400000).length >= monthlyLimit) reason = 'rolling_month_cap';
      }
      if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
      else allowed += 1;
    }
    return {
      monthlyLimit,
      opportunitiesIdentified: selected.length,
      sendsAllowedNow: allowed,
      sendsSuppressedNow: selected.length - allowed,
      suppressionReasons: reasons,
      note: 'One current opportunity per customer was selected. This is an eligibility scenario, not a revenue or fatigue claim.'
    };
  });
}

async function run(now = new Date()) {
  const [orderResult, sentinelResult, consentResult, contactResult, suppressionResult, ledgerResult] = await Promise.all([
    optionalRows('sms_orders', 'id,woo_order_id,contact_phone,status,items,total,created_at', 'created_at'),
    optionalRows('sms_sent_log', 'id,phone,flow_type,sent_at', 'id'),
    optionalRows('sms_consent_events', 'id,workspace_id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,occurred_at', 'id'),
    optionalRows('sms_contacts', 'phone,opted_out,ghl_dnd,ghl_sms_dnd_status,ghl_dnd_synced_at', 'id'),
    optionalRows('sms_campaign_suppressions', 'id,workspace_id,contact_phone,reason_code,active,effective_at,expires_at', 'created_at'),
    optionalRows('sms_commercial_contact_ledger', 'id,workspace_id,contact_phone,classification,idempotency_key,provider_message_id,accepted_at', 'created_at')
  ]);
  if (!orderResult.available) throw new Error('sms_orders is unavailable.');

  const exclusions = analyticsExclusions();
  const uniqueOrders = new Map();
  for (const row of orderResult.rows) {
    const orderID = String(row.woo_order_id ?? row.id ?? '');
    if (!orderID || uniqueOrders.has(orderID)) continue;
    if (isExcludedIdentity({ phone: row.contact_phone, orderID }, exclusions)) continue;
    if (!PAID_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    if (!row.contact_phone || !Number.isFinite(Date.parse(row.created_at))) continue;
    uniqueOrders.set(orderID, row);
  }

  const groups = new Map();
  const productCustomers = new Map();
  const identityQuality = { exact_id: 0, sku: 0, legacy_name: 0 };
  for (const order of uniqueOrders.values()) {
    const seenInOrder = new Set();
    for (const item of itemsFor(order)) {
      const identity = productKey(item);
      if (!identity || seenInOrder.has(identity.key)) continue;
      seenInOrder.add(identity.key);
      identityQuality[identity.quality] += 1;
      const key = `${order.contact_phone}\u0000${identity.key}`;
      if (!groups.has(key)) groups.set(key, {
        phone: order.contact_phone,
        productKey: identity.key,
        productQuality: identity.quality,
        purchases: []
      });
      groups.get(key).purchases.push({
        id: order.woo_order_id,
        status: order.status,
        createdAt: order.created_at,
        total: order.total
      });
      if (!productCustomers.has(identity.key)) productCustomers.set(identity.key, new Map());
      const byPhone = productCustomers.get(identity.key);
      if (!byPhone.has(order.contact_phone)) byPhone.set(order.contact_phone, []);
      byPhone.get(order.contact_phone).push(order.created_at);
    }
  }

  const productCadences = new Map();
  for (const [key, customers] of productCustomers) {
    const intervals = [];
    for (const dates of customers.values()) {
      intervals.push(...intervalDays(qualifyingPurchaseTimes(dates)));
    }
    productCadences.set(key, { intervals, uniqueCustomers: customers.size });
  }

  const opportunitiesByPhone = new Map();
  let reliablePersonalCadences = 0;
  let reliableProductCadences = 0;
  for (const group of groups.values()) {
    const result = calculateReorderCadence({
      purchases: group.purchases,
      productCadence: productCadences.get(group.productKey),
      now
    });
    if (!result.cadence?.reliable) continue;
    if (result.source === 'personal') reliablePersonalCadences += 1;
    if (result.source === 'product') reliableProductCadences += 1;

    const opportunities = [];
    if (result.eligible) {
      opportunities.push({
        id: `reorder:${group.productKey}`,
        type: result.cadence.confidence === 'high' ? 'reorder_personal_high' : 'reorder_personal',
        cadenceConfidence: result.cadence.confidence === 'high' ? 1 : 0.75,
        createdAt: now.toISOString(),
        expiresAt: result.expectedRange.end
      });
    }
    const winback = qualifyWinback({
      cadence: result.cadence,
      lastPurchaseAt: result.lastPurchaseAt,
      lifetimePurchaseCount: result.purchaseCount,
      now
    });
    if (winback.qualifies) {
      opportunities.push({
        id: `winback:${group.productKey}`,
        type: 'winback',
        cadenceConfidence: result.cadence.confidence === 'high' ? 1 : 0.75,
        createdAt: now.toISOString(),
        expiresAt: winback.expiresAt
      });
    }
    if (!opportunities.length) continue;
    if (!opportunitiesByPhone.has(group.phone)) opportunitiesByPhone.set(group.phone, []);
    opportunitiesByPhone.get(group.phone).push(...opportunities);
  }

  const selected = [];
  let collisionSuppressions = 0;
  for (const [phone, opportunities] of opportunitiesByPhone) {
    const result = resolveOpportunityCollision(opportunities, { now });
    if (result.selected) selected.push({ phone, opportunity: result.selected });
    collisionSuppressions += result.suppressed.length;
  }

  const optedOut = new Set(sentinelResult.rows
    .filter(row => row.flow_type === 'opted-out')
    .map(row => row.phone)
    .filter(Boolean));
  const consented = currentConsentByPhone(rowsForWorkspace(consentResult.rows));
  const scenarios = evaluateCadenceScenarios({
    selected,
    consented,
    optedOut,
    contacts: contactResult.rows,
    suppressions: rowsForWorkspace(suppressionResult.rows),
    ledger: rowsForWorkspace(ledgerResult.rows),
    now,
    dndAvailable: contactResult.available,
    suppressionsAvailable: suppressionResult.available,
    ledgerAvailable: ledgerResult.available
  });
  const eligibleNow = scenarios.find(row => row.monthlyLimit === 4)?.sendsAllowedNow || 0;
  const suppressions = scenarios.find(row => row.monthlyLimit === 4)?.suppressionReasons || {};

  const byType = {};
  for (const row of selected) byType[row.opportunity.type] = (byType[row.opportunity.type] || 0) + 1;
  return {
    generatedAt: now.toISOString(),
    mode: 'read_only_aggregate_dry_run',
    source: {
      paidOrdersAnalyzed: uniqueOrders.size,
      customerProductGroups: groups.size,
      consentLedgerAvailable: consentResult.available,
      optOutSentinelAvailable: sentinelResult.available,
      dndStateAvailable: contactResult.available,
      authoritativeSuppressionsAvailable: suppressionResult.available,
      commercialContactLedgerAvailable: ledgerResult.available,
      productIdentityObservations: identityQuality
    },
    cadence: { reliablePersonalCadences, reliableProductCadences },
    opportunities: {
      selectedCustomers: selected.length,
      byType,
      collisionSuppressions,
      eligibleNow,
      suppressions
    },
    scenarios,
    limitations: [
      'Historical sms_orders use order creation time because an authoritative paid timestamp is not stored on that operational table.',
      'Legacy order items without Woo product or variation IDs are grouped by SKU or normalized historical name and are not exact-product evidence.',
      'Back-in-stock candidates require future verified inventory transitions and are not reconstructed from ordinary product edits.',
      'Promotional consent is never inferred from an order, phone number, transactional message or contact record.',
      'Frequency scenarios use the commercial-contact ledger only when its migration is present; a missing ledger yields no historical cadence evidence and must be reported.',
      'No scenario estimates fatigue, conversion or revenue without authoritative historical outcome evidence.'
    ]
  };
}

if (require.main === module) {
  run().then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    console.error(`[CAMPAIGN DRY RUN] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  acceptedPromotionalTimes,
  currentConsentByPhone,
  currentDndReason,
  evaluateCadenceScenarios,
  productKey,
  rowsForWorkspace,
  run
};
