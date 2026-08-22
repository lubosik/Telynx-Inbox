'use strict';
/**
 * routes/auth.js — sign in, sign out, session check, invitation acceptance.
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
 * @param {{authz?: object, client?: object, invitationStore?: object, limiter?: Function}} [options]
 */
function createAuthRouter({ authz, client, invitationStore, limiter } = {}) {
  const auth = authz || require('../lib/authz').sharedAuthz();
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }
  const invitations = invitationStore || require('./invitations').createInvitationStore({ client });

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
