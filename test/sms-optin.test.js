'use strict';
/**
 * test/sms-optin.test.js — the emailed promotional SMS opt-in.
 *
 * WHAT THIS FILE IS ACTUALLY FOR
 *   Not coverage. This flow is the only place in the product where promotional
 *   SMS consent can come into existence, so a bug here does not produce a
 *   missing feature, it produces consent records that are wrong — and a wrong
 *   consent record is indistinguishable from a right one until somebody is
 *   asked to defend it. The properties below are each a real incident if they
 *   are false, and each is asserted on OBSERVABLE LEDGER STATE rather than on a
 *   status code:
 *
 *     1. Exactly one consent row per invitation per direction, even when two
 *        clicks land simultaneously.
 *     2. A token cannot be spent twice into two records.
 *     3. An expired token cannot produce an opt-in.
 *     4. An unknown token gets one generic answer, byte for byte identical to
 *        the answer a superseded token gets. No enumeration oracle.
 *     5. The raw token is stored nowhere. Every value handed to the store is
 *        scanned for it, not just the column somebody remembered to check.
 *     6. The opt-out path works, works from a dead link, and is not reversible
 *        by pressing the other button in the same email.
 *     7. Opening the page records nothing. A mail scanner that follows the link
 *        must not manufacture consent.
 *     8. The evidence is actually there: source, evidence_ref, IP and
 *        user-agent, on the row itself.
 *
 * WHY THE FAKES LOOK LIKE THIS
 *   `fakeInviteStore` is a small in-memory model of the SQL in
 *   scripts/sms-optin-migration.sql, INCLUDING its ordering of checks and its
 *   RAISE messages, because those messages are the contract confirmErrorFrom()
 *   parses. It serialises `claim` behind a single promise chain, which is the
 *   JavaScript analogue of SELECT ... FOR UPDATE and is what makes the
 *   concurrency test meaningful rather than decorative.
 *
 *   `fakeConsentClient` is a model of `sms_consent_events` that enforces the
 *   real UNIQUE index on (workspace_id, dedupe_key) and reports a violation the
 *   way PostgREST does, with code 23505. That index is the second of the two
 *   independent guarantees against a duplicate consent row, so a fake that did
 *   not enforce it would make the concurrency test pass for the wrong reason.
 *
 * Offline: no database, no network, no provider, no timers.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  CONFIRM_ERRORS,
  EXPIRY_DAYS,
  GENERIC_LINK_MESSAGE,
  RESPONSES,
  confirmOptInInvite,
  dedupeKeyFor,
  evidenceRefFor,
  expiryFrom,
  generateToken,
  hashToken,
  isPlausibleToken,
  createSmsOptInInviteStore,
  issueOptInInvite,
  optInUrlFor,
  phoneEnding,
  tokenPrefixOfHash
} = require('../lib/campaigns/sms-optin-invite');
const { SOURCE } = require('../lib/campaigns/consent');
const { CONFIRM_SOURCE, DECLINE_SOURCE, DECLINE_SOURCE_VALUE } =
  require('../lib/campaigns/sms-optin-invite');
const { smsOptInInviteEmail } = require('../lib/email-templates');
const createSmsOptInRouter = require('../routes/sms-optin');
const { PAGE_SIZE, fetchAllRows } = require('../lib/fetch-all-rows');
const { CONFIRM_MAX, DECLINE_MAX } = require('../routes/sms-optin');

const PHONE = '+14155550132';
const CAMPAIGN_REF = 'sms_optin_invite_2026_08';
const BASE_URL = 'https://inbox.example.com';
const ROOT = path.join(__dirname, '..');

// ── Fakes ──────────────────────────────────────────────────────────────────

/**
 * An in-memory model of the tables this flow touches through the Supabase
 * client: `sms_consent_events` with its unique dedupe index, plus the four
 * places a withdrawal can live.
 *
 * IT MODELS THE WITHDRAWAL SOURCES BECAUSE THE CODE READS THEM. A fake that
 * only answered `insert` would have made every withdrawal test pass by
 * accident, since an unimplemented table cannot report an opt-out.
 *
 * Every builder returned here is a thenable with `then` ONLY, exactly like a
 * Supabase query builder. If anything in the code under test ever calls
 * `.catch()` on one, it fails here rather than in production. See
 * test/no-builder-catch.test.js.
 */
function fakeConsentClient() {
  const rows = [];
  const state = {
    rows,
    /** The next sms_consent_events INSERT resolves with a transport error. */
    failNext: false,
    /** Name of a table whose SELECT resolves with an error, or null. */
    readFailure: null,
    /**
     * True when `.from()` THROWS instead of resolving with an error. A different
     * failure mode from `readFailure`, and it has its own branch in
     * activeWithdrawalReason: a fake that only modelled one of the two let the
     * other's guard be deleted without a test noticing.
     */
    throwOnRead: false,
    sentLog: [],
    suppressions: [],
    contacts: []
  };

  /** A chainable read that applies its filters, ordering and limit on await. */
  function queryable(table, getRows) {
    const filters = [];
    const orders = [];
    let max = null;
    let single = false;

    const builder = {
      select() { return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      order(column, options) {
        orders.push([column, options && options.ascending === false ? -1 : 1]);
        return builder;
      },
      limit(count) { max = count; return builder; },
      maybeSingle() { single = true; return builder; },
      then(resolve) {
        if (state.readFailure === table) {
          return resolve({ data: null, error: { code: '08006', message: 'connection refused' } });
        }
        let matched = getRows().filter(row => filters.every(([column, value]) => row[column] === value));
        // Applied last key first, so the first .order() call is the primary one,
        // matching PostgREST.
        for (const [column, direction] of [...orders].reverse()) {
          matched = matched.slice().sort((a, b) => {
            if (a[column] === b[column]) return 0;
            return (a[column] > b[column] ? 1 : -1) * direction;
          });
        }
        if (max !== null) matched = matched.slice(0, max);
        return resolve(single ? { data: matched[0] || null, error: null } : { data: matched, error: null });
      }
    };
    return builder;
  }

  return {
    state,
    optIns() { return rows.filter(row => row.event_type === 'opt_in'); },
    optOuts() { return rows.filter(row => row.event_type === 'opt_out'); },
    from(table) {
      if (state.throwOnRead && table !== 'sms_consent_events') {
        throw new Error(`connection lost reading ${table}`);
      }
      if (table === 'sms_consent_events') {
        return {
          select() { return queryable(table, () => rows); },
          insert(row) {
            return {
              then(resolve) {
                if (state.failNext) {
                  state.failNext = false;
                  return resolve({ error: { code: '08006', message: 'connection refused' } });
                }
                const clash = row.dedupe_key !== null && row.dedupe_key !== undefined
                  && rows.some(existing =>
                    existing.workspace_id === row.workspace_id
                    && existing.dedupe_key === row.dedupe_key);
                if (clash) {
                  return resolve({
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "sms_consent_events_dedupe_idx"' }
                  });
                }
                rows.push({ ...row, id: rows.length + 1 });
                return resolve({ error: null });
              }
            };
          }
        };
      }
      if (table === 'sms_sent_log') return queryable(table, () => state.sentLog);
      if (table === 'sms_campaign_suppressions') return queryable(table, () => state.suppressions);
      if (table === 'sms_contacts') return queryable(table, () => state.contacts);
      assert.fail(`unexpected table read: ${table}`);
      return null;
    }
  };
}

/**
 * An in-memory model of sms_optin_invitations plus its two SQL functions,
 * following scripts/sms-optin-migration.sql check for check and RAISE for
 * RAISE.
 */
function fakeInviteStore(db = fakeConsentClient()) {
  const state = {
    invitations: [],
    /** Everything ever handed to open(), for the "no raw token stored" scan. */
    written: [],
    attempts: [],
    /** 'open' | 'claim' | 'lookup' — which call throws. */
    failWith: null,
    /** The same fake Supabase client the consent ledger is written through. */
    db,
    now: () => Date.now()
  };

  /** The FOR UPDATE analogue: claim() calls run one at a time, in order. */
  let lock = Promise.resolve();

  function raise(code) {
    throw new Error(`postgres error: ${code}`);
  }

  function claimNow({ tokenHash, response, ip, userAgent }) {
    if (response !== RESPONSES.OPT_IN && response !== RESPONSES.OPT_OUT) raise('OPTIN_NOT_VALID');

    const invite = state.invitations.find(row => row.token_hash === tokenHash);
    if (!invite) raise('OPTIN_NOT_VALID');

    const isOptOut = response === RESPONSES.OPT_OUT;
    if (!isOptOut) {
      if (invite.cancelled_at) raise('OPTIN_NOT_VALID');
      if (new Date(invite.expires_at).getTime() <= state.now()) raise('OPTIN_EXPIRED');
      if (invite.responded_at && invite.response === RESPONSES.OPT_OUT) raise('OPTIN_ALREADY_DECLINED');
    }

    const previousResponse = invite.response;

    let newly;
    if (!invite.responded_at || invite.response !== response) {
      invite.response = response;
      invite.responded_at = new Date(state.now()).toISOString();
      invite.responded_ip = ip || null;
      invite.responded_user_agent = userAgent || null;
      // Written by the FIRST transition and never touched again, exactly like
      // the coalesce/CASE in claim_sms_optin_invitation.
      if (invite.first_responded_at === null) {
        invite.first_response = response;
        invite.first_responded_at = invite.responded_at;
        invite.first_responded_ip = ip || null;
        invite.first_responded_user_agent = userAgent || null;
      }
      newly = true;
    } else {
      invite.attempt_count += 1;
      newly = false;
    }

    return {
      invitation_id: invite.id,
      workspace_id: invite.workspace_id,
      contact_phone: invite.contact_phone,
      campaign_ref: invite.campaign_ref,
      response,
      previous_response: previousResponse,
      first_response: invite.first_response,
      newly_recorded: newly
    };
  }

  return {
    state,

    /** The seam confirmOptInInvite and issueOptInInvite resolve the client from. */
    dbClient() { return state.db; },

    /**
     * The advisory read. Returns the same columns the real store selects and
     * changes nothing, which is what lets the opt-out path write the consent
     * ledger before it touches the invitation row.
     */
    async lookup(tokenHash) {
      if (state.failWith === 'lookup') throw new Error('select failed');
      const invite = state.invitations.find(row => row.token_hash === tokenHash);
      if (!invite) return null;
      return {
        id: invite.id,
        workspace_id: invite.workspace_id,
        contact_phone: invite.contact_phone,
        campaign_ref: invite.campaign_ref,
        expires_at: invite.expires_at,
        cancelled_at: invite.cancelled_at,
        responded_at: invite.responded_at,
        response: invite.response
      };
    },

    async open(row) {
      if (state.failWith === 'open') throw new Error('insert failed');
      state.written.push(row);
      for (const existing of state.invitations) {
        if (existing.workspace_id === row.workspace
          && existing.contact_phone === row.phone
          && !existing.responded_at && !existing.cancelled_at) {
          existing.cancelled_at = new Date(state.now()).toISOString();
          existing.cancelled_reason = 'superseded';
        }
      }
      const invite = {
        id: crypto.randomUUID(),
        workspace_id: row.workspace,
        contact_phone: row.phone,
        contact_email: row.email,
        campaign_ref: row.campaignRef,
        token_hash: row.tokenHash,
        token_prefix: row.tokenPrefix,
        expires_at: row.expiresAt,
        created_at: new Date(state.now()).toISOString(),
        responded_at: null,
        response: null,
        responded_ip: null,
        responded_user_agent: null,
        first_response: null,
        first_responded_at: null,
        first_responded_ip: null,
        first_responded_user_agent: null,
        cancelled_at: null,
        cancelled_reason: null,
        attempt_count: 0
      };
      state.invitations.push(invite);
      return invite.id;
    },

    /**
     * Serialised, like SELECT ... FOR UPDATE. Every caller queues behind the
     * previous one, so two concurrent claims cannot interleave their
     * read-modify-write.
     */
    claim(args) {
      if (state.failWith === 'claim') return Promise.reject(new Error('update failed'));
      const run = lock.then(() => claimNow(args), () => claimNow(args));
      // The queue must advance whether this call raised or not, and it must not
      // carry a rejection forward to the next caller.
      lock = run.then(() => {}, () => {});
      return run;
    },

    async noteAttempt(tokenHash) {
      state.attempts.push(tokenHash);
    }
  };
}

/** Issue one invitation and hand back everything a test needs to answer it. */
async function seedInvitation(overrides = {}) {
  // One fake database behind both seams, because in production
  // `store.dbClient()` and `consentClient` are the same Supabase client. A test
  // where they differed could not observe a STOP arriving between the mint and
  // the click, which is the scenario that matters most here.
  const consent = overrides.consent || (overrides.store ? overrides.store.state.db : fakeConsentClient());
  const store = overrides.store || fakeInviteStore(consent);
  let issuedToken = null;

  // The raw token never leaves issueOptInInvite, by design, so it is recovered
  // from the URL exactly as a recipient's browser would recover it.
  const issued = await issueOptInInvite({
    store,
    phone: overrides.phone || PHONE,
    email: overrides.email === undefined ? 'customer@example.com' : overrides.email,
    campaignRef: CAMPAIGN_REF,
    baseUrl: BASE_URL,
    now: overrides.now
  });
  if (issued.issued) {
    issuedToken = new URL(issued.inviteUrl).searchParams.get('token');
  }

  return { store, consent, issued, token: issuedToken };
}

function answer(context, response, extra = {}) {
  return confirmOptInInvite({
    store: context.store,
    consentClient: context.consent,
    token: context.token,
    response,
    ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    ...extra
  });
}

// ── Token handling ─────────────────────────────────────────────────────────

test('a token is 256 bits of randomness and no two are alike', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = generateToken();
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(seen.has(token), false, 'generateToken repeated itself');
    seen.add(token);
  }
});

