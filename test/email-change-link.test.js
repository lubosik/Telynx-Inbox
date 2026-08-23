'use strict';
/**
 * test/email-change-link.test.js — the confirmation LINK, as opposed to the
 * confirmation mechanism.
 *
 * test/email-change.test.js already covers the security of the flow: the token
 * is stored only as a hash, it is single use, it expires, the response is the
 * same whether or not the address exists, and the old address is told. What it
 * does not cover is where the link goes when somebody taps it, which is a
 * separate feature with a separate failure mode and a history of silent
 * breakage in this repository:
 *
 *   * /accept-invite shipped claimed by Apple with no Express route, so anybody
 *     without the app landed on the SPA login screen.
 *   * /.well-known/apple-app-site-association returned index.html with HTTP
 *     200, so universal links never worked at all and nothing was logged.
 *
 * The owner's requirement is that the confirmation link opens the iOS app. That
 * has three halves and only two of them are in this repository's backend, so
 * what is asserted here is:
 *
 *   1. The claim exists, is correctly shaped, and is STAGED — off until an iOS
 *      build that routes the path is in the field. iOS caches the association
 *      document, so publishing before the app can answer produces a link that
 *      opens the app to nothing and cannot be withdrawn instantly.
 *   2. The web page that answers the same URL everywhere else exists, is
 *      mounted ahead of the static handler and the catch-all, and finishes the
 *      job rather than telling somebody to install an app.
 *   3. The page never renders, links or logs the token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CLAIMED_COMPONENTS,
  EMAIL_CHANGE_PATH,
  STAGEABLE_COMPONENTS,
  activeComponents,
  buildAssociation,
  stagedClaimEnabled
} = require('../lib/apple-site-association');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SERVER = read('server.js');
const PAGE = read('public/confirm-email-change.html');
const USERS = read('routes/users.js');

const TEAM_ID = 'ABCDE12345';
const configured = (extra = {}) => ({ APPLE_TEAM_ID: TEAM_ID, ...extra });

// ── The claim ──────────────────────────────────────────────────────────────

test('the email-change path is staged, not published', () => {
  // The default must be off. A build already on somebody's phone cannot be
  // updated retroactively, so a claim published ahead of it is a link that
  // opens the app and does nothing.
  const paths = activeComponents(configured()).map(component => component['/']);
  assert.deepEqual(paths, ['/accept-invite', '/reset-password']);
  assert.equal(paths.includes(EMAIL_CHANGE_PATH), false);

  const staged = STAGEABLE_COMPONENTS.find(entry => entry.component['/'] === EMAIL_CHANGE_PATH);
  assert.ok(staged, 'the claim is written and switched off, not absent');
  assert.equal(staged.env, 'APPLE_CLAIM_EMAIL_CHANGE');
  assert.equal(
    CLAIMED_COMPONENTS.some(component => component['/'] === EMAIL_CHANGE_PATH), false,
    'it must not also be in the permanent list, or the switch does nothing'
  );
});

test('the switch is opt-in, and a typo leaves it off', () => {
  // Failing towards "the link opens the web page" is harmless; failing towards
  // "the link opens an app that cannot answer it" is not, and is cached by iOS.
  for (const value of ['enabled', 'true', 'yes', '1', 'ENABLED', ' True ']) {
    assert.equal(stagedClaimEnabled('X', { X: value }), true, `${value} enables`);
  }
  for (const value of [undefined, '', ' ', 'no', 'false', 'off', 'disabled', 'enable', 'y', '0', 'ENABLE']) {
    assert.equal(stagedClaimEnabled('X', { X: value }), false, `${JSON.stringify(value)} must not enable`);
  }
});

test('turning it on publishes exactly one more component, correctly shaped', () => {
  const document = buildAssociation(configured({ APPLE_CLAIM_EMAIL_CHANGE: 'enabled' }));
  const components = document.applinks.details[0].components;

  assert.equal(components.length, 3);
  assert.deepEqual(components[2], {
    '/': '/confirm-email-change',
    '?': { token: '?*' },
    comment: 'email change confirmation'
  });

  // The same rules the other two live under. A wildcard or a root claim would
  // take every URL on this domain away from the browser for anybody with the
  // app installed, including the web inbox.
  const serialised = JSON.stringify(components);
  assert.equal(serialised.includes('"*"'), false, 'no wildcard path may be claimed');
  assert.equal(components.some(component => component['/'] === '/'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('publishing it does not mutate the frozen constants', () => {
  // buildAssociation() hands its output to JSON.stringify, and a caller that
  // mutated a shared frozen object would either throw or silently change what
  // every later request serves.
  const first = activeComponents(configured({ APPLE_CLAIM_EMAIL_CHANGE: 'enabled' }));
  first[2]['/'] = '/hijacked';
  first[2]['?'].token = 'tampered';
  const second = activeComponents(configured({ APPLE_CLAIM_EMAIL_CHANGE: 'enabled' }));
  assert.equal(second[2]['/'], '/confirm-email-change');
  assert.deepEqual(second[2]['?'], { token: '?*' });
});

test('an unconfigured Team ID still means no document at all', () => {
  // Staging must not have created a way to publish a document with no team.
  assert.equal(buildAssociation({ APPLE_CLAIM_EMAIL_CHANGE: 'enabled' }), null);
});

// ── The page that answers it everywhere else ───────────────────────────────

test('the confirmation URL and the claimed path are the same path', () => {
  // The link in the email is built by confirmUrlFor() in routes/users.js. If
  // that path and the claimed one ever drift, the claim silently stops
  // matching and every link opens the browser again with no error anywhere.
  const built = USERS.match(/\$\{base\}(\/[a-z-]+)\?token=/);
  assert.ok(built, 'confirmUrlFor still builds the link from a literal path');
  assert.equal(built[1], EMAIL_CHANGE_PATH);
});

test('server.js answers the path, before the static handler and the catch-all', () => {
  // Registered after either one and the request never reaches the route: the
  // catch-all serves index.html with HTTP 200. Comments are blanked first
  // because server.js explains this requirement in prose that quotes the very
  // strings being searched for.
  const code = SERVER.split('\n')
    .map(line => {
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment) + ' '.repeat(line.length - comment);
    })
    .join('\n');

  const route = code.indexOf(`app.get('${EMAIL_CHANGE_PATH}'`);
  assert.ok(route > -1, 'the page is routed');
  assert.ok(route < code.indexOf('app.use(express.static('), 'before express.static');
  assert.ok(route < code.indexOf("app.get('/{*splat}'"), 'before the SPA catch-all');
  // Not under /api, so the policy enforcer never sees it. Whoever opens this
  // link has no session and must not need one.
  assert.equal(EMAIL_CHANGE_PATH.startsWith('/api'), false);
});

test('the page is served with no-store, because the URL carries a live token', () => {
  const handler = SERVER.slice(SERVER.indexOf(`app.get('${EMAIL_CHANGE_PATH}'`));
  const body = handler.slice(0, handler.indexOf('});') + 3);
  assert.match(body, /no-store, private/);
  assert.match(body, /confirm-email-change\.html/);
});

test('the page finishes the job rather than sending somebody to the app', () => {
  // The opposite choice to public/accept-invite.html, and deliberately. An
  // invitee is meant to end up in the app; somebody confirming an address
  // already has an account and may be reading their mail on a laptop, and
  // refusing here would strand a pending change that is already blocking their
  // next attempt.
  assert.match(PAGE, /\/auth\/email-change\/confirm/);
  assert.match(PAGE, /method:\s*'POST'/);
  // And it says so once it has worked, which is what the email promises.
  assert.match(PAGE, /Your email address is confirmed/);
});

test('the page never renders, links or stores the token', () => {
  // It is a live single-use credential. It goes into one POST body and nowhere
  // else: not into the DOM, not into an href, not into console, not into
  // storage, and it is stripped out of the address bar before the request.
  assert.equal(/console\.(log|warn|error|info)/.test(PAGE), false, 'nothing is logged');
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(PAGE), false, 'nothing is stored');
  assert.equal(/innerHTML/.test(PAGE), false, 'nothing is injected as markup');
  assert.match(PAGE, /history\.replaceState/, 'the token is stripped from the address bar');
  // The only place the value appears is the request body.
  const tokenUses = (PAGE.match(/\btoken\b(?!s)/g) || []).length;
  assert.ok(tokenUses > 0 && tokenUses < 40, 'the token is referenced, but not everywhere');
});

test('the page sends no cookie, because a mailbox is what is being proved', () => {
  // Whoever opens the link may be on a device that has never had a session, and
  // POST /auth/email-change/confirm deliberately does not sign anybody in.
  assert.match(PAGE, /credentials:\s*'omit'/);
});

test('the page applies the same token bounds the server does', () => {
  // routes/auth.js answers EMAIL_CHANGE_NOT_FOUND outside 16..512 characters
  // with no database read, so checking first turns a truncated link into an
  // explanation instead of a pointless round trip.
  assert.match(PAGE, /MIN_TOKEN_LENGTH = 16/);
  assert.match(PAGE, /MAX_TOKEN_LENGTH = 512/);
});

test('the page is standalone: no bundle, no font, no third-party request', () => {
  // Same rule as public/reset-password.html and public/accept-invite.html.
  // Anything loaded from another origin on this page sees a URL with a live
  // credential in the referrer.
  assert.equal(/<script[^>]+src=/.test(PAGE), false, 'no external script');
  assert.equal(/https?:\/\/(?!schemas)/.test(PAGE.replace(/\$\{APP_URL\}/g, '')), false,
    'no absolute URL to anywhere');
  assert.match(PAGE, /<meta name="referrer" content="no-referrer">/);
  assert.match(PAGE, /<meta name="robots" content="noindex, nofollow">/);
});

test('a person with JavaScript switched off is told, not left staring', () => {
  assert.match(PAGE, /<noscript>/);
  assert.match(PAGE, /Nothing has changed on your account/);
});

// ── The environment switch is documented where an operator will look ───────

test('the switch is named in .env.example with the order it must be flipped in', () => {
  const example = read('.env.example');
  assert.match(example, /^APPLE_CLAIM_EMAIL_CHANGE=/m);
  assert.match(example, /iOS build/);
  assert.match(example, /confirm-email-change/);
});
