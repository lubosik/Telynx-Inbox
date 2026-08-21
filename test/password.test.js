'use strict';
/**
 * Password hashing is the one place in this codebase where a subtle bug is
 * silent: a verify() that returns true too easily looks exactly like a verify()
 * that works, right up until somebody signs in as somebody else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePasswordStrength,
  ALGORITHM,
  VERSION,
  DEFAULT_PARAMS
} = require('../lib/password');

// Cheap parameters keep the suite fast. Every property under test is
// independent of the work factor, and the encoded hash carries its own
// parameters, which is exactly the behaviour being relied on here.
const FAST = { N: 1024, r: 8, p: 1, len: 64 };

test('a hash round-trips and rejects the wrong password', async () => {
  const encoded = await hashPassword('correct horse battery staple', FAST);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('correct horse battery stapl', encoded), false);
  assert.equal(await verifyPassword('', encoded), false);
});

test('the encoding is versioned so a future argon2 hash can coexist', async () => {
  const encoded = await hashPassword('a-perfectly-fine-password', FAST);
  const parts = encoded.split('$');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], ALGORITHM);
  assert.equal(parts[1], VERSION);
  assert.equal(parts[2], `N=${FAST.N},r=${FAST.r},p=${FAST.p},len=${FAST.len}`);

  // An unknown algorithm tag must fail closed rather than be assumed scrypt.
  const foreign = ['argon2id', '1', 'm=65536,t=3,p=4', parts[3], parts[4]].join('$');
  assert.equal(await verifyPassword('a-perfectly-fine-password', foreign), false);
});

test('parameters are read from the stored hash, so raising the cost later keeps old passwords working', async () => {
  const cheap = await hashPassword('legacy-era-password', { N: 1024, r: 8, p: 1, len: 64 });
  const dear = await hashPassword('legacy-era-password', { N: 4096, r: 8, p: 1, len: 64 });
  assert.notEqual(cheap, dear);
  assert.equal(await verifyPassword('legacy-era-password', cheap), true);
  assert.equal(await verifyPassword('legacy-era-password', dear), true);
});

test('every hash of the same password is different, so a salt is really being used', async () => {
  const first = await hashPassword('identical-input-password', FAST);
  const second = await hashPassword('identical-input-password', FAST);
  assert.notEqual(first, second);
  assert.notEqual(first.split('$')[3], second.split('$')[3]);
});

test('a tampered hash is rejected', async () => {
  const encoded = await hashPassword('untouched-original-password', FAST);
  const [algorithm, version, params, salt, digest] = encoded.split('$');

  // Flip one bit of the digest.
  const bytes = Buffer.from(digest, 'base64');
  bytes[0] ^= 0x01;
  const flipped = [algorithm, version, params, salt, bytes.toString('base64')].join('$');
  assert.equal(await verifyPassword('untouched-original-password', flipped), false);

  // Swap the salt for another one.
  const otherSalt = crypto.randomBytes(16).toString('base64');
  const resalted = [algorithm, version, params, otherSalt, digest].join('$');
  assert.equal(await verifyPassword('untouched-original-password', resalted), false);

  // Truncate the digest. A naive implementation comparing prefixes passes here.
  const truncated = [algorithm, version, params, salt, bytes.subarray(0, 32).toString('base64')].join('$');
  assert.equal(await verifyPassword('untouched-original-password', truncated), false);
});

test('a corrupt or hostile stored value is a failed login, never a thrown 500', async () => {
  for (const bad of [
    '',
    'not-a-hash',
    'scrypt$1$N=1024,r=8,p=1,len=64$onlyfourparts',
    'scrypt$2$N=1024,r=8,p=1,len=64$c2FsdA==$aGFzaA==',
    'scrypt$1$N=notanumber,r=8,p=1,len=64$c2FsdA==$aGFzaA==',
    'scrypt$1$r=8,p=1,len=64$c2FsdA==$aGFzaA==',
    // A parameter set chosen to make the server allocate gigabytes.
    'scrypt$1$N=1073741824,r=64,p=16,len=64$c2FsdA==$aGFzaA==',
    null,
    undefined,
    12345
  ]) {
    assert.equal(await verifyPassword('anything-at-all', bad), false, `stored value: ${String(bad)}`);
  }
});

test('the dummy hash is a real verifiable hash that never matches', async () => {
  // routes/auth.js verifies against this on the unknown-email branch so that
  // an unknown address costs the same scrypt work as a wrong password. If it
  // ever short-circuits, response latency starts enumerating staff addresses.
  assert.equal(await verifyAgainstDummy('anything'), false);
  assert.equal(await verifyAgainstDummy(''), false);
  assert.equal(await verifyAgainstDummy(null), false);
});

test('password strength is length-first and bounded at both ends', () => {
  assert.equal(validatePasswordStrength('a-perfectly-fine-password'), null);
  assert.match(validatePasswordStrength('short'), /at least 12/);
  assert.match(validatePasswordStrength('x'.repeat(500)), /at most 200/);
  assert.match(validatePasswordStrength('              '), /whitespace/);
  assert.match(validatePasswordStrength(undefined), /must be a string/);
  assert.match(validatePasswordStrength(1234567890123), /must be a string/);
});

test('the shipped defaults are the interactive-login scrypt parameter set', () => {
  assert.deepEqual({ ...DEFAULT_PARAMS }, { N: 16384, r: 8, p: 1, len: 64 });
});
