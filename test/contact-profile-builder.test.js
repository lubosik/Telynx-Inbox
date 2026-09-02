'use strict';
/**
 * test/contact-profile-builder.test.js — the deterministic client profile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS ACTUALLY AT RISK HERE
 *
 *   This file writes columns that campaigns will select on: who is overdue,
 *   who never replies, what somebody keeps buying. Every one of those is a
 *   decision about whether a real person is messaged, so the failure mode is
 *   not a wrong number on a screen — it is outreach withheld from the person
 *   who needed it, or sent to somebody whose only order was cancelled.
 *
 *   Four specific things have gone wrong before, in this repository, and each
 *   has a test below rather than a comment:
 *
 *   1. `sms_orders.status` holds FULFILMENT states. 252 rows are cancelled and
 *      83 failed. Code that qualified on `completed` alone once skipped 97% of
 *      real orders while looking correct.
 *   2. `calculateReorderCadence` nests the rhythm under `.cadence`. Reading the
 *      outer object silently sends every mid-cycle customer to the shop median
 *      instead of their own measured interval.
 *   3. Unpaged reads stop at 1000 rows without erroring, and `.in()` overflows
 *      the request URL at around 900 values. Both took the inbox down.
 *   4. A column with two writers eventually has the emptiest one win. The
 *      builder must not write `last_checkin_variant` or `updated_at`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLUMNS,
  PROFILE_VERSION,
  ProfileBuilderError,
  backfillProfiles,
  buildProfiles,
  computeProfile,
  engagementTierFor,
  fingerprintOf,
  profileablePhones,
  refreshProfileQuietly,
  sweepProfileDrift
} = require('../lib/profiles/profile-builder');
const { DEFAULT_REORDER_DAYS } = require('../lib/campaigns/checkin-offer-policy');

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE = '+15551110001';
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

let nextId = 1;
function order({ phone = PHONE, status = 'delivered', at = daysAgo(30), total = '100.00', items = [] } = {}) {
  return { id: nextId++, contact_phone: phone, status, created_at: at, total, items };
}
function message({ phone = PHONE, direction = 'inbound', at = daysAgo(5) } = {}) {
  return { id: nextId++, contact_phone: phone, direction, created_at: at };
}
function recipient({ phone = PHONE, campaign = 'c-plain', state = 'delivered', at = daysAgo(10) } = {}) {
  return { id: `r-${nextId++}`, contact_phone: phone, campaign_id: campaign, state, sent_at: at, delivered_at: at };
}

function profileOf(input) {
  return computeProfile({ phone: PHONE, now: NOW, ...input }).payload;
}

// ── computeProfile: orders ─────────────────────────────────────────────────

test('only paid fulfilment states count as a purchase', () => {
  // The distribution that makes this the first test in the file: shipped 642,
  // delivered 608, cancelled 252, failed 83, completed 47. `processing` is
  // paid-but-unshipped and must count; `on-hold` has not been paid for.
  const profile = profileOf({
    orders: [
      order({ status: 'processing', total: '10.00' }),
      order({ status: 'completed', total: '10.00' }),
      order({ status: 'shipped', total: '10.00' }),
      order({ status: 'delivered', total: '10.00' }),
      order({ status: 'cancelled', total: '99.00' }),
      order({ status: 'failed', total: '99.00' }),
      order({ status: 'refunded', total: '99.00' }),
      order({ status: 'on-hold', total: '99.00' }),
      order({ status: 'pending', total: '99.00' })
    ]
  });
  assert.equal(profile.order_count, 4);
  assert.equal(profile.total_spend_cents, 4000, 'the 99.00 rows are not purchases');
});

test('a contact whose every order failed is flagged, and one with no orders is not', () => {
  // has_only_unpaid_orders exists so that a dead order is never read as recent
  // activity. Somebody whose orders all failed is the person MOST in need of
  // being contacted, and treating a cancelled order as a return visit is
  // exactly what would withhold it.
  const failedOnly = profileOf({ orders: [order({ status: 'cancelled' }), order({ status: 'failed' })] });
  assert.equal(failedOnly.has_only_unpaid_orders, true);
  assert.equal(failedOnly.order_count, 0);
  assert.equal(failedOnly.last_order_at, null);

  // The boundary that a naive `paid.length === 0` gets wrong: never having
  // ordered is not the same as having ordered and been refused.
  const neverOrdered = profileOf({ orders: [] });
  assert.equal(neverOrdered.has_only_unpaid_orders, false);

  const mixed = profileOf({ orders: [order({ status: 'delivered' }), order({ status: 'failed' })] });
  assert.equal(mixed.has_only_unpaid_orders, false);
});

test('money is stored in cents and does not drift', () => {
  // 19.99 * 100 is 1998.9999999999998 in IEEE 754. Truncating that reports a
  // cent less on every single order, and the error compounds across a total.
  const profile = profileOf({
    orders: [order({ total: '19.99' }), order({ total: '19.99' }), order({ total: '0.03' })]
  });
  assert.equal(profile.total_spend_cents, 4001);
  assert.equal(profile.avg_order_value_cents, 1334, 'rounded, not truncated');
});

test('a missing or unparseable total is zero rather than NaN', () => {
  // One NaN anywhere in a sum makes the whole sum NaN, and a NaN reaching a
  // bigint column fails the write for the entire batch, not just this row.
  const profile = profileOf({ orders: [order({ total: null }), order({ total: 'free' }), order({ total: '5.00' })] });
  assert.equal(profile.total_spend_cents, 500);
  assert.equal(profile.order_count, 3);
});

test('first and last order dates come from paid orders only, in time order', () => {
  const profile = profileOf({
    orders: [
      order({ at: daysAgo(10), status: 'shipped' }),
      order({ at: daysAgo(200), status: 'delivered' }),
      order({ at: daysAgo(1), status: 'cancelled' })
    ]
  });
  assert.equal(profile.first_order_at, daysAgo(200));
  assert.equal(profile.last_order_at, daysAgo(10), 'the cancelled row one day ago is not the last order');
});

test('how long since they bought is NOT stored, deliberately', () => {
  // It is not a fact about the customer, it is a fact about now, and a stored
  // copy is wrong the day after it is written. The fingerprint skip is correct
  // — an unchanged contact costs no write — so the column would have frozen at
  // whatever it was when the profile was first built. Demonstrated on real
  // rows during QA: the same contacts 90 days later gave 191 -> 281 days with
  // identical fingerprints, so the sweep would never have rewritten them.
  //
  // A "lapsed buyer" segment reading that column would then permanently
  // exclude everybody whose profile was built while they were fresh: exactly
  // the people the outreach exists for.
  //
  // last_order_at is the fact and cannot go stale. segment-rule-evaluator.js
  // already computes daysSinceLastOrder live from facts, so a stored second
  // answer was the fault this codebase keeps repeating.
  const profile = profileOf({ orders: [order({ at: daysAgo(10) })] });
  assert.ok(!('days_since_last_order' in profile),
    'a value that changes without the data changing must not be stored');
  assert.equal(profile.last_order_at, daysAgo(10), 'the durable fact is kept');
});

// ── computeProfile: SKUs and last product ──────────────────────────────────

test('top SKUs are the ones they came back for, capped at five and stably ordered', () => {
  // Counted per ORDER, not per line quantity: somebody who bought six vials
  // once is not a more habitual buyer than somebody who returned three times
  // for one. And the order of the array must be stable across rebuilds, or
  // every sweep sees a change where there is none.
  const orders = [
    order({ at: daysAgo(50), items: [{ sku: 'RT20', quantity: 6 }] }),
    order({ at: daysAgo(40), items: [{ sku: 'TZ10', quantity: 1 }, { sku: 'RT20', quantity: 1 }] }),
    order({ at: daysAgo(30), items: [{ sku: 'RT20', quantity: 1 }, { sku: 'SM10', quantity: 1 }] }),
    order({ at: daysAgo(20), items: [{ sku: 'TZ10', quantity: 1 }] }),
    order({ at: daysAgo(10), items: [{ sku: 'AA10' }, { sku: 'BB10' }, { sku: 'CC10' }] })
  ];
  const profile = profileOf({ orders });
  assert.equal(profile.top_skus.length, 5, 'capped');
  assert.deepEqual(profile.top_skus.slice(0, 2), ['RT20', 'TZ10'], 'most-ordered first');
  assert.deepEqual(
    profile.distinct_skus,
    ['AA10', 'BB10', 'CC10', 'RT20', 'SM10', 'TZ10'],
    'sorted, so two rebuilds of an unchanged history are byte-identical'
  );
  assert.deepEqual(profileOf({ orders }).top_skus, profile.top_skus, 'and deterministic');
});

test('the same SKU twice in one order counts as one order for it', () => {
  const profile = profileOf({
    orders: [order({ items: [{ sku: 'RT20' }, { sku: 'rt20' }, { sku: 'TZ10' }] })]
  });
  assert.deepEqual(profile.distinct_skus, ['RT20', 'TZ10'], 'case-normalised and de-duplicated');
  assert.deepEqual(profile.top_skus, ['RT20', 'TZ10']);
});

test('the last product is the most valuable line, not the first', () => {
  // Orders here routinely LEAD with BAC water or a syringe pack, so items[0]
  // names the accessory and not the product somebody came for. This is why
  // itemsByValue is imported from personalise.js rather than reimplemented:
  // the profile and the campaign renderer must never pick different products
  // out of the same order.
  const profile = profileOf({
    orders: [
      order({ at: daysAgo(60), items: [{ name: 'TZ', sku: 'TZ10', total: '200.00' }] }),
      order({
        at: daysAgo(5),
        items: [
          { name: 'BAC Water', sku: 'P-WA10', total: '12.00' },
          { name: 'RT', sku: 'RT20', total: '129.00' }
        ]
      })
    ]
  });
  assert.equal(profile.last_product_name, 'RT');
  assert.equal(profile.last_product_sku, 'RT20', 'name and SKU come from the SAME line item');
  assert.deepEqual(profile.last_order_skus, ['RT20', 'P-WA10'], 'most valuable first');
});

test('the stored product is the LABEL a customer would read, not the store name', () => {
  // Orders predating the store's renames carry a name and sku: null. 58 of 155
  // people in one win-back were in exactly this state.
  //
  // This used to assert the raw name, "Retatrutide - 20mg". That is what the
  // store calls it and it is not what a message may say: approvedProductLabel
  // matches an exact approved CODE, so the raw name never qualifies, and
  // `name || sku` short-circuits so a good SKU is blocked behind the unusable
  // name.
  //
  // Measured against the live catalogue: the campaign renderer produced an
  // approved label for 832 of 844 buyers and this produced one for 3. So 829
  // people were being routed to a "we don't know what you bought" variant that
  // the campaign path could name perfectly well. The rename map turns this one
  // into "RT", which is exactly what the win-back would print.
  const profile = profileOf({
    orders: [order({ items: [{ name: 'Retatrutide - 20mg', sku: null, total: '129.00' }] })]
  });
  assert.equal(profile.last_product_name, 'RT', 'the approved label, not the shelf name');
  assert.equal(profile.last_product_sku, null);
  assert.deepEqual(profile.last_order_skus, []);
});

test('a product nobody can name in words stores no product at all', () => {
  // The alternative is naming a SKU at the customer. That shipped once and
  // told somebody who bought BAC water they had money off "P-WA10", which the
  // owner rightly called nonsense. A product that cannot be named in words the
  // customer would recognise is not named, and they get the copy that names no
  // product.
  const profile = profileOf({
    orders: [order({ items: [{ name: 'Mystery Item', sku: 'ZZ99', total: '5.00' }] })]
  });
  assert.equal(profile.last_product_name, null);
  assert.equal(profile.last_product_sku, null);
});

// ── computeProfile: reorder rhythm ─────────────────────────────────────────

test('a measurable personal rhythm beats the shop median', () => {
  // Four orders, three even 30-day gaps. `high` needs three intervals.
  const profile = profileOf({
    orders: [daysAgo(120), daysAgo(90), daysAgo(60), daysAgo(30)].map(at => order({ at }))
  });
  assert.equal(profile.reorder_interval_days, 30);
  assert.equal(profile.reorder_interval_source, 'personal');
  assert.equal(profile.cadence_confidence, 'high');
  assert.equal(profile.reorder_due_at, daysAgo(0), 'last order plus the interval');
});

test('a mid-cycle customer keeps their own interval — the .cadence nesting trap', () => {
  // calculateReorderCadence's OUTER object answers "should we contact them
  // now" and comes back eligible:false / reorder_window_not_reached for
  // somebody who bought five days ago, while carrying a perfectly good median
  // underneath on `.cadence`. Reading the outer shape silently sends every
  // mid-cycle customer to the 35-day shop median instead of their own 30.
  //
  // This is a bug that was already hit once in this codebase. It is invisible
  // in production because the fallback is a plausible number.
  const profile = profileOf({
    orders: [daysAgo(95), daysAgo(65), daysAgo(35), daysAgo(5)].map(at => order({ at }))
  });
  assert.equal(profile.reorder_interval_source, 'personal');
  assert.equal(profile.reorder_interval_days, 30, 'their number, not the shop median');
  assert.notEqual(profile.reorder_interval_days, DEFAULT_REORDER_DAYS);
});

test('two orders is not a rhythm, and falls back to the shop median', () => {
  // The floor is two INTERVALS, so three orders. At one interval the
  // consistency test is arithmetically vacuous — the median of a single value
  // is that value, so the deviation is always 0 and every two-order customer
  // would come back high-confidence, including one whose orders were three
  // days apart. Measured: 218 of 269 people qualified that way, 201 of them
  // labelled high confidence on evidence that cannot fail.
  const profile = profileOf({ orders: [order({ at: daysAgo(70) }), order({ at: daysAgo(40) })] });
  assert.equal(profile.reorder_interval_source, 'shop_median');
  assert.equal(profile.reorder_interval_days, DEFAULT_REORDER_DAYS);
  assert.equal(profile.cadence_confidence, 'none', 'the shop median says nothing about this person');
  assert.equal(profile.reorder_due_at, daysAgo(40 - DEFAULT_REORDER_DAYS));
});

test('an erratic buyer is given the shop median rather than an invented rhythm', () => {
  const profile = profileOf({
    orders: [daysAgo(300), daysAgo(290), daysAgo(100), daysAgo(10)].map(at => order({ at }))
  });
  assert.equal(profile.reorder_interval_source, 'shop_median');
  assert.equal(profile.cadence_confidence, 'none');
});

test('three consistent orders are worth an interval but not high confidence', () => {
  // Two consistent gaps are real evidence and worth acting on. They are also
  // two observations, so `high` stays reserved for three — nothing downstream
  // that trusts `high` has quietly had its bar moved.
  const profile = profileOf({
    orders: [daysAgo(90), daysAgo(60), daysAgo(30)].map(at => order({ at }))
  });
  assert.equal(profile.reorder_interval_source, 'personal');
  assert.equal(profile.cadence_confidence, 'low');
});

test('no paid order means no due date at all, not a due date of today', () => {
  // A contact with nothing to measure from must be ABSENT from "who is due
  // back", not sitting at the top of it.
  const profile = profileOf({ orders: [order({ status: 'cancelled' })] });
  assert.equal(profile.reorder_interval_days, null);
  assert.equal(profile.reorder_interval_source, null);
  assert.equal(profile.reorder_due_at, null);
  assert.equal(profile.cadence_confidence, 'none');
});

test('reorder_due_at agrees exactly with last_order_at plus reorder_interval_days', () => {
  // The two columns are read together, and a reader who recomputes one from
  // the other must land on the stored value rather than a few hours away from
  // it. That only holds if the interval is rounded once and used rounded.
  const profile = profileOf({ orders: [order({ at: daysAgo(11) })] });
  const recomputed = new Date(Date.parse(profile.last_order_at) + profile.reorder_interval_days * DAY_MS);
  assert.equal(profile.reorder_due_at, recomputed.toISOString());
});

// ── computeProfile: messages ───────────────────────────────────────────────

test('engagement tiers sit exactly on the measured distribution', () => {
  // 559 contacts have zero inbound, 102 have one, 89 have two to four, 59 have
  // five or more. The boundaries are what a campaign will select on, so each
  // one is pinned rather than sampled.
  assert.equal(engagementTierFor(0), 'silent');
  assert.equal(engagementTierFor(1), 'flicker');
  assert.equal(engagementTierFor(2), 'talker');
  assert.equal(engagementTierFor(4), 'talker');
  assert.equal(engagementTierFor(5), 'regular');
  assert.equal(engagementTierFor(500), 'regular');
});

test('outbound messages do not make somebody a talker', () => {
  // The whole reason the tiers exist: 69% of contacts with any SMS have never
  // sent one. A tier computed from total messages would call every one of them
  // conversational, because we messaged them.
  const profile = profileOf({
    messages: [
      message({ direction: 'outbound' }), message({ direction: 'outbound' }),
      message({ direction: 'outbound' }), message({ direction: 'outbound' })
    ]
  });
  assert.equal(profile.engagement_tier, 'silent');
  assert.equal(profile.has_replied_ever, false);
  assert.equal(profile.outbound_message_count, 4);
  assert.equal(profile.inbound_message_count, 0);
  assert.equal(profile.last_inbound_at, null);
});

test('last_inbound_at is the newest inbound, whatever order the rows arrive in', () => {
  const profile = profileOf({
    messages: [
      message({ direction: 'inbound', at: daysAgo(2) }),
      message({ direction: 'inbound', at: daysAgo(40) }),
      message({ direction: 'outbound', at: daysAgo(1) })
    ]
  });
  assert.equal(profile.last_inbound_at, daysAgo(2), 'the outbound one day ago is not a reply');
  assert.equal(profile.inbound_message_count, 2);
  assert.equal(profile.has_replied_ever, true);
  assert.equal(profile.engagement_tier, 'talker');
});

// ── computeProfile: campaign history ───────────────────────────────────────

test('only messages that actually went out count as campaigns received', () => {
  // Counting attempts would make "how many campaigns has this person received"
  // larger than the number of messages on their phone — the sort of number
  // somebody uses to decide NOT to contact them again.
  const profile = profileOf({
    recipients: [
      recipient({ state: 'sent' }),
      recipient({ state: 'delivered' }),
      recipient({ state: 'failed' }),
      recipient({ state: 'claimed' }),
      recipient({ state: 'suppressed' }),
      recipient({ state: 'draft' })
    ]
  });
  assert.equal(profile.campaigns_received_count, 2);
});

test('last_checkin_at only counts 21-day check-ins, and takes the most recent', () => {
  const profile = profileOf({
    recipients: [
      recipient({ campaign: 'c-winback', at: daysAgo(3) }),
      recipient({ campaign: 'c-checkin-1', at: daysAgo(40) }),
      recipient({ campaign: 'c-checkin-2', at: daysAgo(12) }),
      recipient({ campaign: 'c-checkin-3', at: daysAgo(1), state: 'failed' })
    ],
    checkInCampaignIds: new Set(['c-checkin-1', 'c-checkin-2', 'c-checkin-3'])
  });
  assert.equal(profile.last_checkin_at, daysAgo(12), 'a check-in that failed to send was not received');
  assert.equal(profile.campaigns_received_count, 3);
});

// ── The sole-writer rule ───────────────────────────────────────────────────

test('the payload writes the builder’s columns and nothing else', () => {
  // The rule that matters. `last_checkin_variant` is chosen at campaign
  // approval and cannot be re-derived from orders or messages, so a builder
  // that included it would write NULL over Phase 2's answer on every nightly
  // sweep. `updated_at` and the ten other legacy columns belong to
  // intelligence.js.
  const profile = profileOf({ orders: [order()], messages: [message()], recipients: [recipient()] });
  const written = Object.keys(profile).sort();
  assert.deepEqual(written, ['contact_phone', ...COLUMNS].sort());

  for (const forbidden of [
    'last_checkin_variant', 'updated_at', 'raw_summary', 'sentiment', 'last_analysed',
    'inferred_interests', 'order_signals', 'restock_interests', 'campaign_recommendations',
    'ghl_contact_id', 'id'
  ]) {
    assert.equal(forbidden in profile, false, `${forbidden} has another owner`);
  }
});

test('the profile stores no name, email or opt-out state', () => {
  // Each already has exactly one home — sms_contacts, and the opt-out
  // sentinel. Copying them here would be a second answer to a question that
  // already has one, and the copy is the one that goes stale.
  const profile = profileOf({ orders: [order()] });
  const text = JSON.stringify(profile);
  assert.ok(!/email|opted_out|first_name|contact_name/.test(text));
});

// ── Fingerprints ───────────────────────────────────────────────────────────

test('a fingerprint is count plus newest timestamp, normalised through Date', () => {
  // PostgREST renders timestamptz as `...+00:00` and everything this process
  // mints ends in `Z`. Same instant, different string — a fingerprint built
  // from raw text would compare unequal against itself and rebuild every row
  // on every sweep, which is a skip that never skips.
  const postgrest = fingerprintOf([{ created_at: '2026-08-01T12:00:00+00:00' }]);
  const minted = fingerprintOf([{ created_at: '2026-08-01T12:00:00.000Z' }]);
  assert.equal(postgrest, minted);
  assert.equal(minted, '1:2026-08-01T12:00:00.000Z');
});

test('an empty set has a real fingerprint, so a non-buyer can still be marked built', () => {
  assert.equal(fingerprintOf([]), '0:');
});

test('the fingerprint takes the newest row, not the last one in the array', () => {
  const out = fingerprintOf([
    { created_at: '2026-08-01T12:00:00Z' },
    { created_at: '2026-09-01T12:00:00Z' },
    { created_at: '2026-07-01T12:00:00Z' }
  ]);
  assert.equal(out, '3:2026-09-01T12:00:00.000Z');
});

test('the orders fingerprint ignores cancelled orders', () => {
  // Otherwise a customer cancelling an order would look like a change worth
  // rebuilding for, and — worse — a profile built before the cancellation
  // would never be rebuilt after it if the count happened to match.
  const paidOnly = profileOf({ orders: [order({ at: daysAgo(30) })] });
  const withCancelled = profileOf({
    orders: [order({ at: daysAgo(30) }), order({ at: daysAgo(1), status: 'cancelled' })]
  });
  assert.equal(paidOnly.orders_fingerprint, withCancelled.orders_fingerprint);
});

test('the messages fingerprint counts both directions', () => {
  // An outbound send changes nothing about the customer but does change
  // outbound_message_count, so it has to invalidate the row or that column
  // goes permanently stale.
  const before = profileOf({ messages: [message({ direction: 'inbound', at: daysAgo(5) })] });
  const after = profileOf({
    messages: [message({ direction: 'inbound', at: daysAgo(5) }), message({ direction: 'outbound', at: daysAgo(1) })]
  });
  assert.notEqual(before.messages_fingerprint, after.messages_fingerprint);
});

test('computeProfile refuses a missing phone and an invalid clock', () => {
  assert.throws(() => computeProfile({ phone: null }), ProfileBuilderError);
  assert.throws(() => computeProfile({ phone: PHONE, now: 'never' }), ProfileBuilderError);
});

// ══ Database paths ═════════════════════════════════════════════════════════

/**
 * A Supabase stand-in that behaves like PostgREST in the two ways that matter:
 * `.range()` really slices, so an unpaged read really does truncate, and every
 * request is recorded so the tests can assert HOW the data was fetched rather
 * than only what came back.
 */
