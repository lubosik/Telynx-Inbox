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
 *
 * EMAIL
 *   The invitation is now emailed to the invitee through lib/email.js, which
 *   sends via Maton's authorised Gmail connection as support@vicipeptides.com.
 *   That
 *   send is BEST-EFFORT and strictly after the row is committed: the token is
 *   shown exactly once, so a mail failure that rolled the request back would
 *   destroy a working credential nobody had seen. The response therefore always
 *   carries the link, and `emailSent` / `emailReason` say plainly whether the
 *   message actually left. It must never claim a send that did not happen —
 *   with no MATON_API_KEY configured, which is the state on deploy day, every
 *   response says `emailSent: false, emailReason: 'not_configured'` and the
 *   admin passes the link on by hand exactly as before.
 *
 *   A RESEND CANNOT REBUILD A LINK. Only the sha256 of the token is stored, by
 *   design, so POST /api/invitations/:id/resend can only mail a link the caller
 *   hands back to it. See the handler for why that is not a workaround.
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
const { sendEmail, appUrl, isEmailConfigured } = require('../lib/email');
const { invitationEmail } = require('../lib/email-templates');

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

    /**
     * Does `rawTokenHash` belong to invitation `id`?
     *
     * Deliberately a predicate rather than a getter. `getById` does not select
     * `token_hash` and must not start to: a resend handler that could READ the
     * stored hash would be one refactor away from putting it in a response or a
     * log. This compares server-side and returns a boolean, so the hash never
     * enters this process's memory as a value anybody can pass on.
     */
    async matchesToken(id, tokenHash) {
      const rows = unwrap(
        await db()
          .from('sms_invitations')
          .select('id')
          .eq('id', id)
          .eq('token_hash', tokenHash)
          .limit(1),
        'matchesToken'
      );
      return Array.isArray(rows) && rows.length === 1;
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

      // The email is echoed back so the accept-invite page can hand it to the
      // sign-in form. Without it the invitee is told "account created" and then
      // asked to remember which address they were invited on — the one piece of
      // information they are least likely to have to hand, in the one flow
      // where they have no account to recover from. Best-effort: a failure here
      // must not undo a redemption that has already committed.
      let email = null;
      try {
        const row = await db()
          .from('sms_users')
          .select('email')
          .eq('id', userId)
          .maybeSingle();
        if (!row.error) email = row.data?.email || null;
      } catch (err) {
        console.warn('[INVITE] Could not read the email for the accepted invitation:', err.message);
      }

      return { userId, email };
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
 * The workspace as a person should read it. Not configurable: it is the product
 * name, it appears in a subject line, and an env var here would be one more
 * thing to get wrong on a deploy for no benefit.
 */
const WORKSPACE_NAME = 'Vici Inbox';

/** ${APP_URL}/accept-invite?token=... , or null when APP_URL is unset. */
function acceptUrlFor(rawToken) {
  const base = appUrl();
  return base ? `${base}/accept-invite?token=${encodeURIComponent(rawToken)}` : null;
}

/**
 * Build and send one invitation email.
 *
 * Resolves to the shape the HTTP response reports verbatim. It cannot throw:
 * lib/email.js does not, and the template is pure. Callers therefore need no
 * try/catch and, more importantly, cannot accidentally turn a mail problem
 * into a failed invitation.
 *
 * The `no_app_url` case is real and worth its own reason rather than a generic
 * failure: with APP_URL unset there is no link to put in the message, and an
 * invitation email with no way to accept it is worse than no email at all.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendInvitationEmail(invitation, { rawToken, inviterName, roleDisplayName, isResend = false, send = sendEmail } = {}) {
  const acceptUrl = acceptUrlFor(rawToken);
  if (!acceptUrl) {
    console.warn('[INVITE] Not emailing an invitation: APP_URL is not set, so the accept link cannot be built');
    return { sent: false, reason: 'no_app_url' };
  }

  const message = invitationEmail({
    inviteeName: invitation.display_name,
    inviterName,
    workspaceName: WORKSPACE_NAME,
    roleKey: invitation.role_key,
    roleDisplayName,
    acceptUrl,
    expiresAt: invitation.expires_at,
    isResend
  });

  // `message` holds a live credential inside `text`/`html`. It is handed
  // straight to the provider and never logged, here or in lib/email.js.
  const result = await send({
    to: invitation.email,
    subject: message.subject,
    text: message.text,
    html: message.html
  });
  return { sent: result.sent === true, reason: result.sent === true ? undefined : (result.reason || 'unknown') };
}

/**
 * @param {{
 *   store?: object,
 *   userStore?: object,
 *   now?: () => number,
 *   audit?: Function,
 *   sendMail?: Function,
 *   emailConfigured?: () => boolean
 * }} [options]
 */
function createInvitationsRouter({
  store,
  userStore,
  now = () => Date.now(),
  audit,
  sendMail,
  emailConfigured
} = {}) {
  const invitations = store || createInvitationStore({});
  const users = userStore || require('./users').createUserStore({});
  // Injectable so the unit tests can assert on the rows without a database.
  // The default can never throw; see lib/audit/log.js.
  const logAudit = audit || logAuditSafely;
  // Injectable for the same reason, and for one more: a test must be able to
  // drive a provider failure without a network and without setting credentials
  // into process.env. The default can never throw either; see lib/email.js.
  const mail = sendMail || sendEmail;
  const mailConfigured = emailConfigured || isEmailConfigured;
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

      // Best-effort, and deliberately last. The row is committed and the audit
      // written by this point, so the worst a mail failure can do is cost the
      // admin a copy and paste. It is awaited rather than fired and forgotten
      // because the response has to tell the truth about what happened, and a
      // floating promise would have the handler guess.
      const delivery = await sendInvitationEmail(created, {
        rawToken,
        inviterName: actorName(req),
        roleDisplayName: roleRow.display_name || role,
        send: mail
      });

      return res.status(201).json({
        invitation: publicInvitation(created),
        // Shown once. Not stored, not logged, not recoverable.
        token: rawToken,
        acceptUrl: acceptUrlFor(rawToken),
        acceptEndpoint: 'POST /auth/invitation/accept { token, password }',
        // The UI branches on this to choose between "we emailed them" and
        // "copy this link and send it yourself". It is never optimistic:
        // `true` means the provider accepted the message.
        emailSent: delivery.sent,
        emailReason: delivery.sent ? null : delivery.reason,
        note: delivery.sent
          ? `An invitation email was sent to ${email}. This token is shown once and is not recoverable; keep the link until they accept, because it cannot be re-sent without it.`
          : 'No email was sent. This token is shown once and is not recoverable — pass the link to them over a channel you trust.'
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

  // ── POST /api/invitations/:id/resend ──────────────────────────────────────
  /**
   * Email an OPEN invitation again. It mints nothing and extends nothing: the
   * stored row is not written to at all, so the token and `expires_at` are
   * exactly what they were before the call.
   *
   * WHY THIS TAKES A TOKEN IN THE BODY
   *   Only sha256(token) is stored. That is the whole point of the token
   *   design — a database dump must not hand over a working invitation — and it
   *   means the server genuinely cannot reconstruct an accept link on its own.
   *   There were three ways to build a resend and two of them are wrong:
   *
   *     * Mint a fresh token. Forbidden by the brief, and rightly: it silently
   *       invalidates the link the admin may have already sent, so "resend"
   *       would break the delivery that was already in flight.
   *     * Store the raw token so it can be re-read. That deletes the security
   *       property the hashing exists to provide, for a convenience feature.
   *     * Have the caller supply the token it was given at creation. The link
   *       is already in the admin's hands — it is in the creation response and
   *       on screen in the UI — so this asks for nothing they do not have, and
   *       the server verifies it against the stored hash before mailing
   *       anything.
   *
   *   The third is implemented. When no token is supplied the endpoint says so
   *   with TOKEN_NOT_RECOVERABLE and refuses, rather than sending a broken
   *   email or quietly issuing a new credential.
   */
  router.post('/:id/resend', async (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_PATTERN.test(id)) return fail(res, 400, 'INVALID_INVITATION_ID', 'That invitation id is not valid.');

    const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';

    try {
      const existing = await invitations.getById(id);
      if (!existing) return fail(res, 404, 'INVITATION_NOT_FOUND', 'No such invitation.');
      if (existing.accepted_at) {
        return fail(res, 409, 'INVITATION_USED', 'That invitation was already accepted. There is nothing to resend.');
      }
      if (existing.revoked_at) {
        return fail(res, 409, 'INVITATION_REVOKED', 'That invitation was revoked. Create a new one instead.');
      }
      if (new Date(existing.expires_at).getTime() <= now()) {
        // Resending would produce a link that fails the moment it is clicked.
        // Extending the expiry to avoid that is exactly what this endpoint is
        // forbidden to do, so the honest answer is to refuse.
        return fail(
          res, 410, 'INVITATION_EXPIRED',
          'That invitation has expired. Revoke it and invite them again — a resend cannot extend an expiry.'
        );
      }
      if (!rawToken) {
        return fail(
          res, 409, 'TOKEN_NOT_RECOVERABLE',
          'Only a hash of the invitation token is stored, so the link cannot be rebuilt here. '
          + 'Send the original link from the invitation you created, or revoke this invitation and issue a new one.'
        );
      }
      if (!(await invitations.matchesToken(id, hashToken(rawToken)))) {
        return fail(res, 400, 'TOKEN_MISMATCH', 'That token does not belong to this invitation.');
      }
      if (!mailConfigured()) {
        // Said before doing rather than after: an admin pressing Resend on a
        // service with no mail provider deserves a reason, not a silent no-op
        // dressed up as success.
        return fail(
          res, 503, 'EMAIL_NOT_CONFIGURED',
          'Email sending is not configured on this service, so nothing was sent. Pass the link on yourself.'
        );
      }

      let roleDisplay = existing.role_key;
      try {
        const roles = await users.listRoles();
        roleDisplay = roles.find(entry => entry.key === existing.role_key)?.display_name || existing.role_key;
      } catch (error) {
        // Same tradeoff as the revoke handler below: a slightly blunter role
        // name beats failing a send because the catalogue was briefly unread.
        console.warn('[INVITE] Role catalogue unavailable for a resend:', error?.code || error?.message || 'unknown');
      }

      const delivery = await sendInvitationEmail(existing, {
        rawToken,
        inviterName: actorName(req),
        roleDisplayName: roleDisplay,
        isResend: true,
        send: mail
      });

      if (!delivery.sent) {
        // Nothing was granted, revoked or changed, so there is nothing to
        // audit. A failed send is an operational event, not an access event.
        return fail(
          res, 502, 'EMAIL_SEND_FAILED',
          'The invitation is still valid but the email could not be sent. Pass the link on yourself.',
          { emailSent: false, emailReason: delivery.reason }
        );
      }

      // `team.member.invited`, not a new `team.invitation.resent` type.
      // lib/audit/event-types.js is a closed catalogue mirrored by a CHECK
      // constraint on sms_audit_log, so a new type is a migration, and an
      // undeclared one is rejected at write time. A resend is the same fact as
      // an invite — this person was invited to this role, again — so it reuses
      // the type and distinguishes itself in the summary.
      //
      // The metadata keys are exactly the allowlist for this type in
      // lib/audit/redact.js. Anything else is silently dropped there, so adding
      // `token_reissued: false` would only put a claim in the code that never
      // reaches the row. That guarantee lives in the summary instead, where it
      // is actually stored and read.
      await logAudit({
        eventType: 'team.member.invited',
        req,
        entityId: existing.id,
        summary: `${actorName(req)} re-sent the invitation email to ${existing.email} for ${roleDisplay}, `
          + `with the original link and the original expiry of ${new Date(existing.expires_at).toISOString()}`,
        metadata: {
          invitation_id: existing.id,
          email: existing.email,
          role: existing.role_key,
          role_display_name: roleDisplay,
          expires_at: existing.expires_at
        }
      });

      return res.json({
        success: true,
        invitationId: existing.id,
        emailSent: true,
        emailReason: null,
        expiresAt: existing.expires_at,
        note: 'The same link was sent again. No new token was issued and the expiry is unchanged.'
      });
    } catch (error) {
      return sendStoreError(res, error, 'resend');
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
