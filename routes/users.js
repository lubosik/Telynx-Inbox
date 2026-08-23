'use strict';
/**
 * routes/users.js — team management.
 *
 *   GET    /api/users                     user.read
 *   POST   /api/users                     user.manage
 *   GET    /api/users/me                  any authenticated actor
 *   PATCH  /api/users/me                  any authenticated actor
 *   GET    /api/users/me/timezones        any authenticated actor
 *   POST   /api/users/me/onboarding       any authenticated named actor
 *   POST   /api/users/me/password         any authenticated actor
 *   POST   /api/users/me/email            any authenticated actor
 *   POST   /api/users/me/email/cancel     any authenticated actor
 *   PATCH  /api/users/:id                 user.manage
 *   POST   /api/users/:id/deactivate      user.manage
 *   POST   /api/users/:id/reactivate      user.manage
 *   POST   /api/users/:id/reset-password  user.manage
 *
 * The confirm half of the email change is POST /auth/email-change/confirm in
 * routes/auth.js, which must be public: the person opening the link has no
 * session and may be on a device that never had one. It shares this file's
 * `createEmailChangeStore` and `confirmationErrorFrom`.
 *
 * SELF-SERVICE VERSUS ADMINISTRATIVE
 *   The two email paths are deliberately different, and the difference is not
 *   an oversight:
 *     * You changing your own address must be confirmed at the new address.
 *       An unconfirmed self-service change is account takeover — a borrowed
 *       session becomes permanent ownership.
 *     * An Admin changing somebody else's address is applied immediately. It
 *       is a correction, usually of a typo that is stopping an invitation from
 *       arriving, and requiring confirmation from a mailbox that does not work
 *       would make the one case it exists for impossible. It is audited and
 *       BOTH addresses are notified instead.
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
const { eventDefinition } = require('../lib/audit/event-types');
const { sendEmail, appUrl } = require('../lib/email');
const {
  emailChangeConfirmationEmail,
  emailChangeNoticeEmail,
  emailChangedByAdminEmail,
  emailChangeAddressInUseEmail
} = require('../lib/email-templates');
// Reused, not re-implemented. routes/invitations.js already owns "hash a
// bearer token with sha256 and store only the digest plus a prefix OF THE
// DIGEST", it is the pattern this feature was asked to copy, and a second
// hasher is a second thing that can drift.
const { hashToken, generateToken, TOKEN_PREFIX_LENGTH } = require('./invitations');
// Per-account DISPLAY time zone. Read that module's header before touching any
// of this: `sms_users.timezone` decides how a timestamp is RENDERED for one
// person and has no bearing on when a customer is texted. Campaign quiet hours
// are enforced in SQL against `sms_campaign_settings.business_timezone`, which
// is a property of the business, not of a member of staff.
const {
  DEFAULT_TIME_ZONE,
  canonicalTimeZone,
  catalogue: timeZoneCatalogue,
  describeStoredTimeZone
} = require('../lib/timezones');

const ADMINISTRATIVE_ROLES = ['owner', 'admin'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPORARY_PASSWORD_BYTES = 15; // 20 base64url characters

/**
 * How long a pending email change stays confirmable.
 *
 * 24 hours. Long enough that a request made at the end of a shift can be
 * confirmed the next morning on a phone that was left at home, short enough
 * that a link sitting in a mailbox somebody else later gains access to has
 * almost always expired. It is stated in the confirmation email, stated in the
 * heads-up to the old address, and enforced by `expires_at` inside
 * confirm_sms_email_change — the copy is a courtesy, the database is the rule.
 */
const EMAIL_CHANGE_TTL_HOURS = 24;

/** The product name as a person reads it, matching routes/invitations.js. */
const WORKSPACE_NAME = 'Vici Inbox';

/**
 * The three profile/address audit types this file emits.
 *
 * All three ARE registered in lib/audit/event-types.js, and their metadata keys
 * are on the allowlists in lib/audit/redact.js, so every call site below writes
 * a real row. They are still emitted through `auditIfRegistered` rather than
 * `logAudit` directly: that file is owned elsewhere, `logAudit` THROWS on an
 * unregistered type, and a type deleted there must degrade to one warning in
 * the service log rather than turning a completed profile edit into a 500.
 *
 *   team.member.profile_updated       — display name, phone, or display time
 *                                       zone. Self-service or an admin edit.
 *   team.member.email_change_requested— somebody ASKED to move address. Written
 *                                       even when nothing was created, because
 *                                       an unconfirmed attempt is exactly the
 *                                       one worth having a record of.
 *   team.member.email_changed         — an address actually moved, by either
 *                                       path.
 */
const PROFILE_UPDATED_EVENT = 'team.member.profile_updated';
const EMAIL_CHANGED_EVENT = 'team.member.email_changed';
const EMAIL_CHANGE_REQUESTED_EVENT = 'team.member.email_change_requested';

/** PostgREST/Postgres codes for "that column or relation is not there". */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204', 'PGRST205']);

/**
 * Does this store error mean scripts/user-timezone-migration.sql has not been
 * applied to this database?
 *
 * Shaped after isMissingSchema() in lib/audit/log.js, and narrow for the same
 * reason it is: Postgres names the column in CHECK violations and permission
 * errors too, so a bare "the message mentions timezone" test would tell an
 * operator to run a migration that is already applied and would hide a real
 * constraint failure behind that advice. The message must say the thing is
 * ABSENT and it must name this column.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingTimezoneColumn(error) {
  if (MISSING_COLUMN_CODES.has(error?.code)) return true;
  const message = String(error?.message || '');
  return /does not exist|could not find|schema cache/i.test(message) && /timezone/i.test(message);
}

/**
 * The RAISE strings in confirm_sms_email_change mapped onto HTTP. Each refusal
 * gets its own code, because "expired" and "already used" call for completely
 * different next steps and a single generic failure would hide which one
 * happened.
 */
const CONFIRMATION_ERRORS = Object.freeze({
  EMAIL_CHANGE_NOT_FOUND:      { status: 404, message: 'That confirmation link is not valid.' },
  EMAIL_CHANGE_USED:           { status: 409, message: 'That confirmation link has already been used.' },
  EMAIL_CHANGE_CANCELLED:      { status: 409, message: 'That email change was cancelled.' },
  EMAIL_CHANGE_EXPIRED:        { status: 410, message: 'That confirmation link has expired. Start the change again.' },
  EMAIL_CHANGE_USER_NOT_FOUND: { status: 404, message: 'That confirmation link is not valid.' },
  EMAIL_CHANGE_USER_INACTIVE:  { status: 409, message: 'That account is disabled, so its address cannot be changed.' },
  LEGACY_USER_IMMUTABLE:       { status: 409, message: 'The shared team login cannot change its address.' },
  EMAIL_ALREADY_EXISTS:        { status: 409, message: 'Somebody else has taken that address since the link was sent.' }
});