function fakeClient({ tables = {}, readError = null, upsertError = null, explode = false } = {}) {
  const requests = [];
  const upserts = [];
  const compare = (a, b) => {
    const left = a === null || a === undefined ? '' : a;
    const right = b === null || b === undefined ? '' : b;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  };

  return {
    requests,
    upserts,
    from(table) {
      if (explode) throw new Error('connection refused');
      const state = { filters: [], orders: [], range: null, inValues: null };
      const chain = {
        select() { return chain; },
        range(from, to) { state.range = [from, to]; return chain; },
        eq(column, value) { state.filters.push(row => row?.[column] === value); return chain; },
        in(column, values) {
          state.inValues = values;
          const set = new Set(values);
          state.filters.push(row => set.has(row?.[column]));
          return chain;
        },
        order(column, options = {}) {
          state.orders.push({ column, ascending: options.ascending !== false });
          return chain;
        },
        upsert(rows, options) {
          upserts.push({ table, rows: [].concat(rows), options });
          return Promise.resolve({ data: null, error: upsertError ? { message: upsertError } : null });
        },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            requests.push({ table, inCount: state.inValues?.length ?? null, range: state.range });
            if (readError?.table === table) return { data: null, error: { message: readError.message } };
            let rows = (tables[table] || []).filter(row => state.filters.every(match => match(row)));
            for (const sort of [...state.orders].reverse()) {
              rows = rows.slice().sort((a, b) => compare(a[sort.column], b[sort.column]) * (sort.ascending ? 1 : -1));
            }
            const [from, to] = state.range || [0, rows.length - 1];
            return { data: rows.slice(from, to + 1), error: null };
          }).then(resolve, reject);
        }
      };
      return chain;
    }
  };
}

