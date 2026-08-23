'use strict';
/**
 * routes/sms-optin.js — the public promotional-SMS opt-in confirmation.
 *
 *   GET  /sms-optin            the static page (never reads the token)
 *   POST /sms-optin/confirm    { token } -> records an opt_in
 *   POST /sms-optin/decline    { token } -> records an opt_out
 *
 * PUBLIC BY DESIGN, AND NOT BY ACCIDENT
 *   The person opening this link is a customer, not a member of staff. They
 *   have no session, cannot get one, and must never be asked for one. So this
 *   router is mounted OUTSIDE `/api`: the policy enforcer in
 *   lib/enforce-policy.js never sees it and lib/route-policy.js correctly has no
 *   entry for it. That is the same mechanism routes/well-known.js and every
 *   webhook rely on — unauthenticated because of the MOUNT, never because of a
 *   branch inside the gate. Adding these paths to the policy table would not
 *   tighten anything; it would fail test/route-policy.test.js, which builds its
 *   bijection from the `/api` mounts in server.js.
 *
 * MOUNT ORDER IS PART OF THE CONTRACT
 *   This router must be registered before `express.static` and before the SPA
 *   catch-all in server.js. Mounted after either one, `GET /sms-optin` is
 *   answered by index.html with HTTP 200 — a login screen where a consent page
 *   should be, with no error logged anywhere. That exact failure is why
 *   `/.well-known` is mounted where it is.
 *
 * A GET MUST NEVER RECORD CONSENT. THIS IS THE WHOLE THING.
 *   Corporate mail scanners, link previewers and antivirus proxies fetch every
 *   URL in an inbound email within seconds of delivery, unprompted. If GET
 *   recorded an opt-in, this service would manufacture consent for people who
 *   never saw the message, and it would look completely legitimate in the
 *   ledger. So the GET handler sends a static file and does not read, validate,
 *   log or even look at the token. Consent is written only by a POST, which a
 *   human has to press a button to produce.
 *
 *   If you are about to add a "look up this invitation so the page can greet
 *   them by name" endpoint: don't. It would be an oracle. Feed it tokens, read
 *   back phone numbers. The page shows no name, no address and no number, and
 *   the only thing this router will tell an anonymous caller is whether the
 *   POST it just made was accepted.
 *
 * RATE LIMITING, AND WHY THE TWO POSTS DO NOT SHARE A BUDGET
 *   A 256-bit token is not guessable, so throttling is not the control that
 *   protects the tokens; it is what stops a broken client or a bored script
 *   turning a public endpoint into load on the consent ledger.
 *
 *   Both endpoints used to share ONE limiter of 30 requests per IP per 15
 *   minutes. `req.ip` is one address for an entire corporate NAT, an entire
 *   CGNAT range, and an entire mobile carrier gateway, so the thirty-first
 *   person behind a shared address who pressed "No thanks" received a 429 and
 *   their withdrawal was never recorded. Throttling a "yes" costs a marketing
 *   permission. Throttling a "no" is a compliance failure, and a 429 on a
 *   withdrawal is indefensible in a way that a 429 on a subscription is not.
 *
 *   So /decline has its own budget, two orders of magnitude larger, and it is
 *   counted separately. It is not removed entirely because an unlimited public
 *   POST is a denial-of-service surface, but DECLINE_MAX is set far above any
 *   plausible shared-egress volume for one mailing: an invalid token writes
 *   nothing, and a valid one is idempotent under its dedupe key.
 *
 * THE TOKEN IS NEVER LOGGED
 *   Not at error level, not in development, and not inside a URL assembled for
 *   a log line. lib/campaigns/sms-optin-invite.js holds the same rule.
 */

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const {
  CONFIRM_ERRORS,
  RESPONSES,
  confirmOptInInvite,
  createSmsOptInInviteStore
} = require('../lib/campaigns/sms-optin-invite');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'sms-optin.html');

const WINDOW_MS = 15 * 60 * 1000;

/** Confirmations per IP per window. A delayed "yes" costs nobody anything. */
const CONFIRM_MAX = 30;

/**
 * Withdrawals per IP per window. Deliberately two orders of magnitude larger:
 * one address can stand for a whole office, a whole campus or a whole carrier,
 * and a refused "no" is not a rate-limited request, it is an unrecorded opt-out.
 */
const DECLINE_MAX = 3000;

/**
 * @param {{
 *   store?: object,
 *   consentClient?: object,
 *   confirm?: typeof confirmOptInInvite,
 *   limiter?: import('express').RequestHandler,
 *   now?: () => number
 * }} [options]
 * @returns {import('express').Router}
 */
