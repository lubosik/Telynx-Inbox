'use strict';
/**
 * Segment change notifications: who gets them, what they say, and the two
 * brakes that keep them off by default.
 *
 * The copy rule is enforced here rather than described: NO EM DASHES in any
 * notification text. The house style forbids them in everything customer and
 * app facing, and a rule that lives only in a comment survives about one
 * release. It is asserted on the preparation module AND at the last boundary
 * before Apple, because those are two different files that a future edit could
 * change independently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  changeBody,
  prepareSegmentChangeNotifications
} = require('../lib/campaigns/segment-notifications');
const {
  prepareCampaignReadyNotifications
} = require('../lib/campaigns/campaign-ready-notifications');

const SEGMENT = { id: 'seg-1', key: 'reorder_due_high_confidence', name: 'Due to reorder, best timing', kind: 'automatic' };

const USERS = [
  { id: 1, role: 'owner', isActive: true, canManageCampaigns: true },
  { id: 2, role: 'admin', isActive: true, canManageCampaigns: true },
  { id: 3, role: 'agent', isActive: true, canManageCampaigns: true },
  { id: 4, role: 'admin', isActive: false, canManageCampaigns: true },
  { id: 5, role: 'admin', isActive: true, canManageCampaigns: false },
  { id: 6, role: 'legacy', isActive: true, canManageCampaigns: true }
];

function apns() {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';
  return require('../lib/apns-notify');
}

/**
 * A Supabase stand-in that answers exactly one question: this account's
 * notification preferences.
 *
 * Injected explicitly rather than left to fall through to the real client. A
 * segment change push is governed by the `daily_digest` preference, which FAILS
 * CLOSED when it cannot be read, so a test that supplied no client would be
 * measuring "the offline database refused" rather than the targeting rule it
 * claims to be about. It would also spend seven seconds waiting for a DNS
 * failure, which is how this fake came to be written.
 *
 * @param {object} [byUser] account id -> partial preference row
 */