function storedProfile(payload) {
  return {
    id: 1,
    contact_phone: PHONE,
    profile_version: PROFILE_VERSION,
    deterministic_built_at: daysAgo(1),
    orders_fingerprint: payload.orders_fingerprint,
    messages_fingerprint: payload.messages_fingerprint
  };
}

test('an unchanged contact costs no write at all', () => {
  // The reason the fingerprints exist. Without the skip the nightly sweep
  // rewrites 843 identical rows every night, churning the indexes and
  // destroying the one signal that says when a profile last actually changed.
  const orders = [order({ at: daysAgo(30) })];
  const messages = [message({ at: daysAgo(5) })];
  const expected = profileOf({ orders, messages });

  const client = fakeClient({
    tables: {
      sms_orders: orders,
      sms_messages: messages,
      sms_campaign_recipients: [],
      sms_customer_profiles: [storedProfile(expected)]
    }
  });

  return buildProfiles({ client, phones: [PHONE], now: NOW }).then(summary => {
    assert.equal(summary.skipped, 1);
    assert.equal(summary.written, 0);
    assert.deepEqual(client.upserts, [], 'not even a touched timestamp');
  });
});

test('a new order breaks the fingerprint and the row is rebuilt', async () => {
  const orders = [order({ at: daysAgo(30) })];
  const stale = storedProfile(profileOf({ orders }));
  orders.push(order({ at: daysAgo(1) }));

  const client = fakeClient({
    tables: {
      sms_orders: orders,
      sms_messages: [],
      sms_campaign_recipients: [],
      sms_customer_profiles: [stale]
    }
  });

  const summary = await buildProfiles({ client, phones: [PHONE], now: NOW });
  assert.equal(summary.written, 1);
  assert.equal(client.upserts[0].rows[0].order_count, 2);
  assert.equal(client.upserts[0].options.onConflict, 'contact_phone');
});

