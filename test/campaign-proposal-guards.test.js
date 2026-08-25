'use strict';
/**
 * The two guards this feature is built around, and the service that obeys
 * them. Nothing here touches a network or a real database.
 *
 * GUARD ONE — a proposal whose copy failed validation is never surfaced.
 * GUARD TWO — a proposal never becomes a campaign without a human acceptance.
 *
 * EACH GUARD IS MUTATION TESTED
 *   For every condition inside a guard there is a test that removes exactly
 *   that condition from the input and proves the guard still refuses. Written
 *   the other way round, these tests fail if somebody deletes a clause from
 *   the guard: the surviving clauses do not cover for it. That is the property
 *   worth having, because a guard whose clauses are individually redundant is
 *   a guard that erodes one commit at a time without any test going red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProposalGuardError,
  assertAudienceIsSaved,
  assertDismissalReason,
  assertHumanAcceptance,
  assertSurfaceable,
  isSurfaceable
} = require('../lib/campaigns/proposal-guards');
const { createProposalService } = require('../lib/campaigns/proposal-service');

// The sender's name is a BUSINESS DECISION and it has already changed once,
// from "Vici" to "Vin from Vici". Fixtures that hardcode it turn every one of
// these tests into a test of the current name, so 30 of them failed on a
// two-word copy change that broke nothing. Read it from the rules instead: the
// name can change again and only the rule file needs editing.
const { RULES: COPY_RULES } = require('../lib/campaigns/copy-rules');
const BRAND = COPY_RULES.brand.defaultName;


const ACTOR = { id: 7, displayName: 'Owner' };

function proposal(overrides = {}) {
  return {
    id: 'p-1',
    proposalKey: 'one_time_buyers:plain_check_in',
    opportunityId: 'one_time_buyers',
    opportunityKind: 'repeat_purchase',
    opportunityTitle: 'Most buyers have ordered once and not come back',
    mechanism: 'plain_check_in',
    mechanismLabel: 'Plain check-in, no offer',
    distinctnessClass: 'no_incentive',
    title: 'Plain check-in for One-time buyers',
    audience: { kind: 'rules', segmentKey: 'one_time_buyers' },
    segmentKey: 'one_time_buyers',
    offer: { kind: 'none' },
    copy: {
      text: `${BRAND}: we are here if you need anything from us. Reply STOP to opt out.`,
      septets: 70,
      validated: true,
      failedChecks: [],
      copyRulesVersion: '2026-08-23'
    },
    status: 'proposed',
    createdCampaignId: null,
    ...overrides
  };
}

// ── GUARD ONE: nothing unvalidated reaches a human ──────────────────────────

test('a validated proposal is surfaceable', () => {
  assert.equal(assertSurfaceable(proposal()), true);
  assert.equal(isSurfaceable(proposal()), true);
});

test('MUTATION: copy.validated flipped off blocks it', () => {
  const broken = proposal();
  broken.copy.validated = false;
  assert.throws(() => assertSurfaceable(broken), error => error.code === 'PROPOSAL_COPY_UNVALIDATED');
  assert.equal(isSurfaceable(broken), false);
});

test('MUTATION: copy.validated merely absent blocks it, so a default cannot be permissive', () => {
  const broken = proposal();
  delete broken.copy.validated;
  assert.throws(() => assertSurfaceable(broken), error => error.code === 'PROPOSAL_COPY_UNVALIDATED');
});

test('MUTATION: a single failed check blocks it, even with validated still true', () => {
  const broken = proposal();
  broken.copy.failedChecks = ['no_banned_terms'];
  assert.throws(() => assertSurfaceable(broken), error => error.code === 'PROPOSAL_COPY_REJECTED');
});

test('MUTATION: failedChecks replaced by something that is not an array blocks it', () => {
  // `[].length !== 0` is false for a string too, so a guard written as a
  // truthiness test would let `failedChecks: "none"` through.
  const broken = proposal();
  broken.copy.failedChecks = 'none';
  assert.throws(() => assertSurfaceable(broken), error => error.code === 'PROPOSAL_COPY_UNVALIDATED');
});

test('MUTATION: empty or missing copy text blocks it', () => {
  for (const text of ['', '   ', undefined, null, 42]) {
    const broken = proposal();
    broken.copy.text = text;
    assert.throws(() => assertSurfaceable(broken), error => error.code === 'PROPOSAL_COPY_EMPTY' || error.code === 'PROPOSAL_COPY_UNVALIDATED');
  }
});

test('MUTATION: no copy object at all blocks it', () => {
  assert.throws(() => assertSurfaceable(proposal({ copy: undefined })), error => error.code === 'PROPOSAL_COPY_MISSING');
  assert.throws(() => assertSurfaceable(null), error => error.code === 'PROPOSAL_MALFORMED');
});

test('isSurfaceable never swallows a real bug', () => {
  // A guard failure is false. Anything else must propagate: a TypeError from a
  // future refactor must not read as "this proposal is unsafe" and vanish.
  assert.throws(() => isSurfaceable({ get copy() { throw new RangeError('boom'); } }), RangeError);
});

// ── GUARD TWO: nothing becomes a campaign without a human ───────────────────

test('an open proposal with a named actor may be accepted', () => {
  assert.equal(assertHumanAcceptance(proposal(), ACTOR), true);
});

test('MUTATION: no actor blocks acceptance', () => {
  for (const actor of [undefined, null, {}, { id: null }, { id: 0 }, { id: -1 }, { id: 'seven' }, { id: 1.5 }]) {
    assert.throws(
      () => assertHumanAcceptance(proposal(), actor),
      error => error.code === 'PROPOSAL_ACTOR_REQUIRED',
      `actor ${JSON.stringify(actor)} must not be able to accept`
    );
  }
});

test('MUTATION: a proposal already accepted or dismissed cannot be accepted again', () => {
  for (const status of ['accepted', 'dismissed', 'proposed_', '', undefined]) {
    assert.throws(
      () => assertHumanAcceptance(proposal({ status }), ACTOR),
      error => error.code === 'PROPOSAL_NOT_OPEN'
    );
  }
});

test('MUTATION: a proposal that already produced a campaign cannot produce another', () => {
  assert.throws(
    () => assertHumanAcceptance(proposal({ createdCampaignId: 'c-1' }), ACTOR),
    error => error.code === 'PROPOSAL_ALREADY_CONVERTED'
  );
});

test('MUTATION: an unvalidated proposal cannot be accepted, even by a named human', () => {
  // The gate that stops a bad row written by some future code path from being
  // laundered into a campaign by an ordinary click.
  const broken = proposal();
  broken.copy.failedChecks = ['no_banned_terms'];
  assert.throws(() => assertHumanAcceptance(broken, ACTOR), error => error.code === 'PROPOSAL_COPY_REJECTED');
});

test('MUTATION: a proposal with no saved segment cannot be accepted, and says what to do', () => {
  assert.equal(assertAudienceIsSaved(proposal()), true);
  let caught = null;
  try {
    assertAudienceIsSaved(proposal({ audience: { kind: 'rules', segmentKey: null } }));
  } catch (error) { caught = error; }
  assert.ok(caught instanceof ProposalGuardError);
  assert.equal(caught.code, 'PROPOSAL_AUDIENCE_NOT_SAVED');
  assert.match(caught.message, /Save the rules as a segment/);
});

test('a dismissal must carry a reason', () => {
  assert.equal(assertDismissalReason('  Too expensive for this cohort '), 'Too expensive for this cohort');
  for (const reason of [undefined, null, '', '   ', 'no', 7]) {
    assert.throws(
      () => assertDismissalReason(reason),
      error => error.code === 'PROPOSAL_DISMISSAL_REASON_REQUIRED'
    );
  }
  assert.throws(() => assertDismissalReason('x'.repeat(501)), error => error.code === 'PROPOSAL_DISMISSAL_REASON_TOO_LONG');
});

// ── The service obeys the guards ────────────────────────────────────────────

/**
 * A Supabase stand-in narrow enough to be readable.
 *
 * It records every mutation and honours `.eq('status', ...)` as a real
 * compare-and-swap, which is the behaviour the acceptance path depends on.
 */
