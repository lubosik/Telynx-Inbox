'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptedPromotionalTimes,
  evaluatePromotionalCadence
} = require('../lib/campaigns/cadence-policy');

function gates(overrides = {}) {
  return {
    now: '2026-08-22T12:00:00Z',
    campaignType: 'back_in_stock',
    brand: 'Vici',
    useCase: 'restock',
    tenantLiveSendEnabled: true,
    runtimeLiveSendEnabled: true,
    legalRulesAllow: true,
    quietHoursAllow: true,
    consent: {
      status: 'active',
      scope: 'promotional',
      brand: 'Vici',
      useCases: ['restock'],
      source: 'checkout-v3',
      evidenceReference: 'checkout-consent-2026-01',
      collectedAt: '2026-01-10T00:00:00Z'
    },
    providerEligibility: {
      status: 'active',
      reviewedAt: '2026-08-01T00:00:00Z',
      evidenceReference: 'provider-review-2026-08',
      bindingConfirmed: true,
      copyScopeApproved: true,
      permittedCampaignTypes: ['back_in_stock']
    },
    ...overrides
  };
}

test('live campaign eligibility defaults fail closed', () => {
  const result = evaluatePromotionalCadence({ campaignType: 'back_in_stock' });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('tenant_live_send_disabled'));
  assert.ok(result.reasons.includes('runtime_live_send_disabled'));
  assert.ok(result.reasons.includes('provider_eligibility_required'));
  assert.ok(result.reasons.includes('promotional_consent_required'));
});

test('all explicit hard gates and clean cadence are required before allowing a send', () => {
  const result = evaluatePromotionalCadence(gates());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
});

test('unknown, transactional, wrong-brand and wrong-use consent all fail closed', () => {
  const variants = [
    null,
    gates().consent && { ...gates().consent, scope: 'transactional' },
    { ...gates().consent, brand: 'Other' },
    { ...gates().consent, useCases: ['reorder'] }
  ];
  for (const consent of variants) {
    const result = evaluatePromotionalCadence(gates({ consent }));
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('promotional_consent_required'));
  }
});

test('provider approval must be current, evidenced and cover the exact campaign type', () => {
  const result = evaluatePromotionalCadence(gates({
    providerEligibility: {
      status: 'active',
      reviewedAt: '2026-08-01T00:00:00Z',
      evidenceReference: 'review',
      bindingConfirmed: true,
      copyScopeApproved: true,
      expiresAt: '2026-08-20T00:00:00Z',
      permittedCampaignTypes: ['reorder']
    }
  }));
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('provider_eligibility_required'));
});

test('accepted failed attempts count once while transactional traffic does not consume promotional cadence', () => {
  const entries = [
    { idempotencyKey: 'one', classification: 'promotional', acceptedAt: '2026-08-22T00:00:00Z', failedAt: '2026-08-22T00:01:00Z' },
    { idempotencyKey: 'one', classification: 'promotional', acceptedAt: '2026-08-22T00:00:00Z' },
    { idempotencyKey: 'txn', classification: 'transactional', acceptedAt: '2026-08-22T11:00:00Z' }
  ];
  assert.equal(acceptedPromotionalTimes(entries).length, 1);
  const result = evaluatePromotionalCadence(gates({ recentCommercialContacts: entries }));
  assert.equal(result.allowed, false);
  assert.equal(result.deferOnly, true);
  assert.deepEqual(result.reasons, ['minimum_spacing']);
  assert.equal(result.nextEligibleContactAt, '2026-08-23T00:00:00.000Z');
});

test('rolling week and month caps report distinct product-policy reasons', () => {
  const recentCommercialContacts = [
    '2026-08-01T12:00:00Z',
    '2026-08-10T12:00:00Z',
    '2026-08-17T12:00:00Z',
    '2026-08-20T12:00:00Z'
  ].map((acceptedAt, index) => ({ id: String(index), classification: 'promotional', acceptedAt }));
  const result = evaluatePromotionalCadence(gates({ recentCommercialContacts }));
  assert.equal(result.allowed, false);
  assert.equal(result.hardBlocked, false);
  assert.ok(result.reasons.includes('rolling_week_cap'));
  assert.ok(result.reasons.includes('rolling_month_cap'));
});

test('opt-out, pending revocation, legal uncertainty and quiet hours are hard blocks, never deferrals', () => {
  const result = evaluatePromotionalCadence(gates({
    optedOut: true,
    pendingRevocation: true,
    legalRulesAllow: false,
    quietHoursAllow: false
  }));
  assert.equal(result.hardBlocked, true);
  assert.equal(result.deferOnly, false);
  assert.ok(result.reasons.includes('opted_out'));
  assert.ok(result.reasons.includes('revocation_pending_review'));
  assert.ok(result.reasons.includes('legal_rule_not_confirmed'));
  assert.ok(result.reasons.includes('quiet_hours_block'));
});

test('invalid frequency configuration fails closed and reports the configuration problem', () => {
  const result = evaluatePromotionalCadence(gates({
    policy: { minimumSpacingHours: -1, rollingWeekLimit: 0, rollingMonthDays: 0, rollingMonthLimit: 0 }
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.hardBlocked, true);
  assert.ok(result.reasons.includes('frequency_policy_invalid'));
});
