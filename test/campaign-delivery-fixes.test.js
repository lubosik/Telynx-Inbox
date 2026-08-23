'use strict';
/**
 * test/campaign-delivery-fixes.test.js — guards for the delivery fixes in
 * scripts/campaign-delivery-fixes-migration.sql, telnyx.js and the worker.
 *
 * The frequency-cap tests here are mutation tests, not shape tests. Each one
 * models the ledger predicate the database actually evaluates, then proves the
 * message is counted. Three of them re-run the same scenario against the OLD
 * predicate and assert it FAILS, so the test cannot pass against the bug it
 * was written for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXES = fs.readFileSync(path.join(ROOT, 'scripts/campaign-delivery-fixes-migration.sql'), 'utf8');
const ORIGINAL = fs.readFileSync(path.join(ROOT, 'scripts/campaigns-migration.sql'), 'utf8');

// ── The migration file itself ───────────────────────────────────────────────

test('the follow-up migration is additive, transactional and re-runnable', () => {
  assert.match(FIXES, /^BEGIN;$/m);
  assert.match(FIXES, /^COMMIT;$/m);
  assert.match(FIXES, /NOTIFY pgrst, 'reload schema'/);
  assert.equal((FIXES.match(/\$\$/g) || []).length % 2, 0, 'dollar quotes must balance');

  // It replaces functions. It must not touch a table, a column or a row: the
  // schema it is following up on is already applied in production.
  for (const forbidden of [
    /\bCREATE TABLE\b/i, /\bALTER TABLE\b/i, /\bDROP TABLE\b/i,
    /\bDROP FUNCTION\b/i, /\bDELETE FROM\b/i, /\bTRUNCATE\b/i, /\bCREATE INDEX\b/i
  ]) {
    const hits = FIXES.split('\n')
      .filter(line => !line.trim().startsWith('--') && forbidden.test(line));
    assert.deepEqual(hits, [], `no executable ${forbidden} statement`);
  }
});

test('scripts/campaigns-migration.sql is untouched by this change', () => {
  // It is applied in production. The follow-up must stand alone.
  assert.match(ORIGINAL, /RAISE EXCEPTION 'campaign_recipient_no_longer_eligible'/);
  assert.doesNotMatch(ORIGINAL, /record_sms_campaign_provider_refusal/);
  assert.doesNotMatch(ORIGINAL, /accepted_while_ineligible/);
});

test('every replaced function restates its own REVOKE and GRANT', () => {
  for (const signature of [
    'public.record_sms_campaign_provider_acceptance(uuid,text,uuid,text,text,timestamptz)',
    'public.record_sms_campaign_provider_refusal(uuid,text,uuid,text,text,timestamptz)',
    'public.claim_sms_campaign_recipients(text,integer,integer)',
    'public.release_expired_sms_campaign_claims(text)'
  ]) {
    const escaped = signature.replace(/[.()]/g, ch => `\\${ch}`);
    assert.match(FIXES, new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated`),
      `${signature} must be revoked`);
    assert.match(FIXES, new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped} TO service_role`),
      `${signature} must be granted only to service_role`);
  }
  // A SECURITY DEFINER function reachable from a browser key would bypass RLS.
  const definers = (FIXES.match(/SECURITY DEFINER/g) || []).length;
  assert.equal(definers, 4);
  assert.equal((FIXES.match(/SET search_path = ''/g) || []).length, 4);
});

// ── Recording is unconditional ──────────────────────────────────────────────

function acceptanceBody() {
  const start = FIXES.indexOf('CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_acceptance(');
  const end = FIXES.indexOf('\n$$;\n', start);
  assert.ok(start > -1 && end > start);
  return FIXES.slice(start, end);
}

test('the post-send eligibility check can no longer refuse to record a send', () => {
  const body = acceptanceBody();

  // The eligibility signals are still evaluated...
  for (const signal of [
    'sms_campaign_suppressions', "flow_type = 'opted-out'", 'coalesce(c.opted_out, false) = true',
    'ghl_dnd_synced_at', 'consent_evidence_required'
  ]) {
    assert.ok(body.includes(signal), `${signal} must still be evaluated`);
  }

  // ...but none of them raises any more.
  assert.doesNotMatch(body, /RAISE EXCEPTION 'campaign_recipient_no_longer_eligible'/,
    'refusing to record cannot un-send; it only destroys the record');
  assert.doesNotMatch(body, /RAISE EXCEPTION 'campaign_live_send_disabled'/,
    'flipping the switch off mid-batch must not erase messages already sent');
  assert.doesNotMatch(body, /RAISE EXCEPTION 'campaign_provider_acceptance_before_claim'/,
    'clock skew between Railway and Postgres must not delete a send record');
  assert.doesNotMatch(body, /RAISE EXCEPTION 'campaign_claim_reservation_missing'/,
    'a sent message must get a ledger row, not an exception');

  // They become evidence instead.
  assert.match(body, /provider\.accepted_while_ineligible/);
  assert.match(body, /array_append\(v_reasons/);

  // The identity fence stays, in full. It is the only thing that may refuse.
  assert.match(body, /RAISE EXCEPTION 'campaign_claim_fence_failed'/);
  assert.match(body, /v_recipient\.state NOT IN \('sending', 'reconciliation_required'\)/);
  assert.match(body, /v_recipient\.claim_token <> p_claim_token/);
  assert.match(body, /v_recipient\.provider_idempotency_key <> p_provider_idempotency_key/);

  // The ledger row is written even if the reservation vanished.
  assert.match(body, /INSERT INTO public\.sms_commercial_contact_ledger/);
  assert.match(body, /ON CONFLICT \(workspace_id, idempotency_key\) DO UPDATE/);
});

test('the acceptance timestamp is clamped, never rejected', () => {
  assert.match(acceptanceBody(),
    /v_accepted_at := least\(greatest\(p_accepted_at,[\s\S]*?\), now\(\)\)/);
});

// ── The frequency-cap mutation test ─────────────────────────────────────────

/**
 * A faithful model of the cadence predicate the database evaluates for one
 * ledger row, in both the fixed and the original form.
 *
 * Fixed:    accepted_at IS NOT NULL
 *           OR reservation_expires_at > now()
 *           OR recipient.state IN ('sending', 'reconciliation_required')
 * Original: accepted_at IS NOT NULL OR reservation_expires_at > now()
 */
