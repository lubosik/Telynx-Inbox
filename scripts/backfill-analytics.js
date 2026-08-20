#!/usr/bin/env node
'use strict';

/**
 * Historical revenue-attribution candidate builder.
 *
 * SAFETY
 *   * Dry-run is the default and performs read-only Supabase/WooCommerce reads.
 *   * No phone numbers, customer names, emails, addresses, or message bodies are
 *     printed or written to candidate/report files.
 *   * Persistence requires BOTH --persist and ANALYTICS_BACKFILL_APPROVED=YES.
 *   * Historical Influenced revenue is intentionally disabled: weak evidence
 *     remains Unattributed.
 *
 * Review docs/analytics/REVENUE-ATTRIBUTION-METHODOLOGY.md before use.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  CONFIDENCE,
  DEFAULT_WINDOWS,
  PAYMENT_REMINDER_FLOWS,
  classifyPaymentRecovery,
  isActualReminder,
  isPaymentConfirmation
} = require('../lib/analytics/attribution');
const { normalizePhone, wooGet } = require('../woocommerce');

const WORKSPACE_ID = 'vici';
const METHODOLOGY_VERSION = 'vici-revenue-v1';
const PAGE_SIZE = 1000;
const AMBIGUOUS_REMINDER = /\b(?:two orders|both orders|orders\s+#|lock them both|combined orders?)\b/i;
const TEST_META_KEYS = new Set(['_analytics_test', 'analytics_test', '_test_order', 'test_order']);

function parseCSV(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

function parseArgs(argv) {
  const args = { persist: false, candidateJSON: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--persist') args.persist = true;
    else if (arg === '--candidate-json') args.candidateJSON = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if ((args.candidateJSON === undefined) || (args.report === undefined)) {
    throw new Error('--candidate-json and --report require a file path.');
  }
  return args;
}

function persistenceAllowed(args, env = process.env) {
  return args.persist === true && env.ANALYTICS_BACKFILL_APPROVED === 'YES';
}

function paidTimestamp(order) {
  const value = order?.date_paid_gmt || order?.date_paid;
  if (!value) return null;
  const withZone = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  return Number.isFinite(Date.parse(withZone)) ? withZone : null;
}

function refundTotal(order) {
  const gross = Math.max(0, Number(order?.total) || 0);
  const refunded = (order?.refunds || []).reduce((sum, refund) => {
    return sum + Math.abs(Number(refund?.total ?? refund?.amount) || 0);
  }, 0);
  return Math.min(gross, Number(refunded.toFixed(2)));
}

function isTruthyMeta(value) {
  if (value === true || value === 1) return true;
  return ['true', 'yes', '1', 'test'].includes(String(value || '').toLowerCase());
}

function isExcludedOrder(order, options = {}) {
  const orderID = String(order?.id || '');
  const phone = normalizePhone(order?.billing?.phone || order?.shipping?.phone);
  if (options.excludedOrderIDs?.has(orderID)) return true;
  if (phone && options.excludedPhones?.has(phone)) return true;
  return (order?.meta_data || []).some(meta => TEST_META_KEYS.has(String(meta?.key || '').toLowerCase()) && isTruthyMeta(meta?.value));
}

function safeID(value) {
  return value === null || value === undefined ? null : String(value);
}

function unattributedRecord(order, reason, refundedAmount = refundTotal(order)) {
  const grossAmount = Math.max(0, Number(order?.total) || 0);
  return {
    orderID: safeID(order?.id),
    customerID: safeID(order?.customer_id),
    contactPhone: normalizePhone(order?.billing?.phone || order?.shipping?.phone),
    currency: order?.currency || 'USD',
    confidenceLevel: 'unattributed',
    confidenceScore: CONFIDENCE.unattributed,
    category: null,
    workflow: null,
    action: null,
    conversionAt: paidTimestamp(order),
    attributionWindowSeconds: null,
    reason,
    evidence: { authoritativePayment: Boolean(paidTimestamp(order)), exactOrderMatch: false },
    grossAmount,
    refundedAmount,
    netAmount: Math.max(0, grossAmount - refundedAmount)
  };
}

function providerStatusMap(messages) {
  const statuses = new Map();
  for (const message of messages || []) {
    if (!message?.telnyx_message_id || message.ghl_message_id) continue;
    const current = statuses.get(message.telnyx_message_id);
    if (!current || message.status === 'delivered') statuses.set(message.telnyx_message_id, message.status || null);
  }
  return statuses;
}

function groupInbound(messages) {
  const grouped = new Map();
  for (const message of messages || []) {
    if (message?.direction !== 'inbound') continue;
    const phone = normalizePhone(message.contact_phone);
    if (!phone) continue;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(message);
  }
  return grouped;
}

function publicCandidate(record) {
  return {
    order_id: record.orderID,
    customer_id: record.customerID,
    currency: record.currency,
    gross_amount: Number(record.grossAmount.toFixed(2)),
    refunded_amount: Number(record.refundedAmount.toFixed(2)),
    net_amount: Number(record.netAmount.toFixed(2)),
    category: record.category,
    workflow: record.workflow,
    originating_action_id: record.action?.messageID || record.action?.id || null,
    action_at: record.action?.occurredAt || null,
    conversion_at: record.conversionAt,
    attribution_window_seconds: record.attributionWindowSeconds,
    confidence_level: record.confidenceLevel,
    confidence_score: record.confidenceScore,
    reason: record.reason,
    supporting_evidence: record.evidence
  };
}

function analyseHistoricalRevenue({ orders = [], sentLogs = [], messages = [] }, options = {}) {
  const excludedPhones = options.excludedPhones || new Set();
  const excludedOrderIDs = options.excludedOrderIDs || new Set();
  const statuses = providerStatusMap(messages);
  const inboundByPhone = groupInbound(messages);
  const logsByOrder = new Map();
  const reminderLogs = [];

  for (const log of sentLogs) {
    if (!PAYMENT_REMINDER_FLOWS.has(log?.flow_type)) continue;
    reminderLogs.push(log);
    const orderID = safeID(log.order_id);
    if (!orderID) continue;
    if (!logsByOrder.has(orderID)) logsByOrder.set(orderID, []);
    logsByOrder.get(orderID).push({
      ...log,
      delivery_status: statuses.get(log.telnyx_message_id) || null
    });
  }

  // A single customer confirmation may strengthen only one order: the exact
  // order on the latest delivered recovery touch preceding that reply. This
  // prevents one short “sent” response from upgrading several overlapping
  // outstanding orders to Direct.
  const deliveredActionsByPhone = new Map();
  for (const [orderID, logs] of logsByOrder) {
    for (const log of logs.filter(isActualReminder)) {
      const phone = normalizePhone(log.phone);
      if (!phone || String(log.message_body || '').startsWith('BACKFILL ')) continue;
      if (!deliveredActionsByPhone.has(phone)) deliveredActionsByPhone.set(phone, []);
      deliveredActionsByPhone.get(phone).push({ orderID, sentAt: Date.parse(log.sent_at) });
    }
  }
  const confirmationOrderByMessage = new Map();
  for (const [phone, inbound] of inboundByPhone) {
    const actions = deliveredActionsByPhone.get(phone) || [];
    for (const message of inbound) {
      if (!isPaymentConfirmation(message.body)) continue;
      const replyAt = Date.parse(message.created_at);
      if (!Number.isFinite(replyAt)) continue;
      const winner = actions.filter(action => action.sentAt <= replyAt)
        .sort((left, right) => right.sentAt - left.sentAt || left.orderID.localeCompare(right.orderID))[0];
      if (winner) confirmationOrderByMessage.set(safeID(message.id), winner.orderID);
    }
  }

  const orderMultiplicity = new Map();
  for (const order of orders) {
    const orderID = safeID(order?.id);
    if (orderID) orderMultiplicity.set(orderID, (orderMultiplicity.get(orderID) || 0) + 1);
  }
  const wooOrderIDs = new Set(orderMultiplicity.keys());
  const records = [];

  for (const order of orders) {
    const conversionAt = paidTimestamp(order);
    if (!conversionAt) continue;
    const orderID = safeID(order.id);
    const orderPhone = normalizePhone(order?.billing?.phone || order?.shipping?.phone);
    const refundedAmount = refundTotal(order);
    let record;

    if (!orderID || !/^\d+$/.test(orderID)) {
      record = unattributedRecord(order, 'Order identifier is missing or non-numeric.', refundedAmount);
    } else if (orderMultiplicity.get(orderID) !== 1) {
      record = unattributedRecord(order, 'Duplicate authoritative order records make the source ambiguous.', refundedAmount);
    } else if (isExcludedOrder(order, { excludedPhones, excludedOrderIDs })) {
      record = unattributedRecord(order, 'Order is explicitly marked as test or internal data.', refundedAmount);
    } else if (refundedAmount > 0 || order.status === 'refunded') {
      record = unattributedRecord(order, 'Historical order has refund activity and is excluded pending refund reconciliation.', refundedAmount);
    } else {
      const reminders = logsByOrder.get(orderID) || [];
      const realReminders = reminders.filter(row => !String(row.message_body || '').startsWith('BACKFILL '));
      const reminderPhones = new Set(realReminders.map(row => normalizePhone(row.phone)).filter(Boolean));
      const identityMatched = Boolean(orderPhone && reminderPhones.has(orderPhone));
      const ambiguousOrderMatch = realReminders.some(row => AMBIGUOUS_REMINDER.test(row.message_body || ''));
      const inboundMessages = orderPhone
        ? (inboundByPhone.get(orderPhone) || []).filter(message => confirmationOrderByMessage.get(safeID(message.id)) === orderID)
        : [];

      record = {
        ...classifyPaymentRecovery({
          order: {
            id: orderID,
            total: order.total,
            refunded_amount: 0,
            date_paid_gmt: conversionAt
          },
          reminders,
          inboundMessages,
          identityMatched,
          ambiguousOrderMatch,
          windows: options.windows || DEFAULT_WINDOWS
        }),
        customerID: safeID(order.customer_id),
        contactPhone: orderPhone,
        currency: order.currency || 'USD'
      };

      const genuineForOrder = realReminders.filter(isActualReminder);
      if (record.confidenceLevel === 'unattributed' && genuineForOrder.length === 0) {
        record.reason = 'No genuine payment reminder for this exact order preceded payment.';
      } else if (record.confidenceLevel === 'unattributed' && genuineForOrder.length &&
          genuineForOrder.every(row => Date.parse(row.sent_at) >= Date.parse(conversionAt))) {
        record.reason = 'Authoritative payment occurred before the delivered reminder; no recovery credit is allowed.';
      }
    }
    records.push(record);
  }

  // One authoritative output row per order even when a malformed API page
  // repeats an order. Duplicate IDs are retained once as Unattributed.
  const unique = new Map();
  for (const record of records) if (!unique.has(record.orderID)) unique.set(record.orderID, record);
  const uniqueRecords = [...unique.values()];

  const totals = { direct: 0, strong: 0, influenced: 0, unattributed: 0 };
  const amounts = { direct: 0, strong: 0, influenced: 0, unattributed: 0 };
  for (const record of uniqueRecords) {
    totals[record.confidenceLevel] += 1;
    amounts[record.confidenceLevel] += record.netAmount;
  }
  for (const key of Object.keys(amounts)) amounts[key] = Number(amounts[key].toFixed(2));

  const numericReminderOrderIDs = new Set(reminderLogs.map(row => safeID(row.order_id)).filter(id => /^\d+$/.test(id || '')));
  const exactWooReminderIDs = new Set([...numericReminderOrderIDs].filter(id => wooOrderIDs.has(id)));
  const phoneMatchedReminderIDs = new Set();
  for (const order of orders) {
    const orderID = safeID(order?.id);
    if (!exactWooReminderIDs.has(orderID)) continue;
    const phone = normalizePhone(order?.billing?.phone || order?.shipping?.phone);
    const matched = (logsByOrder.get(orderID) || []).some(log => normalizePhone(log.phone) === phone);
    if (phone && matched) phoneMatchedReminderIDs.add(orderID);
  }

  return {
    records: uniqueRecords,
    publicCandidates: uniqueRecords.map(publicCandidate),
    aggregate: {
      woo_orders_examined: orders.length,
      paid_orders_examined: uniqueRecords.length,
      recovery_reminder_rows: reminderLogs.length,
      unique_reminder_order_ids: new Set(reminderLogs.map(row => safeID(row.order_id)).filter(Boolean)).size,
      numeric_reminder_order_ids: numericReminderOrderIDs.size,
      reminder_order_ids_found_in_woo: exactWooReminderIDs.size,
      reminder_order_ids_with_phone_match: phoneMatchedReminderIDs.size,
      counts: totals,
      net_amounts: amounts,
      historical_influenced_enabled: false
    }
  };
}

async function fetchAllRows(client, table, columns) {
  const rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await client.from(table).select(columns).range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllWooOrders() {
  const orders = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data, headers } = await wooGet('/orders', { per_page: 100, page, status: 'any', orderby: 'date', order: 'asc' });
    orders.push(...(data || []));
    totalPages = Number(headers.get('X-WP-TotalPages') || 1);
    page += 1;
  } while (page <= totalPages);
  return orders;
}

function persistencePayload(record) {
  return {
    workspace_id: WORKSPACE_ID,
    order_id: record.orderID,
    customer_id: record.customerID,
    contact_phone: record.contactPhone,
    currency: record.currency,
    gross_amount: record.grossAmount.toFixed(2),
    refunded_amount: record.refundedAmount.toFixed(2),
    net_amount: record.netAmount.toFixed(2),
    category: record.category,
    workflow: record.workflow,
    originating_action_type: record.action ? 'sms' : null,
    originating_action_id: record.action?.messageID || record.action?.id || null,
    action_at: record.action?.occurredAt || null,
    conversion_at: record.conversionAt,
    attribution_window_seconds: record.attributionWindowSeconds,
    confidence_level: record.confidenceLevel,
    confidence_score: record.confidenceScore.toFixed(2),
    reason: record.reason,
    supporting_evidence: record.evidence,
    methodology_version: METHODOLOGY_VERSION,
    source: 'historical_backfill',
    is_refunded: record.refundedAmount > 0,
    invalidated_at: null,
    invalidation_reason: null
  };
}

function stablePayloadHash(payload) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

function comparablePersistencePayload(payload) {
  const result = { ...payload };
  for (const field of ['gross_amount', 'refunded_amount', 'net_amount', 'confidence_score']) {
    result[field] = Number(result[field] || 0).toFixed(2);
  }
  for (const field of ['action_at', 'conversion_at', 'invalidated_at']) {
    if (result[field] && Number.isFinite(Date.parse(result[field]))) result[field] = new Date(result[field]).toISOString();
  }
  return result;
}

function samePersistencePayload(left, right) {
  return stablePayloadHash(comparablePersistencePayload(left)) === stablePayloadHash(comparablePersistencePayload(right));
}

async function persistRecords(client, analysis) {
  const { data: run, error: runError } = await client.from('analytics_backfill_runs').insert({
    workspace_id: WORKSPACE_ID,
    methodology_version: METHODOLOGY_VERSION,
    mode: 'persist',
    status: 'running',
    aggregate_result: analysis.aggregate
  }).select('id').single();
  if (runError) throw runError;

  try {
    const stagedRows = analysis.records.map(record => ({
      run_id: run.id,
      workspace_id: WORKSPACE_ID,
      order_id: record.orderID,
      confidence_level: record.confidenceLevel,
      confidence_score: record.confidenceScore.toFixed(2),
      // This protected table is the private staging area. It contains the
      // complete persistence payload, but never raw SMS text.
      candidate: persistencePayload(record),
      review_status: 'rule_accepted'
    }));
    for (let offset = 0; offset < stagedRows.length; offset += 250) {
      const { error: candidateError } = await client.from('analytics_backfill_candidates').upsert(
        stagedRows.slice(offset, offset + 250),
        { onConflict: 'run_id,order_id' }
      );
      if (candidateError) throw candidateError;
    }

    const { error: stagedError } = await client.from('analytics_backfill_runs').update({
      status: 'staged'
    }).eq('id', run.id);
    if (stagedError) throw stagedError;

    // One server-side transaction promotes the complete run. ON CONFLICT DO
    // NOTHING in the RPC guarantees a newer live assessment always wins.
    const { data: result, error: promotionError } = await client.rpc('promote_analytics_backfill', {
      p_run_id: run.id
    });
    if (promotionError) throw promotionError;
    return result;
  } catch (error) {
    // A lost RPC response can be ambiguous: the database transaction may have
    // committed. Never relabel an already-completed run as failed.
    await client.from('analytics_backfill_runs').update({
      status: 'failed', completed_at: new Date().toISOString()
    }).eq('id', run.id).in('status', ['running', 'staged']);
    throw error;
  }
}

function renderReport(aggregate) {
  return `# Analytics historical backfill candidate report\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `This is a **candidate-only, provisional** report. It is not an approved revenue claim.\n\n` +
    `| Measure | Result |\n|---|---:|\n` +
    `| WooCommerce orders examined | ${aggregate.woo_orders_examined} |\n` +
    `| Paid orders examined | ${aggregate.paid_orders_examined} |\n` +
    `| 100% Direct candidates | ${aggregate.counts.direct} / $${aggregate.net_amounts.direct.toFixed(2)} |\n` +
    `| 90% Strong candidates | ${aggregate.counts.strong} / $${aggregate.net_amounts.strong.toFixed(2)} |\n` +
    `| 60% Influenced | 0 / $0.00 (disabled historically) |\n` +
    `| Unattributed | ${aggregate.counts.unattributed} |\n\n` +
    `No candidate should be persisted until order-level samples have been manually reviewed.\n`;
}

function writePrivateOutput(filePath, content) {
  const resolved = path.resolve(filePath);
  const repositoryRoot = path.resolve(__dirname, '..');
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('Candidate/review output must be written outside the repository.');
  }
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o600 });
  return resolved;
}

function usage() {
  return `Usage: node scripts/backfill-analytics.js [--candidate-json PATH] [--report PATH] [--persist]\n\n` +
    `Default mode is read-only. --persist also requires ANALYTICS_BACKFILL_APPROVED=YES.\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage());
  if (args.persist && !persistenceAllowed(args)) {
    throw new Error('Persistence refused: pass --persist AND set ANALYTICS_BACKFILL_APPROVED=YES after manual approval.');
  }

  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const { supabase } = require('../db');
  const excludedPhones = new Set([...parseCSV(process.env.ANALYTICS_EXCLUDED_PHONES)].map(normalizePhone).filter(Boolean));
  const excludedOrderIDs = parseCSV(process.env.ANALYTICS_EXCLUDED_ORDER_IDS);
  const [orders, sentLogs, messages] = await Promise.all([
    fetchAllWooOrders(),
    fetchAllRows(supabase, 'sms_sent_log', 'id,order_id,flow_type,phone,message_body,telnyx_message_id,sent_at'),
    fetchAllRows(supabase, 'sms_messages', 'id,telnyx_message_id,ghl_message_id,status,direction,contact_phone,body,created_at')
  ]);
  const analysis = analyseHistoricalRevenue({ orders, sentLogs, messages }, { excludedPhones, excludedOrderIDs });

  if (args.candidateJSON) {
    writePrivateOutput(args.candidateJSON, `${JSON.stringify({ methodology_version: METHODOLOGY_VERSION, aggregate: analysis.aggregate, candidates: analysis.publicCandidates }, null, 2)}\n`);
  }
  if (args.report) writePrivateOutput(args.report, renderReport(analysis.aggregate));

  const result = { mode: args.persist ? 'persist' : 'dry_run', ...analysis.aggregate };
  if (args.persist) result.persistence = await persistRecords(supabase, analysis);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ANALYTICS BACKFILL] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  analyseHistoricalRevenue,
  isExcludedOrder,
  parseArgs,
  persistenceAllowed,
  publicCandidate,
  persistRecords,
  renderReport,
  samePersistencePayload
};
