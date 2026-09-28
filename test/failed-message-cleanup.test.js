'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hideFailedInboxMessage } = require('../lib/failed-message-cleanup');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('failed cleanup scopes the atomic call to one saved message and conversation', async () => {
  let called;
  const result = await hideFailedInboxMessage({ id: '42', phone: '+15555550100',
    client: { rpc: async (name, args) => { called = { name, args }; return { data: true, error: null }; } } });
  assert.deepEqual(called, { name: 'hide_failed_inbox_message', args: { p_id: 42, p_phone: '+15555550100' } });
  assert.deepEqual(result, { hidden: true, messageID: 42 });
});

test('invalid identifiers never touch storage', async () => {
  for (const id of ['NaN', '-1', '1.5', '9007199254740992']) {
    await assert.rejects(hideFailedInboxMessage({ id, phone: '+15555550100',
      client: { rpc: () => { throw Error('must not run'); } } }), error => error.status === 400);
  }
});

test('delivered, inbound, missing and unavailable storage produce plain English errors', async () => {
  for (const [error, status, pattern] of [
    [{ code: 'P0001', message: 'message_not_failed' }, 409, /Only an outbound message confirmed as failed/],
    [{ code: 'P0002', message: 'message_not_found' }, 404, /not found in this conversation/],
    [{ code: 'PGRST202', message: 'secret internal detail' }, 503, /database update/]
  ]) {
    await assert.rejects(hideFailedInboxMessage({ id: 42, phone: '+15555550100',
      client: { rpc: async () => ({ error }) } }), e => e.status === status && pattern.test(e.message));
  }
});

test('cleanup preserves audit evidence and does not delete or resend anything', () => {
  const sql = source('scripts/failed-message-cleanup-migration.sql');
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /direction <> 'outbound'/);
  assert.match(sql, /NOT IN \('failed','sending_failed','delivery_failed'\)/);
  assert.match(sql, /hidden_at = coalesce\(hidden_at,now\(\)\)/);
  assert.doesNotMatch(sql, /DELETE FROM|DROP TABLE/);
  const routes = source('routes/conversations.js');
  assert.match(routes, /filter: query => query\.is\('hidden_at', null\)/);
  assert.match(routes, /\.eq\('contact_phone', phone\)\s*\.is\('hidden_at', null\)/);
});

test('the native message menu exposes confirmed failure cleanup with confirmation', () => {
  const view = source('ios/ViciInbox/UI/InboxViews.swift');
  assert.match(view, /Delete failed message/);
  assert.match(view, /canDeleteFailed && !message\.isInbound/);
  assert.match(view, /confirmationDialog\("Delete this failed message/);
});