/**
 * Match a database RAISE onto one of the codes above.
 *
 * Longest key first: 'EMAIL_CHANGE_USER_NOT_FOUND' contains no other key as a
 * substring, but 'EMAIL_CHANGE_USED' and 'EMAIL_CHANGE_USER_INACTIVE' share a
 * prefix and an unordered scan could report the wrong one.
 *
 * @returns {null|{code: string, status: number, message: string}}
 */
function confirmationErrorFrom(error) {
  const message = String(error?.message || '');
  const codes = Object.keys(CONFIRMATION_ERRORS).sort((a, b) => b.length - a.length);
  for (const code of codes) {
    if (message.includes(code)) return { code, ...CONFIRMATION_ERRORS[code] };
  }
  return null;
}

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

    /**
     * Every stored display time zone, keyed by id.
     *
     * Same 500-row cap as list() above and for the same reason: the team is
     * single-digit sized, so this is one of the few reads here that genuinely
     * cannot meet PostgREST's silent 1000-row ceiling.
     *
     * @returns {Promise<Array<{id: number, timezone: string|null}>>}
     */
    async listTimezones() {
      return unwrap(
        await db()
          .from('sms_users')
          .select('id, timezone')
          .order('id', { ascending: true })
          .limit(500),
        'listTimezones'
      ) || [];
    },

    /**
     * This person's stored display time zone, or null when they have never
     * chosen one.
     *
     * Read on its own rather than folded into the column lists above, and that
     * is deliberate. `timezone` arrives with
     * scripts/user-timezone-migration.sql; adding it to list(), getById() and
     * update() would mean that on a server where the migration has not been
     * applied yet EVERY team endpoint answers 500. Isolated here, an unapplied
     * migration costs one optional field on one payload. Same reasoning as
     * getOnboarding() below.
     *
     * @returns {Promise<string|null>}
     */
    async getTimezone(id) {
      const row = unwrap(
        await db()
          .from('sms_users')
          .select('timezone')
          .eq('id', id)
          .maybeSingle(),
        'getTimezone'
      );
      return row?.timezone || null;
    },

    async getOnboarding(id) {
      return unwrap(
        await db()
          .from('sms_users')
          .select('onboarding_status, onboarding_version, onboarding_decided_at')
          .eq('id', id)
          .maybeSingle(),
        'getOnboarding'
      );
    },

    async decideOnboarding(id, status, version) {
      const result = await db().rpc('decide_sms_user_onboarding', {
        p_user_id: id,
        p_status: status,
        p_version: version
      });
      const data = unwrap(result, 'decideOnboarding');
      return Array.isArray(data) ? (data[0] || null) : data;
    },

    async findByEmail(email) {
      const escaped = String(email).replace(/([\\%_])/g, '\\$1');
      const rows = unwrap(
        await db().from('sms_users').select('id, email').ilike('email', escaped).limit(2),
        'findByEmail'
      );
      return (rows && rows.length === 1) ? rows[0] : null;
    },

    /**
     * Is `email` already spoken for, ignoring `exceptUserId`?
     *
     * Distinct from findByEmail(), which returns null when it sees two matches
     * and is therefore the wrong shape for a uniqueness check: "the answer is
     * ambiguous" must read as TAKEN here, never as available. It also has to
     * ignore the caller's own row, so that re-submitting the address you
     * already hold is a plain no-op rather than a collision with yourself.
     *
     * Case-insensitive, matching the unique index on lower(email) that the
     * database enforces. `%` and `_` are escaped so an address containing
     * either cannot widen the pattern into a wildcard search.
     *
     * @returns {Promise<boolean>}
     */
    async emailIsTaken(email, exceptUserId = null) {
      const escaped = String(email).replace(/([\\%_])/g, '\\$1');
      const rows = unwrap(
        await db().from('sms_users').select('id').ilike('email', escaped).limit(5),
        'emailIsTaken'
      ) || [];
      const except = exceptUserId === null || exceptUserId === undefined
        ? null
        : Number(exceptUserId);
      return rows.some(row => except === null || Number(row.id) !== except);
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

    /**
     * Stop this person's phones receiving customer notifications.
     *
     * Deactivating used to end sessions and nothing else, so a removed
     * teammate's iPhone kept showing message alerts with sender names and body
     * previews. lib/apns-notify.js now also filters them out at delivery, but
     * that is the backstop: the right thing is to remove the registration, so
     * the device stops being a recipient at all rather than being skipped on
     * every send forever.
     *
     * Best-effort by design. Push storage is secondary to the account state,
     * and failing to revoke a device must not prevent the deactivation itself
     * from committing. A failure is logged loudly and the delivery filter still
     * covers it.
     */
    async revokePushDevices(id) {
      const userId = String(id);
      let revoked = 0;

      try {
        const dedicated = await db()
          .from('ios_push_devices')
          .delete()
          .eq('user_id', userId)
          .select('id');
        if (!dedicated.error) revoked += (dedicated.data || []).length;
      } catch (err) {
        console.warn('[USERS] Could not revoke dedicated push devices:', err.message);
      }

      // The compatibility table stores ownership inside the jsonb payload, so
      // it is matched on the arrow operator rather than a column.
      try {
        const compatibility = await db()
          .from('push_subscriptions')
          .delete()
          .eq('subscription->>userId', userId)
          .select('id');
        if (!compatibility.error) revoked += (compatibility.data || []).length;
        else console.warn('[USERS] Could not revoke compatibility push devices:', compatibility.error.message);
      } catch (err) {
        console.warn('[USERS] Could not revoke compatibility push devices:', err.message);
      }

      if (revoked > 0) console.log(`[USERS] Revoked ${revoked} push device(s) for user ${userId}`);
      return revoked;
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

/**
 * Pending email changes — scripts/email-change-migration.sql.
 *
 * Exported, because the CONFIRM half of this flow lives in routes/auth.js: it
 * has to be public (the person clicking the link has no session, and may be
 * signing in from a device that never had one) and everything public in this
 * service is mounted under /auth. Sharing the store rather than duplicating it
 * is the same arrangement routes/auth.js already has with
 * routes/invitations.js.
 *
 * `token_hash` is NEVER selected by anything in here except as a filter. There
 * is deliberately no getter for it: a handler that could read the stored digest
 * would be one careless refactor away from putting it in a response body or a
 * log line, and it is a live credential's only remaining trace.
 */
function createEmailChangeStore({ client } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }

  function unwrap(result, context) {
    if (result.error) {
      throw Object.assign(new Error(result.error.message), { code: 'EMAIL_CHANGE_STORE_FAILED', context });
    }
    return result.data;
  }

  return {
    /**
     * The one request for this person that is neither confirmed nor cancelled,
     * or null. `expires_at` is returned rather than filtered on: an expired row
     * is still OPEN as far as the partial unique index is concerned, and the
     * caller has to cancel it before it can insert a replacement.
     */
    async openForUser(userId) {
      const rows = unwrap(
        await db()
          .from('sms_email_changes')
          .select('id, user_id, new_email, token_prefix, requested_at, expires_at')
          .eq('user_id', userId)
          .is('confirmed_at', null)
          .is('cancelled_at', null)
          .limit(1),
        'openForUser'
      );
      return (rows && rows[0]) || null;
    },

    /**
     * Close every open request for this person.
     *
     * Used both by the explicit cancel endpoint and as the supersede step
     * before a new request is inserted, so that asking twice replaces the first
     * link instead of colliding with the partial unique index.
     *
     * @returns {Promise<number>} how many rows were closed
     */
    async cancelOpenForUser(userId) {
      const result = await db()
        .from('sms_email_changes')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('confirmed_at', null)
        .is('cancelled_at', null)
        .select('id');
      if (result.error) {
        throw Object.assign(new Error(result.error.message), {
          code: 'EMAIL_CHANGE_STORE_FAILED', context: 'cancelOpenForUser'
        });
      }
      return (result.data || []).length;
    },

    /** token_prefix is returned; token_hash is not, and must never be. */
    async create(row) {
      return unwrap(
        await db()
          .from('sms_email_changes')
          .insert(row)
          .select('id, user_id, new_email, token_prefix, requested_at, expires_at')
          .single(),
        'create'
      );
    },

    /**
     * Confirm one pending change, atomically.
     *
     * Straight through to the SQL function, which locks the row, validates it,
     * rewrites sms_users.email and bumps session_epoch in a single transaction.
     * There is no read-then-write here on purpose: two clicks on the same link
     * a millisecond apart must produce exactly one change, and Node cannot make
     * that promise.
     *
     * @param {string} tokenHash
     * @returns {Promise<{change_id: string, user_id: number, previous_email: string,
     *                    new_email: string, session_epoch: number, confirmed_at: string}>}
     * @throws with the RAISE text in `message`; see confirmationErrorFrom().
     */
    async confirm(tokenHash) {
      const result = await db().rpc('confirm_sms_email_change', { p_token_hash: tokenHash });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'EMAIL_CHANGE_CONFIRM_FAILED' });
      }
      return result.data;
    }
  };
}

