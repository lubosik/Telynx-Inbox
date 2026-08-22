'use strict';
/**
 * lib/password-reset.js — self-service "I forgot my password".
 *
 * Two public endpoints live in routes/auth.js and do almost nothing; the
 * behaviour is here so that the shared route file takes the smallest possible
 * addition:
 *
 *   POST /auth/password-reset/request   { email }
 *   POST /auth/password-reset/confirm   { token, password }
 *
 * This is deliberately the same shape as routes/invitations.js, which is the
 * working precedent in this repository for a mailed, single-use, token-bearing
 * credential. Where the two differ, the difference is called out below.
 *
 * TOKEN HANDLING — IDENTICAL TO AN INVITATION
 *   crypto.randomBytes(32), base64url. The raw token goes into exactly one
 *   place, the email body, and is then discarded. What is stored is its sha256
 *   hex plus an 8-character prefix OF THAT HASH, never of the token itself, so
 *   a database dump yields neither a working reset link nor a head start on
 *   guessing one. Unlike an invitation, the raw token is never returned in an
 *   HTTP response either: there is no admin in this flow to hand it to.
 *
 *   The token is never logged. Not at error level, not in development, and not
 *   inside a URL assembled for a log line. lib/email.js logs neither the body
 *   nor the recipient of a successful send for the same reason.
 *
 * NO ACCOUNT-EXISTENCE ORACLE
 *   `requestPasswordReset` resolves to an internal outcome for the auth trail
 *   and NOTHING ELSE. The caller must answer the same status, the same body and
 *   (via `settleAfter`) the same wall-clock time for every outcome, including
 *   the ones where no row was written and no mail was sent. That is why:
 *
 *     * a missing account, the legacy shared identity, a deactivated account,
 *       an unset APP_URL and an outright storage failure all resolve rather
 *       than throw;
 *     * the mail is dispatched WITHOUT being awaited. Awaiting it would put a
 *       provider round trip on the account-exists branch only, and response
 *       latency alone would then enumerate who works here. routes/auth.js
 *       already pays for a dummy scrypt verification on the unknown-email login
 *       branch for exactly this reason; this is the same defence applied to the
 *       one remaining unauthenticated endpoint that takes an email address.
 *
 * THE LEGACY SHARED IDENTITY CANNOT BE RESET
 *   Its credential is INBOX_PASSWORD, held by Railway, not a row in sms_users
 *   (the sms_users_legacy_has_no_password CHECK enforces that). A reset would
 *   have nothing to write. It is refused, and refused with the same response as
 *   every other case so that "this address is the shared login" is not an
 *   oracle either.
 *
 * CONCURRENCY
 *   Confirmation goes through complete_sms_password_reset, a SECURITY DEFINER
 *   function that does SELECT ... FOR UPDATE on the reset row and then rewrites
 *   the password, bumps the session epoch, clears the lockout and marks the row
 *   used in one transaction. Two simultaneous confirmations of one token
 *   therefore produce exactly one password change; the loser sees RESET_USED.
 *   Do not reimplement this as read-then-write in Node — that race is precisely
 *   what the function exists to remove.
 *
 * WHAT A COMPLETED RESET DOES BEYOND SETTING THE HASH
 *   * Bumps session_epoch, which ends every existing session for that person,
 *     including on a device they no longer hold. A password reset that left an
 *     attacker's session alive would be theatre.
 *   * Clears failed_login_count and locked_until. Without this, anybody locked
 *     out by an attacker guessing at their password could never recover: the
 *     lock outranks a correct password in routes/auth.js, by design.
 *   * Clears must_change_password. They just chose this password themselves,
 *     seconds ago, and nobody else has ever seen it.
 *
 * EXPIRY IS ENFORCED IN SQL
 *   The 60 minutes is stated in the email AND checked inside the function
 *   against now(). The email copy is a courtesy; the CHECK is the control.
 */

const crypto = require('crypto');

/** Same size as an invitation token. 256 bits of randomBytes. */
const TOKEN_BYTES = 32;

/** Characters of the HASH kept for log/debug identification. Never of the token. */
const TOKEN_PREFIX_LENGTH = 8;

/** Stated in the email and enforced by complete_sms_password_reset. */
const EXPIRY_MINUTES = 60;

/**
 * The floor every /auth/password-reset/request response waits for.
 *
 * The account-exists branch costs one extra RPC round trip; the unknown-address
 * branch costs one lookup. Padding both to a fixed floor removes that
 * difference from the wire. 600ms is comfortably above a Supabase round trip
 * from Railway and low enough that a human does not read it as a stall.
 */
