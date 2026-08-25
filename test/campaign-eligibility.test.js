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

// GoHighLevel returns `dndSettings` as per-channel OVERRIDES, so an empty
// object means "no override, the global flag applies". Requiring an explicit
// SMS status as well meant every contact in this account read as unknown:
// measured across the whole of GHL, 929 contacts, all `dnd: false`, none with
// channel settings. A campaign targeting five hundred people would have sent to
// nobody.
//
// These fix the boundary in both directions. The first is the change. The rest
// are what must not move because of it.
test('an explicit dnd false with no channel override is contactable', () => {
  const result = evaluateRecipient({
    phone: '+15551230000',
    contactDnd: false,
    smsDndStatus: null,          // GHL sent dndSettings: {}
    dndSyncedAt: new Date().toISOString(),
    now: new Date()
  });
  // Asserted as "cleared the DND gate", not as "eligible". Consent is a later
  // and separate check, so demanding eligibility here would make this test fail
  // for a reason that has nothing to do with what it is guarding.
  assert.notEqual(result.reason, 'dnd_unknown',
    'no override plus an explicit false is an answer, not a shrug');
  assert.notEqual(result.reason, 'dnd');
});

test('DND TRUE IS STILL REFUSED, whatever the channel says', () => {
  for (const smsDndStatus of [null, '', 'inactive', 'active', 'permanent']) {
    const result = evaluateRecipient({
      phone: '+15551230000',
      contactDnd: true,
      smsDndStatus,
      dndSyncedAt: new Date().toISOString(),
      now: new Date()
    });
    assert.equal(result.eligible, false, `dnd true with channel ${JSON.stringify(smsDndStatus)} must be refused`);
    assert.equal(result.reason, 'dnd');
  }
});

test('a channel that says do not contact is still refused even when the global flag is false', () => {
  for (const smsDndStatus of ['active', 'permanent']) {
    const result = evaluateRecipient({
      phone: '+15551230000',
      contactDnd: false,
      smsDndStatus,
      dndSyncedAt: new Date().toISOString(),
      now: new Date()
    });
    assert.equal(result.eligible, false, `channel ${smsDndStatus} must be refused`);
    assert.equal(result.reason, 'dnd');
  }
});

test('no answer at all is still unknown, and so is a stale one', () => {
  const now = new Date();
  // No boolean: GHL was asked and gave nothing.
  assert.equal(evaluateRecipient({
    phone: '+15551230000', contactDnd: null, smsDndStatus: null,
    dndSyncedAt: now.toISOString(), now
  }).reason, 'dnd_unknown');

  // Never synced.
  assert.equal(evaluateRecipient({
    phone: '+15551230000', contactDnd: false, smsDndStatus: null,
    dndSyncedAt: null, now
  }).reason, 'dnd_unknown');

  // Synced two days ago against a 24 hour window.
  assert.equal(evaluateRecipient({
    phone: '+15551230000', contactDnd: false, smsDndStatus: null,
    dndSyncedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
    dndMaxAgeHours: 24, now
  }).reason, 'dnd_unknown');
});

test('the do-not-contact list still outranks a clean DND answer', () => {
  // Suppression is checked before DND, so somebody blocked by hand is refused
  // even when GHL says they are perfectly contactable.
  const result = evaluateRecipient({
    phone: '+15551230000',
    contactDnd: false,
    smsDndStatus: null,
    dndSyncedAt: new Date().toISOString(),
    authoritativeSuppressionReason: 'authoritative_suppression',
    now: new Date()
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'authoritative_suppression');
});