test('what is stored is the hash and a prefix OF THE HASH, never the token', async () => {
  const context = await seedInvitation();
  const written = context.store.state.written;
  assert.equal(written.length, 1);

  const row = written[0];
  assert.equal(row.tokenHash, hashToken(context.token));
  assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(row.tokenPrefix, tokenPrefixOfHash(row.tokenHash));
  assert.match(row.tokenPrefix, /^[0-9a-f]{8}$/);

  // The prefix must be a prefix of the HASH. A prefix of the TOKEN would leak
  // eight characters of a live credential into every log line that mentions it.
  assert.equal(context.token.startsWith(row.tokenPrefix), false);

  // Scan EVERY value that reached the store, not just the column we expect the
  // mistake in.
  const serialised = JSON.stringify([written, context.store.state.invitations]);
  assert.equal(serialised.includes(context.token), false, 'the raw token reached storage');
});

test('the invite URL carries the token and nothing else identifying', async () => {
  const context = await seedInvitation();
  const url = new URL(context.issued.inviteUrl);
  assert.equal(url.origin + url.pathname, `${BASE_URL}/sms-optin`);
  assert.deepEqual([...url.searchParams.keys()], ['token']);
  // No phone number, no email, no invitation id in the link.
  assert.equal(context.issued.inviteUrl.includes(PHONE.slice(1)), false);
  assert.equal(context.issued.inviteUrl.includes('customer@example.com'), false);
  assert.equal(context.issued.inviteUrl.includes(context.issued.invitationId), false);
});

test('no APP_URL means no invitation row, not a broken link', async () => {
  const store = fakeInviteStore();
  const issued = await issueOptInInvite({
    store, phone: PHONE, campaignRef: CAMPAIGN_REF, baseUrl: ''
  });
  assert.deepEqual(issued, { issued: false, reason: 'no_app_url' });
  assert.equal(store.state.invitations.length, 0);
});

test('issuing refuses a number that is not E.164 and a mailing with no reference', async () => {
  const store = fakeInviteStore();
  assert.equal(
    (await issueOptInInvite({ store, phone: '415 555 0132', campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL })).reason,
    'invalid_phone'
  );
  assert.equal(
    (await issueOptInInvite({ store, phone: PHONE, campaignRef: '  ', baseUrl: BASE_URL })).reason,
    'campaign_ref_required'
  );
  assert.equal(store.state.invitations.length, 0);
});

test('issuing writes nothing to the consent ledger', async () => {
  const context = await seedInvitation();
  assert.equal(context.issued.issued, true);
  assert.equal(context.consent.state.rows.length, 0,
    'an unanswered invitation must never create consent');
});

// ── The happy path, and the evidence it leaves ─────────────────────────────

test('confirming records one opt_in with source, evidence, IP and user-agent', async () => {
  const context = await seedInvitation();
  const result = await answer(context, RESPONSES.OPT_IN);

  assert.equal(result.ok, true);
  assert.equal(result.response, 'opt_in');
  assert.equal(result.alreadyRecorded, false);

  const rows = context.consent.optIns();
  assert.equal(rows.length, 1);
  const row = rows[0];

  assert.equal(row.contact_phone, PHONE);
  assert.equal(row.event_type, 'opt_in');
  assert.equal(row.purpose, 'promotional_sms');
  assert.equal(row.source, SOURCE.CONFIRMED_INVITE);

  // The evidence_ref must resolve to the invitation, so that "which email
  // produced this consent?" has an answer.
  assert.equal(row.evidence_ref, evidenceRefFor(context.issued.invitationId));
  assert.equal(row.dedupe_key, dedupeKeyFor(context.issued.invitationId, 'opt_in'));

  // The evidence that makes this defensible.
  assert.equal(row.metadata.ip, '203.0.113.9');
  assert.match(row.metadata.user_agent, /iPhone/);
  assert.equal(row.metadata.invitation_id, context.issued.invitationId);
  assert.equal(row.metadata.campaign_ref, CAMPAIGN_REF);
  assert.ok(row.metadata.confirmed_at, 'the moment of the click is not recorded');
});

test('the phone number comes from the invitation, never from the caller', async () => {
  const context = await seedInvitation();
  // A hostile client submitting somebody else's number alongside the token.
  await confirmOptInInvite({
    store: context.store,
    consentClient: context.consent,
    token: context.token,
    response: RESPONSES.OPT_IN,
    phone: '+15555550001',
    contact_phone: '+15555550001'
  });
  const rows = context.consent.optIns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_phone, PHONE);
});

test('a user-agent is truncated before it is stored', async () => {
  const context = await seedInvitation();
  await answer(context, RESPONSES.OPT_IN, { userAgent: 'x'.repeat(5000) });
  assert.equal(context.consent.optIns()[0].metadata.user_agent.length, 400);
});

// ── Single use, idempotency and the race ───────────────────────────────────

test('a token cannot be spent into two consent records', async () => {
  const context = await seedInvitation();

  const first = await answer(context, RESPONSES.OPT_IN);
  const second = await answer(context, RESPONSES.OPT_IN);

  assert.equal(first.ok, true);
  assert.equal(first.alreadyRecorded, false);
  assert.equal(second.ok, true);
  // The second press is honest about having changed nothing.
  assert.equal(second.alreadyRecorded, true);

  assert.equal(context.consent.optIns().length, 1, 'the token was spent twice');
});

test('two simultaneous clicks produce exactly ONE consent row', async () => {
  const context = await seedInvitation();

  const results = await Promise.all([
    answer(context, RESPONSES.OPT_IN),
    answer(context, RESPONSES.OPT_IN),
    answer(context, RESPONSES.OPT_IN),
    answer(context, RESPONSES.OPT_IN)
  ]);

  assert.deepEqual(results.map(r => r.ok), [true, true, true, true]);
  assert.equal(
    results.filter(r => r.alreadyRecorded === false).length, 1,
    'more than one caller believed it performed the transition'
  );
  assert.equal(context.consent.optIns().length, 1,
    'concurrent confirmations produced more than one consent row');
});

test('a repeat click repairs a ledger write that was lost after the claim', async () => {
  const context = await seedInvitation();

  // The first attempt claims the invitation and then the ledger write fails.
  context.consent.state.failNext = true;
  const first = await answer(context, RESPONSES.OPT_IN);
  assert.equal(first.ok, false);
  // NOT OPTIN_RECORD_FAILED. The invitation row was claimed, so the message
  // that promises "nothing has been recorded" would be false, and a person who
  // believes nothing happened does not press the button that repairs this.
  assert.equal(first.code, 'OPTIN_NOT_CONFIRMED');
  assert.equal(context.consent.optIns().length, 0);

  // The invitation is now answered, so a naive implementation would refuse the
  // retry and leave the person believing they opted in with nothing on file.
  const second = await answer(context, RESPONSES.OPT_IN);
  assert.equal(second.ok, true);
  assert.equal(context.consent.optIns().length, 1, 'the ledger was never repaired');
});

// ── Expiry ─────────────────────────────────────────────────────────────────

