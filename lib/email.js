'use strict';
/**
 * lib/email.js — the only outbound email seam in this service.
 *
 * PROVIDER: Maton, sending through an already-authorised Gmail connection that
 * sends AS support@vicipeptides.com. Chosen over an SMTP/API provider because
 * it needs NO DNS CHANGES: vicipeptides.com mail is hosted elsewhere and the
 * owner is unwilling to touch its records to add a sending domain. The Gmail
 * connection is live and authorised already, so there is nothing to verify and
 * no SPF/DKIM edit to get wrong.
 *
 * There is no SDK and no new npm dependency: it is one POST to the Maton
 * gateway with a bearer token, and native `fetch` does that on Node 20.
 *
 * THE WIRE FORMAT is Gmail's, not a friendly JSON one. The gateway proxies
 * `users.messages.send`, so the body is `{ raw }` where `raw` is a base64url
 * RFC822 message that this module assembles by hand: a `multipart/alternative`
 * envelope with the plain-text part first and the HTML part second, which is
 * the order the standard requires and which decides what a text-only client
 * shows. The connection id travels in the `Maton-Connection` HEADER, not in the
 * body. That is copied from the working implementation at
 * vici-revenue-engine/core/maton-email-client.js rather than guessed.
 *
 * THE CONTRACT: THIS MODULE NEVER THROWS AND NEVER REJECTS.
 *   Every path — missing configuration, a bad recipient, a 500 from the
 *   gateway, a DNS failure, a timeout — resolves to a plain
 *   `{ sent: boolean, reason }` object. Email is a courtesy attached to an
 *   operation that has already succeeded (an invitation row exists and its link
 *   is in the response body), so a mail failure must never surface as a failed
 *   request. This is the main behavioural difference from the reference
 *   implementation, which throws; callers here are expected to report the
 *   returned value honestly rather than to branch on an exception.
 *
 * NOT-CONFIGURED IS THE NORMAL PATH ON DEPLOY DAY.
 *   `MATON_API_KEY` does not exist yet in Railway. Without the full set this
 *   returns `{ sent: false, reason: 'not_configured' }` and logs ONCE for the
 *   life of the process, matching `reportMissingConfiguration()` in
 *   lib/apns-notify.js. Logging per send would turn a known, accepted gap into
 *   recurring noise.
 *
 * WHAT MUST NEVER BE LOGGED
 *   The API key, the connection id, the full recipient list, the subject, and
 *   anything token-shaped. An invite link contains a live credential, so
 *   neither the URL nor the body is ever logged — not at error level, not in
 *   development. The reference implementation logs the recipient and the
 *   subject on success; that is deliberately not carried over. Failures are
 *   identified by status code and a redacted recipient (`j***@example.com`),
 *   which is enough to answer "did this address get their invite?" without
 *   writing the address itself into a log aggregator.
 *
 * NOT COPIED FROM THE REFERENCE: its `sanitise()`, which strips asterisks,
 * em-dashes and hashtags. That is a marketing-copy house rule in that project.
 * Applying it here would corrupt any URL containing '#', and an invitation is
 * transactional mail, not copy.
 */

const MATON_SEND_ENDPOINT = 'https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages/send';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_FROM_NAME = 'Vici Inbox';

/** Logged at most once per process, exactly like lib/apns-notify.js. */
let didLogMissingConfiguration = false;

/** Test hook for the "log the missing configuration once" behaviour. */
function resetMissingConfigurationLog() {
  didLogMissingConfiguration = false;
}

/**
 * `jane.doe@example.com` -> `j***@example.com`.
 * Enough to correlate a delivery failure with a person you already know you
 * invited; not enough to harvest an address list out of a log.
 */
