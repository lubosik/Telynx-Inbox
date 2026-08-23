'use strict';
/**
 * test/campaign-segmentation-seam.test.js
 *
 * The seam between two questions:
 *
 *   WHO MATCHES THIS PATTERN?    behaviour. Widened, deliberately.
 *   MAY WE CONTACT THIS PERSON?  permission. Not widened, not by a byte.
 *
 * The load-bearing assertions here are the ones that FAIL if a segment
 * membership path ever becomes a send path. If you are here because one of
 * them went red, the answer is almost certainly not to change the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildGenerationInput,
  buildSegmentationInput
} = require('../lib/campaigns/generation-service');
const { prepareOpportunityDraftRun } = require('../lib/campaigns/opportunity-orchestrator');
const { computeSegmentMembers } = require('../lib/campaigns/segment-definitions');
const { computedSetDigest } = require('../lib/campaigns/segment-membership');
const {
  mergeVerdict,
  summariseCommercialClearance,
  summariseContactability
} = require('../lib/campaigns/segment-contactability');

/** Comments describe the seam; code must not cross it. Only code is checked. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const NOW = new Date('2026-08-22T12:00:00.000Z');
const PHONE = '+15555550123';

/**
 * A customer with four purchases at a steady 30 day interval, so the reorder
 * detector has a reliable personal cadence and the only variable under test is
 * clearance.
 */
function sources({ support = [], suppressions = [] } = {}) {
  // Four purchases, thirty days apart, the last one thirty days ago: a high
  // confidence personal cadence whose reorder window is open right now.
  const dates = [
    '2026-04-24T12:00:00Z', '2026-05-24T12:00:00Z',
    '2026-06-23T12:00:00Z', '2026-07-23T12:00:00Z'
  ];
  return {
    orders: dates.map((created_at, index) => ({
      id: index + 1, woo_order_id: 900 + index, contact_phone: PHONE, status: 'completed',
      created_at, total: 90, items: [{ product_id: 42, variation_id: 7, name: 'Exact' }]
    })),
    contacts: [{ id: 5, phone: PHONE, name: 'Buyer' }],
    inventory: [{
      product_id: 42, variation_id: 7, name: 'Exact', stock_status: 'instock',
      stock_quantity: 2, updated_at: '2026-08-22T11:00:00Z'
    }],
    support,
    supportAvailable: true,
    ledger: [], suppressions, opportunities: [], restockEvents: []
  };
}

const CLEARED = [{
  contact_phone: PHONE, status: 'clear', source: 'support_sync',
  evidence_ref: 'case-snapshot:1', observed_at: '2026-08-22T11:00:00Z'
}];

// ── The gate is exactly where it was ────────────────────────────────────────

test('gate mode is unchanged: no clearance means no candidate, and the reason is recorded', () => {
  const gated = buildGenerationInput(sources(), { now: NOW, workflows: ['reorder'] });
  assert.equal(gated.reorderCandidates.length, 0);
  assert.equal(gated.segmentationOnly, false);
  assert.equal(gated.clearanceMode, 'gate');
  assert.equal(gated.sourceSuppressions[0].reasons[0], 'support_state_unknown');
});

test('gate mode is the default: an omitted option cannot silently open the gate', () => {
  const omitted = buildGenerationInput(sources(), { now: NOW, workflows: ['reorder'] });
  const explicit = buildGenerationInput(sources(), { now: NOW, workflows: ['reorder'], clearance: 'gate' });
  assert.equal(omitted.clearanceMode, 'gate');
  assert.equal(omitted.segmentationOnly, false);
  assert.deepEqual(omitted.reorderCandidates, explicit.reorderCandidates);
});

test('gate mode still admits a cleared person, and attaches no clearance annotation', () => {
  const cleared = buildGenerationInput(sources({ support: CLEARED }), { now: NOW, workflows: ['reorder'] });
  assert.equal(cleared.reorderCandidates.length, 1);
  assert.equal(cleared.reorderCandidates[0].commercialClearance, undefined);
  assert.equal(cleared.segmentationOnly, false);
});

test('an unrecognised clearance mode is refused rather than guessed at', () => {
  assert.throws(
    () => buildGenerationInput(sources(), { now: NOW, clearance: 'off' }),
    /clearanceMode must be one of/
  );
});

test('an authoritative suppression still blocks the candidate in gate mode', () => {
  const suppressed = buildGenerationInput(sources({
    support: CLEARED,
    suppressions: [{
      contact_phone: PHONE, active: true, reason_code: 'complaint',
      effective_at: '2026-08-01T00:00:00Z', expires_at: null
    }]
  }), { now: NOW, workflows: ['reorder'] });
  assert.equal(suppressed.reorderCandidates.length, 0);
  assert.equal(suppressed.sourceSuppressions[0].reasons[0], 'authoritative_suppression');
});

