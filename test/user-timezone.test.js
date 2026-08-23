'use strict';
/**
 * test/user-timezone.test.js — per-account display time zones.
 *
 * FOUR THINGS ARE BEING PROTECTED HERE
 *
 *   1. THE COMPLIANCE BOUNDARY, and it is the reason this file exists at all.
 *      `sms_users.timezone` says how ONE PERSON sees a timestamp.
 *      `sms_campaign_settings.business_timezone` says when it is lawful and
 *      decent to text a customer, and the quiet-hours predicate in
 *      scripts/campaigns-migration.sql reads that and only that. If the two
 *      were ever crossed, the Miami partner setting his display to
 *      Europe/London would move the quiet-hours window five hours and start
 *      texting American customers at four in the morning. That is not a
 *      cosmetic bug, so it gets a source-text guard rather than a comment.
 *
 *   2. THE ACCEPTED SET IS THE RUNTIME'S. Validation goes through
 *      `Intl.supportedValuesOf('timeZone')`, never a list in this repository,
 *      because a hand-written list rots and then disagrees with the very
 *      formatter both clients use. An offset is never storable: the whole point
 *      of an IANA identifier is that it survives a daylight-saving transition,
 *      and `+01:00` is correct for about five months of the year.
 *
 *   3. THE PAYLOAD SHAPE. The iOS client decodes `timeZone` on the identity
 *      payload and another agent is building against it, so its keys are
 *      asserted literally. It is present unconditionally, including for a
 *      person who has never chosen and on a database where the migration has
 *      not been applied, because a client that had to model its absence would
 *      re-implement the fallback locally, which is precisely the per-device
 *      divergence this feature removes.
 *
 *   4. FAIL-SAFE DEPLOY ORDERING. A READ against a database with no `timezone`
 *      column falls back and says nothing; a WRITE refuses loudly. Silently
 *      discarding somebody's choice and answering 200 is the worse of the two.
 *
 * Offline: no database, no network, no clock dependence beyond an injected one.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';
process.env.APP_URL ||= 'https://inbox.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const createUsersRouter = require('../routes/users');
const {
  DEFAULT_TIME_ZONE,
  canonicalTimeZone,
  effectiveTimeZoneId,
  catalogue,
  describeStoredTimeZone,
  describeTimeZone,
  isSupportedTimeZone,
  labelOf,
  offsetLabelFrom,
  offsetMinutesAt,
  resetCatalogueCache,
  resolveStoredTimeZone,
  supportedTimeZones
} = require('../lib/timezones');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ── The compliance boundary ────────────────────────────────────────────────

test('campaign quiet hours are enforced against the BUSINESS time zone, not a person\'s', () => {
  // Read the predicate itself rather than trusting the prose around it. This is
  // the assertion that would fail the day somebody "unified" the two columns.
  const migration = read('scripts/campaigns-migration.sql');

  const quietHourReads = [...migration.matchAll(/AT TIME ZONE ([A-Za-z0-9_.]+)/g)]
    .map(match => match[1]);
  assert.ok(quietHourReads.length > 0, 'the quiet-hours predicate is still there');
  for (const source of quietHourReads) {
    assert.match(
      source, /business_timezone$/,
      `quiet hours are computed AT TIME ZONE ${source}. That must be `
      + 'sms_campaign_settings.business_timezone. A per-person display preference '
      + 'deciding when a customer may be texted is a compliance failure.'
    );
  }
});

test('nothing in the delivery path reads the per-person column', () => {
  // The reverse direction, over every file that can decide whether or when a
  // message goes out. `sms_users.timezone` must not appear in any of them.
  const deliveryFiles = [
    'scripts/campaigns-migration.sql',
    'telnyx.js',
    'lib/campaigns'
  ];

  const offenders = [];
  const scan = relative => {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) scan(path.join(relative, entry));
      return;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    // The per-person column is only ever reached through sms_users. A bare
    // "timezone" is far too common to assert on: business_timezone contains it.
    if (/sms_users[\s\S]{0,200}?\btimezone\b/.test(text)) offenders.push(relative);
  };
  deliveryFiles.forEach(scan);

  assert.deepEqual(
    offenders, [],
    '\n\nThese delivery-path files reference sms_users near a timezone column. '
    + 'A person\'s display preference must never influence when a customer is '
    + 'contacted; that is sms_campaign_settings.business_timezone:\n\n  '
    + offenders.join('\n  ') + '\n'
  );
});

test('the migration says in the file itself that this is not the business zone', () => {
  // The migration is what an operator reads before running it, and the one
  // mistake that matters is invisible in the DDL. It has to be written down
  // where the person applying it will see it.
  const migration = read('scripts/user-timezone-migration.sql');
  assert.match(migration, /business_timezone/,
    'the migration must name the column it is NOT');
  assert.match(migration, /quiet hours/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS timezone/);
  // Additive only. It must not rewrite a single existing row.
  assert.equal(/\bUPDATE\s+sms_users\b/i.test(migration), false,
    'the migration backfills nothing; NULL means "never chosen"');
  assert.equal(/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration.split('ROLLBACK')[0]), false,
    'nothing outside the rollback note drops anything');
});

// ── Validation ─────────────────────────────────────────────────────────────

test('the accepted set is the runtime\'s IANA list, not a list in this repository', () => {
  const runtime = Intl.supportedValuesOf('timeZone');
  assert.deepEqual(supportedTimeZones(), [...runtime].sort());
  assert.ok(runtime.length > 100, 'the runtime knows a real number of zones');

  // Spot checks for the two people this was built for.
  assert.ok(isSupportedTimeZone('Europe/London'));
  assert.ok(isSupportedTimeZone('America/New_York'));

  // And the module must not be carrying a copy of the list. Naming a handful of
  // zones in prose and in the default is unavoidable; an array of them is the
  // thing that rots, so the assertion is on how many appear, not on whether any
  // do.
  const source = read('lib/timezones.js');
  assert.match(source, /Intl\.supportedValuesOf\('timeZone'\)/);
  const mentioned = new Set(
    (source.match(/['"`][A-Z][A-Za-z_]+\/[A-Za-z_/+-]+['"`]/g) || [])
      .map(literal => literal.slice(1, -1))
      .filter(candidate => runtime.includes(candidate))
  );
  assert.ok(
    mentioned.size <= 6,
    `lib/timezones.js hard-codes ${mentioned.size} real zone identifiers `
    + `(${[...mentioned].join(', ')}). The accepted set must come from the runtime.`
  );
});

test('an alias, a rename and the wrong case all resolve through the runtime', () => {
  // Not a convenience. Foundation on iOS reports `Asia/Kolkata` for a device
  // set to India, while this ICU build's canonical set contains only
  // `Asia/Calcutta`, so a server that refused the alias would reject the very
  // value the client read off the phone. What gets STORED is always a member of
  // the set, so a stored value can always be formatted and always appears in
  // the picker.
  const accepted = new Set(supportedTimeZones());
  for (const alias of ['Asia/Kolkata', 'Europe/Kyiv', 'US/Eastern', 'asia/kolkata']) {
    const canonical = canonicalTimeZone(alias);
    assert.ok(canonical, `${alias} must resolve rather than be refused`);
    assert.ok(accepted.has(canonical), `${alias} resolved to ${canonical}, which is not in the set`);
  }
  assert.equal(canonicalTimeZone('US/Eastern'), 'America/New_York');
});

test('an offset is never a time zone, whatever it looks like', () => {
  // The single most important rejection in the file. An offset is right twice a
  // year: store +01:00 for the UK and every timestamp is an hour out from late
  // October to late March, with no way to recover what was thrown away.
  for (const offset of ['+01:00', '-04:00', 'UTC+1', 'GMT+5:30', '+0100', '0', '60', '-240']) {
    assert.equal(canonicalTimeZone(offset), null, `${offset} must not be storable`);
  }
});

test('rubbish, aliases and oversized input are all refused', () => {
  for (const value of [
    undefined, null, '', '   ', 42, {}, [], true,
    'Mars/Olympus_Mons', 'Europe', '/', '../../etc/passwd',
    'Europe/London; DROP TABLE sms_users',
    // Not in this runtime's set and not resolvable to anything in it. Documented
    // in lib/timezones.js rather than special-cased: nobody here wants UTC as a
    // display zone, and admitting it would need the exception list this design
    // exists to avoid.
    'UTC', 'Etc/UTC', 'GMT',
    'A'.repeat(500)
  ]) {
    assert.equal(canonicalTimeZone(value), null, `${String(value).slice(0, 40)} must be refused`);
  }
});

test('case is forgiven and the canonical spelling is what gets stored', () => {
  // A client that lower-cased a path segment somewhere should not be punished,
  // and two rows that render identically must not compare differently.
  assert.equal(canonicalTimeZone('europe/london'), 'Europe/London');
  assert.equal(canonicalTimeZone('AMERICA/NEW_YORK'), 'America/New_York');
  assert.equal(canonicalTimeZone('  Europe/London  '), 'Europe/London');
  // Forgiving case does not widen the set by a single zone.
  assert.equal(canonicalTimeZone('europe/londonn'), null);
});

// ── Derived offsets ────────────────────────────────────────────────────────

test('the offset is computed for an instant, so it survives daylight saving', () => {
  // The whole reason an identifier is stored instead of a number.
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');

  assert.equal(offsetMinutesAt('Europe/London', winter), 0);
  assert.equal(offsetMinutesAt('Europe/London', summer), 60);
  assert.equal(offsetMinutesAt('America/New_York', winter), -300);
  assert.equal(offsetMinutesAt('America/New_York', summer), -240);

  // A half-hour and a three-quarter-hour zone, because an implementation that
  // parsed only whole hours would pass everything above.
  assert.equal(offsetMinutesAt('Asia/Kolkata', winter), 330);
  assert.equal(offsetMinutesAt('Pacific/Chatham', winter), 825);
});

test('offsets are rendered the same way for every client', () => {
  assert.equal(offsetLabelFrom(0), 'UTC+00:00');
  assert.equal(offsetLabelFrom(60), 'UTC+01:00');
  assert.equal(offsetLabelFrom(-240), 'UTC-04:00');
  assert.equal(offsetLabelFrom(330), 'UTC+05:30');
  assert.equal(offsetLabelFrom(-570), 'UTC-09:30');
});

test('labels read like places, not like identifiers', () => {
  assert.equal(labelOf('Europe/London'), 'London');
  assert.equal(labelOf('America/New_York'), 'New York');
  assert.equal(labelOf('America/Argentina/Buenos_Aires'), 'Buenos Aires, Argentina');
  assert.equal(labelOf('America/Indiana/Indianapolis'), 'Indianapolis, Indiana');
});

// ── The payload shape the iOS client decodes ───────────────────────────────

const DESCRIPTOR_KEYS = ['id', 'label', 'region', 'offsetMinutes', 'offsetLabel', 'abbreviation'];

test('the descriptor is exactly the documented shape', () => {
  const at = new Date('2026-07-15T12:00:00Z');
  const described = describeTimeZone('America/New_York', at);

  assert.deepEqual(Object.keys(described).sort(), [...DESCRIPTOR_KEYS].sort());
  assert.equal(described.id, 'America/New_York');
  assert.equal(described.label, 'New York');
  assert.equal(described.region, 'America');
  assert.equal(described.offsetMinutes, -240);
  assert.equal(described.offsetLabel, 'UTC-04:00');
  assert.equal(typeof described.abbreviation, 'string');
  assert.ok(described.abbreviation.length > 0);

  // Every field must survive JSON, because that is literally what is sent.
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
});

test('the identity-payload shape adds isDefault and nothing else', () => {
  const chosen = describeStoredTimeZone('America/New_York', new Date('2026-07-15T12:00:00Z'));
  assert.deepEqual(Object.keys(chosen).sort(), [...DESCRIPTOR_KEYS, 'isDefault'].sort());
  assert.equal(chosen.isDefault, false);
});

test('never chosen, unreadable and no-longer-canonical all resolve to the default', () => {
  // Three different causes, one correct client behaviour: render the default
  // and offer the picker. The flag says which, so nothing has to guess.
  // `US/Eastern` is deliberately NOT in this list any more: the runtime
  // resolves it to America/New_York, so a row holding it is not stale at all
  // and must keep rendering as the person's own choice.
  for (const stored of [null, undefined, '', 'Mars/Olympus_Mons', 'Factory', '+01:00']) {
    const resolved = resolveStoredTimeZone(stored);
    assert.equal(resolved.id, DEFAULT_TIME_ZONE);
    assert.equal(resolved.isDefault, true);
  }
  // And a stale row is NOT rewritten as a side effect of being read; the
  // function is pure and returns a value, so there is nothing here to assert
  // beyond the absence of a store in its signature.
  assert.equal(resolveStoredTimeZone.length, 1);
});

test('the documented default is a real zone and is the one the header names', () => {
  assert.ok(isSupportedTimeZone(DEFAULT_TIME_ZONE));
  assert.equal(DEFAULT_TIME_ZONE, 'Europe/London');
  assert.match(read('lib/timezones.js'), /Europe\/London, deliberately/);
  assert.match(read('scripts/user-timezone-migration.sql'), /Europe\/London/);
});

// ── The catalogue ──────────────────────────────────────────────────────────

test('the catalogue is grouped, complete, and identical for both clients', () => {
  resetCatalogueCache();
  const at = new Date('2026-07-15T12:00:00Z');
  const payload = catalogue(at);

  assert.deepEqual(Object.keys(payload).sort(), ['count', 'default', 'generatedAt', 'groups']);
  assert.equal(payload.default, DEFAULT_TIME_ZONE);
  assert.equal(payload.count, supportedTimeZones().length);

  const regions = payload.groups.map(group => group.region);
  assert.deepEqual(regions, [...regions].sort(), 'regions are sorted');
  assert.ok(regions.includes('Europe') && regions.includes('America'));

  const flattened = payload.groups.flatMap(group => group.zones);
  assert.equal(flattened.length, payload.count, 'count matches what is actually in the groups');
  assert.deepEqual(
    [...new Set(flattened.map(zone => zone.id))].sort(),
    supportedTimeZones(),
    'every accepted zone is offered, and nothing else is'
  );
  for (const zone of flattened.slice(0, 25)) {
    assert.deepEqual(Object.keys(zone).sort(), [...DESCRIPTOR_KEYS].sort());
  }

  const london = flattened.find(zone => zone.id === 'Europe/London');
  assert.equal(london.offsetMinutes, 60, 'offsets in the catalogue are for the instant asked for');
});

test('the catalogue is cached per quarter hour, and a DST move lands within it', () => {
  resetCatalogueCache();
  const before = catalogue(new Date('2026-03-29T00:30:00Z'));
  const sameBucket = catalogue(new Date('2026-03-29T00:44:00Z'));
  assert.equal(sameBucket, before, 'the same 15-minute bucket reuses one object');
  assert.equal(sameBucket.generatedAt, before.generatedAt);

  // Europe/London springs forward at 01:00 UTC on this date.
  const after = catalogue(new Date('2026-03-29T01:30:00Z'));
  assert.notEqual(after, before, 'a later bucket is rebuilt');
  const zoneIn = payload => payload.groups
    .flatMap(group => group.zones).find(zone => zone.id === 'Europe/London').offsetMinutes;
  assert.equal(zoneIn(before), 0);
  assert.equal(zoneIn(after), 60);
});

// ── The HTTP surface ───────────────────────────────────────────────────────

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true },
  { key: 'legacy', display_name: 'Team (shared password)', rank: 5, is_assignable: false }
]);

function team() {
  return [
    { id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy', is_legacy_shared: true, timezone: null },
    { id: 3, email: 'dominic@example.com', display_name: 'Dominic', role: 'owner', timezone: 'America/New_York' },
    { id: 4, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner', timezone: 'Europe/London' },
    { id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent', timezone: null }
  ];
}

/**
 * @param {{timezoneColumn?: boolean}} [options]
 *   `timezoneColumn: false` simulates a database where
 *   scripts/user-timezone-migration.sql has not been applied: every read and
 *   write that names the column throws the PostgREST error it really throws.
 */
