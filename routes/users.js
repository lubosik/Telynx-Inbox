'use strict';
/**
 * routes/users.js — team management.
 *
 *   GET    /api/users                     user.read
 *   POST   /api/users                     user.manage
 *   GET    /api/users/me                  any authenticated actor
 *   POST   /api/users/me/password         any authenticated actor
 *   PATCH  /api/users/:id                 user.manage
 *   POST   /api/users/:id/deactivate      user.manage
 *   POST   /api/users/:id/reset-password  user.manage
 *
 * The permission for each path lives in lib/route-policy.js and is enforced
 * before any handler here runs. The guards in this file are the ones a
 * permission cannot express:
 *
 *   * Only an Owner may grant or revoke Owner.
 *   * An Owner may not act on ANOTHER Owner. Promoting somebody TO Owner still
 *     works and acting on yourself still works, but changing a peer Owner's
 *     role, active state, permission overrides or password is a 409
 *     CANNOT_MODIFY_PEER_OWNER. `user.manage.owner` answers "may this actor
 *     touch the Owner role at all", which an Owner always may; it cannot
 *     express "but not that particular person". See peerOwnerError().
 *   * The last active Admin/Owner may not be demoted or deactivated. That is
 *     a clean 409, handled here, so a lockout never surfaces as a 500.
 *   * The shared-password identity is immutable through the API. Changing what
 *     it can do is an environment flip (LEGACY_SHARED_ROLE), not an edit, so
 *     that a mis-click cannot alter what two people already signed in with.
 *   * Any role change, deactivation, permission-override change, or password
 *     reset bumps the target's session epoch and drops their cached
 *     permissions, so the change lands on their very next request.
 *
 * password_hash is never selected into a response body. publicUser() is the
 * only serialiser, and test/authz.test.js asserts nothing leaks.
 *
 * AUDIT
 *   Granting and revoking access is the most sensitive thing anybody does in
 *   this application, and sms_auth_events records sign-ins only. Every handler
 *   below that changes what a person can do writes a `team.*` row through
 *   logAuditSafely: role changes, activation, deactivation, reactivation,
 *   admin password resets and per-user permission overrides.
 *
 *   Three rules for those rows:
 *     * They are written AFTER the change has landed and are safe-logged, so a
 *       failed audit insert can never turn a completed role change into a 500.
 *     * The summary names the actor and the target explicitly and spells roles
 *       with their catalogue display names, because it is rendered once and
 *       has to still read correctly years later.
 *     * No password hash, temporary password, or token ever reaches a row. The
 *       metadata allowlists in lib/audit/redact.js omit them, the state screen
 *       drops any key matching SECRET_KEY_PATTERN, and test/audit-team.test.js
 *       asserts their absence in the serialised row.
 */

const express = require('express');
const crypto = require('crypto');
const {
  hashPassword,
  verifyPassword,
  validatePasswordStrength
} = require('../lib/password');
const { logAuditSafely } = require('../lib/audit/log');

