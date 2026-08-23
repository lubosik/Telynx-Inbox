'use strict';
/**
 * lib/campaigns/sms-optin-invite.js — turning an email permission we HAVE into
 * an SMS permission we DO NOT.
 *
 * WHY THIS EXISTS
 *   Vici holds 926 SMS-reachable contacts and, in `sms_consent_events`, exactly
 *   zero promotional SMS opt-ins. The campaign engine is therefore correct to
 *   suppress every one of them, and it will keep being correct for as long as
 *   the ledger is empty. The privacy policy those customers accepted grants
 *   marketing EMAIL permission and says nothing whatsoever about text messages.
 *
 *   So the only lawful route to an SMS list is the slow one: use the email
 *   permission that genuinely exists to ASK, and record the click as documented
 *   consent with the evidence attached. That is the whole of this module. It
 *   creates no consent by itself, it manufactures no basis, and a contact who
 *   never clicks stays exactly as suppressed as they are today.
 *
 * WHAT A CONFIRMED CLICK IS WORTH
 *   `SOURCE.CONFIRMED_INVITE` in lib/campaigns/consent.js is described there as
 *   "they clicked a signed link in an email we were already permitted to send.
 *    Strong, and documented." This module is what makes the second half of that
 *   sentence true. Every opt-in it writes carries:
 *
 *     evidenceRef   sms_optin_invite:<uuid>   the exact invitation row, which
 *                                             names the address it was mailed
 *                                             to, the mailing it belonged to,
 *                                             and when it was sent
 *     metadata.ip / metadata.user_agent       captured at the moment of the
 *                                             click, from the request itself
 *     metadata.confirmed_at                   server time, not client time
 *
 *   None of that is decoration. If somebody later asks "why did you text me?",
 *   the answer has to be a specific email, on a specific date, to a specific
 *   address, with a click from a specific device. A boolean column cannot
 *   answer that question and neither can a spreadsheet.
 *
 * TOKENS: THE SAME CONSTRUCTION AS A PASSWORD RESET, FOR THE SAME REASONS
 *   crypto.randomBytes(32) rendered base64url. The raw token goes into exactly
 *   one place, the email body, and is then discarded. What is stored is its
 *   sha256 hex plus an 8-character prefix OF THAT HASH, never of the token, so
 *   a dump of `sms_optin_invitations` yields neither a working link nor a head
 *   start on guessing one. See lib/password-reset.js, which this deliberately
 *   mirrors down to the helper names so that the two cannot drift apart.
 *
 *   "Signed" in the sense that matters: a token cannot be produced by anybody
 *   who is not this server. It is NOT an HMAC of the phone number, and that is
 *   a deliberate choice rather than an omission. An HMAC is unrevocable without
 *   rotating a key that every other outstanding link depends on, it carries its
 *   subject in the URL where a mail scanner can read it, and it cannot express
 *   "already used". A random token with a hashed row behind it revokes by
 *   UPDATE, reveals nothing, and expires in SQL.
 *
 *   The token is never logged. Not at error level, not in development, and not
 *   inside a URL assembled for a log line.
 *
 * A GET MUST NEVER RECORD CONSENT
 *   Corporate mail scanners, link previewers and antivirus proxies follow every
 *   URL in an inbound email, unprompted, within seconds of delivery. If opening
 *   the link recorded an opt-in, this system would manufacture consent for
 *   people who never even saw the message — which is worse than having no
 *   consent at all, because it would look real in the ledger. So the landing
 *   page is a STATIC file that the server serves without reading the token, and
 *   consent is written only by an explicit POST that a human has to click for.
 *   routes/sms-optin.js repeats this warning where it can be violated.
 *
 * THE PAGE IS ALSO WHY NOTHING IS LOOKED UP ON GET
 *   A "who is this link for?" endpoint would be an oracle: feed it tokens, read
 *   back phone numbers. There is none. The page shows no phone number, no email
 *   address and no name, and the only thing the server ever tells an anonymous
 *   caller is whether the POST it just made was accepted.
 *
 * IDEMPOTENCY AND THE RACE
 *   Two properties, enforced in two independent places, because one of them
 *   failing silently is the kind of bug nobody notices for a year:
 *
 *     1. claim_sms_optin_invitation does SELECT ... FOR UPDATE on the
 *        invitation row, so exactly one concurrent caller performs the
 *        unanswered -> answered transition. The loser is told the answer is
 *        already recorded rather than being handed an error.
 *     2. Every consent write carries `dedupeKey`
 *        `sms_optin_invite:<uuid>:opt_in`, and
 *        `sms_consent_events_dedupe_idx` is UNIQUE on
 *        (workspace_id, dedupe_key). consent.js treats the resulting 23505 as
 *        success. So even if (1) were removed tomorrow, two simultaneous
 *        clicks could still only ever produce ONE consent row.
 *
 *   Because of (2) the consent write is safely repeatable, which is why a
 *   repeat click re-runs it instead of skipping it: if the very first attempt
 *   claimed the row and then died before writing to the ledger, the second
 *   click repairs the ledger rather than inheriting the gap.
 *
 * OPT-OUT IS NOT SYMMETRICAL WITH OPT-IN, ON PURPOSE
 *   consent.js already makes this argument and this module follows it. "No
 *   thanks" is accepted from an invitation that has EXPIRED and from one that
 *   has been SUPERSEDED, because refusing to record somebody's "no" for want of
 *   paperwork would be indefensible. "Yes" is accepted from neither.
 *
 *   And once a person has declined, a later click of the SAME emailed link
 *   cannot flip them to opted in. Anyone who can see that email can press that
 *   button; a change of mind has to be a fresh act (a new invitation, a START
 *   text, a ticked box at checkout), not a second press of a link the person
 *   already answered.
 *
 * THE ASYMMETRY IS IN THE WRITE ORDER TOO, AND THAT IS THE POINT
 *   The invitation row and the consent ledger are two separate round trips.
 *   Whichever one is written second can be lost, so the question is only ever
 *   "which loss is survivable?".
 *
 *     opt_in   claim first, then the ledger. Losing the ledger write means the
 *              person is NOT opted in, which is the safe direction: the send
 *              path reads the ledger and nothing else, so the failure suppresses
 *              rather than permits. The person is told to press again, and the
 *              dedupe key makes the repeat repair the gap.
 *
 *     opt_out  THE LEDGER FIRST, then the invitation row. This order is
 *              mandatory. The ledger is the only storage the send path consults;
 *              `sms_optin_invitations` is read by nothing on that path and there
 *              is no reconciliation job. If the invitation were committed as
 *              declined and the ledger write then failed, a recorded refusal
 *              would vanish while the customer was told to stop worrying, and
 *              they would never press the button again. Written this way round,
 *              the only thing a failure can lose is the bookkeeping stamp on the
 *              invitation row, and the withdrawal that governs sending is
 *              already durable.
 *
 *   That is also why the two directions cannot share the "could not be saved"
 *   message. OPTIN_RECORD_FAILED is only ever returned when NOTHING was written,
 *   and OPTIN_NOT_CONFIRMED exists for the opt_in case where the invitation was
 *   claimed but the ledger was not reached. Telling somebody "nothing has been
 *   recorded" when a row says otherwise is how a lost opt-out becomes invisible.
 *
 * AN EMAILED LINK CANNOT UNDO A STOP
 *   An invitation is minted days or weeks before it is answered, and a person
 *   can text STOP in between. A later opt_in with a later occurred_at would win
 *   the tuple comparison in every eligibility check and the ledger would then
 *   positively assert that consent was obtained after a withdrawal. So the
 *   withdrawal state is consulted TWICE, in two different places:
 *
 *     issueOptInInvite      refuses to mint at all, because emailing marketing
 *                           permission requests to somebody who has texted STOP
 *                           is itself the problem, not just the click that
 *                           follows it;
 *     confirmOptInInvite    re-reads it immediately before writing an opt_in,
 *                           because the mint is not the moment that matters.
 *
 *   Both look in all four places a withdrawal can live: the consent ledger, the
 *   `sms_sent_log` 'opted-out' sentinel, active `sms_campaign_suppressions`, and
 *   `sms_contacts` (`opted_out` and a positive HighLevel DND). A failure to READ
 *   that state refuses the opt_in; it never refuses an opt_out.
 */

