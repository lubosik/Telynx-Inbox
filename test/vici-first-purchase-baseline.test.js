'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceIndex, paidOrderMatches, summarize } = require('../scripts/audit-vici-first-purchase-baseline');

const rows = [
  { wp_user_id: '11', email: 'one@example.test', phone: '+12125550101', woo_paid_order_count: '0' },
  { wp_user_id: '12', email: 'two@example.test', phone: '', woo_paid_order_count: '0' },
  { wp_user_id: '13', email: 'shared@example.test', phone: '', woo_paid_order_count: '0' },
  { wp_user_id: '14', email: 'shared@example.test', phone: '', woo_paid_order_count: '0' },
];

test('paid Woo order uses stable customer ID before email and excludes unpaid statuses', () => {
  const index = sourceIndex(rows);
  const paid = { id: 201, customer_id: 11, status: 'processing', date_paid_gmt: '2026-10-01T19:00:00',
    billing: { email: 'wrong@example.test' } };
  assert.equal(paidOrderMatches(paid, index).wp_user_id, '11');
  assert.equal(paidOrderMatches({ ...paid, status: 'on-hold' }, index), null);
  assert.equal(paidOrderMatches({ ...paid, date_paid_gmt: null }, index), null);
});

test('guest email fallback refuses ambiguous accounts and counts each buyer once', () => {
  const index = sourceIndex(rows);
  const order = (id, email) => ({ id, customer_id: 0, status: 'completed',
    date_paid_gmt: '2026-10-01T19:00:00', billing: { email } });
  assert.equal(paidOrderMatches(order(1, 'shared@example.test'), index), null);
  assert.equal(paidOrderMatches(order(2, 'two@example.test'), index).wp_user_id, '12');
  assert.deepEqual(summarize(rows, [order(2, 'two@example.test'), order(3, 'two@example.test')]), {
    sourceCohort: 4, sourcePhoneUsers: 1, nowWithFirstPaidOrder: 1,
    phoneUsersNowWithFirstPaidOrder: 0, stillWithoutPaidOrder: 3,
    phoneUsersStillWithoutPaidOrder: 1,
    note: 'This is a refreshed fixed nonbuyer cohort, not a registration-to-purchase conversion rate.'
  });
});
