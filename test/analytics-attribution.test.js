'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyPaymentRecovery,
  isActualReminder,
  isPaymentConfirmation
} = require('../lib/analytics/attribution');

const reminder = {
  id: 9,
  order_id: '18472',
  flow_type: 'hold-msg1',
  telnyx_message_id: 'message-1',
  delivery_status: 'delivered',
  sent_at: '2026-08-01T14:02:00.000Z',
  message_body: 'Payment reminder'
};

const order = {
  id: '18472',
  total: '219.00',
  refunded_amount: 0,
  date_paid_gmt: '2026-08-01T14:17:00.000Z'
};

test('classifies exact reminder + confirmation + payment as 100% Direct', () => {
  const result = classifyPaymentRecovery({
    order,
    reminders: [reminder],
    inboundMessages: [{ id: 21, body: 'Sent, thanks', created_at: '2026-08-01T14:11:00.000Z' }]
  });
  assert.equal(result.confidenceLevel, 'direct');
  assert.equal(result.confidenceScore, 1);
  assert.equal(result.netAmount, 219);
  assert.equal(result.evidence.paymentConfirmationMessageID, '21');
});

test('classifies exact payment inside strong window as 90% Strong', () => {
  const result = classifyPaymentRecovery({ order, reminders: [reminder] });
  assert.equal(result.confidenceLevel, 'strong');
  assert.equal(result.confidenceScore, 0.9);
});

test('does not force payment after the conservative recovery window into Influenced', () => {
  const result = classifyPaymentRecovery({
    order: { ...order, date_paid_gmt: '2026-08-02T20:02:00.000Z' },
    reminders: [reminder]
  });
  assert.equal(result.confidenceLevel, 'unattributed');
  assert.equal(result.confidenceScore, 0);
});

test('leaves uncertain or out-of-window orders Unattributed', () => {
  const noReminder = classifyPaymentRecovery({ order, reminders: [] });
  const tooLate = classifyPaymentRecovery({
    order: { ...order, date_paid_gmt: '2026-08-05T14:03:00.000Z' },
    reminders: [reminder]
  });
  assert.equal(noReminder.confidenceLevel, 'unattributed');
  assert.equal(tooLate.confidenceLevel, 'unattributed');
  assert.equal(tooLate.confidenceScore, 0);
});

test('does not treat backfill sentinels, wrong orders, or post-payment replies as evidence', () => {
  assert.equal(isActualReminder({ ...reminder, message_body: 'BACKFILL SKIPPED' }), false);
  const result = classifyPaymentRecovery({
    order,
    reminders: [{ ...reminder, order_id: 'wrong' }],
    inboundMessages: [{ id: 5, body: 'Paid', created_at: '2026-08-01T15:00:00.000Z' }]
  });
  assert.equal(result.confidenceLevel, 'unattributed');
});

test('requires delivered evidence, an identity match, and an unambiguous order', () => {
  const notDelivered = classifyPaymentRecovery({ order, reminders: [{ ...reminder, delivery_status: 'sent' }] });
  const mismatch = classifyPaymentRecovery({ order, reminders: [reminder], identityMatched: false });
  const ambiguous = classifyPaymentRecovery({ order, reminders: [reminder], ambiguousOrderMatch: true });
  assert.equal(notDelivered.confidenceLevel, 'unattributed');
  assert.equal(mismatch.confidenceLevel, 'unattributed');
  assert.equal(ambiguous.confidenceLevel, 'unattributed');
});

test('subtracts partial refunds and caps over-refunds at gross revenue', () => {
  const partial = classifyPaymentRecovery({
    order: { ...order, refunded_amount: 19 },
    reminders: [reminder]
  });
  const full = classifyPaymentRecovery({
    order: { ...order, refunded_amount: 999 },
    reminders: [reminder]
  });
  assert.equal(partial.netAmount, 200);
  assert.equal(full.refundedAmount, 219);
  assert.equal(full.netAmount, 0);
});

test('confirmation matching is intentionally narrow', () => {
  assert.equal(isPaymentConfirmation('Just sent it, thanks'), true);
  assert.equal(isPaymentConfirmation("I've paid"), true);
  assert.equal(isPaymentConfirmation('I’ve paid'), true);
  assert.equal(isPaymentConfirmation('Are you saying the order was paid?'), false);
  assert.equal(isPaymentConfirmation('I will send it tomorrow'), false);
  assert.equal(isPaymentConfirmation('Done thinking about it'), false);
  assert.equal(isPaymentConfirmation('Sent but I have a question'), false);
});