function makeUserStore(seed = team(), { timezoneColumn = true } = {}) {
  const state = {
    users: seed.map(row => ({
      is_active: true, is_legacy_shared: false, must_change_password: false,
      phone: null, session_epoch: 1, password_hash: 'stub-hash',
      created_at: '2026-01-01T00:00:00.000Z', timezone: null, ...row
    })),
    updates: [],
    epochBumps: []
  };
  const missingColumn = () => Object.assign(
    new Error("column sms_users.timezone does not exist"),
    { code: '42703' }
  );
  /** The fixed column list the real store selects; `timezone` is NOT in it. */
  const withoutTimezone = row => {
    if (!row) return null;
    const copy = { ...row };
    delete copy.timezone;
    return copy;
  };
  return {
    state,
    async list() { return state.users.map(withoutTimezone); },
    async listTimezones() {
      if (!timezoneColumn) throw missingColumn();
      return state.users.map(row => ({ id: row.id, timezone: row.timezone || null }));
    },
    async getTimezone(id) {
      if (!timezoneColumn) throw missingColumn();
      return state.users.find(row => row.id === Number(id))?.timezone || null;
    },
    async getById(id) { return withoutTimezone(state.users.find(row => row.id === Number(id))); },
    async update(id, patch) {
      if (!timezoneColumn && 'timezone' in patch) throw missingColumn();
      state.updates.push({ id: Number(id), patch });
      const row = state.users.find(entry => entry.id === Number(id));
      Object.assign(row, patch);
      return withoutTimezone(row);
    },
    async emailIsTaken() { return false; },
    async findByEmail() { return null; },
    async countActiveAdministrators() { return 2; },
    async bumpEpoch(id) { state.epochBumps.push(Number(id)); return 2; },
    async listRoles() { return ROLE_CATALOGUE.map(role => ({ ...role })); },
    async listPermissionKeys() { return ['user.manage', 'user.manage.owner']; },
    async listGrants() { return []; },
    async upsertGrant(row) { return row; },
    async deleteGrant() { return true; },
    async revokePushDevices() { return 0; }
  };
}

