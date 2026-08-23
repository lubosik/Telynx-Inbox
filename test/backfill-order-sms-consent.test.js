'use strict';
/**
 * test/backfill-order-sms-consent.test.js
 *
 * The order-derived promotional SMS consent backfill writes a compliance
 * record for roughly 900 people on a basis the business owner has chosen and
 * been warned about. Two properties have to hold or the script is dangerous:
 *
 *   1. A dry run writes NOTHING. Not "writes less", not "logs instead" —
 *      nothing. The Supabase client used here throws on contact, so if the
 *      guard ever regresses, the test fails loudly rather than silently
 *      counting writes that did not happen.
 *
 *   2. A withdrawal is never resurrected. There are five independent places a
 *      withdrawal lives in this system, and each one is asserted separately,
 *      including the case where the person ALSO has a valid existing opt-in —
 *      the shape where a careless precedence order would report
 *      "already_opted_in" and hide the fact that somebody had said no.
 *
 *   3. Nobody disappears without a reason. A person dropped from the plan with
 *      no entry in `skippedByReason` is invisible to the operator reviewing a
 *      ~900-row compliance write, which is worse than a wrong count.
 *
 * Everything here is offline. `planOrderConsentBackfill()` is a pure function
 * and `applyConsentBackfill()` takes an injected client and an injected
 * `recordOptIn`, so no database, no network, and no environment is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAGE_SIZE, fetchAllRows } = require('../lib/fetch-all-rows');

const {
  DEDUPE_PREFIX,
  EVIDENCE_NAMESPACE,
  SKIP_REASONS,
  applyConsentBackfill,
  dedupeKeyFor,
  planOrderConsentBackfill
} = require('../lib/campaigns/order-consent-backfill');
const { SOURCE } = require('../lib/campaigns/consent');

const NOW = new Date('2026-08-22T12:00:00.000Z');
const NO_EXCLUSIONS = { phones: new Set(), orderIDs: new Set() };

const ALICE = '+13055550101';
const BOB = '+13055550102';
const CARLA = '+13055550103';
const DAN = '+13055550104';
const ERIN = '+13055550105';

function order(overrides = {}) {
  return {
    id: 1,
    woo_order_id: 1001,
    contact_phone: ALICE,
    status: 'completed',
    created_at: '2025-03-01T10:00:00.000Z',
    ...overrides
  };
}

function plan(input = {}) {
  return planOrderConsentBackfill({
    exclusions: NO_EXCLUSIONS,
    now: NOW,
    runID: 'test-run',
    ...input
  });
}

function reasonFor(result, phone) {
  return result.skipped.find(entry => entry.phone === phone)?.reason || null;
}

function phones(result) {
  return result.candidates.map(candidate => candidate.phone);
}

/** Any contact with this client is a bug, so make contact impossible to miss. */
function forbiddenClient() {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`the backfill touched the database (client.${String(property)})`);
    }
  });
}

// ── selection: who qualifies ────────────────────────────────────────────────

