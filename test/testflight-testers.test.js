'use strict';
/**
 * A new teammate cannot install the app until they are a TestFlight tester, so
 * the invitation link has nothing to open. lib/testflight-testers.js closes
 * that by adding them when they are invited.
 *
 * Two properties matter more than the happy path, and most of these tests are
 * about them:
 *
 *   1. It can NEVER reject. It runs alongside creating an invitation, and a
 *      problem at Apple must not fail an invitation that has already been
 *      written. Every test here asserts a resolved value, never a throw.
 *   2. It never leaks. The signing key, the JWT and the full email address must
 *      not reach a log line.
 *
 * No test contacts App Store Connect. `fetchImpl` is injected everywhere, and
 * the signing key below is a throwaway P-256 pair generated for this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addTesterToBetaGroup,
  configuration,
  isTestFlightConfigured,
  providerToken,
  redactEmail,
  resetMissingConfigurationLog,
  splitDisplayName
} = require('../lib/testflight-testers');

/** A real ES256 key, so the JWT is genuinely signed rather than stubbed. */
const TEST_KEY_B64 = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZ2JWTWVybVFycHVtdTloR1YKc2hWVUNtLzJ6NzhzeDhvTVV0NkY4WE16WlBpaFJBTkNBQVNadEdEd1IzNEIxclk3WWltaGJPUWQrMlM0dm9QbQpDdjNwRDkzV0N2aXdqN3VYakk1LzlIdzZlVWRKdk1TZjlWeEl1d1NPSnV1R1BjTlIrUXlXdCtjSgotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==';

function configuredEnv(overrides = {}) {
  return {
    ASC_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
    ASC_KEY_ID: 'ABCD123456',
    ASC_KEY_P8_BASE64: TEST_KEY_B64,
    ASC_BETA_GROUP_ID: 'c3b04f34-53c3-4e3d-9177-c392b9b58659',
    ASC_APP_ID: '6794893971',
    ...overrides
  };
}

/** Records every request so a test can assert what Apple would have received. */
function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 201, body = {} } = responder(calls.length) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function captureConsole(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  return Promise.resolve(run()).finally(() => Object.assign(console, original)).then(v => ({ value: v, lines }));
}

// ── Configuration ───────────────────────────────────────────────────────────

test('a partial credential set counts as unconfigured, never as half-working', () => {
  assert.equal(isTestFlightConfigured(configuredEnv()), true);
  for (const missing of ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_KEY_P8_BASE64', 'ASC_BETA_GROUP_ID']) {
    const env = configuredEnv({ [missing]: '' });
    assert.equal(isTestFlightConfigured(env), false, `missing ${missing} must read as unconfigured`);
    assert.equal(configuration(env), null);
  }
});

test('with no credentials it no-ops, resolves, and says why exactly once', async () => {
  resetMissingConfigurationLog();
  const fetchImpl = recordingFetch(() => ({ status: 201 }));

  const { value, lines } = await captureConsole(async () => {
    const first = await addTesterToBetaGroup(
      { email: 'newbie@example.com', displayName: 'New Bie' },
      { env: {}, fetchImpl });
    const second = await addTesterToBetaGroup(
      { email: 'other@example.com', displayName: 'Oth Er' },
      { env: {}, fetchImpl });
    return [first, second];
  });

  assert.deepEqual(value[0], { added: false, reason: 'not_configured' });
  assert.deepEqual(value[1], { added: false, reason: 'not_configured' });
  assert.equal(fetchImpl.calls.length, 0, 'nothing may be sent to Apple');
  assert.equal(lines.filter(l => l.includes('provisioning disabled')).length, 1,
    'the notice is logged once per process, not once per invitation');
});

// ── The two properties that matter ──────────────────────────────────────────

test('it never rejects, whatever Apple or the network does', async () => {
  const disasters = [
    { label: 'network failure', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
    { label: 'malformed json', fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); }, text: async () => 'oops' }) },
    { label: '401 bad key', fetchImpl: recordingFetch(() => ({ status: 401, body: { errors: [{ code: 'NOT_AUTHORIZED' }] } })) },
    { label: '429 throttled', fetchImpl: recordingFetch(() => ({ status: 429, body: { errors: [{ code: 'RATE_LIMIT' }] } })) },
    { label: '503 outage', fetchImpl: recordingFetch(() => ({ status: 503, body: {} })) }
  ];

  for (const { label, fetchImpl } of disasters) {
    const { value } = await captureConsole(() => addTesterToBetaGroup(
      { email: 'newbie@example.com', displayName: 'New Bie' },
      { env: configuredEnv(), fetchImpl }));
    assert.equal(typeof value, 'object', `${label} must resolve`);
    assert.equal(value.added, false, label);
    assert.ok(value.reason, `${label} must say why`);
  }
});