test('an expired token cannot produce an opt_in', async () => {
  const issuedAt = Date.UTC(2026, 0, 1);
  const context = await seedInvitation({ now: () => issuedAt });

  const afterExpiry = issuedAt + (EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000;
  context.store.state.now = () => afterExpiry;

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_EXPIRED');
  assert.equal(result.status, 410);
  assert.equal(context.consent.state.rows.length, 0, 'an expired link created consent');
});

test('expiry is measured in EXPIRY_DAYS and stated by the issuer', async () => {
  const at = Date.UTC(2026, 5, 1);
  assert.equal(expiryFrom(at), new Date(at + EXPIRY_DAYS * 86400000).toISOString());
  const context = await seedInvitation({ now: () => at });
  assert.equal(context.issued.expiresAt, expiryFrom(at));
});

test('an expired link still accepts a NO, because a refusal must never be blocked', async () => {
  const issuedAt = Date.UTC(2026, 0, 1);
  const context = await seedInvitation({ now: () => issuedAt });
  context.store.state.now = () => issuedAt + (EXPIRY_DAYS + 30) * 24 * 60 * 60 * 1000;

  const result = await answer(context, RESPONSES.OPT_OUT);
  assert.equal(result.ok, true);
  assert.equal(context.consent.optOuts().length, 1);
  assert.equal(context.consent.optIns().length, 0);
});

// ── Anti-enumeration ───────────────────────────────────────────────────────

test('an unknown token gets the generic answer, and so does a superseded one', async () => {
  const context = await seedInvitation();

  const unknown = await confirmOptInInvite({
    store: context.store,
    consentClient: context.consent,
    token: generateToken(),
    response: RESPONSES.OPT_IN
  });

  // A second mailing to the same number cancels the first invitation.
  const resent = await issueOptInInvite({
    store: context.store, phone: PHONE, campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL
  });
  assert.equal(resent.issued, true);
  const superseded = await answer(context, RESPONSES.OPT_IN);

  // Byte for byte identical. Anything less and the endpoint tells a prober
  // whether a number has ever been invited, which is the same as telling them
  // whether it is a customer.
  assert.deepEqual(unknown, superseded);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'OPTIN_NOT_VALID');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.message, GENERIC_LINK_MESSAGE);

  // And the generic message says nothing about anybody.
  assert.equal(/\d{4}/.test(unknown.message), false);
  assert.equal(unknown.message.includes('@'), false);

  assert.equal(context.consent.state.rows.length, 0);
});

test('an unknown token gets the SAME generic answer whichever button was pressed', async () => {
  // The decline path resolves the invitation itself rather than letting the
  // claim raise, so it needs its own anti-enumeration assertion. A distinct
  // answer here would tell a prober whether a token was ever issued, which is
  // the same as telling them whether a number is a customer.
  const context = await seedInvitation();
  const unknownToken = generateToken();

  const declined = await confirmOptInInvite({
    store: context.store, consentClient: context.consent,
    token: unknownToken, response: RESPONSES.OPT_OUT
  });
  const confirmed = await confirmOptInInvite({
    store: context.store, consentClient: context.consent,
    token: unknownToken, response: RESPONSES.OPT_IN
  });

  assert.deepEqual(declined, confirmed);
  assert.equal(declined.code, 'OPTIN_NOT_VALID');
  assert.equal(declined.status, 404);
  assert.equal(declined.message, GENERIC_LINK_MESSAGE);
  assert.equal(context.consent.state.rows.length, 0);
  // Both attempts are counted, so a hammered unknown token is visible whichever
  // endpoint it is hammered at.
  assert.equal(context.store.state.attempts.length, 2);
});

test('a malformed token is refused before any lookup happens', async () => {
  const context = await seedInvitation();
  for (const bad of ['', 'short', ' ', null, undefined, 42, 'has space in it', 'x'.repeat(513)]) {
    const result = await confirmOptInInvite({
      store: context.store, consentClient: context.consent, token: bad, response: RESPONSES.OPT_IN
    });
    assert.equal(result.code, 'OPTIN_NOT_VALID', String(bad));
  }
  // Nothing reached the store: no claim, and therefore no attempt counter.
  assert.deepEqual(context.store.state.attempts, []);
  assert.equal(context.consent.state.rows.length, 0);
});

test('isPlausibleToken agrees with the bounds the page applies', () => {
  assert.equal(isPlausibleToken(generateToken()), true);
  assert.equal(isPlausibleToken('x'.repeat(15)), false);
  assert.equal(isPlausibleToken('x'.repeat(16)), true);
  assert.equal(isPlausibleToken('x'.repeat(512)), true);
  assert.equal(isPlausibleToken('x'.repeat(513)), false);
});

test('a refused claim is counted, so a hammered token is visible', async () => {
  const context = await seedInvitation();
  await confirmOptInInvite({
    store: context.store, consentClient: context.consent,
    token: generateToken(), response: RESPONSES.OPT_IN
  });
  assert.equal(context.store.state.attempts.length, 1);
});

// ── The opt-out path ───────────────────────────────────────────────────────

test('declining records one opt_out with the invitation as evidence', async () => {
  const context = await seedInvitation();
  const result = await answer(context, RESPONSES.OPT_OUT);

  assert.equal(result.ok, true);
  assert.equal(result.response, 'opt_out');

  const rows = context.consent.optOuts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_phone, PHONE);
  assert.equal(rows[0].event_type, 'opt_out');
  // A withdrawal is NOT filed under a source whose name asserts a confirmation.
  assert.equal(rows[0].source, DECLINE_SOURCE);
  assert.notEqual(rows[0].source, SOURCE.CONFIRMED_INVITE);
  assert.equal(rows[0].evidence_ref, evidenceRefFor(context.issued.invitationId));
  assert.equal(context.consent.optIns().length, 0);
});

test('declining twice records one opt_out', async () => {
  const context = await seedInvitation();
  const [a, b] = await Promise.all([
    answer(context, RESPONSES.OPT_OUT),
    answer(context, RESPONSES.OPT_OUT)
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(context.consent.optOuts().length, 1);
});

test('somebody who said yes may still say no, and the no is recorded', async () => {
  const context = await seedInvitation();
  await answer(context, RESPONSES.OPT_IN);
  const changed = await answer(context, RESPONSES.OPT_OUT);

  assert.equal(changed.ok, true);
  assert.equal(context.consent.optIns().length, 1);
  assert.equal(context.consent.optOuts().length, 1);
  // Two different dedupe keys, so both directions are recordable exactly once.
  assert.notEqual(
    dedupeKeyFor(context.issued.invitationId, 'opt_in'),
    dedupeKeyFor(context.issued.invitationId, 'opt_out')
  );
});

test('somebody who said no cannot be flipped to yes by the same emailed link', async () => {
  const context = await seedInvitation();
  await answer(context, RESPONSES.OPT_OUT);

  const flipped = await answer(context, RESPONSES.OPT_IN);
  assert.equal(flipped.ok, false);
  assert.equal(flipped.code, 'OPTIN_ALREADY_DECLINED');
  assert.equal(flipped.status, 409);
  assert.equal(context.consent.optIns().length, 0, 'a recorded refusal was overwritten');
});

test('a storage failure reports failure rather than a consent that does not exist', async () => {
  const context = await seedInvitation();
  context.consent.state.failNext = true;

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_NOT_CONFIRMED');
  assert.equal(result.status, 503);
  assert.equal(context.consent.state.rows.length, 0);
  // And the copy does not claim nothing happened, because the claim stands.
  assert.equal(result.message.includes('Nothing has been recorded'), false);
});

// ── THE REAL STORE, NOT THE FAKE ───────────────────────────────────────────
//
// Everything above injects `fakeInviteStore`, which is a model of the SQL. That
// leaves the actual `createSmsOptInInviteStore()` untested, and it is the thing
// that runs in production. These drive it with an injected Supabase-shaped
// client, so a swallowed `error` in the real store is caught here.

/** A client shaped like Supabase: builders are thenables with `then` only. */
function fakeSupabase({ rpc = () => ({ data: null, error: null }), row = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) { calls.push({ rpc: name, args }); return Promise.resolve(rpc(name, args)); },
    from(table) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        update() { return builder; },
        maybeSingle() { return builder; },
        then(resolve) { calls.push({ table }); return resolve({ data: row, error }); }
      };
      return builder;
    }
  };
}

test('the real store REPORTS a failed lookup instead of reporting "no such invitation"', async () => {
  // A swallowed error here is the worst possible shape. lookup() returning null
  // on a transport failure means confirmOptInInvite sees "unknown token", and on
  // the decline path that turns a database blip into a permanent, silent 404 for
  // somebody trying to withdraw.
  const store = createSmsOptInInviteStore({
    client: fakeSupabase({ error: { code: '08006', message: 'connection refused' } })
  });

  await assert.rejects(() => store.lookup('a'.repeat(64)), error => {
    assert.equal(error.code, 'OPTIN_INVITE_LOOKUP_FAILED');
    return true;
  });
});

test('the real store returns null only when the token genuinely matches no row', async () => {
  const store = createSmsOptInInviteStore({ client: fakeSupabase({ row: null, error: null }) });
  assert.equal(await store.lookup('a'.repeat(64)), null);

  const found = createSmsOptInInviteStore({
    client: fakeSupabase({ row: { id: 'uuid', contact_phone: PHONE }, error: null })
  });
  assert.deepEqual(await found.lookup('a'.repeat(64)), { id: 'uuid', contact_phone: PHONE });
});

test('the real store selects the columns the opt-out ordering depends on', async () => {
  // lookup() exists so the ledger can be written before the invitation row is
  // claimed. Without contact_phone there is nothing to write the withdrawal
  // against, and the whole ordering collapses back to claim-first.
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'campaigns', 'sms-optin-invite.js'), 'utf8');
  const select = source.match(/\.select\('(id, workspace_id, contact_phone[^']*)'\)/);
  assert.ok(select, 'store.lookup no longer selects an explicit column list');
  for (const column of ['id', 'workspace_id', 'contact_phone', 'campaign_ref',
    'expires_at', 'cancelled_at', 'responded_at', 'response']) {
    assert.ok(select[1].includes(column), `lookup no longer reads ${column}`);
  }
});