function fakeDatabase({ rows = [], segments = [], members = [] } = {}) {
  const log = [];
  const state = { rows: rows.map(row => ({ ...row })), segments, members };

  function table(name) {
    const filters = [];
    let pending = null;
    let selected = null;
    const builder = {
      select(columns) { selected = columns; return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      is(column, value) { filters.push([column, value]); return builder; },
      in(column, values) { filters.push([column, values]); return builder; },
      order() { return builder; },
      range() { return builder; },
      update(patch) { pending = { kind: 'update', patch }; return builder; },
      upsert(values) { pending = { kind: 'upsert', values }; return builder; },
      matches(row) {
        return filters.every(([column, value]) =>
          (Array.isArray(value) ? value.includes(row[column]) : row[column] === value));
      },
      async maybeSingle() { return builder.then(result => result).then(r => ({ ...r, data: r.data?.[0] ?? null })); },
      then(resolve) {
        let data = [];
        if (name === 'sms_campaign_proposals') {
          if (pending?.kind === 'update') {
            const hit = state.rows.filter(row => builder.matches(row));
            for (const row of hit) Object.assign(row, pending.patch);
            log.push({ table: name, kind: 'update', patch: pending.patch, matched: hit.length });
            data = hit;
          } else if (pending?.kind === 'upsert') {
            log.push({ table: name, kind: 'upsert', values: pending.values });
            for (const value of pending.values) {
              const existing = state.rows.find(row => row.proposal_key === value.proposal_key);
              if (existing) Object.assign(existing, value);
              else state.rows.push({ id: `p-${state.rows.length + 1}`, ...value });
            }
            data = pending.values.map(value => state.rows.find(row => row.proposal_key === value.proposal_key));
          } else {
            data = state.rows.filter(row => builder.matches(row));
          }
        } else if (name === 'sms_campaign_segments') {
          data = state.segments.filter(row => builder.matches(row));
        } else if (name === 'sms_campaign_segment_members') {
          data = state.members.filter(row => builder.matches(row));
        }
        return Promise.resolve(resolve({ data, error: null, count: data.length }));
      }
    };
    return builder;
  }
  return { from: table, log, state };
}

function storedRow(overrides = {}) {
  return {
    id: 'p-1',
    workspace_id: 'vici',
    proposal_key: 'one_time_buyers:plain_check_in',
    opportunity_id: 'one_time_buyers',
    opportunity_kind: 'repeat_purchase',
    opportunity_title: 'Most buyers have ordered once and not come back',
    opportunity_source: 'detector',
    mechanism: 'plain_check_in',
    mechanism_label: 'Plain check-in, no offer',
    distinctness_class: 'no_incentive',
    title: 'Plain check-in for One-time buyers',
    audience: { kind: 'rules', segmentKey: 'one_time_buyers' },
    segment_key: 'one_time_buyers',
    offer: { kind: 'none' },
    copy_text: `${BRAND}: we are here if you need anything from us. Reply STOP to opt out.`,
    copy_septets: 70,
    copy_rules_version: '2026-08-23',
    reasoning: {},
    costs: [],
    risks: [],
    projections: [],
    schema_version: 'campaign-proposals-2026-08-23',
    catalogue_version: 'proposal-mechanisms-2026-08-23',
    contract_version: 'opportunity-contract-2026-08-23',
    status: 'proposed',
    created_campaign_id: null,
    ...overrides
  };
}

function serviceWith({ rows = [storedRow()], campaignCreate, members } = {}) {
  const created = [];
  const database = fakeDatabase({ rows });
  const service = createProposalService({
    client: database,
    campaignService: {
      create: campaignCreate || (async (input, actor) => {
        created.push({ input, actor });
        return { campaign: { id: 'c-9', status: 'draft', title: input.title }, recipientCount: input.recipients.length };
      })
    },
    segmentMemberReader: async key => ({
      segment: { id: 's-1', key, name: 'One-time buyers' },
      recipients: members || [{ phone: '+15555550123' }, { phone: '+15555550124' }]
    })
  });
  return { service, database, created };
}

test('accepting creates an ordinary campaign DRAFT and links it to the proposal', async () => {
  const { service, database, created } = serviceWith();
  const result = await service.accept('p-1', ACTOR);

  assert.equal(created.length, 1);
  assert.equal(created[0].input.workflowCategory, 'proposal');
  assert.equal(created[0].input.recipients.length, 2);
  assert.equal(result.campaign.status, 'draft');
  assert.equal(result.campaignStatus, 'draft');
  assert.equal(database.state.rows[0].status, 'accepted');
  assert.equal(database.state.rows[0].accepted_by, 7);
  assert.equal(database.state.rows[0].created_campaign_id, 'c-9');
});

test('the acceptance path never approves, schedules or sends', async () => {
  const forbidden = ['approve', 'prepareApproval', 'schedule', 'submitReview', 'send', 'launch'];
  const reached = [];
  const { service } = serviceWith({
    campaignCreate: async input => ({
      campaign: { id: 'c-9', status: 'draft', title: input.title }, recipientCount: 1
    })
  });
  // A campaign service that screams if anything but create() is touched.
  const spy = new Proxy({
    create: async input => ({ campaign: { id: 'c-9', status: 'draft' }, recipientCount: input.recipients.length })
  }, {
    get(target, property) {
      if (forbidden.includes(property)) reached.push(property);
      return target[property];
    }
  });
  const database = fakeDatabase({ rows: [storedRow()] });
  const guarded = createProposalService({
    client: database,
    campaignService: spy,
    segmentMemberReader: async key => ({
      segment: { id: 's-1', key, name: 'One-time buyers' },
      recipients: [{ phone: '+15555550123' }]
    })
  });
  await guarded.accept('p-1', ACTOR);
  assert.deepEqual(reached, [], 'the proposal layer must reach only create()');
  await service.accept('p-1', ACTOR).catch(() => {});
});

test('MUTATION: acceptance without a named actor creates nothing at all', async () => {
  const { service, database, created } = serviceWith();
  await assert.rejects(
    service.accept('p-1', { id: null }),
    error => error instanceof ProposalGuardError && error.code === 'PROPOSAL_ACTOR_REQUIRED'
  );
  assert.equal(created.length, 0, 'no campaign may be created');
  assert.equal(database.state.rows[0].status, 'proposed', 'and the proposal is untouched');
});

test('MUTATION: an already accepted proposal cannot produce a second campaign', async () => {
  const { service, created } = serviceWith({
    rows: [storedRow({ status: 'accepted', accepted_by: 7, created_campaign_id: 'c-1' })]
  });
  await assert.rejects(service.accept('p-1', ACTOR), error => error.code === 'PROPOSAL_NOT_OPEN');
  assert.equal(created.length, 0);
});

test('MUTATION: a dismissed proposal cannot be accepted', async () => {
  const { service, created } = serviceWith({
    rows: [storedRow({ status: 'dismissed', dismissed_reason: 'Too expensive' })]
  });
  await assert.rejects(service.accept('p-1', ACTOR), error => error.code === 'PROPOSAL_NOT_OPEN');
  assert.equal(created.length, 0);
});

test('MUTATION: a stored proposal whose copy is not validated cannot be accepted', async () => {
  // A row that got into the table by some future path that skipped the
  // validator. It is refused at the point of acceptance, not laundered into a
  // campaign by an ordinary click.
  const { service, created } = serviceWith({ rows: [storedRow({ copy_text: '   ' })] });
  await assert.rejects(service.accept('p-1', ACTOR), error => error.code === 'PROPOSAL_COPY_EMPTY');
  assert.equal(created.length, 0);
});

test('MUTATION: a proposal with no saved segment cannot be accepted', async () => {
  const { service, created } = serviceWith({
    rows: [storedRow({ segment_key: null, audience: { kind: 'rules', segmentKey: null } })]
  });
  await assert.rejects(service.accept('p-1', ACTOR), error => error.code === 'PROPOSAL_AUDIENCE_NOT_SAVED');
  assert.equal(created.length, 0);
});

test('an empty segment produces a refusal, not an empty campaign', async () => {
  const { service, created } = serviceWith({ members: [] });
  await assert.rejects(service.accept('p-1', ACTOR), error => error.code === 'PROPOSAL_SEGMENT_EMPTY');
  assert.equal(created.length, 0);
});

test('the claim happens before the campaign, and is released if the campaign fails', async () => {
  const database = fakeDatabase({ rows: [storedRow()] });
  let statusAtCreateTime = null;
  const service = createProposalService({
    client: database,
    campaignService: {
      create: async () => {
        statusAtCreateTime = database.state.rows[0].status;
        throw new Error('campaign drafting is disabled');
      }
    },
    segmentMemberReader: async key => ({
      segment: { id: 's-1', key, name: 'One-time buyers' },
      recipients: [{ phone: '+15555550123' }]
    })
  });
  await assert.rejects(service.accept('p-1', ACTOR), /campaign drafting is disabled/);
  assert.equal(statusAtCreateTime, 'accepted', 'the row is claimed BEFORE the campaign is created');
  assert.equal(database.state.rows[0].status, 'proposed', 'and released when the campaign is not');
  assert.equal(database.state.rows[0].created_campaign_id, null);
});

test('dismissal keeps the reason, which is the loop\'s only training signal', async () => {
  const { service, database } = serviceWith();
  const dismissed = await service.dismiss('p-1', '  Discounting this cohort is not worth the margin ', ACTOR);
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(database.state.rows[0].dismissed_reason, 'Discounting this cohort is not worth the margin');
  assert.equal(database.state.rows[0].dismissed_by, 7);
});

test('MUTATION: a dismissal with no reason writes nothing', async () => {
  const { service, database } = serviceWith();
  await assert.rejects(service.dismiss('p-1', '', ACTOR), error => error.code === 'PROPOSAL_DISMISSAL_REASON_REQUIRED');
  assert.equal(database.state.rows[0].status, 'proposed');
  assert.equal(database.log.length, 0, 'no write was attempted');
});

test('MUTATION: saving a proposal whose copy failed validation is refused before any insert', async () => {
  const { service, database } = serviceWith({ rows: [] });
  await assert.rejects(
    service.saveBatch([{ ...proposal(), copy: { ...proposal().copy, failedChecks: ['no_banned_terms'] } }]),
    error => error.code === 'PROPOSAL_COPY_REJECTED'
  );
  assert.equal(database.log.length, 0, 'nothing reached the database');
});

test('regenerating never resurrects a proposal a human already decided', async () => {
  const { service, database } = serviceWith({
    rows: [storedRow({ status: 'dismissed', dismissed_reason: 'Not this quarter' })]
  });
  const result = await service.saveBatch([proposal()]);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.skipped, [{ proposalKey: 'one_time_buyers:plain_check_in', reason: 'already_dismissed' }]);
  assert.equal(database.state.rows[0].status, 'dismissed');
  assert.equal(database.state.rows[0].dismissed_reason, 'Not this quarter');
});

test('a still-open proposal is refreshed rather than duplicated', async () => {
  const { service, database } = serviceWith();
  const refreshed = { ...proposal(), title: 'A better title' };
  const result = await service.saveBatch([refreshed], { model: 'test/model' });
  assert.equal(result.saved.length, 1);
  assert.equal(database.state.rows.length, 1);
  assert.equal(database.state.rows[0].title, 'A better title');
});