function preferenceClient(byUser = {}) {
  return {
    from() {
      const state = { ids: [] };
      const builder = {
        select() { return builder; },
        in(_column, values) { state.ids = values; return builder; },
        then(onFulfilled, onRejected) {
          return Promise.resolve()
            .then(() => ({
              data: state.ids.map(id => ({
                user_id: id,
                new_customer_messages: true,
                missed_calls: true,
                daily_digest: true,
                campaign_proposals: true,
                new_releases: true,
                ...(byUser[String(id)] || {})
              })),
              error: null
            }))
            .then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
}

// ── Targeting ───────────────────────────────────────────────────────────────

test('only active Owners and Admins who can manage campaigns are notified', () => {
  const prepared = prepareSegmentChangeNotifications({
    users: USERS,
    segment: SEGMENT,
    change: { reason: 'recomputed', memberCount: 42, joinedCount: 6, leftCount: 2 }
  });
  assert.deepEqual(prepared.map(row => row.userID), ['1', '2']);
  // A Support Agent is deliberately excluded even though they may READ a
  // segment: reading one on request is not the same as being paged about it.
  assert.equal(prepared.some(row => row.userID === '3'), false);
  // So is the shared legacy identity, for the same reason campaign review
  // alerts exclude it: two people share it and neither owns the device.
  assert.equal(prepared.some(row => row.userID === '6'), false);
});

test('the campaign auto-draft push already reaches Owners and Admins', () => {
  // Requirement 4 asks for a push when a campaign is auto-drafted. That path
  // already exists; this asserts it actually covers the two roles named,
  // rather than assuming it.
  const prepared = prepareCampaignReadyNotifications({
    users: USERS.map(user => ({ ...user, canApproveCampaigns: user.canManageCampaigns })),
    drafts: [{ id: 'c1', status: 'draft', workflowCategory: 'reorder' }],
    generatedAt: new Date('2026-08-23T12:00:00.000Z')
  });
  assert.deepEqual(prepared.map(row => row.userID), ['1', '2']);
  assert.equal(prepared[0].payload.screen, 'campaigns');
});

test('a segment with no id or no name notifies nobody', () => {
  for (const segment of [{}, { id: 'seg-1' }, { name: 'x' }]) {
    assert.deepEqual(
      prepareSegmentChangeNotifications({ users: USERS, segment, change: { memberCount: 1 } }), []
    );
  }
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('no notification copy contains an em dash', () => {
  const bodies = [
    changeBody({ reason: 'created', memberCount: 1, joinedCount: 0, leftCount: 0 }),
    changeBody({ reason: 'created', memberCount: 40, joinedCount: 0, leftCount: 0 }),
    changeBody({ reason: 'recomputed', memberCount: 40, joinedCount: 6, leftCount: 2 }),
    changeBody({ reason: 'recomputed', memberCount: 40, joinedCount: 1, leftCount: 0 }),
    changeBody({ reason: 'recomputed', memberCount: 40, joinedCount: 0, leftCount: 1 }),
    changeBody({ reason: 'recomputed', memberCount: 40, joinedCount: 0, leftCount: 0 })
  ];
  for (const body of bodies) {
    assert.equal(body.includes('—'), false, `em dash in: ${body}`);
    assert.equal(body.includes('–'), false, `en dash in: ${body}`);
    // Two short sentences, which is what the house style asks for instead.
    assert.match(body, /\.\s|\.$/);
  }

  const prepared = prepareSegmentChangeNotifications({
    users: USERS, segment: SEGMENT,
    change: { reason: 'recomputed', memberCount: 42, joinedCount: 6, leftCount: 2 }
  });
  assert.equal(prepared[0].payload.aps.alert.title.includes('—'), false);
  assert.equal(prepared[0].payload.aps.alert.body.includes('—'), false);
});

test('the source files carry no em dash inside a notification string literal', () => {
  // The comment prose in these files may use whatever punctuation it likes.
  // A string that can reach a device may not.
  for (const file of ['lib/campaigns/segment-notifications.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const literals = withoutComments.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
    const offenders = literals.filter(literal =>
      literal.includes('—') &&
      // The guard itself has to name the character it bans.
      literal.length > 3 &&
      !literal.includes('must not contain'));
    assert.deepEqual(offenders, [], `em dash in a string literal in ${file}`);
  }
});

test('a hand-crafted em dash in the copy is refused at preparation time', () => {
  assert.throws(
    () => prepareSegmentChangeNotifications({
      users: USERS,
      segment: { ...SEGMENT, name: 'Reorder — high confidence' },
      change: { reason: 'created', memberCount: 3 }
    }),
    /must not contain an em dash/
  );
});

test('the copy is factual about what moved', () => {
  assert.match(
    changeBody({ reason: 'recomputed', memberCount: 42, joinedCount: 6, leftCount: 2 }),
    /^6 joined and 2 left\. It now holds 42 people\.$/
  );
  assert.match(
    changeBody({ reason: 'recomputed', memberCount: 1, joinedCount: 1, leftCount: 0 }),
    /^1 person joined\. It now holds 1 person\.$/
  );
  assert.match(
    changeBody({ reason: 'created', memberCount: 12, joinedCount: 0, leftCount: 0 }),
    /^It starts with 12 people\./
  );
});

// ── Delivery ────────────────────────────────────────────────────────────────

test('the segment payload is rejected when it is malformed or carries a dash', () => {
  const { segmentChangePayload } = apns();
  const good = prepareSegmentChangeNotifications({
    users: USERS, segment: SEGMENT, change: { reason: 'created', memberCount: 3 }
  })[0];
  assert.ok(segmentChangePayload(good));
  assert.equal(segmentChangePayload({ ...good, channel: 'something_else' }), null);
  assert.equal(segmentChangePayload({
    ...good, payload: { ...good.payload, segmentID: '' }
  }), null);
  assert.equal(segmentChangePayload({
    ...good, payload: { ...good.payload, memberCount: -1 }
  }), null);
  // The last line of defence for the copy rule.
  assert.equal(segmentChangePayload({
    ...good,
    payload: {
      ...good.payload,
      aps: { ...good.payload.aps, alert: { title: 'A — B', body: good.payload.aps.alert.body } }
    }
  }), null, 'an em dash must not reach a device even if the preparation module changes');
});

test('delivery is off unless the exact lowercase flag is set', async () => {
  const { sendSegmentChangeNotifications } = apns();
  const prepared = prepareSegmentChangeNotifications({
    users: USERS, segment: SEGMENT, change: { reason: 'created', memberCount: 3 }
  });
  const loadDevices = async () => ({ devices: [{ id: 1, user_id: 1, device_token: 't', environment: 'production' }], error: null });
  const client = preferenceClient();

  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes']) {
    const result = await sendSegmentChangeNotifications(
      prepared, { dryRun: false },
      { env: { SEGMENT_CHANGE_NOTIFICATIONS_ENABLED: value }, loadDevices, client }
    );
    assert.equal(result.disabled, true, `flag value ${JSON.stringify(value)} must not enable delivery`);
    assert.equal(result.sent, 0);
    assert.equal(result.reason, 'feature_flag_disabled');
  }
});

test('a dry run resolves targets without sending and without credentials', async () => {
  const { sendSegmentChangeNotifications } = apns();
  const prepared = prepareSegmentChangeNotifications({
    users: USERS, segment: SEGMENT, change: { reason: 'created', memberCount: 3 }
  });
  const result = await sendSegmentChangeNotifications(prepared, { dryRun: true }, {
    env: {},
    client: preferenceClient(),
    loadDevices: async () => ({
      devices: [
        { id: 1, user_id: 1, device_token: 'a', environment: 'production', bundle_id: 'x' },
        { id: 2, user_id: 2, device_token: 'b', environment: 'production', bundle_id: 'x' },
        { id: 3, user_id: 99, device_token: 'c', environment: 'production', bundle_id: 'x' },
        { id: 4, user_id: null, device_token: 'd', environment: 'production', bundle_id: 'x' }
      ],
      error: null
    })
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.sent, 0);
  assert.equal(
    result.targeted, 2,
    'only devices owned by a prepared recipient count; unowned compatibility devices never do'
  );
});

test('a mixed batch describing two different segments is refused outright', async () => {
  const { sendSegmentChangeNotifications } = apns();
  const first = prepareSegmentChangeNotifications({
    users: [USERS[0]], segment: SEGMENT, change: { reason: 'created', memberCount: 3 }
  });
  const second = prepareSegmentChangeNotifications({
    users: [USERS[1]], segment: { ...SEGMENT, id: 'seg-2', name: 'Good customers who have stopped' },
    change: { reason: 'created', memberCount: 9 }
  });
  const result = await sendSegmentChangeNotifications([...first, ...second], { dryRun: true }, { env: {} });
  assert.equal(result.error, 'invalid_segment_notification_preparation');
  assert.equal(result.sent, 0);
});

test('an empty preparation list sends nothing rather than everything', async () => {
  const { sendSegmentChangeNotifications } = apns();
  const result = await sendSegmentChangeNotifications([], { dryRun: false }, {
    env: { SEGMENT_CHANGE_NOTIFICATIONS_ENABLED: 'true' }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.error, 'invalid_segment_notification_preparation');
});

test('the flag is documented in .env.example, defaulting off', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(example, /^SEGMENT_CHANGE_NOTIFICATIONS_ENABLED=false$/m);
  assert.match(example, /^SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA=/m);
});
