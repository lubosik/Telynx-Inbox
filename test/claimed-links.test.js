'use strict';
/**
 * A universal link is claimed in one place and answered in three, and nothing
 * compiles them together.
 *
 *   lib/apple-site-association.js   tells Apple which paths open the app
 *   ios/.../InviteLinkRouter.swift  decides what the app does with them
 *   server.js                        serves the page for anyone without the app
 *
 * Every disagreement between those three is silent and lands on a person who
 * cannot get in. A path claimed but not routed in the app opens the app to
 * nothing. A path claimed but not served on the web sends someone without the
 * app to the SPA login screen with no explanation. Both have happened here:
 * /accept-invite shipped with no Express route, and /reset-password was claimed
 * by the association before either client could answer it.
 *
 * These are text assertions over source. Crude, but they catch exactly the
 * drift that produced those two bugs, and they cost nothing to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SERVER = read('server.js');
const ROUTER_SWIFT = read('ios/ViciInbox/App/InviteLinkRouter.swift');

/** A configured environment with no staged claim switched on. */
function baseEnv(extra = {}) {
  return { APPLE_TEAM_ID: 'ABCDE12345', APNS_BUNDLE_ID: 'com.vicipeptides.inbox', ...extra };
}

/** The paths the association actually publishes to Apple, as shipped. */
function claimedPaths() {
  const { buildAssociation } = require('../lib/apple-site-association');
  const document = buildAssociation(baseEnv());
  return document.applinks.details[0].components.map(component => component['/']).sort();
}

/**
 * Every path the association module knows about: published now, plus the
 * staged ones that a single environment variable would publish.
 *
 * A staged claim exists because the two halves of a universal link ship on
 * different clocks — the backend in a deploy, the app in a TestFlight build
 * days later — and iOS caches the document, so publishing first produces a
 * link that opens the app to nothing. The claim is therefore written, tested
 * and switched off. See STAGEABLE_COMPONENTS in lib/apple-site-association.js.
 */
function knownPaths() {
  const { CLAIMED_COMPONENTS, STAGEABLE_COMPONENTS } = require('../lib/apple-site-association');
  return [
    ...CLAIMED_COMPONENTS.map(component => component['/']),
    ...STAGEABLE_COMPONENTS.map(entry => entry.component['/'])
  ].sort();
}

test('every claimed link is routed inside the iOS app', () => {
  // A claimed path the app cannot answer is worse than not claiming it: iOS
  // opens the app and the person sees whatever happened to be on screen.
  for (const claimed of claimedPaths()) {
    assert.ok(
      ROUTER_SWIFT.includes(`"${claimed}"`),
      `${claimed} is claimed in lib/apple-site-association.js but InviteLinkRouter.swift ` +
      'does not list it. The app would open and do nothing.'
    );
  }
});

test('every claimed link is served on the web for anyone without the app', () => {
  // Universal links only open an app that is installed. Someone tapping this on
  // a phone with no app, or on a laptop, must reach a real page rather than the
  // SPA login screen.
  for (const claimed of claimedPaths()) {
    assert.match(
      SERVER, new RegExp(`app\\.get\\('${claimed}'`),
      `${claimed} is claimed but server.js has no route for it, so it falls ` +
      'through to the SPA catch-all and serves index.html.'
    );
  }
});

test('each claimed link is served before the static handler and the catch-all', () => {
  // Registered after either one and the request never reaches the route: the
  // catch-all answers index.html with HTTP 200. This is the same mount-order
  // bug that made /.well-known/apple-app-site-association return HTML, which
  // silently disabled universal links entirely.
  //
  // Comments are blanked first: server.js explains this requirement in prose
  // that quotes the very strings being searched for, and the raw indexOf finds
  // the explanation before the code.
  const code = SERVER.split('\n')
    .map(line => {
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment) + ' '.repeat(line.length - comment);
    })
    .join('\n');

  const staticMount = code.indexOf('app.use(express.static(');
  const catchAll = code.indexOf("app.get('/{*splat}'");
  assert.ok(staticMount > -1 && catchAll > -1, 'the static handler and catch-all are still mounted');

  for (const claimed of claimedPaths()) {
    const route = code.indexOf(`app.get('${claimed}'`);
    assert.ok(route > -1, `${claimed} is routed`);
    assert.ok(route < staticMount, `${claimed} must be registered before express.static`);
    assert.ok(route < catchAll, `${claimed} must be registered before the SPA catch-all`);
  }
});

test('the app claims no path the association module has never heard of', () => {
  // The reverse direction, and the one that had to loosen by exactly one step
  // when staged claims arrived.
  //
  // The original assertion was a deepEqual against the PUBLISHED list, which
  // made the two halves of a universal link impossible to land separately: the
  // backend claim and the Swift handler had to appear in the same commit or CI
  // went red. That is the wrong constraint on a repository where the app ships
  // days behind the server, and it is the constraint that makes people publish
  // a claim before the app can answer it just to keep the build green.
  //
  // So the property is now the one that actually matters, split in two:
  //
  //   * the app may declare a path the module knows about but has not published
  //     yet (below), because that link simply opens the web page in the
  //     meantime, which is the behaviour it has today;
  //   * the app may NOT declare a path the module has never heard of, because
  //     that one can never fire and reads as "universal links are broken";
  //   * and everything PUBLISHED must still be routed in the app and served on
  //     the web, which the two tests above assert unchanged.
  const declared = [...ROUTER_SWIFT.matchAll(/"(\/[a-z-]+)"\s*:/g)].map(match => match[1]).sort();
  assert.ok(declared.length > 0, 'InviteLinkRouter declares at least one path');

  const known = new Set(knownPaths());
  const unknown = declared.filter(path => !known.has(path));
  assert.deepEqual(
    unknown, [],
    'InviteLinkRouter declares a path that is neither in CLAIMED_COMPONENTS nor in ' +
    'STAGEABLE_COMPONENTS, so Apple is never told about it and the link can never fire'
  );
});

test('every path the association module knows is already answered on the web', () => {
  // The precondition for turning a staged claim on. A published path that
  // nothing serves drops anyone without the app on the SPA login screen with no
  // explanation, and flipping an environment variable must never be able to
  // cause that. Asserting it over the KNOWN set rather than the published one
  // means the page exists before the switch does anything, which is the whole
  // safety property of staging.
  for (const known of knownPaths()) {
    assert.match(
      SERVER, new RegExp(`app\\.get\\('${known}'`),
      `${known} is claimable in lib/apple-site-association.js but server.js has no ` +
      'route for it, so anybody without the app falls through to the SPA catch-all.'
    );
  }
});
