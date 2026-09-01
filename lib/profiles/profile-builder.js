'use strict';
/**
 * lib/profiles/profile-builder.js — the deterministic half of a client profile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 *   Every column this file writes is COMPUTED from rows that already exist:
 *   sms_orders, sms_messages, sms_campaign_recipients. There is no model call
 *   anywhere in it and there is not meant to be one. A summary of a
 *   conversation that does not exist is not knowledge, it is a paraphrase of a
 *   SQL query that downstream code would then trust as if it were evidence.
 *
 *   Measured, which is why the line is drawn here: 809 contacts have any SMS
 *   at all and 559 of them have NEVER sent an inbound message. 102 have sent
 *   exactly one. For 82% of contacts a "conversation summary" would be a
 *   summary of our own outbound templates.
 *
 *   Order data is the opposite: 843 buyers, ~1,500-2,000 order rows with line
 *   items, SKUs, dates and statuses, and 289 people with two or more orders —
 *   enough to measure a rhythm. So this file mines the orders hard and the
 *   messages only for the three facts they honestly support: how much somebody
 *   talks, when they last did, and whether they ever have.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SOLE-WRITER RULE
 *
 *   sms_customer_profiles has two owners and no more:
 *
 *     the eleven legacy columns   -> intelligence.js (analyseConversation)
 *     the columns in COLUMNS below -> this file, and nothing else
 *     last_checkin_variant        -> the check-in approval path (Phase 2)
 *
 *   `last_checkin_variant` is NOT in this file's payload, on purpose. It
 *   records a decision taken when a campaign is approved and cannot be
 *   re-derived from orders or messages, so a nightly sweep that included it
 *   would write NULL over Phase 2's answer every night. `updated_at` is
 *   likewise absent: it belongs to intelligence.js.
 *
 *   This repository's recurring production fault is several places holding one
 *   answer and the emptiest one winning. It has produced a 15% coupon on a
 *   message promising 20%, a dead send path, and analytics reporting zero
 *   opt-outs while ten people had left. This file is not going to be the next
 *   instance.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE FINGERPRINTS EXIST
 *
 *   A rebuild is two indexed reads and no model call, so it is cheap enough to
 *   run on every order webhook, every inbound SMS and a nightly sweep. What it
 *   is not cheap enough to do is rewrite 843 identical rows every night: the
 *   writes are pointless, they churn the indexes, and they destroy the one
 *   signal that tells an operator when a profile last actually changed.
 *
 *   So each row carries `count:latest_created_at` over its paid orders and
 *   over its messages. Both matching, at the current profile_version, means
 *   nothing this file reads has changed, and the row is skipped entirely — no
 *   write at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READS ARE CHUNKED AND PAGED, BOTH
 *
 *   Two Supabase behaviours have each taken production down here, and both are
 *   silent: `.in()` serialises every value into the URL and overflows the HTTP
 *   header limit at around 900 values, and any read without `.range()` stops
 *   at 1000 rows without erroring.
 *
 *   Chunking alone is not enough. A chunk of 200 phones is a safe URL and can
 *   still match well over 1000 message rows, which would silently truncate a
 *   contact's history and produce a confidently wrong profile. Every read here
 *   therefore chunks the `.in()` list AND pages inside each chunk, by going
 *   through `fetchAllRows` from lib/fetch-all-rows.js rather than writing a
 *   third version of either pattern.
 */

const { fetchAllRows, IN_CHUNK_SIZE } = require('../fetch-all-rows');
const { PAID_STATUSES } = require('../campaigns/segment-facts');
const {
  approvedLabelForOrder, itemsByValue, skuToParentName
} = require('../campaigns/personalise');
const { calculateReorderCadence } = require('../campaigns/reorder-cadence');
const { reorderIntervalFor } = require('../campaigns/checkin-offer-policy');
const { WORKFLOW_CATEGORY: CHECK_IN_CATEGORY } = require('../campaigns/check-in');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bumped whenever the arithmetic below changes.
 *
 * The fingerprints answer "have this contact's rows changed"; the version
 * answers "has our reading of them changed". Without it, improving the builder
 * would silently apply only to contacts who happened to buy something
 * afterwards, and the database would hold two generations of profile that look
 * identical and disagree.
 */
