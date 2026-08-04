'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isInternalSIPLog,
  finalCallStatus,
  answeredAtFromDuration
} = require('../lib/call-status');

test('hides the Telnyx transfer leg but keeps real phone and client logs', () => {
  assert.equal(isInternalSIPLog({ to_number: 'sip:agent@sip.telnyx.com' }), true);
  assert.equal(isInternalSIPLog({ to_number: '+13055550123' }), false);
  assert.equal(isInternalSIPLog({ to_number: null }), false);
});

test('does not treat the backend greeting answer as an operator answer', () => {
  assert.equal(finalCallStatus({ direction: 'inbound', currentStatus: 'connecting', answeredAt: null }), 'missed');
  assert.equal(finalCallStatus({ direction: 'outbound', currentStatus: 'initiated', answeredAt: null }), 'failed');
});

test('preserves a successful native-client outcome when hangup races it', () => {
  assert.equal(finalCallStatus({ direction: 'inbound', currentStatus: 'completed', answeredAt: null }), 'completed');
  assert.equal(finalCallStatus({ direction: 'inbound', currentStatus: 'answered', answeredAt: '2026-08-04T19:04:30Z' }), 'completed');
});

test('derives the connected timestamp from the native duration', () => {
  assert.equal(answeredAtFromDuration('2026-08-04T19:05:00Z', 42), '2026-08-04T19:04:18.000Z');
  assert.equal(answeredAtFromDuration('invalid', 42), null);
  assert.equal(answeredAtFromDuration('2026-08-04T19:05:00Z', 0), null);
});
