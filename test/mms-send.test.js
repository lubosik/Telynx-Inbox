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
