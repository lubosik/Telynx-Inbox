'use strict';
/**
 * routes/invitations.js — invite a named person to the inbox.
 *
 *   GET  /api/invitations             user.read
 *   POST /api/invitations             user.manage
 *   POST /api/invitations/:id/revoke  user.manage
 *
 * Acceptance itself is POST /auth/invitation/accept, which must be public
 * because the invitee has no session yet. It is token-bearing, and the token
 * is the only credential it accepts.
 *
 * TOKEN HANDLING
 *   The raw token is generated with crypto.randomBytes(32), returned to the
 *   inviting Admin EXACTLY ONCE in the creation response, and then discarded.
 *   What is stored is its sha256 hex plus an 8-character prefix OF THAT HASH,
 *   never of the token itself. No substring of the live secret is written
 *   anywhere, so a database dump hands over neither a working invitation nor a
 *   head start on guessing one. Invitations are identified in the UI by email
 *   address; the prefix is only there to tell two hashes apart in a log line.
 *   There is no email sender in this service, so the Admin passes the link
 *   along themselves; the response says so rather than letting them assume an
 *   email went out.
 *
 * CONCURRENCY
 *   Redemption goes through the redeem_sms_invitation SQL function, which does
 *   SELECT ... FOR UPDATE and then inserts and marks accepted in one
 *   transaction. Two simultaneous redemptions of the same token therefore
 *   yield exactly one new user; the loser sees INVITATION_USED. Do not
 *   reimplement this as read-then-write in Node — that race is precisely what
 *   the function exists to remove.
 *
 * AUDIT
 *   Inviting somebody, revoking that invitation, and the invitation being
 *   redeemed are all access grants, so all three write a `team.*` row.
 *
 *   NOTHING TOKEN-SHAPED GOES IN. Not the raw token, not its sha256, and not
 *   `token_prefix` — which is a prefix of that sha256, and therefore a head
 *   start on a live credential that would sit permanently in a table with
 *   REVOKE DELETE. Invitations are identified in an audit row by their id and
 *   the invitee's email address, which is how the UI identifies them anyway.
 *   The metadata allowlists in lib/audit/redact.js omit every token key, and
 *   SECRET_KEY_PATTERN drops them a second time.
 */

const express = require('express');
const crypto = require('crypto');
const { logAuditSafely } = require('../lib/audit/log');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 8;
const DEFAULT_TTL_HOURS = 168; // 7 days
const MAX_TTL_HOURS = 720;     // 30 days

/** Deterministic, so the accept path can look a token up without storing it. */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Maps the SQL function's RAISE messages onto HTTP. */
const REDEMPTION_ERRORS = Object.freeze({
  INVITATION_NOT_FOUND: { status: 404, message: 'That invitation link is not valid.' },
  INVITATION_REVOKED:   { status: 409, message: 'That invitation was revoked.' },
  INVITATION_USED:      { status: 409, message: 'That invitation has already been used.' },
  INVITATION_EXPIRED:   { status: 410, message: 'That invitation has expired. Ask for a new one.' }
});

function redemptionErrorFrom(error) {
  const message = String(error?.message || '');
  for (const code of Object.keys(REDEMPTION_ERRORS)) {
    if (message.includes(code)) return { code, ...REDEMPTION_ERRORS[code] };
  }
  return null;
}

/**
 * One `team.member.activated` row for a redeemed invitation.
 *
 * Entirely wrapped: an account has just been created inside a committed SQL
 * transaction by the time this runs, so nothing here may throw. A failure
 * degrades to a warning and a missing audit row, never to an invitee who
 * cannot finish signing up.
 *
 * The invitation is looked up by token_hash because that is the only handle
 * the caller has. The hash is used as a filter and discarded; neither it nor
 * token_prefix is written to the audit row.
 *
 * `req` is passed even though the actor is set explicitly. It is NOT redundant:
 * `resolveActor` in lib/audit/log.js prefers `input.actor` over `req.actor`, so
 * the explicit invitee actor still wins, while `clientIP`, `clientUserAgent`
 * and `requestID` read `req` and nothing else. Without it, the single row
 * recording the creation of a new sign-in identity carries no IP, no
 * user-agent and no request id — the three fields that make "who activated
 * this account, from where?" answerable, and the ones most likely to matter if
 * an invitation link is ever redeemed by someone it was not sent to.
 *
 * @param {object} client
 * @param {number|string} userId
 * @param {string} tokenHash
 * @param {object} [req]  the Express request that redeemed the invitation
 */