const ADMINISTRATIVE_ROLES = ['owner', 'admin'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPORARY_PASSWORD_BYTES = 15; // 20 base64url characters

function createUserStore({ client } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }

  function unwrap(result, context) {
    if (result.error) {
      throw Object.assign(new Error(result.error.message), { code: 'USER_STORE_FAILED', context });
    }
    return result.data;
  }

  return {
    async list() {
      // The team is single-digit sized by design; a page cursor here would be
      // ceremony. Ordered so newest joiners are last, matching the UI.
      return unwrap(
        await db()
          .from('sms_users')
          .select('id, email, display_name, phone, role, is_active, is_legacy_shared, password_hash, must_change_password, last_seen_at, deactivated_at, created_at')
          .order('id', { ascending: true })
          .limit(500),
        'list'
      ) || [];
    },

    async getById(id) {
      return unwrap(
        await db()
          .from('sms_users')
          .select('id, email, display_name, phone, role, is_active, is_legacy_shared, password_hash, must_change_password, session_epoch, last_seen_at, deactivated_at, created_at')
          .eq('id', id)
          .maybeSingle(),
        'getById'
      );
    },

    async findByEmail(email) {
      const escaped = String(email).replace(/([\\%_])/g, '\\$1');
      const rows = unwrap(
        await db().from('sms_users').select('id, email').ilike('email', escaped).limit(2),
        'findByEmail'
      );
      return (rows && rows.length === 1) ? rows[0] : null;
    },

    async create(row) {
      return unwrap(
        await db()
          .from('sms_users')
          .insert(row)
          .select('id, email, display_name, phone, role, is_active, is_legacy_shared, password_hash, must_change_password, last_seen_at, deactivated_at, created_at')
          .single(),
        'create'
      );
    },

    async update(id, patch) {
      return unwrap(
        await db()
          .from('sms_users')
          .update(patch)
          .eq('id', id)
          .select('id, email, display_name, phone, role, is_active, is_legacy_shared, password_hash, must_change_password, last_seen_at, deactivated_at, created_at')
          .single(),
        'update'
      );
    },

    async countActiveAdministrators() {
      const result = await db()
        .from('sms_users')
        .select('id', { count: 'exact', head: true })
        // bounded: ADMINISTRATIVE_ROLES is a two-element module constant, not a
        // computed list. It cannot grow with the data.
        .in('role', ADMINISTRATIVE_ROLES)
        .eq('is_active', true);
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'USER_STORE_FAILED', context: 'countActiveAdministrators' });
      }
      return result.count || 0;
    },

    async bumpEpoch(id) {
      const result = await db().rpc('bump_sms_user_session_epoch', { p_user_id: id });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'USER_STORE_FAILED', context: 'bumpEpoch' });
      }
      return result.data;
    },

    async listRoles() {
      return unwrap(
        await db().from('sms_roles').select('key, display_name, rank, is_assignable, description').order('rank', { ascending: false }),
        'listRoles'
      ) || [];
    },

    async listPermissionKeys() {
      const rows = unwrap(await db().from('sms_permissions').select('key'), 'listPermissionKeys') || [];
      return rows.map(row => row.key);
    },

    async listGrants(userId) {
      return unwrap(
        await db()
          .from('sms_user_permission_grants')
          .select('permission_key, effect, reason, granted_at, expires_at')
          .eq('user_id', userId),
        'listGrants'
      ) || [];
    },

    async upsertGrant(row) {
      return unwrap(
        await db()
          .from('sms_user_permission_grants')
          .upsert(row, { onConflict: 'user_id,permission_key' })
          .select('permission_key, effect')
          .single(),
        'upsertGrant'
      );
    },

    async deleteGrant(userId, permissionKey) {
      const result = await db()
        .from('sms_user_permission_grants')
        .delete()
        .eq('user_id', userId)
        .eq('permission_key', permissionKey);
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'USER_STORE_FAILED', context: 'deleteGrant' });
      }
      return true;
    }
  };
}

/** The only serialiser. password_hash is reduced to a boolean and dropped. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    phone: row.phone || null,
    role: row.role,
    isActive: row.is_active === true,
    isLegacyShared: row.is_legacy_shared === true,
    hasPassword: Boolean(row.password_hash),
    mustChangePassword: row.must_change_password === true,
    lastSeenAt: row.last_seen_at || null,
    deactivatedAt: row.deactivated_at || null,
    createdAt: row.created_at || null
  };
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

function sendStoreError(res, error, label) {
  console.error(`[USERS] ${label} failed:`, error?.code || 'internal_error', error?.context || '');
  return fail(res, 500, 'USER_REQUEST_FAILED', 'That change could not be completed.');
}

function parseUserId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function generateTemporaryPassword() {
  return crypto.randomBytes(TEMPORARY_PASSWORD_BYTES).toString('base64url');
}

/** The name an audit summary should call whoever made the request. */
function actorName(req) {
  return req?.actor?.displayName || req?.actor?.name || 'Team';
}

/**
 * Resolve role keys to their human-readable catalogue names for audit
 * summaries: 'Support Agent', not 'agent'.
 *
 * Read from sms_roles rather than hardcoded, so a renamed role reads correctly
 * in rows written after the rename, and per-request rather than per-process,
 * so a rename is picked up without a restart. Falls back to the raw key if the
 * catalogue cannot be read — a summary that says 'agent' is worth far more
 * than an audit row that was never written because a lookup failed.
 */