test('a paid order with no prior consent produces exactly one candidate', () => {
  const result = plan({ orders: [order()] });

  assert.equal(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.equal(candidate.phone, ALICE);
  assert.equal(candidate.source, SOURCE.ORDER_PRIVACY_POLICY);
  assert.equal(candidate.evidenceRef, 'order_privacy_policy:woo_order:1001');
  assert.equal(result.counts.eligible, 1);
  assert.equal(result.counts.skipped, 0);
});

test('an unpaid order is not a basis for anything', () => {
  for (const status of ['pending', 'on-hold', 'cancelled', 'refunded', 'failed', 'checkout-draft']) {
    const result = plan({ orders: [order({ status })] });
    assert.equal(result.candidates.length, 0, `${status} must not qualify`);
    assert.equal(result.counts.paidOrdersConsidered, 0);
  }
});

test('every paid status this codebase recognises qualifies', () => {
  for (const status of ['processing', 'completed', 'shipped', 'delivered', 'COMPLETED']) {
    const result = plan({ orders: [order({ status })] });
    assert.equal(result.candidates.length, 1, `${status} must qualify`);
  }
});

// ── the consent dates from the purchase, not from the run ───────────────────

test('the earliest qualifying order is chosen, and its date is the consent date', () => {
  const result = plan({
    orders: [
      order({ id: 3, woo_order_id: 3003, created_at: '2025-09-09T00:00:00.000Z' }),
      order({ id: 1, woo_order_id: 1001, created_at: '2025-01-05T08:30:00.000Z' }),
      order({ id: 2, woo_order_id: 2002, created_at: '2025-05-05T00:00:00.000Z' })
    ]
  });

  const [candidate] = result.candidates;
  assert.equal(candidate.evidenceRef, 'order_privacy_policy:woo_order:1001');
  assert.equal(candidate.occurredAt, '2025-01-05T08:30:00.000Z');
  assert.equal(candidate.qualifyingOrders, 3);
  assert.notEqual(candidate.occurredAt, NOW.toISOString(),
    'the consent dates from the purchase, never from the run');
  assert.equal(candidate.metadata.qualifying_order.woo_order_id, 1001);
  assert.equal(candidate.metadata.qualifying_order.created_at, '2025-01-05T08:30:00.000Z');
});

test('an unpaid order older than the earliest paid one is not chosen as evidence', () => {
  const result = plan({
    orders: [
      order({ id: 1, woo_order_id: 1001, status: 'cancelled', created_at: '2024-01-01T00:00:00.000Z' }),
      order({ id: 2, woo_order_id: 2002, status: 'completed', created_at: '2025-06-01T00:00:00.000Z' })
    ]
  });
  assert.equal(result.candidates[0].evidenceRef, 'order_privacy_policy:woo_order:2002');
  assert.equal(result.candidates[0].occurredAt, '2025-06-01T00:00:00.000Z');
});

test('the same input always produces the same evidence reference', () => {
  const rows = [
    order({ id: 2, woo_order_id: 2002, created_at: '2025-04-01T00:00:00.000Z' }),
    order({ id: 1, woo_order_id: 1001, created_at: '2025-04-01T00:00:00.000Z' })
  ];
  const forwards = plan({ orders: rows });
  const backwards = plan({ orders: [...rows].reverse() });
  assert.equal(forwards.candidates[0].evidenceRef, backwards.candidates[0].evidenceRef);
});

// ── opt-out wins, in all four places it can live ────────────────────────────

test('a later ledger opt_out beats an earlier opt_in and blocks the backfill', () => {
  const result = plan({
    orders: [order()],
    consentEvents: [
      {
        id: 1, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
        purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
        evidence_ref: 'woo_order:900', occurred_at: '2025-02-01T00:00:00.000Z'
      },
      {
        id: 2, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_out',
        purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.INBOUND_STOP,
        evidence_ref: null, occurred_at: '2025-06-01T00:00:00.000Z'
      }
    ]
  });

  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.LEDGER_OPT_OUT,
    'the withdrawal must be the reported reason, not "already opted in"');
});

test('an opt_out on the same timestamp as an opt_in still wins on the higher id', () => {
  const at = '2025-06-01T00:00:00.000Z';
  const result = plan({
    orders: [order()],
    consentEvents: [
      {
        id: 7, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
        purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
        evidence_ref: 'woo_order:900', occurred_at: at
      },
      {
        id: 8, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_out',
        purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.INBOUND_STOP,
        evidence_ref: null, occurred_at: at
      }
    ]
  });
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.LEDGER_OPT_OUT);
});

test('sms_contacts.opted_out blocks even when a valid opt_in exists in the ledger', () => {
  const result = plan({
    orders: [order()],
    contacts: [{ phone: ALICE, opted_out: true }],
    consentEvents: [{
      id: 1, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
      purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
      evidence_ref: 'woo_order:900', occurred_at: '2025-02-01T00:00:00.000Z'
    }]
  });

  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.CONTACT_OPTED_OUT,
    'a withdrawal outranks an existing opt-in in the reported reason');
});

test('the sms_sent_log opt-out sentinel blocks — it is what isOptedOut() reads', () => {
  const result = plan({
    orders: [order()],
    optOutSentinels: [{ id: 5, phone: ALICE, flow_type: 'opted-out' }]
  });
  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.OPT_OUT_SENTINEL);
});

test('an unrelated sms_sent_log row is not mistaken for a withdrawal', () => {
  const result = plan({
    orders: [order()],
    optOutSentinels: [{ id: 5, phone: ALICE, flow_type: 'shipped-msg1' }]
  });
  assert.deepEqual(phones(result), [ALICE]);
});