function createSmsOptInRouter(options = {}) {
  const router = express.Router();

  const tooManyAttempts = {
    error: 'Too many attempts from this network. Wait a few minutes and try again.',
    code: 'TOO_MANY_ATTEMPTS'
  };

  // "Yes, text me". Tight, because nothing is lost by making somebody wait for
  // a permission they can grant later.
  const confirmLimiter = options.limiter || rateLimit({
    windowMs: WINDOW_MS,
    max: CONFIRM_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooManyAttempts
  });

  // "No thanks". A SEPARATE store with a SEPARATE budget, so that confirmations
  // from one shared address can never spend the allowance a withdrawal needs.
  // `options.declineLimiter` is the test seam; `options.limiter` deliberately
  // does NOT fall through to this endpoint, because the whole defect being
  // fixed was one limiter covering both.
  const declineLimiter = options.declineLimiter || rateLimit({
    windowMs: WINDOW_MS,
    max: DECLINE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooManyAttempts
  });

  const confirm = options.confirm || confirmOptInInvite;
  // Constructed lazily on first use so that requiring this file offline, as
  // test/route-policy.test.js does for every router, never builds a Supabase
  // client or reads configuration.
  let store = options.store || null;
  function resolveStore() {
    if (!store) store = createSmsOptInInviteStore();
    return store;
  }
  function resolveConsentClient(active) {
    if (options.consentClient) return options.consentClient;
    return typeof active.dbClient === 'function' ? active.dbClient() : null;
  }

  // ── GET /sms-optin ────────────────────────────────────────────────────────
  // The static page. No token is read here; see the header.
  router.get('/', (_req, res) => {
    // Keyed to a single-use invitation token, so no intermediary should hold a
    // copy and no shared device should re-serve it from cache.
    res.set('Cache-Control', 'no-store, private');
    // Belt and braces on top of the meta tag in the page itself. A consent
    // confirmation URL has no business in a search index.
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(PAGE_FILE);
  });

  /** Both POSTs are the same handler with a different answer. */
  async function answer(req, res, response) {
    res.set('Cache-Control', 'no-store, private');

    const token = req.body?.token;
    const active = resolveStore();

    let result;
    try {
      result = await confirm({
        store: active,
        consentClient: resolveConsentClient(active),
        token,
        response,
        // req.ip is trustworthy because server.js sets `trust proxy`, so this
        // is the client address Railway saw and not the load balancer's.
        ip: req.ip || req.socket?.remoteAddress || null,
        userAgent: (req.get ? req.get('user-agent') : null) || null,
        now: options.now
      });
    } catch (error) {
      // confirmOptInInvite is documented never to reject for a link problem, so
      // reaching here is a bug rather than a bad link. Neither the token nor
      // its hash appears in this line, and neither must.
      console.error('[OPTIN] Answer handler failed:', error?.code || 'internal_error');
      return res.status(CONFIRM_ERRORS.OPTIN_RECORD_FAILED.status).json({
        error: CONFIRM_ERRORS.OPTIN_RECORD_FAILED.message,
        code: 'OPTIN_RECORD_FAILED'
      });
    }

    if (!result.ok) {
      return res.status(result.status).json({ error: result.message, code: result.code });
    }

    return res.json({
      success: true,
      response: result.response,
      // The page uses this to say "that was already saved" rather than
      // announcing something that did not just happen.
      alreadyRecorded: result.alreadyRecorded === true
    });
  }

  // ── POST /sms-optin/confirm ───────────────────────────────────────────────
  // Records promotional SMS consent with SOURCE.CONFIRMED_INVITE and an
  // evidence_ref naming the invitation this click came from.
  router.post('/confirm', confirmLimiter, (req, res) => answer(req, res, RESPONSES.OPT_IN));

  // ── POST /sms-optin/decline ───────────────────────────────────────────────
  // Records an opt_out. This is not a courtesy: an email that only has a "yes"
  // button is a leading question, and a "no" that is recorded is worth more to
  // this workspace than a "no" that is merely inferred from silence — silence
  // is indistinguishable from an unread inbox, and an explicit opt_out suppresses
  // the number in every future campaign check.
  router.post('/decline', declineLimiter, (req, res) => answer(req, res, RESPONSES.OPT_OUT));

  return router;
}

module.exports = createSmsOptInRouter;
module.exports.createSmsOptInRouter = createSmsOptInRouter;
module.exports.CONFIRM_MAX = CONFIRM_MAX;
module.exports.DECLINE_MAX = DECLINE_MAX;
module.exports.WINDOW_MS = WINDOW_MS;
