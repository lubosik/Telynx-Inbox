'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReferralService } = require('../lib/referrals/service');

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-08-24T12:00:00Z');

function actor(overrides = {}) {
  const permissions = new Set(['referral.read', 'referral.create', 'referral.act', 'conversation.read', 'message.send']);
  return { id: 7, displayName: 'Gregory', role: 'agent', permissions, can: key => permissions.has(key), ...overrides };
}

function row(overrides = {}) {
  return {
    id: ID, workspace_id: 'vici', contact_phone: '+13055550123',
    referred_by_user_id: 7, target_kind: 'directed', original_target_user_id: 8,
    owner_user_id: null, state: 'pending', initial_note: 'Pricing question',
    claimed_at: null, resolved_at: null, resolved_by_user_id: null,
    created_at: '2026-08-24T11:00:00Z', updated_at: '2026-08-24T11:00:00Z', version: 1,
    ...overrides
  };
}

function fakeStore(overrides = {}) {
  const users = [
    { id: 7, display_name: 'Gregory', role: 'agent', last_seen_at: '2026-08-24T10:00:00Z' },
    { id: 8, display_name: 'Dominic', role: 'admin', last_seen_at: '2026-08-24T11:00:00Z' },
    { id: 9, display_name: 'Lubosi', role: 'owner', last_seen_at: null }
  ];
  return {
    eligibleUsers: async () => users,
    contextFor: async rows => ({
      users: new Map(users.map(user => [String(user.id), user])),
      contacts: new Map([['+13055550123', { phone: '+13055550123', name: 'Nessa' }]])
    }),
    listRows: async () => [row()],
    getRow: async () => row(),
    getEvents: async () => [],
    create: async input => row({ target_kind: input.targetKind, original_target_user_id: input.targetUserID }),
    claim: async () => row({ state: 'owned', owner_user_id: 8, claimed_at: '2026-08-24T12:00:00Z', version: 2 }),
    reassign: async input => row({ state: 'owned', owner_user_id: input.targetUserID, claimed_at: '2026-08-24T11:30:00Z', version: 3 }),
    handBack: async () => row({ state: 'owned', owner_user_id: 7, claimed_at: '2026-08-24T11:30:00Z', version: 3 }),
    resolve: async () => row({ state: 'resolved', owner_user_id: 8, claimed_at: '2026-08-24T11:30:00Z', resolved_at: '2026-08-24T12:00:00Z', resolved_by_user_id: 8, version: 3 }),
    ...overrides
  };
}

test('recipient picker excludes the caller and marks only owner/admin for Any Admin', async () => {
  const result = await createReferralService({ store: fakeStore(), now: () => NOW }).recipients(actor());
  assert.deepEqual(result.map(item => [item.name, item.canReceiveAnyAdmin]), [
    ['Dominic', true], ['Lubosi', true]
  ]);
});

test('directed referral prepares exactly one internal push and preserves the conversation', async () => {
  const result = await createReferralService({ store: fakeStore(), now: () => NOW }).create({
    contactPhone: '+13055550123', targetKind: 'directed', targetUserId: '8', note: 'Pricing question'
  }, actor());
  assert.equal(result.referral.contactName, 'Nessa');
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].userID, '8');
  assert.equal(result.notifications[0].payload.phone, '+13055550123');
  assert.equal(result.notifications[0].payload.aps.alert.body, 'Pricing question');
});

test('Any Admin is explicit and prepares one push per eligible admin', async () => {
  const result = await createReferralService({ store: fakeStore(), now: () => NOW }).create({
    contactPhone: '+13055550123', targetKind: 'any_admin'
  }, actor());
  assert.deepEqual(result.notifications.map(item => item.userID), ['8', '9']);
});

test('legacy shared sessions are refused before touching the store', async () => {
  let touched = false;
  const service = createReferralService({ store: fakeStore({ eligibleUsers: async () => { touched = true; return []; } }) });
  await assert.rejects(
    service.recipients(actor({ id: 1, role: 'admin', isLegacyShared: true, viaLegacySession: true })),
    error => error.code === 'REFERRAL_NAMED_ACCOUNT_REQUIRED'
  );
  assert.equal(touched, false);
});

test('a Support Agent cannot read somebody else’s referral by guessing its id', async () => {
  const service = createReferralService({
    store: fakeStore({ getRow: async () => row({ referred_by_user_id: 4, original_target_user_id: 8 }) })
  });
  await assert.rejects(service.get(ID, actor()), error => error.code === 'REFERRAL_NOT_FOUND');
});

test('a pending referral older than 30 minutes is surfaced as needing attention', async () => {
  const result = await createReferralService({ store: fakeStore(), now: () => NOW }).list({}, actor());
  assert.equal(result.items[0].attentionRequired, true);
  assert.deepEqual(Object.keys(result), ['items'], 'internal lookup context must not reach the API response');
});

test('hand-back requires a note before the database RPC is called', async () => {
  let called = false;
  const service = createReferralService({ store: fakeStore({ handBack: async () => { called = true; } }) });
  await assert.rejects(service.handBack(ID, {}, actor()), error => error.code === 'REFERRAL_NOTE_REQUIRED');
  assert.equal(called, false);
});

test('resolve tells the original referrer but never sends to the resolving actor', async () => {
  const result = await createReferralService({ store: fakeStore() }).resolve(ID, actor({
    id: 8, displayName: 'Dominic', role: 'admin'
  }));
  assert.deepEqual(result.notifications.map(item => item.userID), ['7']);
  assert.equal(result.notifications[0].eventType, 'referrals.resolved');
});