test('HighLevel SMS do-not-disturb blocks — the fifth withdrawal source', () => {
  // `lib/campaigns/eligibility.js` already treats this as authoritative, so the
  // send path would have blocked anyway. That is not the point: this script
  // does not send, it writes an assertion that somebody consented. Recording
  // positive promotional consent for a person the CRM has on a do-not-disturb
  // list is a false statement in a compliance ledger regardless of whether a
  // downstream gate happens to stop us acting on it.
  for (const contact of [
    { phone: ALICE, opted_out: false, ghl_dnd: true },
    { phone: ALICE, opted_out: false, ghl_sms_dnd_status: 'active' },
    { phone: ALICE, opted_out: false, ghl_sms_dnd_status: 'permanent' },
    { phone: ALICE, opted_out: false, ghl_sms_dnd_status: 'ACTIVE' }
  ]) {
    const result = plan({ orders: [order()], contacts: [contact] });
    assert.deepEqual(phones(result), [], `${JSON.stringify(contact)} must block`);
    assert.equal(reasonFor(result, ALICE), SKIP_REASONS.GHL_SMS_DND);
  }
});

test('DND blocks even when the ledger already holds a valid opt_in', () => {
  const result = plan({
    orders: [order()],
    contacts: [{ phone: ALICE, opted_out: false, ghl_sms_dnd_status: 'permanent' }],
    consentEvents: [{
      id: 1, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
      purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
      evidence_ref: 'woo_order:900', occurred_at: '2025-02-01T00:00:00.000Z'
    }]
  });
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.GHL_SMS_DND,
    'the DND is the stronger fact and must be the reported reason');
});

test('a cleared or unknown DND status is not mistaken for a withdrawal', () => {
  // "We have not synced this contact recently" is not evidence that they said
  // no. The send path has its own `dnd_unknown` freshness gate for that; making
  // absence blocking here would silently drop most of the population.
  for (const contact of [
    { phone: ALICE, opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive' },
    { phone: ALICE, opted_out: false, ghl_dnd: null, ghl_sms_dnd_status: null },
    { phone: ALICE, opted_out: false }
  ]) {
    const result = plan({ orders: [order()], contacts: [contact] });
    assert.deepEqual(phones(result), [ALICE], `${JSON.stringify(contact)} must not block`);
  }
});

test('a DND recorded against a loosely-stored phone still blocks the canonical one', () => {
  const result = plan({
    orders: [order({ contact_phone: ALICE })],
    contacts: [{ phone: '(305) 555-0101', opted_out: false, ghl_sms_dnd_status: 'active' }]
  });
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.GHL_SMS_DND);
});

test('an active campaign suppression blocks', () => {
  const result = plan({
    orders: [order()],
    suppressions: [{
      id: 'a', workspace_id: 'vici', contact_phone: ALICE, reason_code: 'compliance_hold',
      active: true, effective_at: '2025-01-01T00:00:00.000Z', expires_at: null
    }]
  });
  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.AUTHORITATIVE_SUPPRESSION);
});

test('an internal or test suppression is reported as such, and still blocks', () => {
  const result = plan({
    orders: [order()],
    suppressions: [{
      id: 'a', workspace_id: 'vici', contact_phone: ALICE, reason_code: 'internal_identity',
      active: true, effective_at: '2025-01-01T00:00:00.000Z', expires_at: null
    }]
  });
  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.INTERNAL_OR_TEST_IDENTITY);
});

test('a suppression with an unreadable window is treated as blocking, not as absent', () => {
  const result = plan({
    orders: [order()],
    suppressions: [{
      id: 'a', workspace_id: 'vici', contact_phone: ALICE, reason_code: 'manual_block',
      active: true, effective_at: 'not-a-date', expires_at: null
    }]
  });
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.AUTHORITATIVE_SUPPRESSION);
});

test('an expired or inactive suppression does not block', () => {
  const result = plan({
    orders: [order()],
    suppressions: [
      {
        id: 'a', workspace_id: 'vici', contact_phone: ALICE, reason_code: 'manual_block',
        active: false, effective_at: '2025-01-01T00:00:00.000Z', expires_at: null
      },
      {
        id: 'b', workspace_id: 'vici', contact_phone: ALICE, reason_code: 'manual_block',
        active: true, effective_at: '2025-01-01T00:00:00.000Z',
        expires_at: '2025-02-01T00:00:00.000Z'
      }
    ]
  });
  assert.deepEqual(phones(result), [ALICE]);
});

// ── already opted in, and other skips ───────────────────────────────────────

test('an existing valid opt_in is skipped rather than duplicated', () => {
  const result = plan({
    orders: [order()],
    consentEvents: [{
      id: 1, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
      purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
      evidence_ref: 'woo_order:900', occurred_at: '2025-02-01T00:00:00.000Z'
    }]
  });

  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.ALREADY_OPTED_IN);
});