const crypto = require('crypto');
const {
  DEFAULT_WORKSPACE,
  SOURCE,
  normalisePhone,
  recordOptIn,
  recordOptOut
} = require('./consent');
const { activeSuppressionReason } = require('./eligibility');

/**
 * The basis recorded for a CONFIRMATION. Owned by lib/campaigns/consent.js.
 */
const CONFIRM_SOURCE = SOURCE.CONFIRMED_INVITE;

/**
 * The basis recorded for a REFUSAL.
 *
 * A withdrawal must not be filed under a source whose name asserts a
 * confirmation. `email_invite_confirmed_link` on an opt_out row makes
 * "group the ledger by source and tell me how these people came off the list"
 * return nonsense, and it reads as a contradiction to anybody auditing one row.
 *
 * consent.js owns the SOURCE map and is owned by another agent, so this falls
 * back to the literal until `SOURCE.INVITE_DECLINED` lands there. The constant
 * is preferred the moment it exists, and test/sms-optin.test.js fails if the two
 * ever disagree, so the interim cannot silently outlive itself or drift.
 */
const DECLINE_SOURCE_VALUE = 'email_invite_declined_link';
const DECLINE_SOURCE = SOURCE.INVITE_DECLINED || DECLINE_SOURCE_VALUE;

/** Same size as a password-reset token and an invitation token. 256 bits. */
const TOKEN_BYTES = 32;

/** Characters of the HASH kept for log identification. Never of the token. */
const TOKEN_PREFIX_LENGTH = 8;

/**
 * How long an invitation stays live.
 *
 * Much longer than a password reset's 60 minutes, and for the opposite reason:
 * nobody is locked out while this sits unread. It is a favour being asked of
 * somebody who has no urgency at all, and an opt-in link that dies before the
 * weekend is a link that mostly gets clicked after it stopped working. Stated
 * in the email AND checked in SQL against now(); the copy is a courtesy, the
 * CHECK is the control.
 */
const EXPIRY_DAYS = 30;

/** Bounds applied to a submitted token before any lookup happens. */
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

/** A user-agent is evidence, not an essay. Truncated before it is stored. */
const MAX_USER_AGENT_LENGTH = 400;

/** Prefix of every evidence_ref and dedupe_key this module writes. */
const EVIDENCE_PREFIX = 'sms_optin_invite';

/** The two things a person can do with an invitation. */
const RESPONSES = Object.freeze({
  OPT_IN: 'opt_in',
  OPT_OUT: 'opt_out'
});

/**
 * The single answer given for a token this service cannot place: unknown,
 * malformed, or never issued.
 *
 * A constant so that no future branch can reword itself into a signal. There
 * is no version of this string that says whether a phone number is on a list.
 */
const GENERIC_LINK_MESSAGE =
  'That link is not valid. It may have been cut short by the app it arrived in, '
  + 'or it may belong to a message that has since been replaced.';