const MIN_RESPONSE_MS = 600;

/**
 * The single answer POST /auth/password-reset/request gives to everybody.
 * It is a constant so that no future branch can accidentally reword itself
 * into a signal. No em dashes: standing rule for user-facing copy here.
 */
const GENERIC_REQUEST_MESSAGE =
  'If an account exists for that address, a reset link is on its way.';

/** Deliberately the same shape check routes/invitations.js uses. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bounds on the token accepted by the confirm endpoint, before any lookup. */
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

/** Deterministic, so the confirm path can look a token up without storing it. */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * A prefix of the HASH, never of the token.
 * @param {string} tokenHash sha256 hex
 */
function tokenPrefixOfHash(tokenHash) {
  return String(tokenHash).slice(0, TOKEN_PREFIX_LENGTH);
}

/**
 * Maps the SQL function's RAISE messages onto HTTP.
 *
 * Four distinct causes, four distinct codes. A single "that link is not valid"
 * for all of them would tell somebody whose link expired ten minutes ago to go
 * hunting for a typo. None of them is an existence oracle: reaching any of them
 * at all requires already holding a token.
 */
const CONFIRM_ERRORS = Object.freeze({
  RESET_NOT_FOUND:   { status: 404, message: 'That reset link is not valid.' },
  RESET_USED:        { status: 409, message: 'That reset link has already been used. Ask for a new one.' },
  RESET_CANCELLED:   { status: 409, message: 'That reset link was replaced by a newer one. Use the most recent email.' },
  RESET_EXPIRED:     { status: 410, message: 'That reset link has expired. Ask for a new one.' },
  RESET_NOT_ALLOWED: { status: 403, message: 'That account cannot be reset here. Ask an admin.' }
});

function confirmErrorFrom(error) {
  const message = String(error?.message || '');
  for (const code of Object.keys(CONFIRM_ERRORS)) {
    if (message.includes(code)) return { code, ...CONFIRM_ERRORS[code] };
  }
  return null;
}

/**
 * `${APP_URL}/reset-password?token=...`, or null when APP_URL is unset.
 *
 * The same URL does both jobs, exactly as the accept-invite link does: it is
 * the Universal Link iOS claims for the app (lib/apple-site-association.js) and
 * the address a browser opens when the app is not installed.
 *
 * @param {string} rawToken
 * @param {string} base  already trimmed of trailing slashes by appUrl()
 * @returns {string|null}
 */
function resetUrlFor(rawToken, base) {
  const root = String(base || '').replace(/\/+$/, '');
  return root ? `${root}/reset-password?token=${encodeURIComponent(rawToken)}` : null;
}

/** ISO timestamp EXPIRY_MINUTES from `from`. */
function expiryFrom(from = Date.now()) {
  return new Date(from + EXPIRY_MINUTES * 60 * 1000).toISOString();
}

/**
 * Resolve no sooner than `floorMs` after `startedAt`.
 *
 * Injectable sleep so the tests can assert the floor is applied to every branch
 * without actually waiting for it.
 *
 * @param {number} startedAt  Date.now() at the top of the handler
 * @param {number} floorMs
 * @param {{sleep?: (ms:number)=>Promise<void>, now?: ()=>number}} [options]
 */
async function settleAfter(startedAt, floorMs, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }));
  const remaining = Number(floorMs) - (now() - Number(startedAt));
  if (remaining > 0) await sleep(remaining);
  return remaining > 0 ? remaining : 0;
}

/**
 * Dispatch a promise nobody is waiting for, without a rejection escaping.
 *
 * `.then(onFulfilled, onRejected)` rather than `.catch()`: this file also
 * touches Supabase builders, which are thenables with no `catch`, and
 * test/no-builder-catch.test.js exists because that distinction already caused
 * an outage. Keeping one shape here means the wrong one is never nearby to
 * copy.
 *
 * @param {Promise<unknown>} promise
 * @param {string} label  never contains a token, a URL or an address
 */
function detach(promise, label) {
  Promise.resolve(promise).then(
    () => {},
    error => console.warn(`[RESET] ${label}: ${error?.code || error?.message || 'unknown'}`)
  );
}

/**
 * Storage seam. Injected wholesale by the tests, exactly like the invitation
 * store, so no test needs a database or a network.
 *
 * @param {{client?: object}} [options]
 */