test('an opt_in with no evidence is not a real opt-in and does not block the backfill', () => {
  // The ledger's CHECK constraint forbids this shape, but a hand-written row or
  // a future writer could produce it. Counting it as consent would leave the
  // person with an unusable record and no way to ever get a usable one.
  const result = plan({
    orders: [order()],
    consentEvents: [{
      id: 1, workspace_id: 'vici', contact_phone: ALICE, event_type: 'opt_in',
      purpose: 'promotional_sms', brand_id: 'vici', source: 'somewhere',
      evidence_ref: '   ', occurred_at: '2025-02-01T00:00:00.000Z'
    }]
  });
  assert.deepEqual(phones(result), [ALICE]);
});

test('a consent event from another workspace is ignored', () => {
  const result = plan({
    orders: [order()],
    consentEvents: [{
      id: 1, workspace_id: 'shore', contact_phone: ALICE, event_type: 'opt_out',
      purpose: 'promotional_sms', brand_id: 'shore', source: SOURCE.INBOUND_STOP,
      evidence_ref: null, occurred_at: '2025-06-01T00:00:00.000Z'
    }]
  });
  assert.deepEqual(phones(result), [ALICE]);
});

test('an excluded staff or test identity is skipped', () => {
  const result = plan({
    orders: [order()],
    exclusions: { phones: new Set([ALICE]), orderIDs: new Set() }
  });
  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.INTERNAL_OR_TEST_IDENTITY);
});

// ── invalid phones ──────────────────────────────────────────────────────────

test('a phone that cannot be resolved to strict E.164 is skipped, never guessed at', () => {
  const result = plan({
    orders: [
      order({ id: 1, woo_order_id: 1001, contact_phone: '12345' }),
      order({ id: 2, woo_order_id: 2002, contact_phone: '' }),
      order({ id: 3, woo_order_id: 3003, contact_phone: null }),
      order({ id: 4, woo_order_id: 4004, contact_phone: 'not a phone' })
    ]
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.counts.skippedByReason[SKIP_REASONS.INVALID_PHONE], 3,
    'the two empty values group into one bucket; the other two are distinct');
  assert.ok(result.skipped.every(entry => entry.reason !== SKIP_REASONS.INVALID_PHONE
    || entry.phone === null), 'an unresolvable phone must not be reported as a phone');
});

test('a legacy loosely-stored phone is canonicalised rather than dropped', () => {
  for (const stored of ['(305) 555-0101', '305-555-0101', '3055550101', '13055550101',
    '+1 (305) 555-0101', ' +13055550101 ']) {
    const result = plan({ orders: [order({ contact_phone: stored })] });
    assert.deepEqual(phones(result), [ALICE], `${JSON.stringify(stored)} is the same number`);
  }
});

test('a phone the resolver cannot prove is skipped, never fabricated', () => {
  // `resolvePhone` now falls back to `normalisePhoneStrict()` from lib/phone.js
  // rather than the loose `normalisePhone()`, which strips every non-digit and
  // therefore invents numbers: "3055551234 ext 22" became +305555123422, a
  // number that does not exist and which some real person may one day be
  // assigned. On a delivery path that is a failed send. On a consent record it
  // is manufactured evidence that a stranger agreed to be texted.
  const fabricable = [
    '3055551234 ext 22',
    '305-555-1234 x9',
    '+1 (305) 555-1234 ext. 100',
    '447506440284',          // no '+': a UK number, or a local one somewhere else?
    '305555123422'
  ];

  const result = plan({
    orders: fabricable.map((contact_phone, index) =>
      order({ id: index + 1, woo_order_id: 7000 + index, contact_phone }))
  });

  assert.deepEqual(result.candidates, [], 'not one of these may become a candidate');
  assert.equal(result.counts.skippedByReason[SKIP_REASONS.INVALID_PHONE], fabricable.length,
    'each is reported to the operator, not silently dropped');

  // And specifically: the fabricated number never appears anywhere in the plan.
  assert.equal(JSON.stringify(result).includes('+305555123422'), false);
});

test('a withdrawal recorded against a loosely-stored phone still blocks the canonical one', () => {
  const result = plan({
    orders: [order({ contact_phone: ALICE })],
    contacts: [{ phone: '3055550101', opted_out: true }]
  });
  assert.deepEqual(phones(result), []);
  assert.equal(reasonFor(result, ALICE), SKIP_REASONS.CONTACT_OPTED_OUT);
});

// ── dedupe key ──────────────────────────────────────────────────────────────

test('the dedupe key is stable per phone and independent of which order was chosen', () => {
  const first = plan({ orders: [order({ woo_order_id: 1001 })] });
  const second = plan({
    orders: [
      order({ id: 9, woo_order_id: 9009, created_at: '2024-01-01T00:00:00.000Z' }),
      order({ id: 1, woo_order_id: 1001 })
    ]
  });

  assert.equal(first.candidates[0].dedupeKey, `${DEDUPE_PREFIX}:${ALICE}`);
  assert.equal(first.candidates[0].dedupeKey, second.candidates[0].dedupeKey);
  assert.notEqual(first.candidates[0].evidenceRef, second.candidates[0].evidenceRef,
    'the evidence changed but the dedupe key did not, so a re-run cannot duplicate');
  assert.equal(dedupeKeyFor('(305) 555-0101'), `${DEDUPE_PREFIX}:${ALICE}`);
  assert.equal(dedupeKeyFor('nonsense'), null);
});

test('two different phones get two different dedupe keys', () => {
  const result = plan({
    orders: [order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB })]
  });
  const keys = new Set(result.candidates.map(candidate => candidate.dedupeKey));
  assert.equal(keys.size, 2);
});

