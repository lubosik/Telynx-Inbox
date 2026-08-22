'use strict';
/**
 * routes/well-known.js — the public `/.well-known` documents.
 *
 * Currently one: `apple-app-site-association`, which iOS fetches to decide
 * whether this domain may open the Vici Inbox app for a Universal Link.
 *
 * PUBLIC BY DESIGN, AND NOT BY ACCIDENT
 *   Apple's CDN fetches this anonymously. It carries no customer data, no
 *   identifiers beyond the app's own Team ID and bundle id — both of which are
 *   public in any App Store listing — and it must answer 200 to a request with
 *   no cookie. It is NOT under `/api`, so the policy enforcer in
 *   lib/enforce-policy.js never sees it and lib/route-policy.js correctly has
 *   no entry for it. That is the same mechanism the Telnyx and WooCommerce
 *   webhooks rely on: unauthenticated because of the MOUNT, never because of a
 *   branch inside the gate.
 *
 * MOUNT ORDER IS THE FIX
 *   This router must be registered before `express.static` and before the SPA
 *   catch-all in server.js. Mounted after either one, the catch-all answers
 *   first and Apple receives index.html with HTTP 200 — which is exactly the
 *   bug this file exists to remove, and which produces no error anywhere.
 *
 * NO REDIRECTS
 *   Apple follows no redirect when fetching an association document. The path
 *   is served literally, with no trailing-slash variant and no `.json` alias,
 *   because a 301 to a working URL reads to Apple as a failure.
 */

const express = require('express');
const { buildAssociation } = require('../lib/apple-site-association');

/** Logged at most once per process; see lib/apns-notify.js for the pattern. */
let didLogMissingTeamId = false;

/** Test hook for the "log the missing configuration once" behaviour. */
function resetMissingTeamIdLog() {
  didLogMissingTeamId = false;
}

/**
 * @param {{ association?: (env: NodeJS.ProcessEnv) => (object|null), env?: NodeJS.ProcessEnv }} [options]
 * @returns {import('express').Router}
 */
function createWellKnownRouter({ association = buildAssociation, env = process.env } = {}) {
  const router = express.Router();

  router.get('/apple-app-site-association', (_req, res) => {
    const document = association(env);

    if (!document) {
      // 404, not a placeholder document. iOS caches the association it is
      // given, so serving one with a wrong or absent Team ID breaks the link
      // and keeps it broken after the configuration is corrected. An absent
      // document simply means the link opens in Safari, which is the existing
      // behaviour and costs nobody anything.
      if (!didLogMissingTeamId) {
        console.log(
          'Universal links: apple-app-site-association is not served — set APPLE_TEAM_ID '
          + '(or APNS_TEAM_ID) to the 10-character Apple Developer Team ID'
        );
        didLogMissingTeamId = true;
      }
      return res.status(404).json({
        error: 'No app site association is published for this domain.',
        code: 'AASA_NOT_CONFIGURED'
      });
    }

    // `application/json` explicitly. Apple rejects any other type without
    // comment, and res.json() would otherwise be free to negotiate.
    res.type('application/json');
    // Short, but not zero. Apple's CDN caches this for its own reasons; a short
    // origin TTL means a Team ID correction propagates in minutes rather than
    // being pinned by an intermediary for a day.
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).send(JSON.stringify(document));
  });

  return router;
}

module.exports = createWellKnownRouter;
module.exports.createWellKnownRouter = createWellKnownRouter;
module.exports.resetMissingTeamIdLog = resetMissingTeamIdLog;
