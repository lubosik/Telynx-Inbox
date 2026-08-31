'use strict';
/**
 * The iOS client and the Express API are written in different languages, in
 * different files, by different people, and nothing compiles them together.
 * Every mismatch between them is therefore silent: the app builds, the server
 * passes its tests, and the screen renders empty on a real phone.
 *
 * That is not hypothetical. Shipping this release, before these checks existed,
 * would have produced a build where:
 *   - the Activity feed answered 400 on its very first request, because the
 *     client sent `category=all` and the server validates against the real
 *     category list;
 *   - every Activity row rendered as fallback text, because the client decoded
 *     camelCase keys while PostgREST returns snake_case columns;
 *   - the Team screen and the actor picker were permanently empty, because the
 *     server names each list after its resource and the client only understood
 *     a generic `items` envelope.
 *
 * These tests read the Swift source as text. That is crude, and it cannot catch
 * everything — but it catches the exact drift that shipped a broken screen, and
 * it costs nothing to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const swift = file => fs.readFileSync(path.join(ROOT, 'ios', 'ViciInbox', file), 'utf8');

const API_CLIENT = swift('Core/APIClient.swift');
const MODELS = swift('Core/AccountModels.swift');

test('the client offers exactly the audit categories the server accepts', () => {
  const { CATEGORIES } = require('../lib/audit/event-types');

  const declaration = MODELS.match(/enum AuditCategory[\s\S]*?\n    case ([^\n]+)/);
  assert.ok(declaration, 'AuditCategory is declared with a case list');
  const cases = declaration[1].split(',').map(part => part.trim()).filter(Boolean);

  // `all` is the client's own "no filter" idea and is deliberately not sent.
  const offered = cases.filter(name => name !== 'all').sort();
  assert.deepEqual(
    offered, [...CATEGORIES].sort(),
    'AuditCategory must match CATEGORIES in lib/audit/event-types.js. A category ' +
    'present on the server but missing here makes those rows unreachable in the app; ' +
    'one present here but not there answers 400.'
  );
});

test('the client never sends the category the server would reject', () => {
  const fetchAudit = API_CLIENT.match(/func fetchAudit\([\s\S]*?\n    }/);
  assert.ok(fetchAudit, 'fetchAudit exists');
  assert.match(
    fetchAudit[0], /if category != \.all/,
    'fetchAudit must omit `category` for .all — routes/audit.js validates it and ' +
    '400s the unfiltered feed, which is the screen\'s first request.'
  );
});

test('audit rows are decoded with the database column names the server returns', () => {
  // routes/audit.js selects straight out of PostgREST, so rows keep snake_case
  // even though the paging envelope around them is camelCase.
  const auditRoute = fs.readFileSync(path.join(ROOT, 'routes', 'audit.js'), 'utf8');
  const selected = auditRoute.match(/const SELECT_COLUMNS = \[([\s\S]*?)\]/);
  assert.ok(selected, 'SELECT_COLUMNS is declared');
  const columns = [...selected[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);

  const item = MODELS.match(/struct AuditItem[\s\S]*?enum CodingKeys[\s\S]*?\n    }/);
  assert.ok(item, 'AuditItem declares CodingKeys');

  // Every snake_case column the client claims to read must be spelled exactly
  // as the server sends it.
  for (const column of ['occurred_at', 'actor_display_name', 'actor_role',
                        'event_type', 'entity_type', 'entity_id', 'contact_phone',
                        'changed_fields', 'previous_state', 'new_state']) {
    assert.ok(columns.includes(column), `${column} is selected by routes/audit.js`);
    assert.ok(
      item[0].includes(`"${column}"`),
      `AuditItem must map ${column}; a camelCase key here decodes to nil and the ` +
      'row renders as fallback text with no error anywhere.'
    );
  }
});

test('list responses are decoded under the envelope key the server actually uses', () => {
  // Each list endpoint names its array after the resource. A client that only
  // understands a generic `items` envelope renders an empty screen.
  const expectations = [
    { fn: 'fetchAuditActors', key: 'actors', route: 'routes/audit.js' },
    { fn: 'fetchTeam',        key: 'users',  route: 'routes/users.js' },
  ];

  for (const { fn, key, route } of expectations) {
    const source = fs.readFileSync(path.join(ROOT, route), 'utf8');
    assert.match(source, new RegExp(`res\\.json\\(\\{[^}]*${key}\\s*:`),
      `${route} answers with a { ${key}: [...] } envelope`);

    const body = API_CLIENT.match(new RegExp(`func ${fn}\\([\\s\\S]*?\\n    \\}`));
    assert.ok(body, `${fn} exists`);
    assert.match(body[0], new RegExp(`let ${key}: \\[`),
      `${fn} must decode the { ${key}: [...] } envelope`);
  }
});

test('the client reads the identity envelope the auth endpoints actually send', () => {
  // Third mismatch of this class, so it gets a guard. routes/auth.js answers
  // with the identity under `actor`; the client originally decoded only `user`,
  // which left currentUser nil and made can() fail open — a Support Agent would
  // have been shown admin controls that then refuse server-side.
  const auth = fs.readFileSync(path.join(ROOT, 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /actor\s*:/, 'routes/auth.js sends the identity as `actor`');

  const model = MODELS.match(/struct AuthResponse[\s\S]*?\n\}/);
  assert.ok(model, 'AuthResponse exists');
  assert.match(model[0], /let actor: AuthUser\?/,
    'AuthResponse must decode `actor` — the key the server actually sends');

  // And nothing may read the raw `user` field directly, or a rename silently
  // reintroduces the bug at whichever call site was missed.
  const rawReads = API_CLIENT.match(/(decoded|wrapped)\.user\b/g) || [];
  assert.deepEqual(rawReads, [],
    'read AuthResponse.identity, not .user — it is the alias-tolerant accessor');
});

test('every permission the client gates UI on is a permission the server grants', () => {
  // A typo here hides a control forever, silently: the server never sends the
  // key, so can() is false and the button simply never appears.
  const migration = fs.readFileSync(path.join(ROOT, 'scripts', 'rbac-migration.sql'), 'utf8');
  const known = new Set([...migration.matchAll(/\('([a-z_]+\.[a-z_.]+)',\s*'[a-z_]+',/g)].map(m => m[1]));
  assert.ok(known.size > 20, `expected a full permission catalogue, parsed ${known.size}`);

  const used = [...MODELS.matchAll(/static let \w+ = "([a-z_]+\.[a-z_.]+)"/g)].map(m => m[1]);
  assert.ok(used.length > 0, 'Permission constants are declared in AccountModels.swift');
  for (const key of used) {
    assert.ok(known.has(key),
      `the app gates on "${key}", which is not in scripts/rbac-migration.sql — ` +
      'the server will never grant it and the control is permanently hidden');
  }
});

// ── Segments ───────────────────────────────────────────────────────────────
//
// Three papercuts landed here within minutes of the segments screen shipping,
// and all three are the kind that only show up on a real phone: the app builds,
// the server tests pass, and the picker still offers somebody who is already
// in. These read the Swift as text for exactly that reason.

const SEGMENT_MODELS = swift('Core/SegmentModels.swift');
const SEGMENTS_VIEW = swift('UI/SegmentsView.swift');
const SEGMENT_DETAIL_VIEW = swift('UI/SegmentDetailView.swift');
const SEGMENT_VIEW_MODELS = fs.readFileSync(
  path.join(ROOT, 'ios', 'ViciInbox', 'App', 'SegmentViewModels.swift'), 'utf8'
);

test('every segment path the client calls is a path the server polices', () => {
  const { ROUTE_POLICY } = require('../lib/route-policy');
  const policed = new Set(ROUTE_POLICY.map(entry => `${entry.method} ${entry.path}`));

  // The Swift interpolates the id, so compare on the shape rather than the text.
  const expected = [
    'GET /api/segments/:id/candidates',
    'DELETE /api/segments/:id',
    'POST /api/segments/:id/restore'
  ];
  for (const signature of expected) {
    assert.ok(policed.has(signature),
      `${signature} is called by the app and must have a policy entry, or it is default-denied`);
  }

  assert.match(API_CLIENT, /\/api\/segments\/\\\(encodedPathSegment\(id\)\)\/candidates/);
  assert.match(API_CLIENT, /\/api\/segments\/\\\(encodedPathSegment\(id\)\)\/restore/);
});

test('the picker does not re-filter the page the server already subtracted from', () => {
  // The fix is server side because the list is paged: filtering the visible
  // page would hide the members on screen and leave the rest one scroll away,
  // which is the bug rather than the fix. If a `filter` creeps into the add
  // sheet's candidate list, that is the regression.
  assert.match(API_CLIENT, /func fetchSegmentCandidates/);
  assert.match(SEGMENT_VIEW_MODELS, /class SegmentCandidatePickerModel/);

  const sheet = SEGMENT_DETAIL_VIEW.slice(
    SEGMENT_DETAIL_VIEW.indexOf('struct SegmentAddMemberSheet')
  );
  assert.ok(sheet.length > 0, 'the add sheet exists');
  assert.match(sheet, /ForEach\(picker\.candidates\)/);
  assert.doesNotMatch(
    sheet, /picker\.candidates\s*\.\s*filter/,
    'membership is subtracted on the server, before paging. A client filter here ' +
    'only hides the members that happen to be on screen.'
  );

  // And the old source is gone from this screen. /api/contacts knows nothing
  // about segments and would offer members again.
  assert.doesNotMatch(
    SEGMENT_DETAIL_VIEW, /SegmentContactPickerModel/,
    'the detail screen must use the candidate picker, not the raw contacts picker'
  );
});

test('somebody held out by an override is shown rather than dropped', () => {
  // "Not a member" and "a person decided to hold them out" are different
  // answers. The second has to be visible, because a database trigger refuses
  // to add them while it stands and hiding them leaves a name missing with no
  // way to find out why.
  assert.match(SEGMENT_MODELS, /struct SegmentHeldCandidate/);
  assert.match(SEGMENT_MODELS, /func heldSentence\(author: String\) -> String/);
  assert.match(SEGMENT_DETAIL_VIEW, /picker\.held/);
  assert.match(SEGMENT_DETAIL_VIEW, /Held out of this segment/);
});

test('a manual segment cannot be created from the app without a purpose', () => {
  // The server answers 400 SEGMENT_PURPOSE_REQUIRED. A form that could submit
  // without one would turn a required field into an error message.
  assert.match(API_CLIENT, /func createManualSegment\(name: String,\s*\n\s*purpose: String,/);
  assert.match(SEGMENTS_VIEW, /if trimmedPurpose\.isEmpty \{ return "Say what this segment is for\." \}/);
  assert.doesNotMatch(
    API_CLIENT, /createManualSegment\([^)]*description:/,
    'description was the optional field this replaces; sending both would be two answers to one question'
  );
});

test('the segment purpose and the per-person reason stay two different things', () => {
  // A purpose describes the group. A per-person reason describes one decision
  // about one named human, and it is still the whole record on an automatic
  // segment where somebody is overruling the engine. Collapsing them loses the
  // second one, silently.
  assert.match(SEGMENT_MODELS, /let purpose: String\?/);
  assert.match(SEGMENT_MODELS, /func headline\(personName: String, segmentPurpose: String\? = nil\)/);
  assert.match(SEGMENT_MODELS, /sentences\.append\("This segment is for: \\\(purpose\)"\)/);
  assert.match(SEGMENT_MODELS, /sentences\.append\("Note about \\\(personName\): \\\(reason\)"\)/);

  // The override reason is untouched: still its own field, still shown.
  assert.match(SEGMENT_MODELS, /struct SegmentOverride[\s\S]{0,600}let reason: String\?/);
  assert.match(SEGMENT_DETAIL_VIEW, /Text\("Reason: \\\(reason\)"\)/);
});

test('the destructive segment control is absent without campaigns.manage, not disabled', () => {
  // A Support Agent is refused by the server. A greyed out button that errors
  // on tap teaches nothing, and a swipe action that 403s teaches less.
  const row = SEGMENTS_VIEW.slice(
    SEGMENTS_VIEW.indexOf('private func segmentRow'),
    SEGMENTS_VIEW.indexOf('// MARK: - The archive')
  );
  assert.match(row, /\.swipeActions\(/);
  assert.match(row, /if canManage \{/);
  assert.doesNotMatch(row, /\.disabled\(!canManage\)/);

  const detailRemoval = SEGMENT_DETAIL_VIEW.slice(
    SEGMENT_DETAIL_VIEW.indexOf('Remove this segment", systemImage')
  ).slice(0, 400);
  assert.doesNotMatch(detailRemoval, /!canManage/);
});

test('the app never claims a removal deleted something the server archived', () => {
  // delete_sms_campaign_segment decides, not the client, and a segment that
  // gains an override between the tap and the statement is archived. So the
  // sentence shown afterwards has to be built from the response.
  assert.match(SEGMENT_MODELS, /var wasDeleted: Bool \{ outcome == "deleted" \}/);
  assert.match(SEGMENT_MODELS, /func outcomeSentence\(segmentName: String\) -> String/);
  assert.match(SEGMENT_VIEW_MODELS, /result\.outcomeSentence\(segmentName:/);

  // Every blocker token the RPC can return has a sentence, or an operator sees
  // a raw database word.
  const migration = fs.readFileSync(
    path.join(ROOT, 'scripts', 'segment-lifecycle-migration.sql'), 'utf8'
  );
  const tokens = [...migration.matchAll(/v_blockers \|\| '([a-z_]+)'/g)].map(match => match[1]);
  assert.ok(tokens.length >= 6, `expected the blocker list to be substantial, got ${tokens.length}`);
  for (const token of new Set(tokens)) {
    assert.ok(
      SEGMENT_MODELS.includes(`case "${token}"`) ||
      SEGMENT_MODELS.includes(`"${token}",`) ||
      SEGMENT_MODELS.includes(`, "${token}"`),
      `SegmentBlockerText has no sentence for "${token}", so the app would show the raw token`
    );
  }
});

test('an archived segment is still reachable from the app', () => {
  // Archiving is only meaningfully different from deleting if the row can be
  // found again. Without this screen an operator who loses a segment reaches
  // for the destructive path next time.
  assert.match(SEGMENTS_VIEW, /struct SegmentArchiveView/);
  assert.match(SEGMENTS_VIEW, /Archived segments/);
  assert.match(SEGMENT_VIEW_MODELS, /includeArchived: true/);
  assert.match(API_CLIENT, /func restoreSegment/);
});

test('EVERY api path the client calls is declared in the route policy', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // THE BUG THIS GENERALISES FROM
  //
  //   APIClient.swift called POST /api/campaigns/:id/archive and
  //   /unarchive, with the comment "ASSUMED CONTRACT" above them. The
  //   assumption was wrong: neither route was ever built. The enforcer
  //   default-denied the request — correctly, that is what default-deny is
  //   for — and the owner saw "this endpoint has no authorization policy and
  //   is therefore denied" while trying to archive cancelled campaigns.
  //
  //   The test above this one lists three segment paths BY HAND, so it could
  //   never have caught a fourth. This one reads every path the client
  //   actually calls, so a route added to Swift without a policy entry fails
  //   here rather than on somebody's phone.
  //
  //   Path only, not method: inferring the verb through post()/get()/
  //   decodedGET()/campaignMutation() wrappers would be guesswork, and a path
  //   nobody declared at all is the failure that actually happened.
  // ═══════════════════════════════════════════════════════════════════════
  const { ROUTE_POLICY } = require('../lib/route-policy');
  // Both sides reduced to the same shape. A parameter's NAME is not part of
  // the contract — the policy calls one `:phone` and the Swift interpolates a
  // phone into it — but its POSITION is, and a path with a segment nobody
  // declared is the failure that actually happened.
  const shapeOf = value => value.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':param');
  const policedPaths = new Set(ROUTE_POLICY.map(entry => shapeOf(entry.path)));

  const called = new Set();
  for (const match of API_CLIENT.matchAll(/"(\/api\/[^"]*)"/g)) {
    const shape = match[1]
      // "\(encodedPathSegment(id))" is one path segment. The inner call has
      // its own parentheses, so the match has to allow one level of nesting or
      // it stops early and leaves a stray ")" on every id.
      .replace(/\\\((?:[^()]|\([^()]*\))*\)/g, ':param')
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '');
    if (shape.startsWith('/api/')) called.add(shape);
  }
  assert.ok(called.size > 20, `expected to find many paths, found ${called.size}`);

  const undeclared = [...called].filter(path => !policedPaths.has(shapeOf(path))).sort();
  assert.deepEqual(undeclared, [],
    'These paths are called by the iOS client and have no entry in lib/route-policy.js, '
    + 'so the enforcer default-denies them and the feature is dead on the phone:\n  '
    + undeclared.join('\n  '));
});

test('archive and unarchive specifically, since the app has always called them', () => {
  const { ROUTE_POLICY } = require('../lib/route-policy');
  const policed = new Set(ROUTE_POLICY.map(entry => `${entry.method} ${entry.path}`));
  for (const signature of [
    'POST /api/campaigns/:id/archive',
    'POST /api/campaigns/:id/unarchive'
  ]) {
    assert.ok(policed.has(signature), `${signature} must be policed`);
  }
  // And actually implemented, not merely declared. A policy entry for a route
  // that does not exist is a 404 rather than a 403, which is a different
  // confusing answer to the same question.
  const routes = fs.readFileSync(path.join(ROOT, 'routes', 'campaigns.js'), 'utf8');
  assert.match(routes, /router\.post\('\/:id\/archive'/);
  assert.match(routes, /router\.post\('\/:id\/unarchive'/);
});
