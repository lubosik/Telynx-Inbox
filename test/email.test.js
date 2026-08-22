'use strict';
/**
 * test/email.test.js — lib/email.js and lib/email-templates.js.
 *
 * WHY THIS FILE EXISTS
 *   Email was added to a service that had none, and the state it will actually
 *   ship in is UNCONFIGURED: `MATON_API_KEY` does not exist in Railway yet. So
 *   the path that matters most on day one is the one where nothing is set up,
 *   and the requirement for it is unusually strict — it must not throw, must
 *   not reject, must not fail the caller, and must not spam the log once per
 *   invitation. That is the first block below.
 *
 *   The second thing this guards is silence about secrets. An invitation email
 *   body contains a live credential in a URL. A well-meant `console.error(err)`
 *   or a logged request body would put a working invitation into a log
 *   aggregator permanently, and it would look like ordinary diagnostics. Every
 *   failure mode is therefore driven here with a captured console, and the
 *   assertion is against everything written, not against a specific call.
 *
 * OFFLINE
 *   `fetch` is injected in every test. Nothing in this file opens a socket or
 *   resolves a name, and no test reads the real process environment for
 *   credentials — `env` is passed explicitly so a developer with a real key in
 *   their shell gets the same result as CI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendEmail,
  isEmailConfigured,
  appUrl,
  redactEmail,
  buildRawMessage,
  resetMissingConfigurationLog,
  MATON_SEND_ENDPOINT
} = require('../lib/email');

/** Decode the base64url `raw` back into the RFC822 message actually sent. */
function decodeRaw(rawBase64Url) {
  return Buffer.from(rawBase64Url, 'base64url').toString('utf8');
}
const { invitationEmail, roleLabel, formatExpiry, escapeHtml } = require('../lib/email-templates');

// ── Helpers ────────────────────────────────────────────────────────────────

const CONFIGURED = Object.freeze({
  MATON_API_KEY: 'maton_test_SUPERSECRETKEY_do_not_log',
  MATON_GMAIL_CONNECTION_ID: 'conn_TESTCONNECTIONID_do_not_log',
  EMAIL_FROM: 'support@vicipeptides.com',
  EMAIL_FROM_NAME: 'Vici Inbox',
  APP_URL: 'https://inbox.example.com'
});

/**
 * Captures everything the module writes to the console, on every level.
 * Assertions run against the concatenation, so a secret cannot escape by being
 * written at a level a test forgot to spy on.
 */
function captureConsole(run) {
  const lines = [];
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = {};
  for (const level of levels) {
    originals[level] = console[level];
    console[level] = (...args) => { lines.push(args.map(value => String(value)).join(' ')); };
  }
  const restore = () => { for (const level of levels) console[level] = originals[level]; };
  const finished = (async () => run())();
  return finished.then(
    result => { restore(); return { result, log: lines.join('\n'), lines }; },
    error => { restore(); throw error; }
  );
}

/** A fetch that records its call and answers however the test wants. */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  impl.calls = calls;
  return impl;
}

function okResponse(body = { id: 'msg_123' }) {
  return { ok: true, status: 200, json: async () => body };
}

// ── Not configured: the path that runs on deploy day ───────────────────────

test('with no MATON_API_KEY it reports not_configured instead of throwing', async () => {
  resetMissingConfigurationLog();
  const fetchImpl = fakeFetch(() => okResponse());

  const { result } = await captureConsole(() => sendEmail(
    { to: 'jane@example.com', subject: 'Hi', text: 'Body' },
    {
      env: {
        MATON_GMAIL_CONNECTION_ID: CONFIGURED.MATON_GMAIL_CONNECTION_ID,
        EMAIL_FROM: CONFIGURED.EMAIL_FROM
      },
      fetchImpl
    }
  ));

  assert.deepEqual(result, { sent: false, reason: 'not_configured' });
  assert.equal(fetchImpl.calls.length, 0, 'nothing may be dispatched without a key');
});

