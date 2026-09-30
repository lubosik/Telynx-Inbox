'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { literalIlikePattern, latestConversationMatches } = require('../lib/inbox-message-search');

test('message search uses literal case-insensitive phrase and digit matching', () => {
  const rows = [
    { id: 4, contact_phone: '+1001', body: 'Order 8063466791 is ready' },
    { id: 3, contact_phone: '+1002', body: 'Apple Pay now works' },
    { id: 2, contact_phone: '+1002', body: 'apple pay was requested' },
    { id: 1, contact_phone: '+1003', body: 'Apple   Pay' }
  ];
  assert.deepEqual(latestConversationMatches(rows, 'apple pay').map(row => row.id), [3]);
  assert.deepEqual(latestConversationMatches(rows, '346679').map(row => row.id), [4]);
  assert.deepEqual(latestConversationMatches(rows, 'apple%pay'), []);
  assert.deepEqual(latestConversationMatches(rows, 'apple_pay'), []);
});

test('SQL filter escapes LIKE wildcards and backslashes', () => {
  assert.equal(literalIlikePattern('20%_off\\now'), '%20\\%\\_off\\\\now%');
});

test('search is permissioned and listed before the phone route', () => {
  const root = path.resolve(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'routes/conversations.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'ios/ViciInbox/UI/InboxViews.swift'), 'utf8');
  const { ROUTE_POLICY } = require('../lib/route-policy');
  assert.ok(route.indexOf("router.get('/search'") < route.indexOf("router.get('/:phone'"));
  assert.ok(ROUTE_POLICY.some(row => row.method === 'GET' && row.path === '/api/conversations/search' && row.permission === 'conversation.read'));
  assert.match(client, /conversation\.lastMessage\?\.createdAt/);
  assert.doesNotMatch(client.slice(client.indexOf('func fetchConversations()'), client.indexOf('func searchConversationMessages(')), /conversation\.lastSeen|conversation\.latestOrderDate/);
  assert.match(view, /Name, phone, or message/);
  assert.match(view, /New contact · no messages yet/);
  assert.match(view, /selectedMatchIDs\[conversation\.phone\] = matchByPhone\[conversation\.phone\]\?\.id\.rawValue/);
  assert.match(view, /proxy\.scrollTo\(focusMessageID, anchor: \.center\)/);
});
