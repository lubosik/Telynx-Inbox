'use strict';
/**
 * lib/testflight-testers.js — add an invitee to the TestFlight beta group.
 *
 * WHY THIS EXISTS
 *   The team invitation email links to a Universal Link that opens the native
 *   app. A brand-new teammate does not have the app, and cannot get it: Vici
 *   Inbox is not on the App Store, it is distributed through TestFlight, and
 *   TestFlight will not let anybody install a build unless Apple already knows
 *   them as a beta tester. So the invitation email arrived pointing at an app
 *   the recipient had no way to obtain, and the link had nothing to open. This
 *   module closes that gap by registering the invitee with App Store Connect at
 *   the moment they are invited, so Apple's own "you're invited to test" email
 *   and the team invitation arrive together.
 *
 * THE CONTRACT: THIS MODULE NEVER THROWS AND NEVER REJECTS.
 *   Every path — missing configuration, an unparseable key, a 4xx, a 5xx, a DNS
 *   failure, a timeout — resolves to a plain `{ added: boolean, reason }`
 *   object. Provisioning a tester is a courtesy attached to an operation that
 *   has already succeeded: the invitation row is committed and its one-time
 *   link is already in the response body. A TestFlight failure must never
 *   surface as a failed invitation. This mirrors lib/email.js exactly, and for
 *   the same reason.
 *
 * NOT-CONFIGURED IS THE NORMAL PATH ON DEPLOY DAY.
 *   None of the ASC_* variables exist in Railway yet. Without the full set this
 *   returns `{ added: false, reason: 'not_configured' }`, logs ONCE for the life
 *   of the process, and does nothing else — matching `reportMissingConfiguration()`
 *   in lib/apns-notify.js and lib/email.js. Logging per invitation would turn a
 *   known, accepted gap into recurring noise.
 *
 * ALREADY A TESTER IS SUCCESS, NOT FAILURE.
 *   Apple answers 409 when the address is already registered. That is precisely
 *   the state the caller wanted, so it resolves to
 *   `{ added: true, alreadyExisted: true }`. Reporting it as a failure would
 *   make re-inviting somebody look broken and would push an admin into manual
 *   work that is already done.
 *
 * AUTHENTICATION
 *   An ES256 JWT, assembled here with node:crypto — no npm dependency, exactly
 *   as lib/apns-notify.js builds its APNs provider token. The claim shape is
 *   copied from ios/scripts/publish-testflight-build.py, which is the working
 *   implementation this repository already ships:
 *     header  { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }
 *     claims  { iss: ASC_ISSUER_ID, iat, exp: iat + 900, aud: 'appstoreconnect-v1' }
 *   The token is NOT cached. Invitations are rare — a handful per year — so a
 *   cache would only add a stale-credential failure mode for no saving.
 *
 * WHAT MUST NEVER BE LOGGED
 *   The .p8, the assembled JWT, the issuer id, the key id, and the invitee's
 *   full email address. A log line that names the tester defeats the point of
 *   redacting the same address in lib/email.js three lines earlier. Failures are
 *   identified by HTTP status and a redacted recipient (`j***@example.com`),
 *   which answers "did this person get provisioned?" without writing an address
 *   into a log aggregator.
 *
 * IDENTIFIERS ARE NOT INTERCHANGEABLE
 *   AGENTS.md is explicit that the Apple Developer Team ID, the App Store
 *   Connect issuer id, the API key id, the bundle id and the numeric app id are
 *   five distinct things. This module reads the issuer id and the key id and
 *   NOTHING else; in particular it never falls back to APNS_TEAM_ID, which is a
 *   Team ID and is not an issuer id. lib/apple-site-association.js does read
 *   APNS_TEAM_ID, because there it genuinely is the same value.
 */

const crypto = require('node:crypto');

const API_BASE = 'https://api.appstoreconnect.apple.com';
const AUDIENCE = 'appstoreconnect-v1';
const TOKEN_TTL_SECONDS = 900;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Apple rejects an over-long name with a 422. Trimming here turns a guaranteed
 * failure into a successful registration with a slightly clipped name, which is
 * the better outcome for somebody who just needs to install an app.
 */
const MAX_NAME_LENGTH = 50;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Logged at most once per process; see lib/apns-notify.js for the pattern. */
let didLogMissingConfiguration = false;