// ── the record must be self-describing ──────────────────────────────────────

test('the metadata states the basis honestly and without needing another document', () => {
  const [candidate] = plan({ orders: [order()] }).candidates;
  const meta = candidate.metadata;

  assert.equal(meta.basis, 'policy_derived_determination');
  assert.equal(meta.explicit_sms_opt_in, false,
    'the record must never imply an explicit SMS opt-in');
  assert.match(meta.relied_upon.checkout_notice_verbatim,
    /^Your personal data will be used to process your order/);
  assert.match(meta.relied_upon.privacy_policy_clause_verbatim,
    /marketing and promotional emails/);
  assert.equal(meta.relied_upon.privacy_policy_channel_named, 'email');
  assert.equal(meta.relied_upon.channel_recorded_here, 'sms');
  assert.ok(meta.limitations.some(line => /does not mention SMS/i.test(line)),
    'the email/SMS gap must be written into the row itself');
  assert.equal(meta.qualifying_order.reference, candidate.evidenceRef);
  assert.equal(meta.determination.made_by, 'vici_business_owner');
  assert.equal(meta.determination.run_id, 'test-run');
  assert.match(meta.reversal, /recordOptOut/);
});

test('the evidence reference names one specific order, never a vague string', () => {
  const [candidate] = plan({ orders: [order({ woo_order_id: 4242 })] }).candidates;
  assert.equal(candidate.evidenceRef, 'order_privacy_policy:woo_order:4242');
  assert.match(candidate.evidenceRef, /^order_privacy_policy:woo_order:\d+$/);
});

test('the weakest basis cannot masquerade as the strongest in evidence_ref', () => {
  // `lib/campaigns/checkout-consent.js` writes the bare `woo_order:<id>` for the
  // checkout tick box. This backfill used to write the IDENTICAL string for the
  // policy-derived basis, so both rows could exist for the same person and the
  // same order with the same `occurred_at` and nothing but insertion order to
  // tell them apart. It also broke the verification query in
  // docs/campaigns/CONSENT-CAPTURE.md section 6, which counts rows by
  // `evidence_ref = 'woo_order:<id>'` to prove the unticked case records
  // nothing — this backfill's rows would have been counted as tick-box consent.
  const [candidate] = plan({ orders: [order({ woo_order_id: 4242 })] }).candidates;

  assert.notEqual(candidate.evidenceRef, 'woo_order:4242',
    'the backfill must not reuse the checkout basis reference');
  assert.equal(candidate.evidenceRef.startsWith(`${EVIDENCE_NAMESPACE}:`), true,
    'it is namespaced by basis');
  assert.equal(candidate.evidenceRef.endsWith(':woo_order:4242'), true,
    'and still names exactly one order');

  // The legacy shape — a row with no WooCommerce id — is namespaced too.
  const [legacy] = plan({
    orders: [order({ id: 77, woo_order_id: null })]
  }).candidates;
  assert.equal(legacy.evidenceRef, 'order_privacy_policy:sms_orders_row:77');
});

// ── counts ──────────────────────────────────────────────────────────────────