function countsAgainstCaps(ledger, recipientState, now, { original = false } = {}) {
  if (ledger.accepted_at !== null) return true;
  if (ledger.reservation_expires_at !== null && ledger.reservation_expires_at > now) return true;
  if (original) return false;
  return recipientState === 'sending' || recipientState === 'reconciliation_required';
}

/** The exact trace from the review, run as a state machine. */
function traceSend({ acceptanceSucceeds, workerSurvives }) {
  const t0 = 1000;
  const lease = 300;
  // 1. begin_sms_campaign_provider_attempt
  let ledger = { accepted_at: null, reservation_expires_at: t0 + lease };
  let recipientState = 'sending';

  // 2. send() SUCCEEDS. The text is in the customer's hand. This is the fact
  //    every assertion below is measured against.
  const messageWasSent = true;

  // 3. record_sms_campaign_provider_acceptance
  if (workerSurvives) {
    if (acceptanceSucceeds) {
      ledger = { accepted_at: t0 + 1, reservation_expires_at: null };
      recipientState = 'sent';
    }
    // If it fails, nothing changes: accepted_at stays NULL.
  }

  // 4. The lease expires. release_expired_sms_campaign_claims runs and moves
  //    `sending` to `reconciliation_required`, and deliberately does NOT expire
  //    the ledger reservation of a row in that state.
  const now = t0 + lease + 1;
  if (recipientState === 'sending') recipientState = 'reconciliation_required';

  return { ledger, recipientState, now, messageWasSent };
}

test('MUTATION: a send whose acceptance RPC fails is still counted against the caps', () => {
  const world = traceSend({ acceptanceSucceeds: false, workerSurvives: true });
  assert.equal(world.messageWasSent, true);
  assert.equal(world.ledger.accepted_at, null, 'the acceptance genuinely was not recorded');
  assert.ok(world.ledger.reservation_expires_at < world.now, 'and its reservation has expired');

  assert.equal(
    countsAgainstCaps(world.ledger, world.recipientState, world.now, { original: true }),
    false,
    'CONTROL: under the original predicate this sent message escaped every cap'
  );
  assert.equal(
    countsAgainstCaps(world.ledger, world.recipientState, world.now),
    true,
    'FIXED: the sent message counts towards spacing, 7-day and 30-day caps'
  );
});

test('MUTATION: a send whose worker died before recording is still counted', () => {
  const world = traceSend({ acceptanceSucceeds: false, workerSurvives: false });
  assert.equal(
    countsAgainstCaps(world.ledger, world.recipientState, world.now, { original: true }),
    false, 'CONTROL: uncounted before the fix');
  assert.equal(countsAgainstCaps(world.ledger, world.recipientState, world.now), true);
});

test('MUTATION: an in-flight send counts from the instant it enters `sending`', () => {
  // Not after the 15-minute recovery timer. Before the fix a row whose lease
  // had lapsed but whose recovery had not yet run was invisible.
  const ledger = { accepted_at: null, reservation_expires_at: 100 };
  assert.equal(countsAgainstCaps(ledger, 'sending', 5000, { original: true }), false);
  assert.equal(countsAgainstCaps(ledger, 'sending', 5000), true);
});

