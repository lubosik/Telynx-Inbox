'use strict';
/**
 * lib/password.js — password hashing for named accounts.
 *
 * scrypt from node:crypto only. This repo has zero native dependencies and a
 * plain `npm ci` Railway build; adding argon2 or bcrypt would introduce a
 * compiler step into the deploy path. scrypt is memory-hard, is in the standard
 * library, and is good enough for a team of single-digit size.
 *
 * Stored format:
 *
 *   scrypt$1$N=16384,r=8,p=1,len=64$<salt-base64>$<hash-base64>
 *
 * The `scrypt` algorithm tag and the `1` version exist so a future argon2id
 * hash can sit in the same column and be verified by the same function. Never
 * strip them; verify() dispatches on them.
 *
 * Parameters are stored per-hash rather than read from a constant, so raising
 * the cost later does not invalidate existing passwords.
 */

const crypto = require('crypto');

const ALGORITHM = 'scrypt';
const VERSION = '1';

// N=16384 (2^14), r=8, p=1 is the Node default and the scrypt paper's
// interactive-login parameter set. maxmem must be raised above Node's 32 MB
// default because 128 * N * r = 16 MB and Node wants headroom.
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, len: 64 });
const SALT_BYTES = 16;

class PasswordFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PasswordFormatError';
    this.code = 'PASSWORD_FORMAT_INVALID';
  }
}

function maxmemFor({ N, r, p }) {
  return Math.max(32 * 1024 * 1024, 256 * N * r * p);
}

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      params.len,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function formatParams(params) {
  return `N=${params.N},r=${params.r},p=${params.p},len=${params.len}`;
}

function parseParams(text) {
  const out = {};
  for (const pair of String(text).split(',')) {
    const [key, rawValue] = pair.split('=');
    const value = Number(rawValue);
    if (!key || !Number.isInteger(value) || value <= 0) {
      throw new PasswordFormatError('Malformed scrypt parameters.');
    }
    out[key] = value;
  }
  for (const key of ['N', 'r', 'p', 'len']) {
    if (!(key in out)) throw new PasswordFormatError(`Missing scrypt parameter ${key}.`);
  }
  // A hostile row could otherwise ask us to allocate gigabytes on a login.
  if (out.N > 1 << 20 || out.r > 64 || out.p > 16 || out.len > 256) {
    throw new PasswordFormatError('scrypt parameters outside the accepted range.');
  }
  return out;
}

/** Minimum viable policy. Deliberately length-first: length beats character classes. */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

function validatePasswordStrength(password) {
  if (typeof password !== 'string') return 'Password must be a string.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (!/\S/.test(password)) return 'Password must not be only whitespace.';
  return null;
}

/**
 * @param {string} password
 * @param {{N?:number,r?:number,p?:number,len?:number}} [overrides]
 * @returns {Promise<string>} the encoded hash, safe to store verbatim
 */
async function hashPassword(password, overrides = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordFormatError('Password must be a non-empty string.');
  }
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    ALGORITHM,
    VERSION,
    formatParams(params),
    salt.toString('base64'),
    key.toString('base64')
  ].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing for any
 * malformed or unknown-algorithm stored value, so a corrupted row is a failed
 * login rather than a 500 that leaks the difference.
 *
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;

  const parts = encoded.split('$');
  if (parts.length !== 5) return false;

  const [algorithm, version, paramText, saltB64, hashB64] = parts;
  if (algorithm !== ALGORITHM || version !== VERSION) return false;

  let params;
  let salt;
  let expected;
  try {
    params = parseParams(paramText);
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== params.len) return false;

  let actual;
  try {
    actual = await derive(password, salt, params);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * A real, verifiable hash of an unguessable random string.
 *
 * routes/auth.js verifies against this on the unknown-email branch so that an
 * unknown email and a wrong password cost the same scrypt work. Without it, an
 * attacker can enumerate valid addresses purely from response latency.
 *
 * Built once at module load: the cost belongs at boot, not on the request.
 */
const DUMMY_HASH_PROMISE = hashPassword(crypto.randomBytes(32).toString('hex'));

async function verifyAgainstDummy(password) {
  try {
    return await verifyPassword(String(password ?? ''), await DUMMY_HASH_PROMISE);
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePasswordStrength,
  PasswordFormatError,
  ALGORITHM,
  VERSION,
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH
};