function redactEmail(address) {
  const value = String(address ?? '');
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

/**
 * Strip anything that could start a new header line.
 *
 * This module builds RFC822 by string concatenation, so a CR or LF inside a
 * recipient, a subject or a display name does not corrupt the message — it
 * ENDS the current header and begins another one the caller chose. A display
 * name of "Sarah\r\nBcc: attacker@evil.com" would silently add a blind copy of
 * an email containing a live invitation token. Invitee names and addresses come
 * from a request body, so this is reachable input, and it is stripped rather
 * than escaped because no legitimate header value here contains a newline.
 */
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * RFC 2047 encode a header value when it is not plain ASCII.
 *
 * A subject line contains a person's name, and names have accents. Left raw, a
 * non-ASCII byte in a header is undefined behaviour and renders as mojibake in
 * most clients. ASCII is passed through untouched so the common case stays
 * readable on the wire and in a test assertion.
 */
function encodeHeaderValue(value) {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

/**
 * Resolved at call time, not at require time. Railway variables are present
 * before the first request but a test must be able to set and unset them
 * between cases, and a module-level constant would freeze whatever was in the
 * environment when the file was first required.
 *
 * All three of key, connection and from-address are required. A partial set is
 * treated as not configured rather than as an attempt, because sending with a
 * missing piece produces a provider error nobody can read.
 */
function configuration(env = process.env) {
  const apiKey = String(env.MATON_API_KEY || '').trim();
  const connectionId = String(env.MATON_GMAIL_CONNECTION_ID || '').trim();
  const from = String(env.EMAIL_FROM || '').trim();
  if (!apiKey || !connectionId || !from) return null;
  // Optional: only affects how the sender's name renders.
  const fromName = String(env.EMAIL_FROM_NAME || '').trim() || DEFAULT_FROM_NAME;
  return { apiKey, connectionId, from, fromName };
}

/** The public base URL used to build links inside an email body. */
function appUrl(env = process.env) {
  return String(env.APP_URL || '').replace(/\/+$/, '');
}

function reportMissingConfiguration(what) {
  if (!didLogMissingConfiguration) {
    console.log(
      `Email: ${what} disabled — MATON_API_KEY / MATON_GMAIL_CONNECTION_ID / EMAIL_FROM are not configured`
    );
    didLogMissingConfiguration = true;
  }
  return { sent: false, reason: 'not_configured' };
}

/**
 * Assemble the RFC822 message Gmail expects, base64url encoded.
 *
 * `multipart/alternative` when there is an HTML part, plain text alone when
 * there is not. The text part comes first: in `alternative`, later parts are
 * the richer ones and a client picks the last it can render.
 *
 * Exported for the tests, which decode `raw` and assert on the actual headers
 * rather than trusting that a header was passed in somewhere.
 *
 * @returns {string} base64url
 */
function buildRawMessage({ to, subject, text, html, from, fromName }) {
  const headers = [
    `From: ${encodeHeaderValue(fromName)} <${headerSafe(from)}>`,
    `To: ${headerSafe(to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0'
  ];

  let message;
  if (html) {
    // Time-based, like the reference. It only has to be absent from the two
    // bodies, and a MIME boundary is not a security boundary.
    const boundary = `vici_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    message = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
      '',
      `--${boundary}--`
    ].join('\r\n');
  } else {
    message = [...headers, 'Content-Type: text/plain; charset=UTF-8', '', text].join('\r\n');
  }

  // Node's 'base64url' is exactly the +/- , //_ , strip-padding transform the
  // reference performs by hand.
  return Buffer.from(message, 'utf8').toString('base64url');
}

/**
 * Send one email.
 *
 * @param {object} message
 * @param {string} message.to        a single recipient address
 * @param {string} message.subject
 * @param {string} message.text      plain-text body, always required
 * @param {string} [message.html]    optional HTML alternative
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]  injected for offline tests
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{sent: boolean, reason?: string, id?: string, status?: number}>}
 */
async function sendEmail(message, options = {}) {
  const env = options.env || process.env;
  const config = configuration(env);
  if (!config) return reportMissingConfiguration('outbound email');

  const to = headerSafe(message?.to);
  const subject = headerSafe(message?.subject);
  const text = String(message?.text || '');
  if (!to || !subject || !text) {
    // A caller bug, not an operational failure. Still not an exception: the
    // contract is that this function resolves.
    console.warn('Email: refused an incomplete message (missing recipient, subject or body)');
    return { sent: false, reason: 'invalid_message' };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    console.warn('Email: no fetch implementation available in this runtime');
    return { sent: false, reason: 'no_fetch' };
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // A hung provider must not hold an HTTP handler open. AbortController is the
  // only thing that bounds a fetch; there is no built-in request timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const raw = buildRawMessage({
    to,
    subject,
    text,
    html: message.html ? String(message.html) : null,
    from: config.from,
    fromName: config.fromName
  });

  try {
    const response = await fetchImpl(MATON_SEND_ENDPOINT, {
      method: 'POST',
      headers: {
        // Neither of these is ever logged or echoed into a returned value.
        Authorization: `Bearer ${config.apiKey}`,
        'Maton-Connection': config.connectionId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw }),
      signal: controller.signal
    });

    if (!response || response.ok !== true) {
      const status = response?.status ?? 0;
      // The gateway's error body can quote the message it rejected, which for
      // an invitation means the accept URL and therefore a live token. Only the
      // status code is recorded.
      console.warn(`Email: send failed with status ${status} for ${redactEmail(to)}`);
      return { sent: false, reason: 'provider_error', status };
    }

    let id;
    try {
      const body = await response.json();
      id = body?.id ? String(body.id) : undefined;
    } catch {
      // A 2xx with an unparseable body still means the gateway accepted it. The
      // message id is a convenience for support, not a success condition.
      id = undefined;
    }
    return { sent: true, id, status: response.status ?? 200 };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    console.warn(
      `Email: send ${aborted ? 'timed out' : 'errored'} for ${redactEmail(to)}`,
      aborted ? `after ${timeoutMs}ms` : (error?.code || error?.name || 'unknown')
    );
    return { sent: false, reason: aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/** True when a send would actually be attempted. Lets a caller explain why not. */
function isEmailConfigured(env = process.env) {
  return configuration(env) !== null;
}

module.exports = {
  sendEmail,
  isEmailConfigured,
  appUrl,
  redactEmail,
  buildRawMessage,
  resetMissingConfigurationLog,
  MATON_SEND_ENDPOINT,
  DEFAULT_TIMEOUT_MS
};