test('the summary counts eligible, skipped-with-reason, and distinct phones', () => {
  const result = plan({
    orders: [
      order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB }),
      order({ id: 3, woo_order_id: 3003, contact_phone: CARLA }),
      order({ id: 4, woo_order_id: 4004, contact_phone: DAN }),
      order({ id: 5, woo_order_id: 5005, contact_phone: ERIN, status: 'pending' }),
      order({ id: 6, woo_order_id: 6006, contact_phone: 'garbage' })
    ],
    contacts: [{ phone: BOB, opted_out: true }],
    consentEvents: [{
      id: 1, workspace_id: 'vici', contact_phone: CARLA, event_type: 'opt_in',
      purpose: 'promotional_sms', brand_id: 'vici', source: SOURCE.CHECKOUT_OPT_IN,
      evidence_ref: 'woo_order:1', occurred_at: '2025-02-01T00:00:00.000Z'
    }]
  });

  assert.deepEqual(phones(result), [ALICE, DAN]);
  assert.equal(result.counts.ordersRead, 6);
  assert.equal(result.counts.distinctPhones, 4, 'ERIN is unpaid, the garbage phone is unresolvable');
  assert.equal(result.counts.eligible, 2);
  assert.equal(result.counts.skipped, 3);
  assert.deepEqual(result.counts.skippedByReason, {
    [SKIP_REASONS.INVALID_PHONE]: 1,
    [SKIP_REASONS.CONTACT_OPTED_OUT]: 1,
    [SKIP_REASONS.ALREADY_OPTED_IN]: 1
  });
});

test('a duplicated order row is counted once', () => {
  const result = plan({
    orders: [order({ woo_order_id: 1001 }), order({ id: 99, woo_order_id: 1001 })]
  });
  assert.equal(result.counts.distinctOrders, 1);
  assert.equal(result.candidates[0].qualifyingOrders, 1);
});

test('a WooCommerce id and a legacy row id that happen to match are two orders', () => {
  // `orderIdentity()` falls back to the local `sms_orders.id` when there is no
  // WooCommerce id, so the two kinds draw from unrelated number spaces and
  // collide constantly. Keying the dedupe set on the bare id therefore threw
  // away the second order — and, when it belonged to a different customer,
  // removed that person from the plan entirely with NO entry in
  // `skippedByReason`. A silent disappearance from a compliance write the
  // operator is meant to review is the worst failure mode this plan has, so it
  // is asserted on the counts AND on the reasons, not just on the candidates.
  const result = plan({
    orders: [
      order({ id: 5, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 1001, woo_order_id: null, contact_phone: BOB })
    ]
  });

  assert.equal(result.counts.distinctOrders, 2, 'two orders, not one');
  assert.deepEqual(phones(result), [ALICE, BOB], 'and neither customer vanished');
  assert.deepEqual(result.counts.skippedByReason, {},
    'nobody was dropped, so nothing should need a skip reason either');
  assert.equal(result.candidates[1].evidenceRef, 'order_privacy_policy:sms_orders_row:1001');
});

test('the same legacy row seen twice is still one order', () => {
  // The collision fix must not have been a licence to stop deduplicating.
  const result = plan({
    orders: [
      order({ id: 1001, woo_order_id: null, contact_phone: BOB }),
      order({ id: 1001, woo_order_id: null, contact_phone: BOB })
    ]
  });
  assert.equal(result.counts.distinctOrders, 1);
  assert.equal(result.candidates[0].qualifyingOrders, 1);
});

// ── DRY RUN WRITES NOTHING ──────────────────────────────────────────────────

test('a dry run writes nothing at all', async () => {
  const built = plan({
    orders: [order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB })]
  });
  assert.equal(built.candidates.length, 2, 'there must be work to refuse to do');

  let recordOptInCalls = 0;
  const summary = await applyConsentBackfill({
    client: forbiddenClient(),
    plan: built,
    recordOptIn: async () => {
      recordOptInCalls += 1;
      return { recorded: true, duplicate: false };
    }
  });

  assert.equal(recordOptInCalls, 0, 'a dry run must not call the consent writer');
  assert.equal(summary.mode, 'dry_run');
  assert.equal(summary.attempted, 0);
  assert.equal(summary.written, 0);
});

test('one flag is not enough — both --commit and --basis-acknowledged are required', async () => {
  const built = plan({ orders: [order()] });

  for (const gates of [
    { commit: true, basisAcknowledged: false },
    { commit: false, basisAcknowledged: true },
    { commit: 'true', basisAcknowledged: 'true' },
    { commit: 1, basisAcknowledged: 1 }
  ]) {
    let calls = 0;
    const summary = await applyConsentBackfill({
      client: forbiddenClient(),
      plan: built,
      recordOptIn: async () => { calls += 1; return { recorded: true }; },
      ...gates
    });
    assert.equal(calls, 0, `wrote with ${JSON.stringify(gates)}`);
    assert.equal(summary.mode, 'dry_run');
  }
});