test('the real store surfaces a failed open and a failed claim rather than inventing a result', async () => {
  const failing = () => ({ data: null, error: { code: '08006', message: 'connection refused' } });

  const openStore = createSmsOptInInviteStore({ client: fakeSupabase({ rpc: failing }) });
  await assert.rejects(
    () => openStore.open({
      workspace: 'vici', phone: PHONE, email: null, tokenHash: 'a'.repeat(64),
      tokenPrefix: 'a'.repeat(8), expiresAt: expiryFrom(), campaignRef: CAMPAIGN_REF
    }),
    error => { assert.equal(error.code, 'OPTIN_INVITE_OPEN_FAILED'); return true; });

  const claimStore = createSmsOptInInviteStore({ client: fakeSupabase({ rpc: failing }) });
  await assert.rejects(
    () => claimStore.claim({ tokenHash: 'a'.repeat(64), response: 'opt_in', ip: null, userAgent: null }),
    error => { assert.equal(error.code, 'OPTIN_INVITE_CLAIM_FAILED'); return true; });
});

test('the real store calls the two RPCs by the names the migration defines', async () => {
  const client = fakeSupabase({ rpc: () => ({ data: 'uuid', error: null }) });
  const store = createSmsOptInInviteStore({ client });

  await store.open({
    workspace: 'vici', phone: PHONE, email: 'a@example.com', tokenHash: 'a'.repeat(64),
    tokenPrefix: 'a'.repeat(8), expiresAt: expiryFrom(), campaignRef: CAMPAIGN_REF
  });
  await store.claim({ tokenHash: 'a'.repeat(64), response: 'opt_out', ip: null, userAgent: null });

  assert.deepEqual(client.calls.map(call => call.rpc),
    ['open_sms_optin_invitation', 'claim_sms_optin_invitation']);

  const sql = fs.readFileSync(path.join(ROOT, 'scripts', 'sms-optin-migration.sql'), 'utf8');
  for (const call of client.calls) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${call.rpc}\\(`),
      `${call.rpc} is called but not defined by the migration`);
  }
  // The raw token is never an argument to either.
  const args = JSON.stringify(client.calls.map(call => call.args));
  assert.equal(args.includes('p_token'), true);
  assert.match(args, /"p_token_hash":"a{64}"/);
});

// ── THE WRITE ORDER, WHICH IS THE WHOLE OPT-OUT ARGUMENT ───────────────────
//
// The invitation row and the consent ledger are two round trips and the second
// one can be lost. These tests pin WHICH one is second, per direction, because
// that single decision is the difference between a recoverable inconvenience
// and a refusal that disappears while the customer is told not to worry.

test('a decline writes the consent ledger BEFORE it touches the invitation row', async () => {
  const context = await seedInvitation();
  const order = [];

  const realClaim = context.store.claim.bind(context.store);
  context.store.claim = args => { order.push('claim'); return realClaim(args); };
  const realFrom = context.consent.from.bind(context.consent);
  context.consent.from = table => {
    const handle = realFrom(table);
    if (table !== 'sms_consent_events' || typeof handle.insert !== 'function') return handle;
    const realInsert = handle.insert.bind(handle);
    return { ...handle, insert(row) { order.push('ledger'); return realInsert(row); } };
  };

  const result = await answer(context, RESPONSES.OPT_OUT);
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['ledger', 'claim'],
    'the withdrawal must be durable before the invitation row is stamped');
});

test('a confirm writes the invitation row BEFORE the consent ledger', async () => {
  const context = await seedInvitation();
  const order = [];

  const realClaim = context.store.claim.bind(context.store);
  context.store.claim = args => { order.push('claim'); return realClaim(args); };
  const realFrom = context.consent.from.bind(context.consent);
  context.consent.from = table => {
    const handle = realFrom(table);
    if (table !== 'sms_consent_events' || typeof handle.insert !== 'function') return handle;
    const realInsert = handle.insert.bind(handle);
    return { ...handle, insert(row) { order.push('ledger'); return realInsert(row); } };
  };

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, true);
  // The opposite order, on purpose: losing the ledger write on a YES suppresses,
  // which is the safe direction.
  assert.deepEqual(order, ['claim', 'ledger']);
});

test('a recorded NO survives the invitation row failing to stamp', async () => {
  const context = await seedInvitation();
  context.store.state.failWith = 'claim';

  const result = await answer(context, RESPONSES.OPT_OUT);

  // The withdrawal is in the only storage the send path reads, so the customer
  // is told the truth: it is recorded.
  assert.equal(result.ok, true);
  assert.equal(result.invitationStamped, false);
  assert.equal(context.consent.optOuts().length, 1,
    'the withdrawal was lost when the invitation row failed');
  assert.equal(context.consent.optOuts()[0].contact_phone, PHONE);
});

test('a decline whose ledger write fails claims NOTHING, so "nothing recorded" is true', async () => {
  const context = await seedInvitation();
  context.consent.state.failNext = true;

  const result = await answer(context, RESPONSES.OPT_OUT);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_RECORD_FAILED');
  assert.match(result.message, /Nothing has been recorded/);
  // The promise that message makes, asserted rather than assumed.
  assert.equal(context.consent.state.rows.length, 0);
  assert.equal(context.store.state.invitations[0].responded_at, null,
    'the invitation was committed as declined while the customer was told nothing was saved');
  assert.equal(context.store.state.invitations[0].response, null);

  // And the retry repairs it completely.
  const retry = await answer(context, RESPONSES.OPT_OUT);
  assert.equal(retry.ok, true);
  assert.equal(context.consent.optOuts().length, 1);
  assert.equal(context.store.state.invitations[0].response, 'opt_out');
});

test('a decline the ledger REFUSES is reported as a failure, not as a success', async () => {
  const context = await seedInvitation();
  // recordOptOut returns { recorded: false } rather than throwing when the phone
  // is not E.164. The claim is the only source of the phone, so this is what a
  // corrupted invitation row looks like from here.
  context.store.lookup = async () => ({
    id: context.issued.invitationId,
    workspace_id: 'vici',
    contact_phone: 'not-a-phone',
    campaign_ref: CAMPAIGN_REF,
    expires_at: context.issued.expiresAt,
    cancelled_at: null,
    responded_at: null,
    response: null
  });

  const result = await answer(context, RESPONSES.OPT_OUT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_RECORD_FAILED');
  assert.equal(context.consent.state.rows.length, 0);
});

test('a confirm the ledger REFUSES is never reported as a subscription', async () => {
  // Guards lib/campaigns/sms-optin-invite.js's `written.recorded !== true`
  // branch. Deleting it makes confirmOptInInvite answer { ok: true } with an
  // EMPTY ledger: the page says "You are subscribed", nothing is on file, and
  // the send path suppresses the person forever with no explanation. Every other
  // storage-failure test drives the throwing path, so this branch had no cover
  // at all and survived being replaced with `if (false)`.
  const context = await seedInvitation();
  context.store.claim = async () => ({
    invitation_id: context.issued.invitationId,
    workspace_id: 'vici',
    // recordOptIn returns { recorded: false, reason: 'invalid_phone' } for this.
    contact_phone: '5551234',
    campaign_ref: CAMPAIGN_REF,
    response: 'opt_in',
    newly_recorded: true
  });

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, false, 'a refused consent write was reported as a subscription');
  assert.equal(result.code, 'OPTIN_NOT_CONFIRMED');
  assert.equal(result.status, 503);
  assert.equal(context.consent.optIns().length, 0);
});

// ── AN EMAILED LINK CANNOT UNDO A STOP ─────────────────────────────────────
//
// An invitation is minted days or weeks before it is answered. Everything below
// is the gap in between.

/** The four places a withdrawal can live, one fixture each. */
const WITHDRAWALS = {
  consent_ledger_opt_out(consent, phone) {
    consent.state.rows.push({
      id: 1,
      workspace_id: 'vici',
      brand_id: 'vici',
      purpose: 'promotional_sms',
      contact_phone: phone,
      event_type: 'opt_out',
      source: 'inbound_sms_stop',
      occurred_at: '2026-08-20T10:00:00.000Z'
    });
  },
  stop_sentinel(consent, phone) {
    consent.state.sentLog.push({ id: 7, phone, flow_type: 'opted-out' });
  },
  authoritative_suppression(consent, phone) {
    consent.state.suppressions.push({
      workspace_id: 'vici',
      contact_phone: phone,
      reason_code: 'complaint',
      active: true,
      effective_at: '2026-01-01T00:00:00.000Z',
      expires_at: null
    });
  },
  contact_opted_out(consent, phone) {
    consent.state.contacts.push({ phone, opted_out: true, ghl_dnd: false, ghl_sms_dnd_status: 'inactive' });
  },
  // Two separate fixtures, because a single one that set BOTH fields let either
  // check be deleted without a test noticing.
  dnd(consent, phone) {
    consent.state.contacts.push({ phone, opted_out: false, ghl_dnd: true, ghl_sms_dnd_status: 'inactive' });
  },
  dnd_status_only(consent, phone) {
    consent.state.contacts.push({ phone, opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'active' });
  }
};

/** `dnd_status_only` is a fixture name; the reason the code reports is 'dnd'. */
const WITHDRAWAL_REASONS = { dnd_status_only: 'dnd' };

for (const [reason, seed] of Object.entries(WITHDRAWALS)) {
  test(`no invitation is minted for a number withdrawn by ${reason}`, async () => {
    const consent = fakeConsentClient();
    const store = fakeInviteStore(consent);
    seed(consent, PHONE);

    const issued = await issueOptInInvite({
      store, phone: PHONE, email: 'customer@example.com', campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL
    });

    assert.equal(issued.issued, false);
    assert.equal(issued.reason, 'withdrawn');
    assert.equal(issued.withdrawalReason, WITHDRAWAL_REASONS[reason] || reason);
    assert.equal(store.state.invitations.length, 0, 'a withdrawn number was invited anyway');
    // Not even a token was generated for them.
    assert.equal(store.state.written.length, 0);
  });

  test(`a live invitation cannot be confirmed after a ${reason} arrives`, async () => {
    // Day 0: minted while the number is perfectly clean.
    const context = await seedInvitation();
    assert.equal(context.issued.issued, true);

    // Day 1: the withdrawal lands.
    seed(context.consent, PHONE);

    // Day 5: they press "Yes, text me" in the email from day 0.
    const result = await answer(context, RESPONSES.OPT_IN);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'OPTIN_WITHDRAWN');
    assert.equal(result.status, 409);
    assert.equal(context.consent.optIns().length, 0,
      'an emailed link wrote an opt_in on top of a withdrawal');
    // And the invitation was not spent, so nothing about the row implies a yes.
    assert.equal(context.store.state.invitations[0].response, null);
  });
}

test('a later opt_in in the ledger un-withdraws a number, because a fresh act outranks an old STOP', async () => {
  const consent = fakeConsentClient();
  const store = fakeInviteStore(consent);
  consent.state.rows.push(
    { id: 1, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms', contact_phone: PHONE,
      event_type: 'opt_out', source: 'inbound_sms_stop', occurred_at: '2026-08-01T10:00:00.000Z' },
    { id: 2, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms', contact_phone: PHONE,
      event_type: 'opt_in', source: 'inbound_sms_start', evidence_ref: 'sms:1', occurred_at: '2026-08-10T10:00:00.000Z' }
  );

  const issued = await issueOptInInvite({
    store, phone: PHONE, campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL
  });
  assert.equal(issued.issued, true, 'the latest event wins, and the latest event is a START');
});

test('a withdrawal state that cannot be READ refuses the mint and refuses the yes', async () => {
  const context = await seedInvitation();

  // Minting: "we could not tell" is not "they have not said no".
  context.consent.state.readFailure = 'sms_sent_log';
  const issued = await issueOptInInvite({
    store: context.store, phone: '+14155550188', campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL
  });
  assert.equal(issued.issued, false);
  assert.equal(issued.reason, 'withdrawal_check_failed');

  // Confirming: refused before the claim, so "nothing has been recorded" is true.
  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_RECORD_FAILED');
  assert.match(result.message, /Nothing has been recorded/);
  assert.equal(context.store.state.invitations[0].responded_at, null);
  assert.equal(context.consent.state.rows.length, 0);
});

test('a withdrawal read that THROWS is not permission either', async () => {
  // Distinct from a query that resolves with an error. A Supabase builder is a
  // thenable with no .catch(), so a failure can surface either way, and each has
  // its own guard in activeWithdrawalReason. Modelling only one of them let the
  // other be deleted with every test still green.
  const context = await seedInvitation();
  context.consent.state.throwOnRead = true;

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OPTIN_RECORD_FAILED');
  assert.equal(context.consent.optIns().length, 0);
  assert.equal(context.store.state.invitations[0].responded_at, null);

  const issued = await issueOptInInvite({
    store: context.store, phone: '+14155550199', campaignRef: CAMPAIGN_REF, baseUrl: BASE_URL
  });
  assert.equal(issued.reason, 'withdrawal_check_failed');

  // And a refusal still gets through, because it never runs this check.
  context.consent.state.throwOnRead = false;
  assert.equal((await answer(context, RESPONSES.OPT_OUT)).ok, true);
});

test('a withdrawal NEVER blocks a decline, even when the state cannot be read', async () => {
  const context = await seedInvitation();
  WITHDRAWALS.stop_sentinel(context.consent, PHONE);
  context.consent.state.readFailure = 'sms_contacts';

  const result = await answer(context, RESPONSES.OPT_OUT);
  assert.equal(result.ok, true, 'a refusal was made conditional on a read succeeding');
  assert.equal(context.consent.optOuts().length, 1);
});

test('the withdrawal refusal has a backstop for when the snapshot and the claim disagree', async () => {
  // The pre-claim refusal is gated on an advisory snapshot judged against the
  // Node clock. If that snapshot says "not answerable" and the database
  // disagrees, the claim succeeds and the only thing standing between a
  // withdrawn number and an opt_in is the post-claim check.
  const context = await seedInvitation();
  WITHDRAWALS.consent_ledger_opt_out(context.consent, PHONE);

  const real = context.store.lookup.bind(context.store);
  context.store.lookup = async hash => {
    const row = await real(hash);
    // Node believes it expired last year. The claim will not agree.
    return row ? { ...row, expires_at: '2025-01-01T00:00:00.000Z' } : row;
  };

  const result = await answer(context, RESPONSES.OPT_IN);
  assert.equal(result.code, 'OPTIN_WITHDRAWN');
  assert.equal(context.consent.optIns().length, 0,
    'the post-claim backstop is gone: an opt_in was written over a withdrawal');
});

test('a store that cannot look an invitation up writes no consent in either direction', async () => {
  const context = await seedInvitation();
  const withoutLookup = { ...context.store, lookup: undefined };

  for (const response of [RESPONSES.OPT_IN, RESPONSES.OPT_OUT]) {
    const result = await confirmOptInInvite({
      store: withoutLookup,
      consentClient: context.consent,
      token: context.token,
      response
    });
    assert.equal(result.ok, false, response);
    assert.equal(result.code, 'OPTIN_RECORD_FAILED', response);
  }
  assert.equal(context.consent.state.rows.length, 0);
  assert.equal(context.store.state.invitations[0].responded_at, null);
});

// ── THE ANSWER IS VALIDATED AGAINST A CLOSED SET ───────────────────────────

test('anything that is not exactly opt_in or opt_out is refused, not defaulted to a YES', async () => {
  // `input.response === 'opt_out' ? OPT_OUT : OPT_IN` turned every one of these
  // into an OPT-IN and made the SQL guard unreachable, because Node coerced
  // first. A fail-open default on the consent-CREATING direction.
  const rejected = [
    'decline', 'no', 'OPT_OUT', 'Opt_Out', ' opt_out', 'opt_out ', 'optout',
    'opt-in', '', undefined, null, 0, 1, true, false, {}, [], ['opt_out']
  ];

  for (const response of rejected) {
    const context = await seedInvitation();
    const result = await confirmOptInInvite({
      store: context.store,
      consentClient: context.consent,
      token: context.token,
      response
    });

    const label = JSON.stringify(response) || String(response);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'OPTIN_NOT_VALID', label);
    assert.equal(context.consent.state.rows.length, 0, `${label} wrote to the consent ledger`);
    assert.equal(context.store.state.invitations[0].responded_at, null,
      `${label} spent the invitation`);
  }
});

test('the two accepted answers are exactly the two RESPONSES values', async () => {
  assert.deepEqual(Object.values(RESPONSES).sort(), ['opt_in', 'opt_out']);
  for (const response of Object.values(RESPONSES)) {
    const context = await seedInvitation();
    const result = await confirmOptInInvite({
      store: context.store, consentClient: context.consent, token: context.token, response
    });
    assert.equal(result.ok, true, response);
  }
});

// ── EVIDENCE THAT DOES NOT CONTRADICT ITSELF ───────────────────────────────

test('a change of mind does not overwrite the answer the opt_in evidence points at', async () => {
  const context = await seedInvitation();

  await answer(context, RESPONSES.OPT_IN, {
    ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone; the confirming device)'
  });
  await answer(context, RESPONSES.OPT_OUT, {
    ip: '198.51.100.4', userAgent: 'Mozilla/5.0 (Macintosh; the declining device)'
  });

  const invitation = context.store.state.invitations[0];

  // What stands today.
  assert.equal(invitation.response, 'opt_out');
  assert.equal(invitation.responded_ip, '198.51.100.4');

  // What the opt_in consent event's evidence_ref must still resolve to. Without
  // these columns an auditor following `sms_optin_invite:<id>` from an opt_in
  // row lands on a record saying opt_out, dated later, from the DECLINING
  // device, and concludes the ledger is wrong.
  assert.equal(invitation.first_response, 'opt_in');
  assert.equal(invitation.first_responded_ip, '203.0.113.9');
  assert.match(invitation.first_responded_user_agent, /confirming device/);
  assert.ok(invitation.first_responded_at <= invitation.responded_at);

  // Both ledger rows exist and each carries its own click's evidence, so a
  // single row is defensible without resolving anything at all.
  assert.equal(context.consent.optIns()[0].metadata.ip, '203.0.113.9');
  assert.equal(context.consent.optOuts()[0].metadata.ip, '198.51.100.4');
});

test('the first answer is immutable even when it was a no', async () => {
  const context = await seedInvitation();
  await answer(context, RESPONSES.OPT_OUT, { ip: '198.51.100.4' });
  await answer(context, RESPONSES.OPT_OUT, { ip: '198.51.100.77' });

  const invitation = context.store.state.invitations[0];
  assert.equal(invitation.first_response, 'opt_out');
  assert.equal(invitation.first_responded_ip, '198.51.100.4',
    'a repeat press rewrote the first answer');
});

// ── THE SOURCE A WITHDRAWAL IS FILED UNDER ─────────────────────────────────

test('a decline is filed under its own source, not under one that says "confirmed"', async () => {
  assert.equal(DECLINE_SOURCE_VALUE, 'email_invite_declined_link');
  assert.notEqual(DECLINE_SOURCE, CONFIRM_SOURCE);
  assert.equal(CONFIRM_SOURCE, SOURCE.CONFIRMED_INVITE);

  // lib/campaigns/consent.js is owned elsewhere, so this module falls back to
  // the literal until SOURCE.INVITE_DECLINED lands there. The moment it does,
  // it must be this value or this assertion fails and the two cannot drift.
  assert.equal(
    SOURCE.INVITE_DECLINED === undefined || SOURCE.INVITE_DECLINED === DECLINE_SOURCE_VALUE,
    true,
    'SOURCE.INVITE_DECLINED disagrees with the value this module writes'
  );
  assert.equal(DECLINE_SOURCE, SOURCE.INVITE_DECLINED || DECLINE_SOURCE_VALUE);
});

// ── The HTTP surface ───────────────────────────────────────────────────────

function buildApp(context) {
  const app = express();
  app.set('case sensitive routing', true);
  app.use(express.json());
  app.use('/sms-optin', createSmsOptInRouter({
    store: context.store,
    consentClient: context.consent,
    // Rate limiting is real in production; a limiter here would make the test
    // order-dependent and would be testing express-rate-limit rather than this.
    limiter: (_req, _res, next) => next()
  }));
  app.get('/{*splat}', (_req, res) => res.status(200).send('SPA_INDEX_HTML'));
  return app;
}

async function request(app, pathname, { method = 'GET', body } = {}) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* the page is HTML */ }
    return { status: response.status, text, json, headers: response.headers };
  } finally {
    server.close();
  }
}

test('GET /sms-optin serves the page and records NOTHING', async () => {
  const context = await seedInvitation();
  const app = buildApp(context);

  // A mail scanner following the link, token and all, within seconds of
  // delivery. This is the single most likely way to manufacture false consent.
  const response = await request(app, `/sms-optin?token=${encodeURIComponent(context.token)}`);

  assert.equal(response.status, 200);
  assert.match(response.text, /Would you like order offers by text\?/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(context.consent.state.rows.length, 0, 'opening the page created consent');
  assert.equal(context.store.state.invitations[0].responded_at, null,
    'opening the page answered the invitation');
});

test('the served page never contains the token', async () => {
  const context = await seedInvitation();
  const response = await request(buildApp(context), `/sms-optin?token=${encodeURIComponent(context.token)}`);
  assert.equal(response.text.includes(context.token), false);
});

test('POST /sms-optin/confirm records the opt_in and answers JSON', async () => {
  const context = await seedInvitation();
  const response = await request(buildApp(context), '/sms-optin/confirm', {
    method: 'POST', body: { token: context.token }
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.success, true);
  assert.equal(response.json.response, 'opt_in');
  assert.equal(context.consent.optIns().length, 1);
});

test('POST /sms-optin/decline records the opt_out', async () => {
  const context = await seedInvitation();
  const response = await request(buildApp(context), '/sms-optin/decline', {
    method: 'POST', body: { token: context.token }
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.response, 'opt_out');
  assert.equal(context.consent.optOuts().length, 1);
});

test('an unknown token over HTTP answers 404 and the generic message', async () => {
  const context = await seedInvitation();
  const response = await request(buildApp(context), '/sms-optin/confirm', {
    method: 'POST', body: { token: generateToken() }
  });

  assert.equal(response.status, 404);
  assert.equal(response.json.code, 'OPTIN_NOT_VALID');
  assert.equal(response.json.error, GENERIC_LINK_MESSAGE);
  // Exactly two keys. Anything else in this body is a channel for the endpoint
  // to say more about the token than "no", which is the whole thing being
  // avoided.
  assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error']);
  assert.equal(context.consent.state.rows.length, 0);
});

test('the endpoints need no session and never mention one', async () => {
  const context = await seedInvitation();
  const app = buildApp(context);
  // No cookie is sent by `request`, and nothing 401s.
  const page = await request(app, '/sms-optin');
  const post = await request(app, '/sms-optin/confirm', { method: 'POST', body: { token: context.token } });
  assert.equal(page.status, 200);
  assert.equal(post.status, 200);
});

// ── RATE LIMITING: YOU MAY THROTTLE A YES, YOU MAY NOT THROTTLE A NO ───────

/**
 * A router with its REAL limiters, so these tests measure production defaults
 * rather than a test double. One server for the whole run, because 60-odd
 * requests each opening and closing a listener is slow and proves nothing extra.
 */
function buildRateLimitedApp(context) {
  const app = express();
  app.set('case sensitive routing', true);
  app.use(express.json());
  app.use('/sms-optin', createSmsOptInRouter({
    store: context.store,
    consentClient: context.consent
  }));
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await run(async (pathname, body) => {
      let response;
      try {
        response = await fetch(base + pathname, {
          method: 'POST',
          // No socket reuse. These tests fire dozens of requests in a row at a
          // server that is closed immediately afterwards, and a pooled
          // connection surviving into the next test turns a rate-limit
          // assertion into an intermittent transport error that reads like a
          // limiter bug.
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          body: JSON.stringify(body)
        });
      } catch (error) {
        // Never let a transport failure quietly become a status that happens to
        // satisfy the assertion.
        throw new Error(`request to ${pathname} did not complete: ${error.message}`);
      }
      let json = null;
      try { json = JSON.parse(await response.text()); } catch { /* not JSON */ }
      return { status: response.status, json };
    });
  } finally {
    server.close();
  }
}

test('the withdrawal endpoint does not spend the confirmation endpoint\'s budget', async () => {
  const context = await seedInvitation();

  await withServer(buildRateLimitedApp(context), async post => {
    // One IP, which behind a corporate NAT or a CGNAT range is an entire office
    // or an entire carrier. The thirty-first person to press "No thanks" used to
    // get a 429 and their withdrawal was never recorded.
    const statuses = [];
    for (let i = 0; i < CONFIRM_MAX + 5; i += 1) {
      statuses.push((await post('/sms-optin/decline', { token: generateToken() })).status);
    }
    assert.equal(statuses.includes(429), false,
      `a decline was rate limited after ${statuses.indexOf(429)} attempts from one address`);

    // The confirmation budget is untouched by all of that, and is still the
    // tight one.
    const confirms = [];
    for (let i = 0; i < CONFIRM_MAX + 1; i += 1) {
      confirms.push((await post('/sms-optin/confirm', { token: generateToken() })).status);
    }
    assert.equal(confirms.filter(status => status !== 429).length, CONFIRM_MAX,
      `the confirmation limiter let through the wrong number of requests: ${confirms.join(',')}`);
    assert.equal(confirms[CONFIRM_MAX], 429, 'the confirmation limiter is not enforcing at all');
  });
});

test('a real withdrawal still records itself well past the confirmation limit', async () => {
  const context = await seedInvitation();

  await withServer(buildRateLimitedApp(context), async post => {
    for (let i = 0; i < CONFIRM_MAX + 2; i += 1) {
      await post('/sms-optin/decline', { token: generateToken() });
    }
    // The genuine one, arriving after the shared address has already burned far
    // more than the confirmation allowance.
    const result = await post('/sms-optin/decline', { token: context.token });
    assert.equal(result.status, 200);
    assert.equal(result.json.response, 'opt_out');
  });

  assert.equal(context.consent.optOuts().length, 1);
});

test('the two budgets are separate constants and the decline one is far larger', () => {
  assert.equal(typeof CONFIRM_MAX, 'number');
  assert.equal(typeof DECLINE_MAX, 'number');
  assert.ok(DECLINE_MAX >= CONFIRM_MAX * 100,
    'the withdrawal budget must be orders of magnitude larger, not merely larger');

  const source = fs.readFileSync(path.join(ROOT, 'routes', 'sms-optin.js'), 'utf8');
  // Two rateLimit() constructions means two independent stores. One shared
  // limiter is the defect, and it is invisible in behaviour until the window
  // fills up.
  assert.equal((source.match(/rateLimit\(\{/g) || []).length, 2,
    'confirm and decline must not share a limiter instance');
  assert.match(source, /router\.post\('\/confirm', confirmLimiter/);
  assert.match(source, /router\.post\('\/decline', declineLimiter/);
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test('server.js mounts /sms-optin before express.static and the catch-all', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
    // Comments mention these lines; measure the code, not the prose.
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

  const mount = source.indexOf("app.use('/sms-optin'");
  const staticMount = source.indexOf('app.use(express.static(');
  const catchAll = source.indexOf("app.get('/{*splat}'");

  assert.ok(mount > 0, '/sms-optin is not mounted in server.js');
  assert.ok(mount < staticMount, '/sms-optin must be mounted before express.static');
  assert.ok(mount < catchAll, '/sms-optin must be mounted before the SPA catch-all');
});

test('the opt-in paths are OUTSIDE /api and absent from the policy table', () => {
  const { ROUTE_POLICY } = require('../lib/route-policy');
  const offenders = ROUTE_POLICY.filter(entry => entry.path.includes('sms-optin'));
  assert.deepEqual(offenders, [],
    'a /sms-optin entry in the policy table is dangling: the router is mounted outside /api');

  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.equal(source.includes("app.use('/api/sms-optin'"), false,
    'the opt-in router must not be mounted under /api, where it would demand a session');
});

test('the migration is transactional, re-runnable, and closes the table down', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'sms-optin-migration.sql'), 'utf8');
  // The header prose names these constructs while explaining them. Count the
  // statements, not the commentary about them.
  const sql = raw.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sms_optin_invitations/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS sms_optin_invitations_one_open_per_phone_idx/);
  assert.match(sql, /ALTER TABLE sms_optin_invitations ENABLE ROW LEVEL SECURITY/);

  // Every function is SECURITY DEFINER with a pinned search_path, and is
  // revoked from the browser-reachable roles before it is granted to anybody.
  const definers = sql.match(/SECURITY DEFINER/g) || [];
  assert.equal(definers.length, 2);
  assert.equal((sql.match(/SET search_path = ''/g) || []).length, 2);
  for (const role of ['PUBLIC', 'anon', 'authenticated']) {
    assert.ok(sql.includes(`FROM ${role}`), `nothing is revoked from ${role}`);
  }
  assert.equal(sql.includes('GRANT EXECUTE ON FUNCTION open_sms_optin_invitation'), true);
  assert.equal(sql.includes('GRANT EXECUTE ON FUNCTION claim_sms_optin_invitation'), true);
  assert.equal(/GRANT EXECUTE[^;]*TO (anon|authenticated|PUBLIC)/.test(sql), false,
    'a SECURITY DEFINER consent function is executable by an anonymous key');

  // The claim function must serialise, or the concurrency guarantee is prose.
  assert.match(sql, /FOR UPDATE/);

  // EXPIRY AND THE OPT-OUT ASYMMETRY LIVE IN SQL, NOT IN NODE.
  //
  // The tests above prove the Node layer refuses correctly when the claim
  // raises, but the rule itself — 30 days, checked against now(), and skipped
  // for a withdrawal — is enforced by claim_sms_optin_invitation, which no
  // offline test can execute. These assertions are the only guard that exists
  // against somebody deleting it, so they are deliberately specific about the
  // shape of the branch rather than just its presence.
  assert.match(sql, /IF NOT v_is_opt_out THEN/,
    'the expiry and cancellation checks must be skipped for an opt_out');
  assert.match(sql, /invite\.expires_at <= now\(\)/,
    'expiry must be checked against the database clock, not a value from the caller');
  assert.match(sql, /RAISE EXCEPTION 'OPTIN_EXPIRED'/);
  assert.match(sql, /RAISE EXCEPTION 'OPTIN_ALREADY_DECLINED'/);
  // Unknown and superseded must raise the SAME code, or the endpoint becomes
  // an oracle for whether a number has ever been invited.
  assert.equal((sql.match(/RAISE EXCEPTION 'OPTIN_NOT_VALID'/g) || []).length, 3);

  // THE FIRST ANSWER IS APPEND-ONLY.
  //
  // Confirm-then-decline used to overwrite response, responded_at, responded_ip
  // and responded_user_agent in place, which left the opt_in event's
  // evidence_ref resolving to a row that said 'opt_out', dated later, carrying
  // the declining device's address. No offline test can execute plpgsql, so
  // these assertions are the only guard on the shape of that UPDATE.
  for (const column of ['first_response', 'first_responded_at', 'first_responded_ip',
    'first_responded_user_agent']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`),
      `${column} is not added on the re-run path`);
  }
  assert.match(sql, /first_response = coalesce\(invite\.first_response, p_response\)/,
    'the first answer must be preserved by coalesce, never reassigned');
  assert.match(sql, /first_responded_at = coalesce\(invite\.first_responded_at, now\(\)\)/);
  // The IP and user agent of the FIRST device, kept only when there was no
  // first answer yet. A plain assignment here silently reintroduces the bug.
  assert.match(sql, /WHEN invite\.first_responded_at IS NULL[\s\S]{0,200}ELSE invite\.first_responded_ip/);
  assert.match(sql, /WHEN invite\.first_responded_at IS NULL[\s\S]{0,200}ELSE invite\.first_responded_user_agent/);
  assert.match(sql, /sms_optin_invitations_first_response_paired/);
  assert.match(sql, /sms_optin_invitations_first_response_ordered/);

  // Re-runnable against an instance where the table already exists: the guarded
  // DO block, and a backfill that only touches rows with no first answer.
  assert.match(sql, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
  assert.match(sql, /WHERE responded_at IS NOT NULL\s*\n\s*AND first_responded_at IS NULL/);
});