/**
 * Every outcome the confirmation endpoint can return, and its HTTP status.
 *
 * OPTIN_NOT_VALID covers unknown, malformed and superseded tokens with ONE
 * message and ONE status, deliberately. The others are only reachable by
 * somebody who is already holding a real, issued token, so they can afford to
 * be specific: telling a person whose link expired last month to go hunting for
 * a typo would be a worse failure than the one being avoided.
 */
const CONFIRM_ERRORS = Object.freeze({
  OPTIN_NOT_VALID: { status: 404, message: GENERIC_LINK_MESSAGE },
  OPTIN_EXPIRED: {
    status: 410,
    message: 'That invitation has expired, so it can no longer be used to turn texts on. '
      + 'You have not been added to anything.'
  },
  OPTIN_ALREADY_DECLINED: {
    status: 409,
    message: 'This invitation was already answered with a no, so it cannot be used to turn texts on. '
      + 'Nothing has changed and you will not be texted.'
  },
  /**
   * NOTHING WAS WRITTEN. This message promises that, so it may only be returned
   * from a path that reached neither the ledger nor the invitation row.
   */
  OPTIN_RECORD_FAILED: {
    status: 503,
    message: 'Your answer could not be saved just now. Nothing has been recorded, so please try again in a moment.'
  },
  /**
   * The invitation was claimed and the consent ledger was NOT reached. Only the
   * opt_in path can produce this, because the opt_out path writes the ledger
   * first precisely so that it cannot.
   *
   * It deliberately does not say "nothing has been recorded": something was, and
   * a person told otherwise stops pressing the button that would repair it.
   */
  OPTIN_NOT_CONFIRMED: {
    status: 503,
    message: 'We received your answer but could not finish saving it, so your permission is not on file yet. '
      + 'Please press the button again in a moment.'
  },
  /**
   * Texts are already off for this number, by a route that outranks an emailed
   * link: a STOP reply, a suppression, a HighLevel do-not-disturb, or a recorded
   * withdrawal. A link cannot undo any of those.
   */
  OPTIN_WITHDRAWN: {
    status: 409,
    message: 'Marketing texts are already turned off for this number, so this link cannot turn them back on. '
      + 'Nothing has changed. If you have changed your mind, reply START to one of our texts or email us '
      + 'and we will sort it out properly.'
  }
});

/** Deterministic, so a token can be looked up without ever being stored. */
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

