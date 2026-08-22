'use strict';
/**
 * routes/auth.js — sign in, sign out, session check, invitation acceptance,
 * email-change confirmation.
 *
 * THE TWO PUBLIC TOKEN ROUTES
 *   POST /auth/invitation/accept and POST /auth/email-change/confirm are the
 *   only endpoints here that are neither a sign-in nor a session read. Both are
 *   public because the caller has no session by construction, both accept a
 *   token as their only credential, both compare it by sha256 against a stored
 *   digest, and both share `loginLimiter`. Their state transitions happen
 *   inside SQL functions that take a row lock, so concurrent redemption of one
 *   token yields exactly one effect.
 *
 * DUAL PATH LOGIN
 *   { email, password }  -> a named account.
 *   { password }         -> the single shared team login, backed by
 *                           INBOX_PASSWORD, gated by LEGACY_SHARED_LOGIN.
 *
 *   The success body is a strict SUPERSET of the previous `{ success: true }`.
 *   The already-shipped web bundle and the iOS binary in the field read only
 *   the status code, so both keep working untouched. Do not remove or rename
 *   `success`; an iOS build cannot be updated without a multi-day TestFlight
 *   round trip.
 *
 * THE SHARED LOGIN IS NOT A ROLE IN A COOKIE
 *   A successful shared login stores the legacy user's id and session epoch,
 *   exactly like a named login. Its role lives in the database row and is
 *   reconciled against LEGACY_SHARED_ROLE at boot by syncLegacySharedRole().
 *   Nothing authority-bearing is ever written into the cookie, so a forged
 *   `"role":"owner"` claim has nothing to attach to.
 *
 * INDISTINGUISHABLE FAILURES
 *   An unknown email, a known email with no password set, and a wrong password
 *   all perform exactly one scrypt verification and return the same status and
 *   body. Without the dummy verification on the unknown-email branch, response
 *   latency alone enumerates who works here.
 *
 * LOCKOUT PRECEDENCE
 *   A locked account returns 429 even when the password supplied is correct.
 *   Otherwise the lock is a free oracle: an attacker learns they guessed right
 *   the moment the response changes.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { hashPassword, verifyPassword, verifyAgainstDummy, validatePasswordStrength } = require('../lib/password');
const { hashToken, redemptionErrorFrom } = require('./invitations');
// The email-change store and its error mapping live with the rest of that
// feature in routes/users.js. Only the CONFIRM half is here, because it has to
// be public — the person opening the link has no session and may be on a
// device that never had one — and everything public in this service is mounted
// under /auth. Same arrangement as the invitation accept route above.
const { createEmailChangeStore, confirmationErrorFrom, EMAIL_CHANGED_EVENT } = require('./users');
const { logAuditSafely } = require('../lib/audit/log');
const { eventDefinition } = require('../lib/audit/event-types');
// Self-service password reset. Both halves are public by necessity: somebody
// who has forgotten their password has no session, which is the whole point.
// The behaviour lives in lib/password-reset.js so that this shared file takes
// only the two handlers. `hashToken` is aliased because routes/invitations.js
// exports a function of the same name above; they are the same construction
// over different secrets and must never be crossed.
const {
  CONFIRM_ERRORS: RESET_CONFIRM_ERRORS,
  EMAIL_PATTERN: RESET_EMAIL_PATTERN,
  EXPIRY_MINUTES: RESET_EXPIRY_MINUTES,
  GENERIC_REQUEST_MESSAGE,
  MAX_TOKEN_LENGTH: MAX_RESET_TOKEN_LENGTH,
  MIN_RESPONSE_MS: RESET_MIN_RESPONSE_MS,
  MIN_TOKEN_LENGTH: MIN_RESET_TOKEN_LENGTH,
  REQUEST_EVENT_CODES,
  REQUEST_OUTCOMES,
  confirmErrorFrom,
  createPasswordResetStore,
  hashToken: hashResetToken,
  requestPasswordReset,
  settleAfter
} = require('../lib/password-reset');
const { sendEmail, appUrl } = require('../lib/email');
const { passwordResetEmail } = require('../lib/email-templates');

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// The shared login has no per-person identity, so a database lockout would
// lock BOTH current users out at once. It gets a per-IP throttle instead:
// brute force is stopped, and one person fat-fingering the shared password
// cannot take the other person's iPhone offline.
const LEGACY_IP_MAX_FAILURES = 10;
const LEGACY_IP_WINDOW_MS = 15 * 60 * 1000;

function legacyLoginEnabled() {
  const value = String(process.env.LEGACY_SHARED_LOGIN || 'enabled').trim().toLowerCase();
  return value !== 'disabled' && value !== 'off' && value !== 'false';
}

function configuredLegacyRole() {
  return String(process.env.LEGACY_SHARED_ROLE || 'admin').trim().toLowerCase() || 'admin';
}

/** Length-independent constant-time comparison of two secrets. */
function secretsMatch(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function requestContext(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: (req.get ? req.get('user-agent') : null) || null,
    client: (req.get ? req.get('x-vici-client') : null) || null
  };
}

