'use strict';
/**
 * lib/authz.js — who is this request, and what may they do.
 *
 * THE ONE RULE
 *   Nothing authority-bearing lives in the cookie. The signed session carries
 *   only `{ v: 1, authenticated: true, uid, se }`. There is no `role` field to
 *   forge and no permission list to tamper with. Identity, role, active state
 *   and permissions are read from the database on every request. A cookie that
 *   claims `"role":"owner"` is simply ignored, because nothing reads it.
 *
 * WHAT IS CACHED
 *   Only the resolved permission Set, for 30 seconds, keyed by user id AND
 *   session epoch. The user row itself — role, is_active, session_epoch,
 *   must_change_password — is read uncached every request. That is one indexed
 *   primary-key lookup, and it is what makes "deactivate this person" take
 *   effect on the next request rather than on the next cache expiry.
 *
 * THE LEGACY SESSION
 *   Cookies issued before this change look like `{ authenticated: true }` with
 *   no `uid`. They resolve to the single `is_legacy_shared` user. This one
 *   branch is what stops the deploy logging both current users out of an iOS
 *   build that cannot be updated for days. Do not "tidy" it away.
 *
 *   A legacy cookie carries no epoch, so it is not epoch-checked; there is
 *   nothing to compare against. Bumping the legacy user's session_epoch
 *   therefore does NOT log legacy cookies out. To end shared sessions, set
 *   LEGACY_SHARED_LOGIN=disabled and rotate SESSION_SECRET.
 *
 * SESSION_STALE IS 401, NOT 403
 *   On iOS, a 401 is what triggers restoreSessionIfNeeded(), so the app
 *   silently re-authenticates and picks up its new permissions. A 403 would be
 *   a dead end that only a reinstall clears.
 */

const PERMISSION_CACHE_TTL_MS = 30 * 1000;
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

const USER_COLUMNS = [
  'id',
  'email',
  'display_name',
  'role',
  'is_active',
  'is_legacy_shared',
  'session_epoch',
  'must_change_password'
].join(', ');

/**
 * @param {{client?: object, ttlMs?: number, now?: () => number}} [options]
 */