test('a profile built by an older version of this file is rebuilt even when nothing changed', async () => {
  // The fingerprints answer "have the rows changed"; profile_version answers
  // "has our reading of them changed". Without it, improving the builder would
  // apply only to contacts who happened to buy something afterwards, and the
  // table would hold two generations that look identical and disagree.
  const orders = [order({ at: daysAgo(30) })];
  const stale = { ...storedProfile(profileOf({ orders })), profile_version: PROFILE_VERSION - 1 };

  const client = fakeClient({
    tables: { sms_orders: orders, sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: [stale] }
  });
  const summary = await buildProfiles({ client, phones: [PHONE], now: NOW });
  assert.equal(summary.written, 1);
});

test('matching fingerprints with no build timestamp are not trusted', () => {
  // A row carrying fingerprints but no deterministic_built_at was never
  // actually built by this file. Skipping it would leave a contact permanently
  // without a profile while every sweep reported them as up to date.
  const orders = [order({ at: daysAgo(30) })];
  const halfWritten = { ...storedProfile(profileOf({ orders })), deterministic_built_at: null };

  const client = fakeClient({
    tables: { sms_orders: orders, sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: [halfWritten] }
  });
  return buildProfiles({ client, phones: [PHONE], now: NOW })
    .then(summary => assert.equal(summary.written, 1));
});