// ── The view is wider, and says so ──────────────────────────────────────────

test('observe mode sees the uncleared person and records why they are not contactable', () => {
  const observed = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] });
  assert.equal(observed.reorderCandidates.length, 1);
  assert.equal(observed.clearanceMode, 'observe');
  assert.equal(observed.segmentationOnly, true);
  assert.deepEqual(observed.reorderCandidates[0].commercialClearance, {
    clear: false, reason: 'support_state_unknown'
  });
  // The suppression is still counted. Widening the view did not hide the gate.
  assert.equal(observed.sourceSuppressions[0].reasons[0], 'support_state_unknown');
});

test('observe mode still reports a cleared person as clear', () => {
  const observed = buildSegmentationInput(sources({ support: CLEARED }), { now: NOW, workflows: ['reorder'] });
  assert.deepEqual(observed.reorderCandidates[0].commercialClearance, { clear: true, reason: null });
});

test('buildSegmentationInput cannot be talked back into gate mode by its caller', () => {
  const forced = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'], clearance: 'gate' });
  assert.equal(forced.clearanceMode, 'observe');
  assert.equal(forced.segmentationOnly, true);
});

// ── THE ONE THAT MATTERS: a wider view can never become a wider send ────────

test('a segmentation input is refused by the draft preparer', async () => {
  const input = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] });
  await assert.rejects(
    () => prepareOpportunityDraftRun(input),
    error => error.code === 'SEGMENTATION_INPUT_IS_NOT_A_SEND_PATH'
  );
});

test('the refusal survives someone stripping the stamp, and survives someone forging it', async () => {
  const input = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] });

  // Stamp removed, mode left behind.
  await assert.rejects(
    () => prepareOpportunityDraftRun({ ...input, segmentationOnly: false }),
    error => error.code === 'SEGMENTATION_INPUT_IS_NOT_A_SEND_PATH'
  );
  // Mode removed, stamp left behind.
  await assert.rejects(
    () => prepareOpportunityDraftRun({ ...input, clearanceMode: 'gate' }),
    error => error.code === 'SEGMENTATION_INPUT_IS_NOT_A_SEND_PATH'
  );
});

test('a gated input is still drafted exactly as before', async () => {
  const gated = buildGenerationInput(sources({ support: CLEARED }), { now: NOW, workflows: ['reorder'] });
  const run = await prepareOpportunityDraftRun(gated);
  assert.equal(run.opportunities.length, 1);
  assert.equal(run.opportunities[0].contactPhone, PHONE);
});

test('the uncleared person who is now VISIBLE is still not DRAFTABLE', async () => {
  const seen = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] });
  const sendable = buildGenerationInput(sources(), { now: NOW, workflows: ['reorder'] });

  // Visible in the segment.
  assert.equal(computeSegmentMembers('reorder_due', seen, { now: NOW }).length, 1);
  // Absent from anything a draft could be made from.
  assert.equal(sendable.reorderCandidates.length, 0);
  const run = await prepareOpportunityDraftRun(sendable);
  assert.equal(run.opportunities.length, 0);
  assert.equal(run.drafts.length, 0);
});

test('no delivery or draft path reaches for the segmentation builder', () => {
  const root = path.join(__dirname, '..');
  const sendPaths = [
    'lib/campaigns/delivery-worker.js',
    'lib/campaigns/service.js',
    'lib/campaigns/draft-copy.js',
    'lib/campaigns/copy-writer.js',
    'lib/campaigns/opportunity-orchestrator.js',
    'routes/campaigns.js'
  ];
  for (const file of sendPaths) {
    // Comments are stripped first, because these files are expected to TALK
    // about the seam. It is calling it that is forbidden, not explaining it.
    const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(
      source.includes('buildSegmentationInput'), false,
      `${file} must never build a segmentation input; it is a send path.`
    );
    assert.equal(
      /clearance:\s*'observe'/.test(source), false,
      `${file} must never request observe-mode clearance.`
    );
  }
});

test('the segment service reads its input through the segmentation builder, not the gated one', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib/campaigns/segment-service.js'), 'utf8'
  );
  assert.match(source, /buildSegmentationInput/);
  assert.equal(
    /\bbuildGenerationInput\s*\(/.test(source), false,
    'segment-service must not call the gated builder; that is what made every segment read zero.'
  );
});

// ── Permission never leaks into membership ──────────────────────────────────

test('membership is identical whether or not the person is cleared', () => {
  const uncleared = buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] });
  const cleared = buildSegmentationInput(sources({ support: CLEARED }), { now: NOW, workflows: ['reorder'] });

  const a = computeSegmentMembers('reorder_due', uncleared, { now: NOW });
  const b = computeSegmentMembers('reorder_due', cleared, { now: NOW });
  assert.deepEqual(a.map(row => row.contactPhone), b.map(row => row.contactPhone));
  assert.deepEqual(a[0].inclusionEvidence, b[0].inclusionEvidence);
});