test('the invitation flow is documented where CONSENT-CAPTURE.md says it is', () => {
  const doc = path.join(ROOT, 'docs', 'campaigns', 'SMS-OPTIN-INVITE.md');
  assert.equal(fs.existsSync(doc), true,
    'docs/campaigns/CONSENT-CAPTURE.md points at SMS-OPTIN-INVITE.md, which must exist');

  const text = fs.readFileSync(doc, 'utf8');
  // The two things a reader must not be able to miss.
  assert.match(text, /staged/i);
  assert.match(text, /scripts\/sms-optin-migration\.sql/);
  assert.match(text, /scripts\/send-sms-optin-invites\.js/);
  // No em dashes: standing rule in this repository.
  assert.equal(text.includes('\u2014'), false);
});

test('AGENTS.md carries the apply-before-deploy note for the invitation migration', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(agents, /scripts\/sms-optin-migration\.sql/,
    'every migration in this repository has an apply-before-deploy note; this one must too');
});

// ── THE THING THAT MINTS INVITATIONS ───────────────────────────────────────
//
// Until scripts/send-sms-optin-invites.js existed, issueOptInInvite() and
// smsOptInInviteEmail() had NO caller outside this file. No route, no cron, no
// script opened an invitation, so POST /sms-optin/confirm could only ever
// answer 404 and the whole capability was unreachable code that looked
// finished. These tests are about the script's refusals, because a send script
// that is easy to run by accident is a worse defect than one that is missing.

