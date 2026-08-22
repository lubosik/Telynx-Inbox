'use strict';
/**
 * lib/apple-site-association.js — the Apple App Site Association document.
 *
 * WHAT THIS IS FOR
 *   The team invitation email links to `${APP_URL}/accept-invite?token=...`.
 *   That URL is a Universal Link: on an iPhone with the app installed, iOS is
 *   supposed to hand the tap to Vici Inbox instead of Safari. It only does that
 *   if Apple can fetch a valid association document from this domain first.
 *
 * THE BUG THIS EXISTS TO FIX
 *   `GET /.well-known/apple-app-site-association` returned HTTP 200 with the
 *   SPA's index.html, because the catch-all at the bottom of server.js answers
 *   every unmatched path. Apple fetched HTML where it expected JSON, discarded
 *   it, and universal links silently never worked. Nothing errored, nothing was
 *   logged, and the only symptom was that the link always opened the browser.
 *   routes/well-known.js must therefore be mounted BEFORE express.static and
 *   before `app.get('/{*splat}')`; test/apple-site-association.test.js asserts
 *   that ordering against the source of server.js, because the ordering IS the
 *   fix and a future mount added above it would silently undo this.
 *
 * WHAT APPLE ENFORCES, EACH OF WHICH IS A SILENT FAILURE WHEN WRONG
 *   - Content-Type must be application/json. HTML is rejected without comment.
 *   - The path has NO `.json` extension.
 *   - It must be reachable over HTTPS with no redirect and no authentication,
 *     so the mount sits above the `/api` gate and outside its prefix.
 *   - `appIDs` entries are `TEAMID.bundleid`, with the 10-character Apple
 *     Developer Team ID as the prefix.
 *
 * WHY AN UNCONFIGURED TEAM ID IS A 404 AND NOT A BEST GUESS
 *   iOS caches the association document, and a document naming the wrong team
 *   is worse than an absent one: the link stops working and keeps not working
 *   after the configuration is fixed. An absent document degrades to "the link
 *   opens in Safari", which is the existing behaviour and is harmless. So
 *   `buildAssociation()` returns null rather than emitting a placeholder, and
 *   the route answers 404.
 *
 * WHY THE COMPONENT LIST IS ONE PATH
 *   `components` is scoped to `/accept-invite` with a `token` query parameter.
 *   Claiming the whole domain would make EVERY link into this service open the
 *   app — including the browser UI itself, which several people use on a phone
 *   and which would become unreachable from any link once the app is installed.
 */

/** Apple Developer Team IDs are exactly ten alphanumeric characters. */
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/i;

/** A reverse-DNS bundle identifier. Deliberately strict: it lands in appIDs. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

const DEFAULT_BUNDLE_ID = 'com.vicipeptides.inbox';

/** The one path this app claims. Not configurable; see the header. */
const INVITATION_PATH = '/accept-invite';

/**
 * The Apple Developer Team ID, or null when it is not configured.
 *
 * `APPLE_TEAM_ID` is the explicit name. `APNS_TEAM_ID` is the fallback because
 * it is already set in Railway and holds the SAME value — AGENTS.md documents
 * it as "10-char Apple Developer Team ID". Reading it here means universal
 * links work on the existing deployment without a new variable, while
 * `APPLE_TEAM_ID` stays available for the day the two ever need to differ.
 *
 * Neither the App Store Connect issuer id nor its key id is a Team ID; AGENTS.md
 * calls them distinct identifiers and they must never be substituted here.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} the uppercased Team ID, or null
 */
function teamId(env = process.env) {
  const candidates = [env.APPLE_TEAM_ID, env.APNS_TEAM_ID];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (TEAM_ID_PATTERN.test(value)) return value.toUpperCase();
  }
  return null;
}

/**
 * The app's bundle identifier. Shares APNS_BUNDLE_ID with lib/apns-notify.js,
 * which defaults to the same constant, so the push topic and the universal-link
 * app id cannot drift apart.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function bundleId(env = process.env) {
  const configured = String(env.APNS_BUNDLE_ID || '').trim();
  return BUNDLE_ID_PATTERN.test(configured) ? configured : DEFAULT_BUNDLE_ID;
}

/**
 * `TEAMID.com.vicipeptides.inbox`, or null when the Team ID is unconfigured.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function applicationIdentifier(env = process.env) {
  const team = teamId(env);
  return team ? `${team}.${bundleId(env)}` : null;
}

/**
 * The association document, or null when it cannot be built correctly.
 *
 * Returning null is the whole safety property of this module: the caller must
 * answer 404 rather than serve a document Apple will cache and act on. See the
 * header for why a wrong document is worse than a missing one.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null}
 */
function buildAssociation(env = process.env) {
  const appID = applicationIdentifier(env);
  if (!appID) return null;

  return {
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: [
            {
              '/': INVITATION_PATH,
              '?': { token: '?*' },
              comment: 'team invitation'
            }
          ]
        }
      ]
    }
  };
}

module.exports = {
  BUNDLE_ID_PATTERN,
  DEFAULT_BUNDLE_ID,
  INVITATION_PATH,
  TEAM_ID_PATTERN,
  applicationIdentifier,
  buildAssociation,
  bundleId,
  teamId
};
