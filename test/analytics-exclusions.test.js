'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyticsExclusions,
  excludeAnalyticsSource,
  isExcludedIdentity
} = require('../lib/analytics/exclusions');

test('staff phones and order IDs are removed from every aggregate source', () => {
  const exclusions = analyticsExclusions({
    ANALYTICS_EXCLUDED_PHONES: '+15550000001',
    ANALYTICS_EXCLUDED_ORDER_IDS: 'staff-order'
  });
  const source = excludeAnalyticsSource({
    messages: [
      { id: 'staff-message', contact_phone: '+15550000001' },
      { id: 'customer-message', contact_phone: '+15550000002' }
    ],
    reminders: [
      { id: 'staff-reminder', phone: '+15550000001', order_id: 'normal' },
      { id: 'customer-reminder', phone: '+15550000002', order_id: 'normal' }
    ],
    calls: [{ id: 'staff-call', contact_phone: '+15550000001' }],
    attributions: [
      { id: 'staff-attribution', order_id: 'staff-order', contact_phone: '+15550000002' },
      { id: 'customer-attribution', order_id: 'customer-order', contact_phone: '+15550000002' }
    ],
    recoveryAttributions: [{ id: 'staff-recovery', order_id: 'staff-order' }],
    sentiments: [
      { id: 'staff-sentiment', message_id: 'staff-message' },
      { id: 'customer-sentiment', message_id: 'customer-message' }
    ]
  }, exclusions);
  assert.deepEqual(source.messages.map(row => row.id), ['customer-message']);
  assert.deepEqual(source.reminders.map(row => row.id), ['customer-reminder']);
  assert.equal(source.calls.length, 0);
  assert.deepEqual(source.attributions.map(row => row.id), ['customer-attribution']);
  assert.equal(source.recoveryAttributions.length, 0);
  assert.deepEqual(source.sentiments.map(row => row.id), ['customer-sentiment']);
  assert.equal(isExcludedIdentity({ phone: '(555) 000-0001' }, exclusions), true);
});
