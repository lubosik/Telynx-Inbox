'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sumUnreadCounts } = require('../lib/unread-count');

test('sums the server-backed unread total used by APNs badges', () => {
  assert.equal(sumUnreadCounts([
    { unread_count: 2 },
    { unread_count: 3 },
    { unread_count: null },
    { unread_count: '1' }
  ]), 6);
});

test('never sends negative, fractional, or malformed badge counts', () => {
  assert.equal(sumUnreadCounts([
    { unread_count: -4 },
    { unread_count: 2.8 },
    { unread_count: 'not-a-number' },
    null
  ]), 2);
  assert.equal(sumUnreadCounts(), 0);
});
