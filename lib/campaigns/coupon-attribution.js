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
      .select('id, contact_phone, contact_name_snapshot, issued_coupon_code, sent_at, delivered_at')
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

  // ── CODES ARE COMPARED CASE-INSENSITIVELY, ALWAYS ──────────────────────
  //
  // The recipient row stores the code AS WRITTEN, because a message has to
  // read "SMS20" and not "sms20". WooCommerce lowercases every code on storage
  // and on lookup, so `coupon_codes` on an order is always lowercase, and
  // Postgres array overlap is case-SENSITIVE.
  //
  // So overlaps(['SMS20']) matched nothing while two real orders sat there
  // carrying ['sms20'], and the campaign reported $0 attributed revenue
  // against $626.10 of sales it had actually produced. A revenue figure that
  // reads zero is not obviously broken — it reads as a campaign that did not
  // work, which is the most expensive kind of wrong.
  //
  // Both sides are lowercased here. Nothing downstream may compare a raw code
  // to a stored one again.
  const normalise = (code) => String(code || '').trim().toLowerCase();

  // ── ONE CODE CAN BELONG TO MANY PEOPLE ─────────────────────────────────
  //
  // This was a Map of code -> recipient, which is exactly right when every
  // person gets their own `vin-xxxxxxxx`. A shared code breaks it twice over:
  // all 376 recipients collapse to ONE map entry pointing at whichever row
  // came last, and the "used more than once" guard below then discards every
  // redemption after the first as a WooCommerce fault.
  //
  // Measured: two people redeemed SMS20 for $626.10 and the campaign reported
  // one sale of $407.25. The guard was written for a single-use per-person
  // code, where a second use genuinely is an anomaly. For a shared code a
  // second use by a DIFFERENT person is the entire point.
  //
  // So: code -> the recipients holding it, and an order is matched to the
  // person who actually placed it.
  const byCode = new Map();
  for (const row of recipients) {
    const code = normalise(row.issued_coupon_code);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }

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

  // Names, for evidence a person can check against their own records. The
  // recipient snapshot is null on campaigns built from a phone list, so the
  // contact record is the fallback rather than showing four digits.
  const names = new Map();
  try {
    const phones = [...new Set(recipients.map(row => row.contact_phone).filter(Boolean))];
    for (let index = 0; index < phones.length; index += 200) {
      const { data } = await client.from('sms_contacts')
        .select('phone, name, first_name, last_name')
        // bounded: at most 200 entries by the loop step above.
        .in('phone', phones.slice(index, index + 200));
      for (const row of data || []) {
        const full = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
        names.set(row.phone, full || row.name || null);
      }
    }
  } catch {
    // A missing name is cosmetic. Revenue must still report.
  }

  const seen = new Map();
  const anomalies = [];
  for (const order of orders) {
    const status = String(order.status || '').toLowerCase();
    for (const rawCode of order.coupon_codes || []) {
      const code = normalise(rawCode);
      const holders = byCode.get(code);
      if (!holders?.length) continue;

      // The person who ordered, not merely somebody who held the code. With a
      // shared code the buyer must be one of its recipients or this is not a
      // campaign sale at all: somebody forwarded it to a friend, which is
      // revenue but not revenue this campaign can claim.
      const shared = holders.length > 1;
      // A per-person code is known to exactly one person AND restricted by
      // email in WooCommerce, so whoever placed the order, this campaign
      // caused it — matching by code alone is sufficient and always was.
      //
      // A shared code has to match a real recipient, because anybody could be
      // holding it. That is the whole difference between the two designs.
      //
      // I briefly flagged a phone mismatch on per-person codes as a possible
      // leak, and removed it: the email restriction already makes that
      // impossible, and it fired on fixtures throughout the suite whose phones
      // simply never had reason to align. Machinery guarding a case the coupon
      // system prevents is noise that trains somebody to ignore the list.
      const recipient = shared
        ? holders.find(row => row.contact_phone === order.contact_phone)
        : holders[0];
      if (!recipient) {
        // A per-person code used by somebody else is a real fault worth
        // surfacing. A SHARED code used by somebody outside this campaign is
        // not: two campaigns issued SMS20, so every sale the 376-person
        // win-back makes would appear as an anomaly on the 9-person one, for
        // ever. An anomaly list that fills with expected events teaches the
        // person reading it to ignore the list.
        //
        // The revenue is still correctly refused either way — this only
        // decides whether it is worth saying out loud.
        if (!shared) {
          anomalies.push({ code, wooOrderID: order.woo_order_id, reason: 'code_used_by_non_recipient' });
        }
        continue;
      }

      if (UNPAID_STATUSES.has(status)) {
        anomalies.push({ code, wooOrderID: order.woo_order_id, reason: `order_${status}` });
        continue;
      }

      // Keyed on the PERSON, not the code. One person redeeming twice is the
      // anomaly a single-use coupon should have prevented; two people
      // redeeming a shared code is two sales.
      const saleKey = `${code}:${recipient.contact_phone}`;
      if (seen.has(saleKey)) {
        anomalies.push({ code, wooOrderID: order.woo_order_id, reason: 'code_used_more_than_once' });
        continue;
      }
      seen.set(saleKey, {
        code,
        recipientID: recipient.id,
        phone: recipient.contact_phone,
        // The name the campaign was addressed to. Evidence somebody can check
        // against their own records reads as people, not phone digits.
        name: recipient.contact_name_snapshot || names.get(recipient.contact_phone) || null,
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