test('every partial configuration is not_configured, never a half-send', async () => {
  // A missing connection id or from-address produces a gateway error nobody
  // can read, so a partial set must be refused as firmly as an empty one.
  const partials = [
    { MATON_API_KEY: CONFIGURED.MATON_API_KEY },
    { MATON_GMAIL_CONNECTION_ID: CONFIGURED.MATON_GMAIL_CONNECTION_ID },
    { EMAIL_FROM: CONFIGURED.EMAIL_FROM },
    { MATON_API_KEY: CONFIGURED.MATON_API_KEY, MATON_GMAIL_CONNECTION_ID: CONFIGURED.MATON_GMAIL_CONNECTION_ID },
    { MATON_API_KEY: CONFIGURED.MATON_API_KEY, EMAIL_FROM: CONFIGURED.EMAIL_FROM }
  ];

  for (const env of partials) {
    resetMissingConfigurationLog();
    const fetchImpl = fakeFetch(() => okResponse());
    const { result } = await captureConsole(() => sendEmail(
      { to: 'jane@example.com', subject: 'Hi', text: 'Body' }, { env, fetchImpl }
    ));
    assert.deepEqual(result, { sent: false, reason: 'not_configured' }, `partial set: ${Object.keys(env)}`);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('the missing-configuration notice is logged once, not once per send', async () => {
  resetMissingConfigurationLog();
  const fetchImpl = fakeFetch(() => okResponse());
  const options = { env: {}, fetchImpl };

  const { lines } = await captureConsole(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sendEmail({ to: 'jane@example.com', subject: 'Hi', text: 'Body' }, options);
    }
  });

  const notices = lines.filter(line => line.includes('not configured'));
  assert.equal(notices.length, 1, `expected exactly one notice, got ${notices.length}`);
});

test('isEmailConfigured requires the key, the connection and the from-address', () => {
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({ MATON_API_KEY: 'k' }), false);
  assert.equal(isEmailConfigured({ MATON_API_KEY: 'k', MATON_GMAIL_CONNECTION_ID: 'c' }), false);
  assert.equal(isEmailConfigured({ MATON_API_KEY: 'k', EMAIL_FROM: 'a@b.c' }), false);
  assert.equal(
    isEmailConfigured({ MATON_API_KEY: 'k', MATON_GMAIL_CONNECTION_ID: 'c', EMAIL_FROM: 'a@b.c' }),
    true
  );
  // EMAIL_FROM_NAME is cosmetic and must not gate a send.
  assert.equal(
    isEmailConfigured({ MATON_API_KEY: 'k', MATON_GMAIL_CONNECTION_ID: 'c', EMAIL_FROM: 'a@b.c', EMAIL_FROM_NAME: '' }),
    true
  );
});

// ── A configured send ──────────────────────────────────────────────────────