test('clearance never enters the run digest, so recompute stays idempotent while permission changes', () => {
  const uncleared = computeSegmentMembers(
    'reorder_due', buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] }), { now: NOW }
  );
  const cleared = computeSegmentMembers(
    'reorder_due', buildSegmentationInput(sources({ support: CLEARED }), { now: NOW, workflows: ['reorder'] }), { now: NOW }
  );
  assert.notDeepEqual(uncleared[0].commercialClearance, cleared[0].commercialClearance);
  assert.equal(computedSetDigest(uncleared), computedSetDigest(cleared));
});

test('clearance is carried beside the evidence, never inside it', () => {
  const members = computeSegmentMembers(
    'reorder_due', buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] }), { now: NOW }
  );
  assert.deepEqual(members[0].commercialClearance, { clear: false, reason: 'support_state_unknown' });
  const evidence = JSON.stringify(members[0].inclusionEvidence);
  assert.equal(evidence.includes('support_state_unknown'), false);
  assert.equal(evidence.includes('commercialClearance'), false);
});

test('a member reconciled for persistence carries no clearance into the database', () => {
  const { reconcileSegmentMembership } = require('../lib/campaigns/segment-membership');
  const computed = computeSegmentMembers(
    'reorder_due', buildSegmentationInput(sources(), { now: NOW, workflows: ['reorder'] }), { now: NOW }
  );
  const reconciled = reconcileSegmentMembership({ existing: [], computed, overrides: [] });
  for (const row of reconciled.submit) {
    assert.equal('commercialClearance' in row, false);
    assert.equal(JSON.stringify(row.inclusionEvidence).includes('clearance'), false);
  }
});

// ── Eligibility as information ──────────────────────────────────────────────

test('two independent reasons are both reported, not short-circuited to one', () => {
  assert.deepEqual(mergeVerdict({
    clearance: { clear: false, reason: 'support_state_unknown' },
    recipient: { eligible: false, reason: 'consent_not_recorded' }
  }).reasons, ['support_state_unknown', 'consent_not_recorded']);
});

test('contactable requires both questions to pass', () => {
  assert.equal(mergeVerdict({
    clearance: { clear: true, reason: null }, recipient: { eligible: true, reason: 'eligible' }
  }).contactable, true);
  assert.equal(mergeVerdict({
    clearance: { clear: true, reason: null }, recipient: { eligible: false, reason: 'dnd' }
  }).contactable, false);
  assert.equal(mergeVerdict({
    clearance: { clear: false, reason: 'support_state_unknown' },
    recipient: { eligible: true, reason: 'eligible' }
  }).contactable, false);
});

test('the summary says "N match, 0 contactable" rather than showing nothing', () => {
  const phones = ['+15555550001', '+15555550002', '+15555550003'];
  const byPhone = new Map(phones.map(phone => [phone, {
    contactable: false, reasons: ['support_state_unknown', 'consent_not_recorded'], explanations: []
  }]));
  const summary = summariseContactability({ phones, byPhone, evaluatedAt: NOW.toISOString() });
  assert.equal(summary.matched, 3);
  assert.equal(summary.contactable, 0);
  assert.equal(summary.notContactable, 3);
  assert.deepEqual(summary.reasons.map(row => [row.reason, row.people]), [
    ['consent_not_recorded', 3], ['support_state_unknown', 3]
  ]);
  assert.match(summary.note, /decided again at send time/);
});

test('an unevaluated summary reports the count and admits it did not check', () => {
  const summary = summariseContactability({
    phones: ['+15555550001'], evaluated: false, notEvaluatedReason: 'segment_too_large_to_evaluate'
  });
  assert.equal(summary.matched, 1);
  assert.equal(summary.contactable, null);
  assert.equal(summary.notEvaluatedReason, 'segment_too_large_to_evaluate');
});

test('in-run clearance folds into a count without a second database opinion', () => {
  const summary = summariseCommercialClearance([
    { commercialClearance: { clear: true, reason: null } },
    { commercialClearance: { clear: false, reason: 'support_state_unknown' } },
    { commercialClearance: { clear: false, reason: 'support_state_unknown' } },
    { commercialClearance: null }
  ]);
  assert.equal(summary.members, 4);
  assert.equal(summary.clear, 1);
  assert.equal(summary.notClear, 2);
  assert.equal(summary.unobserved, 1);
  assert.deepEqual(summary.reasons[0], {
    reason: 'support_state_unknown',
    people: 2,
    explanation: 'No current customer experience clearance on record'
  });
});
