'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render, worstCase } = require('../lib/campaigns/merge-fields');
const { WELCOME_MESSAGE } = require('../lib/campaigns/vip-welcome-automation');
const { validateCopy } = require('../lib/campaigns/copy-validator');

test('VIP loyalty copy uses the earliest recorded paid history, not an invented tenure', () => {
  const result = render(WELCOME_MESSAGE, {
    contactName: 'Jess Smith',
    orderHistory: [{ created_at: '2026-09-01T12:00:00Z' }, { created_at: '2026-03-15T12:00:00Z' }]
  });
  assert.deepEqual(result.missing, []);
  assert.match(result.text, /ordering since March 2026/);
  assert.match(result.text, /Want your code\?$/);
});

test('VIP loyalty refuses missing or invalid purchase dates', () => {
  assert.deepEqual(render('{{loyalty_since}}', {}).missing, ['loyalty_since']);
  assert.deepEqual(render('{{loyalty_since}}', { orderHistory: [{ created_at: 'invalid' }] }).missing, ['loyalty_since']);
});

test('VIP welcome remains within the shared copy rules at the longest substitutions', () => {
  assert.ok(worstCase(WELCOME_MESSAGE).length <= 306);
  const result = validateCopy(WELCOME_MESSAGE, { requireOptOut: false });
  assert.equal(result.ok, true, JSON.stringify(result));
});