test('a configured send posts to the Maton gateway with the bearer token and connection header', async () => {
  const fetchImpl = fakeFetch(() => okResponse({ id: 'msg_abc' }));

  const result = await sendEmail(
    { to: 'jane@example.com', subject: 'Welcome', text: 'Plain', html: '<p>Rich</p>' },
    { env: CONFIGURED, fetchImpl }
  );

  assert.equal(result.sent, true);
  assert.equal(result.id, 'msg_abc');
  assert.equal(fetchImpl.calls.length, 1);

  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, MATON_SEND_ENDPOINT);
  assert.equal(url, 'https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages/send');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${CONFIGURED.MATON_API_KEY}`);
  // The connection id is a HEADER, not a body field. Getting this wrong is the
  // single easiest way to send against the wrong mailbox, so it is asserted
  // rather than assumed.
  assert.equal(init.headers['Maton-Connection'], CONFIGURED.MATON_GMAIL_CONNECTION_ID);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal, 'the request must be abortable so a hung provider cannot pin a handler');

  // The body is Gmail's shape: one key, a base64url RFC822 message.
  const payload = JSON.parse(init.body);
  assert.deepEqual(Object.keys(payload), ['raw']);
  assert.match(payload.raw, /^[A-Za-z0-9_-]+$/, 'raw must be base64url with no padding');
});

test('the encoded message carries the right headers and both alternative parts', async () => {
  const fetchImpl = fakeFetch(() => okResponse());

  await sendEmail(
    { to: 'jane@example.com', subject: 'Welcome', text: 'Plain body', html: '<p>Rich body</p>' },
    { env: CONFIGURED, fetchImpl }
  );

  const raw = decodeRaw(JSON.parse(fetchImpl.calls[0].init.body).raw);

  assert.match(raw, /^From: Vici Inbox <support@vicipeptides\.com>\r\n/);
  assert.match(raw, /\r\nTo: jane@example\.com\r\n/);
  assert.match(raw, /\r\nSubject: Welcome\r\n/);
  assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/);
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(raw.includes('Content-Type: text/html; charset=UTF-8'));
  assert.ok(raw.includes('Plain body'));
  assert.ok(raw.includes('<p>Rich body</p>'));

  // In multipart/alternative the richest part goes last, so a text-only client
  // shows the plain part and everything else shows the HTML.
  assert.ok(
    raw.indexOf('text/plain') < raw.indexOf('text/html'),
    'the plain-text part must precede the HTML part'
  );

  // The boundary must actually delimit, and the closing delimiter must be there.
  const boundary = raw.match(/boundary="([^"]+)"/)[1];
  assert.equal(raw.split(`--${boundary}`).length - 1, 3, 'two part markers plus the closing one');
  assert.ok(raw.includes(`--${boundary}--`));
});

test('a text-only message is sent as text/plain rather than an empty multipart', async () => {
  const fetchImpl = fakeFetch(() => okResponse());

  await sendEmail({ to: 'jane@example.com', subject: 'S', text: 'Just text' }, { env: CONFIGURED, fetchImpl });

  const raw = decodeRaw(JSON.parse(fetchImpl.calls[0].init.body).raw);
  assert.ok(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.equal(raw.includes('multipart/alternative'), false);
  assert.ok(raw.includes('Just text'));
});

test('EMAIL_FROM_NAME sets the display name and defaults when it is absent', async () => {
  const named = fakeFetch(() => okResponse());
  await sendEmail({ to: 'j@e.com', subject: 'S', text: 'B' }, {
    env: { ...CONFIGURED, EMAIL_FROM_NAME: 'Vici Support' }, fetchImpl: named
  });
  assert.match(decodeRaw(JSON.parse(named.calls[0].init.body).raw), /^From: Vici Support <support@vicipeptides\.com>/);

  const unnamed = fakeFetch(() => okResponse());
  const withoutName = { ...CONFIGURED };
  delete withoutName.EMAIL_FROM_NAME;
  await sendEmail({ to: 'j@e.com', subject: 'S', text: 'B' }, { env: withoutName, fetchImpl: unnamed });
  assert.match(decodeRaw(JSON.parse(unnamed.calls[0].init.body).raw), /^From: Vici Inbox <support@vicipeptides\.com>/);
});

test('a newline in a header value cannot inject an extra header', async () => {
  // The message is built by string concatenation, so a CR/LF in a recipient or
  // a subject would END that header and start one the caller chose. A Bcc added
  // this way would silently copy an email containing a live invitation token.
  const fetchImpl = fakeFetch(() => okResponse());

  await sendEmail({
    to: 'jane@example.com\r\nBcc: attacker@evil.com',
    subject: 'Welcome\r\nX-Injected: yes',
    text: 'Body'
  }, { env: CONFIGURED, fetchImpl });

  const raw = decodeRaw(JSON.parse(fetchImpl.calls[0].init.body).raw);
  assert.equal(/^Bcc:/m.test(raw), false, 'a Bcc header was injected through the recipient');
  assert.equal(/^X-Injected:/m.test(raw), false, 'a header was injected through the subject');
  assert.equal(raw.includes('attacker@evil.com'), true,
    'the text is kept, flattened onto the To line, rather than silently dropped');
  assert.match(raw, /\r\nSubject: Welcome X-Injected: yes\r\n/);
});

test('a non-ASCII subject is RFC 2047 encoded rather than sent raw', async () => {
  const fetchImpl = fakeFetch(() => okResponse());

  await sendEmail(
    { to: 'j@e.com', subject: 'Bienvenue chez Vici — Café', text: 'B' },
    { env: CONFIGURED, fetchImpl }
  );

  const raw = decodeRaw(JSON.parse(fetchImpl.calls[0].init.body).raw);
  const encoded = raw.match(/\r\nSubject: (.*)\r\n/)[1];
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(
    Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'),
    'Bienvenue chez Vici — Café'
  );
});

test('buildRawMessage round-trips to a decodable RFC822 message', () => {
  const raw = buildRawMessage({
    to: 'a@b.com', subject: 'S', text: 'T', html: '<p>H</p>',
    from: 'from@c.com', fromName: 'Name'
  });
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url only: no +, / or = may reach the wire');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(decoded.startsWith('From: Name <from@c.com>'));
});

test('a 2xx with an unparseable body is still a success', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 202,
    json: async () => { throw new Error('not json'); }
  }));

  const result = await sendEmail(
    { to: 'jane@example.com', subject: 'S', text: 'B' },
    { env: CONFIGURED, fetchImpl }
  );

  assert.equal(result.sent, true, 'the provider accepted it; a missing message id is not a failure');
});

test('an incomplete message is refused as a value, not an exception', async () => {
  const fetchImpl = fakeFetch(() => okResponse());
  const options = { env: CONFIGURED, fetchImpl };

  const { result } = await captureConsole(async () => ([
    await sendEmail({ to: '', subject: 'S', text: 'B' }, options),
    await sendEmail({ to: 'a@b.c', subject: '', text: 'B' }, options),
    await sendEmail({ to: 'a@b.c', subject: 'S', text: '' }, options)
  ]));

  for (const outcome of result) {
    assert.deepEqual(outcome, { sent: false, reason: 'invalid_message' });
  }
  assert.equal(fetchImpl.calls.length, 0);
});

// ── Failures are returned, never thrown ────────────────────────────────────

test('a provider error resolves to provider_error with the status', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 422, json: async () => ({ message: 'bad' }) }));

  const { result } = await captureConsole(() => sendEmail(
    { to: 'jane@example.com', subject: 'S', text: 'B' },
    { env: CONFIGURED, fetchImpl }
  ));

  assert.deepEqual(result, { sent: false, reason: 'provider_error', status: 422 });
});

test('a network failure resolves to network_error rather than rejecting', async () => {
  const fetchImpl = fakeFetch(() => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); });

  const { result } = await captureConsole(() => sendEmail(
    { to: 'jane@example.com', subject: 'S', text: 'B' },
    { env: CONFIGURED, fetchImpl }
  ));

  assert.deepEqual(result, { sent: false, reason: 'network_error' });
});

test('a hung provider is aborted and reported as a timeout', async () => {
  // Honours the abort signal the way undici does, so the timeout is genuinely
  // exercised rather than simulated by returning a canned value.
  //
  // The `keepAlive` timer is not padding. lib/email.js deliberately unref()s
  // its abort timer so a pending send cannot hold the process open, and a real
  // fetch keeps the loop alive with its socket. This fake has no socket, so
  // without a ref'd handle Node exits before the abort ever fires and the test
  // fails as "promise resolution is still pending" rather than on its assertion.
  const fetchImpl = fakeFetch((url, init) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('the abort never fired')), 2000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
  }));

  const { result } = await captureConsole(() => sendEmail(
    { to: 'jane@example.com', subject: 'S', text: 'B' },
    { env: CONFIGURED, fetchImpl, timeoutMs: 20 }
  ));

  assert.deepEqual(result, { sent: false, reason: 'timeout' });
});

// ── Nothing sensitive reaches a log ────────────────────────────────────────

test('no failure path logs the API key, the recipient or the message body', async () => {
  const token = 'LIVE-INVITE-TOKEN-c2VjcmV0';
  const acceptUrl = `${CONFIGURED.APP_URL}/accept-invite?token=${token}`;
  const message = {
    to: 'jane.doe@example.com',
    subject: 'You are invited',
    text: `Accept here: ${acceptUrl}`,
    html: `<a href="${acceptUrl}">Accept</a>`
  };

  const failures = [
    () => ({ ok: false, status: 500, json: async () => ({ error: `rejected ${acceptUrl}` }) }),
    () => { throw Object.assign(new Error(`connect ECONNREFUSED for ${message.to}`), { code: 'ECONNREFUSED' }); }
  ];

  for (const responder of failures) {
    const { log } = await captureConsole(() => sendEmail(message, {
      env: CONFIGURED,
      fetchImpl: fakeFetch(responder)
    }));

    assert.equal(log.includes(CONFIGURED.MATON_API_KEY), false, 'the API key reached a log line');
    assert.equal(
      log.includes(CONFIGURED.MATON_GMAIL_CONNECTION_ID), false,
      'the Gmail connection id reached a log line'
    );
    assert.equal(log.includes(token), false, 'the invitation token reached a log line');
    assert.equal(log.includes(acceptUrl), false, 'the accept URL reached a log line');
    assert.equal(log.includes(message.to), false, 'the full recipient address reached a log line');
    assert.equal(log.includes(message.text), false, 'the message body reached a log line');
    // The redacted form is what SHOULD be there, so a failure stays diagnosable.
    assert.ok(log.includes('j***@example.com'), `expected a redacted recipient, got: ${log}`);
  }
});

test('a SUCCESSFUL send logs nothing at all', async () => {
  // The reference implementation this was ported from logs the recipient and
  // the subject on every success. For an invitation the subject names the
  // invitee and the send is routine, so that would write personal data to the
  // log on the happy path, forever, for no diagnostic gain.
  const message = {
    to: 'jane.doe@example.com',
    subject: 'Lubosi invited you to Vici Inbox',
    text: 'Accept: https://inbox.example.com/accept-invite?token=LIVETOKEN',
    html: '<a href="https://inbox.example.com/accept-invite?token=LIVETOKEN">Accept</a>'
  };

  const { result, log } = await captureConsole(() => sendEmail(message, {
    env: CONFIGURED,
    fetchImpl: fakeFetch(() => okResponse({ id: 'msg_ok' }))
  }));

  assert.equal(result.sent, true);
  assert.equal(log, '', `a successful send must be silent, got: ${log}`);
});

test('redactEmail keeps the domain and one character, and degrades safely', () => {
  assert.equal(redactEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(redactEmail('a@b.co'), 'a***@b.co');
  assert.equal(redactEmail('not-an-address'), '***');
  assert.equal(redactEmail('@leading.com'), '***');
  assert.equal(redactEmail(undefined), '***');
  assert.equal(redactEmail(null), '***');
});

test('appUrl strips trailing slashes so a link never doubles them', () => {
  assert.equal(appUrl({ APP_URL: 'https://inbox.example.com/' }), 'https://inbox.example.com');
  assert.equal(appUrl({ APP_URL: 'https://inbox.example.com///' }), 'https://inbox.example.com');
  assert.equal(appUrl({}), '');
});

// ── The template ───────────────────────────────────────────────────────────

const INVITE = Object.freeze({
  inviteeName: 'Sarah Chen',
  inviterName: 'Lubosi',
  workspaceName: 'Vici Inbox',
  roleKey: 'agent',
  roleDisplayName: 'Support Agent',
  acceptUrl: 'https://inbox.example.com/accept-invite?token=abc123',
  expiresAt: '2026-08-29T14:30:00.000Z'
});

test('the invitation states the inviter, the workspace, the role and the expiry', () => {
  const { subject, text, html } = invitationEmail(INVITE);

  assert.ok(subject.includes('Lubosi'), 'the subject must name the inviter');
  assert.ok(subject.includes('Vici Inbox'), 'the subject must name the workspace');

  for (const body of [text, html]) {
    assert.ok(body.includes('Lubosi'), 'the body must name the inviter');
    assert.ok(body.includes('Vici Inbox'), 'the body must name the workspace');
    assert.ok(body.includes('Sarah Chen'), 'the body must greet the invitee');
    assert.ok(body.includes('29 August 2026'), 'the body must state when the invitation expires');
    assert.ok(body.includes(INVITE.acceptUrl), 'the body must carry the accept URL');
  }
});

test('the role is spelled in human words, never as the database key', () => {
  const { text, html } = invitationEmail(INVITE);
  for (const body of [text, html]) {
    assert.ok(body.includes('Support Agent'), 'the role must read as "Support Agent"');
    assert.equal(
      /\bthe agent role\b/i.test(body), false,
      'the raw role key "agent" must not be shown as the role'
    );
  }
});

test('roleLabel humanises every known key and never returns a bare key', () => {
  assert.equal(roleLabel('agent'), 'Support Agent');
  assert.equal(roleLabel('admin'), 'Admin');
  assert.equal(roleLabel('owner'), 'Owner');
  // A catalogue display name always wins, because sms_roles is editable.
  assert.equal(roleLabel('agent', 'Customer Support'), 'Customer Support');
  // A role added to the database before it is added to the map still reads.
  assert.equal(roleLabel('billing_manager'), 'Billing Manager');
  assert.equal(roleLabel(''), 'Team Member');
  assert.equal(roleLabel(undefined), 'Team Member');
});

test('the accept URL is prominent: a button and a copyable fallback', () => {
  const { html } = invitationEmail(INVITE);
  const occurrences = html.split(INVITE.acceptUrl).length - 1;
  assert.ok(occurrences >= 2, `expected a button and a pasteable link, found ${occurrences}`);
  assert.ok(html.includes(`href="${INVITE.acceptUrl}"`), 'the URL must be a real href');
});

test('the HTML is inline-styled with no stylesheet an email client would drop', () => {
  const { html } = invitationEmail(INVITE);
  assert.equal(/<style[\s>]/i.test(html), false, 'a <style> block is unreliable in email clients');
  assert.equal(/<link[\s>]/i.test(html), false, 'an external stylesheet will not load in an email client');
  assert.equal(/class=/i.test(html), false, 'classes have no stylesheet to resolve against');
  assert.ok(html.includes('style="'), 'styling must be inline');
});

test('there is no tracking pixel and no beacon', () => {
  const { html } = invitationEmail(INVITE);
  assert.equal(/<img/i.test(html), false, 'no image, so no tracking pixel');
  assert.equal(/width="1"|height="1"/i.test(html), false);
  // The accept URL is the only link in the message.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(hrefs)], [INVITE.acceptUrl]);
});

test('a hostile display name cannot inject markup into the HTML body', () => {
  const { html, text } = invitationEmail({
    ...INVITE,
    inviteeName: '<script>alert(1)</script>',
    inviterName: 'Ann "The Boss" O\'Neil'
  });
  assert.equal(html.includes('<script>'), false, 'markup from a name must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot;') && html.includes('&#39;'));
  // Plain text has no markup semantics, so it is intentionally not escaped.
  assert.ok(text.includes('<script>alert(1)</script>'));
});

test('the plain-text alternative always exists and carries the link', () => {
  const { text } = invitationEmail(INVITE);
  assert.ok(text.length > 0);
  assert.equal(/<[a-z]/i.test(text), false, 'the text part must contain no markup');
  assert.ok(text.includes(INVITE.acceptUrl));
});

test('a resend reads as a reminder rather than as a fresh invitation', () => {
  const first = invitationEmail(INVITE);
  const again = invitationEmail({ ...INVITE, isResend: true });
  assert.notEqual(first.subject, again.subject);
  assert.ok(/reminder/i.test(again.subject));
  assert.ok(again.text.includes(INVITE.acceptUrl), 'a reminder still has to carry the link');
});

test('an unparseable expiry degrades to a sentence rather than to "Invalid Date"', () => {
  const { text, html } = invitationEmail({ ...INVITE, expiresAt: 'not-a-date' });
  for (const body of [text, html]) {
    assert.equal(body.includes('Invalid Date'), false);
    assert.equal(body.includes('NaN'), false);
    assert.ok(/will expire/i.test(body));
  }
  assert.equal(formatExpiry('not-a-date'), null);
});

test('escapeHtml covers every character that could break out of an attribute', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