/** Test hook for the "log the missing configuration once" behaviour. */
function resetMissingConfigurationLog() {
  didLogMissingConfiguration = false;
}

/**
 * `jane.doe@example.com` -> `j***@example.com`.
 * Copied deliberately from lib/email.js rather than shared: the two modules are
 * independent seams and neither should be able to break the other's redaction.
 */
function redactEmail(address) {
  const value = String(address ?? '');
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/**
 * "Dominic Barrett" -> { firstName: 'Dominic', lastName: 'Barrett' }
 * "Ana Maria de Souza" -> { firstName: 'Ana', lastName: 'Maria de Souza' }
 * "Prince" -> { firstName: 'Prince', lastName: null }
 * "" -> { firstName: null, lastName: null }
 *
 * Everything after the first token becomes the surname rather than only the
 * last token, because "de Souza" and "van der Berg" are surnames and splitting
 * on the LAST space would file those people under "der" and "de".
 *
 * A single-word name yields a null lastName, which is omitted from the request
 * entirely. Sending an empty string instead is a 422 from Apple, and inventing
 * a placeholder surname would put a name in somebody's TestFlight profile that
 * is not theirs.
 *
 * @param {string} displayName
 * @returns {{firstName: string|null, lastName: string|null}}
 */
function splitDisplayName(displayName) {
  const parts = String(displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  const clip = value => value.slice(0, MAX_NAME_LENGTH);
  if (parts.length === 1) return { firstName: clip(parts[0]), lastName: null };
  return { firstName: clip(parts[0]), lastName: clip(parts.slice(1).join(' ')) };
}

/**
 * The .p8 private key as PEM, or null when it is absent or not valid base64.
 * Returns null rather than throwing so a mangled Railway variable degrades to
 * "not configured" instead of taking down an invitation.
 */
function privateKeyPEM(env) {
  const encoded = String(env.ASC_KEY_P8_BASE64 || '').trim();
  if (!encoded) return null;
  try {
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    return pem.includes('PRIVATE KEY') ? pem : null;
  } catch {
    return null;
  }
}

/**
 * The complete credential set, or null when any part of it is missing.
 *
 * ASC_APP_ID is read but is NOT part of this check. The betaTesters create
 * request does not carry an app id — the beta group already belongs to an app —
 * so requiring it would refuse to provision anybody over a value the call does
 * not use. It is kept because it names, in the audit summary and in this
 * module's return value, WHICH app somebody was just given access to, and that
 * is not answerable later from a group UUID alone.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{issuerId: string, keyId: string, privateKey: string, betaGroupId: string, appId: string|null}|null}
 */
function configuration(env = process.env) {
  const issuerId = String(env.ASC_ISSUER_ID || '').trim();
  const keyId = String(env.ASC_KEY_ID || '').trim();
  const betaGroupId = String(env.ASC_BETA_GROUP_ID || '').trim();
  const appId = String(env.ASC_APP_ID || '').trim() || null;
  const privateKey = privateKeyPEM(env);
  if (!issuerId || !keyId || !betaGroupId || !privateKey) return null;
  return { issuerId, keyId, privateKey, betaGroupId, appId };
}

/** True when a real call would be attempted. Lets a caller report honestly. */
function isTestFlightConfigured(env = process.env) {
  return configuration(env) !== null;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * A short-lived ES256 bearer token for the App Store Connect API.
 *
 * `dsaEncoding: 'ieee-p1363'` is not optional. Node's default for ECDSA is DER,
 * and a DER signature in a JWS is silently rejected as a bad signature — the
 * same detail lib/apns-notify.js depends on.
 *
 * @throws if the private key cannot be parsed. The only caller wraps this.
 */
function providerToken(config, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: config.issuerId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    aud: AUDIENCE
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Apple's error payload is `{ errors: [{ status, code, title, detail }] }`.
 * Only `code` is taken: `detail` frequently echoes the submitted email address
 * back, and this module must not log that.
 */
function appleErrorCodes(payload) {
  if (!payload || !Array.isArray(payload.errors)) return [];
  return payload.errors
    .map(entry => String(entry?.code || '').trim())
    .filter(Boolean);
}

/**
 * True when a 4xx means "this person is already a tester".
 *
 * 409 is the documented duplicate response. The code check is a second reading
 * of the same fact for the cases where Apple answers 409's meaning with a
 * different status, and is narrow on purpose: mistaking a real failure for a
 * success here would silently leave somebody unable to install the app while
 * the API reported that they could.
 */
function isDuplicate(status, payload) {
  if (status === 409) return true;
  return appleErrorCodes(payload).some(code => code.toUpperCase().includes('DUPLICATE'));
}

/**
 * Add one person to the configured TestFlight beta group.
 *
 * Resolves to the shape POST /api/invitations reports verbatim. It cannot
 * reject, so callers need no try/catch and cannot turn a TestFlight problem
 * into a failed invitation.
 *
 * @param {{email: string, displayName?: string}} invitee
 * @param {{env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number}} [options]
 * @returns {Promise<{added: boolean, alreadyExisted?: boolean, reason?: string, testerId?: string|null, appId?: string|null, betaGroupId?: string}>}
 */
async function addTesterToBetaGroup(invitee = {}, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const config = configuration(env);
  if (!config) {
    if (!didLogMissingConfiguration) {
      console.log(
        'TestFlight: tester provisioning disabled — ASC_ISSUER_ID / ASC_KEY_ID / '
        + 'ASC_KEY_P8_BASE64 / ASC_BETA_GROUP_ID are not configured'
      );
      didLogMissingConfiguration = true;
    }
    return { added: false, reason: 'not_configured' };
  }

  const email = String(invitee.email || '').trim();
  if (!EMAIL_PATTERN.test(email)) {
    // Reached only by a caller that skipped its own validation. Refuse locally
    // rather than spend a round trip proving Apple agrees.
    console.warn('TestFlight: refusing to register a malformed address');
    return { added: false, reason: 'invalid_email' };
  }

  if (typeof fetchImpl !== 'function') {
    console.error('TestFlight: no fetch implementation is available in this runtime');
    return { added: false, reason: 'no_fetch' };
  }

  let authorization;
  try {
    authorization = providerToken(config, options.now ? options.now() : Date.now());
  } catch (error) {
    // The message can name the OpenSSL failure but never the key material.
    console.error('TestFlight: could not sign an App Store Connect token:', error.message);
    return { added: false, reason: 'bad_private_key' };
  }

  const { firstName, lastName } = splitDisplayName(invitee.displayName);
  const attributes = { email };
  if (firstName) attributes.firstName = firstName;
  if (lastName) attributes.lastName = lastName;

  const body = {
    data: {
      type: 'betaTesters',
      attributes,
      relationships: {
        betaGroups: {
          data: [{ type: 'betaGroups', id: config.betaGroupId }]
        }
      }
    }
  };

  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/betaTesters`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorization}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'timeout'
      : 'network_error';
    console.error(
      `TestFlight: could not reach App Store Connect for ${redactEmail(email)} (${reason})`
    );
    return { added: false, reason };
  }

  const status = Number(response?.status || 0);
  let payload = null;
  try {
    const raw = await response.text();
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // A body that is absent or not JSON is normal for some statuses and is not
    // itself a failure. The status decides the outcome.
    payload = null;
  }

  if (status === 201 || status === 200) {
    const testerId = payload?.data?.id ? String(payload.data.id) : null;
    return {
      added: true,
      alreadyExisted: false,
      testerId,
      appId: config.appId,
      betaGroupId: config.betaGroupId
    };
  }

  if (isDuplicate(status, payload)) {
    // Already a tester. That is the state the caller asked for, so it succeeded.
    return {
      added: true,
      alreadyExisted: true,
      testerId: null,
      appId: config.appId,
      betaGroupId: config.betaGroupId
    };
  }

  const codes = appleErrorCodes(payload);
  console.error(
    `TestFlight: App Store Connect refused to register ${redactEmail(email)} `
    + `(HTTP ${status}${codes.length ? ` ${codes.join(',')}` : ''})`
  );
  return { added: false, reason: `http_${status || 'unknown'}` };
}

module.exports = {
  API_BASE,
  AUDIENCE,
  MAX_NAME_LENGTH,
  TOKEN_TTL_SECONDS,
  addTesterToBetaGroup,
  configuration,
  isTestFlightConfigured,
  providerToken,
  redactEmail,
  resetMissingConfigurationLog,
  splitDisplayName
};