async function auditRedemption(client, userId, tokenHash, req) {
  try {
    const found = await client
      .from('sms_invitations')
      .select('id, email, display_name, role_key')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (found.error) throw new Error(found.error.message);
    const invitation = found.data;
    if (!invitation) return;

    let roleDisplay = invitation.role_key;
    const role = await client
      .from('sms_roles')
      .select('key, display_name')
      .eq('key', invitation.role_key)
      .maybeSingle();
    if (!role.error && role.data?.display_name) roleDisplay = role.data.display_name;

    await logAuditSafely({
      // The invitee is the actor: they redeemed the token. The inviting Admin
      // is already recorded on the team.member.invited row. `req` supplies the
      // IP, user-agent and request id only; resolveActor prefers this explicit
      // `actor` over `req.actor`, so the two cannot conflict.
      actor: { type: 'user', id: userId, displayName: invitation.display_name || invitation.email, role: invitation.role_key },
      req,
      eventType: 'team.member.activated',
      entityId: userId,
      summary: `${invitation.display_name || invitation.email} accepted their invitation and activated an account as ${roleDisplay}`,
      newState: { role: invitation.role_key, is_active: true, can_sign_in: true },
      metadata: {
        user_id: userId,
        email: invitation.email,
        role: invitation.role_key,
        role_display_name: roleDisplay,
        via: 'invitation',
        invitation_id: invitation.id,
        can_sign_in: true
      }
    });
  } catch (error) {
    console.warn('[INVITE] Redemption not audited:', error?.code || error?.message || 'unknown');
  }
}

function createInvitationStore({ client } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../db').supabase;
    return injected;
  }

  function unwrap(result, context) {
    if (result.error) {
      throw Object.assign(new Error(result.error.message), { code: 'INVITATION_STORE_FAILED', context });
    }
    return result.data;
  }

  return {
    async list() {
      // token_hash is deliberately NOT selected. Nothing outside the accept
      // path ever needs it, and a list endpoint is the easiest place to leak.
      return unwrap(
        await db()
          .from('sms_invitations')
          .select('id, email, display_name, phone, role_key, token_prefix, invited_by, invited_at, expires_at, accepted_at, accepted_user_id, revoked_at, revoked_by, attempt_count')
          .order('invited_at', { ascending: false })
          .limit(200),
        'list'
      ) || [];
    },

    async getById(id) {
      return unwrap(
        await db()
          .from('sms_invitations')
          .select('id, email, display_name, role_key, token_prefix, invited_at, expires_at, accepted_at, revoked_at')
          .eq('id', id)
          .maybeSingle(),
        'getById'
      );
    },

    async findOpenByEmail(email) {
      const escaped = String(email).replace(/([\\%_])/g, '\\$1');
      const rows = unwrap(
        await db()
          .from('sms_invitations')
          .select('id, email, expires_at')
          .ilike('email', escaped)
          .is('accepted_at', null)
          .is('revoked_at', null)
          .limit(1),
        'findOpenByEmail'
      );
      return (rows && rows[0]) || null;
    },

    async create(row) {
      return unwrap(
        await db()
          .from('sms_invitations')
          .insert(row)
          .select('id, email, display_name, phone, role_key, token_prefix, invited_at, expires_at')
          .single(),
        'create'
      );
    },

    async revoke(id, revokedBy) {
      return unwrap(
        await db()
          .from('sms_invitations')
          .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy ?? null })
          .eq('id', id)
          .select('id, email, revoked_at')
          .single(),
        'revoke'
      );
    },

    /**
     * @param {string} tokenHash
     * @param {string} passwordHash
     * @param {object} [req]  the Express request, forwarded to the audit row
     *   for its IP, user-agent and request id. Optional so existing callers and
     *   tests keep working, but every HTTP caller should pass it.
     * @returns {Promise<number>} the id of the newly created user
     */
    async redeem(tokenHash, passwordHash, req) {
      const result = await db().rpc('redeem_sms_invitation', {
        p_token_hash: tokenHash,
        p_password_hash: passwordHash
      });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'INVITATION_REDEEM_FAILED' });
      }
      const userId = result.data;
      // Audited here, in the store, rather than at POST /auth/invitation/accept
      // in routes/auth.js. Redemption is the moment a new identity becomes able
      // to sign in, and this is the only seam that observes it.
      //
      // The request IS worth capturing, contrary to what this comment used to
      // claim. It is unauthenticated, so `req.actor` is absent and the actor is
      // set explicitly below — but the IP, user-agent and request id are the
      // only evidence of WHERE a new sign-in identity was activated from, and
      // an unauthenticated endpoint is exactly where that matters most.
      await auditRedemption(db(), userId, tokenHash, req);
      return userId;
    },

    /**
     * Best-effort attempt counter. The redeem function raises, which rolls its
     * own transaction back, so a failed attempt cannot increment from inside
     * it. This runs separately and is allowed to fail silently-with-a-warning:
     * sms_auth_events is the audit trail that matters.
     */
    async noteAttempt(tokenHash) {
      try {
        const found = await db()
          .from('sms_invitations')
          .select('id, attempt_count')
          .eq('token_hash', tokenHash)
          .maybeSingle();
        if (found.error || !found.data) return;
        const bumped = await db()
          .from('sms_invitations')
          .update({ attempt_count: (found.data.attempt_count || 0) + 1 })
          .eq('id', found.data.id);
        if (bumped.error) console.warn('[INVITE] attempt_count not recorded:', bumped.error.message);
      } catch (err) {
        console.warn('[INVITE] attempt_count not recorded:', err.message);
      }
    }
  };
}

