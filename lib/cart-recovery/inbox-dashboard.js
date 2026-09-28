'use strict';

const { readAllInboxRows } = require('../inbox-audience');

function recoveryCursor(row) {
  return Buffer.from(JSON.stringify({ at: row.last_activity_at, id: row.id })).toString('base64url');
}

function afterRecoveryCursor(rows, raw) {
  if (!raw) return rows;
  let cursor;
  if (Number.isFinite(Date.parse(raw))) cursor = { at: raw };
  else {
    try { cursor = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch (_) {}
  }
  if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || (cursor.id != null && !/^[0-9a-f-]{36}$/i.test(cursor.id))) {
    throw Object.assign(new Error('This recovery page has expired. Refresh the list and try again.'), { status: 400 });
  }
  const boundary = Date.parse(cursor.at);
  return rows.filter(row => Date.parse(row.last_activity_at) < boundary ||
    (cursor.id != null && Date.parse(row.last_activity_at) === boundary && String(row.id) < cursor.id));
}

// Mirrors the lifetime operational metric definitions in the deployed voice
// migration. Revenue is only the persisted recovered-order net, never cart
// value, SMS totals or inferred purchases. Scoping changes no attribution.
function scopedRecoveryMetrics({ carts, recoveredOrders, voiceAttempts }, context, now = new Date()) {
  const rows = context.filter(carts);
  const ids = new Set(rows.map(row => String(row.id)));
  const orders = context.filter(recoveredOrders);
  const attempts = voiceAttempts.filter(row => ids.has(String(row.recovery_id)));
  const count = predicate => rows.filter(predicate).length;
  const currencies = new Set(orders.map(row => row.order_currency).filter(Boolean));
  if (currencies.size > 1 || orders.some(row => !row.order_currency || row.net_recovered_revenue == null || !Number.isFinite(Number(row.net_recovered_revenue)))) {
    throw Object.assign(new Error('Recovery revenue includes different or missing currencies. Open Analytics for the currency breakdown; no messages have been changed.'), {
      status: 503, code: 'RECOVERY_CURRENCY_BREAKDOWN_REQUIRED'
    });
  }
  const reasons = new Map();
  for (const row of rows) {
    if (row.objection_category != null && row.objection_category !== 'UNKNOWN') {
      reasons.set(row.objection_category, (reasons.get(row.objection_category) || 0) + 1);
    }
  }
  return {
    abandoned_carts_identified: count(row => Number.isFinite(Date.parse(row.due_at)) && Date.parse(row.due_at) <= now.getTime()
      && !['emptied', 'expired'].includes(row.status)),
    sms_eligible: count(row => row.consent_granted === true),
    sms_scheduled: count(row => row.status === 'active'),
    dry_run_proposals: count(row => row.status === 'dry_run'),
    sms_sent: count(row => row.dry_run === false && row.sent_at != null),
    sms_delivered: count(row => row.dry_run === false && row.delivered_at != null),
    sms_clicked: count(row => row.sms_recovery_click_id != null),
    customer_replies: count(row => row.conversation_occurred_at != null),
    ai_drafts: count(row => ['DRAFT_READY', 'APPROVED', 'SENT'].includes(row.reply_status)),
    push_scheduled: count(row => row.push_status === 'QUEUED'),
    push_blocked: count(row => row.push_status === 'BLOCKED'),
    push_sent: count(row => row.push_sent_at != null),
    push_clicked: count(row => row.push_recovery_click_id != null),
    voice_eligible: count(row => row.voice_marketing_consent === true && row.ai_voice_consent === true),
    voice_queued: count(row => ['QUEUED', 'DEFERRED_CALLING_WINDOW', 'CLAIMED'].includes(row.voice_status)),
    voice_initiated: attempts.filter(row => row.dry_run === false).length,
    voice_human_detected: attempts.filter(row => String(row.amd_result || '').startsWith('human')).length,
    voice_voicemails_played: attempts.filter(row => row.voicemail_played_at != null).length,
    voice_transfers_connected: attempts.filter(row => row.transfer_connected_at != null).length,
    voice_opt_outs: attempts.filter(row => row.opt_out_at != null).length,
    recovered_orders: orders.length,
    recovered_revenue: orders.reduce((sum, row) => sum + Math.round(Number(row.net_recovered_revenue) * 100), 0) / 100,
    currency: [...currencies][0] || 'USD',
    top_abandonment_reasons: [...reasons].map(([category, value]) => ({ category, count: value }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)).slice(0, 12)
  };
}

async function readScopedRecoveryMetrics(client, workspace, context, now) {
  const filter = query => query.eq('workspace_id', workspace);
  const [carts, recoveredOrders, voiceAttempts] = await Promise.all([
    readAllInboxRows(client, 'luko_cart_recoveries', '*', { orderBy: 'id', ascending: true, filter }),
    readAllInboxRows(client, 'luko_cart_recovered_orders', 'id,contact_phone,recovery_id,net_recovered_revenue,order_currency', { orderBy: 'id', ascending: true, filter }),
    readAllInboxRows(client, 'luko_cart_voice_attempts', 'id,recovery_id,dry_run,amd_result,voicemail_played_at,transfer_connected_at,opt_out_at', { orderBy: 'id', ascending: true, filter })
  ]);
  return scopedRecoveryMetrics({ carts, recoveredOrders, voiceAttempts }, context, now);
}

module.exports = { scopedRecoveryMetrics, readScopedRecoveryMetrics, recoveryCursor, afterRecoveryCursor };
