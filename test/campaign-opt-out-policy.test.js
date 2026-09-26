'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { requiresOptOutFooter } = require('../lib/campaigns/opt-out-policy');
const { assertReviewableCopy } = require('../lib/campaigns/service');

const WITHOUT_FOOTER = "Vin from Vici: Hi {{first_name}}, how are you finding everything?";

test('only VIP and automatic check-in workflows may omit the repeated footer', () => {
  assert.equal(requiresOptOutFooter('vip'), false);
  assert.equal(requiresOptOutFooter('vip_welcome'), false);
  assert.equal(requiresOptOutFooter('vip_reorder'), false);
  assert.equal(requiresOptOutFooter('checkin_21d'), false);
  assert.equal(requiresOptOutFooter('manual'), true);
  assert.equal(requiresOptOutFooter('winback'), true);
  assert.equal(requiresOptOutFooter(undefined), true);
});

test('the validator exception is explicit and defaults closed', () => {
  assert.equal(validateCopy(WITHOUT_FOOTER).ok, false);
  assert.ok(validateCopy(WITHOUT_FOOTER).failedChecks.includes('exact_opt_out_suffix'));
  const allowed = validateCopy(WITHOUT_FOOTER, { requireOptOut: false });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.failures));
});

test('the campaign review gate applies the exception from server-owned workflow identity', () => {
  assert.doesNotThrow(() => assertReviewableCopy(WITHOUT_FOOTER, { workflowCategory: 'vip' }));
  assert.doesNotThrow(() => assertReviewableCopy(WITHOUT_FOOTER, { workflowCategory: 'checkin_21d' }));
  assert.throws(() => assertReviewableCopy(WITHOUT_FOOTER, { workflowCategory: 'manual' }),
    error => error.code === 'CAMPAIGN_COPY_NOT_REVIEWABLE');
});

test('VIP is treated as a customer-tier initialism rather than all-caps shouting', () => {
  const message = "Hi {{first_name}}, it's Vin from Vici. You're now one of our VIP customers. What would be most helpful for you right now?";
  const verdict = validateCopy(message, { requireOptOut: false });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  assert.doesNotThrow(() => assertReviewableCopy(message, { workflowCategory: 'vip_welcome' }));
});