test('the upsert carries only the builder’s own columns', async () => {
  const client = fakeClient({
    tables: {
      sms_orders: [order()], sms_messages: [message()],
      sms_campaign_recipients: [], sms_customer_profiles: []
    }
  });
  await buildProfiles({ client, phones: [PHONE], now: NOW });
  const written = Object.keys(client.upserts[0].rows[0]).sort();
  assert.deepEqual(written, ['contact_phone', ...COLUMNS].sort());
});

test('a contact with more than 1000 messages is counted in full', async () => {
  // PostgREST silently caps a response at 1000 rows. An unpaged read here
  // would report 1000 inbound messages for a contact who sent 1200 and would
  // fingerprint the truncated set, so the row would look up to date forever.
  // This is one of the two behaviours that took the inbox down.
  const messages = Array.from({ length: 1200 }, (_, index) =>
    message({ direction: 'inbound', at: new Date(NOW.getTime() - (1200 - index) * 60_000).toISOString() }));

  const client = fakeClient({
    tables: { sms_orders: [], sms_messages: messages, sms_campaign_recipients: [], sms_customer_profiles: [] }
  });
  await buildProfiles({ client, phones: [PHONE], now: NOW });
  assert.equal(client.upserts[0].rows[0].inbound_message_count, 1200);

  const pages = client.requests.filter(request => request.table === 'sms_messages');
  assert.ok(pages.length >= 2, 'it paged rather than trusting one response');
});

