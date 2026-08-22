'use strict';
/**
 * test/apple-site-association.test.js
 *
 * WHY THIS FILE EXISTS
 *   `GET /.well-known/apple-app-site-association` returned HTTP 200 with the
 *   SPA's index.html. The catch-all at the bottom of server.js answers every
 *   unmatched path, and that path was unmatched. Apple fetched it, found HTML
 *   where it required JSON, discarded it, and universal links silently never
 *   worked — no error, no log, no failing request, on either side. The only
 *   symptom was that the invitation link always opened Safari.
 *
 *   Two things therefore have to be true, and only one of them is about the
 *   document:
 *     1. The body, the status and the Content-Type are what Apple demands.
 *     2. The route is registered BEFORE express.static and before the SPA
 *        catch-all in server.js. That ordering IS the fix. A correct document
 *        served from the wrong position in the middleware stack is the original
 *        bug with more code in it, so the ordering is asserted against the text
 *        of server.js, following the precedent in test/analytics-api.test.js.
 *
 *   And one that is about safety rather than function: an unconfigured Team ID
 *   must produce a 404, never a placeholder. iOS caches the association it is
 *   given, so a wrong one breaks the link and keeps it broken after the
 *   configuration is corrected, whereas a missing one degrades to the browser.
 *
 * Offline: the environment is a literal object, and the one HTTP test binds
 * 127.0.0.1 on an ephemeral port. Nothing reaches Apple or the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  applicationIdentifier,
  buildAssociation,
  bundleId,
  teamId
} = require('../lib/apple-site-association');
const createWellKnownRouter = require('../routes/well-known');

const ROOT = path.join(__dirname, '..');
const SERVER_SOURCE_RAW = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/**
 * server.js with `//` comments blanked out, for the positional assertions
 * below.
 *
 * They compare `indexOf` offsets to prove one mount is registered before
 * another. Scanning the raw source finds the FIRST textual match, and the
 * comment above the /.well-known mount quotes `app.get('/{*splat}')` while
 * explaining why the ordering matters. So the test measured the position of a
 * comment describing the fix rather than the code implementing it, and failed
 * while the code was correct.
 *
 * Blanked rather than deleted, so every offset still lines up with the real
 * file and a failure message points at a usable position.
 */
const SERVER_SOURCE = SERVER_SOURCE_RAW
  .split('\n')
  .map(line => {
    const comment = line.indexOf('//');
    if (comment === -1) return line;
    // Naive, and adequate here: server.js has no `//` inside a string literal
    // on any line these assertions look for. A URL would be the usual
    // counter-example and there is none.
    return line.slice(0, comment) + ' '.repeat(line.length - comment);
  })
  .join('\n');

const TEAM_ID = 'A1B2C3D4E5';
const BUNDLE_ID = 'com.vicipeptides.inbox';

/** A configured environment with nothing else in it. */
function configuredEnv(extra = {}) {
  return { APPLE_TEAM_ID: TEAM_ID, ...extra };
}

// ── The document ────────────────────────────────────────────────────────────