function issueSession(req, user) {
  req.session = {
    v: 1,
    authenticated: true,
    uid: user.id,
    se: user.session_epoch
  };
}

/**
 * Reconcile the shared identity's role with LEGACY_SHARED_ROLE at boot.
 *
 * This is the whole "demoting the shared login later is an env flip" story:
 * the role lives in the database where a cookie cannot forge it, and the
 * environment variable is what decides which role that is. Defaults to
 * `admin`, which is what the two current users effectively have today, so a
 * deploy with no new environment variables changes nothing for them.
 *
 * @returns {Promise<{role:string, changed:boolean}>}
 * @throws if the configured role does not exist, so a typo fails startup
 */
async function syncLegacySharedRole({ client, authz } = {}) {
  const supabase = client || require('../db').supabase;
  const auth = authz || require('../lib/authz').sharedAuthz();
  const wanted = configuredLegacyRole();

  const roles = await supabase.from('sms_roles').select('key');
  if (roles.error) {
    throw new Error(
      `[AUTH] Could not read sms_roles (${roles.error.message}). ` +
      'Apply scripts/rbac-migration.sql before deploying this build.'
    );
  }
  if (!(roles.data || []).some(row => row.key === wanted)) {
    throw new Error(`[AUTH] LEGACY_SHARED_ROLE="${wanted}" is not a known role key.`);
  }

  const found = await supabase
    .from('sms_users')
    .select('id, role')
    .eq('is_legacy_shared', true)
    .maybeSingle();
  if (found.error) throw new Error(`[AUTH] Could not read the shared identity (${found.error.message}).`);
  if (!found.data) {
    throw new Error('[AUTH] No is_legacy_shared user. Apply scripts/rbac-migration.sql.');
  }
  if (found.data.role === wanted) return { role: wanted, changed: false };

  const updated = await supabase.from('sms_users').update({ role: wanted }).eq('id', found.data.id);
  if (updated.error) throw new Error(`[AUTH] Could not set the shared identity role (${updated.error.message}).`);

  // Any session issued against the previous role must stop carrying it.
  // Pre-existing cookies with no uid are exempt by design; see lib/authz.js.
  const bumped = await supabase.rpc('bump_sms_user_session_epoch', { p_user_id: found.data.id });
  if (bumped.error) console.warn('[AUTH] Shared identity epoch not bumped:', bumped.error.message);
  auth.invalidate(found.data.id);

  return { role: wanted, changed: true };
}

/**
 * @param {object} [options]
 * @param {object} [options.authz]
 * @param {object} [options.client]
 * @param {object} [options.invitationStore]
 * @param {object} [options.emailChangeStore]
 * @param {Function} [options.audit]    audit writer, injected offline
 * @param {Function} [options.limiter]
 * @param {object} [options.passwordReset]  one bag rather than four separate
 *   options, to keep this signature short: `{ store, sendMail, baseUrl,
 *   minResponseMs, sleep, now }`. Every field is optional and the defaults are
 *   the live ones.
 */