test('a large audience is read in chunks small enough for the URL', async () => {
  // `.in()` serialises every value into the request URL. At 907 contacts that
  // is an ~11,800-character filter, which overflows Node's HTTP header limit
  // and fails the request after a ten-second stall — silently, from the
  // caller's point of view.
  const phones = Array.from({ length: 450 }, (_, index) => `+1555111${String(index).padStart(4, '0')}`);
  const client = fakeClient({
    tables: { sms_orders: [], sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: [] }
  });

  await buildProfiles({ client, phones, now: NOW });
  const orderReads = client.requests.filter(request => request.table === 'sms_orders');
  assert.ok(orderReads.length >= 3, '450 phones cannot be one request');
  for (const read of orderReads) {
    assert.ok(read.inCount <= 200, `a chunk of ${read.inCount} is too wide`);
  }
});

test('a missing migration is named, not left as a raw Postgres error', async () => {
  // Otherwise the nightly sweep logs `column ... does not exist` once a night
  // forever and nobody connects it to an unapplied migration.
  const client = fakeClient({
    tables: { sms_orders: [], sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: [] },
    readError: {
      table: 'sms_customer_profiles',
      message: 'column sms_customer_profiles.orders_fingerprint does not exist'
    }
  });

  await assert.rejects(
    () => buildProfiles({ client, phones: [PHONE], now: NOW }),
    error => {
      assert.equal(error.code, 'PROFILE_COLUMNS_MISSING');
      assert.match(error.message, /contact-profiles-migration\.sql/);
      return true;
    }
  );
});

