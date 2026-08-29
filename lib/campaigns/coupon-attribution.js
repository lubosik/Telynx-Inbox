'use strict';
/**
 * lib/campaigns/coupon-attribution.js — which campaign made which money.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE STRONGEST EVIDENCE THIS SYSTEM HAS
 *
 *   attribution-policy.js scores a redeemed per-person coupon at 650,
 *   `verified_unique_recipient_coupon`, above a clicked link at 640 and far
 *   above any time-window correlation. That ranking is right. A code minted
 *   for one person, usable once, bound to their campaign, appearing on a paid
 *   order is not a correlation at all. It is the customer telling you which
 *   message they acted on.
 *
 *   It had never fired. attribution-generator.js passes `couponEvidence: []`,
 *   hardcoded, and nothing read coupon usage back from WooCommerce. The
 *   highest-confidence signal in the model was one the model never received,
 *   so a campaign could report delivery and replies and say nothing about
 *   revenue.
 *
 *   Two columns fixed the ends of the join (see
 *   scripts/coupon-attribution-migration.sql). This is the join.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   It does not estimate. A campaign with no redemptions reports zero
 *   redemptions, not "probably influenced some orders". The whole reason to
 *   prefer coupon evidence is that it needs no inference, and quietly padding
 *   it with guesses would throw that away while keeping the confident label.
 *
 *   It does not count an unpaid order. `cancelled`, `failed`, `refunded` and
 *   `trash` are excluded: a code attached to an order that was refunded
 *   produced no revenue, and counting it would make a campaign look
 *   successful precisely when it attracted the wrong buyer.
 *
 *   It does not double count. A code is single-use and bound to one person, so
 *   a code appearing on two orders means something has gone wrong in
 *   WooCommerce rather than that the campaign earned twice; the first paid
 *   order wins and the rest are reported as anomalies rather than summed.
 */

const { fetchAllRows } = require('../fetch-all-rows');

/** Orders in these states produced no money. */
const UNPAID_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash', 'pending']);

/**
 * Redemptions for one campaign, with the revenue behind them.
 *
 * Reads the codes this campaign issued, then the orders carrying any of them.
 * Both sides are indexed by the migration, so this stays a lookup rather than
 * a scan as order volume grows.
 */
async function campaignCouponRedemptions({ client, campaignID, workspaceID = 'vici' }) {
  const recipients = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('sms_campaign_recipients')
      .select('id, contact_phone, issued_coupon_code, sent_at, delivered_at')
      .eq('campaign_id', campaignID)
      .eq('workspace_id', workspaceID)
      .not('issued_coupon_code', 'is', null)
      .range(from, from + 999);
    if (error) {
      // 42703 is "column does not exist": the migration has not been applied.
      // Reported rather than thrown, so a campaign screen still renders its
      // delivery numbers on a database that predates this feature.
      if (error.code === '42703' || error.code === 'PGRST204') {
        return { available: false, reason: 'coupon_attribution_migration_missing' };
      }
      throw new Error(`Reading issued codes failed: ${error.message}`);
    }
    recipients.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  if (!recipients.length) {
    return { available: true, issued: 0, redemptions: [], redeemed: 0, revenue: 0, anomalies: [] };
  }

  const byCode = new Map(recipients.map(row => [row.issued_coupon_code, row]));

  // Paged, and NOT swallowed on error. fetch-all-rows.js exists because a
  // swallowed error once became null data and a wrong-looking screen, and a
  // revenue number that silently reads zero because a query failed is exactly
  // that bug with money attached. The missing-migration case is already
  // handled above, so anything thrown here is real.
  //
  // `overlaps` is the array-containment operator the GIN index serves, and it
  // sends the code list once rather than one value per row, so this does not
  // reproduce the unbounded `.in()` URL overflow.
  const orders = await fetchAllRows(
    client,
    'sms_orders',
    'woo_order_id, contact_phone, status, total, created_at, coupon_codes',
    { filter: query => query.overlaps('coupon_codes', [...byCode.keys()]) }
  );

  const seen = new Map();
  const anomalies = [];
  for (const order of orders) {
    const status = String(order.status || '').toLowerCase();
    for (const code of order.coupon_codes || []) {
      const recipient = byCode.get(code);
      if (!recipient) continue;
      if (UNPAID_STATUSES.has(status)) {
        anomalies.push({ code, wooOrderID: order.woo_order_id, reason: `order_${status}` });
        continue;
      }
      // A single-use code on two paid orders is a WooCommerce problem, not a
      // second sale. First one wins, the rest are surfaced.
      if (seen.has(code)) {
        anomalies.push({ code, wooOrderID: order.woo_order_id, reason: 'code_used_more_than_once' });
        continue;
      }
      seen.set(code, {
        code,
        recipientID: recipient.id,
        phone: recipient.contact_phone,
        wooOrderID: order.woo_order_id,
        orderTotal: Number(order.total) || 0,
        orderedAt: order.created_at,
        // Proof the message reached them before the order, which is what makes
        // this attribution rather than coincidence.
        deliveredAt: recipient.delivered_at || recipient.sent_at || null
      });
    }
  }

  const redemptions = [...seen.values()];
  return {
    available: true,
    issued: recipients.length,
    redeemed: redemptions.length,
    revenue: redemptions.reduce((total, row) => total + row.orderTotal, 0),
    redemptionRate: recipients.length ? redemptions.length / recipients.length : 0,
    redemptions,
    anomalies
  };
}

module.exports = { UNPAID_STATUSES, campaignCouponRedemptions };
