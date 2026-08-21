'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectReleaseTargets, deviceBuild } = require('../lib/release-targets');

const AGENT_21 = 'Vici%20Inbox/21 CFNetwork/3860.700.1 Darwin/25.6.0';
const AGENT_20 = 'Vici%20Inbox/20 CFNetwork/3860.700.1 Darwin/25.6.0';

function device(overrides = {}) {
  return {
    id: 1,
    device_token: 'a'.repeat(64),
    environment: 'production',
    bundle_id: 'com.vicipeptides.inbox',
    user_id: null,
    app_build: null,
    user_agent: AGENT_21,
    ...overrides
  };
}

test('reads the build from the explicit field first, then the User-Agent', () => {
  assert.equal(deviceBuild({ app_build: '22', user_agent: AGENT_20 }), 22);
  assert.equal(deviceBuild({ user_agent: AGENT_21 }), 21);
  assert.equal(deviceBuild({ user_agent: 'Vici Inbox/20 CFNetwork/3860' }), 20);
});

test('an undeterminable build reads as unknown rather than as zero', () => {
  // A User-Agent with no product token of ours: the CFNetwork and Darwin
  // versions must never be mistaken for the app build.
  assert.equal(deviceBuild({ user_agent: 'CFNetwork/3860.700.1 Darwin/25.6.0' }), null);
  assert.equal(deviceBuild({ user_agent: 'CFNetwork/3860 Darwin/25.6.0' }), null);
  assert.equal(deviceBuild({ user_agent: 'Vici Inbox iOS' }), null);
  assert.equal(deviceBuild({ user_agent: '' }), null);
  assert.equal(deviceBuild({}), null);
  assert.equal(deviceBuild({ app_build: 'not-a-build' }), null);
});

test('targets only the named user, and never an unowned device', () => {
  const targets = selectReleaseTargets([
    device({ id: 1, user_id: 'user-dominic', device_token: 'd'.repeat(64) }),
    device({ id: 2, user_id: 'user-lubosi',  device_token: 'l'.repeat(64) }),
    device({ id: 3, user_id: null,           device_token: 'u'.repeat(64) })
  ], { userId: 'user-dominic' });

  const tokens = targets.map(row => row.device_token);
  assert.deepEqual(tokens, ['d'.repeat(64)]);
  // Assert the absence directly: a count check would pass even if the filter
  // returned the wrong single device.
  assert.ok(!tokens.includes('l'.repeat(64)));
  assert.ok(!tokens.includes('u'.repeat(64)));
});

test('targets only devices not already running the new build', () => {
  const targets = selectReleaseTargets([
    device({ id: 1, app_build: '20' }),
    device({ id: 2, app_build: '21' }),
    device({ id: 3, app_build: '22' }),
    device({ id: 4, app_build: '23' })
  ], { belowBuild: 22 });

  assert.deepEqual(targets.map(row => row.id), [1, 2]);
});

test('a device of unknown build is included, never silently skipped', () => {
  const targets = selectReleaseTargets([
    device({ id: 1, app_build: null, user_agent: 'CFNetwork/3860 Darwin/25.6.0' }),  // no product token
    device({ id: 2, app_build: '22' })
  ], { belowBuild: 22 });

  assert.deepEqual(targets.map(row => row.id), [1]);
});

test('user and build filters intersect rather than union', () => {
  const targets = selectReleaseTargets([
    device({ id: 1, user_id: 'user-dominic', app_build: '20' }),
    device({ id: 2, user_id: 'user-dominic', app_build: '22' }),
    device({ id: 3, user_id: 'user-lubosi',  app_build: '20' })
  ], { userId: 'user-dominic', belowBuild: 22 });

  assert.deepEqual(targets.map(row => row.id), [1]);
});

test('an empty selection stays empty and never falls back to everyone', () => {
  const all = [device({ id: 1, user_id: 'user-lubosi' }), device({ id: 2, user_id: 'user-lubosi' })];
  assert.deepEqual(selectReleaseTargets(all, { userId: 'user-nobody' }), []);
  assert.deepEqual(selectReleaseTargets([], { belowBuild: 99 }), []);
  assert.deepEqual(selectReleaseTargets(null, { belowBuild: 99 }), []);
});

test('no filters means every registered device, and rows without a token are dropped', () => {
  const targets = selectReleaseTargets([
    device({ id: 1 }),
    device({ id: 2, device_token: null }),
    device({ id: 3 })
  ], {});
  assert.deepEqual(targets.map(row => row.id), [1, 3]);
});

test('compatibility-storage rows are selected identically to dedicated rows', () => {
  const dedicated = device({ id: 1, user_id: 'user-dominic', app_build: '20' });
  const compatibility = device({ id: 2, user_id: 'user-dominic', app_build: '20', storage: 'compatibility' });
  const filters = { userId: 'user-dominic', belowBuild: 21 };

  assert.equal(selectReleaseTargets([dedicated], filters).length, 1);
  assert.equal(selectReleaseTargets([compatibility], filters).length, 1);
});
