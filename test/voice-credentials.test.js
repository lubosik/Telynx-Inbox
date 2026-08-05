'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getIOSVoiceCredentials } = require('../lib/voice-credentials');

const legacy = {
  TELNYX_SIP_USERNAME: 'legacy-user',
  TELNYX_SIP_PASSWORD: 'legacy-password'
};

test('uses the dedicated iOS credential when both override values exist', () => {
  assert.deepEqual(getIOSVoiceCredentials({
    ...legacy,
    TELNYX_IOS_SIP_USERNAME: 'ios-user',
    TELNYX_IOS_SIP_PASSWORD: 'ios-password'
  }), {
    login: 'ios-user',
    password: 'ios-password',
    usingDedicatedIOSCredential: true
  });
});

test('falls back to the complete legacy pair if either override is absent', () => {
  assert.deepEqual(getIOSVoiceCredentials({
    ...legacy,
    TELNYX_IOS_SIP_USERNAME: 'ios-user'
  }), {
    login: 'legacy-user',
    password: 'legacy-password',
    usingDedicatedIOSCredential: false
  });

  assert.deepEqual(getIOSVoiceCredentials({
    ...legacy,
    TELNYX_IOS_SIP_PASSWORD: 'ios-password'
  }), {
    login: 'legacy-user',
    password: 'legacy-password',
    usingDedicatedIOSCredential: false
  });
});