test('no log line carries the signing key, the JWT, or the full address', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 401, body: { errors: [{ code: 'NOT_AUTHORIZED' }] } }));
  const { lines } = await captureConsole(() => addTesterToBetaGroup(
    { email: 'verysecret.person@example.com', displayName: 'Very Secret' },
    { env: configuredEnv(), fetchImpl }));

  const all = lines.join('\n');
  assert.equal(all.includes(TEST_KEY_B64), false, 'the key must never be logged');
  assert.equal(all.includes('BEGIN PRIVATE KEY'), false, 'nor the decoded PEM');
  assert.equal(all.includes('verysecret.person@example.com'), false, 'nor the full address');
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(all), false, 'nor anything JWT-shaped');
});

test('redactEmail keeps enough to identify a row and not enough to be a disclosure', () => {
  const redacted = redactEmail('dominic.pandolfo@example.com');
  assert.equal(redacted.includes('dominic.pandolfo'), false);
  assert.ok(redacted.length > 0);
});

// ── The request Apple actually receives ─────────────────────────────────────

test('a successful add posts the tester and relates them to the beta group', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 201, body: { data: { id: 'tester-1' } } }));
  const { value } = await captureConsole(() => addTesterToBetaGroup(
    { email: 'newbie@example.com', displayName: 'New Bie' },
    { env: configuredEnv(), fetchImpl }));

  assert.equal(value.added, true);
  assert.ok(fetchImpl.calls.length >= 1);

  const first = fetchImpl.calls[0];
  assert.match(first.url, /api\.appstoreconnect\.apple\.com/);
  assert.match(first.init.headers.Authorization || first.init.headers.authorization, /^Bearer eyJ/);

  const sent = JSON.parse(first.init.body);
  assert.equal(sent.data.attributes.email, 'newbie@example.com');
  assert.equal(sent.data.attributes.firstName, 'New');
  assert.equal(sent.data.attributes.lastName, 'Bie');
});

test('already a tester is success, not failure', async () => {
  for (const duplicate of [
    { status: 409, body: {} },
    { status: 409, body: { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE' }] } },
    { status: 400, body: { errors: [{ code: 'ENTITY_ERROR_DUPLICATE' }] } }
  ]) {
    const { value } = await captureConsole(() => addTesterToBetaGroup(
      { email: 'already@example.com', displayName: 'Al Ready' },
      { env: configuredEnv(), fetchImpl: recordingFetch(() => duplicate) }));
    assert.equal(value.added, true, 'a person who is already a tester can install the app');
    assert.equal(value.alreadyExisted, true);
  }
});

test('a malformed address is refused locally, without a round trip', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 201 }));
  const { value } = await captureConsole(() => addTesterToBetaGroup(
    { email: 'not-an-email', displayName: 'No Body' },
    { env: configuredEnv(), fetchImpl }));
  assert.equal(value.added, false);
  assert.equal(value.reason, 'invalid_email');
  assert.equal(fetchImpl.calls.length, 0);
});

// ── Name handling ───────────────────────────────────────────────────────────

test('names split sensibly, and an absent part is null rather than empty', () => {
  // Apple requires only `email`; firstName and lastName are optional. So a
  // mononym is a legitimate record, not a case to paper over with a
  // placeholder surname.
  assert.deepEqual(splitDisplayName('Cher'), { firstName: 'Cher', lastName: null });
  assert.deepEqual(splitDisplayName('Dominic Pandolfo'), { firstName: 'Dominic', lastName: 'Pandolfo' });
  // Everything after the first token is the surname, so a middle name is not
  // silently discarded.
  assert.deepEqual(splitDisplayName('Mary Jane Watson'), { firstName: 'Mary', lastName: 'Jane Watson' });
  assert.deepEqual(splitDisplayName('   '), { firstName: null, lastName: null });
});

test('an absent name is omitted from the payload, never sent as null', async () => {
  // Apple rejects an explicit null on an optional attribute. Serialising
  // `lastName: null` would fail every mononym with an error that reads as a
  // credential problem rather than a data one.
  const fetchImpl = recordingFetch(() => ({ status: 201, body: { data: { id: 'tester-1' } } }));
  await captureConsole(() => addTesterToBetaGroup(
    { email: 'cher@example.com', displayName: 'Cher' },
    { env: configuredEnv(), fetchImpl }));

  const attributes = JSON.parse(fetchImpl.calls[0].init.body).data.attributes;
  assert.deepEqual(attributes, { email: 'cher@example.com', firstName: 'Cher' });
  assert.equal('lastName' in attributes, false, 'the key is absent, not null');
});

// ── The JWT ─────────────────────────────────────────────────────────────────

test('the provider token is a signed ES256 JWT with the audience Apple requires', () => {
  const token = providerToken(configuration(configuredEnv()));
  const [header, claims, signature] = token.split('.');
  assert.ok(signature && signature.length > 0, 'it is signed');

  const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  assert.equal(decode(header).alg, 'ES256');
  assert.equal(decode(header).kid, 'ABCD123456');
  assert.equal(decode(claims).iss, '11111111-2222-3333-4444-555555555555');
  assert.equal(decode(claims).aud, 'appstoreconnect-v1');
  assert.ok(decode(claims).exp > decode(claims).iat, 'it expires after it is issued');
});