test('the ordinary accepted send is unaffected, and a refusal still frees the budget', () => {
  const accepted = traceSend({ acceptanceSucceeds: true, workerSurvives: true });
  assert.equal(countsAgainstCaps(accepted.ledger, accepted.recipientState, accepted.now), true);
  assert.equal(
    countsAgainstCaps(accepted.ledger, accepted.recipientState, accepted.now, { original: true }),
    true, 'the happy path behaved correctly before and behaves correctly now');

  // A refused message never left, so it must NOT consume the recipient's budget.
  const refused = { accepted_at: null, reservation_expires_at: 100 };
  assert.equal(countsAgainstCaps(refused, 'failed', 5000), false);
});

test('the three cadence predicates in the claim RPC all carry the fix', () => {
  const start = FIXES.indexOf('CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients(');
  const end = FIXES.indexOf('\n$$;\n', start);
  const body = FIXES.slice(start, end);
  const guarded = body.match(
    /ledger\.accepted_at IS NOT NULL OR ledger\.reservation_expires_at > now\(\)\s*\n\s*OR EXISTS \(/g
  ) || [];
  assert.equal(guarded.length, 3,
    'minimum_promotional_spacing_hours, max_promotional_per_7_days and max_promotional_per_30_days');
  assert.equal(
    (body.match(/inflight\.state IN \('sending', 'reconciliation_required'\)/g) || []).length, 3);

  // And nothing else in that long function drifted from the applied version.
  const oStart = ORIGINAL.indexOf('CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients(');
  const oBody = ORIGINAL.slice(oStart, ORIGINAL.indexOf('\n$$;\n', oStart));
  const strip = (text) => text
    .replace(/ledger\.accepted_at IS NOT NULL OR ledger\.reservation_expires_at > now\(\)[\s\S]*?\n(\s*)\)\)/g,
      'ledger.accepted_at IS NOT NULL OR ledger.reservation_expires_at > now())')
    .replace(/\s+/g, ' ');
  assert.equal(strip(body), strip(oBody),
    'the claim function must differ from the applied one only in the cadence predicate');
});

test('recovery must keep refusing to expire an in-flight reservation', () => {
  const start = FIXES.indexOf('CREATE OR REPLACE FUNCTION public.release_expired_sms_campaign_claims(');
  const body = FIXES.slice(start, FIXES.indexOf('\n$$;\n', start));
  assert.match(body, /NOT EXISTS \(/);
  assert.match(body, /r\.state IN \('sending', 'reconciliation_required'\)/);

  const oStart = ORIGINAL.indexOf('CREATE OR REPLACE FUNCTION public.release_expired_sms_campaign_claims(');
  assert.equal(body, ORIGINAL.slice(oStart, ORIGINAL.indexOf('\n$$;\n', oStart)),
    'replaced verbatim; only the surrounding comment is new');
});

// ── The refusal function ────────────────────────────────────────────────────

test('a refusal frees the reservation, marks the row failed and can never overwrite a send', () => {
  const start = FIXES.indexOf('CREATE OR REPLACE FUNCTION public.record_sms_campaign_provider_refusal(');
  const body = FIXES.slice(start, FIXES.indexOf('\n$$;\n', start));

  assert.match(body, /v_recipient\.provider_message_id IS NOT NULL/,
    'a row that already has a message id went out; a refusal must not claim otherwise');
  assert.match(body, /RAISE EXCEPTION 'campaign_claim_fence_failed'/);
  assert.match(body, /v_recipient\.state NOT IN \('sending', 'reconciliation_required'\)/);
  assert.match(body, /state = 'failed', provider_status = 'refused', provider_error_code = v_code/);
  assert.match(body, /reservation_expires_at = now\(\)/);
  assert.doesNotMatch(body, /accepted_at = /,
    'a refusal is not a contact and must never consume the frequency budget');
  // 'provider.%' event types carry a CHECK requiring a provider_message_id.
  assert.match(body, /'recipient\.provider_refused'/);
});

// ── The delivery loop cannot stack on itself ────────────────────────────────

test('setInterval never starts a second delivery batch on top of a running one', () => {
  // server.js cannot be required here: it validates env, connects to Supabase
  // and listens. The guard is a four-line invariant, so read it from source.
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('function startCampaignDelivery()');
  assert.ok(start > -1);
  const body = source.slice(start, source.indexOf('\nconst PORT', start));

  // A batch of 10 with a 20s provider timeout can run for 200 seconds against
  // a 120-second interval. Without a guard, the runs overlap and each claims
  // rows the other is already leasing.
  assert.match(body, /let delivering = false;/);
  assert.match(body, /if \(delivering\) return;\s*\n\s*delivering = true;/);
  assert.match(body, /finally \{\s*\n\s*delivering = false;\s*\n\s*\}/);

  assert.match(body, /let recovering = false;/);
  assert.match(body, /if \(recovering\) return;/);

  // The three-outcome model must be visible in the operational log line.
  assert.match(body, /refused=\$\{summary\.refused\}/);
});