function createPasswordResetStore({ client } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }

  function unwrap(result, context) {
    if (result.error) {
      throw Object.assign(new Error(result.error.message), { code: 'PASSWORD_RESET_STORE_FAILED', context });
    }
    return result.data;
  }

  return {
    /**
     * The account for an address, or null.
     *
     * password_hash is NOT selected. Nothing in this flow verifies an existing
     * password, so reading the hash would be pure liability. The columns are
     * exactly what the decision needs: who, whether they are the shared
     * identity, and whether they are still active.
     *
     * `ilike` with % and _ escaped, matching lib/authz.js: PostgREST has no
     * lower() filter and the unique index is on lower(email), so at most one
     * row can come back. Two would mean the index is gone, and this returns
     * null rather than guessing which person to mail.
     */
    async findAccountByEmail(email) {
      const escaped = String(email).replace(/([\\%_])/g, '\\$1');
      const rows = unwrap(
        await db()
          .from('sms_users')
          .select('id, email, display_name, is_active, is_legacy_shared')
          .ilike('email', escaped)
          .limit(2),
        'findAccountByEmail'
      );
      if (!Array.isArray(rows) || rows.length !== 1) return null;
      return rows[0];
    },

    /**
     * Cancel any open request for this person and insert a new one, in one
     * transaction. Two of these racing cannot both leave an open row, which is
     * what the partial unique index in the migration expects.
     *
     * @returns {Promise<string>} the new request's id
     */
    async open({ userId, tokenHash, tokenPrefix, expiresAt, ip, userAgent }) {
      const result = await db().rpc('open_sms_password_reset', {
        p_user_id: userId,
        p_token_hash: tokenHash,
        p_token_prefix: tokenPrefix,
        p_expires_at: expiresAt,
        p_ip: ip ?? null,
        p_user_agent: userAgent ?? null
      });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'PASSWORD_RESET_OPEN_FAILED' });
      }
      return result.data;
    },

    /**
     * Spend the token and rewrite the password, atomically.
     *
     * @returns {Promise<number>} the id of the user whose password changed
     */
    async complete(tokenHash, passwordHash) {
      const result = await db().rpc('complete_sms_password_reset', {
        p_token_hash: tokenHash,
        p_password_hash: passwordHash
      });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'PASSWORD_RESET_COMPLETE_FAILED' });
      }
      return result.data;
    },

    /**
     * Who the reset belonged to, for the audit summary only. Best-effort by
     * construction: the password has already been committed by the time this
     * runs, so a failure here must cost an audit row and nothing else.
     */
    async describeUser(userId) {
      return unwrap(
        await db()
          .from('sms_users')
          .select('id, email, display_name, role')
          .eq('id', userId)
          .maybeSingle(),
        'describeUser'
      );
    },

    /**
     * Best-effort attempt counter for a failed confirmation. The SQL function
     * raises, which rolls its own transaction back, so a failed attempt cannot
     * increment from inside it. Mirrors noteAttempt in routes/invitations.js,
     * including its tolerance of failure: sms_auth_events is the trail that
     * matters.
     */
    async noteAttempt(tokenHash) {
      try {
        const found = await db()
          .from('sms_password_resets')
          .select('id, attempt_count')
          .eq('token_hash', tokenHash)
          .maybeSingle();
        if (found.error || !found.data) return;
        const bumped = await db()
          .from('sms_password_resets')
          .update({ attempt_count: (found.data.attempt_count || 0) + 1 })
          .eq('id', found.data.id);
        if (bumped.error) console.warn('[RESET] attempt_count not recorded:', bumped.error.message);
      } catch (err) {
        console.warn('[RESET] attempt_count not recorded:', err.message);
      }
    }
  };
}

/**
 * The internal outcomes of a reset request.
 *
 * NONE of these may reach the client. They exist for sms_auth_events, which is
 * a private table nobody outside the service reads. The response is
 * GENERIC_REQUEST_MESSAGE in every single case.
 */
const REQUEST_OUTCOMES = Object.freeze({
  SENT: 'sent',                     // row written, mail dispatched
  NO_ACCOUNT: 'no_account',         // nobody has that address
  LEGACY_SHARED: 'legacy_shared',   // the shared identity; no row to reset
  INACTIVE: 'inactive',             // deactivated account
  NO_APP_URL: 'no_app_url',         // APP_URL unset, so no link can be built
  STORE_FAILED: 'store_failed'      // the write failed; the caller still says nothing
});

