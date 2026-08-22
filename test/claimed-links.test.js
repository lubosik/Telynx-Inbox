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

/** The paths the association actually publishes to Apple. */
function claimedPaths() {
  const { buildAssociation } = require('../lib/apple-site-association');
  const document = buildAssociation({
    APPLE_TEAM_ID: 'ABCDE12345',
    APNS_BUNDLE_ID: 'com.vicipeptides.inbox'
  });
  return document.applinks.details[0].components.map(component => component['/']).sort();
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

test('the app claims no path the association does not', () => {
  // The reverse direction. A path the app claims but Apple was never told
  // about simply never fires, which reads as "universal links are broken"
  // rather than as a mismatch.
  const declared = [...ROUTER_SWIFT.matchAll(/"(\/[a-z-]+)"\s*:/g)].map(match => match[1]).sort();
  assert.ok(declared.length > 0, 'InviteLinkRouter declares at least one path');
  assert.deepEqual(
    declared, claimedPaths(),
    'InviteLinkRouter.claimedPaths and CLAIMED_COMPONENTS must list the same paths'
  );
});