const sendScript = require('../scripts/send-sms-optin-invites');

test('the invitation script is dry run by default and needs two flags to write', () => {
  const { parseArgs } = sendScript;

  assert.equal(parseArgs(['--campaign-ref=x']).commit, false);
  assert.equal(parseArgs(['--campaign-ref=x']).mailingApproved, false);
  // Either flag alone is a mismatch, which main() refuses on. The same shape as
  // scripts/backfill-order-sms-consent.js.
  const commitOnly = parseArgs(['--campaign-ref=x', '--commit']);
  assert.notEqual(commitOnly.commit, commitOnly.mailingApproved);
  const approvedOnly = parseArgs(['--campaign-ref=x', '--mailing-approved']);
  assert.notEqual(approvedOnly.commit, approvedOnly.mailingApproved);
  const both = parseArgs(['--campaign-ref=x', '--commit', '--mailing-approved']);
  assert.equal(both.commit, both.mailingApproved);
  // --dry-run always wins over an earlier --commit.
  assert.equal(parseArgs(['--commit', '--dry-run']).commit, false);
  assert.equal(parseArgs(['--nope']).unknown.length, 1);

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'send-sms-optin-invites.js'), 'utf8');
  assert.match(source, /flags\.commit !== flags\.mailingApproved/,
    'the two-flag guard is gone');
  // Committing without a destination file would put live consent tokens on
  // stdout, in a terminal scrollback and in any CI log that captured it.
  assert.match(source, /if \(!flags\.out\) \{\n\s*return \{ willWrite: false, error: 'out_path_required' \};/);
  assert.match(source, /mode: 0o600, flag: 'wx'/,
    'the handover file must be private and must not silently overwrite');
  // It renders. It does not send.
  assert.equal(/sendEmail|sendMail|transporter|maton/i.test(source), false,
    'this script must not acquire a mailer; the agency sends the email');
});

