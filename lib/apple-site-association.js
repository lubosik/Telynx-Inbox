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
 * WHY THE COMPONENT LIST IS A SHORT LIST AND NOT A DOMAIN CLAIM
 *   `components` is scoped to specific token-bearing paths and to nothing else.
 *   Each one is mailed to a person who is expected to finish the job in the
 *   app, so each one should open it. Claiming the whole domain, or adding a `*`
 *   component, would make EVERY link into this service open the app — including
 *   the browser UI itself, which several people use on a phone and which would
 *   become unreachable from any link once the app is installed.
 *
 *   Adding a path here is not free: iOS caches this document, so a claimed path
 *   that the app cannot handle becomes a link that opens the app and then does
 *   nothing. Claim a path only once something in the app answers it.
 *
 * STAGED CLAIMS, AND WHY THE EMAIL-CHANGE PATH IS ONE
 *   `/confirm-email-change` is the third mailed, token-bearing link in this
 *   service and it belongs in the app for exactly the same reasons the other
 *   two do. It is nevertheless NOT published by default, and that is the whole
 *   point of STAGEABLE_COMPONENTS below.
 *
 *   The backend half of a universal link ships in a deploy; the client half
 *   ships in a TestFlight build, days later, and the build already in the field
 *   cannot be updated retroactively. Publish the claim first and every person
 *   with the current build taps their confirmation link, watches the app open,
 *   and lands nowhere — and because iOS caches this document, backing that out
 *   is not instant either. Publish it after, and the link merely opens the web
 *   page, which is the behaviour they have today and which finishes the job.
 *
 *   So the claim is code, complete and tested, behind one environment switch:
 *
 *       APPLE_CLAIM_EMAIL_CHANGE=enabled
 *
 *   Flip it in Railway once a build that routes `/confirm-email-change` is in
 *   the field. Flipping it back is a variable change and a restart, with no
 *   App Store round trip. A staged path must ALREADY be answered on the web
 *   before it can be flipped on; test/email-change-link.test.js asserts that,
 *   so enabling the switch can never produce a dead link for anyone.
 */

/** Apple Developer Team IDs are exactly ten alphanumeric characters. */
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/i;

/** A reverse-DNS bundle identifier. Deliberately strict: it lands in appIDs. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

const DEFAULT_BUNDLE_ID = 'com.vicipeptides.inbox';

/** The paths this app claims. Not configurable; see the header. */
const INVITATION_PATH = '/accept-invite';
const PASSWORD_RESET_PATH = '/reset-password';
/** Staged. Published only when APPLE_CLAIM_EMAIL_CHANGE says so. */
const EMAIL_CHANGE_PATH = '/confirm-email-change';

/**
 * Every claimed path, in the order they appear in the document.
 *
 * Apple evaluates `components` in order and the first match wins, so a list
 * with no overlap between its entries — which this is, two distinct literal
 * paths — behaves identically whatever the order. Kept as data so that
 * "which paths does this app claim?" has exactly one answer.
 */
const CLAIMED_COMPONENTS = Object.freeze([
  Object.freeze({ '/': INVITATION_PATH, '?': Object.freeze({ token: '?*' }), comment: 'team invitation' }),
  Object.freeze({ '/': PASSWORD_RESET_PATH, '?': Object.freeze({ token: '?*' }), comment: 'password reset' })
]);

/**
 * Claims that are written, tested and switched off.
 *
 * Keyed by the environment variable that turns each one on. A path here is NOT
 * in the published document until its switch is set, so the shipped iOS build
 * cannot be handed a link it does not route. See the header for why that
 * ordering is not optional.
 *
 * @type {ReadonlyArray<{env: string, component: object}>}
 */
const STAGEABLE_COMPONENTS = Object.freeze([
  Object.freeze({
    env: 'APPLE_CLAIM_EMAIL_CHANGE',
    component: Object.freeze({
      '/': EMAIL_CHANGE_PATH,
      '?': Object.freeze({ token: '?*' }),
      comment: 'email change confirmation'
    })
  })
]);

/**
 * Is a staged claim switched on?
 *
 * Opt-in, and strictly: only `enabled`, `true`, `yes` or `1` count. Every other
 * value, including an empty string and an unset variable, leaves the claim off.
 * A typo must fail towards "the link opens the web page", never towards "the
 * link opens an app that cannot answer it". This is the opposite polarity to
 * LEGACY_SHARED_LOGIN in routes/auth.js, which defaults ON, because the
 * consequence of being wrong runs the other way.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function stagedClaimEnabled(name, env = process.env) {
  const value = String(env[name] || '').trim().toLowerCase();
  return value === 'enabled' || value === 'true' || value === 'yes' || value === '1';
}

/**
 * Every component the document should carry for this environment: the
 * permanent list, plus any staged claim whose switch is set.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object[]} deep copies, safe for the caller to hand to JSON
 */
function activeComponents(env = process.env) {
  const staged = STAGEABLE_COMPONENTS
    .filter(entry => stagedClaimEnabled(entry.env, env))
    .map(entry => entry.component);
  // Deep-copied out of the frozen constants. The document is handed to
  // JSON.stringify by the route, and a caller that mutated a shared frozen
  // object would either throw or silently change what every later request
  // serves.
  return [...CLAIMED_COMPONENTS, ...staged].map(component => ({
    '/': component['/'],
    '?': { ...component['?'] },
    comment: component.comment
  }));
}

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
          components: activeComponents(env)
        }
      ]
    }
  };
}

module.exports = {
  BUNDLE_ID_PATTERN,
  CLAIMED_COMPONENTS,
  DEFAULT_BUNDLE_ID,
  EMAIL_CHANGE_PATH,
  INVITATION_PATH,
  PASSWORD_RESET_PATH,
  STAGEABLE_COMPONENTS,
  TEAM_ID_PATTERN,
  activeComponents,
  applicationIdentifier,
  buildAssociation,
  bundleId,
  stagedClaimEnabled,
  teamId
};