test('a failed write is reported per contact and does not throw', async () => {
  // A backfill that stops on the first bad row leaves 800 contacts unbuilt.
  // The failed batch keeps its old fingerprints, so the next run retries it.
  const client = fakeClient({
    tables: {
      sms_orders: [order()], sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: []
    },
    upsertError: 'duplicate key value violates unique constraint'
  });
  const summary = await buildProfiles({ client, phones: [PHONE], now: NOW });
  assert.equal(summary.written, 0);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].phone, PHONE);
  assert.match(summary.failed[0].error, /duplicate key/);
});

test('refreshProfileQuietly never throws into a webhook, and never fails silently', async () => {
  // It is called from the WooCommerce order webhook and the Telnyx inbound
  // handler, both of which have already answered the provider with 200. A
  // rejection there is an unhandled rejection in the process that also carries
  // the inbox, the dialler and order SMS.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await refreshProfileQuietly({ client: fakeClient({ explode: true }), phone: PHONE });
    assert.equal(result.written, false);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, 'loud enough to find, quiet enough not to break the webhook');
  assert.ok(!warnings[0].includes(PHONE), 'the full number is never logged');
});

test('refreshProfileQuietly refuses an incomplete request rather than guessing', async () => {
  assert.deepEqual(
    await refreshProfileQuietly({ client: null, phone: PHONE }),
    { written: false, reason: 'invalid_request' }
  );
  assert.deepEqual(
    await refreshProfileQuietly({ client: fakeClient({}), phone: null }),
    { written: false, reason: 'invalid_request' }
  );
});

// ── Backfill and sweep ─────────────────────────────────────────────────────

function backfillClient() {
  const orders = [
    order({ phone: '+15551110001', at: daysAgo(30) }),
    order({ phone: '+15551110002', at: daysAgo(10) }),
    order({ phone: '+15551110003', at: daysAgo(5), status: 'cancelled' })
  ];
  return fakeClient({
    tables: {
      sms_orders: orders,
      sms_messages: [message({ phone: '+15551110002', at: daysAgo(2) })],
      sms_campaign_recipients: [],
      // A contact with no paid order who already has a row: created by an
      // inbound-SMS refresh, and it must keep being maintained.
      sms_customer_profiles: [{ id: 9, contact_phone: '+15551119999' }]
    }
  });
}