const PROFILE_VERSION = 1;

const PROFILE_TABLE = 'sms_customer_profiles';

/** The fulfilment states, as a literal list, for the one `.in()` on status. */
const PAID_STATUS_LIST = [...PAID_STATUSES];

/**
 * Campaign recipient states meaning the message actually went out.
 *
 * `claimed` and `sending` are attempts, not arrivals, and `failed` is the
 * opposite of one. Counting attempts here would make "how many campaigns has
 * this person received" quietly larger than the number of messages on their
 * phone, which is the sort of number somebody uses to decide not to contact
 * them again.
 */
const RECEIVED_STATES = new Set(['sent', 'delivered']);

/**
 * Inbound-message thresholds, measured against the live distribution rather
 * than chosen: of 809 contacts with any message, 559 have zero inbound, 102
 * have one, 89 have two to four and 59 have five or more.
 *
 * The names exist so a campaign can ask for "silent buyers who are overdue"
 * without four call sites re-deriving the same cutoffs and eventually
 * disagreeing about where `talker` starts.
 */
const ENGAGEMENT_TIERS = Object.freeze(['silent', 'flicker', 'talker', 'regular']);

/** Columns this file owns. Nothing outside it may write these. */
const COLUMNS = Object.freeze([
  'profile_version', 'deterministic_built_at', 'orders_fingerprint', 'messages_fingerprint',
  'order_count', 'first_order_at', 'last_order_at',
  'total_spend_cents', 'avg_order_value_cents', 'distinct_skus', 'top_skus',
  'last_order_skus', 'last_product_name', 'last_product_sku', 'has_only_unpaid_orders',
  'reorder_interval_days', 'reorder_interval_source', 'reorder_due_at', 'cadence_confidence',
  'inbound_message_count', 'outbound_message_count', 'last_inbound_at', 'has_replied_ever',
  'engagement_tier', 'campaigns_received_count', 'last_checkin_at'
]);

class ProfileBuilderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProfileBuilderError';
    this.code = code || 'PROFILE_BUILD_FAILED';
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function isPaid(order) {
  return PAID_STATUSES.has(String(order?.status || '').toLowerCase());
}