function fixture(options) {
  const users = makeUserStore(team(), options);
  const auditRows = [];
  const router = createUsersRouter({
    store: users,
    emailChangeStore: {
      async openForUser() { return null; },
      async cancelOpenForUser() { return 0; },
      async create(row) { return row; },
      async confirm() { throw new Error('unused'); }
    },
    authz: { invalidate() {} },
    audit: async input => { auditRows.push(input); },
    sendMail: async () => ({ sent: true })
  });
  return { users, router, auditRows };
}

function actorFrom({ id, displayName, role, permissions = [], isLegacyShared = false, viaLegacySession = false }) {
  return { id, displayName, role, permissions: new Set(permissions), isLegacyShared, viaLegacySession };
}

const LUBOSI = actorFrom({ id: 4, displayName: 'Lubosi', role: 'owner', permissions: ['user.manage', 'user.manage.owner'] });
const SARAH = actorFrom({ id: 5, displayName: 'Sarah', role: 'agent' });
const LEGACY = actorFrom({ id: 1, displayName: 'Team', role: 'legacy', isLegacyShared: true, viaLegacySession: true });

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route?.path === routePath && entry.route?.methods?.[method.toLowerCase()]);
  assert.ok(layer, `no handler for ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(router, method, routePath, { params = {}, body = {}, actor = null } = {}) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)({
    params, body, actor,
    ip: '203.0.113.9',
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  }, res);
  return res;
}

/**
 * The contract, asserted on every payload that carries it.
 *
 * `timeZone` MUST be a bare IANA string. It was briefly an object during
 * development while the iOS client was being written in parallel against
 * `String?`, which would have decoded nil: the account zone would never have
 * reached the app, every timestamp would have kept rendering in device-local
 * time, and nothing would have errored. That is exactly the bug this feature
 * exists to remove, so the type is asserted rather than described.
 */
function assertTimeZoneContract(payload, where) {
  assert.ok(
    typeof payload.timeZone === 'string' || payload.timeZone === null,
    `${where}: timeZone must be a string or null, got ${
      payload.timeZone === null ? 'null' : typeof payload.timeZone}`
  );
  if (payload.timeZone !== null) {
    assert.ok(isSupportedTimeZone(payload.timeZone),
      `${where}: timeZone must be an identifier this server accepts`);
  }
  assert.equal(typeof payload.timeZoneDetail, 'object', `${where}: the rich sibling is present`);
  assert.ok(payload.timeZoneDetail !== null);
  assert.deepEqual(
    Object.keys(payload.timeZoneDetail).sort(),
    [...DESCRIPTOR_KEYS, 'isDefault'].sort(),
    `${where}: the detail object shape`
  );
  assert.equal(payload.timeZoneDetail.id, payload.timeZone,
    `${where}: the two fields must never disagree`);
}

test('GET /api/users/me carries the zone as a STRING, with the detail alongside', async () => {
  const { router } = fixture();
  const res = await call(router, 'get', '/me', { actor: LUBOSI });

  assert.equal(res.statusCode, 200);
  assertTimeZoneContract(res.payload, 'GET /me');
  assert.equal(res.payload.timeZone, 'Europe/London');
  assert.equal(res.payload.timeZoneDetail.isDefault, false);
  assert.equal(res.payload.timeZoneDetail.region, 'Europe');
});

test('the field is present even for somebody who has never chosen', async () => {
  const { router } = fixture();
  const res = await call(router, 'get', '/me', { actor: SARAH });
  assertTimeZoneContract(res.payload, 'GET /me, unchosen');
  assert.equal(res.payload.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(res.payload.timeZoneDetail.isDefault, true);
});

test('effectiveTimeZoneId is a plain string on every input a row can hold', () => {
  for (const stored of [null, undefined, '', 'Europe/London', 'Asia/Kolkata', 'nonsense', 42]) {
    const id = effectiveTimeZoneId(stored);
    assert.equal(typeof id, 'string');
    assert.ok(isSupportedTimeZone(id));
  }
});

test('the shared team login is not asked, and is answered the default', async () => {
  // Two people are behind that row. There is no such thing as "their" zone, and
  // answering one of them would be a lie rather than an approximation.
  const { router, users } = fixture();
  const before = users.state.users.find(row => row.id === 1).timezone;
  const res = await call(router, 'get', '/me', { actor: LEGACY });
  assertTimeZoneContract(res.payload, 'GET /me, shared login');
  assert.equal(res.payload.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(res.payload.timeZoneDetail.isDefault, true);
  assert.equal(users.state.users.find(row => row.id === 1).timezone, before);
});

test('an unapplied migration costs the field, never the payload', async () => {
  // Deploy ordering. The read fails closed to the default and /me still answers
  // 200 with a complete identity, because account access must not depend on a
  // display preference.
  const { router } = fixture({ timezoneColumn: false });
  const res = await call(router, 'get', '/me', { actor: LUBOSI });
  assert.equal(res.statusCode, 200);
  assertTimeZoneContract(res.payload, 'GET /me, migration not applied');
  assert.equal(res.payload.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(res.payload.timeZoneDetail.isDefault, true);
  assert.ok(Array.isArray(res.payload.permissions));
});

test('GET /api/users/me/timezones publishes the whole picker', async () => {
  const { router } = fixture();
  const res = await call(router, 'get', '/me/timezones', { actor: SARAH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.count, supportedTimeZones().length);
  assert.ok(res.payload.groups.length > 5);
  // A Support Agent can reach it. Choosing your own zone is open, so the list
  // that populates the picker has to be open too.
  assert.equal(res.payload.default, DEFAULT_TIME_ZONE);
});

test('the picker refuses an unauthenticated caller rather than leaking a 200', async () => {
  const { router } = fixture();
  const res = await call(router, 'get', '/me/timezones', { actor: null });
  assert.equal(res.statusCode, 401);
});

test('PATCH /api/users/me stores the canonical spelling and audits it', async () => {
  const { router, users, auditRows } = fixture();
  const res = await call(router, 'patch', '/me', {
    actor: SARAH, body: { timeZone: 'america/new_york' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(users.state.users.find(row => row.id === 5).timezone, 'America/New_York');
  assertTimeZoneContract(res.payload.user, 'PATCH /me');
  assert.equal(res.payload.user.timeZone, 'America/New_York');
  assert.equal(res.payload.user.timeZoneDetail.isDefault, false);

  const row = auditRows.find(entry => entry.eventType === 'team.member.profile_updated');
  assert.ok(row, 'a profile_updated row is written');
  assert.deepEqual(row.changedFields, ['timezone']);
  assert.equal(row.previousState.timezone, null);
  assert.equal(row.newState.timezone, 'America/New_York');
  assert.equal(row.metadata.via, 'self_service');

  // Changing how you read a clock does not change what you may do.
  assert.deepEqual(users.state.epochBumps, []);
});

test('a name and a zone can move together, and both are reported', async () => {
  const { router, users } = fixture();
  const res = await call(router, 'patch', '/me', {
    actor: SARAH, body: { displayName: 'Sarah Chen', timeZone: 'Europe/London' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.user.displayName, 'Sarah Chen');
  assertTimeZoneContract(res.payload.user, 'PATCH /me, name and zone');
  assert.equal(res.payload.user.timeZone, 'Europe/London');
  assert.equal(users.state.users.find(row => row.id === 5).display_name, 'Sarah Chen');
});

test('a rename alone still reports the zone the account already had', async () => {
  // The write path selects a fixed column list that excludes `timezone`, so a
  // naive implementation reports the default here and the client silently
  // "forgets" the person's choice on every rename.
  const { router } = fixture();
  const res = await call(router, 'patch', '/me', {
    actor: LUBOSI, body: { displayName: 'Lubosi K' }
  });
  assert.equal(res.payload.user.timeZone, 'Europe/London');
  assert.equal(res.payload.user.timeZoneDetail.isDefault, false);
});

test('null clears the choice rather than being refused', async () => {
  const { router, users } = fixture();
  const res = await call(router, 'patch', '/me', { actor: LUBOSI, body: { timeZone: null } });
  assert.equal(res.statusCode, 200);
  assert.equal(users.state.users.find(row => row.id === 4).timezone, null);
  assertTimeZoneContract(res.payload.user, 'PATCH /me, cleared');
  // Clearing the STORED choice does not blank the SENT field. The client still
  // gets a usable identifier, and `isDefault` is what says it was not chosen.
  assert.equal(res.payload.user.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(res.payload.user.timeZoneDetail.isDefault, true);
});

test('a value that is not a zone is refused and nothing is written', async () => {
  for (const bad of ['+01:00', 'Mars/Phobos', 'UTC', 'Europe', 12]) {
    const { router, users } = fixture();
    const res = await call(router, 'patch', '/me', { actor: LUBOSI, body: { timeZone: bad } });
    assert.equal(res.statusCode, 400, `${bad} must be refused`);
    assert.equal(res.payload.code, 'INVALID_TIME_ZONE');
    assert.deepEqual(users.state.updates, [], 'a refusal writes nothing at all');
    assert.equal(users.state.users.find(row => row.id === 4).timezone, 'Europe/London');
  }
});

test('the refusal points at the endpoint that lists the acceptable answers', async () => {
  const { router } = fixture();
  const res = await call(router, 'patch', '/me', { actor: LUBOSI, body: { timeZone: 'nonsense' } });
  assert.match(res.payload.error, /\/api\/users\/me\/timezones/);
});

test('the shared team login cannot set a personal zone', async () => {
  const { router, users } = fixture();
  const res = await call(router, 'patch', '/me', { actor: LEGACY, body: { timeZone: 'Europe/London' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.deepEqual(users.state.updates, []);
});

test('a WRITE against an unapplied migration refuses loudly instead of pretending', async () => {
  // The asymmetry that matters. A read falls back silently because the
  // alternative is losing account access; a write must not answer 200 having
  // thrown the person's choice away.
  const { router } = fixture({ timezoneColumn: false });
  const res = await call(router, 'patch', '/me', { actor: LUBOSI, body: { timeZone: 'Europe/London' } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'TIME_ZONE_UNAVAILABLE');
});

test('an Owner may set somebody else\'s zone, and it is audited as an admin edit', async () => {
  const { router, users, auditRows } = fixture();
  const res = await call(router, 'patch', '/:id', {
    actor: LUBOSI, params: { id: '5' }, body: { timeZone: 'America/New_York' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(users.state.users.find(row => row.id === 5).timezone, 'America/New_York');
  assertTimeZoneContract(res.payload.user, 'PATCH /:id');
  assert.equal(res.payload.user.timeZone, 'America/New_York');
  // Not an authority change, so nobody is signed out over it.
  assert.equal(res.payload.sessionsRevoked, false);
  assert.deepEqual(users.state.epochBumps, []);

  const row = auditRows.find(entry => entry.eventType === 'team.member.profile_updated');
  assert.ok(row, 'the change is recorded; the person did not ask for it');
  assert.equal(row.metadata.via, 'admin_correction');
  assert.equal(row.previousState.timezone, null);
  assert.equal(row.newState.timezone, 'America/New_York');
});

test('an Owner may not reach into a peer Owner\'s account to change it', async () => {
  const { router, users } = fixture();
  const res = await call(router, 'patch', '/:id', {
    actor: LUBOSI, params: { id: '3' }, body: { timeZone: 'Europe/London' }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_MODIFY_PEER_OWNER');
  assert.equal(users.state.users.find(row => row.id === 3).timezone, 'America/New_York');
  assert.deepEqual(users.state.updates, []);
});

test('an administrative zone change to the value already held writes no audit row', async () => {
  const { router, auditRows } = fixture();
  await call(router, 'patch', '/:id', {
    actor: LUBOSI, params: { id: '3' }, body: { displayName: 'Dominic' }
  });
  assert.equal(auditRows.some(entry => entry.eventType === 'team.member.profile_updated'), false);
});

test('the team list carries each person\'s zone', async () => {
  const { router } = fixture();
  const res = await call(router, 'get', '/', { actor: LUBOSI });
  const byId = new Map(res.payload.users.map(user => [user.id, user]));
  // Every row in the list obeys the same contract as /me. A divergence between
  // the two would be worse than a single bug: one screen would work and the
  // other would not, and nothing would say why.
  for (const user of res.payload.users) assertTimeZoneContract(user, `GET /users id=${user.id}`);
  assert.equal(byId.get(4).timeZone, 'Europe/London');
  assert.equal(byId.get(3).timeZone, 'America/New_York');
  assert.equal(byId.get(5).timeZoneDetail.isDefault, true);
});

test('the team list still renders when the column is not there', async () => {
  const { router } = fixture({ timezoneColumn: false });
  const res = await call(router, 'get', '/', { actor: LUBOSI });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.users.length, 4);
  for (const user of res.payload.users) {
    assertTimeZoneContract(user, `GET /users, migration not applied, id=${user.id}`);
    assert.equal(user.timeZoneDetail.isDefault, true);
  }
});
