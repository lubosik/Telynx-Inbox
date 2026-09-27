'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validatePaymentTemplates, loadPaymentTemplates,
  renderPaymentTemplate } = require('../lib/automation/payment-templates');

test('all six payment reminder defaults are valid editable templates', () => {
  assert.deepEqual(validatePaymentTemplates(DEFAULTS), DEFAULTS);
});

test('payment editor rejects unknown fields and removal of an existing STOP footer', () => {
  assert.throws(() => validatePaymentTemplates({ ...DEFAULTS,
    'hold-msg1': 'Hey {{first_name}}, pay {{secret}}.' }), /Payment reminder 1/);
  assert.throws(() => validatePaymentTemplates({ ...DEFAULTS,
    'hold-msg2': 'Hey {{first_name}}, pay our {{method}} address {{handle}}.' }), /Payment reminder 2/);
  assert.throws(() => validatePaymentTemplates({ ...DEFAULTS,
    'failed-msg1': 'Hey {{first_name}}, try again.' }), /Card retry 1/);
  assert.throws(() => validatePaymentTemplates({ ...DEFAULTS,
    'failed-msg3': 'Hey {{first_name}}, use NEW20 for 20% off: {{checkout_url}}' }), /Card retry 3/);
});

test('no migration means existing payment copy continues and editor is unavailable', async () => {
  const client = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: null, error: { code: 'PGRST204', message: 'payment_reminder_templates missing' }
    }) }) })
  }) };
  const settings = await loadPaymentTemplates(client);
  assert.equal(settings.available, false);
  assert.equal(settings.overrides, null);
  assert.equal(renderPaymentTemplate('hold-msg1', settings.overrides, {}, 'existing body'), 'existing body');
});

test('saved payment copy renders customer and order facts without raw placeholders', () => {
  const message = renderPaymentTemplate('hold-msg1', DEFAULTS, {
    first_name: 'Ana', order_description: 'orders #123 and #456', balance: '250.00',
    method: 'Venmo', handle: '@ViciPeptides'
  }, 'fallback');
  assert.match(message, /Ana/);
  assert.match(message, /orders #123 and #456/);
  assert.match(message, /\$250\.00/);
  assert.match(message, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(message, /{{/);
});
