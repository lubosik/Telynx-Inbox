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
