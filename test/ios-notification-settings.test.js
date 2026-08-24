'use strict';
/**
 * The iOS notification settings screen and the server it talks to, checked
 * against each other.
 *
 * Nothing compiles these two together, so every mismatch is silent: the app
 * builds, the server passes its tests, and a switch either answers 400 or
 * cannot be reached at all. The same reasoning, and the same crude method, as
 * test/ios-api-contract.js: read the Swift as text and assert the specific
 * drift that would ship a broken screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const swift = file => fs.readFileSync(path.join(ROOT, 'ios', 'ViciInbox', file), 'utf8');

const MODELS = swift('Core/NotificationSettingsModels.swift');
const API_CLIENT = swift('Core/APIClient.swift');
const SETTINGS_VIEW = swift('UI/SettingsView.swift');
const MANAGER = swift('App/MessageNotificationManager.swift');

const { CATEGORY_KEYS, NOTIFICATION_CATEGORIES } =
  require('../lib/notifications/preferences');
const { ROUTE_POLICY } = require('../lib/route-policy');

// ── The contract ────────────────────────────────────────────────────────────

test('the client offers exactly the categories the server accepts', () => {
  // A key here and not there answers 400. A key there and not here is a switch
  // nobody can reach.
  const declared = [...MODELS.matchAll(/case \w+ = "([a-z_]+)"/g)].map(match => match[1]);
  const offered = declared.filter(key => CATEGORY_KEYS.includes(key) || /^[a-z_]+$/.test(key));
  assert.deepEqual(
    [...new Set(offered)].sort(), [...CATEGORY_KEYS].sort(),
    'NotificationCategory must match CATEGORY_KEYS in lib/notifications/preferences.js'
  );
});

test('the wire keys the client decodes are the columns the server sends', () => {
  const coding = [...MODELS.matchAll(/case \w+ = "([a-z_]+)"\n/g)].map(match => match[1]);
  for (const key of CATEGORY_KEYS) {
    assert.ok(coding.includes(key), `${key} has no CodingKey in NotificationSettingsModels.swift`);
  }
});

test('the client calls the paths the policy table actually declares', () => {
  const declared = ROUTE_POLICY
    .filter(entry => entry.path === '/api/users/me/notifications')
    .map(entry => `${entry.method} ${entry.path}`)
    .sort();
  assert.deepEqual(declared, [
    'GET /api/users/me/notifications',
    'PATCH /api/users/me/notifications'
  ]);
  assert.match(API_CLIENT, /get\("\/api\/users\/me\/notifications"\)/);
  assert.match(API_CLIENT, /patch\("\/api\/users\/me\/notifications"/);
});

test('the update sends a partial preferences object, not a full snapshot', () => {
  // Partial by design: two devices changing different categories must not
  // overwrite each other's answer with a stale full snapshot.
  assert.match(API_CLIENT, /body: \["preferences": \[category\.rawValue: enabled\]\]/);
});

// ── The three rules of the screen ───────────────────────────────────────────

test('there is no app level master switch', () => {
  // iOS already owns the master switch. A second one creates three states to
  // reconcile and one bad failure mode: the screen reading On while iOS drops
  // everything.
  for (const banned of [
    /Toggle\(\s*"All notifications"/,
    /"Enable all notifications"/,
    /masterSwitch/i,
    /allNotificationsEnabled/
  ]) {
    assert.equal(banned.test(SETTINGS_VIEW), false,
      `SettingsView contains what looks like a master switch: ${banned}`);
  }
});

test('the OS state is re-read on every scenePhase active, not cached', () => {
  assert.match(SETTINGS_VIEW, /onChange\(of: scenePhase\)/,
    'permission can change while the app is backgrounded and there is no callback for it');
  assert.match(SETTINGS_VIEW, /refreshAuthorizationStatus/);
  // Caching it as a proxy would guarantee the screen is wrong exactly when it
  // matters.
  assert.equal(/UserDefaults[\s\S]{0,120}authoriz/i.test(SETTINGS_VIEW), false,
    'authorization state must never be cached in UserDefaults as a proxy');
});

test('the toggles are never greyed out because of the OS state', () => {
  // Disabling them would be the intuitive move and it is wrong: the preference
  // is stored on the ACCOUNT and takes effect the moment permission returns.
  const disabled = SETTINGS_VIEW.match(/\.disabled\(([^)]*)\)/g) || [];
  for (const clause of disabled) {
    assert.equal(/authoriz/i.test(clause), false,
      `a control is disabled on the authorization state: ${clause}`);
  }
  assert.match(SETTINGS_VIEW, /\.disabled\(savingCategory == category \|\| !settings\.available\)/);
});

test('a denied state offers a route to the app\'s own Notifications pane', () => {
  // iOS 16+ lands directly on the Notifications pane rather than the app root.
  assert.match(MANAGER, /openNotificationSettingsURLString/);
  assert.match(SETTINGS_VIEW, /openSystemSettings\(\)/);
});

test('providesAppNotificationSettings is requested AND implemented', () => {
  // Requesting it without implementing openSettingsFor adds a button to iOS
  // Settings that does nothing at all.
  assert.match(MANAGER, /\.providesAppNotificationSettings/);
  assert.match(MANAGER, /openSettingsFor notification: UNNotification\?/);
});

// ── The digest category on the device ───────────────────────────────────────

test('the digest category identifier matches the payload the server sends', () => {
  const { prepareDailyDigest } = require('../lib/notifications/daily-digest');
  const prepared = prepareDailyDigest({
    users: [{ id: 1, role: 'owner', isActive: true, canManageCampaigns: true }],
    segments: [{
      key: 'reorder_due', name: 'Due to reorder, everyone due',
      previousCount: 9, memberCount: 14, joinedCount: 5, leftCount: 0
    }],
    localDay: '2026-08-24',
    generatedAt: new Date('2026-08-24T07:30:00.000Z')
  });
  assert.equal(prepared.send, true);
  const aps = prepared.notifications[0].payload.aps;
  assert.match(MANAGER, new RegExp(`digestCategory = "${aps.category}"`),
    'the client category identifier must equal aps.category or the actions never appear');
  assert.match(MANAGER, new RegExp(`threadIdentifier = "${aps['thread-id']}"`),
    'the snooze re-delivery must land in the same thread as the original');
});

test('the hidden previews placeholder is set on the client, where it has to be', () => {
  // It is a property of a UNNotificationCategory and has no payload
  // equivalent, so a server-side attempt at it would silently do nothing.
  assert.match(MANAGER, /hiddenPreviewsBodyPlaceholder: "Daily summary"/);
});

test('the digest carries Review and Later, and never Approve or Reject', () => {
  assert.match(MANAGER, /SEGMENT_DIGEST_REVIEW/);
  assert.match(MANAGER, /SEGMENT_DIGEST_SNOOZE/);
  // Approving model-written marketing aimed at real paying customers, from a
  // Lock Screen, without having read the copy, is a defect dressed up as a
  // convenience. It is also ambiguous across several proposals.
  for (const banned of [/SEGMENT_DIGEST_APPROVE/, /SEGMENT_DIGEST_REJECT/]) {
    assert.equal(banned.test(MANAGER), false, `a one tap approval action exists: ${banned}`);
  }
});

test('the review action opens the app rather than running in the background', () => {
  // A background action has seconds of execution time. On a bad connection the
  // call fails after the notification is dismissed and the person believes
  // they did something they did not.
  assert.match(MANAGER, /identifier: Self\.digestReviewAction,\s*\n\s*title: "Review",\s*\n\s*options: \[\.foreground\]/);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('no user facing string in the notification screen carries an em dash', () => {
  for (const [name, source] of [['SettingsView', SETTINGS_VIEW], ['models', MODELS]]) {
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*\/\/\/.*$/gm, '');
    const literals = withoutComments.match(/"(?:\\.|[^"\\])*"/g) || [];
    const offenders = literals.filter(literal => literal.includes('—') || literal.includes('–'));
    assert.deepEqual(offenders, [], `dash in a user facing string in ${name}`);
  }
});

test('the missed calls row does not claim to silence a ringing phone', () => {
  // There is no server-sent missed-call alert to suppress: a call arrives as a
  // VoIP push and CallKit presents it. The only honest thing the toggle can
  // control is the badge, and the label has to say so.
  const entry = NOTIFICATION_CATEGORIES.find(row => row.key === 'missed_calls');
  assert.match(entry.detail, /badge/i);
  assert.match(MODELS, /Count missed calls towards the app badge/);
  assert.match(SETTINGS_VIEW, /cannot silence them and does not try to/);
});

test('the account timezone is shown read only rather than editable here', () => {
  // It answers "why did this arrive at three in the morning" and makes the
  // London to Miami difference visible. Editing it belongs on Account, where
  // the picker already lives, and two places to change one value is how the two
  // disagree.
  assert.match(SETTINGS_VIEW, /LabeledContent\("Your timezone", value: zone\)/);
  // Scoped to this screen. SettingsView also holds Appearance, which
  // legitimately has pickers and legitimately reads a time zone.
  const start = SETTINGS_VIEW.indexOf('struct NotificationSettingsView');
  const end = SETTINGS_VIEW.indexOf('struct SecuritySettingsView');
  const screen = SETTINGS_VIEW.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the notification screen is still in this file');
  assert.equal(/Picker/.test(screen), false,
    'the notification screen must not be a second timezone editor');
});

test('AGENTS.md lists the new Foundation file in the typecheck command', () => {
  // That list is hand maintained and goes stale silently: a file missing from
  // it makes the documented command fail with "cannot find type", which looks
  // like the caller's fault.
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(agents, /NotificationSettingsModels\.swift/,
    'add every new Foundation-only file to the swiftc -typecheck list in AGENTS.md');
});
