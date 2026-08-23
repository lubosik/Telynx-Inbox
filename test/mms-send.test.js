'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendSMS } = require('../telnyx');

test('sends an image-only MMS using public media_urls', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    TELNYX_PHONE_NUMBER: process.env.TELNYX_PHONE_NUMBER,
    TELNYX_MESSAGING_PROFILE_ID: process.env.TELNYX_MESSAGING_PROFILE_ID,
    TELNYX_API_KEY: process.env.TELNYX_API_KEY
  };
  let captured;

  process.env.TELNYX_PHONE_NUMBER = '+15555550100';
  process.env.TELNYX_MESSAGING_PROFILE_ID = 'profile-test';
  process.env.TELNYX_API_KEY = 'not-a-real-key';
  global.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ data: { id: 'message-test', to: [{ status: 'queued' }] } })
    };
  };

  try {
    const result = await sendSMS('+15555550101', '', ['https://media.example/photo.jpg']);
    assert.equal(captured.url, 'https://api.telnyx.com/v2/messages');
    assert.deepEqual(captured.body.media_urls, ['https://media.example/photo.jpg']);
    assert.equal(captured.body.text, '');
    assert.deepEqual(result, { messageId: 'message-test', status: 'queued' });
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('limits the provider payload to Telnyx maximum of ten media URLs', async () => {
  const originalFetch = global.fetch;
  let capturedBody;
  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ data: { id: 'message-test', to: [{ status: 'queued' }] } })
    };
  };

  try {
    const urls = Array.from({ length: 12 }, (_, index) => `https://media.example/${index}.jpg`);
    await sendSMS('+15555550101', 'Photos', urls);
    assert.equal(capturedBody.media_urls.length, 10);
    assert.deepEqual(capturedBody.media_urls, urls.slice(0, 10));
  } finally {
    global.fetch = originalFetch;
  }
});

test('surfaces Telnyx MMS rejection details to the caller', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    json: async () => ({ errors: [{ detail: 'Media file too large' }] })
  });

  try {
    await assert.rejects(
      sendSMS('+15555550101', '', ['https://media.example/large.jpg']),
      /Media file too large/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Refusal classification and the request timeout ──────────────────────────
//
// telnyx.js is used by order confirmation, shipping, the inbox, the GHL relay,
// reactions, catch-up and the campaign worker. These tests exist to pin the
// contract those callers depend on while the campaign worker learns to read a
// refusal off the thrown error.

const {
  PROVIDER_REFUSAL_STATUSES,
  PROVIDER_TIMEOUT_MS,
  isProviderRefusal
} = require('../telnyx');
const { providerRefusalCode } = require('../lib/campaigns/delivery-worker');

async function captureSendFailure({ status, body, ok = false }) {
  const originalFetch = global.fetch;
  let capturedOptions;
  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return {
      ok,
      status,
      json: async () => {
        if (typeof body === 'function') return body();
        return body;
      }
    };
  };
  try {
    await sendSMS('+15555550101', 'hello');
    return { error: null, capturedOptions };
  } catch (error) {
    return { error, capturedOptions };
  } finally {
    global.fetch = originalFetch;
  }
}

test('a 4xx with a parsed Telnyx error body is a refusal the worker can act on', async () => {
  for (const status of PROVIDER_REFUSAL_STATUSES) {
    const { error } = await captureSendFailure({
      status,
      body: { errors: [{ code: '40300', detail: 'Invalid destination number' }] }
    });

    assert.equal(error.message, 'Invalid destination number', 'the message callers log is unchanged');
    assert.equal(error.httpStatus, status);
    assert.equal(isProviderRefusal(error), true, String(status));
    assert.equal(error.providerErrorCode, '40300');
    // The worker reads this shape without importing telnyx.js. Prove they agree.
    assert.equal(providerRefusalCode(error), '40300', 'telnyx and the worker must agree');
  }
});

test('a refusal without an error code still carries a usable code', async () => {
  const { error } = await captureSendFailure({ status: 400, body: { errors: [{ detail: 'Bad request' }] } });
  assert.equal(isProviderRefusal(error), true);
  assert.equal(error.providerErrorCode, 'http_400');
});

test('a 5xx, a 429 and an auth failure are NOT refusals', async () => {
  // These are the statuses most tempting to fold into the refusal path. A 429
  // is retryable, a 5xx says nothing about whether the message was submitted,
  // and a 401 is about our credentials, not this destination. Downgrading any
  // of them to "the provider said no" would mark real recipients failed.
  for (const status of [401, 402, 403, 408, 429, 500, 502, 503]) {
    const { error } = await captureSendFailure({
      status, body: { errors: [{ code: '99999', detail: 'Nope' }] }
    });
    assert.equal(error.message, 'Nope');
    assert.equal(error.httpStatus, status);
    assert.equal(isProviderRefusal(error), false, String(status));
    assert.equal(error.providerErrorCode, undefined);
    assert.equal(providerRefusalCode(error), null, String(status));
  }
});

test('an unparseable failure body is never promoted to a refusal', async () => {
  const { error } = await captureSendFailure({
    status: 400,
    body: () => { throw new SyntaxError('Unexpected token < in JSON'); }
  });
  assert.equal(error.message, 'Telnyx send failed');
  assert.equal(isProviderRefusal(error), false, 'a body we cannot read is not evidence');
});

test('an unparseable body on a success status still throws exactly as before', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }
  });
  try {
    await assert.rejects(sendSMS('+15555550101', 'hello'), /Unexpected end of JSON input/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('every provider call carries an abort timeout, and an abort is uncertain', async () => {
  const { capturedOptions } = await captureSendFailure({ status: 400, body: { errors: [] } });
  assert.ok(capturedOptions.signal instanceof AbortSignal, 'no bare fetch without a deadline');
  assert.equal(PROVIDER_TIMEOUT_MS, 20_000);

  // A real abort rejects out of fetch itself, so it never reaches the status
  // classification and can never carry providerRefused.
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  try {
    await assert.rejects(sendSMS('+15555550101', 'hello'), (error) => {
      assert.equal(isProviderRefusal(error), false, 'an abort is unknown, not refused');
      assert.equal(providerRefusalCode(error), null);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
});