function publicInvitation(row) {
  if (!row) return null;
  const status = row.revoked_at ? 'revoked'
    : row.accepted_at ? 'accepted'
      : (new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'open');
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    phone: row.phone || null,
    role: row.role_key,
    tokenPrefix: row.token_prefix,
    status,
    invitedBy: row.invited_by ?? null,
    invitedAt: row.invited_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at || null,
    revokedAt: row.revoked_at || null,
    attemptCount: row.attempt_count ?? 0
  };
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

function sendStoreError(res, error, label) {
  console.error(`[INVITE] ${label} failed:`, error?.code || 'internal_error', error?.context || '');
  return fail(res, 500, 'INVITATION_REQUEST_FAILED', 'That invitation could not be processed.');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name an audit summary should call whoever made the request. */
function actorName(req) {
  return req?.actor?.displayName || req?.actor?.name || 'Team';
}

/**
 * @param {{store?: object, userStore?: object, now?: () => number, audit?: Function}} [options]
 */
function createInvitationsRouter({ store, userStore, now = () => Date.now(), audit } = {}) {
  const invitations = store || createInvitationStore({});
  const users = userStore || require('./users').createUserStore({});
  // Injectable so the unit tests can assert on the rows without a database.
  // The default can never throw; see lib/audit/log.js.
  const logAudit = audit || logAuditSafely;
  const router = express.Router();

  // ── GET /api/invitations ──────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const rows = await invitations.list();
      res.set('Cache-Control', 'no-store, private');
      return res.json({ invitations: rows.map(publicInvitation) });
    } catch (error) {
      return sendStoreError(res, error, 'list');
    }
  });

  // ── POST /api/invitations ─────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    const actor = req.actor;
    const email = String(req.body?.email || '').trim();
    const displayName = String(req.body?.displayName || '').trim();
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;
    const role = String(req.body?.role || 'agent').trim();

    if (!EMAIL_PATTERN.test(email)) return fail(res, 400, 'INVALID_EMAIL', 'Enter a valid email address.');
    if (displayName.length < 1 || displayName.length > 120) {
      return fail(res, 400, 'INVALID_DISPLAY_NAME', 'Enter a name between 1 and 120 characters.');
    }

    let ttlHours = Number(req.body?.expiresInHours ?? DEFAULT_TTL_HOURS);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > MAX_TTL_HOURS) {
      return fail(res, 400, 'INVALID_EXPIRY', `An invitation may last between 1 and ${MAX_TTL_HOURS} hours.`);
    }

    try {
      const roles = await users.listRoles();
      const roleRow = roles.find(entry => entry.key === role);
      if (!roleRow || roleRow.is_assignable !== true) {
        return fail(res, 400, 'ROLE_NOT_ASSIGNABLE', 'That role cannot be assigned to a person.');
      }
      if (role === 'owner' && !actor.permissions.has('user.manage.owner')) {
        return fail(res, 403, 'OWNER_ROLE_REQUIRES_OWNER', 'Only an Owner may invite another Owner.');
      }
      if (await users.findByEmail(email)) {
        return fail(res, 409, 'EMAIL_ALREADY_EXISTS', 'Somebody already has that email address.');
      }
      if (await invitations.findOpenByEmail(email)) {
        return fail(
          res, 409, 'INVITATION_ALREADY_OPEN',
          'There is already an open invitation for that address. Revoke it first.'
        );
      }

      const rawToken = generateToken();
      const created = await invitations.create({
        email,
        display_name: displayName,
        phone,
        role_key: role,
        token_hash: hashToken(rawToken),
        token_prefix: hashToken(rawToken).slice(0, TOKEN_PREFIX_LENGTH),
        invited_by: actor?.id ?? null,
        expires_at: new Date(now() + ttlHours * 3600 * 1000).toISOString()
      });

      // Written after the row exists, and safe-logged: the invitation is live
      // by this point, and the raw token below is shown exactly once, so a
      // throw here would destroy a working credential nobody has seen yet.
      await logAudit({
        eventType: 'team.member.invited',
        req,
        entityId: created.id,
        summary: `${actorName(req)} invited ${email} to join as ${roleRow.display_name || role}, expiring ${new Date(created.expires_at).toISOString()}`,
        metadata: {
          invitation_id: created.id,
          email,
          role,
          role_display_name: roleRow.display_name || role,
          expires_at: created.expires_at,
          ttl_hours: ttlHours
        }
      });

      const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
      return res.status(201).json({
        invitation: publicInvitation(created),
        // Shown once. Not stored, not logged, not recoverable.
        token: rawToken,
        acceptUrl: base ? `${base}/accept-invite?token=${encodeURIComponent(rawToken)}` : null,
        acceptEndpoint: 'POST /auth/invitation/accept { token, password }',
        note: 'This token is shown once and is not recoverable. No email is sent from this service — pass the link to them over a channel you trust.'
      });
    } catch (error) {
      // The partial unique index is the real guarantee; this is the friendly
      // face of it when two admins invite the same person at the same moment.
      if (/duplicate key|unique constraint/i.test(error?.message || '')) {
        return fail(res, 409, 'INVITATION_ALREADY_OPEN', 'There is already an open invitation for that address.');
      }
      return sendStoreError(res, error, 'create');
    }
  });

  // ── POST /api/invitations/:id/revoke ──────────────────────────────────────
  router.post('/:id/revoke', async (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_PATTERN.test(id)) return fail(res, 400, 'INVALID_INVITATION_ID', 'That invitation id is not valid.');

    try {
      const existing = await invitations.getById(id);
      if (!existing) return fail(res, 404, 'INVITATION_NOT_FOUND', 'No such invitation.');
      if (existing.accepted_at) {
        return fail(
          res, 409, 'INVITATION_USED',
          'That invitation was already accepted. Deactivate the account instead.'
        );
      }
      if (existing.revoked_at) {
        return res.json({ success: true, alreadyRevoked: true });
      }
      const revoked = await invitations.revoke(id, req.actor?.id ?? null);

      let roleDisplay = existing.role_key;
      try {
        const roles = await users.listRoles();
        roleDisplay = roles.find(entry => entry.key === existing.role_key)?.display_name || existing.role_key;
      } catch (error) {
        // A summary that says 'agent' beats an audit row that was never
        // written because the role catalogue was briefly unreadable.
        console.warn('[INVITE] Role catalogue unavailable for an audit summary:', error?.code || error?.message || 'unknown');
      }

      await logAudit({
        eventType: 'team.invitation.revoked',
        req,
        entityId: existing.id,
        summary: `${actorName(req)} revoked the unused invitation for ${existing.email} (${roleDisplay})`,
        previousState: { invitation_status: 'open' },
        newState: { invitation_status: 'revoked' },
        changedFields: ['invitation_status'],
        metadata: {
          invitation_id: existing.id,
          email: existing.email,
          role: existing.role_key,
          role_display_name: roleDisplay,
          invitation_status: 'revoked'
        }
      });

      return res.json({ success: true, invitationId: revoked.id, revokedAt: revoked.revoked_at });
    } catch (error) {
      return sendStoreError(res, error, 'revoke');
    }
  });

  return router;
}

module.exports = createInvitationsRouter;
module.exports.createInvitationStore = createInvitationStore;
module.exports.publicInvitation = publicInvitation;
module.exports.hashToken = hashToken;
module.exports.generateToken = generateToken;
module.exports.redemptionErrorFrom = redemptionErrorFrom;
module.exports.REDEMPTION_ERRORS = REDEMPTION_ERRORS;
module.exports.TOKEN_PREFIX_LENGTH = TOKEN_PREFIX_LENGTH;
