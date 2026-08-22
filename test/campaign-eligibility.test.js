'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeSuppressionReason,
  evaluateRecipient,
  latestConsent,
  liveSendEligibility
} = require('../lib/campaigns/eligibility');
const {
  approvalRetryMatches, audienceHash, campaignMaySchedulePreview, normaliseAudience, singleRPCRow
} = require('../lib/campaigns/service');

const noExclusions = { phones: new Set(), orderIDs: new Set() };
const knownNotDnd = {
  contactDnd: false,
  smsDndStatus: 'inactive',
  dndSyncedAt: '2026-08-21T10:00:00Z',
  now: '2026-08-21T11:00:00Z'
};

test('campaign live sending needs the environment and both database gates', () => {
  const settings = { provider_approved: true, live_send_enabled: true };
  assert.deepEqual(liveSendEligibility(settings, {}), {
    allowed: false, reasons: ['environment_gate_disabled']
  });
  assert.deepEqual(liveSendEligibility({ provider_approved: false, live_send_enabled: false }, {
    CAMPAIGNS_LIVE_SEND_ENABLED: 'true'
  }), {
    allowed: false, reasons: ['provider_not_approved', 'workspace_live_send_disabled']
  });
  assert.equal(liveSendEligibility(settings, { CAMPAIGNS_LIVE_SEND_ENABLED: 'true' }).allowed, true);
});

test('consent is fail-closed and an undated opt-in is not evidence', () => {
  assert.deepEqual(latestConsent([{ id: 1, event_type: 'opt_in', occurred_at: null }]), null);
  assert.equal(evaluateRecipient({
    phone: '+13055551234', consentEvents: [{ id: 1, event_type: 'opt_in' }],
    exclusions: noExclusions, ...knownNotDnd
  }).reason, 'consent_not_recorded');
});