test('with both flags it writes exactly the planned candidates, and nothing else', async () => {
  const built = plan({
    orders: [order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB })]
  });

  const writes = [];
  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: built,
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async args => {
      writes.push(args);
      return { recorded: true, duplicate: false };
    }
  });

  assert.equal(summary.mode, 'commit');
  assert.equal(summary.written, 2);
  assert.equal(summary.duplicates, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(writes.map(write => write.phone), [ALICE, BOB]);
  assert.equal(writes[0].source, SOURCE.ORDER_PRIVACY_POLICY);
  assert.equal(writes[0].evidenceRef, 'order_privacy_policy:woo_order:1001');
  assert.equal(writes[0].occurredAt, '2025-03-01T10:00:00.000Z');
  assert.equal(writes[0].dedupeKey, `${DEDUPE_PREFIX}:${ALICE}`);
  assert.ok(writes.every(write => write.metadata.explicit_sms_opt_in === false));
});

test('a duplicate is success, not a failure — re-running the backfill is safe', async () => {
  const built = plan({ orders: [order()] });
  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: built,
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async () => ({ recorded: true, duplicate: true })
  });

  assert.equal(summary.written, 0);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.failed, 0);
});

test('one failed write does not abandon the rest of the run', async () => {
  const built = plan({
    orders: [order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB }),
      order({ id: 3, woo_order_id: 3003, contact_phone: CARLA })]
  });

  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: built,
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async ({ phone }) => {
      if (phone === BOB) throw new Error('CONSENT_WRITE_FAILED');
      return { recorded: true, duplicate: false };
    }
  });

  assert.equal(summary.attempted, 3);
  assert.equal(summary.written, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].phone, BOB);
});

test('a failure carries a code, never the provider error text', async () => {
  // The CLI masks every phone number it prints and then printed this string
  // verbatim on the same line. A PostgREST CHECK-violation message quotes the
  // offending row, so the raw message could hand back the digits the mask had
  // just removed — plus whatever else was in the row.
  const built = plan({ orders: [order({ contact_phone: ALICE })] });

  const leak = Object.assign(
    new Error('new row for relation "sms_consent_events" violates check constraint ' +
      '"sms_consent_phone_e164", Failing row contains (+13055550101, alice@example.com).'),
    { code: 'CONSENT_WRITE_FAILED' }
  );

  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: built,
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async () => { throw leak; }
  });

  assert.equal(summary.failed, 1);
  const [failure] = summary.failures;
  assert.equal(failure.code, 'CONSENT_WRITE_FAILED');
  assert.equal(failure.message, undefined, 'the raw provider text must not be carried at all');

  // `failure.phone` is the candidate's own number and is meant to be there —
  // the CLI masks it on the way out. Nothing ELSE in the entry may carry row
  // content, which is what the raw message did.
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'phone']);
  const beyondThePhone = JSON.stringify({ ...failure, phone: undefined });
  assert.equal(beyondThePhone.includes('3055550101'), false, 'no digits from the offending row');
  assert.equal(beyondThePhone.includes('alice@example.com'), false, 'and no other row content');
  assert.equal(beyondThePhone.includes('check constraint'), false, 'and no provider text');
});

test('an error with no code still reports something a human can act on', async () => {
  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: plan({ orders: [order()] }),
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async () => { throw new Error('connect ETIMEDOUT 10.0.0.1:5432'); }
  });
  assert.deepEqual(summary.failures, [{ phone: ALICE, code: 'write_failed' }]);
});

test('a rejected write is reported by its refusal code', async () => {
  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: plan({ orders: [order()] }),
    commit: true,
    basisAcknowledged: true,
    recordOptIn: async () => ({ recorded: false, reason: 'evidence_required' })
  });
  assert.equal(summary.rejected, 1);
  assert.deepEqual(summary.failures, [{ phone: ALICE, code: 'evidence_required' }]);
});

test('SIGINT stops the run instead of merely narrating it', async () => {
  const built = plan({
    orders: [order({ id: 1, woo_order_id: 1001, contact_phone: ALICE }),
      order({ id: 2, woo_order_id: 2002, contact_phone: BOB }),
      order({ id: 3, woo_order_id: 3003, contact_phone: CARLA })]
  });

  let written = 0;
  const summary = await applyConsentBackfill({
    client: { marker: 'injected' },
    plan: built,
    commit: true,
    basisAcknowledged: true,
    shouldStop: () => written >= 1,
    recordOptIn: async () => { written += 1; return { recorded: true, duplicate: false }; }
  });

  assert.equal(summary.attempted, 1);
  assert.equal(summary.stoppedEarly, true);
  assert.equal(written, 1);
});