/** ISO timestamp EXPIRY_DAYS from `from`. */
function expiryFrom(from = Date.now()) {
  return new Date(from + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The evidence_ref written onto every consent event from this flow.
 *
 * Deliberately resolvable: a person auditing the ledger can take this string,
 * look the row up in `sms_optin_invitations`, and see which address the email
 * went to, which mailing it belonged to, when it was sent, and when it was
 * answered. "email" would not be a source and "clicked a link" would not be
 * evidence.
 */
function evidenceRefFor(invitationId) {
  return `${EVIDENCE_PREFIX}:${invitationId}`;
}

/**
 * The uniqueness key that makes a consent write repeatable.
 *
 * One per invitation per direction, so an opt-out that follows an opt-in is
 * still recordable (different key) while two clicks of the same button are
 * not (same key, unique index, 23505, treated as success by consent.js).
 */
function dedupeKeyFor(invitationId, response) {
  return `${EVIDENCE_PREFIX}:${invitationId}:${response}`;
}

/**
 * `${APP_URL}/sms-optin?token=...`, or null when APP_URL is unset.
 *
 * @param {string} rawToken
 * @param {string} base  appUrl(), already trimmed of trailing slashes
 * @returns {string|null}
 */
function optInUrlFor(rawToken, base) {
  const root = String(base || '').replace(/\/+$/, '');
  return root ? `${root}/sms-optin?token=${encodeURIComponent(rawToken)}` : null;
}

/**
 * The last four digits of a phone number, for the EMAIL only.
 *
 * The person needs to know which number is about to start receiving texts, and
 * they are reading this in a mailbox they control. It is never rendered on the
 * public page, which anybody holding a forwarded link can open.
 *
 * @returns {string|null} e.g. '0132'
 */
function phoneEnding(phone) {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;
  return normalised.slice(-4);
}

/** True when a submitted token is the right shape to be worth looking up. */
function isPlausibleToken(value) {
  return typeof value === 'string'
    && value.length >= MIN_TOKEN_LENGTH
    && value.length <= MAX_TOKEN_LENGTH
    && !/\s/.test(value);
}

/** Maps the SQL function's RAISE messages onto an outcome code. */
function confirmErrorFrom(error) {
  const message = String(error?.message || '');
  for (const code of Object.keys(CONFIRM_ERRORS)) {
    if (message.includes(code)) return { code, ...CONFIRM_ERRORS[code] };
  }
  return null;
}

/** A failure shaped exactly like every other failure this module returns. */
function failure(code) {
  const known = CONFIRM_ERRORS[code] || CONFIRM_ERRORS.OPTIN_NOT_VALID;
  return { ok: false, code: CONFIRM_ERRORS[code] ? code : 'OPTIN_NOT_VALID', ...known };
}

/**
 * The Supabase client the withdrawal check and the consent ledger share.
 *
 * One injected fake therefore covers `sms_optin_invitations`, the four
 * withdrawal sources and `sms_consent_events`, which is what makes the offline
 * tests able to model a STOP arriving between the mint and the click.
 */
function resolveConsentClient(input) {
  if (input.consentClient) return input.consentClient;
  const store = input.store;
  return store && typeof store.dbClient === 'function' ? store.dbClient() : null;
}

/**
 * True when this invitation could still be answered with a YES right now.
 *
 * ADVISORY ONLY. claim_sms_optin_invitation re-decides all of this under
 * SELECT ... FOR UPDATE against the DATABASE clock, and that decision is the
 * authoritative one. This copy exists for exactly one purpose: to know whether
 * a withdrawal refusal may be shown to the caller yet, or whether the claim is
 * about to refuse the link for a reason that outranks it.
 *
 * Getting it wrong is safe in both directions. Too permissive and the claim
 * raises the right code anyway. Too restrictive and the refusal is simply
 * deferred to the post-claim backstop in confirmOptInInvite, which uses the same
 * already-computed withdrawal state.
 *
 * @param {object|null} row  snapshot from store.lookup()
 * @param {number} nowMs
 */
function invitationAnswerableForOptIn(row, nowMs) {
  if (!row) return false;
  if (row.cancelled_at) return false;
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) return false;
  if (row.responded_at && row.response === RESPONSES.OPT_OUT) return false;
  return true;
}

/**
 * Every place a withdrawal can live, read at once.
 *
 * An emailed invitation is minted days or weeks before it is answered. In that
 * gap the person can text STOP, be suppressed, or be marked do-not-disturb in
 * HighLevel, and none of those touch the invitation row. Writing an opt_in on
 * top of any of them would produce a ledger that positively asserts consent
 * obtained AFTER a refusal, with a later occurred_at that wins every tuple
 * comparison in every eligibility check. That is the worst possible shape for
 * this table to be in.
 *
 * The four sources mirror scripts/backfill-order-sms-consent.js and
 * lib/campaigns/eligibility.js, deliberately, so a withdrawal recognised by one
 * of them is recognised by all three:
 *
 *   sms_consent_events         the latest event for this number is an opt_out
 *   sms_sent_log               a 'opted-out' sentinel row, written by the
 *                              inbound STOP handler
 *   sms_campaign_suppressions  an active, in-window suppression
 *   sms_contacts               opted_out, or a positive HighLevel SMS DND
 *
 * DND is treated as a withdrawal only when it is POSITIVE. Eligibility also
 * refuses a stale or unknown DND status, but that is a send-time freshness rule;
 * applying it here would refuse to ask permission of the entire list on a sync
 * lag, which is a different failure and not the one being prevented.
 *
 * NEVER CALL THIS ON THE OPT-OUT PATH. A refusal must not depend on a read
 * succeeding.
 *
 * Supabase query builders are thenables with no `.catch()`, so every await is
 * wrapped in try/catch and every result has its `error` inspected. See
 * test/no-builder-catch.test.js.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>} `ok:false` means the
 *   state could not be determined, which is NOT the same as "not withdrawn" and
 *   must never be treated as permission.
 */
async function activeWithdrawalReason({ client, phone, workspace = DEFAULT_WORKSPACE, now = Date.now }) {
  const contactPhone = normalisePhone(phone);
  if (!client || !contactPhone) return { ok: false, reason: null };

  let ledger;
  let sentinel;
  let suppressions;
  let contact;
  try {
    [ledger, sentinel, suppressions, contact] = await Promise.all([
      client.from('sms_consent_events')
        .select('event_type, occurred_at, id')
        .eq('workspace_id', workspace)
        .eq('brand_id', workspace)
        .eq('purpose', 'promotional_sms')
        .eq('contact_phone', contactPhone)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1),
      client.from('sms_sent_log')
        .select('id')
        .eq('phone', contactPhone)
        .eq('flow_type', 'opted-out')
        .limit(1),
      client.from('sms_campaign_suppressions')
        .select('reason_code, active, effective_at, expires_at')
        .eq('workspace_id', workspace)
        .eq('contact_phone', contactPhone)
        .eq('active', true)
        .limit(50),
      client.from('sms_contacts')
        .select('opted_out, ghl_dnd, ghl_sms_dnd_status')
        .eq('phone', contactPhone)
        .maybeSingle()
    ]);
  } catch (error) {
    console.error('[OPTIN] Withdrawal state could not be read:', error?.code || 'internal_error');
    return { ok: false, reason: null };
  }

  const failed = ledger?.error || sentinel?.error || suppressions?.error || contact?.error;
  if (failed) {
    console.error('[OPTIN] Withdrawal state could not be read:', failed.code || 'query_failed');
    return { ok: false, reason: null };
  }

  const latest = Array.isArray(ledger.data) ? ledger.data[0] : ledger.data;
  if (latest?.event_type === 'opt_out') return { ok: true, reason: 'consent_ledger_opt_out' };

  const sentinelRows = Array.isArray(sentinel.data) ? sentinel.data : [];
  if (sentinelRows.length) return { ok: true, reason: 'stop_sentinel' };

  const suppression = activeSuppressionReason(
    Array.isArray(suppressions.data) ? suppressions.data : [],
    new Date(now())
  );
  if (suppression) return { ok: true, reason: suppression };

  const contactRow = contact.data || null;
  if (contactRow?.opted_out === true) return { ok: true, reason: 'contact_opted_out' };
  if (contactRow?.ghl_dnd === true) return { ok: true, reason: 'dnd' };
  if (['active', 'permanent'].includes(String(contactRow?.ghl_sms_dnd_status || '').toLowerCase())) {
    return { ok: true, reason: 'dnd' };
  }

  return { ok: true, reason: null };
}

/**
 * Storage seam. Injected wholesale by the tests, exactly like the password
 * reset store, so no test needs a database or a network.
 *
 * @param {{client?: object}} [options]
 */
