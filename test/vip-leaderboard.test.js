'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCORE_VERSION,
  buildVIPLeaderboard,
  eligibleOrders
} = require('../lib/analytics/vip-leaderboard');

const EMPTY_EXCLUSIONS = { phones: new Set(), orderIDs: new Set() };
const RANGE = {
  period: 'week',
  start: new Date('2026-09-21T04:00:00.000Z'),
  end: new Date('2026-09-26T16:00:00.000Z'),
  timeZone: 'America/New_York',
  previous: null
};

function contact(number, name = `Customer ${number}`) {
  return { id: number, phone: `+15550000${String(number).padStart(3, '0')}`, name };
}

function order(person, number, total, createdAt = '2026-09-24T14:00:00.000Z', status = 'completed') {
  return {
    id: `${person}-${number}`, woo_order_id: `${person}0${number}`,
    contact_phone: contact(person).phone, status, total, created_at: createdAt
  };
}

function lifetimeOrders(person, period = []) {
  return [
    order(person, 1, 200, '2026-01-10T12:00:00.000Z'),
    order(person, 2, 200, '2026-03-10T12:00:00.000Z'),
    order(person, 3, 200, '2026-05-10T12:00:00.000Z'),
    ...period
  ];
}

test('VIP leaderboard uses the selected period and equal-weight paid-order value score', () => {
  const contacts = [contact(1, 'Frequent'), contact(2, 'Large orders')];
  const orders = [
    ...lifetimeOrders(1, [order(1, 4, 100), order(1, 5, 100), order(1, 6, 100)]),
    ...lifetimeOrders(2, [order(2, 4, 500)])
  ];
  const result = buildVIPLeaderboard({ contacts, orders, range: RANGE, exclusions: EMPTY_EXCLUSIONS });
  assert.equal(result.totalVipCustomers, 2);
  assert.equal(result.activeVipCustomers, 2);
  assert.equal(result.leaders[0].customerName, 'Large orders');
  assert.equal(result.leaders[0].paidOrders, 1);
  assert.equal(result.leaders[0].totalSpend, 500);
  assert.equal(result.leaders[0].averageOrderValue, 500);
  assert.equal(result.leaders[1].paidOrders, 3);
  assert.ok(result.leaders.every(row => row.score >= 0 && row.score <= 100));
  assert.equal(SCORE_VERSION, 'vip_value_rank_v1');
});

test('rankings change with the period and omit VIPs without activity in that period', () => {
  const contacts = [contact(1, 'Today buyer'), contact(2, 'Earlier buyer')];
  const orders = [
    ...lifetimeOrders(1, [order(1, 4, 180, '2026-09-26T15:00:00.000Z')]),
    ...lifetimeOrders(2, [order(2, 4, 700, '2026-09-22T15:00:00.000Z')])
  ];
  const today = { ...RANGE, period: 'today', start: new Date('2026-09-26T04:00:00.000Z') };
  const result = buildVIPLeaderboard({ contacts, orders, range: today, exclusions: EMPTY_EXCLUSIONS });
  assert.deepEqual(result.leaders.map(row => row.customerName), ['Today buyer']);
  assert.equal(result.totalVipCustomers, 2);
  assert.equal(result.activeVipCustomers, 1);
});

test('paid rows are deduplicated and failed, cancelled, staff and test orders never rank', () => {
  const staff = contact(9, 'Staff');
  const customer = contact(1, 'Real customer');
  const duplicated = order(1, 4, 250);
  const orders = [
    ...lifetimeOrders(1, [duplicated, { ...duplicated, id: 'duplicate-webhook' },
      order(1, 5, 999, '2026-09-25T14:00:00.000Z', 'failed'),
      order(1, 6, 999, '2026-09-25T14:00:00.000Z', 'cancelled')]),
    ...lifetimeOrders(9, [order(9, 4, 900)])
  ];
  const exclusions = { phones: new Set([staff.phone]), orderIDs: new Set() };
  const result = buildVIPLeaderboard({ contacts: [customer, staff], orders, range: RANGE, exclusions });
  assert.equal(result.totalVipCustomers, 1);
  assert.equal(result.leaders.length, 1);
  assert.equal(result.leaders[0].paidOrders, 1);
  assert.equal(result.leaders[0].totalSpend, 250);
});

test('manual VIP additions rank but do not weaken the permanent automatic definition', () => {
  const automatic = contact(1, 'Automatic');
  const manual = contact(2, 'Manual');
  const standard = contact(3, 'Standard');
  const orders = [
    ...lifetimeOrders(1, [order(1, 4, 100)]),
    order(2, 1, 90),
    order(3, 1, 1000)
  ];
  const result = buildVIPLeaderboard({
    contacts: [automatic, manual, standard], orders, range: RANGE,
    manuallyIncluded: new Set([manual.phone]), exclusions: EMPTY_EXCLUSIONS
  });
  assert.deepEqual(new Set(result.leaders.map(row => row.customerName)), new Set(['Automatic', 'Manual']));
  assert.equal(result.totalVipCustomers, 2);
});

test('leaderboard is capped at ten with deterministic ranks', () => {
  const contacts = Array.from({ length: 12 }, (_, index) => contact(index + 1));
  const orders = contacts.flatMap((_, index) => lifetimeOrders(index + 1,
    [order(index + 1, 4, 100 + index)]));
  const result = buildVIPLeaderboard({ contacts, orders, range: RANGE, exclusions: EMPTY_EXCLUSIONS });
  assert.equal(result.activeVipCustomers, 12);
  assert.equal(result.leaders.length, 10);
  assert.deepEqual(result.leaders.map(row => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('order exclusion may remove one order without hiding a legitimate customer', () => {
  const person = contact(1, 'Customer');
  const excluded = order(1, 4, 999);
  const included = order(1, 5, 120);
  const rows = eligibleOrders([...lifetimeOrders(1), excluded, included], {
    phones: new Set(), orderIDs: new Set([excluded.woo_order_id])
  });
  assert.equal(rows.some(row => row.woo_order_id === excluded.woo_order_id), false);
  assert.equal(rows.some(row => row.woo_order_id === included.woo_order_id), true);
  assert.ok(person.phone);
});