function createAuthRouter({ authz, client, invitationStore, emailChangeStore, audit, limiter, passwordReset } = {}) {
  const auth = authz || require('../lib/authz').sharedAuthz();
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }
  const invitations = invitationStore || require('./invitations').createInvitationStore({ client });
  const emailChanges = emailChangeStore || createEmailChangeStore({ client });
  const logAudit = audit || logAuditSafely;

  /**
   * Everything the two password-reset handlers need, resolved once.
   *
   * `baseUrl` is read per request rather than captured here when it is not
   * injected: APP_URL is a Railway variable and a module-level constant would
   * freeze whatever was in the environment at require time, which is the bug
   * lib/email.js documents for its own configuration.
   */
  const resets = {
    store: passwordReset?.store || createPasswordResetStore({ client }),
    sendMail: passwordReset?.sendMail || sendEmail,
    baseUrl: () => (passwordReset?.baseUrl !== undefined ? passwordReset.baseUrl : appUrl()),
    minResponseMs: Number.isFinite(Number(passwordReset?.minResponseMs))
      ? Number(passwordReset.minResponseMs)
      : RESET_MIN_RESPONSE_MS,
    sleep: passwordReset?.sleep,
    now: passwordReset?.now
  };

  /**
   * Write an audit row, but only for an event type the catalogue knows.
   *
   * The twin of `auditIfRegistered` in routes/users.js, and here for the same
   * reason: `logAudit` throws on an unregistered type, and
   * `team.member.email_changed` is not in lib/audit/event-types.js yet. That
   * file is owned elsewhere. The call site below is complete and starts writing
   * rows the moment the type is registered; until then it logs one warning
   * naming the missing type rather than failing a confirmation that has already
   * committed in the database.
   */
  async function auditIfRegistered(input) {
    if (!eventDefinition(input.eventType)) {
      console.warn(
        `[AUTH] Not audited: "${input.eventType}" is not registered in `
        + 'lib/audit/event-types.js. Add it there (and its metadata keys to '
        + 'METADATA_ALLOWLIST in lib/audit/redact.js) to turn this row on.'
      );
      return { audited: false, reason: 'event_type_unregistered' };
    }
    await logAudit(input);
    return { audited: true };
  }

  const router = express.Router();

  const loginLimiter = limiter || rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Wait a few minutes.', code: 'TOO_MANY_ATTEMPTS' }
  });

  /** ip -> { failures: number, resetAt: number } */
  const legacyFailuresByIP = new Map();

  function legacyThrottled(ip) {
    const entry = legacyFailuresByIP.get(ip);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      legacyFailuresByIP.delete(ip);
      return false;
    }
    return entry.failures >= LEGACY_IP_MAX_FAILURES;
  }

  function noteLegacyFailure(ip) {
    const now = Date.now();
    const entry = legacyFailuresByIP.get(ip);
    if (!entry || entry.resetAt <= now) {
      legacyFailuresByIP.set(ip, { failures: 1, resetAt: now + LEGACY_IP_WINDOW_MS });
      return;
    }
    entry.failures += 1;
  }

  async function record(req, event) {
    const context = requestContext(req);
    await auth.logAuthEvent({ ...context, ...event });
  }

  function actorSummary(user, permissions) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      isLegacyShared: user.is_legacy_shared === true,
      mustChangePassword: user.must_change_password === true,
      permissions: [...permissions].sort()
    };
  }

  // ── POST /auth/login ──────────────────────────────────────────────────────
  router.post('/login', loginLimiter, async (req, res) => {
    const rawEmail = req.body?.email;
    const password = req.body?.password;
    const context = requestContext(req);

    if (typeof password !== 'string' || password.length === 0) {
      await record(req, { method: 'password', outcome: 'failure', code: 'MISSING_PASSWORD', emailAttempted: rawEmail ? String(rawEmail) : null });
      return res.status(401).json({ error: 'Incorrect password', code: 'INVALID_CREDENTIALS' });
    }

    const usingEmail = typeof rawEmail === 'string' && rawEmail.trim().length > 0;

    try {
      // ── Shared team login ─────────────────────────────────────────────────
      if (!usingEmail) {
        if (!legacyLoginEnabled()) {
          await record(req, { method: 'legacy', outcome: 'failure', code: 'LEGACY_LOGIN_DISABLED' });
          return res.status(401).json({
            error: 'The shared team password is no longer accepted. Sign in with your own email.',
            code: 'LEGACY_LOGIN_DISABLED'
          });
        }
        if (legacyThrottled(context.ip)) {
          await record(req, { method: 'legacy', outcome: 'failure', code: 'TOO_MANY_ATTEMPTS' });
          return res.status(429).json({
            error: 'Too many sign-in attempts. Wait a few minutes.',
            code: 'TOO_MANY_ATTEMPTS'
          });
        }

        const expected = process.env.INBOX_PASSWORD;
        const ok = typeof expected === 'string' && expected.length > 0 && secretsMatch(password, expected);
        if (!ok) {
          noteLegacyFailure(context.ip);
          await record(req, { method: 'legacy', outcome: 'failure', code: 'INVALID_CREDENTIALS' });
          return res.status(401).json({ error: 'Incorrect password', code: 'INVALID_CREDENTIALS' });
        }

        const legacyUser = await auth.loadLegacyUser();
        if (!legacyUser) {
          console.error('[AUTH] No is_legacy_shared user. Apply scripts/rbac-migration.sql.');
          await record(req, { method: 'legacy', outcome: 'failure', code: 'RBAC_NOT_READY' });
          return res.status(503).json({ error: 'Accounts are not initialised on this server.', code: 'RBAC_NOT_READY' });
        }
        if (legacyUser.is_active !== true) {
          await record(req, { method: 'legacy', outcome: 'failure', code: 'ACCOUNT_DISABLED', userId: legacyUser.id });
          return res.status(401).json({ error: 'The shared team login is disabled.', code: 'ACCOUNT_DISABLED' });
        }

        legacyFailuresByIP.delete(context.ip);
        issueSession(req, legacyUser);
        const permissions = await auth.permissionsFor(legacyUser.id, legacyUser.session_epoch);
        await record(req, { method: 'legacy', outcome: 'success', code: 'OK', userId: legacyUser.id });
        return res.json({
          success: true,
          actor: actorSummary(legacyUser, permissions),
          mustChangePassword: false
        });
      }

      // ── Named account ─────────────────────────────────────────────────────
      const email = rawEmail.trim();
      const user = await auth.loadUserByEmail(email);

      // Exactly one scrypt verification happens on every branch below, so an
      // unknown address and a wrong password cost the same.
      let passwordOk;
      if (!user || user.is_legacy_shared === true || !user.password_hash) {
        passwordOk = await verifyAgainstDummy(password);
      } else {
        passwordOk = await verifyPassword(password, user.password_hash);
      }

      if (!user || user.is_legacy_shared === true) {
        await record(req, { method: 'password', outcome: 'failure', code: 'INVALID_CREDENTIALS', emailAttempted: email });
        return res.status(401).json({ error: 'Incorrect email or password', code: 'INVALID_CREDENTIALS' });
      }

      // The lock outranks a correct password on purpose.
      const lockedUntil = user.locked_until ? new Date(user.locked_until).getTime() : 0;
      if (lockedUntil > Date.now()) {
        await record(req, { method: 'password', outcome: 'failure', code: 'ACCOUNT_LOCKED', emailAttempted: email, userId: user.id });
        return res.status(429).json({
          error: 'Too many failed attempts. Try again shortly.',
          code: 'ACCOUNT_LOCKED',
          retryAfterSeconds: Math.ceil((lockedUntil - Date.now()) / 1000)
        });
      }

      if (!passwordOk) {
        const failures = (user.failed_login_count || 0) + 1;
        const patch = { failed_login_count: failures };
        if (failures >= MAX_FAILED_LOGINS) {
          patch.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString();
          patch.failed_login_count = 0;
        }
        const updated = await db().from('sms_users').update(patch).eq('id', user.id);
        if (updated.error) console.warn('[AUTH] Failed-login counter not updated:', updated.error.message);
        await record(req, { method: 'password', outcome: 'failure', code: 'INVALID_CREDENTIALS', emailAttempted: email, userId: user.id });
        return res.status(401).json({ error: 'Incorrect email or password', code: 'INVALID_CREDENTIALS' });
      }

      if (user.is_active !== true) {
        await record(req, { method: 'password', outcome: 'failure', code: 'ACCOUNT_DISABLED', emailAttempted: email, userId: user.id });
        return res.status(401).json({ error: 'This account is disabled.', code: 'ACCOUNT_DISABLED' });
      }

      const cleared = await db()
        .from('sms_users')
        .update({ failed_login_count: 0, locked_until: null })
        .eq('id', user.id);
      if (cleared.error) console.warn('[AUTH] Failed-login counter not cleared:', cleared.error.message);

      issueSession(req, user);
      const permissions = await auth.permissionsFor(user.id, user.session_epoch);
      await record(req, { method: 'password', outcome: 'success', code: 'OK', emailAttempted: email, userId: user.id });
      return res.json({
        success: true,
        actor: actorSummary(user, permissions),
        mustChangePassword: user.must_change_password === true
      });
    } catch (error) {
      console.error('[AUTH] Login failed:', error?.code || 'internal_error', error?.message);
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable.', code: 'AUTH_UNAVAILABLE' });
    }
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  router.post('/logout', async (req, res) => {
    const userId = req.session?.uid ?? null;
    req.session = null; // cookie-session: setting to null clears the cookie
    await record(req, { method: 'logout', outcome: 'success', code: 'OK', userId });
    return res.json({ success: true });
  });

  // ── GET /auth/check ───────────────────────────────────────────────────────
  // The iOS client reads `authenticated` and nothing else; a false answer is
  // what makes restoreSessionIfNeeded() re-authenticate silently. A stale or
  // disabled session must therefore report false rather than error.
  router.get('/check', async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    if (!req.session?.authenticated) return res.json({ authenticated: false });

    try {
      const uid = req.session.uid;
      const viaLegacySession = uid === undefined || uid === null;
      const user = viaLegacySession ? await auth.loadLegacyUser() : await auth.loadUserById(uid);

      if (!user || user.is_active !== true) return res.json({ authenticated: false });
      if (!viaLegacySession && req.session.se !== user.session_epoch) {
        return res.json({ authenticated: false, code: 'SESSION_STALE' });
      }

      const permissions = await auth.permissionsFor(user.id, user.session_epoch);
      return res.json({
        authenticated: true,
        actor: { ...actorSummary(user, permissions), viaLegacySession }
      });
    } catch (error) {
      console.error('[AUTH] Session check failed:', error?.code || 'internal_error');
      // A database wobble must not silently sign an iPhone out mid-call, and
      // it must not claim an unverified session is good either.
      return res.status(503).json({ authenticated: false, code: 'AUTH_UNAVAILABLE' });
    }
  });

  // ── POST /auth/invitation/accept ──────────────────────────────────────────
  // Public by necessity: the invitee has no session yet. The token is the only
  // credential accepted, and it is compared by hash.
  //
  // This does NOT sign anybody in. There is no email sender in this service,
  // so the inviting Admin frequently holds the token themselves; signing in
  // automatically would put the new account into the Admin's browser.
  router.post('/invitation/accept', loginLimiter, async (req, res) => {
    const token = req.body?.token;
    const password = req.body?.password;

    if (typeof token !== 'string' || token.length < 16 || token.length > 512) {
      await record(req, { method: 'invitation', outcome: 'failure', code: 'INVITATION_NOT_FOUND' });
      return res.status(404).json({ error: 'That invitation link is not valid.', code: 'INVITATION_NOT_FOUND' });
    }
    const strengthProblem = validatePasswordStrength(password);
    if (strengthProblem) {
      return res.status(400).json({ error: strengthProblem, code: 'PASSWORD_TOO_WEAK' });
    }

    const tokenHash = hashToken(token);
    try {
      const passwordHash = await hashPassword(password);
      // `req` carries the IP, user-agent and request id onto the activation audit
    // row. The invitee still wins as the actor; this is provenance, not identity.
      const { userId, email, mustChangePassword } = await invitations.redeem(tokenHash, passwordHash, req);
      await record(req, { method: 'invitation', outcome: 'success', code: 'OK', userId });
      return res.status(201).json({
        success: true,
        userId,
        // Returned so the sign-in form can prefill it. The invitee has just
        // proven they hold a token issued to this address, so echoing it back
        // to them discloses nothing they did not arrive with.
        email,
        // Reported from the row that was actually created, not assumed. If the
        // invitation-password-fix migration has not been applied, the database
        // still flags the account and the invitee is told so honestly instead
        // of being promised a clean sign-in they will not get.
        mustChangePassword: mustChangePassword === true,
        note: mustChangePassword === true
          ? 'Account created. Sign in with this email and password, then set a new password.'
          : 'Account created. You can sign in with this email and password now.'
      });
    } catch (error) {
      const mapped = redemptionErrorFrom(error);
      await invitations.noteAttempt(tokenHash);
      if (mapped) {
        await record(req, { method: 'invitation', outcome: 'failure', code: mapped.code });
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      if (/duplicate key|unique constraint/i.test(error?.message || '')) {
        await record(req, { method: 'invitation', outcome: 'failure', code: 'EMAIL_ALREADY_EXISTS' });
        return res.status(409).json({
          error: 'An account already exists for that address.',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      console.error('[AUTH] Invitation acceptance failed:', error?.code || 'internal_error');
      return res.status(500).json({ error: 'That invitation could not be accepted.', code: 'INVITATION_ACCEPT_FAILED' });
    }
  });

  // ── POST /auth/email-change/confirm ───────────────────────────────────────
  // Public by necessity, exactly like the invitation accept route above and
  // rate limited by the same limiter: the person opening the link may not be
  // signed in, may be on a phone that has never had a session, and in the case
  // this whole flow exists to catch is proving control of a mailbox rather than
  // of an account. The token is the only credential accepted and it is compared
  // by hash — the raw value is never stored, so there is nothing to compare
  // against except a digest.
  //
  // This does NOT sign anybody in, for the same reason acceptance does not:
  // whoever opens the link is not necessarily at a device that should end up
  // holding a session for that account.
  //
  // NOTE FOR WHOEVER OWNS public/ AND server.js: the link in the email is
  // `${APP_URL}/confirm-email-change?token=...`, and there is no page at that
  // path yet. server.js serves /accept-invite explicitly and everything else
  // falls through to the SPA. A GET of the confirm URL therefore returns
  // index.html and nothing calls this endpoint. The API half is complete and
  // testable; the landing page that POSTs the token to it is not this file's to
  // add. See the report accompanying this change.
  router.post('/email-change/confirm', loginLimiter, async (req, res) => {
    const token = req.body?.token;

    // Same shape check and same answer as an unknown token. A malformed value
    // and a well-formed value that matches nothing must be indistinguishable,
    // otherwise the length check itself is an oracle for the token format.
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) {
      await record(req, { method: 'email_change', outcome: 'failure', code: 'EMAIL_CHANGE_NOT_FOUND' });
      return res.status(404).json({ error: 'That confirmation link is not valid.', code: 'EMAIL_CHANGE_NOT_FOUND' });
    }

    const tokenHash = hashToken(token);
    try {
      // One RPC. It locks the row, validates it, rewrites the address and bumps
      // the session epoch in a single transaction, so two clicks a millisecond
      // apart produce exactly one change and the loser gets EMAIL_CHANGE_USED.
      // Do not turn this into a read-then-write here.
      const result = await emailChanges.confirm(tokenHash);
      const userId = result?.user_id ?? null;

      // The epoch moved inside the transaction; this drops the permission cache
      // that is keyed on it. Doing one without the other leaves a stale entry
      // answering for up to the cache TTL.
      if (userId !== null) auth.invalidate(userId);

      await record(req, { method: 'email_change', outcome: 'success', code: 'OK', userId });
      await auditIfRegistered({
        // The person holding the mailbox is the actor. They have just proven
        // control of the new address, which is the entire point of the step.
        actor: { type: 'user', id: userId, displayName: result?.new_email || 'Team member' },
        req,
        eventType: EMAIL_CHANGED_EVENT,
        entityId: userId,
        summary: 'A team member confirmed a new email address and their other sessions were ended',
        previousState: { email: result?.previous_email },
        newState: { email: result?.new_email },
        changedFields: ['email'],
        metadata: {
          user_id: userId,
          email: result?.new_email,
          previous_email: result?.previous_email,
          via: 'self_service_confirmed',
          confirmed: true,
          logins_revoked: true
        }
      });

      return res.json({
        success: true,
        // Echoed back so a sign-in form can prefill it. Whoever is reading this
        // response just proved they hold the mailbox it names, so it discloses
        // nothing they did not arrive with. The PREVIOUS address is deliberately
        // not echoed: on the hijack path that would hand an attacker the address
        // of the account they just failed to take.
        email: result?.new_email ?? null,
        note: 'Your email address is confirmed. Sign in with it. Any other device you were '
          + 'signed in on will ask you to sign in again.'
      });
    } catch (error) {
      const mapped = confirmationErrorFrom(error);
      if (mapped) {
        await record(req, { method: 'email_change', outcome: 'failure', code: mapped.code });
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      // Neither the token nor its hash reaches this line, and must not.
      console.error('[AUTH] Email change confirmation failed:', error?.code || 'internal_error');
      return res.status(500).json({
        error: 'That email change could not be confirmed.',
        code: 'EMAIL_CHANGE_CONFIRM_FAILED'
      });
    }
  });

  // ── Self-service password reset ───────────────────────────────────────────
  // Public by necessity, on both halves: somebody who has forgotten their
  // password has no session. The behaviour is in lib/password-reset.js; these
  // two handlers are the HTTP surface and the auth-event trail.

  /**
   * One `team.member.password_reset` row for a completed self-service reset.
   *
   * Entirely wrapped, exactly like auditRedemption in routes/invitations.js: by
   * the time this runs the password has already been rewritten inside a
   * committed SQL transaction, so nothing here may throw. A failure degrades to
   * a warning and a missing audit row, never to a person who cannot finish
   * resetting their password.
   *
   * NOTHING TOKEN-SHAPED OR PASSWORD-SHAPED GOES IN. Not the raw token, not its
   * sha256, not the hash, not the new password. The row records that a reset
   * happened, to whom, and by what method.
   *
   * `reset_method` is what distinguishes this from the admin-issued temporary
   * password written by POST /api/users/:id/reset-password, which shares the
   * event type. Both answer the same forensic question — who reset whose
   * password, and when — and the metadata says which of the two paths it was.
   */
  async function auditPasswordReset(req, userId) {
    try {
      const person = await resets.store.describeUser(userId);
      const name = person?.display_name || person?.email || `user ${userId}`;
      await logAudit({
        // The account holder is the actor: they proved they hold the token.
        // `req` supplies the IP, user-agent and request id only — resolveActor
        // in lib/audit/log.js prefers this explicit actor over req.actor, and
        // this endpoint is unauthenticated so there is no req.actor anyway.
        // Those three fields are the only evidence of WHERE a password was
        // reset from, which is exactly what matters if a link is ever used by
        // somebody it was not sent to.
        actor: { type: 'user', id: userId, displayName: name, role: person?.role || null },
        req,
        eventType: 'team.member.password_reset',
        entityId: userId,
        summary: `${name} reset their own password with an emailed link and ended their other sessions`,
        metadata: {
          user_id: userId,
          email: person?.email || null,
          role: person?.role || null,
          reset_method: 'self_service_reset_link',
          must_rotate_on_next_sign_in: false,
          logins_revoked: true
        }
      });
    } catch (error) {
      console.warn('[AUTH] Password reset not audited:', error?.code || error?.message || 'unknown');
    }
  }

  // ── POST /auth/password-reset/request ─────────────────────────────────────
  // ONE ANSWER FOR EVERY CASE. Same status, same body, same wall-clock time,
  // whether the address belongs to an active account, a deactivated one, the
  // shared identity, or nobody at all. An account whose reset "worked" and one
  // that does not exist must be indistinguishable from outside, or this
  // endpoint becomes a public enumerator of who works here.
  //
  // The three ingredients of that:
  //   * the body is the GENERIC_REQUEST_MESSAGE constant, never a branch;
  //   * requestPasswordReset never rejects, so a storage failure cannot turn
  //     into a 503 that only ever appears for real accounts;
  //   * settleAfter pads every branch to the same floor, and the email is
  //     dispatched without being awaited so a provider round trip never lands
  //     on the account-exists branch alone.
  // The real outcome goes to sms_auth_events, which is private.
  router.post('/password-reset/request', loginLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    const startedAt = Date.now();

    const rawEmail = req.body?.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';

    // Shape only. This is not an existence signal: every well-formed address
    // gets the same 202 below, whether or not anybody holds it.
    if (!email || email.length > 320 || !RESET_EMAIL_PATTERN.test(email)) {
      await record(req, {
        method: 'password_reset_request',
        outcome: 'failure',
        code: 'INVALID_EMAIL',
        emailAttempted: email || null
      });
      return res.status(400).json({
        error: 'Enter the email address you sign in with.',
        code: 'INVALID_EMAIL'
      });
    }

    const context = requestContext(req);
    let outcome = REQUEST_OUTCOMES.STORE_FAILED;
    let userId = null;
    try {
      const result = await requestPasswordReset({
        store: resets.store,
        email,
        sendMail: resets.sendMail,
        buildEmail: reset => passwordResetEmail({
          recipientName: reset.recipientName,
          workspaceName: 'Vici Inbox',
          resetUrl: reset.resetUrl,
          expiresAt: reset.expiresAt,
          expiryMinutes: RESET_EXPIRY_MINUTES
        }),
        baseUrl: resets.baseUrl(),
        ip: context.ip,
        userAgent: context.userAgent,
        now: resets.now
      });
      outcome = result.outcome;
      userId = result.userId;
    } catch (error) {
      // requestPasswordReset is documented never to reject. If that ever stops
      // being true, the answer is still the generic one.
      console.error('[AUTH] Password reset request failed:', error?.code || 'internal_error');
    }

    await record(req, {
      method: 'password_reset_request',
      outcome: outcome === REQUEST_OUTCOMES.SENT ? 'success' : 'failure',
      code: REQUEST_EVENT_CODES[outcome] || 'RESET_REQUEST_FAILED',
      emailAttempted: email,
      userId
    });

    await settleAfter(startedAt, resets.minResponseMs, { sleep: resets.sleep });
    return res.status(202).json({ success: true, message: GENERIC_REQUEST_MESSAGE });
  });

  // ── POST /auth/password-reset/confirm ─────────────────────────────────────
  // Public by necessity. The token is the only credential accepted and it is
  // compared by hash. This does NOT sign anybody in: they now know their
  // password, and signing them in here would mean a link forwarded to the
  // wrong person is a session rather than a dead end.
  router.post('/password-reset/confirm', loginLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    const token = req.body?.token;
    const password = req.body?.password;

    if (typeof token !== 'string'
      || token.length < MIN_RESET_TOKEN_LENGTH
      || token.length > MAX_RESET_TOKEN_LENGTH) {
      await record(req, { method: 'password_reset', outcome: 'failure', code: 'RESET_NOT_FOUND' });
      return res.status(404).json({
        error: RESET_CONFIRM_ERRORS.RESET_NOT_FOUND.message,
        code: 'RESET_NOT_FOUND'
      });
    }

    // STRENGTH IS CHECKED BEFORE THE TOKEN IS TOUCHED, deliberately. The token
    // is single use. Spending it on a password the policy then rejects would
    // leave somebody with a burnt link and no new password, needing a second
    // email to fix a typo. Nothing is read or written until this passes.
    const strengthProblem = validatePasswordStrength(password);
    if (strengthProblem) {
      return res.status(400).json({ error: strengthProblem, code: 'PASSWORD_TOO_WEAK' });
    }

    const tokenHash = hashResetToken(token);
    try {
      const passwordHash = await hashPassword(password);
      // One atomic call: sets the hash, bumps the session epoch, clears
      // must_change_password and the lockout, and marks the row used. Two
      // concurrent confirmations of one token yield exactly one change.
      const userId = await resets.store.complete(tokenHash, passwordHash);

      await record(req, { method: 'password_reset', outcome: 'success', code: 'OK', userId });
      // The permission cache is keyed by user id AND session epoch, so the
      // bumped epoch already misses every cached entry. Invalidating is belt
      // and braces and costs one Map scan.
      auth.invalidate(userId);
      await auditPasswordReset(req, userId);

      return res.json({
        success: true,
        note: 'Your password has been changed. Sign in with it. '
          + 'Any other device you were signed in on will ask you to sign in again.'
      });
    } catch (error) {
      const mapped = confirmErrorFrom(error);
      await resets.store.noteAttempt(tokenHash);
      if (mapped) {
        await record(req, { method: 'password_reset', outcome: 'failure', code: mapped.code });
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      // Neither the token nor its hash nor the password reaches this line, and
      // none of them must.
      console.error('[AUTH] Password reset confirmation failed:', error?.code || 'internal_error');
      return res.status(500).json({
        error: 'That password could not be changed.',
        code: 'PASSWORD_RESET_FAILED'
      });
    }
  });

  return router;
}

// server.js does `app.use('/auth', require('./routes/auth'))`, so the module
// must still export a router directly. The factory is exported alongside it
// for tests, which inject a fake store and a fake authz.
module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
module.exports.syncLegacySharedRole = syncLegacySharedRole;
module.exports.legacyLoginEnabled = legacyLoginEnabled;
module.exports.configuredLegacyRole = configuredLegacyRole;
module.exports.secretsMatch = secretsMatch;
module.exports.MAX_FAILED_LOGINS = MAX_FAILED_LOGINS;
module.exports.LOCKOUT_MINUTES = LOCKOUT_MINUTES;