/** sms_auth_events codes, one per outcome. */
const REQUEST_EVENT_CODES = Object.freeze({
  sent: 'OK',
  no_account: 'NO_ACCOUNT',
  legacy_shared: 'LEGACY_SHARED',
  inactive: 'ACCOUNT_DISABLED',
  no_app_url: 'NO_APP_URL',
  store_failed: 'RESET_STORE_FAILED'
});

/**
 * Handle one reset request.
 *
 * NEVER REJECTS. Every failure resolves to an outcome, because a 503 on the
 * account-exists branch and a 202 everywhere else is the same oracle this
 * whole design exists to remove.
 *
 * The email is dispatched and NOT awaited; see the header. Its result is
 * therefore unavailable to the caller on purpose, and must not be reported.
 *
 * @param {object} input
 * @param {object} input.store            createPasswordResetStore(), or a fake
 * @param {string} input.email            already shape-checked by the caller
 * @param {(message: object) => Promise<object>} input.sendMail  lib/email.js sendEmail
 * @param {(reset: object) => {subject:string,text:string,html:string}} input.buildEmail
 * @param {string} input.baseUrl          appUrl()
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @param {() => number} [input.now]
 * @returns {Promise<{outcome: string, userId: number|null}>}
 */
async function requestPasswordReset(input) {
  const { store, email, sendMail, buildEmail, baseUrl } = input;
  const now = input.now || Date.now;

  let account = null;
  try {
    account = await store.findAccountByEmail(email);
  } catch (error) {
    // Reaches both branches equally: the lookup runs before anything is known
    // about the address, so a database outage is not a signal about it.
    console.warn('[RESET] Account lookup failed:', error?.code || 'internal_error');
    return { outcome: REQUEST_OUTCOMES.STORE_FAILED, userId: null };
  }

  if (!account) return { outcome: REQUEST_OUTCOMES.NO_ACCOUNT, userId: null };
  if (account.is_legacy_shared === true) {
    return { outcome: REQUEST_OUTCOMES.LEGACY_SHARED, userId: account.id };
  }
  if (account.is_active !== true) {
    return { outcome: REQUEST_OUTCOMES.INACTIVE, userId: account.id };
  }

  // Minted before the row so the hash is all that is ever passed downwards.
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const resetUrl = resetUrlFor(rawToken, baseUrl);
  if (!resetUrl) {
    // No link means no usable reset, and writing a row would pointlessly
    // supersede one that might still work. Neither the token nor the address
    // appears in this warning.
    console.warn('[RESET] Not sending a reset: APP_URL is not set, so the link cannot be built');
    return { outcome: REQUEST_OUTCOMES.NO_APP_URL, userId: account.id };
  }

  const expiresAt = expiryFrom(now());
  try {
    await store.open({
      userId: account.id,
      tokenHash,
      tokenPrefix: tokenPrefixOfHash(tokenHash),
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null
    });
  } catch (error) {
    console.warn('[RESET] Reset request not stored:', error?.code || 'internal_error');
    return { outcome: REQUEST_OUTCOMES.STORE_FAILED, userId: account.id };
  }

  // Strictly after the row is committed, and strictly not awaited.
  //
  // A send failure leaves an unused row that expires in an hour and an account
  // whose password, sessions and lockout state are all untouched. That is the
  // correct failure: the person asks again. The opposite ordering, or rolling
  // the row back on a mail failure, would be worse in every case.
  const message = buildEmail({
    recipientName: account.display_name,
    resetUrl,
    expiresAt
  });
  detach(
    sendMail({ to: account.email, subject: message.subject, text: message.text, html: message.html }),
    'reset email not dispatched'
  );

  return { outcome: REQUEST_OUTCOMES.SENT, userId: account.id };
}

module.exports = {
  CONFIRM_ERRORS,
  EMAIL_PATTERN,
  EXPIRY_MINUTES,
  GENERIC_REQUEST_MESSAGE,
  MAX_TOKEN_LENGTH,
  MIN_RESPONSE_MS,
  MIN_TOKEN_LENGTH,
  REQUEST_EVENT_CODES,
  REQUEST_OUTCOMES,
  TOKEN_BYTES,
  TOKEN_PREFIX_LENGTH,
  confirmErrorFrom,
  createPasswordResetStore,
  detach,
  expiryFrom,
  generateToken,
  hashToken,
  requestPasswordReset,
  resetUrlFor,
  settleAfter,
  tokenPrefixOfHash
};
