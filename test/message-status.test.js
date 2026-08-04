'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseTelnyxStatus,
  shouldAdvanceStatus,
  retrieveTelnyxMessage,
  presentExpiredQueuedAsUnavailable
} = require('../lib/message-status');

test('normalises Telnyx SMS lifecycle states without claiming a read', () => {
  assert.equal(normaliseTelnyxStatus('queued'), 'queued');
  assert.equal(normaliseTelnyxStatus('sending'), 'queued');
  assert.equal(normaliseTelnyxStatus('sent'), 'sent');
  assert.equal(normaliseTelnyxStatus('delivery_unconfirmed'), 'sent');
  assert.equal(normaliseTelnyxStatus('delivered'), 'delivered');
  assert.equal(normaliseTelnyxStatus('delivery_failed'), 'failed');
  assert.equal(normaliseTelnyxStatus('status_unavailable'), 'unavailable');
  assert.equal(normaliseTelnyxStatus('read', null), null);
});

test('presents expired queued rows honestly without mutating stored objects', () => {
  const now = Date.parse('2026-08-04T18:00:00Z');
  const old = { direction: 'outbound', status: 'queued', created_at: '2026-07-20T18:00:00Z' };
  const recent = { direction: 'outbound', status: 'queued', created_at: '2026-08-04T17:00:00Z' };
  const presented = presentExpiredQueuedAsUnavailable([old, recent], now);
  assert.equal(presented[0].status, 'unavailable');
  assert.equal(presented[1].status, 'queued');
  assert.equal(old.status, 'queued');
});

test('status updates advance and cannot be downgraded by late callbacks', () => {
  assert.equal(shouldAdvanceStatus('queued', 'sent'), true);
  assert.equal(shouldAdvanceStatus('queued', 'delivered'), true);
  assert.equal(shouldAdvanceStatus('sent', 'delivered'), true);
  assert.equal(shouldAdvanceStatus('delivered', 'sent'), false);
  assert.equal(shouldAdvanceStatus('failed', 'sent'), false);
  assert.equal(shouldAdvanceStatus('sent', 'queued'), false);
  assert.equal(shouldAdvanceStatus('queued', 'unavailable'), true);
});

test('retrieves the recipient status without returning message content', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        text: 'private message body',
        completed_at: '2026-08-04T16:41:00Z',
        to: [{ phone_number: '+15555550123', status: 'delivered' }]
      }
    })
  });
  const result = await retrieveTelnyxMessage('message-id', fakeFetch);
  assert.deepEqual(result, { status: 'delivered', updatedAt: '2026-08-04T16:41:00Z' });
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.equal(Object.hasOwn(result, 'phone_number'), false);
});