function createAuthz({ client, ttlMs = PERMISSION_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }

  /** key: `${userId}:${sessionEpoch}` -> { permissions: Set<string>, expiresAt: number } */
  const permissionCache = new Map();
  /** key: userId -> last millisecond we wrote last_seen_at */
  const lastSeenWrites = new Map();

  function invalidate(userId) {
    const prefix = `${userId}:`;
    for (const key of permissionCache.keys()) {
      if (key.startsWith(prefix)) permissionCache.delete(key);
    }
  }

  function invalidateAll() {
    permissionCache.clear();
  }

  async function loadUserById(userId) {
    const { data, error } = await db()
      .from('sms_users')
      .select(USER_COLUMNS)
      .eq('id', userId)
      .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: 'AUTHZ_USER_LOOKUP_FAILED' });
    return data || null;
  }

  async function loadLegacyUser() {
    const { data, error } = await db()
      .from('sms_users')
      .select(USER_COLUMNS)
      .eq('is_legacy_shared', true)
      .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: 'AUTHZ_USER_LOOKUP_FAILED' });
    return data || null;
  }

  async function loadUserByEmail(email) {
    // PostgREST has no lower() filter, and `ilike` treats % and _ as wildcards,
    // so escape them before matching. The unique index is on lower(email), so
    // at most one row can come back.
    const escaped = String(email).replace(/([\\%_])/g, '\\$1');
    const { data, error } = await db()
      .from('sms_users')
      .select(`${USER_COLUMNS}, password_hash, failed_login_count, locked_until`)
      .ilike('email', escaped)
      .limit(2);
    if (error) throw Object.assign(new Error(error.message), { code: 'AUTHZ_USER_LOOKUP_FAILED' });
    if (!data || data.length !== 1) return null;
    return data[0];
  }

  /**
   * Effective permissions for one user. Bounded by the size of the permission
   * catalogue (tens of rows), so this is one of the few reads in this codebase
   * that genuinely cannot approach PostgREST's silent 1000-row cap.
   */
  async function loadPermissions(userId) {
    const { data, error } = await db()
      .from('sms_effective_permissions')
      .select('permission_key')
      .eq('user_id', userId);
    if (error) throw Object.assign(new Error(error.message), { code: 'AUTHZ_PERMISSION_LOOKUP_FAILED' });
    return new Set((data || []).map(row => row.permission_key));
  }

  async function permissionsFor(userId, sessionEpoch) {
    const key = `${userId}:${sessionEpoch}`;
    const cached = permissionCache.get(key);
    const at = now();
    if (cached && cached.expiresAt > at) return cached.permissions;

    const permissions = await loadPermissions(userId);
    permissionCache.set(key, { permissions, expiresAt: at + ttlMs });
    return permissions;
  }

  function touchLastSeen(userId) {
    const at = now();
    const previous = lastSeenWrites.get(userId) || 0;
    if (at - previous < LAST_SEEN_THROTTLE_MS) return;
    lastSeenWrites.set(userId, at);
    Promise.resolve(
      db().from('sms_users').update({ last_seen_at: new Date(at).toISOString() }).eq('id', userId)
    ).then(result => {
      if (result && result.error) {
        console.warn('[AUTHZ] last_seen_at update failed:', result.error.message);
      }
    }).catch(err => {
      console.warn('[AUTHZ] last_seen_at update failed:', err.message);
    });
  }

  function toActor(user, permissions, { viaLegacySession }) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      isLegacyShared: user.is_legacy_shared === true,
      viaLegacySession: viaLegacySession === true,
      sessionEpoch: user.session_epoch,
      mustChangePassword: user.must_change_password === true,
      permissions,
      can(permission) { return permissions.has(permission); }
    };
  }

  /** Gate 1: is there a signed session at all. */
  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated === true) return next();
    return res.status(401).json({ error: 'Unauthorised', code: 'NOT_AUTHENTICATED' });
  }

  /** Gate 2: turn that session into a database-backed actor. */
  async function resolveActor(req, res, next) {
    try {
      const session = req.session || {};
      const uid = session.uid;
      const viaLegacySession = uid === undefined || uid === null;

      const user = viaLegacySession ? await loadLegacyUser() : await loadUserById(uid);

      if (!user) {
        if (viaLegacySession) {
          // The shared identity row is missing, which means
          // scripts/rbac-migration.sql has not been applied to this database.
          // Authorisation never fails open, so say so plainly rather than
          // guessing a role.
          console.error('[AUTHZ] No is_legacy_shared user. Apply scripts/rbac-migration.sql.');
          return res.status(503).json({
            error: 'Accounts are not initialised on this server.',
            code: 'RBAC_NOT_READY'
          });
        }
        req.session = null;
        return res.status(401).json({ error: 'Unauthorised', code: 'ACCOUNT_NOT_FOUND' });
      }

      if (user.is_active !== true) {
        req.session = null;
        return res.status(401).json({ error: 'This account is disabled.', code: 'ACCOUNT_DISABLED' });
      }

      // A named session must present the epoch it was issued with. A legacy
      // cookie predates epochs entirely and is exempt — see the header note.
      if (!viaLegacySession && session.se !== user.session_epoch) {
        req.session = null;
        return res.status(401).json({
          error: 'Your access changed. Sign in again.',
          code: 'SESSION_STALE'
        });
      }

      const permissions = await permissionsFor(user.id, user.session_epoch);
      req.actor = toActor(user, permissions, { viaLegacySession });
      touchLastSeen(user.id);
      return next();
    } catch (err) {
      console.error('[AUTHZ] Actor resolution failed:', err.code || 'internal_error', err.message);
      return res.status(503).json({
        error: 'Could not verify your access right now.',
        code: 'AUTHZ_UNAVAILABLE'
      });
    }
  }

  /** Append one row to the authentication audit trail. Never throws. */
  async function logAuthEvent(event) {
    try {
      const { error } = await db().from('sms_auth_events').insert({
        user_id: event.userId ?? null,
        email_attempted: event.emailAttempted ?? null,
        method: event.method,
        outcome: event.outcome,
        code: event.code ?? null,
        ip: event.ip ?? null,
        user_agent: event.userAgent ?? null,
        client: event.client ?? null
      });
      if (error) console.warn('[AUTHZ] Auth event not recorded:', error.message);
    } catch (err) {
      console.warn('[AUTHZ] Auth event not recorded:', err.message);
    }
  }

  return {
    requireAuth,
    resolveActor,
    invalidate,
    invalidateAll,
    logAuthEvent,
    loadUserById,
    loadUserByEmail,
    loadLegacyUser,
    loadPermissions,
    permissionsFor,
    _permissionCache: permissionCache
  };
}

// The process-wide instance the Express middleware and the route factories
// share. They must share one, otherwise invalidate() clears a cache the
// request path never reads.
let shared = null;
function sharedAuthz() {
  if (!shared) shared = createAuthz({});
  return shared;
}

module.exports = createAuthz;
module.exports.createAuthz = createAuthz;
module.exports.sharedAuthz = sharedAuthz;
module.exports.requireAuth = function requireAuth(req, res, next) {
  return sharedAuthz().requireAuth(req, res, next);
};
module.exports.resolveActor = function resolveActor(req, res, next) {
  return sharedAuthz().resolveActor(req, res, next);
};
module.exports.invalidate = function invalidate(userId) {
  return sharedAuthz().invalidate(userId);
};
module.exports.logAuthEvent = function logAuthEvent(event) {
  return sharedAuthz().logAuthEvent(event);
};
module.exports.PERMISSION_CACHE_TTL_MS = PERMISSION_CACHE_TTL_MS;
module.exports.USER_COLUMNS = USER_COLUMNS;