function timeOf(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(milliseconds) {
  return milliseconds === null || milliseconds === undefined
    ? null
    : new Date(milliseconds).toISOString();
}

/**
 * `count:latest_created_at`, with the timestamp NORMALISED through Date rather
 * than taken as the string the database happened to send.
 *
 * PostgREST renders timestamptz as `2026-08-01T12:00:00+00:00`, and everything
 * in this process that mints one writes `2026-08-01T12:00:00.000Z`. Those are
 * the same instant and different strings, so a fingerprint built from raw text
 * would compare unequal against itself and rebuild every row on every sweep —
 * a skip that never skips, which is indistinguishable from having no
 * fingerprint at all.
 *
 * An empty set fingerprints as `0:`. That is a real value, not a missing one:
 * a contact whose orders were all cancelled must be able to be marked as built.
 */
function fingerprintOf(rows) {
  let latest = null;
  for (const row of rows || []) {
    const time = timeOf(row?.created_at);
    if (time === null) continue;
    if (latest === null || time > latest) latest = time;
  }
  return `${(rows || []).length}:${latest === null ? '' : new Date(latest).toISOString()}`;
}

/** Money in cents, from the numeric-dollars string sms_orders.total carries. */
function centsFrom(total) {
  const parsed = Number(total);
  // Round the product, not the operands: `19.99 * 100` is 1998.9999999999998
  // in IEEE 754, and truncating that reports a cent less on every order.
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function normaliseSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return sku || null;
}

function engagementTierFor(inboundCount) {
  const count = Number(inboundCount);
  if (!Number.isFinite(count) || count <= 0) return 'silent';
  if (count === 1) return 'flicker';
  if (count <= 4) return 'talker';
  return 'regular';
}

/**
 * The reorder rhythm, and how much it is worth.
 *
 * ── THE SHAPE THAT IS EASY TO GET WRONG ────────────────────────────────────
 *
 *   `calculateReorderCadence` nests the rhythm under `.cadence`. The OUTER
 *   object answers "should we contact them now", which is a different question
 *   from "how often do they buy" — somebody mid-cycle comes back
 *   `eligible: false, reason: 'reorder_window_not_reached'` while carrying a
 *   perfectly good median. Reading the outer shape sends every one of them to
 *   the shop median instead of their own number, silently.
 *
 * ── WHY reorderIntervalFor DECIDES AND THIS ONLY LABELS ────────────────────
 *
 *   "Which interval applies to this person" already has an owner:
 *   checkin-offer-policy.js, which is the code that decides whether somebody is
 *   lapsed enough to be offered a discount. If the profile answered that
 *   question independently, the profile could say a customer is overdue while
 *   the offer policy said they were mid-cycle. So the interval and its source
 *   come from there, and only the confidence label is derived here.
 */
function cadenceFor(paidOrders, now) {
  if (!paidOrders.length) {
    return { days: null, source: null, confidence: 'none' };
  }
  const interval = reorderIntervalFor(paidOrders, now);
  const cadence = calculateReorderCadence({
    purchases: paidOrders.map(order => ({ paidAt: order.created_at, status: order.status })),
    now
  })?.cadence;

  // The contract's vocabulary is high | low | none, and reorder-cadence.js
  // speaks high | moderate | none. Two consistent gaps are real evidence and
  // three are better, so `moderate` maps to `low` rather than being promoted.
  const confidence = interval.source === 'personal'
    ? (cadence?.confidence === 'high' ? 'high' : 'low')
    : 'none';

  // Rounded here and used rounded below, so that a reader who recomputes
  // last_order_at + reorder_interval_days lands on exactly the stored
  // reorder_due_at instead of a few hours away from it.
  return { days: Math.round(interval.days), source: interval.source, confidence };
}

/**
 * One contact's deterministic profile. Pure: no client, no clock of its own.
 *
 * @param {object}   input
 * @param {string}   input.phone
 * @param {Array}    input.orders      every sms_orders row for this phone, any status
 * @param {Array}    input.messages    every sms_messages row for this phone
 * @param {Array}    input.recipients  every sms_campaign_recipients row for this phone
 * @param {Set}      input.checkInCampaignIds  ids of campaigns that are 21-day check-ins
 * @param {Date}     input.now
 * @returns {{ payload: object, fingerprints: { orders: string, messages: string } }}
 */
function computeProfile({
  phone,
  orders = [],
  messages = [],
  recipients = [],
  checkInCampaignIds = new Set(),
  // The catalogue map, so a line item resolves to the label a customer would
  // actually read. Null is honest rather than fatal: without it a product is
  // simply unnameable, which is the same answer the campaign path gives.
  skuMap = null,
  now = new Date()
}) {
  if (!phone) throw new ProfileBuilderError('A profile needs a phone number.', 'PROFILE_NO_PHONE');
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new ProfileBuilderError('now must be a valid date.', 'PROFILE_BAD_CLOCK');

  // ── Orders ───────────────────────────────────────────────────────────────
  const paid = orders.filter(isPaid)
    .slice()
    .sort((a, b) => (timeOf(a.created_at) ?? 0) - (timeOf(b.created_at) ?? 0));

  const orderTimes = paid.map(order => timeOf(order.created_at)).filter(time => time !== null);
  const firstOrderTime = orderTimes.length ? orderTimes[0] : null;
  const lastOrderTime = orderTimes.length ? orderTimes[orderTimes.length - 1] : null;
  const newestPaidOrder = paid.length ? paid[paid.length - 1] : null;

  const totalSpendCents = paid.reduce((sum, order) => sum + centsFrom(order.total), 0);

  // SKU tallies. `ordersWithSku` counts ORDERS rather than line quantities: a
  // customer who bought six vials once is not a more habitual buyer of that
  // product than somebody who has come back for it three times, and the column
  // is read as "what do they keep coming back for".
  const ordersWithSku = new Map();
  const lastSeenBySku = new Map();
  for (const order of paid) {
    const time = timeOf(order.created_at) ?? 0;
    const seenInThisOrder = new Set();
    for (const item of order.items || []) {
      const sku = normaliseSku(item?.sku);
      if (!sku || seenInThisOrder.has(sku)) continue;
      seenInThisOrder.add(sku);
      ordersWithSku.set(sku, (ordersWithSku.get(sku) || 0) + 1);
      lastSeenBySku.set(sku, Math.max(lastSeenBySku.get(sku) || 0, time));
    }
  }

  // Sorted rather than left in encounter order, so that two rebuilds of an
  // unchanged history produce byte-identical arrays. An array that reorders
  // itself makes every diff look like a change.
  const distinctSkus = [...ordersWithSku.keys()].sort();
  const topSkus = [...ordersWithSku.entries()]
    .sort((a, b) =>
      (b[1] - a[1])
      || ((lastSeenBySku.get(b[0]) || 0) - (lastSeenBySku.get(a[0]) || 0))
      || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(entry => entry[0]);

  // Most valuable line first, because orders here routinely lead with BAC
  // water or a syringe pack and `items[0]` would name the accessory rather
  // than the thing somebody came for. itemsByValue is imported rather than
  // reimplemented so this and the campaign renderer can never pick different
  // products out of the same order.
  const lastItems = newestPaidOrder ? itemsByValue(newestPaidOrder) : [];
  const lastOrderSkus = [...new Set(lastItems.map(item => normaliseSku(item?.sku)).filter(Boolean))];
  // Name and SKU come from the SAME line item, so the two columns can never
  // describe different products.
  //
  // ── THE LABEL, NOT THE RAW NAME ──────────────────────────────────────────
  //
  // This stored `String(item.name).trim()` — "RT - 10mg", "GLP3-Ret - 30mg" —
  // and the variant selector then asked approvedProductLabel() whether that
  // was nameable. It never is: the approved list holds codes, not store names,
  // and `name || sku` short-circuits so a perfectly good SKU is blocked behind
  // the unusable name.
  //
  // Measured against the live catalogue: the campaign renderer produces an
  // approved label for 832 of 844 buyers, this produced one for 3. So 829
  // people would have been routed to a "we don't know what you bought"
  // message that the campaign path could have named perfectly well.
  //
  // approvedLabelForOrder is the chain personalise.js already uses, exported
  // rather than copied. A second copy is how the two answers drifted apart in
  // the first place.
  const resolved = newestPaidOrder
    ? approvedLabelForOrder(newestPaidOrder, skuMap)
    : { label: null, sku: null };
  const lastProductName = resolved.label;
  const lastProductSku = resolved.sku ? normaliseSku(resolved.sku) : null;

  const cadence = cadenceFor(paid, new Date(nowTime));
  const reorderDueTime = lastOrderTime !== null && cadence.days !== null
    ? lastOrderTime + cadence.days * DAY_MS
    : null;

  // ── Messages ─────────────────────────────────────────────────────────────
  let inbound = 0;
  let outbound = 0;
  let lastInboundTime = null;
  for (const message of messages) {
    if (String(message?.direction || '').toLowerCase() === 'inbound') {
      inbound += 1;
      const time = timeOf(message.created_at);
      if (time !== null && (lastInboundTime === null || time > lastInboundTime)) lastInboundTime = time;
    } else {
      outbound += 1;
    }
  }

  // ── Campaign history ─────────────────────────────────────────────────────
  let campaignsReceived = 0;
  let lastCheckInTime = null;
  for (const recipient of recipients) {
    if (!RECEIVED_STATES.has(String(recipient?.state || '').toLowerCase())) continue;
    campaignsReceived += 1;
    if (!checkInCampaignIds.has(recipient.campaign_id)) continue;
    // sent_at is the moment it left; delivered_at stands in for the rows where
    // the provider confirmed delivery without a separate sent timestamp.
    const time = timeOf(recipient.sent_at) ?? timeOf(recipient.delivered_at);
    if (time !== null && (lastCheckInTime === null || time > lastCheckInTime)) lastCheckInTime = time;
  }

  const payload = {
    contact_phone: phone,
    profile_version: PROFILE_VERSION,
    deterministic_built_at: new Date(nowTime).toISOString(),
    orders_fingerprint: fingerprintOf(paid),
    messages_fingerprint: fingerprintOf(messages),

    order_count: paid.length,
    first_order_at: isoOrNull(firstOrderTime),
    last_order_at: isoOrNull(lastOrderTime),
    // Never negative. A backdated import or a clock skew can put an order
    // fractionally in the future, and "-1 days since their last order" would
    // pass every "more than N days" test in the system by being smaller than
    // all of them.
    // days_since_last_order is DELIBERATELY NOT STORED.
    //
    // It is not a fact about the customer, it is a fact about now, and a
    // stored copy is wrong the day after it is written. The fingerprint skip
    // is correct — an unchanged contact costs no write — so this column would
    // have frozen at whatever it was when the profile was first built. A
    // "lapsed buyer" segment reading it would then permanently exclude
    // everybody whose profile was built while they were fresh: exactly the
    // people the outreach is for.
    //
    // last_order_at is the fact and never goes stale. The segment system
    // already computes daysSinceLastOrder live from facts
    // (segment-rule-evaluator.js:70), so storing a second answer here would
    // have been the same fault this codebase keeps repeating — several places
    // holding one answer, and the emptiest or stalest one winning.
    total_spend_cents: totalSpendCents,
    avg_order_value_cents: paid.length ? Math.round(totalSpendCents / paid.length) : 0,
    distinct_skus: distinctSkus,
    top_skus: topSkus,
    last_order_skus: lastOrderSkus,
    last_product_name: lastProductName,
    last_product_sku: lastProductSku,
    // The guard that keeps a cancelled order from reading as a return visit.
    // 335 of the live rows are cancelled or failed, and somebody whose only
    // orders failed is not a customer who came back — they are the person most
    // in need of being contacted, and treating their dead order as recent
    // activity is exactly what would withhold it.
    has_only_unpaid_orders: orders.length > 0 && paid.length === 0,

    reorder_interval_days: cadence.days,
    reorder_interval_source: cadence.source,
    reorder_due_at: isoOrNull(reorderDueTime),
    cadence_confidence: cadence.confidence,

    inbound_message_count: inbound,
    outbound_message_count: outbound,
    last_inbound_at: isoOrNull(lastInboundTime),
    has_replied_ever: inbound > 0,
    engagement_tier: engagementTierFor(inbound),

    campaigns_received_count: campaignsReceived,
    last_checkin_at: isoOrNull(lastCheckInTime)
  };

  return {
    payload,
    fingerprints: { orders: payload.orders_fingerprint, messages: payload.messages_fingerprint }
  };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * A column list is missing from the database, not from the code.
 *
 * Without this the nightly sweep logs `column ... does not exist` once a night
 * forever and nobody connects it to an unapplied migration.
 */
function asBuilderError(error) {
  const message = String(error?.message || error);
  if (/does not exist|schema cache/i.test(message)) {
    return new ProfileBuilderError(
      `${PROFILE_TABLE} is missing the profile columns — run scripts/contact-profiles-migration.sql. (${message})`,
      'PROFILE_COLUMNS_MISSING'
    );
  }
  return error instanceof Error ? error : new ProfileBuilderError(message);
}

/**
 * Chunked AND paged. Either one alone is a silent failure at scale; see the
 * file header.
 */
async function readChunked(client, table, columns, column, values, {
  orderBy = 'created_at',
  thenBy = 'id'
} = {}) {
  const unique = [...new Set((values || []).filter(Boolean))];
  const rows = [];
  for (let index = 0; index < unique.length; index += IN_CHUNK_SIZE) {
    const chunk = unique.slice(index, index + IN_CHUNK_SIZE);
    const page = await fetchAllRows(client, table, columns, {
      orderBy,
      ascending: true,
      thenBy,
      // bounded: chunk is at most IN_CHUNK_SIZE (200) values, the width
      // lib/fetch-all-rows.js measured as safe. The live failure was at 907.
      filter: query => query.in(column, chunk)
    });
    rows.push(...page);
  }
  return rows;
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row?.[key];
    if (!value) continue;
    const held = grouped.get(value);
    if (held) held.push(row); else grouped.set(value, [row]);
  }
  return grouped;
}

/**
 * Which of these campaigns are 21-day check-ins.
 *
 * Two reads rather than a PostgREST embedded join: sms_campaign_recipients has
 * both a plain and a composite foreign key to sms_campaigns, which makes an
 * embed ambiguous and makes it fail at runtime rather than at review.
 */
async function checkInCampaignIdsFor(client, recipients) {
  const ids = [...new Set(recipients.map(row => row?.campaign_id).filter(Boolean))];
  if (!ids.length) return new Set();
  const campaigns = await readChunked(
    client, 'sms_campaigns', 'id, workflow_category', 'id', ids,
    { orderBy: 'id', thenBy: null }
  );
  return new Set(campaigns
    .filter(row => String(row?.workflow_category || '') === CHECK_IN_CATEGORY)
    .map(row => row.id));
}

// ── Build and write ────────────────────────────────────────────────────────

/**
 * Build (and where changed, write) profiles for a set of phone numbers.
 *
 * Returns counts rather than rows: this is called from a sweep and from a
 * webhook, and neither has any use for 843 payloads.
 *
 * @returns {Promise<{considered:number, written:number, skipped:number, failed:Array}>}
 */
async function buildProfiles({ client, phones, now = new Date() }) {
  if (!client) throw new ProfileBuilderError('buildProfiles needs a Supabase client.', 'PROFILE_NO_CLIENT');
  const unique = [...new Set((phones || []).filter(Boolean))];
  if (!unique.length) return { considered: 0, written: 0, skipped: 0, failed: [] };

  let orders;
  let messages;
  let recipients;
  let existingRows;
  try {
    [orders, messages, recipients, existingRows] = await Promise.all([
      readChunked(client, 'sms_orders', 'contact_phone, status, created_at, items, total',
        'contact_phone', unique),
      readChunked(client, 'sms_messages', 'contact_phone, direction, created_at',
        'contact_phone', unique),
      readChunked(client, 'sms_campaign_recipients', 'contact_phone, campaign_id, state, sent_at, delivered_at',
        'contact_phone', unique),
      readChunked(client, PROFILE_TABLE,
        'contact_phone, profile_version, orders_fingerprint, messages_fingerprint, deterministic_built_at',
        'contact_phone', unique, { orderBy: 'id', thenBy: null })
    ]);
  } catch (error) {
    throw asBuilderError(error);
  }

  let checkInCampaignIds;
  try {
    checkInCampaignIds = await checkInCampaignIdsFor(client, recipients);
  } catch (error) {
    throw asBuilderError(error);
  }

  // The catalogue, fetched once for the whole batch rather than per contact.
  //
  // Never fatal. WooCommerce being unreachable must not stop 800 profiles from
  // being built over a product NAME, so an unavailable catalogue means products
  // resolve to null for this run and the next run fills them in. A profile with
  // no product label is a smaller problem than no profile at all.
  let skuMap = null;
  try {
    skuMap = await skuToParentName();
  } catch (error) {
    console.warn(`[PROFILE] Catalogue unavailable; products unnamed this run: ${error.message}`);
  }

  const ordersByPhone = groupBy(orders, 'contact_phone');
  const messagesByPhone = groupBy(messages, 'contact_phone');
  const recipientsByPhone = groupBy(recipients, 'contact_phone');
  const existingByPhone = new Map(existingRows.map(row => [row.contact_phone, row]));

  const failed = [];
  const changed = [];
  let skipped = 0;

  for (const phone of unique) {
    try {
      const { payload } = computeProfile({
        phone,
        orders: ordersByPhone.get(phone) || [],
        messages: messagesByPhone.get(phone) || [],
        recipients: recipientsByPhone.get(phone) || [],
        checkInCampaignIds,
        skuMap,
        now
      });

      const existing = existingByPhone.get(phone);
      // The whole point of the fingerprints: an unchanged contact costs no
      // write at all, not even a touched timestamp.
      const unchanged = existing
        && existing.deterministic_built_at
        && Number(existing.profile_version) === PROFILE_VERSION
        && existing.orders_fingerprint === payload.orders_fingerprint
        && existing.messages_fingerprint === payload.messages_fingerprint;

      if (unchanged) { skipped += 1; continue; }
      changed.push(payload);
    } catch (error) {
      failed.push({ phone, error: error.message });
    }
  }

  let written = 0;
  for (let index = 0; index < changed.length; index += 100) {
    const batch = changed.slice(index, index + 100);
    try {
      // PostgREST reports failures in `error`, never as a rejection, and a
      // query builder has no `.catch()` — calling one throws before the request
      // is even sent. try/catch around the await, then check `error`.
      const { error } = await client
        .from(PROFILE_TABLE)
        .upsert(batch, { onConflict: 'contact_phone' });
      if (error) throw new Error(error.message);
      written += batch.length;
    } catch (error) {
      const failure = asBuilderError(error);
      // A failed batch is retried on the next pass for free, because its
      // fingerprints were never stored. Named per phone so the caller's summary
      // says who did not get one rather than only how many.
      for (const row of batch) failed.push({ phone: row.contact_phone, error: failure.message });
    }
  }

  return { considered: unique.length, written, skipped, failed };
}

/** One contact. Throws on a read or write failure; see refreshProfileQuietly. */
async function refreshProfile({ client, phone, now = new Date() }) {
  const summary = await buildProfiles({ client, phones: [phone], now });
  return {
    phone,
    written: summary.written > 0,
    skipped: summary.skipped > 0,
    error: summary.failed[0]?.error || null
  };
}

/**
 * One contact, best effort, for the webhook paths.
 *
 * NEVER throws and never rejects. It is called from the WooCommerce order
 * webhook and from the Telnyx inbound handler, both of which have already
 * answered the provider with 200 by the time they reach it. A rejection there
 * becomes an unhandled rejection in a process that also carries the inbox, the
 * dialler and order SMS, and a profile is not worth any of them.
 */
async function refreshProfileQuietly({ client, phone, now = new Date() }) {
  if (!client || !phone) return { written: false, reason: 'invalid_request' };
  try {
    const result = await refreshProfile({ client, phone, now });
    if (result.error) {
      console.warn(`[PROFILE] Refresh failed for ...${String(phone).slice(-4)}: ${result.error}`);
      return { written: false, reason: 'write_failed' };
    }
    return { written: result.written, reason: result.written ? 'written' : 'unchanged' };
  } catch (error) {
    console.warn(`[PROFILE] Refresh failed for ...${String(phone).slice(-4)}: ${error.message}`);
    return { written: false, reason: error.code || 'error' };
  }
}

// ── Backfill and drift sweep ───────────────────────────────────────────────

/**
 * Everybody who should have a profile.
 *
 * Two sources, unioned:
 *
 *   - every contact with a PAID order, which is the population the contract
 *     names and is 843 people today;
 *   - every contact who already has a profile row, so that anything created by
 *     an inbound-SMS refresh keeps being maintained instead of being written
 *     once and then drifting forever because they never bought anything.
 *
 * Sorted, so a run that dies halfway resumes over the same order and its
 * progress log means something.
 */
async function profileablePhones({ client }) {
  const buyers = await fetchAllRows(client, 'sms_orders', 'contact_phone, status, created_at', {
    orderBy: 'created_at',
    ascending: true,
    thenBy: 'id',
    // bounded: four fulfilment states, fixed in code. This list cannot grow
    // with the size of the customer base.
    filter: query => query.in('status', PAID_STATUS_LIST)
  });
  const existing = await fetchAllRows(client, PROFILE_TABLE, 'contact_phone', {
    orderBy: 'id',
    ascending: true,
    thenBy: null
  });
  const phones = new Set();
  for (const row of buyers) if (row?.contact_phone) phones.add(row.contact_phone);
  for (const row of existing) if (row?.contact_phone) phones.add(row.contact_phone);
  return [...phones].sort();
}

/**
 * Build every profile that needs building.
 *
 * Idempotent by construction: the second run finds every fingerprint matching
 * and writes nothing. Resumable for the same reason — a run that dies at
 * contact 400 leaves 400 built rows that the next run skips.
 *
 * @param {object}   options
 * @param {number}   [options.batchSize]  contacts per pass. Bounds the reads
 *                                        and the memory, and decides how much
 *                                        work one failure can cost.
 * @param {function} [options.onProgress] called with a running summary after
 *                                        each batch.
 * @param {function} [options.shouldStop] return true to stop cleanly between
 *                                        batches, for SIGINT handling.
 */
async function backfillProfiles({
  client,
  now = new Date(),
  batchSize = 200,
  phones = null,
  onProgress = null,
  shouldStop = null,
  dryRun = false
} = {}) {
  if (!client) throw new ProfileBuilderError('backfillProfiles needs a Supabase client.', 'PROFILE_NO_CLIENT');
  const targets = phones ? [...new Set(phones.filter(Boolean))].sort() : await profileablePhones({ client });

  const summary = { contacts: targets.length, considered: 0, written: 0, skipped: 0, failed: [], stopped: false };
  if (dryRun) return summary;

  const size = Math.max(1, Math.trunc(Number(batchSize) || 200));
  for (let index = 0; index < targets.length; index += size) {
    if (typeof shouldStop === 'function' && shouldStop()) { summary.stopped = true; break; }
    const batch = targets.slice(index, index + size);
    try {
      const result = await buildProfiles({ client, phones: batch, now });
      summary.considered += result.considered;
      summary.written += result.written;
      summary.skipped += result.skipped;
      summary.failed.push(...result.failed);
    } catch (error) {
      // One unreadable batch must not abandon the other 800 contacts. The
      // batch keeps its old fingerprints, so the next run retries it.
      const failure = asBuilderError(error);
      summary.failed.push({ phone: `batch:${index}`, error: failure.message });
      if (failure.code === 'PROFILE_COLUMNS_MISSING') throw failure;
    }
    if (typeof onProgress === 'function') onProgress({ ...summary, failed: summary.failed.length });
  }
  return summary;
}

/**
 * The nightly drift sweep.
 *
 * Same builder as the two webhooks; no separate logic, because three
 * definitions of "what is this person's profile" is the fault this whole file
 * is written to avoid. Almost every contact is skipped on a fingerprint match,
 * so a full sweep of 843 people costs a handful of paged reads and no writes.
 *
 * Disabled only by CONTACT_PROFILES_SWEEP_DISABLED being the exact string
 * 'true'. A negative flag, so the default is on: the feature is read-mostly
 * and write-safe, and a flag that had to be REMEMBERED at deploy time would
 * mean the profiles silently stopped being maintained.
 */
async function sweepProfileDrift({ client, now = new Date(), env = process.env, batchSize = 200 } = {}) {
  // `disabled`, not `skipped`. The summary underneath already uses `skipped`
  // to mean "contacts whose fingerprints matched", and spreading one over the
  // other made a disabled sweep and a sweep where nothing had changed report
  // the identical shape — one key, two answers, which is the fault this
  // feature is written to avoid.
  if (String(env.CONTACT_PROFILES_SWEEP_DISABLED || '') === 'true') {
    return {
      disabled: true, reason: 'disabled',
      contacts: 0, considered: 0, written: 0, skipped: 0, failed: [], stopped: false
    };
  }
  const summary = await backfillProfiles({ client, now, batchSize });
  return { disabled: false, reason: 'swept', ...summary };
}

module.exports = {
  COLUMNS,
  ENGAGEMENT_TIERS,
  PROFILE_TABLE,
  PROFILE_VERSION,
  ProfileBuilderError,
  RECEIVED_STATES,
  backfillProfiles,
  buildProfiles,
  cadenceFor,
  centsFrom,
  computeProfile,
  engagementTierFor,
  fingerprintOf,
  profileablePhones,
  refreshProfile,
  refreshProfileQuietly,
  sweepProfileDrift
};