function createRoleNamer(users) {
  let catalogue = null;
  return async function roleDisplayName(key) {
    if (!key) return 'no role';
    if (catalogue === null) {
      try {
        catalogue = await users.listRoles();
      } catch (error) {
        console.warn('[USERS] Role catalogue unavailable for an audit summary:', error?.code || error?.message || 'unknown');
        catalogue = [];
      }
    }
    return catalogue.find(entry => entry.key === key)?.display_name || key;
  };
}

/**
 * @param {{store?: object, authz?: object, audit?: Function}} [options]
 */
function createUsersRouter({ store, authz, audit } = {}) {
  const users = store || createUserStore({});
  const auth = authz || require('../lib/authz').sharedAuthz();
  // Injectable so the unit tests can assert on the rows without a database.
  // The default can never throw; see lib/audit/log.js.
  const logAudit = audit || logAuditSafely;
  const router = express.Router();

  /** Bump the epoch and drop the cache together. Doing one without the other
   *  leaves a stale grant live for up to the cache TTL. */
  async function revokeSessions(userId) {
    await users.bumpEpoch(userId);
    auth.invalidate(userId);
  }

  /**
   * Role transitions that a permission check cannot express.
   * @returns {null|{status:number, code:string, message:string}}
   */
  function ownerTransitionError(actor, { fromRole, toRole }) {
    const touchesOwner = fromRole === 'owner' || toRole === 'owner';
    if (!touchesOwner) return null;
    if (actor.permissions.has('user.manage.owner')) return null;
    return {
      status: 403,
      code: 'OWNER_ROLE_REQUIRES_OWNER',
      message: 'Only an Owner may grant or revoke the Owner role.'
    };
  }

  /**
   * An Owner may not exercise authority over ANOTHER Owner.
   *
   * `ownerTransitionError` above asks one question — does the ACTOR hold
   * `user.manage.owner`? — and an Owner always does. That made Owner a role
   * that could dismantle itself: any Owner could demote, deactivate or reset
   * the password of a peer Owner, and the loser of that exchange had no
   * recourse because their sessions were revoked in the same request. The
   * product owner's rule is explicit: "an owner can edit the role of an admin
   * or support agent, but it cannot edit the role or deactivate another owner."
   *
   * So this asks the second question — WHO is the target? — and it is
   * deliberately about identity, not permission:
   *
   *   * Promotion TO Owner is untouched. `targetRole` is the role the target
   *     holds ALREADY, so an admin or agent being raised to Owner never
   *     matches. Making a second person an Owner is a supported action and the
   *     product owner asked for it by name.
   *   * Acting on yourself is untouched. An Owner may step down or hand over,
   *     and `wouldStrandWorkspace` still refuses if they are the last
   *     administrative account, so "step down" can never become "lock everyone
   *     out".
   *   * An Admin is caught by `ownerTransitionError` first and still sees the
   *     403 it has always returned. This one only ever fires for an actor who
   *     genuinely holds Owner authority, which is why it is a 409 (a conflict
   *     with the state of the target) rather than a 403 (a missing grant).
   *
   * `targetRole` must be the role snapshotted BEFORE this request mutates
   * anything. Passing a post-update row would let a demotion in the same
   * request talk its way past the guard.
   *
   * @param {{id?: number|string}} actor
   * @param {{id: number|string, role: string}} target  role as it was on arrival
   * @returns {null|{status:number, code:string, message:string}}
   */
  function peerOwnerError(actor, target) {
    if (!target || target.role !== 'owner') return null;
    const actorId = actor?.id;
    // The legacy shared identity has no uid at all. It is Admin-equivalent and
    // never reaches here, but a null id must not be allowed to compare equal to
    // a real one, so it is excluded explicitly rather than by coercion.
    const isSelf = actorId !== null && actorId !== undefined
      && Number(actorId) === Number(target.id);
    if (isSelf) return null;
    return {
      status: 409,
      code: 'CANNOT_MODIFY_PEER_OWNER',
      message: 'This person is an Owner. An Owner cannot change the role, the active state, '
        + 'the permissions or the password of another Owner. They must make that change '
        + 'themselves, or step down first.'
    };
  }

  /**
   * Refuse any change that would leave the workspace with no active Owner or
   * Admin. Enforced here rather than by a database constraint so that the
   * caller gets a 409 they can act on instead of a 500 they cannot.
   */
  async function wouldStrandWorkspace(target, { becomingActive, becomingRole }) {
    const wasAdministrative = target.is_active === true && ADMINISTRATIVE_ROLES.includes(target.role);
    if (!wasAdministrative) return false;
    const stillAdministrative = becomingActive && ADMINISTRATIVE_ROLES.includes(becomingRole);
    if (stillAdministrative) return false;
    const active = await users.countActiveAdministrators();
    return active <= 1;
  }

  // ── GET /api/users ────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const rows = await users.list();
      const roles = await users.listRoles();
      res.set('Cache-Control', 'no-store, private');
      return res.json({ users: rows.map(publicUser), roles });
    } catch (error) {
      return sendStoreError(res, error, 'list');
    }
  });

  // ── GET /api/users/me ─────────────────────────────────────────────────────
  // Deliberately open to every authenticated actor, including one locked into
  // must_change_password. It is how a client learns what to render.
  router.get('/me', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    res.set('Cache-Control', 'no-store, private');
    return res.json({
      id: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role,
      isLegacyShared: actor.isLegacyShared,
      viaLegacySession: actor.viaLegacySession,
      mustChangePassword: actor.mustChangePassword,
      permissions: [...actor.permissions].sort()
    });
  });

  // ── POST /api/users/me/password ───────────────────────────────────────────
  router.post('/me/password', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    if (actor.viaLegacySession || actor.isLegacyShared) {
      return fail(
        res, 400, 'LEGACY_SESSION_NO_PASSWORD',
        'The shared team login has no personal password. Ask an admin for your own account.'
      );
    }

    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    const strengthProblem = validatePasswordStrength(newPassword);
    if (strengthProblem) return fail(res, 400, 'PASSWORD_TOO_WEAK', strengthProblem);
    if (currentPassword === newPassword) {
      return fail(res, 400, 'PASSWORD_UNCHANGED', 'Choose a password you have not used here before.');
    }

    try {
      const row = await users.getById(actor.id);
      if (!row) return fail(res, 401, 'ACCOUNT_NOT_FOUND', 'Unauthorised');
      if (!row.password_hash) {
        return fail(res, 400, 'PASSWORD_NOT_SET', 'This account has no password yet. Ask an admin to send an invitation.');
      }
      if (!(await verifyPassword(String(currentPassword ?? ''), row.password_hash))) {
        return fail(res, 401, 'CURRENT_PASSWORD_INCORRECT', 'That current password is not right.');
      }

      const password_hash = await hashPassword(newPassword);
      await users.update(actor.id, {
        password_hash,
        password_set_at: new Date().toISOString(),
        must_change_password: false,
        failed_login_count: 0,
        locked_until: null
      });

      // Changing a password ends every other session. Re-stamping this
      // request's cookie with the new epoch keeps the caller signed in on the
      // device they just used, and only that device.
      const nextEpoch = await users.bumpEpoch(actor.id);
      auth.invalidate(actor.id);
      if (req.session) req.session.se = nextEpoch;

      return res.json({ success: true, mustChangePassword: false });
    } catch (error) {
      return sendStoreError(res, error, 'changePassword');
    }
  });

  // ── POST /api/users ───────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    const actor = req.actor;
    const email = String(req.body?.email || '').trim();
    const displayName = String(req.body?.displayName || '').trim();
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;
    const role = String(req.body?.role || 'agent').trim();
    const password = req.body?.password;

    if (!EMAIL_PATTERN.test(email)) return fail(res, 400, 'INVALID_EMAIL', 'Enter a valid email address.');
    if (displayName.length < 1 || displayName.length > 120) {
      return fail(res, 400, 'INVALID_DISPLAY_NAME', 'Enter a name between 1 and 120 characters.');
    }

    try {
      const roles = await users.listRoles();
      const target = roles.find(entry => entry.key === role);
      if (!target || target.is_assignable !== true) {
        return fail(res, 400, 'ROLE_NOT_ASSIGNABLE', 'That role cannot be assigned to a person.');
      }

      const ownerProblem = ownerTransitionError(actor, { fromRole: null, toRole: role });
      if (ownerProblem) return fail(res, ownerProblem.status, ownerProblem.code, ownerProblem.message);

      if (await users.findByEmail(email)) {
        return fail(res, 409, 'EMAIL_ALREADY_EXISTS', 'Somebody already has that email address.');
      }

      let password_hash = null;
      if (password !== undefined && password !== null && password !== '') {
        const strengthProblem = validatePasswordStrength(password);
        if (strengthProblem) return fail(res, 400, 'PASSWORD_TOO_WEAK', strengthProblem);
        password_hash = await hashPassword(password);
      }

      const created = await users.create({
        email,
        display_name: displayName,
        phone,
        role,
        password_hash,
        password_set_at: password_hash ? new Date().toISOString() : null,
        must_change_password: Boolean(password_hash)
      });

      const roleName = createRoleNamer(users);
      const roleDisplay = await roleName(created.role);
      // 'activated', not 'created': the event that matters is a new identity
      // becoming able to act, whether it arrives through this endpoint or
      // through a redeemed invitation.
      await logAudit({
        eventType: 'team.member.activated',
        req,
        entityId: created.id,
        summary: `${actorName(req)} created the account for ${created.display_name} (${created.email}) as ${roleDisplay}`,
        newState: { role: created.role, is_active: created.is_active === true, can_sign_in: Boolean(created.password_hash) },
        metadata: {
          user_id: created.id,
          email: created.email,
          role: created.role,
          role_display_name: roleDisplay,
          via: 'direct_creation',
          can_sign_in: Boolean(created.password_hash)
        }
      });

      return res.status(201).json({
        user: publicUser(created),
        // No email sender is configured in this service, so an account created
        // without a password cannot notify anybody. Say so rather than let an
        // admin assume an email went out.
        note: password_hash
          ? 'Share the password you set over a channel you trust. They will be asked to change it on first sign-in.'
          : 'This account cannot sign in yet. Send them an invitation, or set a password with scripts/set-password.js.'
      });
    } catch (error) {
      return sendStoreError(res, error, 'create');
    }
  });

  // ── PATCH /api/users/:id ──────────────────────────────────────────────────
  router.patch('/:id', async (req, res) => {
    const actor = req.actor;
    const id = parseUserId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_USER_ID', 'That user id is not valid.');

    try {
      const target = await users.getById(id);
      if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'No such user.');
      if (target.is_legacy_shared) {
        return fail(
          res, 409, 'LEGACY_USER_IMMUTABLE',
          'The shared team login cannot be edited here. Change LEGACY_SHARED_ROLE or LEGACY_SHARED_LOGIN instead.'
        );
      }

      // Snapshot before anything mutates. The audit rows at the foot of this
      // handler must describe the row as it was when the request arrived, and
      // `target` is not guaranteed to be a distinct object from whatever
      // users.update() returns.
      const previousRole = target.role;
      const previousActive = target.is_active === true;
      const targetName = target.display_name || target.email;
      const targetEmail = target.email;

      const patch = {};
      let sessionAffecting = false;

      if (req.body?.displayName !== undefined) {
        const displayName = String(req.body.displayName).trim();
        if (displayName.length < 1 || displayName.length > 120) {
          return fail(res, 400, 'INVALID_DISPLAY_NAME', 'Enter a name between 1 and 120 characters.');
        }
        patch.display_name = displayName;
      }
      if (req.body?.phone !== undefined) {
        patch.phone = req.body.phone ? String(req.body.phone).trim() : null;
      }

      let becomingRole = target.role;
      if (req.body?.role !== undefined) {
        becomingRole = String(req.body.role).trim();
        const roles = await users.listRoles();
        const roleRow = roles.find(entry => entry.key === becomingRole);
        if (!roleRow || roleRow.is_assignable !== true) {
          return fail(res, 400, 'ROLE_NOT_ASSIGNABLE', 'That role cannot be assigned to a person.');
        }
        // `previousRole`, not `target.role`: both are the pre-mutation value
        // here, but only the snapshot is guaranteed to stay that way.
        const ownerProblem = ownerTransitionError(actor, { fromRole: previousRole, toRole: becomingRole });
        if (ownerProblem) return fail(res, ownerProblem.status, ownerProblem.code, ownerProblem.message);
        const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
        if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);
        if (becomingRole !== target.role) {
          patch.role = becomingRole;
          sessionAffecting = true;
        }
      }

      let becomingActive = target.is_active === true;
      if (req.body?.isActive !== undefined) {
        if (req.body.isActive !== true) {
          return fail(
            res, 400, 'USE_DEACTIVATE_ENDPOINT',
            'Deactivate a person with POST /api/users/:id/deactivate so the reason is recorded.'
          );
        }
        // Reactivating a peer Owner restores an authority-bearing sign-in, so
        // it is the same class of action as deactivating one and is refused on
        // the same grounds. Note the consequence: a deactivated Owner cannot be
        // brought back by another Owner. In practice one cannot arise through
        // this API any more — the deactivate handler now refuses a peer Owner
        // outright — so this only guards rows that predate the guard, and the
        // remedy for those is a deliberate database change, not a mis-click.
        const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
        if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);
        becomingActive = true;
        if (target.is_active !== true) {
          patch.is_active = true;
          patch.deactivated_at = null;
          sessionAffecting = true;
        }
      }

      if (await wouldStrandWorkspace(target, { becomingActive, becomingRole })) {
        return fail(
          res, 409, 'CANNOT_DEACTIVATE_LAST_OWNER',
          'This is the last active Owner or Admin. Promote somebody else first.'
        );
      }

      // Per-user permission overrides. A deny always wins; an allow with a
      // past expires_at is inert. See scripts/rbac-migration.sql.
      const grants = Array.isArray(req.body?.grants) ? req.body.grants : [];
      const revokeGrants = Array.isArray(req.body?.revokeGrants) ? req.body.revokeGrants : [];
      if (grants.length > 0 || revokeGrants.length > 0) {
        // A per-user override changes what somebody can do just as surely as a
        // role does, so the Owner guards apply to it. Both run before the first
        // upsertGrant below: a refusal must leave the target untouched, and the
        // grant loop is the only mutation in this handler that happens before
        // users.update().
        const ownerProblem = ownerTransitionError(actor, { fromRole: previousRole, toRole: previousRole });
        if (ownerProblem) {
          return fail(res, ownerProblem.status, ownerProblem.code, 'Only an Owner may change an Owner\'s permissions.');
        }
        const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
        if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);

        const known = new Set(await users.listPermissionKeys());
        for (const grant of grants) {
          const key = String(grant?.permissionKey || '');
          const effect = String(grant?.effect || '');
          if (!known.has(key)) return fail(res, 400, 'UNKNOWN_PERMISSION', `Unknown permission: ${key}`);
          if (effect !== 'allow' && effect !== 'deny') {
            return fail(res, 400, 'INVALID_GRANT_EFFECT', 'A grant effect must be "allow" or "deny".');
          }
          if (key === 'user.manage.owner' && !actor.permissions.has('user.manage.owner')) {
            return fail(res, 403, 'OWNER_ROLE_REQUIRES_OWNER', 'Only an Owner may delegate Owner management.');
          }
        }
        for (const key of revokeGrants) {
          if (!known.has(String(key))) return fail(res, 400, 'UNKNOWN_PERMISSION', `Unknown permission: ${key}`);
        }
        for (const grant of grants) {
          await users.upsertGrant({
            user_id: id,
            permission_key: String(grant.permissionKey),
            effect: String(grant.effect),
            reason: grant.reason ? String(grant.reason).slice(0, 500) : null,
            granted_by: actor?.id ?? null,
            expires_at: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null
          });
        }
        for (const key of revokeGrants) {
          await users.deleteGrant(id, String(key));
        }
        sessionAffecting = true;
      }

      const updated = Object.keys(patch).length > 0 ? await users.update(id, patch) : target;
      if (sessionAffecting) await revokeSessions(id);

      // Audited only once the change has actually landed, and separately per
      // kind of change: a role change and a permission override answer
      // different questions and must not be folded into one row.
      const roleName = createRoleNamer(users);

      if (patch.role) {
        const previousDisplay = await roleName(previousRole);
        const newDisplay = await roleName(becomingRole);
        await logAudit({
          eventType: 'team.member.role_changed',
          req,
          entityId: id,
          summary: `${actorName(req)} changed ${targetName} from ${previousDisplay} to ${newDisplay}`,
          previousState: { role: previousRole },
          newState: { role: becomingRole },
          changedFields: ['role'],
          metadata: {
            user_id: id,
            email: targetEmail,
            previous_role: previousRole,
            new_role: becomingRole,
            previous_role_display_name: previousDisplay,
            new_role_display_name: newDisplay,
            logins_revoked: true
          }
        });
      }

      if (patch.is_active === true) {
        const roleDisplay = await roleName(updated.role || previousRole);
        await logAudit({
          eventType: 'team.member.reactivated',
          req,
          entityId: id,
          summary: `${actorName(req)} reactivated ${targetName} as ${roleDisplay}`,
          previousState: { is_active: previousActive },
          newState: { is_active: true },
          changedFields: ['is_active'],
          metadata: {
            user_id: id,
            email: targetEmail,
            role: updated.role || previousRole,
            role_display_name: roleDisplay,
            logins_revoked: true
          }
        });
      }

      // One row per override. There are only ever a handful in a request, and
      // "who was given automation.cancel, and why" is the question these exist
      // to answer — a single rolled-up row would not answer it.
      for (const grant of grants) {
        await logAudit({
          eventType: 'team.permission_override.granted',
          req,
          entityId: id,
          summary: `${actorName(req)} added a per-user "${String(grant.effect)}" override for ${String(grant.permissionKey)} on ${targetName}`,
          metadata: {
            user_id: id,
            email: targetEmail,
            permission_key: String(grant.permissionKey),
            effect: String(grant.effect),
            reason: grant.reason ? String(grant.reason).slice(0, 500) : null,
            expires_at: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null
          }
        });
      }
      for (const key of revokeGrants) {
        await logAudit({
          eventType: 'team.permission_override.revoked',
          req,
          entityId: id,
          summary: `${actorName(req)} removed the per-user override for ${String(key)} from ${targetName}`,
          metadata: { user_id: id, email: targetEmail, permission_key: String(key) }
        });
      }

      return res.json({ user: publicUser(updated), sessionsRevoked: sessionAffecting });
    } catch (error) {
      return sendStoreError(res, error, 'update');
    }
  });

  // ── POST /api/users/:id/deactivate ────────────────────────────────────────
  router.post('/:id/deactivate', async (req, res) => {
    const actor = req.actor;
    const id = parseUserId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_USER_ID', 'That user id is not valid.');

    try {
      const target = await users.getById(id);
      if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'No such user.');
      if (target.is_legacy_shared) {
        return fail(
          res, 409, 'LEGACY_USER_IMMUTABLE',
          'The shared team login cannot be deactivated here. Set LEGACY_SHARED_LOGIN=disabled instead.'
        );
      }

      // Snapshotted before any guard runs, and reused by the audit row at the
      // foot of this handler. Reading `target.role` twice invites the bug this
      // file already fixed once: `users.update()` is not guaranteed to return a
      // different object from `target`, so a second read can see the new value.
      const previousRole = target.role;
      const targetName = target.display_name || target.email;
      const targetEmail = target.email;

      // Deactivation ends every session the target has. It had NO Owner guard
      // at all, which meant an Admin could switch an Owner off — the role
      // hierarchy held for "change their role" and not for the strictly more
      // severe "revoke all their access". Both guards belong here.
      const ownerProblem = ownerTransitionError(actor, { fromRole: previousRole, toRole: previousRole });
      if (ownerProblem) {
        return fail(res, ownerProblem.status, ownerProblem.code, 'Only an Owner may deactivate an Owner.');
      }
      const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
      if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);

      if (target.is_active !== true) {
        return res.json({ user: publicUser(target), alreadyInactive: true });
      }
      if (await wouldStrandWorkspace(target, { becomingActive: false, becomingRole: previousRole })) {
        return fail(
          res, 409, 'CANNOT_DEACTIVATE_LAST_OWNER',
          'This is the last active Owner or Admin. Promote somebody else first.'
        );
      }

      const updated = await users.update(id, {
        is_active: false,
        deactivated_at: new Date().toISOString()
      });
      await revokeSessions(id);

      const roleDisplay = await createRoleNamer(users)(previousRole);
      await logAudit({
        eventType: 'team.member.deactivated',
        req,
        entityId: id,
        summary: `${actorName(req)} deactivated ${targetName} (${roleDisplay}) and ended their sessions`,
        previousState: { is_active: true, role: previousRole },
        newState: { is_active: false, role: previousRole },
        changedFields: ['is_active'],
        metadata: {
          user_id: id,
          email: targetEmail,
          role: previousRole,
          role_display_name: roleDisplay,
          logins_revoked: true
        }
      });

      return res.json({ user: publicUser(updated), sessionsRevoked: true });
    } catch (error) {
      return sendStoreError(res, error, 'deactivate');
    }
  });

  // ── POST /api/users/:id/reset-password ────────────────────────────────────
  router.post('/:id/reset-password', async (req, res) => {
    const actor = req.actor;
    const id = parseUserId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_USER_ID', 'That user id is not valid.');

    try {
      const target = await users.getById(id);
      if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'No such user.');
      if (target.is_legacy_shared) {
        return fail(
          res, 409, 'LEGACY_USER_IMMUTABLE',
          'The shared team login uses INBOX_PASSWORD, which is not reset from here.'
        );
      }
      // Snapshotted before the update below, which rewrites password fields on
      // this same row and, depending on the store, may hand back the very same
      // object. Every use after this point reads the snapshot.
      const previousRole = target.role;

      const ownerProblem = ownerTransitionError(actor, { fromRole: previousRole, toRole: previousRole });
      if (ownerProblem) {
        return fail(res, ownerProblem.status, ownerProblem.code, 'Only an Owner may reset an Owner password.');
      }
      // A password reset hands the target's account to whoever performed it:
      // it mints a temporary credential, shows it to the actor, and revokes the
      // owner's live sessions. It is a takeover, so it is refused between peers
      // for the same reason a demotion is.
      const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
      if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);

      const temporaryPassword = generateTemporaryPassword();
      await users.update(id, {
        password_hash: await hashPassword(temporaryPassword),
        password_set_at: new Date().toISOString(),
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null
      });
      await revokeSessions(id);

      // The temporary password is NOT an argument to this call and must never
      // become one. Neither is the hash. The audit row records that a reset
      // happened, by whom, to whom — not the credential it produced. There is
      // deliberately no previous_state/new_state here: every field that would
      // describe the change is password-shaped, and the state screen in
      // lib/audit/log.js would drop it anyway.
      const roleDisplay = await createRoleNamer(users)(previousRole);
      await logAudit({
        eventType: 'team.member.password_reset',
        req,
        entityId: id,
        summary: `${actorName(req)} reset the password for ${target.display_name || target.email} (${roleDisplay}) and ended their sessions`,
        metadata: {
          user_id: id,
          email: target.email,
          role: previousRole,
          role_display_name: roleDisplay,
          reset_method: 'admin_temporary_password',
          must_rotate_on_next_sign_in: true,
          logins_revoked: true
        }
      });

      // Shown exactly once, in this response. Nothing stores it in plaintext
      // and no email is sent, because this service has no email sender.
      return res.json({
        success: true,
        temporaryPassword,
        note: 'Shown once. Pass it on over a channel you trust; they must change it at next sign-in.'
      });
    } catch (error) {
      return sendStoreError(res, error, 'resetPassword');
    }
  });

  return router;
}

module.exports = createUsersRouter;
module.exports.createUserStore = createUserStore;
module.exports.publicUser = publicUser;
module.exports.ADMINISTRATIVE_ROLES = ADMINISTRATIVE_ROLES;