test('the document is exactly the shape Apple parses', () => {
  const document = buildAssociation(configuredEnv());

  assert.deepEqual(document, {
    applinks: {
      details: [
        {
          appIDs: [`${TEAM_ID}.${BUNDLE_ID}`],
          components: [
            {
              '/': '/accept-invite',
              '?': { token: '?*' },
              comment: 'team invitation'
            }
          ]
        }
      ]
    }
  });

  // It has to survive a round trip through JSON.stringify unchanged, because
  // that is literally what is written to the socket.
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('only /accept-invite is claimed, so the browser UI stays reachable from a link', () => {
  const components = buildAssociation(configuredEnv()).applinks.details[0].components;

  assert.equal(components.length, 1, 'exactly one component, not a wildcard domain claim');
  assert.equal(components[0]['/'], '/accept-invite');

  // The property that matters is negative: nothing may claim the whole domain.
  // A '*' or '/' component would make EVERY link into this service open the
  // app, including the web inbox, which several people use on a phone and which
  // would become unreachable from any link the moment the app was installed.
  const serialised = JSON.stringify(components);
  assert.equal(serialised.includes('"*"'), false, 'no wildcard path may be claimed');
  assert.equal(components[0]['/'] === '/', false, 'the domain root may not be claimed');
});

test('the appID is TEAMID.bundleid, and the bundle id follows APNS_BUNDLE_ID', () => {
  assert.equal(applicationIdentifier(configuredEnv()), `${TEAM_ID}.${BUNDLE_ID}`);
  assert.equal(bundleId({}), BUNDLE_ID, 'defaults to the shipping bundle id');
  assert.equal(
    applicationIdentifier(configuredEnv({ APNS_BUNDLE_ID: 'com.example.other' })),
    `${TEAM_ID}.com.example.other`,
    'the push topic and the universal-link app id come from the same variable'
  );
  // A malformed override must not produce a malformed appID.
  assert.equal(bundleId({ APNS_BUNDLE_ID: 'not a bundle id' }), BUNDLE_ID);
});

test('the Team ID falls back to APNS_TEAM_ID, which already holds it in Railway', () => {
  assert.equal(teamId({ APNS_TEAM_ID: TEAM_ID }), TEAM_ID);
  assert.equal(teamId({ APPLE_TEAM_ID: TEAM_ID, APNS_TEAM_ID: 'ZZZZZZZZZZ' }), TEAM_ID,
    'the explicit variable wins when both are set');
  assert.equal(teamId({ APPLE_TEAM_ID: 'a1b2c3d4e5' }), TEAM_ID, 'normalised to upper case');
});

test('a Team ID that is not a Team ID is refused rather than published', () => {
  // These are the substitutions AGENTS.md warns about: an issuer UUID, a key
  // id of the wrong length, and a bundle id. Each would produce a document iOS
  // caches and acts on, and each would break the link permanently.
  for (const wrong of [
    '',
    '   ',
    'SHORT',
    'TOOMANYCHARS11',
    'c3b04f34-53c3-4e3d-9177-c392b9b58659',
    'com.vicipeptides.inbox'
  ]) {
    assert.equal(teamId({ APPLE_TEAM_ID: wrong }), null, `${JSON.stringify(wrong)} is not a Team ID`);
    assert.equal(buildAssociation({ APPLE_TEAM_ID: wrong }), null, 'no document is built');
  }
});

test('with no Team ID configured there is NO document, not a placeholder one', () => {
  assert.equal(buildAssociation({}), null);
  assert.equal(applicationIdentifier({}), null);
});

// ── The route ───────────────────────────────────────────────────────────────

/**
 * A faithful miniature of server.js's ordering: the well-known mount, then
 * express.static, then the SPA catch-all. The catch-all sends a marker rather
 * than the real index.html so a regression is unmistakable in the assertion.
 */
function buildApp(env) {
  const app = express();
  app.set('case sensitive routing', true);
  app.use('/.well-known', createWellKnownRouter({ env }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/{*splat}', (_req, res) => res.status(200).type('html').send('SPA_INDEX_HTML'));
  return app;
}

async function request(app, requestPath) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${requestPath}`, {
      redirect: 'manual'
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: await response.text()
    };
  } finally {
    server.close();
  }
}

test('the AASA path serves JSON, not the SPA — the whole point of this change', async () => {
  const response = await request(buildApp(configuredEnv()), '/.well-known/apple-app-site-association');

  assert.equal(response.status, 200);
  assert.match(response.contentType, /^application\/json\b/,
    'Apple rejects any other Content-Type without comment');
  assert.equal(response.body.includes('SPA_INDEX_HTML'), false,
    'the SPA catch-all must not answer this path');
  assert.equal(response.body.includes('<!doctype'), false);
  assert.deepEqual(JSON.parse(response.body), buildAssociation(configuredEnv()));
});

test('no redirect, and no .json alias — Apple follows neither', async () => {
  const app = buildApp(configuredEnv());

  const direct = await request(app, '/.well-known/apple-app-site-association');
  assert.equal(direct.status, 200, 'served literally, with no 301 to a canonical form');

  // A `.json` suffix is a DIFFERENT path and Apple never requests it. It must
  // not accidentally become a second, divergent copy of the document.
  const suffixed = await request(app, '/.well-known/apple-app-site-association.json');
  assert.equal(suffixed.body.includes('applinks'), false,
    'the extensioned path must not serve an association document');
});

test('an unconfigured service answers 404, so iOS caches nothing', async () => {
  const response = await request(buildApp({}), '/.well-known/apple-app-site-association');

  assert.equal(response.status, 404, 'a wrong association is worse than an absent one');
  assert.equal(response.body.includes('applinks'), false, 'no partial document leaks out');
  assert.equal(response.body.includes('SPA_INDEX_HTML'), false,
    'and it is still not the SPA — the catch-all must not reclaim the path');
  assert.equal(JSON.parse(response.body).code, 'AASA_NOT_CONFIGURED');
});

test('the document carries no credential and no customer data', async () => {
  const response = await request(
    buildApp(configuredEnv({ ASC_KEY_P8_BASE64: 'c2VjcmV0', SESSION_SECRET: 'hunter2' })),
    '/.well-known/apple-app-site-association'
  );
  for (const forbidden of ['secret', 'hunter2', 'c2VjcmV0', 'token=', 'password']) {
    assert.equal(response.body.toLowerCase().includes(forbidden.toLowerCase()), false,
      `${forbidden} must never appear in a publicly fetched document`);
  }
  // `token` DOES appear, as the name of the claimed query parameter. That is
  // the parameter's name, not anybody's token, and it is required by Apple.
  assert.equal(response.body.includes('"token"'), true);
});

// ── The ordering in server.js, which is the actual fix ──────────────────────

test('server.js mounts /.well-known before express.static and before the SPA catch-all', () => {
  const mount = SERVER_SOURCE.indexOf("app.use('/.well-known'");
  const staticMount = SERVER_SOURCE.indexOf('app.use(express.static(');
  const catchAll = SERVER_SOURCE.indexOf("app.get('/{*splat}'");

  assert.ok(mount > -1, 'the /.well-known router is mounted in server.js');
  assert.ok(staticMount > -1, 'express.static is still mounted');
  assert.ok(catchAll > -1, 'the SPA catch-all is still mounted');

  // Registered later than either of these and the request never reaches the
  // router: express.static would 404 into the catch-all, and the catch-all
  // would answer index.html with HTTP 200. That is the original bug.
  assert.ok(mount < staticMount, 'the AASA mount must precede express.static');
  assert.ok(mount < catchAll, 'the AASA mount must precede the SPA catch-all');
});

test('the AASA path is public: above the /api gate, and outside its prefix', () => {
  const gate = SERVER_SOURCE.indexOf("app.use('/api', requireAuth, resolveActor, createPolicyEnforcer())");
  const mount = SERVER_SOURCE.indexOf("app.use('/.well-known'");

  assert.ok(gate > -1, 'the /api authorisation gate is still registered');
  assert.ok(mount < gate, 'the AASA mount is registered before the /api gate');

  // Position is the belt; the prefix is the braces. lib/enforce-policy.js is
  // mounted on '/api' ONLY, so a path that does not start with /api is never
  // classified and never denied — the same mechanism the Telnyx and Woo
  // webhooks rely on. Apple fetches anonymously and reads a 401 as a missing
  // document, so this must never end up behind the gate.
  assert.equal("/.well-known/apple-app-site-association".startsWith('/api'), false);

  const { ROUTE_POLICY } = require('../lib/route-policy');
  const stray = ROUTE_POLICY.filter(entry => entry.path.includes('well-known'));
  assert.deepEqual(stray, [], 'a /.well-known policy entry would be dangling and meaningless');
});

test('the mount is /.well-known, spelled exactly — Apple requests no other casing', () => {
  // Express route matching is case-sensitive from server.js onwards, so a
  // capitalised mount would simply never be hit and would fail exactly as
  // silently as the original bug.
  assert.match(SERVER_SOURCE, /app\.use\('\/\.well-known', require\('\.\/routes\/well-known'\)\(\)\)/);
});