/**
 * The only serialiser. password_hash is reduced to a boolean and dropped.
 *
 * `timeZone` is always present and never null, so no client has to model its
 * absence. `isDefault: true` means "no stored choice was read", which covers
 * three cases a client cannot usefully tell apart: the person has never
 * chosen, the row was serialised without selecting the column, and
 * scripts/user-timezone-migration.sql has not been applied. The right
 * behaviour is the same in all three: render the default, offer the picker.
 */
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
    createdAt: row.created_at || null,
    timeZone: describeStoredTimeZone(row.timezone ?? null)
  };
}

/** Server-owned first-run state. Missing state is omitted and therefore never
 *  makes an older account look new in the iOS client. */
function publicOnboarding(row) {
  if (!row) return null;
  const status = row.onboarding_status;
  const version = Number(row.onboarding_version);
  if (!['not_started', 'completed', 'skipped', 'ineligible'].includes(status)
      || !Number.isInteger(version) || version < 1) return null;
  return {
    status,
    version,
    eligible: status === 'not_started',
    decidedAt: row.onboarding_decided_at || null
  };
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

/**
 * The answer when a WRITE to sms_users.timezone fails because the column is not
 * there yet.
 *
 * A read falls back to the default and says nothing; see readStoredTimeZone().
 * A write must not, because silently discarding somebody's choice and
 * answering 200 is worse than refusing. 503 rather than 500: the request was
 * valid, the server is not ready for it, and the fix is an operator applying
 * scripts/user-timezone-migration.sql rather than the caller retrying.
 */
function timeZoneUnavailable(res, error) {
  console.error(
    '[USERS] sms_users.timezone is not present, so a time zone could not be saved. '
    + `Apply scripts/user-timezone-migration.sql (${error?.code || 'unknown'}).`
  );
  return fail(
    res, 503, 'TIME_ZONE_UNAVAILABLE',
    'Time zones are not available on this server yet. Ask an admin to finish the update.'
  );
}

function sendStoreError(res, error, label) {
  console.error(`[USERS] ${label} failed:`, error?.code || 'internal_error', error?.context || '');
  return fail(res, 500, 'USER_REQUEST_FAILED', 'That change could not be completed.');
}

/**
 * Validate a submitted `timeZone` and, if it is good, write it into `patch`.
 *
 * The accepted set is `Intl.supportedValuesOf('timeZone')`, read from the
 * running ICU rather than from a list kept in this repository. See
 * lib/timezones.js for why: a hand-written list rots, and it drifts away from
 * the very formatter the clients use, so a value we accepted today would fail
 * to render tomorrow.
 *
 * A rejection NAMES the problem, because the only way to reach it is to have
 * sent something that is not a zone, and it leaks nothing: the accepted set is
 * public knowledge and GET /api/users/me/timezones publishes all of it.
 *
 * `null` (or an empty string) CLEARS the choice, which is not the same as
 * setting one. It returns the account to the documented fallback and lets a
 * client prompt again.
 *
 * @param {object} patch   mutated in place when the value is acceptable
 * @param {unknown} value  req.body.timeZone
 * @returns {null|{status: number, code: string, message: string}}
 */
function timeZonePatch(patch, value) {
  if (value === null || value === '') {
    patch.timezone = null;
    return null;
  }
  const canonical = canonicalTimeZone(value);
  if (!canonical) {
    return {
      status: 400,
      code: 'INVALID_TIME_ZONE',
      message: 'That is not a time zone this server knows. Send an IANA identifier such as '
        + `${DEFAULT_TIME_ZONE} or America/New_York. GET /api/users/me/timezones lists every one.`
    };
  }
  // The CANONICAL spelling is stored, never what arrived. `europe/london` and
  // `Europe/London` must not become two rows that render identically and
  // compare differently.
  patch.timezone = canonical;
  return null;
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
 * `${APP_URL}/confirm-email-change?token=...`, or null when APP_URL is unset.
 *
 * Mirrors acceptUrlFor() in routes/invitations.js, including the trailing-slash
 * strip that lib/email.js:appUrl() performs.
 *
 * ONE URL, THREE ANSWERS, in this order:
 *
 *   1. An iPhone with a build that routes the path opens the Vici Inbox app.
 *      lib/apple-site-association.js carries the claim as a STAGED one,
 *      published when APPLE_CLAIM_EMAIL_CHANGE is set, which happens after such
 *      a build is in the field. iOS caches the association document, so
 *      publishing before the app can answer produces a link that opens the app
 *      to nothing; that file's header explains why the order is not optional.
 *   2. Everywhere else, `app.get('/confirm-email-change')` in server.js serves
 *      public/confirm-email-change.html, which posts the token to
 *      POST /auth/email-change/confirm and completes the change in any browser.
 *   3. With APP_URL unset there is no link at all, and the handler below
 *      refuses the request rather than writing a pending change nobody can
 *      confirm.
 *
 * The literal path here and the claimed path must stay the same string;
 * test/email-change-link.test.js asserts it, because a drift between them
 * silently stops the claim matching and produces no error anywhere.
 */
function confirmUrlFor(rawToken) {
  const base = appUrl();
  return base ? `${base}/confirm-email-change?token=${encodeURIComponent(rawToken)}` : null;
}

/**
 * Send one templated message and reduce the result to the shape a response
 * body reports verbatim.
 *
 * Cannot throw: lib/email.js resolves on every path including a missing
 * provider key, and the templates are pure. That matters because every caller
 * below is sending AFTER a decision has already been made, and a mail failure
 * must never turn a completed operation into a 500.
 *
 * `message` may contain a live confirmation token. It is handed to the provider
 * and never logged, here or in lib/email.js.
 *
 * @param {Function} send  lib/email.js sendEmail, or a test double
 * @param {{subject: string, text: string, html: string}} message
 * @param {string} to
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function deliverMessage(send, message, to) {
  const recipient = String(to || '').trim();
  if (!recipient) return { sent: false, reason: 'no_recipient' };
  const result = await send({
    to: recipient,
    subject: message.subject,
    text: message.text,
    html: message.html
  });
  return result?.sent === true
    ? { sent: true }
    : { sent: false, reason: result?.reason || 'unknown' };
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
 * @param {object} [options]
 * @param {object} [options.store]             user store
 * @param {object} [options.emailChangeStore]  pending email-change store
 * @param {object} [options.authz]
 * @param {Function} [options.audit]           audit writer
 * @param {Function} [options.sendMail]        lib/email.js sendEmail, injected offline
 */
function createUsersRouter({ store, emailChangeStore, authz, audit, sendMail } = {}) {
  const users = store || createUserStore({});
  const emailChanges = emailChangeStore || createEmailChangeStore({});
  const auth = authz || require('../lib/authz').sharedAuthz();
  // Injectable so the unit tests can assert on the rows without a database.
  // The default can never throw; see lib/audit/log.js.
  const logAudit = audit || logAuditSafely;
  // lib/email.js never throws and never rejects; see its header. Injected so
  // the tests can assert on what would have been sent without a network.
  const send = sendMail || sendEmail;
  const router = express.Router();

  /**
   * Write an audit row, but only for an event type the catalogue knows.
   *
   * `logAudit` throws on an unregistered type — see lib/audit/log.js — so
   * calling it with one is not "best effort", it is a guaranteed failure that
   * `logAuditSafely` would swallow into a warning nobody reads. This checks
   * first and says exactly which type is missing.
   *
   * Every registered type goes straight through, so today this is a no-op for
   * every `team.*` event this file emits. It stays because the catalogue is
   * owned elsewhere: a type removed there must cost one warning, not a 500 on
   * a change that has already been written to sms_users.
   *
   * @returns {Promise<{audited: boolean, reason?: string}>}
   */
  async function auditIfRegistered(input) {
    if (!eventDefinition(input.eventType)) {
      console.warn(
        `[USERS] Not audited: "${input.eventType}" is not registered in `
        + 'lib/audit/event-types.js. Add it there (and its metadata keys to '
        + 'METADATA_ALLOWLIST in lib/audit/redact.js) to turn this row on.'
      );
      return { audited: false, reason: 'event_type_unregistered' };
    }
    await logAudit(input);
    return { audited: true };
  }

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
      // Merged in from a separate read, for the same reason getTimezone() is a
      // separate read: `timezone` arrives with a migration, and folding it into
      // the main column list would turn "the migration has not run yet" into
      // "the team screen is broken". A failure here costs the column, not the
      // page, and every row then serialises with the documented default.
      const zones = await listStoredTimeZones();
      res.set('Cache-Control', 'no-store, private');
      return res.json({
        users: rows.map(row => publicUser({ ...row, timezone: zones.get(Number(row.id)) ?? null })),
        roles
      });
    } catch (error) {
      return sendStoreError(res, error, 'list');
    }
  });

  // ── GET /api/users/me ─────────────────────────────────────────────────────
  // Deliberately open to every authenticated actor, including one locked into
  // must_change_password. It is how a client learns what to render.
  /**
   * Every stored zone, keyed by user id, and never a throw.
   *
   * Bounded by the same 500-row cap as users.list(): the team is single-digit
   * sized, so this cannot approach PostgREST's silent 1000-row ceiling. An
   * unreadable column yields an empty map and every row then serialises with
   * the documented default.
   *
   * @returns {Promise<Map<number, string|null>>}
   */
  async function listStoredTimeZones() {
    if (typeof users.listTimezones !== 'function') return new Map();
    try {
      const rows = await users.listTimezones();
      return new Map((rows || []).map(row => [Number(row.id), row.timezone || null]));
    } catch (error) {
      warnTimeZoneReadFailed(error, 'the team list');
      return new Map();
    }
  }

  /**
   * `sms_users.timezone` for one id, or null, and never a throw.
   *
   * The fail-open read. A person who has never chosen, a failed read, and a
   * database where the migration has not been applied yet are all null here
   * and all become the documented default one layer up. A missing column
   * during a rolling deploy must cost one rendered field, never account
   * access.
   *
   * @param {number|string} id
   * @returns {Promise<string|null>}
   */
  async function readStoredTimeZone(id) {
    if (typeof users.getTimezone !== 'function') return null;
    try {
      return await users.getTimezone(id);
    } catch (error) {
      warnTimeZoneReadFailed(error, `user ${id}`);
      return null;
    }
  }

  /** One warning shape for both readers, so the advice is never half-given. */
  function warnTimeZoneReadFailed(error, what) {
    if (isMissingTimezoneColumn(error)) {
      console.warn(
        `[USERS] sms_users.timezone is not present, so no time zone was read for ${what}. `
        + 'Apply scripts/user-timezone-migration.sql.'
      );
      return;
    }
    console.warn(`[USERS] time zone unavailable for ${what}:`, error?.code || 'read_failed');
  }

  /**
   * The `timeZone` object for one actor. ALWAYS resolves to a descriptor.
   *
   * The shared legacy identity is not asked at all: two people are behind it,
   * so there is no such thing as "their" zone, and answering the documented
   * default is honest where answering one of them would not be.
   *
   * @param {object} actor  req.actor
   */
  async function timeZoneFor(actor) {
    const shared = actor.viaLegacySession || actor.isLegacyShared
      || actor.id === null || actor.id === undefined;
    if (shared) return describeStoredTimeZone(null);
    return describeStoredTimeZone(await readStoredTimeZone(actor.id));
  }

  router.get('/me', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    let onboarding = null;
    if (!actor.viaLegacySession && !actor.isLegacyShared && typeof users.getOnboarding === 'function') {
      try {
        onboarding = publicOnboarding(await users.getOnboarding(actor.id));
      } catch (error) {
        // Fail closed and preserve account access during an additive rolling
        // deploy. No state is safer than accidentally touring every existing
        // user when the migration is not available yet.
        console.warn('[USERS] onboarding state unavailable:', error?.code || 'read_failed');
      }
    }
    // Unlike `onboarding`, this key is ALWAYS present. Onboarding is omitted
    // when unknown so an older account is never made to look new; a display
    // time zone has a correct answer in every case, and a client forced to
    // cope with its absence would re-implement the fallback locally, which is
    // exactly the per-device divergence this feature removes.
    const timeZone = await timeZoneFor(actor);
    res.set('Cache-Control', 'no-store, private');
    return res.json({
      id: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role,
      isLegacyShared: actor.isLegacyShared,
      viaLegacySession: actor.viaLegacySession,
      mustChangePassword: actor.mustChangePassword,
      permissions: [...actor.permissions].sort(),
      timeZone,
      ...(onboarding ? { onboarding } : {})
    });
  });

  // ── GET /api/users/me/timezones ───────────────────────────────────────────
  // The picker. Every IANA zone this server accepts, grouped by region, each
  // with the offset it is on RIGHT NOW and a human label.
  //
  // WHY THE LIST IS BUILT HERE AND NOT ON EACH CLIENT
  //   Two clients formatting their own list from their own runtime would show
  //   two different lists: different ICU versions know different zones, so one
  //   of them would offer a zone this server then refuses. One server-side list
  //   means the set a person can pick from is exactly the set that will be
  //   accepted, and the offsets shown beside each entry are the ones the server
  //   computed rather than two devices' separate guesses.
  //
  // WHY IT IS UNDER /me RATHER THAN /api/users/timezones
  //   `permission: null` in lib/route-policy.js is reserved for endpoints under
  //   /api/users/me that act only on the caller, and test/route-policy.test.js
  //   asserts exactly that. Choosing your own zone is open to every Support
  //   Agent, so the picker has to be open, so it belongs under /me. It reads no
  //   account state and returns the same document to everybody.
  router.get('/me/timezones', (req, res) => {
    if (!req.actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    // Not `no-store`. This is a constant public list, it costs real Intl work
    // to build, and a picker that re-downloads four hundred rows every time it
    // opens is a worse experience for no privacy gain. `private` because it is
    // still served behind a session and no shared proxy should hold it.
    res.set('Cache-Control', 'private, max-age=900');
    return res.json(timeZoneCatalogue());
  });

  // ── POST /api/users/me/onboarding ────────────────────────────────────────
  // This route can decide only the authenticated actor's first-run state. The
  // optional userId in the body is an optimistic identity check for clients;
  // it is never used as the update target.
  router.post('/me/onboarding', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    if (actor.viaLegacySession || actor.isLegacyShared || actor.id === null || actor.id === undefined) {
      return fail(res, 409, 'ONBOARDING_NOT_ELIGIBLE', 'The shared team login does not have a personal tour state.');
    }

    const status = String(req.body?.status || '').trim();
    const version = Number(req.body?.version);
    const bodyUserId = req.body?.userId;
    if (!['completed', 'skipped'].includes(status)) {
      return fail(res, 400, 'INVALID_ONBOARDING_STATUS', 'Status must be completed or skipped.');
    }
    if (!Number.isInteger(version) || version < 1) {
      return fail(res, 400, 'INVALID_ONBOARDING_VERSION', 'Onboarding version must be a positive integer.');
    }
    if (bodyUserId !== undefined && String(bodyUserId) !== String(actor.id)) {
      return fail(res, 409, 'ONBOARDING_USER_MISMATCH', 'The signed-in account changed. Reload and try again.');
    }
    if (typeof users.decideOnboarding !== 'function') {
      return fail(res, 503, 'ONBOARDING_UNAVAILABLE', 'Tour state is not available yet.');
    }

    try {
      const row = await users.decideOnboarding(actor.id, status, version);
      const onboarding = publicOnboarding(row);
      if (!onboarding) {
        return fail(res, 503, 'ONBOARDING_UNAVAILABLE', 'Tour state is not available yet.');
      }
      if (onboarding.version !== version) {
        return fail(res, 409, 'ONBOARDING_VERSION_CHANGED', 'This tour version is no longer current.', { onboarding });
      }
      if (onboarding.status !== status) {
        return fail(res, 409, 'ONBOARDING_ALREADY_DECIDED', 'This tour has already been completed or skipped.', { onboarding });
      }
      res.set('Cache-Control', 'no-store, private');
      return res.json({ success: true, onboarding });
    } catch (error) {
      return sendStoreError(res, error, 'decideOnboarding');
    }
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

  // ── PATCH /api/users/me ───────────────────────────────────────────────────
  // Your own display name and phone number. No permission: a Support Agent may
  // correct the spelling of their own name without asking an Admin, and this
  // endpoint can change nothing else. Role, active state, permissions, email
  // and password all live behind their own handlers.
  //
  // MUST be registered before the parameterised PATCH handler further down.
  // Express matches in registration order and a `:id` pattern would happily
  // swallow the literal `me`. The policy table already resolves the literal
  // first, so such a request would arrive authorised as `permission: null` and
  // then be executed by the `user.manage` handler. It would fail closed —
  // parseUserId('me') is null and returns 400 — but "fails closed by accident"
  // is not a design.
  //
  // Do not spell the parameterised route out in a comment here. The audit-flag
  // check in test/route-policy.test.js locates a handler by searching this file
  // as TEXT, so a comment quoting `router.<verb>('/<param>')` is found before
  // the real handler and the audit coverage assertion reads the wrong body.
  router.patch('/me', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');

    // Two people share this identity. Neither of them gets to rename what the
    // other one sees, and the row is load-bearing at boot besides:
    // syncLegacySharedRole() exits the process if it cannot find it.
    if (actor.viaLegacySession || actor.isLegacyShared) {
      return fail(
        res, 409, 'LEGACY_USER_IMMUTABLE',
        'The shared team login is used by more than one person and cannot be renamed here. '
        + 'Ask an admin for your own account.'
      );
    }

    const patch = {};
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
    // Your own display time zone. This changes how YOU see timestamps and
    // nothing else.
    //
    // IT IS NOT THE BUSINESS TIME ZONE. Campaign quiet hours are enforced in
    // SQL against sms_campaign_settings.business_timezone, which is a property
    // of the business: the hours in which it is lawful and decent to text a
    // customer. If the two were ever read from one column, the Miami partner
    // switching his display to Europe/London would silently move the
    // quiet-hours window five hours and start texting American customers at
    // four in the morning. Two columns, two tables, two meanings, and nothing
    // that decides WHEN a customer is contacted may read this one.
    if (req.body?.timeZone !== undefined) {
      const problem = timeZonePatch(patch, req.body.timeZone);
      if (problem) return fail(res, problem.status, problem.code, problem.message);
    }
    if (Object.keys(patch).length === 0) {
      return fail(
        res, 400, 'NOTHING_TO_UPDATE',
        'Send displayName, phone, timeZone, or any combination. '
        + 'Your email address is changed with POST /api/users/me/email.'
      );
    }

    try {
      const row = await users.getById(actor.id);
      if (!row) return fail(res, 401, 'ACCOUNT_NOT_FOUND', 'Unauthorised');
      // Belt and braces. `actor.isLegacyShared` is derived from this same
      // column, but the check above reads a session-derived actor and this one
      // reads the row that is about to be written.
      if (row.is_legacy_shared) {
        return fail(
          res, 409, 'LEGACY_USER_IMMUTABLE',
          'The shared team login cannot be edited here.'
        );
      }

      // Read BEFORE the write, so the audit row can say what it changed from
      // and so a request that did not touch the zone still serialises the
      // current one. Fail-open; see readStoredTimeZone().
      const previousTimeZone = await readStoredTimeZone(actor.id);
      const previous = {
        display_name: row.display_name,
        phone: row.phone || null,
        timezone: previousTimeZone
      };
      const updated = await users.update(actor.id, patch);

      // users.update() selects a fixed column list that deliberately does not
      // include `timezone` (see getTimezone()), so the value is merged back in
      // here. When this request did not touch it, the pre-write read above is
      // still the current value.
      const timezone = 'timezone' in patch ? patch.timezone : previousTimeZone;

      // Nothing here changes what this person can do, so no session is revoked
      // and no epoch is bumped. A rename that signed somebody out mid-shift
      // would be a worse bug than the typo they were fixing, and the same is
      // true of a time zone: it is a rendering preference, not an authority.
      const changedFields = Object.keys(patch);
      const audited = await auditIfRegistered({
        eventType: PROFILE_UPDATED_EVENT,
        req,
        entityId: actor.id,
        summary: `${actorName(req)} updated their own profile (${changedFields.join(', ')})`,
        previousState: previous,
        newState: { display_name: updated.display_name, phone: updated.phone || null, timezone },
        changedFields,
        metadata: {
          user_id: actor.id,
          email: updated.email,
          role: updated.role,
          changed_fields: changedFields,
          via: 'self_service'
        }
      });

      return res.json({ user: publicUser({ ...updated, timezone }), audited: audited.audited });
    } catch (error) {
      // A write that failed because the column is absent gets its own answer.
      // Silently discarding somebody's choice and returning 200 would be worse
      // than refusing.
      if (isMissingTimezoneColumn(error)) return timeZoneUnavailable(res, error);
      return sendStoreError(res, error, 'updateOwnProfile');
    }
  });

  // ── POST /api/users/me/email ──────────────────────────────────────────────
  // Ask to move your account onto a different address. NOTHING CHANGES HERE.
  //
  // An email address is half a credential and the whole of an account-recovery
  // path, so an unconfirmed change is an account takeover: a borrowed session
  // becomes permanent ownership. The address only moves once somebody has
  // proven they can read mail at the new one, which is what
  // POST /auth/email-change/confirm is for.
  //
  // THIS ENDPOINT IS NOT AN ACCOUNT-EXISTENCE ORACLE. Any authenticated actor
  // can call it, including a Support Agent who cannot call GET /api/users, so a
  // 409 "that address already exists" would hand them a way to enumerate every
  // address in the workspace one guess at a time. Both branches therefore
  // return the same status, the same message and the same body shape:
  //
  //   available  -> confirmation link to the new address + heads-up to the old
  //   taken      -> "this address is already in use here" to the new address,
  //                 which is a real message to a real interested party,
  //                 + the same heads-up to the old
  //
  // Two sends either way, so `confirmationEmail`/`noticeEmail` report what
  // genuinely happened on both paths and neither is a lie. The remaining
  // difference is one INSERT, which is noise beside a provider round trip.
  router.post('/me/email', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    if (actor.viaLegacySession || actor.isLegacyShared) {
      return fail(
        res, 409, 'LEGACY_USER_IMMUTABLE',
        'The shared team login has no personal address. Ask an admin for your own account.'
      );
    }

    const newEmail = String(req.body?.newEmail || '').trim();
    const currentPassword = req.body?.currentPassword;
    if (!EMAIL_PATTERN.test(newEmail) || newEmail.length > 254) {
      return fail(res, 400, 'INVALID_EMAIL', 'Enter a valid email address.');
    }

    try {
      const row = await users.getById(actor.id);
      if (!row) return fail(res, 401, 'ACCOUNT_NOT_FOUND', 'Unauthorised');
      if (row.is_legacy_shared) {
        return fail(res, 409, 'LEGACY_USER_IMMUTABLE', 'The shared team login cannot change its address.');
      }
      if (!row.password_hash) {
        return fail(
          res, 400, 'PASSWORD_NOT_SET',
          'This account has no password yet, so there is nothing to check the request against. '
          + 'Ask an admin to send an invitation.'
        );
      }
      // The password is verified BEFORE the address is looked at, so a caller
      // who cannot prove who they are learns nothing about any address at all.
      // Reuses lib/password's verifier — the same one POST /me/password and
      // POST /auth/login use. A second implementation is a second place for a
      // timing bug to live.
      if (!(await verifyPassword(String(currentPassword ?? ''), row.password_hash))) {
        return fail(res, 401, 'CURRENT_PASSWORD_INCORRECT', 'That current password is not right.');
      }

      // Their own current address. Not a collision and not a secret from them,
      // so this one is answered plainly.
      if (String(row.email || '').toLowerCase() === newEmail.toLowerCase()) {
        return fail(res, 400, 'EMAIL_UNCHANGED', 'That is already your email address.');
      }

      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 3600 * 1000).toISOString();
      const taken = await users.emailIsTaken(newEmail, actor.id);

      let confirmationMessage;
      if (taken) {
        // No row, no token, no link. The message below tells the mailbox owner
        // what happened without telling the caller anything.
        confirmationMessage = emailChangeAddressInUseEmail({
          newEmail,
          workspaceName: WORKSPACE_NAME
        });
      } else {
        // Supersede any request already open for this person. The partial
        // unique index in scripts/email-change-migration.sql permits exactly
        // one, and the older link must stop working the moment a newer one is
        // issued — two live links to two different addresses is the state this
        // whole flow exists to prevent.
        await emailChanges.cancelOpenForUser(actor.id);

        const rawToken = generateToken();
        const tokenHash = hashToken(rawToken);
        const confirmUrl = confirmUrlFor(rawToken);
        if (!confirmUrl) {
          // With APP_URL unset there is no link to send, and a pending change
          // nobody can confirm is worse than no pending change: it blocks the
          // next attempt behind the partial unique index. Refuse before writing.
          console.error('[USERS] Refusing an email change: APP_URL is not set, so no confirmation link can be built');
          return fail(
            res, 503, 'EMAIL_CHANGE_UNAVAILABLE',
            'Email changes are not available on this server yet. Ask an admin to change it for you.'
          );
        }

        await emailChanges.create({
          user_id: actor.id,
          new_email: newEmail,
          // Only the digest. The raw token exists in `rawToken` for the length
          // of this handler and in the recipient's mailbox, nowhere else.
          token_hash: tokenHash,
          token_prefix: tokenHash.slice(0, TOKEN_PREFIX_LENGTH),
          expires_at: expiresAt,
          requested_ip: req.ip || null,
          requested_user_agent: (req.get ? req.get('user-agent') : null) || null
        });

        confirmationMessage = emailChangeConfirmationEmail({
          recipientName: row.display_name,
          newEmail,
          confirmUrl,
          expiresAt,
          workspaceName: WORKSPACE_NAME
        });
      }

      // To the NEW address. Carries the live link on the available path and no
      // link at all on the taken path.
      const confirmationEmail = await deliverMessage(send, confirmationMessage, newEmail);
      // To the OLD address, always, on both paths. This is the message that
      // makes a hijack visible to the person being hijacked, so it is sent even
      // when the request went nowhere.
      const noticeEmail = await deliverMessage(send, emailChangeNoticeEmail({
        recipientName: row.display_name,
        newEmail,
        expiresAt,
        workspaceName: WORKSPACE_NAME
      }), row.email);

      // Recorded even though nothing has changed yet, and recorded on BOTH
      // branches. An attempt that is never confirmed is precisely the case
      // worth having: a hijacker on a borrowed session requests a move to their
      // own address, the victim ignores the heads-up email, and without this
      // there is no trace anywhere that it happened. The audit log is
      // Admin-only, so recording which branch ran leaks nothing to the caller.
      const audited = await auditIfRegistered({
        eventType: EMAIL_CHANGE_REQUESTED_EVENT,
        req,
        entityId: String(actor.id),
        summary: `${actorName(req)} asked to move their account to a different email address`,
        metadata: {
          user_id: actor.id,
          email: actor.email,
          requested_email: newEmail,
          via: 'self',
          address_available: !taken
        }
      });

      return res.json({
        success: true,
        // Identical on both branches, by design. See the header comment.
        message: 'If that address can be used, a confirmation link is on its way to it. '
          + 'Nothing changes on your account until that link is opened.',
        expiresInHours: EMAIL_CHANGE_TTL_HOURS,
        // Honest, and honest on both paths: two messages are attempted either
        // way, so reporting the truth about each cannot reveal which path ran.
        confirmationEmail,
        noticeEmail,
        audited: audited.audited === true
      });
    } catch (error) {
      return sendStoreError(res, error, 'requestEmailChange');
    }
  });

  // ── POST /api/users/me/email/cancel ───────────────────────────────────────
  // Abandon an open request. Deliberately idempotent and deliberately silent
  // about whether there was one: the same 200 either way, so this cannot be
  // used to probe whether somebody has a change in flight.
  router.post('/me/email/cancel', async (req, res) => {
    const actor = req.actor;
    if (!actor) return fail(res, 401, 'NO_ACTOR', 'Unauthorised');
    if (actor.viaLegacySession || actor.isLegacyShared) {
      return fail(
        res, 409, 'LEGACY_USER_IMMUTABLE',
        'The shared team login has no personal address.'
      );
    }

    try {
      const cancelled = await emailChanges.cancelOpenForUser(actor.id);
      return res.json({
        success: true,
        cancelled: cancelled > 0,
        message: cancelled > 0
          ? 'That email change was cancelled. The confirmation link no longer works.'
          : 'There was no email change waiting to be confirmed.'
      });
    } catch (error) {
      return sendStoreError(res, error, 'cancelEmailChange');
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

      // Setting somebody else's DISPLAY time zone. Reaching this handler at all
      // requires `user.manage`, which is Owner and Admin.
      //
      // It is NOT session-affecting. It changes how one person's client renders
      // a timestamp and nothing about what they may do, so ending their
      // sessions over it would be gratuitous.
      //
      // It is NOT the business time zone. Campaign quiet hours are enforced in
      // SQL against sms_campaign_settings.business_timezone, and an Owner
      // editing a teammate's profile here must never move the window in which
      // customers are textable. Two columns, two tables, two meanings.
      //
      // The peer-Owner guard applies for the same reason it applies to an
      // address: an Owner does not get to reach into another Owner's account
      // and change what they see.
      if (req.body?.timeZone !== undefined) {
        const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
        if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);
        const problem = timeZonePatch(patch, req.body.timeZone);
        if (problem) return fail(res, problem.status, problem.code, problem.message);
      }

      // An Admin correcting somebody else's address does NOT go through the
      // confirmation dance. It is an administrative correction — usually a typo
      // that is stopping an invitation from arriving — and requiring the person
      // to confirm from a mailbox they cannot reach would make the one case
      // this exists for impossible.
      //
      // What it does NOT skip: this is still an identity change, so it bumps
      // the session epoch, it is audited, and BOTH addresses are told. The
      // person losing the address finds out even if they never touch the app
      // again, which is the only defence against an Admin quietly moving an
      // account onto an address they control.
      //
      // No enumeration concern here, unlike the self-service path: reaching
      // this handler at all requires `user.manage`, and anybody holding it can
      // simply call GET /api/users and read every address in the workspace.
      if (req.body?.email !== undefined) {
        const nextEmail = String(req.body.email).trim();
        if (!EMAIL_PATTERN.test(nextEmail) || nextEmail.length > 254) {
          return fail(res, 400, 'INVALID_EMAIL', 'Enter a valid email address.');
        }
        // The peer-Owner guard applies to an address exactly as it applies to a
        // role: moving an Owner onto an address you control is a takeover with
        // extra steps. Checked before the collision lookup so a refused request
        // cannot be used to probe the address book either.
        const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
        if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);

        if (nextEmail.toLowerCase() !== String(targetEmail || '').toLowerCase()) {
          if (await users.emailIsTaken(nextEmail, id)) {
            return fail(res, 409, 'EMAIL_ALREADY_EXISTS', 'Somebody already has that email address.');
          }
          patch.email = nextEmail;
          sessionAffecting = true;
        }
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

      // Read before the write, so the audit row can say what it changed from
      // and so a request that did not touch the zone still serialises the
      // current one. Fail-open; see readStoredTimeZone().
      const previousTimeZone = await readStoredTimeZone(id);
      const updated = Object.keys(patch).length > 0 ? await users.update(id, patch) : target;
      const timezone = 'timezone' in patch ? patch.timezone : previousTimeZone;
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

      // An administrative time-zone change. Recorded because somebody's view of
      // every timestamp in the product just moved and they did not ask for it:
      // without a row, "why does my Activity Center suddenly read New York
      // time?" has no answer anywhere. Not session-affecting, and deliberately
      // its own row rather than folded into any above, which answer different
      // questions.
      if ('timezone' in patch && timezone !== previousTimeZone) {
        await auditIfRegistered({
          eventType: PROFILE_UPDATED_EVENT,
          req,
          entityId: id,
          summary: `${actorName(req)} set the display time zone for ${targetName} to `
            + `${timezone || 'the workspace default'}`,
          previousState: { timezone: previousTimeZone },
          newState: { timezone },
          changedFields: ['timezone'],
          metadata: {
            user_id: id,
            email: targetEmail,
            role: previousRole,
            changed_fields: ['timezone'],
            via: 'admin_correction'
          }
        });
      }

      // An address change has three consequences beyond the row itself, and all
      // three run only once the write has landed.
      let emailNotifications;
      if (patch.email) {
        // 1. Any self-service request this person had in flight is void. Their
        //    pending link points at an address that is no longer theirs to move
        //    from, and leaving it open would let it fire later and undo an
        //    administrative correction nobody would think to re-check.
        try {
          await emailChanges.cancelOpenForUser(id);
        } catch (error) {
          console.warn('[USERS] Could not cancel a pending self-service email change:', error?.code || 'unknown');
        }

        // 2. Both mailboxes are told. The old address is the one that matters:
        //    it is the only warning the person gets if this was not legitimate.
        const message = emailChangedByAdminEmail({
          recipientName: updated.display_name || targetName,
          previousEmail: targetEmail,
          newEmail: patch.email,
          actorName: actorName(req),
          workspaceName: WORKSPACE_NAME
        });
        emailNotifications = {
          previousAddress: await deliverMessage(send, message, targetEmail),
          newAddress: await deliverMessage(send, message, patch.email)
        };

        // 3. Audited as `team.member.email_changed` with via: 'admin_correction'
        //    and confirmed: false, so the Activity Center can tell an
        //    administrative correction apart from an address its owner proved
        //    control of.
        await auditIfRegistered({
          eventType: EMAIL_CHANGED_EVENT,
          req,
          entityId: id,
          summary: `${actorName(req)} changed the email address for ${targetName} and ended their sessions`,
          previousState: { email: targetEmail },
          newState: { email: patch.email },
          changedFields: ['email'],
          metadata: {
            user_id: id,
            email: patch.email,
            previous_email: targetEmail,
            role: previousRole,
            via: 'admin_correction',
            confirmed: false,
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

      return res.json({
        user: publicUser({ ...updated, timezone }),
        sessionsRevoked: sessionAffecting,
        // Present only when an address moved, and honest about each recipient.
        // An admin who is told "changed" but not "and we could not tell them"
        // has no way to know they need to pick up the phone.
        ...(emailNotifications ? { emailNotifications } : {})
      });
    } catch (error) {
      if (isMissingTimezoneColumn(error)) return timeZoneUnavailable(res, error);
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
      // Ending their sessions is not enough on its own. Push registrations live
      // outside the session, so without this a removed teammate's iPhone keeps
      // showing customer messages, sender name and preview included, until the
      // APNs token expires or they delete the app. lib/apns-notify.js also
      // filters deactivated owners at delivery; this removes the registration
      // so the device stops being a recipient rather than being skipped forever.
      const devicesRevoked = await users.revokePushDevices(id);

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

      return res.json({
        user: publicUser(updated),
        sessionsRevoked: true,
        devicesRevoked
      });
    } catch (error) {
      return sendStoreError(res, error, 'deactivate');
    }
  });

  // ── POST /api/users/:id/reactivate ────────────────────────────────────────
  // The counterpart to /deactivate, and the reason removal is a deactivation
  // rather than a delete: the owner's instruction was "deactivate, keep
  // history", explicitly so the Activity Center keeps reading "Sarah cancelled
  // Payment Reminder" instead of "Unknown". Rows are never deleted, so bringing
  // somebody back is a single flag and their whole history is still attributed
  // to them.
  //
  // PATCH /api/users/:id with `{ isActive: true }` already does this and keeps
  // working; it is how the existing iOS build reactivates. This exists so that
  // the pair reads symmetrically — /deactivate has a sibling — and so a client
  // does not have to know that `isActive: false` is refused while
  // `isActive: true` is not. Both paths run the same guards and write the same
  // `team.member.reactivated` row.
  router.post('/:id/reactivate', async (req, res) => {
    const actor = req.actor;
    const id = parseUserId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_USER_ID', 'That user id is not valid.');

    try {
      const target = await users.getById(id);
      if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'No such user.');
      if (target.is_legacy_shared) {
        return fail(
          res, 409, 'LEGACY_USER_IMMUTABLE',
          'The shared team login cannot be reactivated here. Set LEGACY_SHARED_LOGIN=enabled instead.'
        );
      }

      // Snapshotted before anything mutates, for the same reason every other
      // handler in this file does it: users.update() may hand back the very
      // object `target` points at.
      const previousRole = target.role;
      const targetName = target.display_name || target.email;
      const targetEmail = target.email;

      // Restoring an authority-bearing sign-in is the same class of action as
      // revoking one, so it carries the same two guards. Note the consequence,
      // which PATCH already documents: a deactivated Owner cannot be brought
      // back by another Owner. One can no longer be created through this API,
      // so this only guards rows that predate the guard, and the remedy for
      // those is a deliberate database change rather than a mis-click.
      const ownerProblem = ownerTransitionError(actor, { fromRole: previousRole, toRole: previousRole });
      if (ownerProblem) {
        return fail(res, ownerProblem.status, ownerProblem.code, 'Only an Owner may reactivate an Owner.');
      }
      const peerProblem = peerOwnerError(actor, { id: target.id, role: previousRole });
      if (peerProblem) return fail(res, peerProblem.status, peerProblem.code, peerProblem.message);

      if (target.is_active === true) {
        return res.json({ user: publicUser(target), alreadyActive: true });
      }

      // `deactivated_at: null` is not optional. sms_users carries
      // CHECK (is_active = (deactivated_at IS NULL)), so setting one without
      // the other is a constraint violation, not a partially applied change.
      const updated = await users.update(id, { is_active: true, deactivated_at: null });
      // Their sessions were already revoked when they were deactivated. This
      // bump is for the cached permission set: auth.invalidate() runs with it,
      // and a stale cache would otherwise keep answering for the TTL.
      await revokeSessions(id);

      const roleDisplay = await createRoleNamer(users)(previousRole);
      await auditIfRegistered({
        eventType: 'team.member.reactivated',
        req,
        entityId: id,
        summary: `${actorName(req)} reactivated ${targetName} as ${roleDisplay}`,
        previousState: { is_active: false },
        newState: { is_active: true },
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
      return sendStoreError(res, error, 'reactivate');
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
module.exports.createEmailChangeStore = createEmailChangeStore;
module.exports.publicUser = publicUser;
module.exports.publicOnboarding = publicOnboarding;
module.exports.confirmationErrorFrom = confirmationErrorFrom;
module.exports.confirmUrlFor = confirmUrlFor;
module.exports.ADMINISTRATIVE_ROLES = ADMINISTRATIVE_ROLES;
module.exports.CONFIRMATION_ERRORS = CONFIRMATION_ERRORS;
module.exports.EMAIL_CHANGE_TTL_HOURS = EMAIL_CHANGE_TTL_HOURS;
module.exports.EMAIL_CHANGED_EVENT = EMAIL_CHANGED_EVENT;
module.exports.PROFILE_UPDATED_EVENT = PROFILE_UPDATED_EVENT;