test('committing requires a client and a consent writer rather than defaulting to one', async () => {
  const built = plan({ orders: [order()] });
  await assert.rejects(
    () => applyConsentBackfill({ plan: built, commit: true, basisAcknowledged: true, recordOptIn: async () => ({}) }),
    /requires a Supabase client/);
  await assert.rejects(
    () => applyConsentBackfill({ client: {}, plan: built, commit: true, basisAcknowledged: true }),
    /requires recordOptIn/);
});


// ── reading a withdrawal source must never silently return less than all of it ─
//
// `fetchAllRows()` defaults to warning and returning a TRUNCATED array when a
// table is bigger than `maxRows`. That is right for a screen. It is exactly
// wrong for this script, whose header promises "Every source is mandatory. If a
// withdrawal source cannot be read, the run aborts", because this script reads
// ABSENCE as permission: a withdrawal it cannot see becomes a fresh opt-in for
// somebody who said no, with the warning scrolled off above the plan.

/** A Supabase double whose table is `totalRows` long, served a page at a time. */
function pagingClient(totalRows) {
  const pagesRead = [];
  const query = {
    order() { return query; },
    then(resolve, reject) {
      const [from, to] = pagesRead[pagesRead.length - 1];
      const data = [];
      for (let id = from; id <= to && id < totalRows; id += 1) data.push({ id });
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  };
  const api = {
    pagesRead,
    from() { return api; },
    select() { return api; },
    range(from, to) { pagesRead.push([from, to]); return query; }
  };
  return api;
}

/** fetchAllRows warns on `console.warn`; keep a deliberate warning out of the run. */
async function withoutWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test('fetchAllRows still truncates with a warning by default, so no existing caller changes', async () => {
  const client = pagingClient(10000);
  const { result, warnings } = await withoutWarnings(() =>
    fetchAllRows(client, 'sms_contacts', 'phone', { maxRows: PAGE_SIZE * 3 }));

  assert.equal(result.length, PAGE_SIZE * 3, 'the rows read so far are returned');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /truncated/);
});

test('fetchAllRows aborts at the ceiling when the caller asks it to', async () => {
  const client = pagingClient(10000);
  await assert.rejects(
    () => fetchAllRows(client, 'sms_consent_events', 'id', {
      maxRows: PAGE_SIZE * 3,
      throwOnCeiling: true
    }),
    /sms_consent_events exceeded the 3000-row ceiling/);
});

test('throwOnCeiling changes nothing for a table that fits', async () => {
  const client = pagingClient(1500);
  const { result, warnings } = await withoutWarnings(() =>
    fetchAllRows(client, 'sms_contacts', 'phone', {
      maxRows: PAGE_SIZE * 3,
      throwOnCeiling: true
    }));

  assert.equal(result.length, 1500, 'a short read is a short read, not a ceiling');
  assert.deepEqual(warnings, []);
});

test('the backfill script reads no source without the ceiling abort', () => {
  // A shape guard, in the spirit of test/no-builder-catch.test.js: the property
  // is about a call SITE, and a behavioural test of one call site cannot stop
  // the next one being added without the flag.
  const file = path.join(__dirname, '..', 'scripts', 'backfill-order-sms-consent.js');
  const source = fs.readFileSync(file, 'utf8');

  const calls = [];
  for (let at = source.indexOf('fetchAllRows('); at !== -1;
    at = source.indexOf('fetchAllRows(', at + 1)) {
    const open = source.indexOf('(', at);
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '(') depth += 1;
      else if (source[close] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = source.slice(open + 1, close);
    if (args.trim()) calls.push(args);   // skip prose mentions of `fetchAllRows()`
  }

  assert.ok(calls.length >= 1, 'the script still reads its sources through fetchAllRows');
  for (const args of calls) {
    assert.match(args, /throwOnCeiling:\s*true/,
      `a fetchAllRows call in the backfill omits throwOnCeiling: true —\n${args}`);
  }
});

test('the CLI reports a failure as a masked phone and a code, and nothing else', () => {
  // `applyConsentBackfill` no longer carries provider text (see above), but the
  // leak was a PRINT, and the print is what a future edit would reach for when
  // a run fails and the code alone is not enough. Guard the line itself: a
  // PostgREST message quotes the offending row, so printing one on the same
  // line as a carefully masked phone number undoes the masking.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'backfill-order-sms-consent.js'), 'utf8');

  assert.equal(/failure\.message/.test(source), false,
    'the CLI must not print failure.message — truncate to failure.code');
  assert.match(source, /mask\(failure\.phone\)\}\s+\$\{failure\.code\}/,
    'the failure line prints the masked phone and the code');
});