test('the mailing script reads no source without the ceiling abort', () => {
  // A shape guard, in the spirit of test/no-builder-catch.test.js and the
  // matching one in test/backfill-order-sms-consent.test.js: the property is
  // about a call SITE, and a behavioural test of one call site cannot stop the
  // next one being added without the flag.
  //
  // fetchAllRows() warns and returns a TRUNCATED array at its ceiling by
  // default. This script reads ABSENCE AS PERMISSION, so a silently truncated
  // read of sms_consent_events, sms_contacts or sms_campaign_suppressions does
  // not produce a smaller mailing. It produces one that emails a marketing
  // permission request to people who have already withdrawn, which is a
  // violation before anybody clicks anything.
  const file = path.join(ROOT, 'scripts', 'send-sms-optin-invites.js');
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
      `a fetchAllRows call in the mailing script omits throwOnCeiling: true:\n${args}`);
  }

  // And every source goes through the single `paged()` helper, so the flag
  // cannot be forgotten when a fifth source is added next to the other four.
  assert.match(source, /const paged = \(table, columns, orderBy, ascending = true\) =>/);
  assert.equal(calls.length, 1,
    'a source is read outside paged(), where the ceiling abort can be omitted');
});

test('a truncated withdrawal source aborts the run instead of shrinking it', async () => {
  // The behaviour behind the shape guard, proven against fetchAllRows itself.
  // A run that reads 3000 of N withdrawal rows must not continue.
  let served = 0;
  // Shaped like a Supabase builder: chainable, and a thenable with `then` only.
  const client = {
    from() {
      let window = [0, 0];
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range(from, to) { window = [from, to]; return builder; },
        then(resolve) {
          const [from, to] = window;
          served += 1;
          // Always a full page, so paging never terminates before the ceiling.
          return resolve({
            data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
            error: null
          });
        }
      };
      return builder;
    }
  };

  await assert.rejects(
    () => fetchAllRows(client, 'sms_consent_events', 'id',
      { orderBy: 'id', maxRows: PAGE_SIZE * 3, throwOnCeiling: true }),
    /sms_consent_events exceeded the 3000-row ceiling/,
    'a partial view of who has withdrawn was returned instead of aborting');
  assert.equal(served, 3, 'the ceiling is reached by paging, not by a short read');
});

test('exactly one flag combination writes, and everything else is a dry run', () => {
  // BEHAVIOURAL, not a shape assertion. This decision used to live inline in
  // main(), where the only thing a test could reach was the guard's source
  // text, and a source-position check cannot tell `if (!willWrite)` from
  // `if (willWrite === 'never')`. The second one mints invitations on a dry run.
  // That mutation survived, which is why resolveRunMode() is a function.
  const { parseArgs, resolveRunMode } = sendScript;
  const mode = argv => resolveRunMode(parseArgs(argv));
  const REF = '--campaign-ref=x';

  // The one combination that writes.
  assert.deepEqual(mode([REF, '--commit', '--mailing-approved', '--out=/tmp/x.json']),
    { willWrite: true, error: null });

  // Everything else does not, and each refusal is distinguishable.
  assert.deepEqual(mode([REF]), { willWrite: false, error: null });
  assert.deepEqual(mode([]), { willWrite: false, error: 'campaign_ref_required' });
  assert.deepEqual(mode(['--commit', '--mailing-approved', '--out=/tmp/x.json']),
    { willWrite: false, error: 'campaign_ref_required' });
  assert.deepEqual(mode([REF, '--commit']), { willWrite: false, error: 'both_flags_required' });
  assert.deepEqual(mode([REF, '--mailing-approved']), { willWrite: false, error: 'both_flags_required' });
  assert.deepEqual(mode([REF, '--commit', '--mailing-approved']),
    { willWrite: false, error: 'out_path_required' });
  assert.deepEqual(mode([REF, '--commit', '--mailing-approved', '--out=/tmp/x.json', '--dry-run']),
    { willWrite: false, error: 'both_flags_required' });

  // Exhaustive over the flags that decide it, so no combination is untested.
  for (const commit of [false, true]) {
    for (const approved of [false, true]) {
      for (const out of [null, '/tmp/x.json']) {
        const result = resolveRunMode({ campaignRef: 'x', commit, mailingApproved: approved, out });
        assert.equal(result.willWrite, commit && approved && Boolean(out),
          `commit=${commit} approved=${approved} out=${out}`);
      }
    }
  }
});

test('a dry run renders with a placeholder, because a dry run mints no token', () => {
  assert.equal(sendScript.PLACEHOLDER_TOKEN, 'DRY-RUN-NO-TOKEN-WAS-MINTED');
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'send-sms-optin-invites.js'), 'utf8');
  // The only call that opens an invitation is downstream of the dry-run return,
  // and the return itself is driven by resolveRunMode() above.
  const dryRunReturn = source.indexOf('DRY RUN. No invitation was opened');
  const firstMint = source.indexOf('await issueOptInInvite(');
  assert.ok(dryRunReturn > 0 && firstMint > dryRunReturn,
    'a dry run reaches the code that opens invitations');
  assert.match(source, /const \{ willWrite \} = mode;/);
  assert.match(source, /if \(!willWrite\) \{/,
    'the dry-run branch must test willWrite directly');
});

