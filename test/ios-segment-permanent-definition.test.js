'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUILDER = fs.readFileSync(
  path.join(ROOT, 'ios/ViciInbox/UI/SegmentRuleBuilderView.swift'),
  'utf8'
);

test('the iOS segment builder explains the permanent Best Repeat Customers definition', () => {
  assert.match(BUILDER, /Best Repeat Customers/);
  assert.match(BUILDER, /3 or more paid orders and \$500 or more in lifetime spend/);
  assert.match(BUILDER, /our best and most repeat customers/);
  assert.match(BUILDER, /Membership updates as paid orders are recorded/);
});