test('the backfill covers everybody who ORDERED, paid or not', async () => {
  // This used to exclude a contact whose only order was cancelled, on the
  // reasoning that they are not a buyer. True, and it made
  // has_only_unpaid_orders — the column that exists precisely to stop such a
  // person being treated as a returning customer — impossible for anybody to
  // have. A guard that cannot reach the people it guards is not a guard.
  //
  // Measured on production: 125 contacts have only unpaid orders, $25,009.88
  // of orders that never completed, 71 of them for RT. Two share an email with
  // a paying customer and none shares a phone, so they are not duplicates of
  // existing buyers — they are people who tried to buy and did not, and they
  // were invisible to every segment.
  //
  // A contact created by an inbound-SMS refresh is still included too, or
  // their row is written once and drifts forever.
  const client = backfillClient();
  const phones = await profileablePhones({ client });
  assert.deepEqual(phones,
    ['+15551110001', '+15551110002', '+15551110003', '+15551119999'],
    'the cancelled-only contact is now in');
});

test('running the backfill twice changes nothing the second time', async () => {
  // The definition of idempotent that matters operationally: an operator who
  // is unsure whether it finished can simply run it again.
  const client = backfillClient();
  const first = await backfillProfiles({ client, now: NOW, batchSize: 2 });
  assert.equal(first.written, 4, 'three ordering contacts plus the existing row');
  assert.deepEqual(first.failed, []);

  // Feed the rows it just wrote back in as the stored state.
  const written = client.upserts.flatMap(entry => entry.rows).map((row, index) => ({
    id: 100 + index,
    ...row
  }));
  const second = backfillClient();
  second.upserts.length = 0;
  const replay = fakeClient({
    tables: {
      sms_orders: [
        order({ phone: '+15551110001', at: daysAgo(30) }),
        order({ phone: '+15551110002', at: daysAgo(10) }),
        order({ phone: '+15551110003', at: daysAgo(5), status: 'cancelled' })
      ],
      sms_messages: [message({ phone: '+15551110002', at: daysAgo(2) })],
      sms_campaign_recipients: [],
      sms_customer_profiles: written
    }
  });
  const again = await backfillProfiles({ client: replay, now: NOW, batchSize: 2 });
  assert.equal(again.written, 0);
  assert.equal(again.skipped, 4, 'all four unchanged on the replay');
  assert.deepEqual(replay.upserts, []);
});

test('a dry run reports the population and writes nothing', async () => {
  const client = backfillClient();
  const summary = await backfillProfiles({ client, now: NOW, dryRun: true });
  assert.equal(summary.contacts, 4);
  assert.equal(summary.written, 0);
  assert.deepEqual(client.upserts, []);
});

test('the backfill stops between batches when asked, without losing what it built', async () => {
  // Ctrl-C must not land in the middle of a write. Stopping between batches
  // leaves a consistent set of rows that the next run skips.
  const client = backfillClient();
  let batches = 0;
  const summary = await backfillProfiles({
    client, now: NOW, batchSize: 1,
    shouldStop: () => batches++ >= 1
  });
  assert.equal(summary.stopped, true);
  assert.equal(summary.written, 1, 'the first batch was still committed');
});

test('the sweep is on by default and only the exact string "true" turns it off', async () => {
  // Every flag in this codebase means the exact string "true" and nothing
  // else, so that a stray "1" or "yes" cannot half-enable something. This one
  // is NEGATIVE — profiles are read-mostly and skipping is nearly free, so a
  // flag somebody had to remember at deploy time would mean the profiles
  // silently stopped being maintained.
  const off = await sweepProfileDrift({
    client: backfillClient(), now: NOW, env: { CONTACT_PROFILES_SWEEP_DISABLED: 'true' }
  });
  assert.equal(off.disabled, true);
  assert.equal(off.written, 0);
  // The disabled shape must still be a complete summary. `skipped` here means
  // "contacts whose fingerprints matched", and a disabled sweep matched none.
  assert.equal(off.skipped, 0);
  assert.deepEqual(off.failed, []);

  for (const value of ['TRUE', '1', 'yes', '', undefined]) {
    const on = await sweepProfileDrift({
      client: backfillClient(), now: NOW, env: { CONTACT_PROFILES_SWEEP_DISABLED: value }
    });
    assert.equal(on.disabled, false, `"${value}" must not disable the sweep`);
    assert.equal(on.written, 4);
  }
});

test('the sweep and the webhook build through the same code path', async () => {
  // Three refresh triggers, one builder. Three definitions of "what is this
  // person's profile" is the fault this whole feature is written to avoid.
  const orders = [order({ at: daysAgo(30) })];
  const tables = {
    sms_orders: orders, sms_messages: [], sms_campaign_recipients: [], sms_customer_profiles: []
  };
  const viaWebhook = fakeClient({ tables });
  const viaSweep = fakeClient({ tables });

  await refreshProfileQuietly({ client: viaWebhook, phone: PHONE, now: NOW });
  await sweepProfileDrift({ client: viaSweep, now: NOW, env: {} });

  assert.deepEqual(viaWebhook.upserts[0].rows[0], viaSweep.upserts[0].rows[0]);
});