test('the mailing plan excludes everybody it must, and names the reason for each', () => {
  const { planOptInMailing } = sendScript;
  const campaignRef = CAMPAIGN_REF;

  const contact = (phone, extra = {}) => ({
    phone, email: `${phone.slice(-4)}@example.com`, first_name: 'Sam',
    opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive', ...extra
  });

  const plan = planOptInMailing({
    campaignRef,
    now: new Date('2026-08-22T12:00:00Z'),
    contacts: [
      contact('+14155550101'),                                   // invited
      contact('+14155550102', { email: null }),                  // no_email_address
      contact('+14155550103', { phone: 'nonsense' }),            // invalid_phone
      contact('+14155550104', { opted_out: true }),              // contact_opted_out
      contact('+14155550105', { ghl_dnd: true }),                // dnd
      contact('+14155550106', { ghl_sms_dnd_status: 'active' }), // dnd
      contact('+14155550107'),                                   // stop_sentinel
      contact('+14155550108'),                                   // campaign_suppression
      contact('+14155550109'),                                   // consent_ledger_opt_out
      contact('+14155550110'),                                   // already_opted_in
      contact('+14155550111'),                                   // already_invited_this_campaign
      contact('+14155550101')                                    // duplicate_contact
    ],
    optOutSentinels: [{ id: 1, phone: '+14155550107', flow_type: 'opted-out' }],
    suppressions: [{
      workspace_id: 'vici', contact_phone: '+14155550108', reason_code: 'complaint',
      active: true, effective_at: '2026-01-01T00:00:00Z', expires_at: null
    }],
    consentEvents: [
      { id: 1, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms',
        contact_phone: '+14155550109', event_type: 'opt_out', occurred_at: '2026-08-01T00:00:00Z' },
      { id: 2, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms',
        contact_phone: '+14155550110', event_type: 'opt_in', occurred_at: '2026-08-01T00:00:00Z' }
    ],
    invitations: [
      { id: 'a', workspace_id: 'vici', contact_phone: '+14155550111',
        campaign_ref: campaignRef, responded_at: null, cancelled_at: null }
    ]
  });

  assert.deepEqual(plan.recipients.map(row => row.phone), ['+14155550101']);
  assert.deepEqual(plan.counts.skippedByReason, {
    no_email_address: 1,
    invalid_phone: 1,
    contact_opted_out: 1,
    dnd: 2,
    stop_sentinel: 1,
    campaign_suppression: 1,
    consent_ledger_opt_out: 1,
    already_opted_in: 1,
    already_invited_this_campaign: 1,
    duplicate_contact: 1
  });
  // Nobody vanishes without a reason. An operator reviewing a ~900 person
  // mailing cannot audit a count that does not add up.
  assert.equal(plan.counts.eligible + plan.counts.skipped, 12);
});

test('a later opt_in outranks an earlier opt_out in the mailing plan too', () => {
  const plan = sendScript.planOptInMailing({
    campaignRef: CAMPAIGN_REF,
    contacts: [{ phone: PHONE, email: 'a@example.com', opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive' }],
    consentEvents: [
      { id: 1, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms',
        contact_phone: PHONE, event_type: 'opt_in', occurred_at: '2026-08-10T00:00:00Z' },
      { id: 2, workspace_id: 'vici', brand_id: 'vici', purpose: 'promotional_sms',
        contact_phone: PHONE, event_type: 'opt_out', occurred_at: '2026-08-20T00:00:00Z' }
    ]
  });
  assert.deepEqual(plan.recipients, []);
  assert.equal(plan.counts.skippedByReason.consent_ledger_opt_out, 1);
});

test('a cancelled invitation does not count as having already asked somebody', () => {
  const base = {
    campaignRef: CAMPAIGN_REF,
    contacts: [{ phone: PHONE, email: 'a@example.com', opted_out: false, ghl_dnd: false, ghl_sms_dnd_status: 'inactive' }]
  };
  const superseded = sendScript.planOptInMailing({
    ...base,
    invitations: [{ id: 'a', workspace_id: 'vici', contact_phone: PHONE,
      campaign_ref: CAMPAIGN_REF, responded_at: null, cancelled_at: '2026-08-01T00:00:00Z' }]
  });
  assert.equal(superseded.recipients.length, 1);

  const answered = sendScript.planOptInMailing({
    ...base,
    invitations: [{ id: 'a', workspace_id: 'vici', contact_phone: PHONE,
      campaign_ref: CAMPAIGN_REF, responded_at: '2026-08-02T00:00:00Z', cancelled_at: null }]
  });
  assert.equal(answered.recipients.length, 0);
});

test('a rendered invitation carries the link and never the whole phone number', () => {
  const rendered = sendScript.renderInvite({
    recipient: { phone: PHONE, email: 'customer@example.com', recipientName: 'Sarah' },
    optInUrl: `${BASE_URL}/sms-optin?token=abc`,
    expiresAt: expiryFrom(Date.UTC(2026, 7, 1))
  });
  assert.equal(rendered.to, 'customer@example.com');
  assert.ok(rendered.text.includes(`${BASE_URL}/sms-optin?token=abc`));
  assert.match(rendered.text, /ending 0132/);
  assert.equal(rendered.text.includes(PHONE), false);
  assert.equal(rendered.html.includes(PHONE), false);
});

test('the printed plan masks contact details unless they are explicitly asked for', () => {
  assert.equal(sendScript.mask(PHONE), '+1******0132');
  assert.equal(sendScript.mask('123'), '****');
  assert.equal(sendScript.maskEmail('customer@example.com'), 'c*******@example.com');
  assert.equal(sendScript.maskEmail('nonsense'), '****');
});

// ── The email ──────────────────────────────────────────────────────────────

test('the invitation email states every term the consent depends on', () => {
  const message = smsOptInInviteEmail({
    recipientName: 'Sarah',
    optInUrl: `${BASE_URL}/sms-optin?token=abc`,
    phoneEnding: phoneEnding(PHONE),
    expiresAt: expiryFrom(Date.UTC(2026, 7, 1)),
    expiryDays: EXPIRY_DAYS
  });

  assert.match(message.subject, /permission/i);
  assert.match(message.text, /^Hi Sarah,/);

  // The five disclosures, in the plain text where they cannot be styled away.
  assert.match(message.text, /not a condition of buying anything/i);
  assert.match(message.text, /2 messages in any 7 days/);
  assert.match(message.text, /4 in any 30 days/);
  assert.match(message.text, /Message and data rates may apply/i);
  assert.match(message.text, /replying STOP/i);

  // Which number, so a person with two on file knows what they are answering.
  assert.match(message.text, /ending 0132/);
  // But never the whole number.
  assert.equal(message.text.includes(PHONE), false);

  assert.ok(message.text.includes(`${BASE_URL}/sms-optin?token=abc`));
  assert.match(message.html, /<a href="https:\/\/inbox\.example\.com\/sms-optin\?token=abc"/);
});

test('the email degrades without a name or a known number, and never renders undefined', () => {
  const message = smsOptInInviteEmail({ optInUrl: `${BASE_URL}/sms-optin?token=abc` });
  assert.match(message.text, /^Hi,/);
  assert.equal(/undefined|null|\[object/.test(message.text), false);
  assert.equal(/undefined|null|\[object/.test(message.html), false);
  assert.equal(message.text.includes('ending '), false);
});

test('the email carries no tracking pixel and one destination', () => {
  const message = smsOptInInviteEmail({
    optInUrl: `${BASE_URL}/sms-optin?token=abc`, phoneEnding: '0132'
  });
  assert.equal(/<img/i.test(message.html), false, 'a tracking pixel in a consent email');
  const hrefs = [...message.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(hrefs)], [`${BASE_URL}/sms-optin?token=abc`]);
});

test('phoneEnding masks everything except the last four digits', () => {
  assert.equal(phoneEnding(PHONE), '0132');
  assert.equal(phoneEnding('not a phone'), null);
  assert.equal(phoneEnding(null), null);
});

// ── The page ───────────────────────────────────────────────────────────────

test('the page states every term the consent depends on', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'sms-optin.html'), 'utf8');
  const visible = page.replace(/<!--[\s\S]*?-->/g, '');

  assert.match(visible, /Marketing texts from Vici Peptides/i);
  assert.match(visible, /not a condition of buying anything/i);
  assert.match(visible, /2 messages in any 7 days/);
  assert.match(visible, /4 in any 30 days/);
  assert.match(visible, /Message and data rates may apply/i);
  assert.match(visible, /Reply <strong>STOP<\/strong>/);
  assert.match(visible, /No thanks/);

  // Nothing third-party, and nothing that could carry a token off-site.
  assert.equal(/src="http/i.test(visible), false);
  assert.equal(/href="http/i.test(visible), false);
  assert.match(page, /name="robots" content="noindex, nofollow"/);
});

test('the page forgets the token on EVERY path, not just the two success screens', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'sms-optin.html'), 'utf8');

  // Exactly one call site, and it is in the POST continuation rather than in a
  // success renderer. It used to run only from showOptedIn/showOptedOut, so an
  // expired, rate-limited, withdrawn or server-error answer left a live consent
  // token in the address bar, in session history, in whatever the browser syncs
  // that history to, and in any screenshot of the tab. Those are precisely the
  // states a person lingers on and retries from.
  const calls = page.match(/^\s*forgetTokenInAddressBar\(\);/gm) || [];
  assert.equal(calls.length, 1, 'the token is forgotten on some paths and not others');

  // Not in a success renderer. Those are reached on exactly two of the eight
  // outcomes this page can show.
  const renderers = page.slice(page.indexOf('function showOptedIn'), page.indexOf('function showDeadLink'));
  assert.equal(renderers.includes('forgetTokenInAddressBar'), false,
    'the token is forgotten from a success renderer, so failures keep it');

  // In the POST continuation, and unconditional: nothing between the
  // continuation opening and the call inspects the result.
  const callSite = page.search(/^\s*forgetTokenInAddressBar\(\);/m);
  const continuation = page.indexOf("postJSON('/sms-optin/' + which");
  assert.ok(continuation > 0 && callSite > continuation,
    'the call must be in the POST continuation, before anything branches on the outcome');
  assert.equal(/if\s*\(|switch\s*\(/.test(page.slice(continuation, callSite)), false,
    'the token is only forgotten on some outcomes');
});

test('the page has a state for every code the server can return', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'sms-optin.html'), 'utf8');
  for (const code of Object.keys(CONFIRM_ERRORS)) {
    assert.match(page, new RegExp(`case '${code}':`), `${code} falls through to the default state`);
  }
  assert.match(page, /case 'TOO_MANY_ATTEMPTS':/);
});

test('the page posts same-origin, to the two real endpoints and nowhere else', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'sms-optin.html'), 'utf8');

  // One fetch call site, one relative path, built from a variable that can only
  // ever hold one of two literals.
  assert.equal((page.match(/fetch\(/g) || []).length, 1);
  assert.match(page, /postJSON\('\/sms-optin\/' \+ which/);
  const answers = [...page.matchAll(/answer\('(confirm|decline)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(answers)].sort(), ['confirm', 'decline']);
  assert.equal((page.match(/answer\('/g) || []).length, answers.length,
    'answer() is called with something other than a literal endpoint name');
});

test('optInUrlFor refuses to build a link without a base', () => {
  assert.equal(optInUrlFor('abc', ''), null);
  assert.equal(optInUrlFor('a b', 'https://x.test/'), 'https://x.test/sms-optin?token=a%20b');
});

test('every confirm error has a status and a message', () => {
  for (const [code, shape] of Object.entries(CONFIRM_ERRORS)) {
    assert.equal(typeof shape.status, 'number', code);
    assert.ok(shape.message.length > 20, code);
    // No em dashes in customer-facing copy: standing rule in this repository.
    assert.equal(shape.message.includes('—'), false, code);
  }
});