function createSmsOptInInviteStore({ client } = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }

  return {
    /**
     * The same Supabase client the consent ledger writes through, resolved
     * lazily. A caller passes `store.dbClient()` as `consentClient` so that one
     * injected fake covers both the invitation table and `sms_consent_events`.
     */
    dbClient: db,

    /**
     * Supersede any unanswered invitation for this number and open a new one,
     * atomically. Two of these racing cannot both leave an open row.
     *
     * @returns {Promise<string>} the new invitation's uuid
     */
    async open({
      workspace, phone, email, tokenHash, tokenPrefix, expiresAt, campaignRef, createdBy
    }) {
      const result = await db().rpc('open_sms_optin_invitation', {
        p_workspace_id: workspace,
        p_contact_phone: phone,
        p_contact_email: email ?? null,
        p_token_hash: tokenHash,
        p_token_prefix: tokenPrefix,
        p_expires_at: expiresAt,
        p_campaign_ref: campaignRef,
        p_created_by: createdBy ?? null
      });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'OPTIN_INVITE_OPEN_FAILED' });
      }
      return result.data;
    },

    /**
     * Read the invitation behind a token WITHOUT touching it.
     *
     * This is what makes the opt-out path able to write the consent ledger
     * FIRST: the ledger write needs a phone number, and until this existed the
     * only way to learn one was to claim the invitation, which is the very
     * commit that must not happen before the durable record. It answers the
     * question "whose invitation is this?" and nothing else.
     *
     * It is not an oracle. It is a service-role read behind a 256-bit token,
     * called only from confirmOptInInvite, and it returns to the server. No
     * caller of this module can reach it and nothing it returns is put in an
     * HTTP response: routes/sms-optin.js answers with a code and a message and
     * never with a phone number.
     *
     * It is also advisory. Every rule about whether an invitation may be
     * answered is still decided by claim_sms_optin_invitation under its row
     * lock; the snapshot is used to order error codes and to find the phone.
     *
     * @returns {Promise<object|null>} null when the token matches no row
     */
    async lookup(tokenHash) {
      const found = await db()
        .from('sms_optin_invitations')
        .select('id, workspace_id, contact_phone, campaign_ref, expires_at, cancelled_at, responded_at, response')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (found.error) {
        throw Object.assign(new Error(found.error.message), { code: 'OPTIN_INVITE_LOOKUP_FAILED' });
      }
      return found.data || null;
    },

    /**
     * Spend the token, in ONE transaction, under SELECT ... FOR UPDATE.
     *
     * Returns the invitation's identity plus `newly_recorded`, which is true
     * only for the caller that actually performed the state transition. The
     * phone number comes back from HERE and never from the client: the browser
     * submits a token and nothing else, so no caller can nominate whose consent
     * is being recorded.
     *
     * @returns {Promise<object>} jsonb from claim_sms_optin_invitation
     */
    async claim({ tokenHash, response, ip, userAgent }) {
      const result = await db().rpc('claim_sms_optin_invitation', {
        p_token_hash: tokenHash,
        p_response: response,
        p_ip: ip ?? null,
        p_user_agent: userAgent ?? null
      });
      if (result.error) {
        throw Object.assign(new Error(result.error.message), { code: 'OPTIN_INVITE_CLAIM_FAILED' });
      }
      return result.data;
    },

    /**
     * Best-effort attempt counter for a refused claim. The SQL function raises,
     * which rolls its own transaction back, so a failed attempt cannot increment
     * from inside it. Mirrors noteAttempt in lib/password-reset.js, including
     * its tolerance of failure.
     */
    async noteAttempt(tokenHash) {
      try {
        const found = await db()
          .from('sms_optin_invitations')
          .select('id, attempt_count')
          .eq('token_hash', tokenHash)
          .maybeSingle();
        if (found.error || !found.data) return;
        const bumped = await db()
          .from('sms_optin_invitations')
          .update({ attempt_count: (found.data.attempt_count || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', found.data.id);
        if (bumped.error) console.warn('[OPTIN] attempt_count not recorded:', bumped.error.message);
      } catch (err) {
        console.warn('[OPTIN] attempt_count not recorded:', err.message);
      }
    }
  };
}

/**
 * Mint one invitation for one phone number.
 *
 * Writes nothing to the consent ledger. An issued invitation is a question, and
 * a question is not an answer: until somebody presses a button on the page, the
 * number remains exactly as unconsented as it was.
 *
 * ASKING IS ITSELF AN ACT THAT NEEDS PERMISSION
 *   Somebody who has texted STOP has told this business to stop texting them
 *   about marketing. Emailing them a button labelled "Yes, text me" is not a
 *   neutral question, it is the campaign arriving by another door, and the CTIA
 *   handbook treats a solicitation after a withdrawal as the violation whether
 *   or not the recipient engages. So the withdrawal state is checked HERE, and
 *   a refusal costs one invitation rather than one complaint.
 *
 *   The check is fail-closed. A number whose state cannot be read is not
 *   invited, because "we could not tell" and "they have not said no" are
 *   different facts and only one of them is a basis for asking.
 *
 * @param {object} input
 * @param {object} input.store        createSmsOptInInviteStore(), or a fake
 * @param {string} input.phone        E.164
 * @param {string} [input.email]      the address it will be mailed to; evidence
 * @param {string} input.campaignRef  identifies the mailing, e.g. 'sms_optin_invite_2026_08'
 * @param {string} input.baseUrl      appUrl()
 * @param {object} [input.consentClient]  the Supabase client the withdrawal
 *                                        check reads through. Defaults to
 *                                        `store.dbClient()`.
 * @param {number} [input.createdBy]  sms_users.id of whoever launched the mailing
 * @param {string} [input.workspace]
 * @param {() => number} [input.now]
 * @returns {Promise<{issued: boolean, reason?: string, invitationId?: string,
 *                    inviteUrl?: string, expiresAt?: string, phoneEnding?: string}>}
 */
async function issueOptInInvite(input) {
  const { store, campaignRef, baseUrl } = input;
  const now = input.now || Date.now;
  const workspace = input.workspace || DEFAULT_WORKSPACE;

  const phone = normalisePhone(input.phone);
  if (!phone) return { issued: false, reason: 'invalid_phone' };
  if (!String(campaignRef || '').trim()) return { issued: false, reason: 'campaign_ref_required' };

  // Checked before the token is generated, so that a refused mint leaves no
  // credential in memory and no row that would pointlessly supersede a live
  // invitation. Neither the token nor the number appears in this warning.
  if (!String(baseUrl || '').replace(/\/+$/, '')) {
    console.warn('[OPTIN] Not issuing an invitation: APP_URL is not set, so the link cannot be built');
    return { issued: false, reason: 'no_app_url' };
  }

  const withdrawal = await activeWithdrawalReason({
    client: resolveConsentClient(input),
    phone,
    workspace,
    now
  });
  if (!withdrawal.ok) {
    console.warn('[OPTIN] Not issuing an invitation: the withdrawal state could not be read');
    return { issued: false, reason: 'withdrawal_check_failed' };
  }
  if (withdrawal.reason) {
    return { issued: false, reason: 'withdrawn', withdrawalReason: withdrawal.reason };
  }

  // Minted after every refusal, so that the hash is all that is ever passed
  // downwards and no unusable token is ever created.
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const inviteUrl = optInUrlFor(rawToken, baseUrl);

  const expiresAt = expiryFrom(now());
  let invitationId;
  try {
    invitationId = await store.open({
      workspace,
      phone,
      email: input.email ? String(input.email).trim() : null,
      tokenHash,
      tokenPrefix: tokenPrefixOfHash(tokenHash),
      expiresAt,
      campaignRef: String(campaignRef).trim(),
      createdBy: input.createdBy ?? null
    });
  } catch (error) {
    console.warn('[OPTIN] Invitation not stored:', error?.code || 'internal_error');
    return { issued: false, reason: 'store_failed' };
  }

  return {
    issued: true,
    invitationId,
    inviteUrl,
    expiresAt,
    phoneEnding: phoneEnding(phone)
  };
}

/**
 * Answer one invitation.
 *
 * NEVER REJECTS for a link problem. Every refusal resolves to the same shape as
 * every success, so routes/sms-optin.js has one thing to map and cannot leak a
 * stack trace or a distinguishing 500 to an anonymous caller.
 *
 * THE ANSWER IS VALIDATED AGAINST A CLOSED SET, AND FAILS CLOSED
 *   This used to read `input.response === 'opt_out' ? OPT_OUT : OPT_IN`, which
 *   turned 'decline', 'no', 'OPT_OUT', a typo and `undefined` into an OPT-IN and
 *   made the SQL function's own guard unreachable, because Node had already
 *   coerced the value into something valid. A default on the consent-CREATING
 *   direction is the wrong way round in a module whose entire subject is not
 *   creating consent by accident. Anything that is not exactly 'opt_in' or
 *   'opt_out' is now refused before a token is even hashed.
 *
 * ORDER OF OPERATIONS, AND WHY
 *   0. validate the answer against the closed set;
 *   1. shape-check the token, before any lookup at all;
 *   2. read the invitation WITHOUT touching it, to learn whose it is;
 *
 *   then the two directions part company, and the split is the whole point:
 *
 *   OPT_IN   3. read the withdrawal state for that number and refuse if there
 *               is one, because a link may not undo a STOP;
 *            4. claim the invitation (FOR UPDATE), which serialises two
 *               simultaneous clicks and is authoritative about expiry,
 *               cancellation and a prior refusal;
 *            5. write the consent event with the dedupe key.
 *
 *            Step 5 runs even when step 4 reports the answer was already
 *            recorded. That is intentional: the pair is only eventually
 *            consistent if a repeat click can repair a ledger write lost between
 *            (4) and (5), and the dedupe index makes the repair free when there
 *            is nothing to repair. Losing (5) suppresses rather than permits, so
 *            this order is safe.
 *
 *   OPT_OUT  3. write the consent event FIRST;
 *            4. stamp the invitation row second.
 *
 *            Reversed relative to the opt_in, deliberately. The ledger is the
 *            only storage the send path reads and there is no reconciliation
 *            job, so the withdrawal has to be the durable half. A failure at (4)
 *            loses a bookkeeping stamp and the person still never gets texted; a
 *            failure the other way round would lose the refusal itself while
 *            telling them it was safe to stop pressing.
 *
 *            No withdrawal check runs on this path and none ever should. A "no"
 *            must not depend on a read succeeding.
 *
 * @param {object} input
 * @param {object} input.store          createSmsOptInInviteStore(), or a fake
 * @param {object} input.consentClient  the Supabase client consent.js writes through
 * @param {string} input.token          raw token from the page's POST body
 * @param {'opt_in'|'opt_out'} input.response
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @param {string} [input.workspace]
 * @param {() => number} [input.now]
 * @returns {Promise<{ok: true, response: string, invitationId: string,
 *                    alreadyRecorded: boolean, invitationStamped?: boolean}
 *                 | {ok: false, code: string, status: number, message: string}>}
 */
async function confirmOptInInvite(input) {
  const { store, token } = input;
  const now = input.now || Date.now;

  // FAIL CLOSED ON AN UNRECOGNISED ANSWER. No default, in either direction.
  if (input.response !== RESPONSES.OPT_IN && input.response !== RESPONSES.OPT_OUT) {
    return failure('OPTIN_NOT_VALID');
  }
  const response = input.response;

  // Refused before a single row is read. A token of the wrong shape cannot be
  // one this service issued, so looking it up would buy nothing but a timing
  // difference between "wrong shape" and "wrong value".
  if (!isPlausibleToken(token)) return failure('OPTIN_NOT_VALID');

  const tokenHash = hashToken(token);
  const ip = input.ip ? String(input.ip).slice(0, 100) : null;
  const userAgent = input.userAgent ? String(input.userAgent).slice(0, MAX_USER_AGENT_LENGTH) : null;
  const consentClient = resolveConsentClient(input);

  // Whose invitation is this? Nothing is written by this read, and nothing it
  // returns reaches the caller.
  let snapshot = null;
  let lookupFailed = false;
  if (typeof store.lookup === 'function') {
    try {
      snapshot = await store.lookup(tokenHash);
    } catch (error) {
      // Neither the token nor its hash reaches this line, and neither must.
      console.error('[OPTIN] Invitation lookup failed:', error?.code || 'internal_error');
      lookupFailed = true;
    }
  } else {
    // A store that cannot answer "whose is this?" cannot support the opt-out
    // ordering, and guessing is not an option on a consent path.
    lookupFailed = true;
  }

  const context = {
    store,
    consentClient,
    tokenHash,
    snapshot,
    lookupFailed,
    ip,
    userAgent,
    now,
    workspace: snapshot?.workspace_id || input.workspace || DEFAULT_WORKSPACE
  };

  return response === RESPONSES.OPT_OUT
    ? declineInvitation(context)
    : acceptInvitation(context);
}

/** The evidence carried by every consent event this module writes. */
function evidenceFor({ snapshot, invitationId, campaignRef, ip, userAgent, occurredAt, consentClient, workspace }) {
  return {
    client: consentClient,
    phone: snapshot.contact_phone,
    evidenceRef: evidenceRefFor(invitationId),
    occurredAt,
    metadata: {
      invitation_id: invitationId,
      campaign_ref: campaignRef || null,
      channel: 'email_invite_web_confirmation',
      // Captured from the request, not from anything the page was free to say
      // about itself.
      ip,
      user_agent: userAgent,
      confirmed_at: occurredAt
    },
    workspace
  };
}

/**
 * "No thanks". The ledger first, the invitation row second.
 *
 * Everything here is arranged so that the only outcome this function can produce
 * is either "the withdrawal is durably on file" or "nothing at all was written,
 * and we said so".
 */
async function declineInvitation(context) {
  const { store, consentClient, tokenHash, snapshot, lookupFailed, ip, userAgent, now, workspace } = context;

  if (lookupFailed) {
    // The number cannot be established, so the withdrawal cannot be written
    // against anybody. Refusing is the only honest answer, and the message this
    // returns promises exactly what happened: nothing. The page keeps the button
    // in place so the person can press it again.
    return failure('OPTIN_RECORD_FAILED');
  }
  if (!snapshot) {
    // Unknown token. The same generic answer an unknown token gets everywhere
    // else, and the attempt is counted, so this cannot be used to tell a real
    // token from an invented one.
    try { await store.noteAttempt(tokenHash); } catch { /* counter only */ }
    return failure('OPTIN_NOT_VALID');
  }

  const invitationId = snapshot.id;
  const occurredAt = new Date(now()).toISOString();
  const common = evidenceFor({
    snapshot,
    invitationId,
    campaignRef: snapshot.campaign_ref,
    ip,
    userAgent,
    occurredAt,
    consentClient,
    workspace
  });

  let written;
  try {
    written = await recordOptOut({
      ...common,
      source: DECLINE_SOURCE,
      dedupeKey: dedupeKeyFor(invitationId, RESPONSES.OPT_OUT)
    });
  } catch (error) {
    // The invitation has NOT been claimed, so nothing anywhere says this person
    // answered. "Nothing has been recorded" is true.
    console.error('[OPTIN] Withdrawal not written:', error?.code || 'internal_error');
    return failure('OPTIN_RECORD_FAILED');
  }
  if (!written || written.recorded !== true) {
    // recordOptOut REFUSED rather than threw, e.g. a phone it will not accept.
    // Same reasoning: the invitation is untouched, so nothing was recorded.
    console.error('[OPTIN] Withdrawal refused:', written?.reason || 'unknown');
    return failure('OPTIN_RECORD_FAILED');
  }

  // From here the withdrawal is durable and the person will not be texted, no
  // matter what happens next. The invitation row is bookkeeping.
  let claimed = null;
  try {
    claimed = await store.claim({ tokenHash, response: RESPONSES.OPT_OUT, ip, userAgent });
  } catch (error) {
    // Deliberately NOT reported as a failure. The consent ledger already holds
    // the opt_out, and telling somebody their "no" did not save when it did is
    // the exact bug this ordering exists to prevent.
    console.error('[OPTIN] Withdrawal recorded, invitation row not stamped:', error?.code || 'internal_error');
  }

  return {
    ok: true,
    response: RESPONSES.OPT_OUT,
    invitationId,
    alreadyRecorded: written.duplicate === true || claimed?.newly_recorded === false,
    invitationStamped: claimed !== null
  };
}

/**
 * "Yes, text me". The claim first, the ledger second, and a withdrawal check on
 * both sides of the claim.
 */
async function acceptInvitation(context) {
  const { store, consentClient, tokenHash, snapshot, lookupFailed, ip, userAgent, now, workspace } = context;

  // A number that has withdrawn cannot be opted back in by pressing a link in an
  // email that predates the withdrawal.
  let withdrawal = { ok: true, reason: null };
  if (lookupFailed || (snapshot && !normalisePhone(snapshot.contact_phone))) {
    // Either the invitation could not be read, or it was read and carries no
    // usable number. Both mean the withdrawal state is unknown, and unknown is
    // not permission. Nothing has been touched, so nothing was recorded.
    //
    // The second case is impossible while `contact_phone` is NOT NULL with an
    // E.164 CHECK, and is handled anyway because the alternative is a silent
    // path that writes an opt_in with no withdrawal check at all.
    return failure('OPTIN_RECORD_FAILED');
  }
  if (snapshot) {
    withdrawal = await activeWithdrawalReason({
      client: consentClient,
      phone: snapshot.contact_phone,
      workspace,
      now
    });
    if (!withdrawal.ok) {
      // Could not tell. Not the same as "they have not said no", and the
      // invitation has not been touched, so nothing was recorded.
      return failure('OPTIN_RECORD_FAILED');
    }
    // Surfaced before the claim only when the link would otherwise have worked.
    // If it is expired, cancelled or already declined, the claim owns the answer
    // and says so, which keeps an unknown token and a superseded one
    // indistinguishable.
    if (withdrawal.reason && invitationAnswerableForOptIn(snapshot, now())) {
      return failure('OPTIN_WITHDRAWN');
    }
  }
  // snapshot === null with a lookup that SUCCEEDED means the token matches no
  // row. That falls through to the claim, which raises the generic answer, so an
  // unknown token stays indistinguishable from a superseded one.

  let claimed;
  try {
    claimed = await store.claim({ tokenHash, response: RESPONSES.OPT_IN, ip, userAgent });
  } catch (error) {
    const mapped = confirmErrorFrom(error);
    // Best effort, and deliberately not awaited into the failure path's
    // correctness: a counter that did not increment costs nothing.
    try { await store.noteAttempt(tokenHash); } catch { /* counter only */ }
    if (mapped) return { ok: false, ...mapped };
    // Neither the token nor its hash reaches this line, and neither must.
    console.error('[OPTIN] Invitation claim failed:', error?.code || 'internal_error');
    return failure('OPTIN_RECORD_FAILED');
  }

  if (!claimed || !claimed.invitation_id || !claimed.contact_phone) {
    console.error('[OPTIN] Invitation claim returned nothing usable');
    return failure('OPTIN_RECORD_FAILED');
  }

  // BACKSTOP. The pre-claim refusal is gated on an advisory snapshot judged
  // against the Node clock, and the database judged the same invitation
  // answerable. Whichever of the two was right about expiry, a withdrawal still
  // outranks this click, and no opt_in may be written on top of it.
  if (withdrawal.reason) {
    console.error('[OPTIN] Refusing an opt_in over an active withdrawal:', withdrawal.reason);
    return failure('OPTIN_WITHDRAWN');
  }

  const invitationId = claimed.invitation_id;
  const occurredAt = new Date(now()).toISOString();
  const common = evidenceFor({
    // The phone comes from the CLAIM here, never from the advisory snapshot and
    // never from the client.
    snapshot: { contact_phone: claimed.contact_phone },
    invitationId,
    campaignRef: claimed.campaign_ref,
    ip,
    userAgent,
    occurredAt,
    consentClient,
    workspace: claimed.workspace_id || workspace
  });

  let written;
  try {
    written = await recordOptIn({
      ...common,
      source: CONFIRM_SOURCE,
      dedupeKey: dedupeKeyFor(invitationId, RESPONSES.OPT_IN)
    });
  } catch (error) {
    // The claim STANDS. Saying "nothing has been recorded" here would be false,
    // so this returns OPTIN_NOT_CONFIRMED instead: something was recorded, the
    // permission was not, and pressing again repairs it under the stable dedupe
    // key rather than double-recording it.
    console.error('[OPTIN] Consent event not written:', error?.code || 'internal_error');
    return failure('OPTIN_NOT_CONFIRMED');
  }

  if (!written || written.recorded !== true) {
    // recordOptIn REFUSED rather than threw. Without this branch a refusal is
    // reported to the customer as "you are subscribed" with nothing in the
    // ledger, which is the one outcome this module exists to make impossible.
    console.error('[OPTIN] Consent event refused:', written?.reason || 'unknown');
    return failure('OPTIN_NOT_CONFIRMED');
  }

  return {
    ok: true,
    response: RESPONSES.OPT_IN,
    invitationId,
    // True when this exact answer was already in the ledger. The page says
    // "already recorded" rather than pretending something just happened.
    alreadyRecorded: claimed.newly_recorded === false || written.duplicate === true,
    invitationStamped: true
  };
}

module.exports = {
  CONFIRM_ERRORS,
  CONFIRM_SOURCE,
  DECLINE_SOURCE,
  DECLINE_SOURCE_VALUE,
  EVIDENCE_PREFIX,
  EXPIRY_DAYS,
  GENERIC_LINK_MESSAGE,
  MAX_TOKEN_LENGTH,
  MAX_USER_AGENT_LENGTH,
  MIN_TOKEN_LENGTH,
  RESPONSES,
  TOKEN_BYTES,
  TOKEN_PREFIX_LENGTH,
  activeWithdrawalReason,
  confirmErrorFrom,
  confirmOptInInvite,
  createSmsOptInInviteStore,
  dedupeKeyFor,
  evidenceRefFor,
  expiryFrom,
  generateToken,
  hashToken,
  invitationAnswerableForOptIn,
  isPlausibleToken,
  issueOptInInvite,
  optInUrlFor,
  phoneEnding,
  tokenPrefixOfHash
};