test('the latest valid opt-out overrides earlier positive consent', () => {
  const result = evaluateRecipient({
    phone: '+13055551234',
    exclusions: noExclusions,
    consentEvents: [
      { id: 1, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici', source: 'checkout', evidence_ref: 'checkout:1', occurred_at: '2026-08-20T10:00:00Z' },
      { id: 2, event_type: 'opt_out', source: 'STOP', occurred_at: '2026-08-21T10:00:00Z' }
    ]
  });
  assert.deepEqual(result, { eligible: false, phone: '+13055551234', reason: 'opted_out' });
});

test('positive current evidence allows a recipient but internal identities never pass', () => {
  const consentEvents = [{
    id: 1, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici',
    source: 'checkout', evidence_ref: 'checkout:2', occurred_at: '2026-08-21T10:00:00Z'
  }];
  assert.equal(evaluateRecipient({
    phone: '3055551234', consentEvents, exclusions: noExclusions, ...knownNotDnd
  }).eligible, true);
  assert.equal(evaluateRecipient({
    phone: '3055551234', consentEvents, ...knownNotDnd,
    exclusions: { phones: new Set(['+13055551234']), orderIDs: new Set() }
  }).reason, 'internal_or_test_identity');
});

test('GHL DND is fail-closed: active, permanent, missing and stale states never qualify', () => {
  const consentEvents = [{
    id: 1, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici',
    source: 'checkout', evidence_ref: 'checkout:3', occurred_at: '2026-08-21T10:00:00Z'
  }];
  const base = { phone: '+13055551234', consentEvents, exclusions: noExclusions, now: '2026-08-22T12:00:00Z' };
  assert.equal(evaluateRecipient({ ...base, contactDnd: true, smsDndStatus: 'inactive', dndSyncedAt: '2026-08-22T11:00:00Z' }).reason, 'dnd');
  assert.equal(evaluateRecipient({ ...base, contactDnd: false, smsDndStatus: 'permanent', dndSyncedAt: '2026-08-22T11:00:00Z' }).reason, 'dnd');
  assert.equal(evaluateRecipient(base).reason, 'dnd_unknown');
  assert.equal(evaluateRecipient({ ...base, contactDnd: false, smsDndStatus: 'inactive', dndSyncedAt: '2026-08-20T00:00:00Z' }).reason, 'dnd_unknown');
  assert.equal(evaluateRecipient({ ...base, contactDnd: false, smsDndStatus: 'inactive', dndSyncedAt: '2026-08-22T12:00:01Z' }).reason, 'dnd_unknown');
  assert.equal(evaluateRecipient({ ...base, contactDnd: false, smsDndStatus: 'inactive', dndSyncedAt: '2026-08-22T11:00:00Z' }).eligible, true);
});

test('authoritative database suppression is active-window aware and outranks consent', () => {
  const now = '2026-08-22T12:00:00Z';
  assert.equal(activeSuppressionReason([{
    active: true, reason_code: 'test_identity', effective_at: '2026-08-20T00:00:00Z', expires_at: null
  }], now), 'internal_or_test_identity');
  assert.equal(activeSuppressionReason([{
    active: true, reason_code: 'compliance_hold', effective_at: '2026-08-20T00:00:00Z', expires_at: '2026-08-23T00:00:00Z'
  }], now), 'authoritative_suppression');
  assert.equal(activeSuppressionReason([{
    active: true, reason_code: 'test_identity', effective_at: '2026-08-23T00:00:00Z', expires_at: null
  }], now), null);
  assert.equal(evaluateRecipient({
    phone: '+13055551234', authoritativeSuppressionReason: 'internal_or_test_identity',
    consentEvents: [], exclusions: noExclusions, ...knownNotDnd
  }).reason, 'internal_or_test_identity');
});

test('transactional or wrong-brand consent cannot authorize a promotional campaign', () => {
  for (const event of [
    { id: 1, event_type: 'opt_in', purpose: 'transactional_sms', brand_id: 'vici', source: 'checkout', evidence_ref: 'x', occurred_at: '2026-08-21T10:00:00Z' },
    { id: 2, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'other', source: 'checkout', evidence_ref: 'x', occurred_at: '2026-08-21T10:00:00Z' }
  ]) {
    assert.equal(evaluateRecipient({
      phone: '+13055551234', consentEvents: [event], exclusions: noExclusions,
      ...knownNotDnd
    }).reason, 'consent_not_recorded');
  }
});

test('an opt-in without a source and evidence reference remains unknown', () => {
  const result = evaluateRecipient({
    phone: '+13055551234', exclusions: noExclusions, ...knownNotDnd,
    consentEvents: [{
      id: 1, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici',
      source: ' ', evidence_ref: null, occurred_at: '2026-08-21T10:00:00Z'
    }]
  });
  assert.equal(result.reason, 'consent_not_recorded');
});

test('manual audiences are normalized, deduplicated and reject non-positive contact ids', () => {
  const rows = normaliseAudience([
    { phone: '(305) 555-1234', contactId: '', name: 'One' },
    { phone: '+13055551234', contactId: 9, name: 'Duplicate' },
    { phone: '+447506440284', contactId: -2 }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contact_id, null);
  assert.equal(rows[1].contact_id, null);
  assert.equal(audienceHash([...rows].reverse()), audienceHash(rows));
});

test('a transient audit failure can resume only the identical frozen approval', () => {
  const campaign = { status: 'approval_pending', revision: 3, approval_audit_recorded_at: null };
  const approval = { decision: 'approved', revision: 3, audience_hash: 'aud', message_hash: 'msg' };
  assert.equal(approvalRetryMatches(campaign, approval, { audienceHash: 'aud', messageHash: 'msg' }), true);
  assert.equal(approvalRetryMatches(campaign, approval, { audienceHash: 'changed', messageHash: 'msg' }), false);
  assert.equal(approvalRetryMatches({ ...campaign, status: 'approved' }, approval, {
    audienceHash: 'aud', messageHash: 'msg'
  }), false);
});

test('a suppressed frozen recipient is skipped without blocking eligible recipients', () => {
  assert.equal(campaignMaySchedulePreview({ eligible: 1, suppressed: 3 }), true);
  assert.equal(campaignMaySchedulePreview({ eligible: 0, suppressed: 3 }), false);
});

test('single-row RPC responses normalize PostgREST object and one-item array shapes', () => {
  assert.deepEqual(singleRPCRow({ id: 'one' }), { id: 'one' });
  assert.deepEqual(singleRPCRow([{ id: 'one' }]), { id: 'one' });
  assert.equal(singleRPCRow([]), null);
});
